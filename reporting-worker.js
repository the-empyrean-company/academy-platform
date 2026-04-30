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

const ALLOW_ORIGIN = "*"; // tighten to your domain once you deploy the site

/* Token lifetime for the Internal session. A week is long enough that staff
   are not constantly re-typing the password but short enough that a leaked
   token expires before it becomes a real liability. Rotate INTERNAL_PASSWORD
   to invalidate everything sooner. */
const INTERNAL_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    /* ---- Internal track routes ---------------------------------------- */
    if (path === "/auth/internal" && request.method === "POST") {
      return handleInternalAuth(request, env);
    }
    if (path.startsWith("/internal/") && request.method === "GET") {
      return handleInternalContent(request, env, path);
    }

    /* ---- Reporting routes (legacy /, accepts any path on POST) -------- */
    // GET / — return all stored page_view + event rows for sync-visitors.js
    if (request.method === "GET") {
      return handleGetVisits(env);
    }

    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: "invalid JSON" }, 400); }

    const eventRaw = payload?.event;
    // Backwards compat: old pages send "course_completed" for module-level finishes.
    const event = eventRaw === "course_completed" ? "module_completed" : eventRaw;

    // page_view: no learner required, stored in KV only.
    if (event === "page_view") {
      return handlePageView(request, env, payload);
    }

    const allowed = new Set(["session_start", "lesson_completed", "module_completed", "path_completed"]);
    if (!allowed.has(event)) return json({ error: "unknown event", got: eventRaw }, 400);

    const learner = payload.learner || {};
    if (!learner.email || !learner.name) {
      return json({ error: "learner.name and learner.email required" }, 400);
    }
    const email = String(learner.email).trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "invalid email" }, 400);

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

    return json({ ok: true, stored: true });
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

  return json({ ok: true, logged: !!env.VISITS_KV });
}

async function handleGetVisits(env) {
  if (!env.VISITS_KV) {
    return json({ error: "VISITS_KV binding not configured" }, 503);
  }

  // Return both raw page views and learner events for the scheduled sync.
  const [visits, events] = await Promise.all([
    fetchKVPrefix(env, "visits:"),
    fetchKVPrefix(env, "events:"),
  ]);

  visits.sort((a, b) => (b.at > a.at ? 1 : -1));
  events.sort((a, b) => (b.at > a.at ? 1 : -1));

  return new Response(JSON.stringify({ visits, events }), {
    status: 200,
    headers: {
      ...corsHeaders(),
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

async function handleInternalAuth(request, env) {
  if (!env.INTERNAL_PASSWORD || !env.INTERNAL_JWT_SECRET) {
    return json({ error: "internal auth not configured" }, 503);
  }
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }
  const password = String(payload?.password || "");
  if (!constantTimeEqual(password, env.INTERNAL_PASSWORD)) {
    // Generic message; do not leak whether the password was empty, too short, etc.
    return json({ error: "invalid password" }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + INTERNAL_TOKEN_TTL_SECONDS;
  const token = await signInternalToken(env.INTERNAL_JWT_SECRET, { scope: "internal", exp });
  return json({ token, expiresAt: new Date(exp * 1000).toISOString() });
}

async function handleInternalContent(request, env, path) {
  if (!env.INTERNAL_JWT_SECRET) {
    return json({ error: "internal auth not configured" }, 503);
  }
  if (!env.VISITS_KV) {
    return json({ error: "KV binding missing" }, 503);
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const claims = token ? await verifyInternalToken(env.INTERNAL_JWT_SECRET, token) : null;
  if (!claims) return json({ error: "unauthorized" }, 401);

  /* Map URL -> KV key. The relative shape mirrors the public /content tree
     so the loader can use the same fetch logic for both. Examples:
       /internal/manifest.json            -> internal:manifest.json
       /internal/paths/foo.json           -> internal:paths/foo.json
       /internal/modules/in-foo.json      -> internal:modules/in-foo.json
     We allow only paths under /internal/ and reject any traversal. */
  const rel = path.replace(/^\/internal\//, "");
  if (!rel || rel.includes("..") || !/^[\w./-]+\.json$/.test(rel)) {
    return json({ error: "bad request" }, 400);
  }
  const kvKey = `internal:${rel}`;
  const value = await env.VISITS_KV.get(kvKey);
  if (value === null) return json({ error: "not found", key: kvKey }, 404);
  return new Response(value, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Authorization is required so the browser can send the Internal token
    // on cross-origin GET /internal/* requests from the static page.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
