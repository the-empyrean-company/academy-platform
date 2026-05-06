#!/usr/bin/env node
/*
 * sync-visitors.js
 * ----------------
 * Fetches all learner activity from the Academy Reporting Worker (stored in
 * Cloudflare KV) and writes it to visitors.json in this directory.
 *
 * visitors.json is the local source of truth for the academy-visitor-sync
 * scheduled task, which reads from this file to populate the Notion Learners
 * Logs database. The flow is:
 *
 *   Cloudflare Worker (KV)  →  sync-visitors.js  →  visitors.json
 *                                                         ↓
 *                                              academy-visitor-sync (Notion)
 *
 * No Notion access required here. The Worker must be deployed and VISITS_KV
 * must be bound (see reporting-worker.js for setup instructions).
 *
 * USAGE
 *   ACADEMY_SYNC_TOKEN=<token> node sync-visitors.js
 *
 * CONFIGURATION
 *   Set WORKER_URL in the block below, or pass it as the first CLI argument:
 *   node sync-visitors.js https://academy-reporter.<you>.workers.dev
 *
 *   ACADEMY_SYNC_TOKEN env var must match the SYNC_TOKEN secret on the
 *   worker (set with `wrangler secret put SYNC_TOKEN`). Without it the
 *   worker rejects GET / with HTTP 401, since the endpoint exposes every
 *   learner's email and is not safe to leave open. Generate a fresh
 *   token with `openssl rand -hex 32`.
 *
 * OUTPUT
 *   visitors.json — object with two arrays, both sorted newest-first:
 *   {
 *     "syncedAt": "2026-04-29T10:22:01.000Z",
 *     "visits": [            // anonymous page_view records
 *       {
 *         "at": "2026-04-29T10:22:01.000Z",
 *         "country": "NL",
 *         "referrer": "https://www.linkedin.com/...",
 *         "learner": {       // present only if the visitor was identified
 *           "email": "alice@qargo.com",
 *           "name": "Alice",
 *           "role": "Super Admin"
 *         }
 *       }
 *     ],
 *     "events": [            // identified learner activity records
 *       {
 *         "event": "session_start" | "lesson_completed" | "module_completed" | "path_completed",
 *         "at": "2026-04-29T10:22:01.000Z",
 *         "country": "NL",
 *         "milestone": "Lesson: Intro to Qargo",  // null for session_start
 *         "learner": {
 *           "email": "alice@qargo.com",
 *           "name": "Alice",
 *           "role": "Super Admin",
 *           "company": "Qargo"
 *         }
 *       }
 *     ]
 *   }
 */

const fs   = require("fs");
const path = require("path");

// ── Configuration ────────────────────────────────────────────────────────────
const WORKER_URL = process.argv[2] || "https://academy-reporter.alvaro-avelar.workers.dev/"; // override via CLI arg
const OUT_FILE   = path.join(__dirname, "visitors.json");
const SYNC_TOKEN = process.env.ACADEMY_SYNC_TOKEN;
// ─────────────────────────────────────────────────────────────────────────────

if (!WORKER_URL) {
  console.error(
    "Error: no Worker URL provided.\n" +
    "Usage: ACADEMY_SYNC_TOKEN=<token> node sync-visitors.js https://academy-reporter.<you>.workers.dev\n" +
    "Or set WORKER_URL inside sync-visitors.js."
  );
  process.exit(1);
}

if (!SYNC_TOKEN) {
  console.error(
    "Error: ACADEMY_SYNC_TOKEN environment variable is required.\n" +
    "This token authenticates against the worker's GET / endpoint, which\n" +
    "exposes every learner email and must not be left open.\n" +
    "\n" +
    "Setup:\n" +
    "  1. Generate a token:    openssl rand -hex 32\n" +
    "  2. Set on the worker:   wrangler secret put SYNC_TOKEN\n" +
    "  3. Set in your shell:   export ACADEMY_SYNC_TOKEN=<token>\n" +
    "  4. Re-run this script.\n"
  );
  process.exit(1);
}

(async () => {
  let res;
  try {
    res = await fetch(WORKER_URL, {
      headers: { Authorization: `Bearer ${SYNC_TOKEN}` },
    });
  } catch (e) {
    console.error("Request failed:", e.message);
    process.exit(1);
  }

  if (res.status === 401) {
    console.error(
      "Worker returned 401: ACADEMY_SYNC_TOKEN does not match the SYNC_TOKEN\n" +
      "secret on the worker. Re-run `wrangler secret put SYNC_TOKEN` and make\n" +
      "sure your local env var matches what you pasted in."
    );
    process.exit(1);
  }
  if (res.status === 503) {
    console.error(
      "Worker returned 503: SYNC_TOKEN secret is not configured on the worker.\n" +
      "Run `wrangler secret put SYNC_TOKEN` and paste the token, then redeploy."
    );
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`Worker returned HTTP ${res.status}:\n${body}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch (e) {
    console.error("Could not parse Worker response as JSON:", e.message);
    process.exit(1);
  }

  // Worker returns { visits, events, learners }; fall back to plain array for older deploys.
  let visits, events, learners;
  if (Array.isArray(parsed)) {
    // Legacy: older worker returned a flat array of page_view records only.
    visits = parsed;
    events = [];
    learners = [];
  } else if (parsed && Array.isArray(parsed.visits)) {
    visits = parsed.visits;
    events = Array.isArray(parsed.events) ? parsed.events : [];
    learners = Array.isArray(parsed.learners) ? parsed.learners : [];
  } else {
    console.error("Unexpected response shape (expected array or {visits, events, learners}):", JSON.stringify(parsed));
    process.exit(1);
  }

  // Sort newest-first.
  visits.sort((a, b) => (b.at > a.at ? 1 : -1));
  events.sort((a, b) => (b.at > a.at ? 1 : -1));
  learners.sort((a, b) => (b.last_active_at > a.last_active_at ? 1 : -1));

  const output = {
    syncedAt: new Date().toISOString(),
    visits,
    events,
    learners,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${visits.length} visit(s), ${events.length} event(s), and ${learners.length} learner(s) to ${OUT_FILE}`);
})();
