# Updated prompt for academy-visitor-sync scheduled task

Apply this via: open a regular Cowork session → ask Claude to update the `academy-visitor-sync` scheduled task with the prompt below.

---

Read learner activity from the local visitors.json file and upsert records into the Notion Learners Logs database (ID: 351e32e8f8c880668b0ec3d835c78398).

visitors.json is populated by running `node sync-visitors.js` beforehand. That script fetches from the Cloudflare Worker and writes a clean local snapshot. This task only reads from the file — it never hits the Worker directly.

## Step 1 — Read data from visitors.json

Read the file at: /Users/alvaro.avelar/Documents/Claude/Projects/Academy platform/visitors.json

The file is a JSON object with:
- `syncedAt` — ISO timestamp of when the file was last synced from the Worker
- `visits` — raw page_view hits with fields: at, country, referrer, learner (email, name, role, company)
- `events` — identified learner events with these fields:
  {
    "event": "session_start" | "lesson_completed" | "module_completed" | "path_completed",
    "at": "2026-04-29T10:22:01.000Z",
    "country": "NL",
    "milestone": "Lesson: Intro to Qargo",  // null for session_start
    "learner": {
      "email": "alice@qargo.com",
      "name": "Alice",
      "role": "Super Admin",
      "company": "Qargo"        // may be null — derive from email if missing
    }
  }

If the file is missing, or both `visits` and `events` are empty arrays, stop and report that visitors.json needs to be synced first (`node sync-visitors.js`). Do not write to Notion.

## Step 2 — Build per-learner summaries

Group all entries (from both `visits` and `events`) by learner email. Skip any record where email is missing or does not contain "@".

For each learner compute:
- `latestLogin`: the most recent `at` value across all their events
- `loginCount`: number of `session_start` events
- `milestones`: deduplicated list of all non-null `milestone` values across their events
- `lastMilestone`: milestone from their most recent non-session_start event (null if none)
- `country`: country from their most recent event that has one
- `name`, `role`: from their most recent event
- `company`: use the `company` field from the event if non-null and non-empty; otherwise derive it from the email domain — capitalise the domain name (e.g. alice@acme.com → "Acme", alvaro@qargo.com → "Qargo"). Strip common suffixes (.com, .nl, .be, .io, etc.) before capitalising.

Also collect:
- `allVisits`: all entries from the `visits` array for this learner, sorted by `at` descending
- `allEvents`: all entries from the `events` array for this learner, sorted by `at` descending

## Step 3 — Upsert row properties into Notion

For each learner, query the Notion database for an existing page where Email = learner email.

If a page exists, update its properties:
- Learner (Title): name
- Latest login (Date): latestLogin (datetime, is_datetime = 1)
- Login count (Number): loginCount
- Milestones (Multi-select): merge existing milestones with new ones — no duplicates. If a milestone value does not exist as a schema option yet, add it first using the update_data_source tool before updating the page.
- Last milestone (Text): lastMilestone (only update if non-null)
- Country (Text): country (only update if non-null)
- Role (Select): role (only update if non-null)
- Company (Text): company (always update)

If no page exists, create one with all the above fields set.

## Step 4 — Write visit and event history inside each learner page

After upserting the row properties, replace the entire page content with a structured history log using `replace_content`. This keeps the database uncluttered — all detail lives inside the page, not in extra rows.

Use the following Markdown structure:

---

## Visit History

| Date (UTC) | Country | Referrer |
|---|---|---|
| [YYYY-MM-DD HH:mm:ss] | [country code or —] | [referrer URL or —] |

(one row per visit, most recent first)

---

## Event Log

| Date (UTC) | Event | Milestone |
|---|---|---|
| [YYYY-MM-DD HH:mm:ss] | [event type] | [milestone or —] |

(one row per event, most recent first)

---

Replace null values with `—`. Overwrite the full page body on every run so it always reflects the latest data from the worker.

## Step 5 — Report summary

Print: total visits fetched, total events fetched, unique learners processed, pages created vs updated in Notion.
