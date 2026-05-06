/*
 * Academy Reporting Worker
 * ------------------------
 * Tiny Cloudflare Worker that receives learner events from the academy's
 * static HTML page and stores them in Cloudflare KV. A separate scheduled
 * task (academy-visitor-sync) reads from KV and writes to downstream systems.
 *
 * The same Worker also serves the gated Internal track: a shared-password
 * auth endpoint mints a signed HMAC token, and /internal/* serves Internal
 * content from KV only when a valid token is presented. See the "INTERNAL
 * TRACK" block further down for details and required secrets.
 *
 * EVENTS ACCEPTED
 *   page_view         — fired on every page load, no identity required.
 *                       Stored in KV under key visits:YYYY-MM-DD as a JSON array.
 *                       Includes timestamp, country, referrer, and learner info
 *                       if already identified.
 *   session_start     — fired on every page load when an identified learner is present.
 *   lesson_completed  — fires the first time a lesson is marked done.
 *   module_completed  — fires the first time every lesson in a module is done.
 *   path_completed    — fires the first time the entire learning path is done.
 *
 *   The legacy "course_completed" event name is still accepted and treated as
 *   module_completed, so older deployed pages keep working.
 *
 * GET /
 *   Returns all stored visits and events as { visits: [...], events: [...] },
 *   sorted newest-first. Used by sync-visitors.js to build visitors.json.
 *
 * POST /auth/internal
 *   Body: { password: "..." }. If it matches env.INTERNAL_PASSWORD, returns
 *   { token, expiresAt } where token is an HMAC-signed string proving the
 *   bearer authenticated successfully. Token is required for /internal/*.
 *
 * GET /internal/<kind>/<id>.json   (where kind is one of paths|tracks|modules|lessons)
 * GET /internal/manifest.json
 *   Requires Authorization: Bearer <token>. Reads the file from KV under the
 *   key prefix "internal:". Returns 401 without a valid token, 404 if the key
 *   is not present in KV. Cache: no-store so newly uploaded content is picked
 *   up immediately.
 *
 * KV SETUP
 *   1. Cloudflare dashboard -> Workers & Pages -> KV -> Create namespace "ACADEMY_VISITS".
 *   2. On your Worker -> Settings -> Bindings -> KV Namespace: variable name = VISITS_KV.
 *   If VISITS_KV is not bound the Worker silently skips KV writes (events still
 *   return 200 so the page does not error). The same KV namespace also stores
 *   Internal content under the "internal:" prefix.
 *
 * REQUIRED WORKER SECRETS (for the Internal track)
 *   wrangler secret put INTERNAL_PASSWORD     — shared password for staff
 *   wrangler secret put INTERNAL_JWT_SECRET   — random string used to sign tokens
 *   If either is missing, /auth/internal returns 503 and /internal/* returns 503,
 *   so the public flow is never affected by a half-configured Worker.
 *
 * AUDIT-GRADE CAVEAT
 *   Events are reported by the learner's browser. A learner with DevTools could
 *   send fake events. This is fine for an internal engagement view but not proof
 *   of completion.
 *
 * HOW TO DEPLOY (2 minutes)
 *
 * 1. Deploy this Worker
 *    - https://dash.cloudflare.com -> Workers & Pages -> Create -> Hello World.
 *    - Replace the default code with this file, click Deploy.
 *    - Settings -> Triggers -> note the *.workers.dev URL.
 *
 * 2. Wire the URL into index.html
 *    - Open index.html, find REPORTING_ENDPOINT at the top of <script>, paste the URL.
 *    - Reload the page, log in, complete a lesson.
 *
 * 3. (Internal track only) Set the two secrets above, then upload Internal
 *    content to KV with `wrangler kv:key put --binding VISITS_KV
 *    "internal:manifest.json" '{"version":"...","paths":[],...}'` etc.
 */

/* CORS allowlist. The Academy lives on GitHub Pages in production and on
   localhost during dev; both need to POST events. Any Origin not in this
   set gets PRIMARY_ORIGIN echoed back, which causes the browser's own CORS
   check to fail. The Origin check on POST below is the second line of
   defence for callers that bypass the browser entirely (curl, scripts).
   Update PRIMARY_ORIGIN if the production hostname changes (e.g. moving
   to a custom domain like academy.qargo.com). */
const PRIMARY_ORIGIN = "https://the-empyrean-company.github.io";
const ALLOWED_ORIGINS = new Set([
  PRIMARY_ORIGIN,
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function pickOrigin(request) {
  const origin = request?.headers?.get("origin") || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : PRIMARY_ORIGIN;
}

function isAllowedOrigin(request) {
  const origin = request.headers.get("origin") || "";
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Fallback for non-browser callers that still set Referer (some scripts do).
  // Pure curl/wget without --referer is rejected, which is the intent.
  const ref = request.headers.get("referer") || "";
  for (const allowed of ALLOWED_ORIGINS) {
    if (ref.startsWith(allowed + "/")) return true;
  }
  return false;
}

const INTERNAL_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/* Per-IP rate limits (fixed-minute window, backed by KV). */
const AUTH_RATE_LIMIT          = 5;   // /auth/internal
const TUTOR_RATE_LIMIT         = 10;  // /tutor
const AUTH_RATE_WINDOW_SECONDS = 60;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    /* ---- AI tutor proxy ----------------------------------------------- */
    if (path === "/tutor" && request.method === "POST") {
      return handleTutor(request, env);
    }

    /* ---- D1 progress routes ------------------------------------------- */
    if (path === "/learner" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403, request);
      return handleUpsertLearner(request, env);
    }
    if (path === "/progress/lesson" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403, request);
      return handleUpsertLesson(request, env);
    }
    if (path === "/progress/badge" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403, request);
      return handleUpsertBadge(request, env);
    }
    if (path === "/progress/block" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403, request);
      return handleUpsertBlock(request, env);
    }
    if (path === "/progress" && request.method === "GET") {
      return handleGetProgress(request, env);
    }
    if (path === "/leaderboard" && request.method === "GET") {
      return handleGetLeaderboard(request, env);
    }

    /* ---- Internal track routes ---------------------------------------- */
    if (path === "/auth/internal" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403, request);
      return handleInternalAuth(request, env);
    }
    if (path.startsWith("/internal/") && request.method === "GET") {
      return handleInternalContent(request, env, path);
    }

    /* ---- Reporting routes (legacy /, accepts any path on POST) -------- */
    // GET / — return all stored page_view + event rows for sync-visitors.js.
    // Requires Authorization: Bearer <SYNC_TOKEN>; without it the response
    // is 401 with no data, even though the URL itself is public.
    if (request.method === "GET") {
      return handleGetVisits(request, env);
    }

    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, request);
    }

    /* Origin check on writes. CORS already blocks browsers from other
       origins, but a curl/script can ignore CORS entirely; this catches
       those. The OPTIONS preflight above is unaffected: browsers send
       OPTIONS before POST and we let them through to negotiate CORS. */
    if (!isAllowedOrigin(request)) return json({ error: "forbidden" }, 403, request);

    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: "invalid JSON" }, 400, request); }

    const eventRaw = payload?.event;
    // Backwards compat: old pages send "course_completed" for module-level finishes.
    const event = eventRaw === "course_completed" ? "module_completed" : eventRaw;

    // page_view: no learner required, stored in KV only.
    if (event === "page_view") {
      return handlePageView(request, env, payload);
    }

    const allowed = new Set(["session_start", "lesson_completed", "module_completed", "path_completed"]);
    if (!allowed.has(event)) return json({ error: "unknown event", got: eventRaw }, 400, request);

    const learner = payload.learner || {};
    if (!learner.email || !learner.name) {
      return json({ error: "learner.name and learner.email required" }, 400, request);
    }
    const email = String(learner.email).trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "invalid email" }, 400, request);

    // Country comes from Cloudflare for free; no extra API call.
    const country =
      (request.cf && request.cf.country) ||
      request.headers.get("cf-ipcountry") ||
      "";

    // Build the milestone label, if any. session_start has none.
    let milestoneLabel = null;
    if (event === "lesson_completed" && payload.lesson?.title) {
      milestoneLabel = `Lesson: ${payload.lesson.title}`;
    } else if (event === "module_completed" && (payload.module?.title || payload.course?.title)) {
      milestoneLabel = `Module: ${payload.module?.title || payload.course?.title}`;
    } else if (event === "path_completed" && payload.path?.title) {
      milestoneLabel = `Path: ${payload.path.title}`;
    }

    const nowIso = new Date().toISOString();

    // Store the event in KV. The scheduled sync task (academy-visitor-sync)
    // reads from KV via GET / and handles all downstream writes.
    await storeEventInKV(env, {
      event,
      at: payload.at || nowIso,
      country: country || null,
      milestone: milestoneLabel,
      learner: {
        email,
        name: String(learner.name).slice(0, 200),
        role: learner.roleLabel || learner.role || null,
        company: learner.company || null,
      },
    });

    return json({ ok: true, stored: true }, 200, request);
  },
};

/* -------------------------------------------------------------------------- */
/* page_view helpers                                                           */
/* -------------------------------------------------------------------------- */

async function handlePageView(request, env, payload) {
  const country =
    (request.cf && request.cf.country) ||
    request.headers.get("cf-ipcountry") ||
    null;

  const entry = {
    at: payload.at || new Date().toISOString(),
    country,
    referrer: payload.referrer || null,
    ...(payload.learner ? {
      learner: {
        email: payload.learner.email || null,
        name:  payload.learner.name  || null,
        role:  payload.learner.roleLabel || payload.learner.role || null,
      },
    } : {}),
  };

  if (env.VISITS_KV) {
    const dateKey = `visits:${entry.at.slice(0, 10)}`; // e.g. visits:2026-04-29
    const existing = await env.VISITS_KV.get(dateKey, { type: "json" }) || [];
    existing.push(entry);
    await env.VISITS_KV.put(dateKey, JSON.stringify(existing));
  }

  return json({ ok: true, logged: !!env.VISITS_KV }, 200, request);
}

async function handleGetVisits(request, env) {
  /* Reading the visit/event corpus is sensitive: it contains every learner
     email, name, role, and activity record. Gate it behind a shared token
     stored as the SYNC_TOKEN secret on the worker. The only legitimate
     caller is sync-visitors.js running on the operator's machine, which
     reads the same token from the ACADEMY_SYNC_TOKEN env var.

     If the secret isn't set, we return 503 rather than fall through to
     "open". This is the same fail-closed pattern used for the Internal
     auth routes. */
  if (!env.SYNC_TOKEN) {
    return json({ error: "sync auth not configured" }, 503, request);
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!constantTimeEqual(token, env.SYNC_TOKEN)) {
    return json({ error: "unauthorized" }, 401, request);
  }
  if (!env.VISITS_KV) {
    return json({ error: "VISITS_KV binding not configured" }, 503, request);
  }

  // Return KV event log plus structured D1 learner/progress data.
  const [visits, events, learners] = await Promise.all([
    fetchKVPrefix(env, "visits:"),
    fetchKVPrefix(env, "events:"),
    fetchLearnersFromD1(env),
  ]);

  visits.sort((a, b) => (b.at > a.at ? 1 : -1));
  events.sort((a, b) => (b.at > a.at ? 1 : -1));
  learners.sort((a, b) => (b.last_active_at > a.last_active_at ? 1 : -1));

  return new Response(JSON.stringify({ visits, events, learners }), {
    status: 200,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function fetchKVPrefix(env, prefix) {
  const list = await env.VISITS_KV.list({ prefix });
  const all = [];
  for (const key of list.keys) {
    const rows = await env.VISITS_KV.get(key.name, { type: "json" }) || [];
    all.push(...rows);
  }
  return all;
}

async function fetchLearnersFromD1(env) {
  if (!env.DB) return [];
  try {
    const [learnersRes, badgesRes] = await Promise.all([
      env.DB.prepare(
        `SELECT l.email, l.name, l.role, l.company, l.created_at, l.last_active_at,
                COUNT(CASE WHEN lp.completed_at IS NOT NULL THEN 1 END) AS lessons_completed
         FROM learners l
         LEFT JOIN lesson_progress lp ON l.id = lp.learner_id
         GROUP BY l.id`
      ).all(),
      env.DB.prepare(
        `SELECT l.email, b.badge_id, b.earned_at
         FROM badges b JOIN learners l ON l.id = b.learner_id`
      ).all(),
    ]);

    // Index badges by email for fast lookup.
    const badgesByEmail = {};
    for (const { email, badge_id, earned_at } of badgesRes.results) {
      if (!badgesByEmail[email]) badgesByEmail[email] = [];
      badgesByEmail[email].push({ badge_id, earned_at });
    }

    return learnersRes.results.map(l => ({
      email:             l.email,
      name:              l.name,
      role:              l.role,
      company:           l.company,
      created_at:        l.created_at,
      last_active_at:    l.last_active_at,
      lessons_completed: l.lessons_completed,
      badges:            badgesByEmail[l.email] || [],
    }));
  } catch (e) {
    console.error("D1 learner fetch failed:", e);
    return [];
  }
}

async function storeEventInKV(env, entry) {
  if (!env.VISITS_KV) return; // KV not bound — skip silently
  const dateKey = `events:${entry.at.slice(0, 10)}`; // e.g. events:2026-04-29
  const existing = await env.VISITS_KV.get(dateKey, { type: "json" }) || [];
  existing.push(entry);
  await env.VISITS_KV.put(dateKey, JSON.stringify(existing));
}

/* -------------------------------------------------------------------------- */
/* Internal track auth + content                                              */
/* -------------------------------------------------------------------------- */

/* Constant-time string compare. Avoids leaking the password length / first
   mismatched byte through timing differences. Returns false for any inputs
   of different lengths. */
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Base64url helpers — Web Crypto outputs ArrayBuffers, but we want compact
   URL-safe strings to ship in JSON / Authorization headers. */
function bufToB64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64UrlToBuf(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/* Token shape: <payloadB64Url>.<signatureB64Url>
   Payload is JSON { scope, exp } where exp is an epoch-second integer.
   Compact, no library, easy to verify in either direction. */
async function signInternalToken(secret, payload) {
  const key = await importHmacKey(secret);
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = bufToB64Url(new TextEncoder().encode(payloadJson));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${bufToB64Url(sig)}`;
}

async function verifyInternalToken(secret, token) {
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC", key,
    b64UrlToBuf(sigB64),
    new TextEncoder().encode(payloadB64),
  );
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64UrlToBuf(payloadB64))); }
  catch { return null; }
  if (!payload || payload.scope !== "internal") return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/* Generic per-IP rate limiter. Keyed by namespace + IP + minute window in KV.
   Returns { allowed: true } or { allowed: false, retryAfter: seconds }. */
async function checkRateLimit(request, env, namespace, limit, windowSeconds) {
  if (!env.VISITS_KV) return { allowed: true };
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `ratelimit:${namespace}:${ip}:${window}`;
  const current = parseInt((await env.VISITS_KV.get(key)) || "0", 10);
  if (current >= limit) return { allowed: false, retryAfter: windowSeconds };
  await env.VISITS_KV.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return { allowed: true };
}

async function handleInternalAuth(request, env) {
  if (!env.INTERNAL_PASSWORD || !env.INTERNAL_JWT_SECRET) {
    return json({ error: "internal auth not configured" }, 503, request);
  }
  /* Rate-check FIRST so failed attempts never reach the password compare.
     A 429 here also means the worker did not even attempt to verify, which
     is the right signal both for legit users (back off) and attackers (you
     are throttled regardless of guess quality). */
  const rl = await checkRateLimit(request, env, "auth", AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_SECONDS);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: "too many attempts; try again in a minute" }),
      {
        status: 429,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfter),
        },
      },
    );
  }
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400, request); }
  const password = String(payload?.password || "");
  if (!constantTimeEqual(password, env.INTERNAL_PASSWORD)) {
    // Generic message; do not leak whether the password was empty, too short, etc.
    return json({ error: "invalid password" }, 401, request);
  }
  const exp = Math.floor(Date.now() / 1000) + INTERNAL_TOKEN_TTL_SECONDS;
  const token = await signInternalToken(env.INTERNAL_JWT_SECRET, { scope: "internal", exp });
  return json({ token, expiresAt: new Date(exp * 1000).toISOString() }, 200, request);
}

async function handleInternalContent(request, env, path) {
  if (!env.INTERNAL_JWT_SECRET) {
    return json({ error: "internal auth not configured" }, 503, request);
  }
  if (!env.VISITS_KV) {
    return json({ error: "KV binding missing" }, 503, request);
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const claims = token ? await verifyInternalToken(env.INTERNAL_JWT_SECRET, token) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, request);

  /* Map URL -> KV key. The relative shape mirrors the public /content tree
     so the loader can use the same fetch logic for both. Examples:
       /internal/manifest.json            -> internal:manifest.json
       /internal/paths/foo.json           -> internal:paths/foo.json
       /internal/modules/in-foo.json      -> internal:modules/in-foo.json
     We allow only paths under /internal/ and reject any traversal. */
  const rel = path.replace(/^\/internal\//, "");
  if (!rel || rel.includes("..") || !/^[\w./-]+\.json$/.test(rel)) {
    return json({ error: "bad request" }, 400, request);
  }
  const kvKey = `internal:${rel}`;
  const value = await env.VISITS_KV.get(kvKey);
  if (value === null) return json({ error: "not found", key: kvKey }, 404, request);
  return new Response(value, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/* -------------------------------------------------------------------------- */
/* AI tutor proxy                                                              */
/* -------------------------------------------------------------------------- */

async function handleTutor(request, env) {
  if (!env.OPENAI_API_KEY) return json({ error: "AI tutor not configured" }, 503, request);
  const rl = await checkRateLimit(request, env, "tutor", TUTOR_RATE_LIMIT, AUTH_RATE_WINDOW_SECONDS);
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
      status: 429,
      headers: { ...corsHeaders(request), "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }
  let body;
  try { body = await request.text(); }
  catch { return json({ error: "invalid request" }, 400, request); }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
    body,
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

/* -------------------------------------------------------------------------- */
/* D1 progress routes                                                         */
/* -------------------------------------------------------------------------- */

function domainFromEmail(email) {
  const at = (email || "").indexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function extractBearer(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
}

/* Look up a learner row by session token. Returns null if token is missing,
   unknown, or DB is unavailable. All progress routes call this. */
async function verifyLearnerToken(env, token) {
  if (!token || !env.DB) return null;
  return await env.DB.prepare(
    `SELECT id, email, company_domain FROM learners WHERE session_token = ?`
  ).bind(token).first();
}

async function handleUpsertLearner(request, env) {
  if (!env.DB) return json({ error: "DB not configured" }, 503, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, request); }
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email.includes("@")) return json({ error: "invalid email" }, 400, request);
  const domain = domainFromEmail(email);

  // Reuse an existing token so concurrent devices stay in sync.
  // Generate one only on first registration.
  const existing = await env.DB.prepare(
    `SELECT session_token FROM learners WHERE email = ?`
  ).bind(email).first();
  const token = existing?.session_token || crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO learners (email, name, role, company, company_domain, session_token, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET
       name           = excluded.name,
       role           = excluded.role,
       company        = excluded.company,
       company_domain = excluded.company_domain,
       session_token  = excluded.session_token,
       last_active_at = excluded.last_active_at`
  ).bind(email, body.name || null, body.role || null, body.company || null, domain, token).run();

  return json({ ok: true, token }, 200, request);
}

async function handleUpsertLesson(request, env) {
  if (!env.DB) return json({ error: "DB not configured" }, 503, request);
  const learner = await verifyLearnerToken(env, extractBearer(request));
  if (!learner) return json({ error: "unauthorized" }, 401, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, request); }
  const lessonId = String(body?.lesson_id || "");
  const moduleId = String(body?.module_id || "");
  if (!lessonId || !moduleId) return json({ error: "missing fields" }, 400, request);
  const completedAt = body.completed_at || new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO lesson_progress (learner_id, lesson_id, module_id, completed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(learner_id, lesson_id) DO UPDATE SET completed_at = excluded.completed_at`
  ).bind(learner.id, lessonId, moduleId, completedAt).run();
  return json({ ok: true }, 200, request);
}

async function handleUpsertBadge(request, env) {
  if (!env.DB) return json({ error: "DB not configured" }, 503, request);
  const learner = await verifyLearnerToken(env, extractBearer(request));
  if (!learner) return json({ error: "unauthorized" }, 401, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, request); }
  const badgeId = String(body?.badge_id || "");
  if (!badgeId) return json({ error: "missing fields" }, 400, request);
  const earnedAt = body.earned_at || new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO badges (learner_id, badge_id, earned_at)
     VALUES (?, ?, ?)
     ON CONFLICT(learner_id, badge_id) DO NOTHING`
  ).bind(learner.id, badgeId, earnedAt).run();
  return json({ ok: true }, 200, request);
}

async function handleUpsertBlock(request, env) {
  if (!env.DB) return json({ error: "DB not configured" }, 503, request);
  const learner = await verifyLearnerToken(env, extractBearer(request));
  if (!learner) return json({ error: "unauthorized" }, 401, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, request); }
  const lessonId = String(body?.lesson_id || "");
  const blockIdx = Number(body?.block_idx);
  if (!lessonId || isNaN(blockIdx)) return json({ error: "missing fields" }, 400, request);
  await env.DB.prepare(
    `INSERT INTO block_progress (learner_id, lesson_id, block_idx)
     VALUES (?, ?, ?)
     ON CONFLICT(learner_id, lesson_id, block_idx) DO NOTHING`
  ).bind(learner.id, lessonId, blockIdx).run();
  return json({ ok: true }, 200, request);
}

async function handleGetProgress(request, env) {
  if (!env.DB) return json({ error: "DB not configured" }, 503, request);
  const learner = await verifyLearnerToken(env, extractBearer(request));
  if (!learner) return json({ error: "unauthorized" }, 401, request);
  const [lessons, badges, blocks] = await Promise.all([
    env.DB.prepare(
      `SELECT lesson_id, module_id, completed_at, started_at
       FROM lesson_progress WHERE learner_id = ?`
    ).bind(learner.id).all(),
    env.DB.prepare(
      `SELECT badge_id, earned_at FROM badges WHERE learner_id = ?`
    ).bind(learner.id).all(),
    env.DB.prepare(
      `SELECT lesson_id, block_idx FROM block_progress WHERE learner_id = ?`
    ).bind(learner.id).all(),
  ]);
  return json({ lessons: lessons.results, badges: badges.results, blocks: blocks.results }, 200, request);
}

async function handleGetLeaderboard(request, env) {
  if (!env.DB) return json({ error: "DB not configured" }, 503, request);
  const learner = await verifyLearnerToken(env, extractBearer(request));
  if (!learner) return json({ error: "unauthorized" }, 401, request);
  // Use the token-verified learner's own domain — ignore any query param to
  // prevent enumeration of other companies' data.
  const domain = learner.company_domain;
  if (!domain) return json([], 200, request);
  const rows = await env.DB.prepare(
    `SELECT l.name, l.company,
            COUNT(CASE WHEN lp.completed_at IS NOT NULL THEN 1 END) AS lessons_completed
     FROM learners l
     LEFT JOIN lesson_progress lp ON l.id = lp.learner_id
     WHERE l.company_domain = ?
     GROUP BY l.id
     ORDER BY lessons_completed DESC, l.last_active_at DESC
     LIMIT 10`
  ).bind(domain).all();
  return json(rows.results, 200, request);
}

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": pickOrigin(request),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Authorization is required so the browser can send the Internal token
    // on cross-origin GET /internal/* requests from the static page, and
    // so sync-visitors.js can send the SYNC_TOKEN on GET /.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    /* Vary: Origin tells caches that the response depends on the Origin
       header, so a cached "allow https://foo" doesn't get served back to
       a request from https://bar. */
    "Vary": "Origin",
  };
}

function json(obj, status = 200, request = null) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}
