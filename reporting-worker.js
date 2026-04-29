/*
 * Academy Reporting Worker
 * ------------------------
 * Tiny Cloudflare Worker that receives lightweight learner events from the
 * academy's static HTML page and writes them to a Notion database, keyed by
 * email (one row per learner, upserted).
 *
 * EVENTS ACCEPTED
 *   page_view         — fired on every page load, no identity required.
 *                       Stored in Cloudflare KV under key visits:YYYY-MM-DD as a
 *                       JSON array. Includes timestamp, country, referrer, and
 *                       learner info if already identified.
 *   session_start     — fired on every page load when an identified learner is present.
 *                       Updates Latest login, bumps Login count, sets Country.
 *   lesson_completed  — fires the first time a lesson is marked done.
 *                       Adds "Lesson: <title>" to Milestones; sets Last milestone.
 *   module_completed  — fires the first time every lesson in a module is done.
 *                       Adds "Module: <title>" to Milestones; sets Last milestone.
 *   path_completed    — fires the first time the entire learning path is done.
 *                       Adds "Path: <title>" to Milestones; sets Last milestone.
 *
 *   The legacy "course_completed" event name is still accepted and treated as
 *   module_completed, so older deployed pages keep working.
 *
 * GET /visits
 *   Returns all stored page_view entries as a JSON array, sorted newest-first.
 *   Used by sync-visitors.js to build the local visitors.json file.
 *
 * KV SETUP (for page_view storage)
 *   1. Cloudflare dashboard -> Workers & Pages -> KV -> Create namespace "ACADEMY_VISITS".
 *   2. On your Worker -> Settings -> Bindings -> KV Namespace: variable name = VISITS_KV.
 *   If VISITS_KV is not bound the Worker silently skips KV writes (page_view still
 *   returns 200 so the page doesn't error).
 *
 * AUDIT-GRADE CAVEAT
 *   Events are reported by the learner's browser. A learner with DevTools could
 *   send fake events. This is fine for an internal engagement view but NOT proof
 *   of completion. The path to audit-grade is documented in the Notion callout
 *   on the "Qargo University - Project Management Dashboard" page (above the
 *   Learners Logs database).
 *
 * HOW TO DEPLOY (5 minutes)
 *
 * 1. Create a Notion integration
 *    - Go to https://www.notion.so/my-integrations and click "New integration".
 *    - Name it (e.g. "Academy Reporter") and copy the Internal Integration Secret.
 *
 * 2. Connect the integration to the existing "Learners Logs" database
 *    - Open the database, click the "..." menu -> Connections -> add the integration.
 *    - Copy the database ID from the URL: notion.so/<workspace>/<DB_ID>?v=...
 *      The DB_ID is the 32-char hash before the "?".
 *      For Qargo's deployed DB the ID is: 351e32e8f8c880668b0ec3d835c78398
 *
 *    The database schema this Worker expects (already created):
 *      - Learner         (Title)
 *      - Email           (Email)              <-- upsert key
 *      - Role            (Select)
 *      - Company         (Text)
 *      - Latest login    (Date)
 *      - Login count     (Number)
 *      - Milestones      (Multi-select)
 *      - Last milestone  (Text)
 *      - Country         (Text)
 *
 * 3. Deploy this Worker
 *    - https://dash.cloudflare.com -> Workers & Pages -> Create -> Hello World.
 *    - Replace the default code with this file, click Deploy.
 *    - Settings -> Variables, add two SECRETS:
 *         NOTION_TOKEN        = <integration secret>
 *         NOTION_DATABASE_ID  = <database id>
 *    - Settings -> Triggers -> note the *.workers.dev URL.
 *
 * 4. Wire the URL into index.html
 *    - Open index.html, find REPORTING_ENDPOINT at the top of <script>, paste the URL.
 *    - Reload the page, log in, complete a lesson — check the Notion database.
 */

const ALLOW_ORIGIN = "*"; // tighten to your domain once you deploy the site
const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // GET /visits — return all stored page_view rows for sync-visitors.js
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

    // page_view: no learner required, stored in KV only (not Notion).
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

    // Always store the event in KV so the scheduled sync can pick it up
    // regardless of whether Notion secrets are configured on this Worker.
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

    // 1) Find existing row by Email (upsert key).
    const existing = await findPageByEmail(env, email);

    if (existing) {
      // 2a) Update in place.
      const props = existing.properties || {};
      const currentMilestones = (props["Milestones"]?.multi_select || []).map(o => o.name);
      const mergedMilestones = milestoneLabel && !currentMilestones.includes(milestoneLabel)
        ? [...currentMilestones, milestoneLabel]
        : currentMilestones;

      const currentLoginCount = props["Login count"]?.number || 0;
      const newLoginCount = event === "session_start" ? currentLoginCount + 1 : currentLoginCount;

      const updatedProps = {
        // Refresh fields that might have changed (rename, role change, company).
        "Learner": { title: [{ text: { content: String(learner.name).slice(0, 200) } }] },
        "Milestones": { multi_select: mergedMilestones.map(name => ({ name: name.slice(0, 100) })) },
      };
      if (learner.company) {
        updatedProps["Company"] = { rich_text: [{ text: { content: String(learner.company).slice(0, 200) } }] };
      }
      if (learner.roleLabel) {
        updatedProps["Role"] = { select: { name: String(learner.roleLabel).slice(0, 100) } };
      }
      if (event === "session_start") {
        updatedProps["Latest login"] = { date: { start: nowIso } };
        updatedProps["Login count"] = { number: newLoginCount };
        if (country) updatedProps["Country"] = { rich_text: [{ text: { content: country } }] };
      }
      if (milestoneLabel) {
        updatedProps["Last milestone"] = { rich_text: [{ text: { content: milestoneLabel.slice(0, 200) } }] };
      }

      const res = await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: "PATCH",
        headers: notionHeaders(env),
        body: JSON.stringify({ properties: updatedProps }),
      });
      if (!res.ok) return notionError(res, "patch");
      return json({ ok: true, mode: "updated", id: existing.id });
    }

    // 2b) Create a new row.
    const properties = {
      "Learner": { title: [{ text: { content: String(learner.name).slice(0, 200) } }] },
      "Email":   { email },
    };
    if (learner.company) {
      properties["Company"] = { rich_text: [{ text: { content: String(learner.company).slice(0, 200) } }] };
    }
    if (learner.roleLabel) {
      properties["Role"] = { select: { name: String(learner.roleLabel).slice(0, 100) } };
    }
    properties["Latest login"] = { date: { start: nowIso } };
    properties["Login count"]  = { number: event === "session_start" ? 1 : 0 };
    if (country) properties["Country"] = { rich_text: [{ text: { content: country } }] };
    if (milestoneLabel) {
      properties["Milestones"]    = { multi_select: [{ name: milestoneLabel.slice(0, 100) }] };
      properties["Last milestone"] = { rich_text: [{ text: { content: milestoneLabel.slice(0, 200) } }] };
    }

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: notionHeaders(env),
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties,
      }),
    });
    if (!res.ok) return notionError(res, "create");
    const created = await res.json();
    return json({ ok: true, mode: "created", id: created.id });
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

  // Return both raw page views and learner events so the scheduled sync
  // can process everything from one endpoint.
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

async function findPageByEmail(env, email) {
  // Notion's data-source/database query: filter by Email property equals.
  const res = await fetch(
    `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: notionHeaders(env),
      body: JSON.stringify({
        filter: { property: "Email", email: { equals: email } },
        page_size: 1,
      }),
    }
  );
  if (!res.ok) {
    console.error("notion query error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return (data.results && data.results[0]) || null;
}

function notionHeaders(env) {
  return {
    "Authorization": `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionError(res, label) {
  const text = await res.text();
  console.error(`notion ${label} error`, res.status, text);
  return json({ error: `notion ${label} rejected`, status: res.status, detail: text }, 502);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
