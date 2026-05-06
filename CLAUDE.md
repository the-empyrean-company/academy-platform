# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

```bash
./serve.command          # starts Python HTTP server at http://localhost:8000
```

Opening `index.html` via `file://` will not work — the runtime loader uses `fetch()` which browsers block on the local-file protocol.

## Deploying the Worker

```bash
wrangler deploy                                    # deploy reporting-worker.js
wrangler secret put SYNC_TOKEN                     # gates GET / on the Worker
wrangler secret put INTERNAL_PASSWORD              # shared staff password
wrangler secret put INTERNAL_JWT_SECRET            # HMAC signing key
wrangler d1 execute academy-db --remote --file=schema.sql   # apply D1 schema (idempotent)
```

## Syncing visitor data

```bash
ACADEMY_SYNC_TOKEN=<token> node sync-visitors.js
```

Pulls learner events from Cloudflare KV into `visitors.json` (gitignored), which the `academy-visitor-sync` scheduled task then pushes to Notion.

## Pushing internal content to KV

```bash
cd internal-content && ./push.sh
```

## Architecture

**Single-file SPA** — `index.html` contains the entire application: HTML shell, all CSS, all JS. No build step, no bundler, vanilla JS only.

**Content tree** — lesson content lives in `content/` and is fetched at runtime. The loader reads `content/manifest.json`, fans out parallel fetches for every path/track/module/lesson, then caches the assembled bundle in `localStorage` keyed by `manifest.version`. Bump the version on every content change to bust the cache.

**Routing** — hash-based. `#/` = catalog, `#/course/<id>` = module view, `#/blocks` = block library demo, `#/badge` = completion certificate. Anything else = not-found.

**Content hierarchy** — Learning Path → Modules → Lessons → Blocks. Each layer references the next by ID. Lesson IDs are permanent: learner progress is keyed on them, so never rename a published lesson ID.

**Block system** — 14 block types: `text`, `accordion`, `summary`, `quiz`, `flashcards` (alias `flipcard`), `match`, `embed`, `image`, `carousel`, `fillblanks`, `process`, `timeline`, `milestone`, `tutor`. Each has its own renderer in `app.js`; the dispatcher is `renderBlock()`. Adding a new block type is a platform change — update the renderer first, then author content against it.

**Drag-and-drop utility** — `addDropZone(el, onDrop)` in `app.js` wires `dragover`/`dragleave`/`drop` onto any element with the `relatedTarget` fix applied (prevents the "over" class flickering when the pointer crosses child elements). Use it for any block that needs a drop target instead of writing the three listeners inline.

**Completion contract** — every block renderer receives a `markDone` callback. A lesson completes only when all its blocks have fired `markDone`. Module completion requires all lessons; path completion requires all modules.

**Persistence** — all state lives in `localStorage`:
- `academy.learner` — role/name
- `academy.completed` — finished module IDs
- `academy.progress` — per-module completed lesson IDs
- `academy.content_cache` — assembled content bundle (keyed by manifest version)
- `academy.internal_token` — Worker-issued session token for the Internal track
- `academy.openai_key` — AI tutor key (set by the learner via the tutor block's settings cog)
- `academy.badges_earned` — badge ID → ISO timestamp
- `academy.activity_dates` — array of `YYYY-MM-DD` strings for streak tracking
- `academy.session_token` — UUID issued by D1 `/learner` route; sent as `Authorization: Bearer` on all D1 calls

**Cloudflare Worker** (`reporting-worker.js`) — handles five concerns:
1. Event reporting: `POST /` writes learner events to KV.
2. Visitor dump: `GET /` (requires `SYNC_TOKEN`) returns all events for `sync-visitors.js`.
3. Internal track gate: `POST /auth/internal` issues HMAC-signed tokens; `GET /internal/*` serves content from KV behind token auth.
4. Learner identity: `POST /learner` upserts a learner row in D1, returns a stable UUID session token (reused across devices for the same email).
5. Progress tracking: `POST /progress/lesson`, `POST /progress/badge`, `GET /progress`, `GET /leaderboard` — all require `Authorization: Bearer <session_token>`. Leaderboard is scoped to the learner's email domain (server-enforced, not client-supplied).

**Internal track** — content lives in KV under `internal:` key prefix (not in the repo). Upload via `internal-content/push.sh`. The `internal` role is hidden from the profile dropdown unless the email domain matches `qargo.com`. Token TTL is one week; rotate `INTERNAL_JWT_SECRET` to instantly invalidate all existing tokens.

## Content authoring

The canonical authoring reference is `LESSON_AUTHORING_INSTRUCTIONS.md`. Key points:

- Lesson IDs follow the convention `m{N}-l{N}-{kebab-case-title}` (e.g. `m1-l3-order-of-operations`). Internal: `madmin-l{N}-...`.
- After adding a lesson: add its ID to the parent module file, add it to `manifest.json`, bump `manifest.version`.
- Lesson rhythm: text → interactive block → (optional support block) → summary → quiz. 4–6 blocks, 5–10 minutes.
- No em dashes, no emojis. Plain English, second person.
- Source databases per module are listed in `LESSON_AUTHORING_INSTRUCTIONS.md` section 5 (Notion links).

## Workflow

Before taking any action: think through possible solutions, propose a strategy, and wait for explicit approval before implementing.

## Rules

- Do not remove block renderers, the block dispatcher, progressive reveal, the lesson-transition banner, the collapsible TOC, per-block completion tracking, or the learning path > modules > lessons hierarchy without explicit confirmation.
- Never commit internal-track secrets. Set them via `wrangler secret put`.
- No pixel offsets for layout alignment — use grid/flex auto-alignment and restructure the DOM instead.
- The live block demo at `#/blocks` is the canonical reference for block field shapes.
