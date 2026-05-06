# Qargo Academy — project context

A SCORM-style eLearning mockup. The shell, all CSS, and all JS still live in `index.html`; lesson content has been pulled out into a versioned `content/` tree fetched at runtime. A small Cloudflare Worker (`reporting-worker.js`) handles event reporting and now also gates an Internal track behind a shared password. Vanilla JS, no build step. Everything below reflects decisions we've locked in so far.

## Architecture

- **Shell file**: `index.html` contains HTML shell, all CSS, all JS. Lesson content is no longer inlined; it is loaded from `content/` at runtime.
- **Content tree**: `content/manifest.json` lists every paths / tracks / modules / lessons ID. Each ID resolves to its own JSON file under `content/<kind>/<id>.json`. `loadContent()` fetches the manifest, fans out the per-file fetches in parallel, and assembles `MODULES`, `LEARNING_PATH`, `SPECIALISED_MODULES`, `EXTRA_CURRICULAR`, and `INTERNAL_MODULES`. The bundle is cached in `localStorage` keyed by `manifest.version` so subsequent loads are one fetch.
- **Routing**: hash-based — `#/` is the catalog, `#/course/<id>` is a module, `#/blocks` is the block library demo page. Anything else → not-found.
- **Content hierarchy**: Learning Path → Modules → Lessons → Blocks.
- **Block types**: `text`, `accordion`, `summary`, `quiz`, `flashcards` (alias `flipcard`), `match`, `embed`, `image`, `carousel`, `fillblanks`, `process`, `timeline`, `milestone`, `tutor`. Each has its own renderer; the dispatcher is `renderBlock()`.
- **Persistence**: `localStorage` keys `LS_LEARNER` (role/name), `LS_COMPLETED` (finished modules), `LS_PROGRESS` (per-module completed lessons, tracked by lesson ID, not index), `LS_CONTENT_CACHE` (the assembled content bundle keyed by manifest version), `LS_INTERNAL_TOKEN` (Worker-issued session token for the Internal track), `academy.openai_key` (AI tutor key, set by the learner via the tutor block's settings cog), `academy.session_token` (UUID from D1 `/learner`; Bearer token for all progress/leaderboard calls).
- **Completion contract**: each block renderer receives a `markDone` callback, plus an optional `ctx` argument with `{ lesson: { title, body }, course: { id, title } }` used by the AI tutor. A lesson is marked complete only when all its blocks have signaled done. The path card and progress bars are derived from this state.

## Home page

- **Full-bleed photo hero** with the Qargo TMS truck image (`qargo.com/u/2025/07/Qargo-tms-1-1.avif`) under a dark gradient. White heading, "Quick start" green CTA, outlined "Browse All Courses" button.
- `main.home-view` releases the default 1200 px cap so the hero can span the viewport; the rest of the page is wrapped in `.home-content` which reinstates the 1200 px cap.
- **Two-column layout below the hero** — left: path card + specialised + extra-curricular grids; right: sidebar stack.
- **Section header lives above the grid**, not inside the left column, so "Learner progress" and the path card auto-align by grid row start. No pixel offsets.
- **Sidebar cards are compact and collapsible** — each has a clickable header with a chevron; `data-collapsed` on the section drives the CSS. Learner-progress stats render as a 3-column mini-stat row, not a tall vertical list. The leaderboard uses tighter row padding.
- Renamed "Your learning at a glance" → **"Learner progress"**.

## Course / lesson view

- **Full-viewport course hero** with the Qargo Team backdrop (`transportmedia.be/.../Qargo-Team-1.jpg`). Dark gradient overlay, white hero copy, a bottom-center "Start module" button that smooth-scrolls to lesson 1.
- **Frameless blocks** — no card chrome, transparent backgrounds. Block typography is newspaper-scale: 32 px headings, 18 px prose with 1.75 line-height, 22 px lead paragraphs.
- **Each lesson section scrolls like an article**, one block after another, with generous vertical rhythm.
- **Lesson-transition banner** sits full-width between lessons. Background is slightly darker than the content surface (`#E4E9EF`) so it clearly separates. Shows "N of TOTAL — Next lesson title" with arrow and a centered button; the title + arrow use Qargo green.
- **Progressive reveal** — lessons and transitions beyond the current "revealed index" are `display: none` (`.is-locked`). The natural end of one lesson is the transition banner. Clicking the button unlocks the next section and smooth-scrolls to it. **First-time visitors start with `revealedIdx = -1`** so the hero acts as a real gate; clicking "Start module" sets `revealedIdx = 0` and unlocks lesson 1. Returning learners (any completed lesson on the module) bypass the gate.
- **Block focus indicator** — a scroll-driven tracker (`updateBlockFocus`) finds the block whose centre is closest to the viewport centre and marks it `.is-focused`; the hosting section-wrap gets `.has-focus`. CSS dims the other blocks in that lesson to opacity 0.42 and adds a brand-green left-rail accent on the active block. This gives learners a clear "you are here" cue without removing surrounding context. Throttled with `requestAnimationFrame`. Honours `prefers-reduced-motion`.
- **Animations** — IntersectionObserver fades/slides the transition banner in on scroll. Newly revealed sections replay a `lesson-reveal` keyframe via a forced reflow (`void target.offsetWidth`) so the animation restarts cleanly.
- **Final transition banner** has a navy background and a "Finish module" button; clicking returns to the catalog.
- **Collapsible table of contents** — fixed-position drawer that slides in from the left, backed by a semi-opaque backdrop. A floating "course pin" at the bottom-left toggles it, showing current lesson number and title.
- **Routing bug fix baked in** — the transition button is a real `<button>` (not an `<a href="#section-N">`); anchor hashes would otherwise collide with the hash router and send the user back to the catalog.

## Block behaviors

- **Text** — optional lead paragraph + body. Marks done on render.
- **Accordion** — every row must be expanded to mark done.
- **Summary** — renders key points, marks done on render.
- **Quiz** — standard single-select radio list with custom green dots, a hidden native radio input per option (for semantics), and an explicit "Submit answer" button that's disabled until an option is picked. On submit: options lock, chosen option highlights correct/wrong, correct answer is revealed if the choice was wrong, feedback appears below, block marked done. Each quiz gets a unique `name` group so multiple quizzes on the same page don't interfere.
- **Flashcards / Flipcard** — click-to-flip cards; marks done once half the deck has been flipped.
- **Match** — drag terms onto definitions; Check/Reset buttons. Chips are always draggable: slot-to-slot and slot-back-to-pool both work. All drop zones use the shared `addDropZone(el, onDrop)` helper which includes the `relatedTarget` guard on `dragleave` to prevent the highlight flickering when the pointer crosses child elements.
- **Embed** — iframe with "Mark as done" confirmation button.
- **Image** — single image with optional caption. Marks done on render.
- **Carousel** — `slides: [{ src, alt, caption }]` with prev/next buttons, dots, arrow-key navigation. Marks done once every slide has been viewed at least once.
- **Fill in the blanks** — paragraph in `text` field with `{answer}` tokens parsed into inline inputs. Check button grades (case-insensitive by default), Reveal button shows answers and marks done. Marks done on full correct or after reveal.
- **Process** — numbered vertical stepper with click-to-expand bodies. Same completion contract as accordion — every step must be opened.
- **Timeline** — vertical date-anchored events. IntersectionObserver fades each event in. Marks done on render.
- **Milestone** — celebratory marker between sections. Confetti canvas burst on first scroll-in (no library, raw `<canvas>` particles). Marks done when the learner clicks the CTA.
- **Tutor (AI)** — lesson-aware chat panel. Reads OpenAI key from `localStorage.academy.openai_key`; first-use UI prompts for the key behind a settings cog. Calls `gpt-4o-mini` chat completions; system prompt is built from `ctx.lesson` (title + concatenated text/summary/accordion/process/timeline content, truncated to ~4000 chars). Marks done on first successful answer. **For shared/remote hosting, set `OPENAI_PROXY_URL` near the top of the AI Tutor section to a backend proxy that injects the key server-side; otherwise the key lives only on each learner's machine.**

## Design tokens

- **Brand green**: `--brand-600` = `#00E85B`. Used for eyebrow labels ("Learning path", "Lesson 2 of 5"), CTAs, accent text, radio dots, progress bars.
- **Brand navy**: `--brand-900`. Used for the final transition banner, the course pin, button text on green backgrounds.
- **Content surface**: `--surface` (white).
- **Transition banner surface**: `#E4E9EF` (distinctly darker than content).
- **Borders**: `--border` for neutral chrome; transition banner uses `#CED5DD` to match its darker fill.

## Block library demo page

- **Route**: `#/blocks` — renders a single page (`renderBlocksDemo()`) with a working example of every block type, plus a one-line description of what it's for and when to use it.
- **Numbered demos** — each block gets a number badge in its heading and the TOC, plus a "Block N of total" caption. Helps authors talk about specific blocks ("see block 7 in the library") and reduces orientation friction.
- **Anchor TOC** — top-of-page chip row links to each demo via `#/blocks#demo-<id>`; the route handler honours the secondary hash and scrolls to the section.
- **Discovery** — linked from the home page sidebar under a "For authors" card.
- **Tutor demo** — uses a synthetic `ctx` so the lesson-aware tutor has something to ground its answers in.

## Path completion certificate

- **Route**: `#/badge` — renders `renderBadge()`. Shows a stylised certificate of completion with the learner's name, path title, completion date, and a deterministic cert ID (e.g. `QA-2026-A1B2C3`).
- **Cert source** — built as inline SVG via `buildCertificateSVG()` so it scales crisply on the page and downloads as a PNG via canvas (`drawImage` of the serialised SVG, 2x scale).
- **LinkedIn integration** — primary CTA uses LinkedIn's official "Add to Profile" prefill URL (`linkedin.com/profile/add?startTask=CERTIFICATION_NAME&...`). Pre-fills name, organisation, issue date, cert URL, and cert ID; the learner just clicks Save in LinkedIn.
- **Persistence** — `LS_PATH_COMPLETED` stores the ISO timestamp of first path completion; `LS_CERT_ID` stores the deterministic ID. Set inside `reportCompletion()` when `isPathComplete()` flips true, so the cert is ready the moment the learner navigates to `#/badge`.
- **Locked state** — visiting `#/badge` before path completion shows a friendly locked card directing the learner back to the catalog.
- **Catalog banner** — `renderCatalog()` shows a celebratory `.path-complete-banner` above the path card when `isPathComplete()` is true, with a "View your certificate" CTA. The banner is the immediate-celebration surface for the badge.
- **Main-column cert card** — `.cert-card` sits directly under the learning-path card in the home main column. Horizontal layout: mini-certificate SVG on the left (with the learner's name and the path title baked in), tag, headline, descriptive copy, progress bar, and CTA on the right. Locked state is desaturated with a padlock; unlocked state turns vivid green and swaps in a "View certificate" CTA. Stacks vertically on mobile.
- **Sidebar Badges-earned overview** — `.side-block.badges-overview` is always visible in the home sidebar. Top counter ("X of Y earned", where Y is `ENGAGEMENT_BADGES.length + 1` capstone) summarises progress; a streak line shows the current run of consecutive learning days. Below that, a single grid of pointy-top hexagonal badges (`buildHexBadgeSVG()`):
  - **Milestones** — 7 engagement badges defined in `ENGAGEMENT_BADGES`: first day at Qargo (sunrise/coral), first lesson (brand green), first module (brand green deep), 3-day streak (bronze), 5-day streak (silver), 10-day streak (gold), and path complete (gold-to-LinkedIn-blue gradient). Each has a unique icon. Earned badges show the full gradient with a coloured drop shadow tinted to the badge; locked badges are greyscaled and 45% opacity.
  - **LinkedIn certificate** — full-width capstone slot at the bottom.

  Module-level achievement is intentionally not shown here — the path card on the left already shows per-module completion state and the duplication felt heavy. The hex builder still supports a label-mode (used internally for the SVG), but no module hexes are rendered in this widget.

## Profile dropdown menu

- The avatar in the header (`#user-menu-btn`) opens a dropdown (`.user-menu`) anchored to the `.me` container. The menu lists: account actions (Switch profile), demo tools, and quick links.
- **Demo tools** are a deliberate convenience for showcasing the academy without grinding through every lesson:
  - **Finish learning path** — `demoFinishPath()` marks every unlocked module's lessons complete, stamps `LS_PATH_COMPLETED`, mints the cert ID, fires every relevant engagement badge.
  - **Set mid-path state** — `demoMidPathState()` completes the first three unlocked modules, logs activity today, and triggers welcome/lesson/module badges. Shows the "in flight" experience.
  - **Earn all badges** — `demoEarnAllBadges()` grants every engagement badge (queued back-to-back so the celebrations play in sequence).
  - **Set 10-day streak** — `demoSet10DayStreak()` synthesises ten consecutive activity dates and awards all three streak badges.
  - **Preview badge celebration** — `demoPreviewBadge()` plays the confetti overlay for a random badge without persisting it. Useful to show the celebration design.
  - **Reset all progress** — `demoResetProgress()` clears every `academy.*` localStorage key (with a confirm prompt). Returns the demo to a clean slate.
- Menu closes on outside click, Escape, or after picking an action. Re-renders the route at the end of mutating actions so the sidebar grids and main column reflect the new state.

## Home page two-pane scroll

- The two-column home layout (`.home-layout`) is locked to viewport height on desktop (`height: calc(100vh - var(--header-h) - 24px)`); each child (`.home-main`, `.home-side`) gets `overflow-y: auto` and `overscroll-behavior: contain` so the two columns scroll independently. Custom subtle scrollbars on webkit.
- The hero and any catalog banner above the layout still scroll out via the page first; once the layout enters the viewport, the columns take over.
- Below 1080px the layout collapses to a single column and reverts to normal page-flow scrolling.

## Engagement and streak tracking

- `LS_BADGES = "academy.badges_earned"` — object keyed by badge id, value is the ISO timestamp of when earned. `grantBadge(id)` is idempotent and triggers `celebrateBadge(def)` on first earn — a fullscreen overlay with the hex badge, "Badge earned" eyebrow, title, and a confetti burst (canvas particles, no library). Multiple simultaneous earns are queued via `_bceQueue` so they don't stack on top of each other; click anywhere, the CTA, Escape, or wait 5s to dismiss.
- `LS_ACTIVITY = "academy.activity_dates"` — array of unique `YYYY-MM-DD` strings. `logActivityToday()` is called from `markLessonDone()`. `getCurrentStreak()` returns the longest run of consecutive days ending today or yesterday (a learner has until the next midnight to extend their streak).
- `checkEngagementBadges(reason)` is the single entry point that awards badges based on the triggering action: `welcome` (profile created → `first-day`), `lesson` (lesson done → activity logged, `first-lesson` + streak badges), `module` (module done → `first-module`), `path` (full path done → `first-path`).

## Login and logout

- **Login gate** — `showIdentityModal()` blocks the app until the learner submits. Only a valid email is required; name, company, and role auto-fill from the address if left blank (name = part before `@`, company = domain capitalised, role = first available non-internal role). All fields remain editable. The save button enables as soon as email is entered and consent is ticked.
- **Internal login** — unchanged: requires `@qargo.com` email + shared password, verified server-side by the Worker before a token is issued.
- **Logout** — `logout()` function iterates all `localStorage` keys starting with `academy.` and removes them, then calls `location.reload()`. This clears the session, all progress, and forces a fresh fetch of the latest deployed code from GitHub Pages. The button lives in the profile dropdown above the Demo tools section.

## D1 progress tracking

The Cloudflare Worker connects to a D1 (SQLite) database (`academy-db`) for server-side progress storage. Schema lives in `schema.sql` — run `wrangler d1 execute academy-db --remote --file=schema.sql` to apply (idempotent).

**Tables**: `learners`, `lesson_progress`, `badges`, `block_progress` (learner_id, lesson_id, block_idx).

**Session token design** — a UUID generated once per email and stored in `learners.session_token`. The same token is returned on every subsequent login for the same email, so the same learner on different devices automatically shares progress. Token is never rotated unless explicitly cleared.

**Worker routes** (all require `Authorization: Bearer <session_token>` except `/learner`):
- `POST /learner` — upsert learner row, return stable session token.
- `POST /progress/lesson` — upsert lesson completion row.
- `POST /progress/badge` — upsert badge row.
- `POST /progress/block` — upsert individual block completion row.
- `GET /progress` — return all lessons, badges, and block completions for the authenticated learner.
- `GET /leaderboard` — return top learners by lessons completed, scoped to the token-holder's email domain (server enforces this; client cannot override it).

**Block resumption** — every time a block fires `markDone`, `syncBlockToD1(lessonId, blockIdx)` writes the completion to D1 (no-op if already recorded). On boot, `loadProgressFromD1()` populates `_d1CompletedBlocks` (a `Map<lessonId, Set<blockIdx>>`). When `renderCourse` renders a lesson, any block whose index is already in `_d1CompletedBlocks` gets `markBlockDone()` called immediately after rendering — so the lesson completion counter is pre-seeded without requiring the learner to redo the interaction. Those blocks receive a `data-resumed` attribute and show a subtle "Completed in a previous session" note via CSS `::after`.

**Rate limiting** — shared `checkRateLimit(request, env, namespace, limit, windowSeconds)` helper uses KV fixed-window counting. Auth endpoint: 5 req/IP/min. AI tutor: 10 req/IP/min.

**Security** — `index.html` carries a `Content-Security-Policy` meta tag restricting scripts, styles, fonts, images, frames, and connections to known origins. Worker validates token ownership before every D1 read/write.

**Boot sequence** — on load, if a learner exists in localStorage but has no session token, `syncLearnerToD1()` runs first, then `loadProgressFromD1()`, then `route()`. If a token already exists, it skips straight to `loadProgressFromD1()`.

## Internal track and password gate

- **Profile**: a fifth role, `internal`, sits in `ROLES` next to the four customer-facing roles. It is `internalOnly: true`, which the identity modal reads to hide the option from the dropdown unless the email field already matches `INTERNAL_EMAIL_DOMAIN` (`qargo.com`). On submit, the modal re-checks the email and refuses to save if the role is internal but the email does not qualify. This is a UX guard, not a security boundary.
- **Authoritative gate**: when a learner picks Internal, the modal shows a password field. On submit it POSTs to `${REPORTING_ENDPOINT}/auth/internal` with `{ password }`. The Worker compares it constant-time against `env.INTERNAL_PASSWORD`, and on match returns `{ token, expiresAt }` where the token is an HMAC-SHA256 signature of `{ scope: "internal", exp }` using `env.INTERNAL_JWT_SECRET`. The browser stores the token in `LS_INTERNAL_TOKEN`. Every Internal content fetch attaches `Authorization: Bearer <token>`. Token TTL is one week (`INTERNAL_TOKEN_TTL_SECONDS` in the Worker).
- **Required Worker secrets**: `INTERNAL_PASSWORD` and `INTERNAL_JWT_SECRET`, both set with `wrangler secret put`. If either is missing the Worker fails closed: `/auth/internal` and `/internal/*` both return 503, leaving the public flow untouched. Rotate `INTERNAL_PASSWORD` to revoke future logins; rotate `INTERNAL_JWT_SECRET` to also instantly invalidate every existing token.
- **Worker routes**:
  - `POST /auth/internal` — verify password, mint signed token.
  - `GET /internal/<kind>/<id>.json` and `GET /internal/manifest.json` — read from KV under the `internal:` key prefix on the existing `VISITS_KV` namespace. Auth required. Returns 401 on missing/bad token, 404 on missing key, 503 if secrets / KV unbound. Path traversal rejected at the regex check.
  - All existing reporting routes (`POST /` for events, `GET /` for the visitor dump) are untouched.
  - CORS now allows `Authorization` so the browser can attach the token cross-origin.
- **Loader behaviour**: `loadContent()` only fetches the Internal manifest when `learner?.role === "internal"`. Internal-content failures (Worker down, token expired, KV miss) are non-fatal — they log a warning, leave `INTERNAL_MODULES` empty, and let the public flow continue. A 401 from any internal fetch clears the stored token so the next profile switch re-prompts. The cache key folds in the internal manifest version so switching roles or shipping new internal content invalidates a stale bundle without bumping the public version.
- **Home page rendering**: when `role === "internal"`, the "Recommended for you" header swaps to "Internal training" and the path-card / cert-card slot is replaced with a single empty-state placeholder card (eyebrow `Internal track`, headline `Content is on the way`, dashed-border `path-empty` block) until `INTERNAL_MODULES` is populated. Specialised and Extra-curricular sections are unchanged.
- **Content storage**: Internal content lives in KV under keys `internal:manifest.json`, `internal:tracks/<id>.json`, `internal:modules/<id>.json`, `internal:lessons/<id>.json`, mirroring the public `content/` tree. Upload via `wrangler kv:key put --binding VISITS_KV "internal:..." '{...}'`. Nothing is committed to git.

## Rules to keep

- **Do not remove interactive blocks or structural aspects of the platform without verifying first.** This includes block renderers, the block dispatcher, progressive reveal, the lesson-transition banner, the collapsible TOC, per-block completion tracking, and the learning path > modules > lessons hierarchy.
- **Copy avoids em dashes and stray emojis** — this was an earlier cleanup pass; keep new copy consistent.
- **No pixel offsets for layout alignment** — prefer grid/flex auto-alignment. If pixel math starts creeping in, restructure the DOM instead.
- **Internal-track secrets never enter the repo**. Set them via `wrangler secret put`, rotate them there. `.gitignore` blocks the usual local-secret filenames as a safety net.

## File layout

```
README.md                              — entry point: what this is and how to run it
index.html                             — shell, CSS, JS, runtime content loader
serve.command                          — local dev server (python3 http.server on :8000)

content/                               — public lesson content, fetched at runtime
  manifest.json                          version + ID lists for paths / tracks / modules / lessons
  paths/<id>.json                        { id, title, description, modules: [moduleId] }
  tracks/<id>.json                       { id, title, description, modules: [moduleId] }
  modules/<id>.json                      { id, code, title, description, roles, locked, lessons: [lessonId] }
  lessons/<id>.json                      { id, title, blocks: [...] }

internal-content/                      — gated Internal track content (gitignored; pushed to KV, not served from repo)
  manifest.json                          same shape as content/manifest.json, scoped to Internal
  tracks/internal.json                   the Internal track definition
  modules/<id>.json                      Internal modules
  lessons/<id>.json                      Internal lessons
  push.sh                                bash script that uploads the tree to Cloudflare KV via wrangler

reporting-worker.js                    — Cloudflare Worker: event reporting + Internal auth + gated Internal content + D1 progress
wrangler.toml                          — Worker config + KV namespace binding + D1 binding + documented secrets
schema.sql                             — D1 schema (learners, lesson_progress, badges); apply with wrangler d1 execute --remote
sync-visitors.js                       — pulls reporting events from the Worker into visitors.json
visitors.json                          — generated visitor / event dump (gitignored, local-only)
SECURITY_AUDIT.md                      — local-only security audit report (gitignored)

skills/academy-builder/SKILL.md        — local authoring skill used to draft new lessons (gitignored)

CONTEXT.md                             — this file: platform architecture
LOADER.md                              — how the runtime content loader fetches and assembles the tree
```
