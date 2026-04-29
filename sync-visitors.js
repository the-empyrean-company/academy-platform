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
 *   node sync-visitors.js
 *
 * CONFIGURATION
 *   Set WORKER_URL in the block below, or pass it as the first CLI argument:
 *   node sync-visitors.js https://academy-reporter.<you>.workers.dev
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
const https = require("https");
const http  = require("http");

// ── Configuration ────────────────────────────────────────────────────────────
const WORKER_URL = process.argv[2] || "https://academy-reporter.alvaro-avelar.workers.dev/"; // override via CLI arg
const OUT_FILE   = path.join(__dirname, "visitors.json");
// ─────────────────────────────────────────────────────────────────────────────

if (!WORKER_URL) {
  console.error(
    "Error: no Worker URL provided.\n" +
    "Usage: node sync-visitors.js https://academy-reporter.<you>.workers.dev\n" +
    "Or set WORKER_URL inside sync-visitors.js."
  );
  process.exit(1);
}

const url = new URL(WORKER_URL);
const lib = url.protocol === "https:" ? https : http;

lib.get(WORKER_URL, (res) => {
  let body = "";
  res.on("data", (chunk) => (body += chunk));
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(`Worker returned HTTP ${res.statusCode}:\n${body}`);
      process.exit(1);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      console.error("Could not parse Worker response as JSON:", e.message);
      process.exit(1);
    }
    // Worker returns { visits, events }; fall back to plain array for older deploys.
    let visits, events;
    if (Array.isArray(parsed)) {
      // Legacy: older worker returned a flat array of page_view records only.
      visits = parsed;
      events = [];
    } else if (parsed && Array.isArray(parsed.visits)) {
      visits = parsed.visits;
      events = Array.isArray(parsed.events) ? parsed.events : [];
    } else {
      console.error("Unexpected response shape (expected array or {visits, events}):", JSON.stringify(parsed));
      process.exit(1);
    }

    // Sort both arrays newest-first.
    visits.sort((a, b) => (b.at > a.at ? 1 : -1));
    events.sort((a, b) => (b.at > a.at ? 1 : -1));

    const output = {
      syncedAt: new Date().toISOString(),
      visits,
      events,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
    console.log(`Wrote ${visits.length} visit(s) and ${events.length} event(s) to ${OUT_FILE}`);
  });
}).on("error", (e) => {
  console.error("Request failed:", e.message);
  process.exit(1);
});
