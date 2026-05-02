/* =========================================================================
   REPORTING CONFIG
   Paste your Cloudflare Worker URL here once deployed (see reporting-worker.js).
   Leave empty while developing locally — completions still track in localStorage
   but nothing is sent to Notion.

   AUDIT-GRADE CAVEAT (TODO, not built yet):
   Logging is currently client-reported. A learner with DevTools could fire
   fake session_start / lesson_completed / module_completed / path_completed
   events, or skip lessons and still appear complete. Fine for an internal
   engagement view, NOT proof of completion.

   Path to audit-grade later:
     1. Move identity behind SSO (e.g. Cloudflare Access) so name/email/role
        come from a verified header, not the in-page identity prompt.
     2. Have the Worker mint a signed, short-lived session token at login and
        require it on every event.
     3. Move completion logic server-side: the Worker decides what counts as
        done based on submitted answers, not a client "done" flag.
     4. Persist raw events (append-only) alongside the upserted learner row
        so any tampering is auditable.
     5. Tie certificate IDs to a server record and verify via a public
        /verify/<certId> URL (the existing reporting-worker.js plan covers this).
   The same caveat is also pinned on the Notion "Qargo University - Project
   Management Dashboard" page above the Learners Logs database.
   ========================================================================= */
const REPORTING_ENDPOINT = "https://academy-reporter.alvaro-avelar.workers.dev";

/* =========================================================================
   ROLES
   From the Qargo Learning Architecture. Only Super Admin is selectable
   while we build out content for the other personas. The remaining three
   appear in the dropdown with a "Coming soon" hint so users can see the
   direction without being able to pick them yet.
   ========================================================================= */
/* The "internal" role is restricted: it should only be selectable by Qargo
   staff. The dropdown hides it unless the email field contains a Qargo
   domain. The authoritative check is server-side: picking Internal asks
   for a shared password, the Worker verifies it and returns a signed
   token, and every Internal content fetch has to present that token.
   If a learner forces the role locally without the password, the Worker
   refuses to serve Internal modules. */
const INTERNAL_EMAIL_DOMAIN = "qargo.com";
const INTERNAL_AUTH_URL = `${REPORTING_ENDPOINT}/auth/internal`;
const LS_INTERNAL_TOKEN = "academy.internal_token";
const ROLES = [
  { id: "super_admin",   label: "Super Admin",
    blurb: "Full-stack operator. Needs the complete end-to-end journey across every Qargo module.",
    available: true },
  { id: "planner",       label: "Planner",
    blurb: "Daily dispatch. Planning board, stops and trips.",
    available: false },
  { id: "invoicer",      label: "Invoicer",
    blurb: "Invoicing, credit notes and rate card logic.",
    available: false },
  { id: "customer_svc",  label: "Customer Services",
    blurb: "Order entry, customer communications and day-to-day support.",
    available: false },
  { id: "internal",      label: "Internal",
    blurb: "Qargo staff only. Unlocks Internal modules served from behind Cloudflare Access.",
    available: true, internalOnly: true },
];

/* True when the email looks like it belongs to Qargo. Used to soft-gate the
   Internal role in the identity modal. The authoritative check sits in the
   Worker / Cloudflare Access. */
function isInternalEmail(email) {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return email.slice(at + 1).trim().toLowerCase() === INTERNAL_EMAIL_DOMAIN;
}

/* =========================================================================
   LEARNING PATH, MODULES AND EXTRAS
   Content is loaded at runtime from the /content tree. See LOADER.md for
   the file shapes and the manifest versioning contract. The values below
   are filled in by loadContent() before the router boots; everything
   downstream reads these bindings as if the data were inline.
   Source: https://www.notion.so/qargo/336e32e8f8c88041b155de9243e48980
   ========================================================================= */
let MODULES = [];
let LEARNING_PATH = { id: "", title: "", description: "", modules: MODULES };
let SPECIALISED_MODULES = [];
let EXTRA_CURRICULAR = [];
let INTERNAL_MODULES = [];
let INTERNAL_TRACK = null;
let COURSES = MODULES;

const CONTENT_BASE = "content";
/* Internal content is served by the same Worker that handles reporting,
   under /internal/<kind>/<id>.json. Override with window.QARGO_INTERNAL_BASE
   at deploy time if you ever split it onto a different origin. */
const INTERNAL_BASE = (typeof window !== "undefined" && window.QARGO_INTERNAL_BASE) || `${REPORTING_ENDPOINT}/internal`;
const LS_CONTENT_CACHE = "academy.content_cache";

/* Internal-token helpers. The token is a Worker-issued, HMAC-signed string
   proving the bearer authenticated with the shared password. We treat any
   401 from the Worker as "token bad / expired", clear it, and let the next
   profile switch re-prompt for the password. */
function getInternalToken() {
  try { return localStorage.getItem(LS_INTERNAL_TOKEN) || null; }
  catch { return null; }
}
function setInternalToken(token) {
  try { localStorage.setItem(LS_INTERNAL_TOKEN, token); } catch (e) {}
}
function clearInternalToken() {
  try { localStorage.removeItem(LS_INTERNAL_TOKEN); } catch (e) {}
}
/* Single place to authenticate against the Worker. Returns the token on
   success, throws Error("invalid password") on a 401, throws other errors
   for network / server failures so the caller can distinguish "bad pw"
   (show inline error) from "Worker is down" (toast and bail). */
async function requestInternalToken(password) {
  const res = await fetch(INTERNAL_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) throw new Error("invalid password");
  if (!res.ok) throw new Error(`auth failed (${res.status})`);
  const data = await res.json();
  if (!data?.token) throw new Error("auth response missing token");
  return data.token;
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("Failed to fetch " + url + " (" + res.status + ")");
  return res.json();
}

function readContentCache(version) {
  try {
    const raw = localStorage.getItem(LS_CONTENT_CACHE);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || cached.version !== version) return null;
    return cached.bundle || null;
  } catch { return null; }
}
function writeContentCache(version, bundle) {
  try {
    localStorage.setItem(LS_CONTENT_CACHE, JSON.stringify({ version, bundle }));
  } catch (e) { /* quota or disabled — non-fatal */ }
}

/* Public-content fetches must succeed; an outage here is a real bug.
   Internal-content fetches must NOT be allowed to break the public app:
   the worker may be unreachable, the token may have expired, the route
   may not exist yet, etc. Swallow per-file failures and log a warning.
   A 401 anywhere in the internal flow is treated as "token expired",
   clears the token, and the user gets re-prompted next profile switch. */
async function fetchInternalJSON(url) {
  const token = getInternalToken();
  const res = await fetch(url, {
    cache: "no-cache",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    clearInternalToken();
    throw new Error("internal token expired");
  }
  if (!res.ok) throw new Error("Failed to fetch " + url + " (" + res.status + ")");
  return res.json();
}

async function fetchInternalKind(kind, ids) {
  const results = await Promise.all((ids || []).map(async id => {
    try { return await fetchInternalJSON(`${INTERNAL_BASE}/${kind}/${id}.json`); }
    catch (e) {
      console.warn(`[content] failed to fetch internal ${kind}/${id}:`, e.message);
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function fetchInternalManifest() {
  try {
    return await fetchInternalJSON(`${INTERNAL_BASE}/manifest.json`);
  } catch (e) {
    console.warn("[content] internal manifest unavailable, public content only:", e.message);
    return null;
  }
}

async function fetchBundle(manifest, internalManifest) {
  const fetchKind = async (kind) => {
    const pub = await Promise.all(
      (manifest[kind] || []).map(id => fetchJSON(`${CONTENT_BASE}/${kind}/${id}.json`))
    );
    const int = internalManifest
      ? await fetchInternalKind(kind, internalManifest[kind])
      : [];
    return [...pub, ...int];
  };
  const [paths, tracks, modules, lessons] = await Promise.all([
    fetchKind("paths"),
    fetchKind("tracks"),
    fetchKind("modules"),
    fetchKind("lessons"),
  ]);
  return { paths, tracks, modules, lessons };
}

function assembleContent(bundle) {
  const lessonById = Object.fromEntries(bundle.lessons.map(l => [l.id, l]));
  const moduleById = Object.fromEntries(bundle.modules.map(m => {
    // Resolve lesson ID references into full lesson objects. Modules with
    // no lesson IDs (locked stubs) keep an empty array.
    const resolved = (m.lessons || []).map(id => {
      const lesson = lessonById[id];
      if (!lesson) console.warn("[content] lesson not found:", id);
      return lesson;
    }).filter(Boolean);
    return [m.id, { ...m, lessons: resolved }];
  }));

  // Path: take the first one. The platform currently boots a single path.
  const pathFile = bundle.paths[0];
  const orderedModules = (pathFile.modules || []).map(id => {
    const mod = moduleById[id];
    if (!mod) console.warn("[content] module not found in path:", id);
    return mod;
  }).filter(Boolean);

  // Tracks: resolve module IDs into module objects. For locked tracks
  // (specialised, extra-curricular) only id/title/description are read by
  // renderLocked. For the internal track the full module (including
  // resolved lessons) is needed so the course route can render it.
  const trackById = Object.fromEntries(bundle.tracks.map(t => [t.id, t]));
  const resolveTrack = (trackId, { full = false } = {}) => {
    const t = trackById[trackId];
    if (!t) return [];
    return (t.modules || []).map(id => {
      const mod = moduleById[id];
      if (!mod) { console.warn("[content] module not found in track:", id); return null; }
      return full ? mod : { id: mod.id, title: mod.title, description: mod.description };
    }).filter(Boolean);
  };

  // Internal track meta is exposed separately so the home page can frame
  // the Internal section as a path-style card with title/description.
  const internalTrackFile = trackById["internal"] || null;
  const internalTrack = internalTrackFile ? {
    id: internalTrackFile.id,
    title: internalTrackFile.title,
    description: internalTrackFile.description,
  } : null;

  return {
    modules: orderedModules,
    learningPath: {
      id: pathFile.id,
      title: pathFile.title,
      description: pathFile.description,
      modules: orderedModules,
    },
    specialised: resolveTrack("specialised"),
    extraCurricular: resolveTrack("extra-curricular"),
    internal: resolveTrack("internal", { full: true }),
    internalTrack,
  };
}

async function loadContent() {
  const manifest = await fetchJSON(`${CONTENT_BASE}/manifest.json`);
  /* Internal content is only attempted for learners who have selected
     the Internal role. This keeps the public flow on a single fetch
     path and prevents externals from generating spurious 401s against
     the Worker. The Worker / Cloudflare Access still has the final
     say if anyone forces the role locally. */
  const learner = getLearner();
  const wantsInternal = learner?.role === "internal";
  const internalManifest = wantsInternal ? await fetchInternalManifest() : null;

  /* Cache key folds in the internal manifest version (if any) so that
     toggling roles or shipping new internal content invalidates a stale
     bundle without having to bump the public version. */
  const cacheKey = internalManifest
    ? `${manifest.version}+int:${internalManifest.version || "0"}`
    : manifest.version;

  let bundle = readContentCache(cacheKey);
  if (!bundle) {
    bundle = await fetchBundle(manifest, internalManifest);
    writeContentCache(cacheKey, bundle);
  }
  const built = assembleContent(bundle);
  // Mutate in place where possible so any closures that captured the
  // original array references stay live.
  MODULES.length = 0;
  built.modules.forEach(m => MODULES.push(m));
  Object.assign(LEARNING_PATH, built.learningPath);
  LEARNING_PATH.modules = MODULES;
  SPECIALISED_MODULES.length = 0;
  built.specialised.forEach(t => SPECIALISED_MODULES.push(t));
  EXTRA_CURRICULAR.length = 0;
  built.extraCurricular.forEach(t => EXTRA_CURRICULAR.push(t));
  INTERNAL_MODULES.length = 0;
  built.internal.forEach(t => INTERNAL_MODULES.push(t));
  INTERNAL_TRACK = built.internalTrack || null;
  // COURSES is the lookup the course route uses. It unions the public path
  // modules with any internal modules so /#course/<id> resolves either.
  // Specialised and extra-curricular are intentionally excluded (locked).
  COURSES = [...MODULES, ...INTERNAL_MODULES];
}


/* =========================================================================
   LEARNER IDENTITY + REPORTING
   No login — we ask for name/email/company once and stash in localStorage.
   A course is reported to Notion exactly once per browser (guarded by the
   "academy.completed" key) when progress hits 100%.
   ========================================================================= */
const LS_LEARNER   = "academy.learner";
const LS_COMPLETED = "academy.completed";
const LS_PROGRESS  = "academy.progress"; // { [moduleId]: { lastLessonIdx, completedLessons: [lessonId...] } }

/* Return a module's lessons. If a module still uses the flat `blocks` shape
   (legacy or placeholder), wrap each block as its own one-block lesson. */
function lessonsOf(m) {
  if (Array.isArray(m.lessons) && m.lessons.length) return m.lessons;
  if (Array.isArray(m.blocks) && m.blocks.length) {
    return m.blocks.map((b, i) => ({
      id: `${m.id}-legacy-${i}`,
      title: b.title || `Lesson ${i + 1}`,
      blocks: [b],
    }));
  }
  return [];
}
function moduleLessonCount(m) { return lessonsOf(m).length; }
function moduleBlockCount(m)  { return lessonsOf(m).reduce((n, l) => n + (l.blocks?.length || 0), 0); }

function getProgressAll() {
  try { return JSON.parse(localStorage.getItem(LS_PROGRESS) || "{}"); }
  catch { return {}; }
}
function getModuleProgress(moduleId) {
  const all = getProgressAll();
  return all[moduleId] || { lastLessonId: null, completedLessons: [] };
}
function setModuleProgress(moduleId, progress) {
  const all = getProgressAll();
  all[moduleId] = progress;
  localStorage.setItem(LS_PROGRESS, JSON.stringify(all));
}
function markLessonDone(moduleId, lessonId) {
  const p = getModuleProgress(moduleId);
  if (!p.completedLessons.includes(lessonId)) p.completedLessons.push(lessonId);
  p.lastLessonId = lessonId;
  setModuleProgress(moduleId, p);
  // Record activity and award lesson-related engagement badges.
  checkEngagementBadges("lesson");
}
/* Path-level progress: % of unlocked-module lessons the learner has finished. */
function getPathProgress() {
  const unlocked = MODULES.filter(m => !m.locked && moduleLessonCount(m) > 0);
  if (!unlocked.length) return { pct: 0, started: false, completedModules: 0, totalModules: MODULES.length };
  let totalLessons = 0, doneLessons = 0, startedAny = false, completedModules = 0;
  for (const m of unlocked) {
    const lessons = moduleLessonCount(m);
    const p = getModuleProgress(m.id);
    totalLessons += lessons;
    doneLessons += p.completedLessons.length;
    if (p.completedLessons.length > 0) startedAny = true;
    if (p.completedLessons.length >= lessons) completedModules++;
  }
  const pct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;
  return { pct, started: startedAny, completedModules, totalModules: MODULES.length };
}

function getLearner() {
  try { return JSON.parse(localStorage.getItem(LS_LEARNER) || "null"); }
  catch { return null; }
}
function setLearner(l) {
  localStorage.setItem(LS_LEARNER, JSON.stringify(l));
  renderMe();
  // Welcome — first-day badge fires the moment a profile exists.
  checkEngagementBadges("welcome");
}
function switchProfile() {
  // Keep the existing learner pre-filled and let them change any field.
  // After save, reload content so that picking / leaving the Internal role
  // pulls in (or drops) Internal modules. loadContent() is fail-safe for
  // internal fetches, so a network blip here cannot brick the catalog.
  showIdentityModal(async () => {
    try { await loadContent(); }
    catch (e) { console.warn("[content] reload after profile switch failed:", e.message); }
    route();
  });
}
function roleLabel(id) {
  const r = ROLES.find(r => r.id === id);
  return r ? r.label : id;
}
function getCompleted() {
  try { return JSON.parse(localStorage.getItem(LS_COMPLETED) || "{}"); }
  catch { return {}; }
}
function markCompleted(courseId) {
  const all = getCompleted();
  if (all[courseId]) return false;
  all[courseId] = new Date().toISOString();
  localStorage.setItem(LS_COMPLETED, JSON.stringify(all));
  return true;
}

/* ---------- Learning-path completion + LinkedIn-shareable certificate ---------- */
const LS_PATH_COMPLETED = "academy.path_completed_at";
const LS_CERT_ID        = "academy.cert_id";

function isPathComplete() {
  const unlocked = MODULES.filter(m => !m.locked && moduleLessonCount(m) > 0);
  if (!unlocked.length) return false;
  const done = getCompleted();
  return unlocked.every(m => !!done[m.id]);
}

function getPathCompletedAt() {
  return localStorage.getItem(LS_PATH_COMPLETED) || "";
}

function setPathCompletedAtIfMissing() {
  // Returns true if this call was the first to stamp the completion date
  // (i.e. the path just transitioned to complete). Used by reportCompletion
  // to fire the path_completed event exactly once.
  if (!localStorage.getItem(LS_PATH_COMPLETED)) {
    localStorage.setItem(LS_PATH_COMPLETED, new Date().toISOString());
    return true;
  }
  return false;
}

/* ---------- Engagement badges + streak tracking ---------- */
const LS_BADGES   = "academy.badges_earned";
const LS_ACTIVITY = "academy.activity_dates";

/* Definitions for the seven engagement milestone badges. The colour pair
   defines the gradient fill on the hexagon; iconPath is a single SVG path
   drawn in white over the gradient. */
const ENGAGEMENT_BADGES = [
  {
    id: "first-day", title: "First day at Qargo",
    desc: "Welcome aboard. You signed up for the academy.",
    c1: "#FFB347", c2: "#FF7F50",
    icon: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>'
  },
  {
    id: "first-lesson", title: "First lesson",
    desc: "You finished your first lesson.",
    c1: "#00E85B", c2: "#00C44C",
    icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'
  },
  {
    id: "first-module", title: "First module",
    desc: "You wrapped up an entire module.",
    c1: "#00E85B", c2: "#008F39",
    icon: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'
  },
  {
    id: "streak-3", title: "3-day streak",
    desc: "Three days in a row. The habit is starting.",
    c1: "#D38A52", c2: "#8B4513",
    icon: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'
  },
  {
    id: "streak-5", title: "5-day streak",
    desc: "Five days running. Habit forming.",
    c1: "#E8E8E8", c2: "#8E8E8E",
    icon: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'
  },
  {
    id: "streak-10", title: "10-day streak",
    desc: "Ten days. You are on fire.",
    c1: "#FFD700", c2: "#DAA520",
    icon: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'
  },
  {
    id: "first-path", title: "Path complete",
    desc: "You finished a full learning path.",
    // Ice-blue tones power the locked-state filter and the celebration glow.
    c1: "#E8F0FF", c2: "#7AA0D0",
    iconColor: "#1F3A5F",
    style: "diamond",
    icon: '<path d="M22 10v6"/><path d="M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5"/>'
  },
];

function getEarnedBadges() {
  try { return JSON.parse(localStorage.getItem(LS_BADGES) || "{}"); }
  catch { return {}; }
}
function hasBadge(id) { return !!getEarnedBadges()[id]; }
function grantBadge(id) {
  const earned = getEarnedBadges();
  if (earned[id]) return false;
  earned[id] = new Date().toISOString();
  localStorage.setItem(LS_BADGES, JSON.stringify(earned));
  const def = ENGAGEMENT_BADGES.find(b => b.id === id);
  if (def) queueBadgeCelebration(def);
  return true;
}

/* Badge celebration overlay — shown on first earn. Confetti burst + scale-pop
   card. Queued so multiple simultaneous earns don't stack on top of each other.
   Click anywhere or the CTA to dismiss; auto-dismisses after 5 seconds. */
const _bceQueue = [];
let _bceShowing = false;
function queueBadgeCelebration(def) {
  _bceQueue.push(def);
  if (!_bceShowing) showNextBadgeCelebration();
}
function showNextBadgeCelebration() {
  if (!_bceQueue.length) { _bceShowing = false; return; }
  _bceShowing = true;
  const def = _bceQueue.shift();
  celebrateBadge(def, () => {
    _bceShowing = false;
    // Slight delay between celebrations so they don't feel jammed.
    setTimeout(showNextBadgeCelebration, 200);
  });
}
function celebrateBadge(def, onClosed) {
  const overlay = document.createElement("div");
  overlay.className = "badge-celebration";
  overlay.style.setProperty("--bce-glow", `${def.c2}66`);
  overlay.innerHTML = `
    <canvas class="bce-confetti" aria-hidden="true"></canvas>
    <div class="bce-card" role="alertdialog" aria-live="assertive">
      <div class="bce-eyebrow">Badge earned</div>
      <div class="bce-hex">${buildHexBadgeSVG(def)}</div>
      <h3 class="bce-title">${escape(def.title)}</h3>
      <p class="bce-desc">${escape(def.desc)}</p>
      <button type="button" class="bce-cta">Nice</button>
    </div>
  `;
  document.body.appendChild(overlay);

  // Confetti — full-viewport canvas, particles burst from the centre.
  const canvas = overlay.querySelector(".bce-confetti");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function fitCanvas() {
    canvas.width  = window.innerWidth  * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width  = window.innerWidth  + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();
  window.addEventListener("resize", fitCanvas);

  const palette = ["#00E85B", "#00C44C", "#FFD700", "#FF7F50", "#FFB347", "#FFFFFF", "#0A66C2", def.c1, def.c2];
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2 - 20;
  const particles = Array.from({ length: 160 }, () => ({
    x: cx + (Math.random() - 0.5) * 120,
    y: cy + (Math.random() - 0.5) * 40,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 16 - 4,
    g: 0.32 + Math.random() * 0.16,
    size: 5 + Math.random() * 7,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.45,
    color: palette[Math.floor(Math.random() * palette.length)],
    life: 0,
  }));
  let frames = 0;
  let rafId = 0;
  function tick() {
    frames++;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    let alive = 0;
    particles.forEach(p => {
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life++;
      if (p.y < window.innerHeight + 40 && p.life < 260) alive++;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.55);
      ctx.restore();
    });
    if (alive > 0 && frames < 320) rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", fitCanvas);
    overlay.classList.add("dismissing");
    setTimeout(() => {
      overlay.remove();
      if (typeof onClosed === "function") onClosed();
    }, 260);
  }
  overlay.querySelector(".bce-cta").addEventListener("click", e => { e.stopPropagation(); dismiss(); });
  overlay.addEventListener("click", dismiss);
  document.addEventListener("keydown", function escDismiss(e) {
    if (e.key === "Escape") {
      dismiss();
      document.removeEventListener("keydown", escDismiss);
    }
  });
  setTimeout(dismiss, 5000);
}

/* Activity-date tracking — drives streak badges. We only store unique
   YYYY-MM-DD strings; a streak is the longest run of consecutive days
   ending today (or yesterday — a learner has until tomorrow's midnight
   to extend their streak). */
function todayStamp() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function getActivityDates() {
  try { return JSON.parse(localStorage.getItem(LS_ACTIVITY) || "[]"); }
  catch { return []; }
}
function logActivityToday() {
  const dates = getActivityDates();
  const t = todayStamp();
  if (!dates.includes(t)) {
    dates.push(t);
    localStorage.setItem(LS_ACTIVITY, JSON.stringify(dates));
  }
}
function getCurrentStreak() {
  const dates = [...new Set(getActivityDates())].sort().reverse();
  if (!dates.length) return 0;
  const today = todayStamp();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = y.getFullYear() + "-" + String(y.getMonth()+1).padStart(2,"0") + "-" + String(y.getDate()).padStart(2,"0");
  if (dates[0] !== today && dates[0] !== yesterday) return 0;
  let streak = 1;
  let cur = new Date(dates[0] + "T00:00:00");
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i] + "T00:00:00");
    const diffDays = Math.round((cur - prev) / 86400000);
    if (diffDays === 1) { streak++; cur = prev; }
    else if (diffDays === 0) { /* dupe — skip */ }
    else break;
  }
  return streak;
}

/* Award all badges the learner has just qualified for. Called from the
   places that move state forward — profile creation, lesson done,
   module done, path done. Idempotent — already-earned badges are no-ops. */
function checkEngagementBadges(reason) {
  if (!getLearner()) return;
  grantBadge("first-day");
  if (reason === "lesson") {
    logActivityToday();
    grantBadge("first-lesson");
    const s = getCurrentStreak();
    if (s >= 3)  grantBadge("streak-3");
    if (s >= 5)  grantBadge("streak-5");
    if (s >= 10) grantBadge("streak-10");
  }
  if (reason === "module") {
    grantBadge("first-module");
  }
  if (reason === "path") {
    grantBadge("first-path");
  }
}

/* Stable cert ID per learner+path. Same learner gets the same ID across refreshes. */
function getCertId() {
  let id = localStorage.getItem(LS_CERT_ID);
  if (id) return id;
  const learner = getLearner() || {};
  const seed = (learner.email || learner.name || "anon") + "|" + (LEARNING_PATH.title || "path");
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  const block = h.toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
  const completedAt = getPathCompletedAt();
  const year = (completedAt ? new Date(completedAt) : new Date()).getFullYear();
  id = `QA-${year}-${block}`;
  localStorage.setItem(LS_CERT_ID, id);
  return id;
}

function renderMe() {
  const me = document.getElementById("me");
  const l = getLearner();
  if (!l) { me.innerHTML = ""; return; }
  const initials = l.name.split(/\s+/).filter(Boolean).slice(0,2).map(p => p[0].toUpperCase()).join("");
  const pathDone = isPathComplete();
  me.innerHTML = `
    <div class="who">
      <span class="name">${escape(l.name)}</span>
      <span class="role">${escape(roleLabel(l.role))}</span>
    </div>
    <button class="avatar" id="user-menu-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Open menu">${escape(initials || "·")}</button>
    <div class="user-menu" id="user-menu" role="menu" hidden>
      <div class="menu-header">
        <span class="name">${escape(l.name)}</span>
        ${l.email ? `<span class="email">${escape(l.email)}</span>` : ""}
      </div>

      <div class="menu-section">
        <button type="button" class="menu-item" data-act="switch-profile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          Switch profile
        </button>
      </div>

      <div class="menu-section">
        <div class="menu-label">Demo tools</div>
        <button type="button" class="menu-item" data-act="finish-path">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 5c0-1.66 4-3 9-3s9 1.34 9 3"/></svg>
          Finish learning path
        </button>
        <button type="button" class="menu-item" data-act="generate-cert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/><path d="M8 13.5h8"/></svg>
          Generate certificate
        </button>
        <button type="button" class="menu-item" data-act="mid-path">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>
          Set mid-path state
        </button>
        <button type="button" class="menu-item" data-act="earn-all-badges">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>
          Earn all badges
        </button>
        <button type="button" class="menu-item" data-act="set-streak">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
          Set 10-day streak
        </button>
        <button type="button" class="menu-item" data-act="preview-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>
          Preview badge celebration
        </button>
        <button type="button" class="menu-item danger" data-act="reset">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/></svg>
          Reset all progress
        </button>
      </div>

      <div class="menu-section">
        <div class="menu-label">Quick links</div>
        ${pathDone ? `
          <a class="menu-item" href="#/badge" data-act="close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            View certificate
          </a>` : ""}
        <a class="menu-item" href="#/blocks" data-act="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          Open block library
        </a>
        <a class="menu-item" href="${escape(PRIVACY_NOTICE_URL)}" target="_blank" rel="noopener" data-act="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
          Privacy notice
        </a>
      </div>
    </div>
  `;

  const btn  = document.getElementById("user-menu-btn");
  const menu = document.getElementById("user-menu");
  if (!btn || !menu) return;

  function openMenu() {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    setTimeout(() => document.addEventListener("click", outsideListener), 0);
    document.addEventListener("keydown", escListener);
  }
  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outsideListener);
    document.removeEventListener("keydown", escListener);
  }
  function outsideListener(e) {
    if (!menu.contains(e.target) && e.target !== btn) closeMenu();
  }
  function escListener(e) { if (e.key === "Escape") closeMenu(); }

  btn.addEventListener("click", e => {
    e.stopPropagation();
    menu.hidden ? openMenu() : closeMenu();
  });

  menu.querySelectorAll("[data-act]").forEach(item => {
    item.addEventListener("click", e => {
      const act = item.dataset.act;
      // Anchor links keep their navigation but still close the menu.
      if (act === "close") { closeMenu(); return; }
      e.preventDefault();
      closeMenu();
      handleDemoAction(act);
    });
  });
}

/* Demo actions — invoked from the profile dropdown. All operate on the
   localStorage keys documented in the storage layer; nothing is sent to a
   server. After mutating state we either call route() to re-render the
   current view or rely on the next render to pick up changes. */
function handleDemoAction(act) {
  switch (act) {
    case "switch-profile":     switchProfile(); break;
    case "reset":              demoResetProgress(); break;
    case "earn-all-badges":    demoEarnAllBadges(); break;
    case "finish-path":        demoFinishPath(); break;
    case "generate-cert":      demoGenerateCert(); break;
    case "set-streak":         demoSet10DayStreak(); break;
    case "mid-path":           demoMidPathState(); break;
    case "preview-badge":      demoPreviewBadge(); break;
  }
}

function demoResetProgress() {
  if (!confirm("This clears all academy progress on this browser: completions, badges, streaks, certificate, and saved API key. Continue?")) return;
  [LS_COMPLETED, LS_PROGRESS, LS_BADGES, LS_ACTIVITY, LS_PATH_COMPLETED, LS_CERT_ID, LS_TUTOR_KEY].forEach(k => localStorage.removeItem(k));
  toast("Progress reset");
  route();
}

function demoEarnAllBadges() {
  // Granting a badge auto-queues the celebration; the queue plays them
  // back-to-back. Re-render the sidebar after the last one so the grid
  // reflects the new state.
  ENGAGEMENT_BADGES.forEach(b => grantBadge(b.id));
  setTimeout(route, 600);
}

function demoFinishPath() {
  // Mark every unlocked module's lessons as completed.
  const all = getCompleted();
  MODULES.forEach(m => {
    if (m.locked) return;
    const lessons = lessonsOf(m);
    if (!lessons.length) return;
    const progress = {
      lastLessonId: lessons[lessons.length - 1].id,
      completedLessons: lessons.map(l => l.id),
    };
    setModuleProgress(m.id, progress);
    all[m.id] = new Date().toISOString();
  });
  localStorage.setItem(LS_COMPLETED, JSON.stringify(all));
  setPathCompletedAtIfMissing();
  getCertId();
  logActivityToday();
  checkEngagementBadges("welcome");
  checkEngagementBadges("lesson");
  checkEngagementBadges("module");
  checkEngagementBadges("path");
  setTimeout(route, 200);
}

function demoMidPathState() {
  // Complete the first three unlocked modules — handy "in flight" demo state.
  const all = getCompleted();
  const unlocked = MODULES.filter(m => !m.locked);
  unlocked.slice(0, 3).forEach(m => {
    const lessons = lessonsOf(m);
    if (!lessons.length) return;
    const progress = {
      lastLessonId: lessons[lessons.length - 1].id,
      completedLessons: lessons.map(l => l.id),
    };
    setModuleProgress(m.id, progress);
    all[m.id] = new Date().toISOString();
  });
  localStorage.setItem(LS_COMPLETED, JSON.stringify(all));
  logActivityToday();
  checkEngagementBadges("welcome");
  checkEngagementBadges("lesson");
  checkEngagementBadges("module");
  toast("Mid-path state set");
  setTimeout(route, 200);
}

function demoSet10DayStreak() {
  // Synthesise ten consecutive activity dates ending today.
  const dates = [];
  const t = new Date();
  for (let i = 0; i < 10; i++) {
    const d = new Date(t);
    d.setDate(t.getDate() - i);
    dates.push(d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"));
  }
  localStorage.setItem(LS_ACTIVITY, JSON.stringify(dates));
  grantBadge("streak-3");
  grantBadge("streak-5");
  grantBadge("streak-10");
  setTimeout(route, 200);
}

function demoPreviewBadge() {
  // Show a celebration without granting — useful for showing the design
  // without permanently unlocking anything.
  const def = ENGAGEMENT_BADGES[Math.floor(Math.random() * ENGAGEMENT_BADGES.length)];
  queueBadgeCelebration(def);
}

function demoGenerateCert() {
  // Same state mutations as demoFinishPath but routes straight to the
  // certificate page so the demo can show the cert in one click.
  const all = getCompleted();
  MODULES.forEach(m => {
    if (m.locked) return;
    const lessons = lessonsOf(m);
    if (!lessons.length) return;
    setModuleProgress(m.id, {
      lastLessonId: lessons[lessons.length - 1].id,
      completedLessons: lessons.map(l => l.id),
    });
    all[m.id] = new Date().toISOString();
  });
  localStorage.setItem(LS_COMPLETED, JSON.stringify(all));
  setPathCompletedAtIfMissing();
  getCertId();
  logActivityToday();
  checkEngagementBadges("welcome");
  checkEngagementBadges("lesson");
  checkEngagementBadges("module");
  checkEngagementBadges("path");
  location.hash = "#/badge";
}

function showIdentityModal(onDone) {
  if (document.getElementById("id-modal")) return;
  const existing = getLearner() || {};
  const isEdit = !!existing.name;
  /* Build the role <option> list. Internal-only roles are filtered out
     unless the current email value already qualifies. The list is rebuilt
     on email input so the option appears the moment the learner types a
     Qargo address. */
  const buildRoleOptions = (currentEmail, currentRole) => ROLES.filter(r => {
    if (!r.internalOnly) return true;
    return isInternalEmail(currentEmail);
  }).map(r => {
    const label = r.available ? r.label : `${r.label} (coming soon)`;
    const disabledAttr = r.available ? "" : "disabled";
    const selectedAttr = currentRole === r.id && r.available ? "selected" : "";
    return `<option value="${r.id}" ${selectedAttr} ${disabledAttr}>${escape(label)}</option>`;
  }).join("");
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id = "id-modal";
  back.innerHTML = `
    <div class="modal">
      <div class="mark-lg"><img src="https://app.qargo.com/assets/Qargo_Icon.png" alt="Qargo" /></div>
      <h2>${isEdit ? "Switch profile" : "Welcome to Qargo Academy"}</h2>
      <p class="lead">Tell us who you are so we can record your progress and show the right content for your role.</p>
      <label for="id-name">Full name</label>
      <input id="id-name" autocomplete="name" value="${escape(existing.name || "")}" />
      <label for="id-email">Work email</label>
      <input id="id-email" type="email" autocomplete="email" value="${escape(existing.email || "")}" />
      <label for="id-company">Company</label>
      <input id="id-company" autocomplete="organization" value="${escape(existing.company || "")}" />
      <label for="id-role">Your role</label>
      <select id="id-role">
        <option value="" ${!existing.role ? "selected" : ""} disabled>Pick the role closest to what you do</option>
        ${buildRoleOptions(existing.email || "", existing.role)}
      </select>
      <div class="role-hint" id="id-role-hint"></div>
      <div id="id-internal-row" hidden>
        <label for="id-internal-pw">Internal access password</label>
        <input id="id-internal-pw" type="password" autocomplete="off"
          placeholder="Shared with Qargo staff" />
        <div class="role-hint">Required to unlock Internal modules. Ask your manager if you do not have it.</div>
      </div>
      <div class="consent-row">
        <label class="consent-label">
          <input id="id-consent" type="checkbox" />
          <span>I understand that the Academy will store my name, email, company, role, and learning activity to track progress and issue my certificate, processed under <a href="${escape(PRIVACY_NOTICE_URL)}" target="_blank" rel="noopener">Qargo's privacy notice</a>.</span>
        </label>
      </div>
      <div class="error" id="id-error"></div>
      <div class="actions">
        <button class="primary" id="id-save" disabled>${isEdit ? "Save" : "Start learning"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(back);
  const nameEl = document.getElementById("id-name");
  const emailEl = document.getElementById("id-email");
  const roleEl = document.getElementById("id-role");
  const hintEl = document.getElementById("id-role-hint");
  const saveBtn = document.getElementById("id-save");
  const internalRow = document.getElementById("id-internal-row");
  const internalPwEl = document.getElementById("id-internal-pw");
  const updateHint = () => {
    const r = ROLES.find(r => r.id === roleEl.value);
    hintEl.textContent = r ? r.blurb : "";
    // Show the password field only when Internal is the active selection.
    // Hide and clear it otherwise so we never accidentally submit a stale
    // password the user typed before changing their mind.
    const showInternal = !!r?.internalOnly;
    internalRow.hidden = !showInternal;
    if (!showInternal) internalPwEl.value = "";
  };
  /* Rebuild role options whenever the email changes so internal-only
     options can appear / disappear without losing the current selection
     (when it is still valid). */
  const refreshRoleOptions = () => {
    const prev = roleEl.value;
    const placeholder = `<option value="" disabled ${!prev ? "selected" : ""}>Pick the role closest to what you do</option>`;
    roleEl.innerHTML = placeholder + buildRoleOptions(emailEl.value.trim(), prev);
    // If the previous selection is no longer offered (e.g. internal role
    // dropped because the email was changed to a non-Qargo address), the
    // <select> resets to the placeholder. The hint follows.
    updateHint();
  };
  roleEl.addEventListener("change", updateHint);
  emailEl.addEventListener("input", refreshRoleOptions);
  updateHint();
  /* Consent gate. The "Start learning" / "Save" button starts disabled and
     unlocks only when the consent box is checked. Re-running the modal
     (switch profile) requires the box again, so a learner who didn't see
     a previous version of this notice can't sail past it. We stamp the
     accepted PRIVACY_VERSION into localStorage on submit, which lets us
     detect if the notice changes and re-prompt later. */
  const consentEl = document.getElementById("id-consent");
  const stampedVersion = localStorage.getItem("academy.privacy_consent_version");
  if (stampedVersion === PRIVACY_VERSION) {
    // Returning user who already accepted the current notice: pre-tick the
    // box so they only need to click Save. Switching the box off and on
    // again is still allowed.
    consentEl.checked = true;
    saveBtn.disabled = false;
  }
  consentEl.addEventListener("change", () => {
    saveBtn.disabled = !consentEl.checked;
  });
  (isEdit ? roleEl : nameEl).focus();
  const submit = async () => {
    const name = document.getElementById("id-name").value.trim();
    const email = document.getElementById("id-email").value.trim();
    const company = document.getElementById("id-company").value.trim();
    const role = roleEl.value;
    const err = document.getElementById("id-error");
    err.textContent = "";
    if (!name || !email || !company) { err.textContent = "Name, email, and company are required."; return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Please enter a valid email."; return; }
    if (!role) { err.textContent = "Please pick your role."; return; }
    // Final client-side guard: the Internal role requires a Qargo email.
    // The authoritative check is the Worker password verification below;
    // this just keeps externals from picking the role by mistake.
    const roleDef = ROLES.find(r => r.id === role);
    if (roleDef?.internalOnly && !isInternalEmail(email)) {
      err.textContent = "The Internal profile is reserved for Qargo staff. Please use your @qargo.com email.";
      return;
    }
    // Internal role: verify the shared password against the Worker before
    // saving the profile. If the call fails, the modal stays open so the
    // user can retry without losing what they typed.
    if (roleDef?.internalOnly) {
      const password = internalPwEl.value;
      if (!password) { err.textContent = "Please enter the Internal access password."; return; }
      saveBtn.disabled = true;
      const prevLabel = saveBtn.textContent;
      saveBtn.textContent = "Verifying...";
      try {
        const token = await requestInternalToken(password);
        setInternalToken(token);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = prevLabel;
        err.textContent = e.message === "invalid password"
          ? "That password is not correct. Try again or ask your manager."
          : `Could not reach the Internal auth service: ${e.message}`;
        return;
      }
      saveBtn.disabled = false;
      saveBtn.textContent = prevLabel;
    } else {
      // Picking any non-internal role drops a previously stored token so
      // it cannot be reused by accident if the role is switched back.
      clearInternalToken();
    }
    setLearner({ name, email, company, role });
    /* Stamp the accepted privacy notice version. Used on subsequent modal
       opens to decide whether to re-prompt: if PRIVACY_VERSION advances,
       the stored value won't match and the consent box will start
       unchecked again. */
    try { localStorage.setItem("academy.privacy_consent_version", PRIVACY_VERSION); }
    catch (e) { /* localStorage unavailable, non-fatal */ }
    back.remove();
    if (onDone) onDone();
  };
  saveBtn.addEventListener("click", submit);
  back.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2500);
}

/* ---------- Worker reporting helpers ----------
   All Worker calls go through reportEvent(). It is fire-and-forget: a Worker
   outage or offline state can never block the lesson flow. The Worker upserts
   into the Notion "Learners Logs" database keyed by email. */
function learnerPayload() {
  const l = getLearner();
  if (!l) return null;
  return {
    name: l.name,
    email: l.email,
    company: l.company || "",
    role: l.role || null,
    roleLabel: l.role ? roleLabel(l.role) : null,
  };
}
async function reportEvent(event, extra = {}) {
  if (!REPORTING_ENDPOINT) return;           // dev / offline
  const learner = learnerPayload();
  if (!learner) return;                      // no identity yet
  try {
    await fetch(REPORTING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, learner, at: new Date().toISOString(), ...extra }),
    });
  } catch (e) { console.warn("reporting failed:", event, e); }
}
// Fires on every page load regardless of login state. No learner data required.
// The Worker stores these as raw page hits in KV (keyed by date).
async function reportPageView() {
  if (!REPORTING_ENDPOINT) return;
  try {
    const learner = learnerPayload(); // null for first-time visitors
    await fetch(REPORTING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "page_view",
        at: new Date().toISOString(),
        referrer: document.referrer || null,
        ...(learner ? { learner } : {}),
      }),
    });
  } catch (e) { console.warn("reporting failed: page_view", e); }
}
function reportSessionStart() {
  return reportEvent("session_start");
}
function reportLessonComplete(course, lesson) {
  return reportEvent("lesson_completed", {
    lesson: { id: lesson.id, title: lesson.title || lesson.id },
    module: { id: course.id, title: course.title },
  });
}
function reportPathComplete() {
  return reportEvent("path_completed", {
    path: { id: LEARNING_PATH.id, title: LEARNING_PATH.title },
  });
}

async function reportCompletion(course) {
  const learner = getLearner();
  if (!learner) return;
  if (!markCompleted(course.id)) return;     // already reported on this browser
  toast("Module completed");
  // Module-level engagement badges (e.g. first-module).
  checkEngagementBadges("module");
  // Send the module event before evaluating path completion so the order in
  // Notion's "Last milestone" field reads naturally (module then path).
  reportEvent("module_completed", {
    module: { id: course.id, title: course.title },
  });
  // If this completion finishes the whole learning path, stamp the date and
  // mint the cert ID so the badge page is ready when the learner navigates there.
  if (isPathComplete()) {
    const wasFirstTime = setPathCompletedAtIfMissing();
    getCertId();
    checkEngagementBadges("path");
    if (wasFirstTime) reportPathComplete();
  }
}

/* =========================================================================
   ROUTING + RENDERING
   ========================================================================= */
const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");

function route() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/course/")) {
    const id = hash.slice("#/course/".length);
    const course = COURSES.find(c => c.id === id);
    if (course) renderCourse(course);
    else renderNotFound();
  } else if (hash.startsWith("#/blocks")) {
    renderBlocksDemo();
  } else if (hash.startsWith("#/badge")) {
    renderBadge();
  } else {
    renderCatalog();
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}
window.addEventListener("hashchange", route);

function renderCatalog() {
  crumbs.textContent = "";
  app.classList.remove("course-view");
  app.classList.remove("blocks-view");
  app.classList.add("home-view");
  document.body.classList.remove("in-course");
  const learner = getLearner();
  const role = learner?.role;
  const done = getCompleted();

  // Path progress drives the CTA label on the learning-path card.
  const pathProgress = getPathProgress();
  const pathPct = pathProgress.pct;
  const pathStarted = pathProgress.started;

  // Stats: total module count, completed module count, and a rough learning-time
  // figure built from every unlocked block in the path (roughly 2 minutes per block).
  const unlockedModules = MODULES.filter(m => !m.locked);
  const inProgressCount = Math.max(MODULES.length - pathProgress.completedModules, 0);
  const certsEarned = pathProgress.completedModules;
  const learningMinutes = unlockedModules.reduce((acc, m) => acc + moduleBlockCount(m) * 2, 0);
  const learningHours = Math.max(1, Math.round(learningMinutes / 60));

  // Find the next unlocked module the learner hasn't fully finished. That's
  // the deep-link target for "Continue learning".
  const learnerName = learner?.name || "";
  const nextModule = unlockedModules.find(m => {
    const p = getModuleProgress(m.id);
    return p.completedLessons.length < moduleLessonCount(m);
  }) || unlockedModules[0] || null;

  // Seeded leaderboard so the same order shows up across renders. The
  // current learner is spliced in at row 3 when we know their name.
  const leaderboard = [
    { name: "Tom G.",     company: "Ashworth Logistics", score: 1840 },
    { name: "Delphin B.",   company: "Berger Transport",   score: 1675 },
    { name: "Liam B.", company: "NordEuro Freight",   score: 1510 },
    { name: "Michiel M.",  company: "West Transport",    score: 1395 },
    { name: "Lee H.",   company: "Northlane Haulage",  score: 1280 },
  ];
  if (learnerName) {
    const selfScore = 520 + (Array.from(learnerName).reduce((a, c) => a + c.charCodeAt(0), 0) % 380);
    leaderboard.splice(2, 0, { name: learnerName, company: learner?.company || "", score: selfScore, isYou: true });
  }
  leaderboard.sort((a, b) => b.score - a.score);

  const pathCtaLabel = pathStarted ? "Continue learning" : "Start learning path";

  const pathComplete = isPathComplete();

  app.innerHTML = `
    <section class="home-hero">
      <div class="home-hero-inner">
        <div class="eyebrow">Qargo Academy</div>
        <h1>Learn the Qargo way.</h1>
        <p>Short, focused courses that help your team get the most from Qargo, from order entry to invoicing and everything in between.</p>
        <div class="cta-row">
          <a class="btn btn-primary" id="hero-start" href="${nextModule ? `#/course/${nextModule.id}` : "#/"}">
            Quick start
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </a>
          <a class="btn btn-ghost" id="hero-browse" href="#/">Browse All Courses</a>
        </div>
      </div>
    </section>
    <div class="home-content">
    ${pathComplete ? `
      <div class="path-complete-banner">
        <div class="pcb-icon" aria-hidden="true">🏆</div>
        <div class="pcb-text">
          <div class="pcb-eyebrow">Learning path complete</div>
          <h3>You've finished ${escape(LEARNING_PATH.title)}.</h3>
          <p>Your shareable certificate is ready. Add it to your LinkedIn profile or download a PNG.</p>
        </div>
        <a class="pcb-cta" href="#/badge">
          View your certificate
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </a>
      </div>
    ` : ""}
    ${role ? `
      <div class="section-header home-section-header">
        <div>
          <h2 class="title">${role === "internal" ? "Internal training" : "Recommended for you"}</h2>
          <p class="sub">${role === "internal"
            ? (INTERNAL_MODULES.length > 0
                ? `For the <span class="role-accent">Qargo team</span>.`
                : `For the <span class="role-accent">Qargo team</span>. Internal modules will appear here once they have been published.`)
            : `Curated for <span class="role-accent">${escape(roleLabel(role))}</span>`}</p>
        </div>
      </div>
    ` : ""}
    <div class="home-layout">
      <div class="home-main">
        ${role === "internal" ? `
          <!-- Internal track is gated behind the Worker. When KV holds no
               internal modules yet, the empty-state placeholder renders.
               As soon as INTERNAL_MODULES has content, a path-style card
               takes its place: track title, module list with progress, CTA.
               No cert-card is rendered for Internal because the Super Admin
               certificate does not apply. -->
          ${INTERNAL_MODULES.length === 0 ? `
            <article class="path-card">
              <div class="path-card-head">
                <div class="path-meta">
                  <span class="path-code">Internal track</span>
                </div>
                <h3>Content is on the way</h3>
                <p>The Internal training track is still being built. Modules and lessons will appear here once the team publishes them.</p>
              </div>
              <div class="path-empty">
                <div class="path-empty-icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>
                </div>
                <div>
                  <strong>Nothing to take just yet</strong>
                  <p>No Internal modules have been published. Check back soon, or contact the Academy team if you have content ready to add.</p>
                </div>
              </div>
            </article>
          ` : (() => {
              /* Compute progress across the internal track using the same
                 helpers the public path uses (getModuleProgress, moduleLessonCount).
                 These work on any module that has lessons resolved. */
              const intCompleted = INTERNAL_MODULES.reduce((acc, m) => acc + getModuleProgress(m.id).completedLessons.length, 0);
              const intTotal = INTERNAL_MODULES.reduce((acc, m) => acc + moduleLessonCount(m), 0);
              const intPct = intTotal > 0 ? Math.round((intCompleted / intTotal) * 100) : 0;
              const intMinutes = INTERNAL_MODULES.filter(m => !m.locked).reduce((acc, m) => acc + moduleBlockCount(m) * 2, 0);
              const intHours = Math.max(1, Math.round(intMinutes / 60));
              const intNext = INTERNAL_MODULES.find(m => {
                const p = getModuleProgress(m.id);
                return !m.locked && p.completedLessons.length < moduleLessonCount(m);
              }) || INTERNAL_MODULES.find(m => !m.locked) || null;
              const intCtaLabel = intCompleted > 0 ? "Continue learning" : "Start learning path";
              const trackTitle = (INTERNAL_TRACK && INTERNAL_TRACK.title) || "Internal Onboarding";
              const trackDesc = (INTERNAL_TRACK && INTERNAL_TRACK.description) || "";
              return `
                <article class="path-card">
                  <div class="path-card-head">
                    <div class="path-meta">
                      <span class="path-code">Learning path</span>
                      <span class="dot-sep">·</span>
                      <span>${INTERNAL_MODULES.length} module${INTERNAL_MODULES.length === 1 ? "" : "s"}</span>
                      <span class="dot-sep">·</span>
                      <span>~${intHours}h total</span>
                    </div>
                    <h3>${escape(trackTitle)}</h3>
                    <p>${escape(trackDesc)}</p>
                  </div>
                  <ol class="path-module-list">
                    ${INTERNAL_MODULES.map((m) => {
                      const p = getModuleProgress(m.id);
                      const lessons = moduleLessonCount(m);
                      const moduleDone = !m.locked && lessons > 0 && p.completedLessons.length >= lessons;
                      const moduleStarted = !m.locked && p.completedLessons.length > 0 && !moduleDone;
                      const state = m.locked ? "locked" : moduleDone ? "done" : moduleStarted ? "active" : "ready";
                      const clickable = !m.locked && lessons > 0;
                      const Tag = clickable ? "a" : "div";
                      const hrefAttr = clickable ? ` href="#/course/${m.id}"` : "";
                      return `<${Tag} class="path-step path-step--${state}"${hrefAttr}>
                        <span class="step-code">${escape(m.code || "")}</span>
                        <span class="step-title">${escape(m.title)}</span>
                        <span class="step-status">${m.locked ? "Locked" : moduleDone ? "Completed" : moduleStarted ? "In progress" : "Not started"}</span>
                      </${Tag}>`;
                    }).join("")}
                  </ol>
                  <div class="path-card-foot">
                    <div class="path-progress">
                      <div class="bar"><span style="width:${intPct}%"></span></div>
                      <div class="pct">${intPct}% complete</div>
                    </div>
                    <a class="btn btn-primary" href="${intNext ? `#/course/${intNext.id}` : "#/"}">
                      ${intCtaLabel}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    </a>
                  </div>
                </article>
              `;
            })()}
        ` : role ? `
          <article class="path-card">
            <div class="path-card-head">
              <div class="path-meta">
                <span class="path-code">Learning path</span>
                <span class="dot-sep">·</span>
                <span>${MODULES.length} modules</span>
                <span class="dot-sep">·</span>
                <span>~${learningHours}h total</span>
              </div>
              <h3>${escape(LEARNING_PATH.title)}</h3>
              <p>${escape(LEARNING_PATH.description)}</p>
            </div>
            <ol class="path-module-list">
              ${MODULES.map((m) => {
                const p = getModuleProgress(m.id);
                const lessons = moduleLessonCount(m);
                const moduleDone = !m.locked && lessons > 0 && p.completedLessons.length >= lessons;
                const moduleStarted = !m.locked && p.completedLessons.length > 0 && !moduleDone;
                const state = m.locked ? "locked" : moduleDone ? "done" : moduleStarted ? "active" : "ready";
                const clickable = !m.locked && lessons > 0;
                const Tag = clickable ? "a" : "div";
                const hrefAttr = clickable ? ` href="#/course/${m.id}"` : "";
                return `<${Tag} class="path-step path-step--${state}"${hrefAttr}>
                  <span class="step-code">${escape(m.code)}</span>
                  <span class="step-title">${escape(m.title)}</span>
                  <span class="step-status">${m.locked ? "Locked" : moduleDone ? "Completed" : moduleStarted ? "In progress" : "Not started"}</span>
                </${Tag}>`;
              }).join("")}
            </ol>
            <div class="path-card-foot">
              <div class="path-progress">
                <div class="bar"><span style="width:${pathPct}%"></span></div>
                <div class="pct">${pathPct}% complete</div>
              </div>
              <a class="btn btn-primary" id="path-cta" href="${nextModule ? `#/course/${nextModule.id}` : "#/"}">
                ${pathCtaLabel}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              </a>
            </div>
          </article>

          <article class="cert-card ${pathComplete ? "cert-card-unlocked" : "cert-card-locked"}">
            <div class="cert-preview">
              <svg class="cert-mini" viewBox="0 0 240 150" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="cm-bg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%"  stop-color="#FFFFFF"/>
                    <stop offset="100%" stop-color="#F3FBF6"/>
                  </linearGradient>
                </defs>
                <rect x="2" y="2" width="236" height="146" rx="10" fill="url(#cm-bg)" stroke="#17181B" stroke-width="1.5"/>
                <rect x="10" y="10" width="220" height="130" rx="6" fill="none" stroke="#00E85B" stroke-width="1" stroke-dasharray="2 4" opacity="0.6"/>
                <rect x="22" y="22" width="3" height="106" fill="#00E85B" rx="1.5"/>
                <rect x="36" y="26" width="20" height="20" rx="4" fill="#17181B"/>
                <text x="46" y="40" text-anchor="middle" fill="#00E85B" font-family="Inter, sans-serif" font-size="13" font-weight="800">Q</text>
                <text x="62" y="34" fill="#17181B" font-family="Inter, sans-serif" font-size="7" font-weight="700" letter-spacing="2">QARGO</text>
                <text x="62" y="44" fill="#6B7076" font-family="Inter, sans-serif" font-size="6" font-weight="500" letter-spacing="2">ACADEMY</text>
                <text x="120" y="74" text-anchor="middle" fill="#00C44C" font-family="Inter, sans-serif" font-size="7" font-weight="700" letter-spacing="2">CERTIFICATE OF COMPLETION</text>
                <line x1="100" y1="80" x2="140" y2="80" stroke="#00E85B" stroke-width="1.5" stroke-linecap="round"/>
                <text x="120" y="100" text-anchor="middle" fill="#17181B" font-family="Inter, sans-serif" font-size="11" font-weight="800">${escape((learner?.name || "Your name").slice(0, 28))}</text>
                <text x="120" y="116" text-anchor="middle" fill="#3A3D44" font-family="Inter, sans-serif" font-size="7">${escape(LEARNING_PATH.title.length > 38 ? LEARNING_PATH.title.slice(0,36) + "…" : LEARNING_PATH.title)}</text>
                <circle cx="216" cy="128" r="12" fill="#0A66C2"/>
                <text x="216" y="132" text-anchor="middle" fill="#FFFFFF" font-family="Inter, sans-serif" font-size="9" font-weight="800">in</text>
              </svg>
              ${pathComplete ? "" : `
                <div class="cert-lock" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </div>
              `}
            </div>
            <div class="cert-body">
              <div class="cert-tag" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/></svg>
                Shareable on LinkedIn
              </div>
              <h3>${pathComplete ? "Your certificate is ready" : "Earn your LinkedIn certificate"}</h3>
              <p class="cert-desc">${pathComplete
                  ? "Add it to your LinkedIn profile in two clicks, or download a PNG for your records."
                  : `Finish all ${MODULES.length} modules in <strong>${escape(LEARNING_PATH.title)}</strong> and a personalised, shareable certificate appears here.`}</p>
              ${pathComplete ? `
                <a class="cert-cta" href="#/badge">
                  View certificate
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                </a>
              ` : `
                <div class="cert-progress">
                  <div class="bar"><span style="width:${pathPct}%"></span></div>
                  <div class="meta"><strong>${pathProgress.completedModules} of ${MODULES.length}</strong> modules<span>${pathPct}%</span></div>
                </div>
                <a class="cert-cta" href="${nextModule ? `#/course/${nextModule.id}` : "#/"}">
                  ${pathProgress.started ? "Continue learning" : "Start the path"}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                </a>
              `}
            </div>
          </article>
        ` : ""}

        <div class="section-header" style="margin-top:28px">
          <div>
            <h2 class="title">Specialised modules</h2>
            <p class="sub">Network-specific modules. Available once your learning path is complete.</p>
          </div>
        </div>
        <div class="grid" id="catalog-specialised"></div>

        <div class="section-header" style="margin-top:28px">
          <div>
            <h2 class="title">Extra-curricular</h2>
            <p class="sub">Regulatory and soft-skill training. Coming soon.</p>
          </div>
        </div>
        <div class="grid" id="catalog-extra"></div>
      </div>

      <aside class="home-side">
        <section class="side-block" data-collapsed="false">
          <button type="button" class="side-block-head" aria-expanded="true" data-toggle="collapse">
            <h3 class="side-title">Learner progress</h3>
            <svg class="side-block-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="side-block-body">
            <ul class="side-stats">
              <li>
                <div class="num">${inProgressCount}</div>
                <div class="label">In progress</div>
              </li>
              <li>
                <div class="num">${certsEarned}</div>
                <div class="label">Certifications</div>
              </li>
              <li>
                <div class="num">${learningHours}h</div>
                <div class="label">Learning time</div>
              </li>
            </ul>
          </div>
        </section>

        <section class="side-block badges-overview" data-collapsed="false">
          <button type="button" class="side-block-head" aria-expanded="true" data-toggle="collapse">
            <h3 class="side-title">Badges earned</h3>
            <svg class="side-block-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="side-block-body">
            ${(() => {
              const earnedBadges = getEarnedBadges();
              const totalEng = ENGAGEMENT_BADGES.length;
              const earnedEng = ENGAGEMENT_BADGES.filter(b => earnedBadges[b.id]).length;
              const totalAll  = totalEng + 1; // +1 for the LinkedIn cert capstone
              const earnedAll = earnedEng + (pathComplete ? 1 : 0);
              const streak    = getCurrentStreak();
              const streakLine = streak > 0
                ? `<div class="streak-line"><strong>${streak}-day</strong> streak — keep it up.</div>`
                : `<div class="streak-line">No active streak yet. Finish a lesson today to start one.</div>`;

              const engHexes = ENGAGEMENT_BADGES.map(b => {
                const earned = !!earnedBadges[b.id];
                const cls = earned ? "earned" : "locked";
                const glow = earned ? `--hex-glow: ${b.c2}66;` : "";
                return `
                  <div class="hex-badge ${cls}" style="${glow}" title="${escape(b.title)}${earned ? " — earned" : ""}\n${escape(b.desc)}">
                    ${buildHexBadgeSVG(b)}
                  </div>`;
              }).join("");

              return `
                <div class="summary">
                  <span class="num">${earnedAll}</span>
                  <span class="total">of ${totalAll} earned</span>
                </div>
                ${streakLine}

                <div class="b-section-label">Milestones</div>
                <div class="grid eng-grid">${engHexes}</div>

                <div class="b-cert ${pathComplete ? "earned" : "locked"}" title="${pathComplete ? "Certificate earned" : "Complete the path to unlock"}">
                  <span class="b-cert-icon">${pathComplete
                    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/></svg>`
                    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`}</span>
                  <div class="b-cert-text">
                    <strong>LinkedIn certificate</strong>
                    ${pathComplete
                      ? `<a href="#/badge" style="color: var(--brand-700); font-weight: 600;">View &rarr;</a>`
                      : `Awarded for full-path completion`}
                  </div>
                </div>
              `;
            })()}
          </div>
        </section>

        <section class="side-block" data-collapsed="false">
          <button type="button" class="side-block-head" aria-expanded="true" data-toggle="collapse">
            <h3 class="side-title">Leaderboard 🏆</h3>
            <svg class="side-block-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="side-block-body">
            <p class="side-sub">Top learners this month across Qargo customers.</p>
            <ol class="leaderboard">
              ${leaderboard.slice(0, 6).map((row, i) => `
                <li class="${row.isYou ? "is-you" : ""}">
                  <span class="rank">${i + 1}</span>
                  <span class="who">
                    <span class="nm">${escape(row.name)}${row.isYou ? ' <span class="you-chip">You</span>' : ""}</span>
                    ${row.company ? `<span class="co">${escape(row.company)}</span>` : ""}
                  </span>
                  <span class="pts">${row.score.toLocaleString()} pts</span>
                </li>
              `).join("")}
            </ol>
          </div>
        </section>
      </aside>
    </div>
    </div>
  `;

  // Wire up "Start Learning" and "Browse All Courses" to navigate or scroll.
  const startBtn = document.getElementById("hero-start");
  if (startBtn) {
    startBtn.addEventListener("click", (e) => {
      if (nextModule) return; // let the anchor navigate
      e.preventDefault();
      const target = document.querySelector(".path-card") || document.querySelector(".grid");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const browseBtn = document.getElementById("hero-browse");
  if (browseBtn) {
    browseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.querySelector(".path-card") || document.querySelector(".grid");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const renderLocked = (selector, list) => {
    const grid = document.querySelector(selector);
    if (!grid || !list.length) return;
    for (const c of list) {
      const card = document.createElement("div");
      card.className = "card card-locked";
      card.setAttribute("aria-disabled", "true");
      card.innerHTML = `
        <div class="locked-badge">Coming soon</div>
        <h3>${escape(c.title)}</h3>
        <p>${escape(c.description || "")}</p>
      `;
      grid.appendChild(card);
    }
  };
  renderLocked("#catalog-specialised", SPECIALISED_MODULES);
  renderLocked("#catalog-extra", EXTRA_CURRICULAR);

  // Collapsible side blocks (Learner progress + Leaderboard). Clicking the
  // header toggles data-collapsed on the section, which the CSS animates.
  document.querySelectorAll(".side-block [data-toggle='collapse']").forEach(btn => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".side-block");
      if (!block) return;
      const nowCollapsed = block.getAttribute("data-collapsed") !== "true";
      block.setAttribute("data-collapsed", String(nowCollapsed));
      btn.setAttribute("aria-expanded", String(!nowCollapsed));
    });
  });

  // Wire up the header search to filter whatever cards are visible on the page.
  const search = document.getElementById("course-search");
  if (search) {
    search.value = "";
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      document.querySelectorAll(".grid .card, .path-card").forEach(card => {
        const match = card.textContent.toLowerCase().includes(q);
        card.style.display = match ? "" : "none";
      });
    };
  }
}

function countKinds(course) {
  const kinds = {};
  for (const l of lessonsOf(course)) {
    for (const b of (l.blocks || [])) {
      kinds[b.type] = (kinds[b.type] || 0) + 1;
    }
  }
  const label = {
    text: "reading",
    accordion: "accordion",
    flipcard: "flipcards",
    flashcards: "flipcards",
    match: "match",
    embed: "interactive",
    summary: "summary",
    quiz: "quiz",
  };
  return Object.entries(kinds).map(([k, n]) => `${n} ${label[k] || k}`).join(" · ");
}

/* Derive a human-readable section title from a block, even when block.title is absent. */
function sectionTitleOf(block, idx) {
  if (block.title) return block.title;
  const fallback = {
    text: "Overview",
    quiz: "Knowledge check",
    flashcards: "Flashcards",
    match: "Match the pairs",
    embed: block.kind || "Interactive",
  }[block.type] || "Section";
  return fallback;
}

function renderCourse(course) {
  // Course view uses a two-column layout that breaks out of the default max-width.
  crumbs.textContent = "";
  app.classList.add("course-view");
  app.classList.remove("home-view");
  app.classList.remove("blocks-view");
  document.body.classList.add("in-course");

  const lessons = lessonsOf(course);

  // Locked modules aren't playable yet — show a placeholder so anyone who
  // deep-links to them lands on something coherent.
  if (course.locked || !lessons.length) {
    app.classList.remove("course-view");
    app.classList.remove("home-view");
    document.body.classList.remove("in-course");
    app.innerHTML = `
      <section class="hero">
        <div class="eyebrow">${escape(course.code || "Module")}</div>
        <h1>${escape(course.title)}</h1>
        <p>${escape(course.description || "")}</p>
        <div class="locked-panel">
          <strong>Coming soon.</strong>
          <p>This module is part of the Super Admin learning path but hasn't been built yet. Only <em>The Logic of Qargo</em> is playable in this preview.</p>
          <div class="cta-row">
            <a class="btn btn-primary" href="#/">Back to the learning path</a>
          </div>
        </div>
      </section>
    `;
    return;
  }

  const total = lessons.length;
  const persisted = getModuleProgress(course.id);

  // Build sidebar section items and the main content at the same time so
  // indexes line up. Each lesson is one section; inside a section we render
  // all of its blocks stacked.
  const sectionItems = lessons.map((l, i) => `
    <li data-idx="${i}">
      <span class="dot"></span>
      <div>
        <div>${escape(l.title)}</div>
        <span class="status">Unstarted</span>
      </div>
    </li>
  `).join("");

  // Render each lesson as a section-wrap, with a full-width lesson-transition
  // banner between it and the next lesson. The banner bleeds past the prose
  // column so it looks like a newspaper section break.
  const sectionPieces = lessons.map((l, i) => {
    const blockSlots = (l.blocks || []).map((_, bi) =>
      `<section class="block" data-block-idx="${bi}"></section>`
    ).join("");
    const sectionHtml = `
      <div class="section-wrap" id="section-${i}" data-idx="${i}">
        <div class="section-label">Lesson ${i + 1} of ${total}</div>
        <h2 class="section-title">${escape(l.title)}</h2>
        ${blockSlots}
      </div>
    `;
    const isLast = i + 1 >= total;
    const transitionHtml = isLast ? `
      <div class="lesson-transition is-last" data-after-idx="${i}">
        <button type="button" data-action="finish">
          <span class="next-title">Module complete — back to learning path</span>
        </button>
      </div>
    ` : `
      <div class="lesson-transition" data-after-idx="${i}">
        <button type="button" data-action="advance" data-to-idx="${i + 1}">
          <span class="arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg></span>
          <span class="next-title">${i + 2} of ${total} — ${escape(lessons[i + 1].title)}</span>
        </button>
      </div>
    `;
    return sectionHtml + transitionHtml;
  }).join("");

  app.innerHTML = `
    <div class="course-layout">
      <div class="course-sidebar-backdrop" id="course-sidebar-backdrop"></div>
      <aside class="course-sidebar" id="course-sidebar" aria-hidden="true">
        <button class="course-sidebar-close" type="button" id="course-sidebar-close" aria-label="Close table of contents">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
        <a href="#/" class="back-link">← Back to learning path</a>
        <div class="eyebrow">${escape(course.code || "Module")}</div>
        <h2 class="course-title">${escape(course.title)}</h2>
        <div class="pct-row">
          <span id="pct-label">0% complete</span>
        </div>
        <div class="pct-track"><div class="pct-fill" id="pct-fill"></div></div>
        <ol class="sections" id="sections">${sectionItems}</ol>
      </aside>
      <div class="course-main">
        <div class="course-hero">
          <div class="hero-inner">
            <div class="meta">${escape(course.code || "Module")} · ${total} lesson${total === 1 ? "" : "s"}</div>
            <h1>${escape(course.title)}</h1>
            ${course.description ? `<p>${escape(course.description)}</p>` : ""}
          </div>
          <button class="hero-start" id="hero-start-btn" type="button">
            Start module
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
          </button>
        </div>
        ${sectionPieces}
      </div>
      <button class="course-pin" id="course-pin" type="button" aria-expanded="false" aria-controls="course-sidebar">
        <div class="pin-text">
          <div class="pin-eyebrow" id="pin-eyebrow">Lesson 1 of ${total}</div>
          <div class="pin-title" id="pin-title">${escape(lessons[0].title)}</div>
        </div>
        <svg class="pin-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
      </button>
    </div>
  `;

  const completion = new Array(total).fill(false);
  const sectionEls = Array.from(document.querySelectorAll(".section-wrap"));
  const sidebarLis = Array.from(document.querySelectorAll("#sections li"));
  const pctFill = document.getElementById("pct-fill");
  const pctLabel = document.getElementById("pct-label");
  const sidebarEl = document.getElementById("course-sidebar");
  const sidebarBackdrop = document.getElementById("course-sidebar-backdrop");
  const sidebarCloseBtn = document.getElementById("course-sidebar-close");
  const pinBtn = document.getElementById("course-pin");
  const pinEyebrow = document.getElementById("pin-eyebrow");
  const pinTitle = document.getElementById("pin-title");

  // Drawer open/close helpers for the collapsible table of contents.
  const openDrawer = () => {
    sidebarEl.setAttribute("aria-hidden", "false");
    sidebarBackdrop.classList.add("visible");
    pinBtn.setAttribute("aria-expanded", "true");
  };
  const closeDrawer = () => {
    sidebarEl.setAttribute("aria-hidden", "true");
    sidebarBackdrop.classList.remove("visible");
    pinBtn.setAttribute("aria-expanded", "false");
  };
  pinBtn.addEventListener("click", openDrawer);
  sidebarBackdrop.addEventListener("click", closeDrawer);
  sidebarCloseBtn.addEventListener("click", closeDrawer);

  // Progressive reveal — only lessons up to `revealedIdx` are visible. The
  // lesson-transition banner between revealedIdx and revealedIdx+1 is the
  // visible gate; scrolling past it is impossible because nothing follows
  // in the DOM until the learner clicks the button.
  // For first-time visitors, `revealedIdx` starts at -1 so the hero acts as
  // a real gate — nothing is scrollable below it until "Start module" is
  // clicked. Returning learners (any completed lesson on this module) bypass
  // the gate so they don't have to re-click through.
  const transitionEls = Array.from(document.querySelectorAll(".lesson-transition"));
  const hasPriorProgress = persisted.completedLessons.length > 0;
  let revealedIdx = hasPriorProgress ? 0 : -1;
  for (let i = total - 1; i >= 0; i--) {
    if (persisted.completedLessons.includes(lessons[i].id)) {
      revealedIdx = Math.min(i + 1, total - 1);
      break;
    }
  }

  // The course pin (bottom-left floating menu) overlaps the centred
  // "Start module" CTA on small viewports while the hero is in view.
  // Hide it until the learner has scrolled past the hero.
  const heroEl = document.querySelector(".course-hero");
  if (heroEl && pinBtn) {
    pinBtn.classList.add("pin-hidden");
    const heroSpy = new IntersectionObserver(([entry]) => {
      pinBtn.classList.toggle("pin-hidden", entry.isIntersecting);
    }, { threshold: 0.1 });
    heroSpy.observe(heroEl);
  }

  // "Start module" hero CTA — for first-time visitors, this is the gate that
  // unlocks lesson 1. For returning learners it's a quick scroll-to-first.
  const heroStartBtn = document.getElementById("hero-start-btn");
  if (heroStartBtn) {
    heroStartBtn.addEventListener("click", () => {
      if (revealedIdx < 0) {
        revealedIdx = 0;
        applyReveal();
        requestAnimationFrame(() => {
          const target = document.getElementById("section-0");
          if (!target) return;
          target.classList.remove("just-revealed");
          void target.offsetWidth;
          target.classList.add("just-revealed");
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      } else {
        const first = document.getElementById("section-0");
        if (first) first.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  function applyReveal() {
    sectionEls.forEach((el, i) => {
      el.classList.toggle("is-locked", i > revealedIdx);
    });
    transitionEls.forEach(t => {
      const afterIdx = Number(t.dataset.afterIdx);
      t.classList.toggle("is-locked", afterIdx > revealedIdx);
    });
  }
  applyReveal();

  // Wire advance / finish buttons on every lesson-transition.
  transitionEls.forEach(t => {
    const btn = t.querySelector("button");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      if (action === "finish") {
        location.hash = "#/";
        return;
      }
      const toIdx = Number(btn.dataset.toIdx);
      if (toIdx > revealedIdx) revealedIdx = toIdx;
      applyReveal();
      // Let the browser paint the newly-revealed section before scrolling +
      // animating, otherwise the animation starts partially scrolled-past.
      requestAnimationFrame(() => {
        const target = document.getElementById("section-" + toIdx);
        if (!target) return;
        target.classList.remove("just-revealed");
        // Force reflow so the animation restarts cleanly.
        void target.offsetWidth;
        target.classList.add("just-revealed");
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  });

  // Fade + slide the lesson-transition banner into view as the learner
  // reaches the end of a lesson's content.
  const fadeSpy = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.classList.add("in-view");
    });
  }, { threshold: 0.15 });
  transitionEls.forEach(t => fadeSpy.observe(t));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebarEl.getAttribute("aria-hidden") === "false") closeDrawer();
  });

  // Click sidebar entry → smooth-scroll to the corresponding section AND close drawer.
  sidebarLis.forEach(li => {
    li.addEventListener("click", () => {
      const idx = Number(li.dataset.idx);
      const target = document.getElementById("section-" + idx);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      closeDrawer();
    });
  });

  // Render each lesson's blocks into their inner .block shells.
  // A lesson is only marked complete once every block inside it has signalled done.
  lessons.forEach((lesson, i) => {
    const sectionEl = sectionEls[i];
    const blockEls = Array.from(sectionEl.querySelectorAll(".block"));
    const blocks = lesson.blocks || [];

    // Flag the section as hosting an embed so it can break out of the prose column.
    if (blocks.some(b => b.type === "embed")) sectionEl.classList.add("has-embed");

    const alreadyDone = persisted.completedLessons.includes(lesson.id);
    // Track per-block completion within this lesson.
    const blockDone = new Array(blocks.length).fill(false);

    const markLessonCompleteUI = () => {
      if (completion[i]) return;
      completion[i] = true;
      sidebarLis[i].classList.add("done");
      const statusEl = sidebarLis[i].querySelector(".status");
      if (statusEl) statusEl.textContent = "Completed";
      markLessonDone(course.id, lesson.id);
      // Fire the per-lesson event. This block only runs when the lesson
      // transitions from incomplete to complete in this session, so it's
      // already deduped against the pre-seeded "alreadyDone" path.
      reportLessonComplete(course, lesson);
      const doneCount = completion.filter(Boolean).length;
      const pct = Math.round((doneCount / total) * 100);
      pctFill.style.width = pct + "%";
      pctLabel.textContent = pct + "% complete";
      if (doneCount === total) reportCompletion(course);
    };

    // Pre-seed UI if the learner previously finished this lesson.
    if (alreadyDone) {
      completion[i] = true;
      sidebarLis[i].classList.add("done");
      const statusEl = sidebarLis[i].querySelector(".status");
      if (statusEl) statusEl.textContent = "Completed";
    }

    // Render each block and wire its per-block done signal.
    const lessonCtx = buildLessonContext(lesson);
    blocks.forEach((block, bi) => {
      const el = blockEls[bi];
      if (!el) return;
      const markBlockDone = () => {
        if (blockDone[bi]) return;
        blockDone[bi] = true;
        if (blockDone.every(Boolean)) markLessonCompleteUI();
      };
      renderBlock(el, block, markBlockDone, { lesson: lessonCtx, course: { id: course.id, title: course.title } });
    });
  });

  // Prime the progress bar from any pre-seeded completions.
  const preDone = completion.filter(Boolean).length;
  if (preDone) {
    const prePct = Math.round((preDone / total) * 100);
    pctFill.style.width = prePct + "%";
    pctLabel.textContent = prePct + "% complete";
  }

  // Scroll-spy — highlight whichever section is currently in the viewport
  // and keep the floating pin in sync with the current lesson.
  const spy = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = Number(entry.target.dataset.idx);
        sidebarLis.forEach(li => li.classList.remove("current"));
        const cur = sidebarLis[idx];
        if (cur) {
          cur.classList.add("current");
          if (!cur.classList.contains("done")) {
            const statusEl = cur.querySelector(".status");
            if (statusEl) statusEl.textContent = "In progress";
          }
        }
        // Update the floating pin text.
        const lesson = lessons[idx];
        if (lesson) {
          pinEyebrow.textContent = `Lesson ${idx + 1} of ${total}`;
          pinTitle.textContent = lesson.title;
        }
      }
    });
  }, { rootMargin: "-20% 0px -70% 0px", threshold: 0 });
  sectionEls.forEach(el => spy.observe(el));

  // Block focus tracker — picks the block whose centre is closest to the
  // viewport centre and marks it `.is-focused`. The hosting section-wrap is
  // marked `.has-focus`, which the CSS uses to gently dim other blocks in
  // the same lesson. Helps learners orient on the block they're reading.
  const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 68;
  let focusRAF = 0;
  function updateBlockFocus() {
    focusRAF = 0;
    const blocks = Array.from(document.querySelectorAll(".course-main .section-wrap:not(.is-locked) .block"));
    if (!blocks.length) return;
    const viewCentre = headerH + (window.innerHeight - headerH) / 2;
    let best = null;
    let bestDist = Infinity;
    blocks.forEach(b => {
      const r = b.getBoundingClientRect();
      if (r.bottom < headerH || r.top > window.innerHeight) return; // off-screen
      const centre = (r.top + r.bottom) / 2;
      const dist = Math.abs(centre - viewCentre);
      if (dist < bestDist) { best = b; bestDist = dist; }
    });
    const prevFocused = document.querySelector(".course-main .block.is-focused");
    if (prevFocused && prevFocused !== best) prevFocused.classList.remove("is-focused");
    const prevSection = document.querySelector(".course-main .section-wrap.has-focus");
    if (prevSection && (!best || best.closest(".section-wrap") !== prevSection)) {
      prevSection.classList.remove("has-focus");
    }
    if (best) {
      best.classList.add("is-focused");
      const sec = best.closest(".section-wrap");
      if (sec) sec.classList.add("has-focus");
    }
  }
  function scheduleFocusUpdate() {
    if (focusRAF) return;
    focusRAF = requestAnimationFrame(updateBlockFocus);
  }
  window.addEventListener("scroll", scheduleFocusUpdate, { passive: true });
  window.addEventListener("resize", scheduleFocusUpdate);
  // Run once after layout settles so the first visible block lights up.
  setTimeout(updateBlockFocus, 50);
}

function renderNotFound() {
  crumbs.textContent = "";
  app.classList.remove("course-view");
  app.classList.remove("home-view");
  app.innerHTML = `<h1>Not found</h1><p class="lead">That course doesn't exist. <a href="#/">Back to catalog</a></p>`;
}

/* =========================================================================
   PRIVACY CONSENT
   The Academy operates under Qargo's master privacy notice at
   PRIVACY_NOTICE_URL below. We don't ship a separate Academy-specific
   notice — there's only one source of truth, and it lives on qargo.com.

   Consent is captured in the identity modal: a checkbox that links to the
   master notice, gating the "Start learning" / "Save" button. When the
   learner ticks the box and submits, we stamp PRIVACY_VERSION into
   localStorage so we can re-prompt later if Qargo updates the master
   notice in a way that warrants fresh acceptance — bump PRIVACY_VERSION
   here and every learner's stored consent will fall out of date,
   forcing a re-tick on their next profile edit.
   ========================================================================= */
const PRIVACY_VERSION = "2026-05-02";
const PRIVACY_NOTICE_URL = "https://www.qargo.com/privacy-notice/";

/* =========================================================================
   BLOCK LIBRARY — /#blocks demo route
   A single page showing every block type the platform supports, with a
   short description of when to use it and a working example. Useful for
   authors deciding which block to drop into a lesson, and for QA.
   ========================================================================= */
function renderBlocksDemo() {
  crumbs.innerHTML = `<a href="#/">Catalog</a> &nbsp;/&nbsp; Block library`;
  app.classList.remove("course-view");
  app.classList.remove("home-view");
  app.classList.add("blocks-view");
  document.body.classList.remove("in-course");

  const demos = [
    {
      id: "text", label: "Text",
      desc: "Standard prose block with optional lead paragraph. Marks done on render — the platform assumes the learner read it.",
      block: {
        type: "text",
        title: "Why short, focused lessons work",
        lead: "Adults retain more from chunked content than from long blocks of prose.",
        body: "Each lesson should hold one idea, supported by one or two practical examples. If you need more, split it into a follow-up lesson rather than padding this one."
      }
    },
    {
      id: "image", label: "Image",
      desc: "Single image with optional caption. Use for diagrams, screenshots, or photography. Marks done on render.",
      block: {
        type: "image",
        src: "https://www.qargo.com/u/2025/07/Qargo-tms-1-1.avif",
        alt: "Qargo TMS dashboard",
        caption: "Figure 1. The Qargo TMS dispatch view, showing live trips on the right and orders on the left."
      }
    },
    {
      id: "carousel", label: "Carousel",
      desc: "A set of slides the learner pages through with prev/next or arrow keys. Marks done once every slide has been viewed.",
      block: {
        type: "carousel",
        title: "Three views in dispatch",
        slides: [
          { src: "https://images.unsplash.com/photo-1601584115197-04ecc0da31e2?w=1200&q=80", alt: "Truck on highway",
            caption: "Live trips. Watch active trucks move across the network in real time." },
          { src: "https://images.unsplash.com/photo-1577415124269-fc1140a69e91?w=1200&q=80", alt: "Warehouse loading bay",
            caption: "Yard view. See what's at each gate and how long it's been there." },
          { src: "https://images.unsplash.com/photo-1494412519320-aa613dfb7738?w=1200&q=80", alt: "Dispatch screens",
            caption: "Planner. Drag and drop unassigned orders onto the right driver." },
        ]
      }
    },
    {
      id: "accordion", label: "Accordion",
      desc: "Collapsible Q&A rows. The learner must expand every row before the block marks done. Good for reference material.",
      block: {
        type: "accordion",
        title: "Common dispatcher questions",
        items: [
          { q: "What's the difference between an order and a trip?", a: "An order is what the customer asked for. A trip is one truck's plan to deliver one or more orders." },
          { q: "When do I close a trip?", a: "Close a trip after the final POD is received and any extra charges have been added. Closing locks rates and triggers invoicing." },
          { q: "Can I edit a closed trip?", a: "Only with manager rights, and the system will log the change. Most edits should happen before close." },
        ]
      }
    },
    {
      id: "summary", label: "Summary",
      desc: "Highlighted list of key takeaways. Use at the end of a lesson to anchor the main points. Marks done on render.",
      block: {
        type: "summary",
        title: "What to remember",
        points: [
          "Orders capture what the customer wants. Trips capture how you'll deliver it.",
          "One trip can carry many orders, but each order belongs to one trip at a time.",
          "Closing a trip locks rates — do it after POD and any extras are in.",
        ]
      }
    },
    {
      id: "quiz", label: "Quiz",
      desc: "Single-select multiple-choice question. Locks on submit, reveals the correct answer, and shows feedback. Marks done on submit.",
      block: {
        type: "quiz",
        title: "Quick check",
        question: "Which object captures what the customer asked for?",
        options: ["Trip", "Order", "Asset", "Invoice"],
        correct: 1,
        explanation: "Orders capture customer demand. Trips capture how you'll deliver."
      }
    },
    {
      id: "fillblanks", label: "Fill in the blanks",
      desc: "Paragraph with `{answer}` tokens that become inline inputs. Use Check to grade, Reveal to show answers. Marks done on full correct or after reveal.",
      block: {
        type: "fillblanks",
        title: "Vocabulary check",
        prompt: "Fill the gaps with the right object names.",
        text: "In Qargo, customer demand is captured as an {order}, the truck's plan is a {trip}, and the truck itself is an {asset}."
      }
    },
    {
      id: "match", label: "Match",
      desc: "Drag terms onto the matching definitions. Marks done when every pair is correct.",
      block: {
        type: "match",
        title: "Match the term to the definition",
        pairs: [
          { term: "Order",   definition: "What the customer asked you to move." },
          { term: "Trip",    definition: "One truck's planned route, carrying one or more orders." },
          { term: "Asset",   definition: "A vehicle, trailer, or other physical resource." },
          { term: "Invoice", definition: "The financial document sent to the customer or carrier." },
        ]
      }
    },
    {
      id: "flashcards", label: "Flashcards",
      desc: "Click-to-flip card deck. Marks done once the learner has flipped at least half the deck. Good for vocabulary or quick recall.",
      block: {
        type: "flashcards",
        title: "Status flashcards",
        cards: [
          { front: "POD", back: "Proof of Delivery — signed confirmation that the load arrived." },
          { front: "ETA", back: "Estimated Time of Arrival." },
          { front: "Tractor", back: "The powered unit at the front of a truck." },
          { front: "Trailer", back: "The unpowered unit behind the tractor that holds the load." },
        ]
      }
    },
    {
      id: "process", label: "Process steps",
      desc: "Numbered vertical stepper. Click each step to expand. Marks done once every step has been opened.",
      block: {
        type: "process",
        title: "How an order becomes an invoice",
        steps: [
          { title: "Capture the order",   body: "Sales or EDI creates the order with pickup, delivery, and rate." },
          { title: "Plan onto a trip",    body: "Dispatch assigns the order to a driver and trip, sequencing pickups and deliveries." },
          { title: "Execute and POD",     body: "The driver picks up, delivers, and uploads the POD via the mobile app." },
          { title: "Close and invoice",   body: "Operations close the trip, billing reviews, and the invoice goes out." },
        ]
      }
    },
    {
      id: "timeline", label: "Timeline",
      desc: "Vertical timeline of dated events. Each event fades in as the learner scrolls. Marks done on render.",
      block: {
        type: "timeline",
        title: "Qargo product milestones",
        events: [
          { date: "2021",     title: "First TMS shipped",       body: "First version of the Qargo TMS goes live with launch customers." },
          { date: "2023",     title: "Mobile app",              body: "Driver-facing mobile app released, with offline POD capture." },
          { date: "2024",     title: "Smart planning",          body: "Automated trip suggestions and cost-aware dispatch." },
          { date: "2025",     title: "Open API",                body: "Public REST API and webhooks open up custom integrations." },
          { date: "Today",    title: "You're learning the basics", body: "Welcome to Qargo Academy." },
        ]
      }
    },
    {
      id: "milestone", label: "Milestone celebration",
      desc: "Congratulatory marker between key sections of a path. Confetti fires once. Marks done when the learner clicks the CTA.",
      block: {
        type: "milestone",
        headline: "Halfway there",
        message: "You've learned the four core objects and how they connect. Next up: planning trips and handling exceptions.",
        cta: "Keep going"
      }
    },
    {
      id: "embed", label: "Embed",
      desc: "Iframe wrapper for Storylane demos, YouTube, Loom, virtual environments. Marks done when the learner clicks Mark complete.",
      block: {
        type: "embed",
        title: "Try it yourself",
        kind: "Interactive demo",
        url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
        ratio: "16/9",
        caption: "Watch the walkthrough, then mark complete."
      }
    },
    {
      id: "tutor", label: "AI tutor",
      desc: "Lesson-aware chat panel powered by OpenAI. Reads your API key from localStorage on first use. Suggested prompts speed up the first question. Marks done on first successful answer.",
      block: {
        type: "tutor",
        title: "AI tutor",
        subtitle: "Try me — I know about every block on this page.",
        suggestions: [
          "What's the difference between an order and a trip?",
          "Give me a quick exam-style question about dispatch.",
          "Explain a Qargo POD in simple terms."
        ]
      }
    },
  ];

  // Synthetic lesson context so the tutor demo feels grounded.
  const demoCtx = {
    lesson: { title: "Qargo Academy block library",
              body: "This page demonstrates every interactive block type in the Academy platform: text, image, carousel, accordion, summary, quiz, fill-in-the-blanks, match, flashcards, process steps, timeline, milestone, embed, and AI tutor. Use these as building blocks when authoring lessons." },
    course: { id: "blocks-demo", title: "Block library" }
  };

  app.innerHTML = `
    <section class="blocks-hero">
      <div class="eyebrow">Block library</div>
      <h1>Every block, in one place</h1>
      <p>Each block below is fully interactive. Use this page to decide which block fits your lesson, to QA new behaviour, or to onboard new content authors. There are ${demos.length} blocks in total.</p>
      <div class="blocks-toc">
        ${demos.map((d, i) => `<a href="#/blocks#demo-${d.id}"><span class="toc-num">${i + 1}</span>${escape(d.label)}</a>`).join("")}
      </div>
    </section>
    ${demos.map((d, i) => `
      <section class="block-demo" id="demo-${d.id}">
        <span class="demo-meta">Block ${i + 1} of ${demos.length} &middot; ${escape(d.label)}</span>
        <h2><span class="demo-num">${i + 1}</span> ${escape(d.label)}</h2>
        <p class="demo-desc">${escape(d.desc)}</p>
        <article class="block" data-demo="${d.id}"></article>
      </section>
    `).join("")}
    <p style="margin: 56px 0 0; color: var(--ink-500); font-size: 14px;">
      <a href="#/">&larr; Back to catalog</a>
    </p>
  `;

  // Render each demo block. Per-demo "done" is harmless — these aren't tracked.
  demos.forEach(d => {
    const el = app.querySelector(`.block[data-demo="${d.id}"]`);
    if (!el) return;
    renderBlock(el, d.block, () => {}, demoCtx);
  });

  // Honour TOC hash anchors after content renders.
  requestAnimationFrame(() => {
    const sub = (location.hash.split("#")[2] || "").trim();
    if (sub) {
      const t = document.getElementById(sub);
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/* =========================================================================
   PATH COMPLETION BADGE — /#badge
   Renders a certificate of completion as inline SVG (so it scales crisply
   and can be downloaded as PNG). Provides a LinkedIn "Add to Profile" link
   using the official prefill URL, plus PNG download and copy-link.
   ========================================================================= */

/* Render a single hexagonal achievement badge as inline SVG. The gradient
   IDs are uniqued per-badge so multiple hexes coexist on the same page.
   `style: "diamond"` switches to a multi-faceted, shimmering diamond render. */
function buildHexBadgeSVG({ id, c1, c2, icon, label, style, iconColor }, opts = {}) {
  const gid = `hex-grad-${id}`;
  const hid = `hex-high-${id}`;
  const sid = `hex-shimmer-${id}`;
  const cid = `hex-clip-${id}`;
  // Pointy-top hexagon path with corners at viewBox 100x100.
  const hex = "M50 4 L91 27 L91 73 L50 96 L9 73 L9 27 Z";
  const icColor = iconColor || "#FFFFFF";
  const labelMarkup = label
    ? `<text x="50" y="60" text-anchor="middle" class="mod-code">${label}</text>`
    : "";
  const iconMarkup = icon && !label
    ? `<g transform="translate(28,28) scale(1.84)" stroke="${icColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none">${icon}</g>`
    : "";

  if (style === "diamond") {
    // Multi-faceted diamond: pale ice gradient, white facet lines, bright
    // top-left facet, subtle shadow facet, animated shimmer sweep,
    // twinkling sparkles, crisp white border.
    return `
<svg class="hex hex-diamond" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs>
  <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%"   stop-color="#FFFFFF"/>
    <stop offset="35%"  stop-color="#E8F0FF"/>
    <stop offset="60%"  stop-color="#B8D0F0"/>
    <stop offset="100%" stop-color="#7AA0D0"/>
  </linearGradient>
  <linearGradient id="${sid}" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%"   stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="45%"  stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="50%"  stop-color="#FFFFFF" stop-opacity="0.85"/>
    <stop offset="55%"  stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <clipPath id="${cid}"><path d="${hex}"/></clipPath>
</defs>
<!-- Diamond base -->
<path d="${hex}" fill="url(#${gid})"/>
<!-- Bright top-left facet -->
<path d="M50 4 L9 27 L50 50 Z" fill="#FFFFFF" fill-opacity="0.42"/>
<!-- Soft shadow facet bottom-right -->
<path d="M91 73 L50 96 L50 50 Z" fill="#3D6A98" fill-opacity="0.18"/>
<!-- Faint facet lines (crystalline triangulation) -->
<g stroke="#FFFFFF" stroke-width="0.7" stroke-opacity="0.55" fill="none">
  <path d="M50 4 L50 96"/>
  <path d="M9 27 L91 73"/>
  <path d="M91 27 L9 73"/>
</g>
<!-- Animated shimmer sweep -->
<g clip-path="url(#${cid})">
  <rect class="diamond-shimmer" x="-30" y="-10" width="32" height="120" fill="url(#${sid})"/>
</g>
<!-- Crisp white border -->
<path d="${hex}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-opacity="0.95"/>
<!-- Sparkles -->
<g fill="#FFFFFF">
  <circle class="diamond-sparkle s1" cx="32" cy="22" r="1.2"/>
  <circle class="diamond-sparkle s2" cx="72" cy="38" r="0.9"/>
  <circle class="diamond-sparkle s3" cx="28" cy="68" r="0.9"/>
  <circle class="diamond-sparkle s4" cx="68" cy="78" r="1.1"/>
</g>
${iconMarkup}
${labelMarkup}
</svg>`.trim();
  }

  return `
<svg class="hex" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs>
  <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%"  stop-color="${c1}"/>
    <stop offset="100%" stop-color="${c2}"/>
  </linearGradient>
  <linearGradient id="${hid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%"  stop-color="#FFFFFF" stop-opacity="0.35"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
</defs>
<path d="${hex}" fill="${'url(#'+gid+')'}"/>
<path d="${hex}" fill="${'url(#'+hid+')'}"/>
<path d="${hex}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-opacity="0.55"/>
${iconMarkup}
${labelMarkup}
</svg>`.trim();
}

/* Build the certificate as a self-contained SVG string. Used for both the
   on-page rendering and the PNG download. Keep all styling inline so the
   SVG is portable. */
function buildCertificateSVG({ name, pathTitle, dateLabel, certId, issuer }) {
  const W = 1200, H = 760;
  const safe = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, -apple-system, Segoe UI, sans-serif">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%"  stop-color="#FFFFFF"/>
    <stop offset="100%" stop-color="#F3FBF6"/>
  </linearGradient>
  <linearGradient id="ribbon" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%"  stop-color="#00E85B"/>
    <stop offset="100%" stop-color="#00C44C"/>
  </linearGradient>
</defs>

<!-- Card -->
<rect x="0" y="0" width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="24" y="24" width="${W-48}" height="${H-48}" rx="20" ry="20" fill="none" stroke="#17181B" stroke-width="2"/>
<rect x="40" y="40" width="${W-80}" height="${H-80}" rx="14" ry="14" fill="none" stroke="#00E85B" stroke-width="1.5" stroke-dasharray="2 6" opacity="0.55"/>

<!-- Top ribbon accent -->
<rect x="80" y="40" width="6" height="${H-80}" fill="url(#ribbon)" rx="3" ry="3"/>

<!-- Brand mark + wordmark -->
<g transform="translate(140, 110)">
  <rect x="0" y="0" width="48" height="48" rx="10" ry="10" fill="#17181B"/>
  <text x="24" y="34" text-anchor="middle" fill="#00E85B" font-size="28" font-weight="800">Q</text>
  <text x="64" y="22" fill="#17181B" font-size="14" font-weight="700" letter-spacing="0.18em">QARGO</text>
  <text x="64" y="42" fill="#6B7076" font-size="12" font-weight="500" letter-spacing="0.18em">ACADEMY</text>
</g>

<!-- Eyebrow -->
<text x="${W/2}" y="220" text-anchor="middle" fill="#00C44C" font-size="14" font-weight="700" letter-spacing="0.28em">CERTIFICATE OF COMPLETION</text>

<!-- Section divider -->
<line x1="${W/2-50}" y1="246" x2="${W/2+50}" y2="246" stroke="#00E85B" stroke-width="3" stroke-linecap="round"/>

<!-- Subhead -->
<text x="${W/2}" y="298" text-anchor="middle" fill="#6B7076" font-size="18">This is to certify that</text>

<!-- Recipient name -->
<text x="${W/2}" y="380" text-anchor="middle" fill="#17181B" font-size="60" font-weight="800" letter-spacing="-0.01em">${safe(name)}</text>

<!-- Has completed -->
<text x="${W/2}" y="430" text-anchor="middle" fill="#6B7076" font-size="18">has successfully completed the learning path</text>

<!-- Path title -->
<text x="${W/2}" y="500" text-anchor="middle" fill="#17181B" font-size="34" font-weight="700">${safe(pathTitle)}</text>

<!-- Date + issuer line -->
<text x="${W/2}" y="568" text-anchor="middle" fill="#3A3D44" font-size="16">Issued ${safe(dateLabel)} by ${safe(issuer)}</text>

<!-- Footer: signature line + cert id -->
<g transform="translate(140, ${H-130})">
  <line x1="0" y1="40" x2="220" y2="40" stroke="#17181B" stroke-width="1.5"/>
  <text x="0" y="62" fill="#6B7076" font-size="12" letter-spacing="0.12em">AUTHORISED BY QARGO ACADEMY</text>
</g>
<g transform="translate(${W-360}, ${H-130})">
  <text x="0" y="40" fill="#17181B" font-size="13" font-weight="700" letter-spacing="0.12em">CERTIFICATE ID</text>
  <text x="0" y="64" fill="#6B7076" font-size="14" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${safe(certId)}</text>
</g>
</svg>`.trim();
}

function renderBadge() {
  crumbs.innerHTML = `<a href="#/">Catalog</a> &nbsp;/&nbsp; Certificate`;
  app.classList.remove("course-view");
  app.classList.remove("home-view");
  app.classList.remove("blocks-view");
  app.classList.add("badge-view");
  document.body.classList.remove("in-course");

  const learner = getLearner();
  if (!learner || !learner.name) {
    app.innerHTML = `
      <section class="badge-hero">
        <div class="eyebrow">Certificate</div>
        <h1>Tell us who you are first</h1>
        <p>Your certificate is personalised. Add your name on the welcome screen, then come back here.</p>
      </section>
      <p style="margin: 32px 0 0; color: var(--ink-500); font-size: 14px;">
        <a href="#/">&larr; Back to catalog</a>
      </p>
    `;
    return;
  }

  const complete = isPathComplete();
  if (!complete) {
    app.innerHTML = `
      <section class="badge-hero">
        <div class="eyebrow">Certificate</div>
        <h1>Almost there</h1>
        <p>Finish every module in the learning path to unlock your shareable certificate.</p>
      </section>
      <div class="badge-locked">
        <div class="lock-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <h2>Certificate locked</h2>
        <p>Complete the remaining modules in <strong>${escape(LEARNING_PATH.title)}</strong> and your badge will appear here, ready to share on LinkedIn.</p>
        <a class="badge-btn primary" href="#/" style="text-decoration:none;">
          Back to learning path
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </a>
      </div>
    `;
    return;
  }

  // Path is complete — make sure the date + cert ID are stamped, then render.
  setPathCompletedAtIfMissing();
  const completedAtIso = getPathCompletedAt() || new Date().toISOString();
  const completedAt    = new Date(completedAtIso);
  const dateLabel = completedAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const issuer    = "Qargo Academy";
  const pathTitle = LEARNING_PATH.title;
  const certId    = getCertId();
  const svg       = buildCertificateSVG({ name: learner.name, pathTitle, dateLabel, certId, issuer });

  // LinkedIn "Add to Profile" prefill URL. Reference:
  // https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/add-to-profile
  const certUrl = location.origin + location.pathname + "#/badge";
  const linkedInUrl = "https://www.linkedin.com/profile/add?" + new URLSearchParams({
    startTask: "CERTIFICATION_NAME",
    name: pathTitle,
    organizationName: "Qargo",
    issueYear: String(completedAt.getFullYear()),
    issueMonth: String(completedAt.getMonth() + 1),
    certUrl,
    certId,
  }).toString();

  app.innerHTML = `
    <section class="badge-hero">
      <div class="eyebrow">Path completed</div>
      <h1>Nice work, ${escape(learner.name.split(/\s+/)[0])}.</h1>
      <p>Here is your shareable certificate for <strong>${escape(pathTitle)}</strong>. Add it to your LinkedIn profile in two clicks, or download a PNG for your records.</p>
    </section>

    <div class="cert-stage" id="cert-stage">${svg}</div>

    <div class="badge-actions">
      <a class="badge-btn linkedin" href="${linkedInUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/></svg>
        Add to LinkedIn profile
      </a>
      <button class="badge-btn primary" type="button" id="cert-download">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download as PNG
      </button>
      <button class="badge-btn ghost" type="button" id="cert-copy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy share link
      </button>
    </div>

    <p class="badge-meta">
      Certificate ID <code>${escape(certId)}</code> &nbsp;·&nbsp; Issued ${escape(dateLabel)} by ${escape(issuer)}
    </p>
    <p style="text-align:center; margin: 24px 0 0; color: var(--ink-500); font-size: 13px;">
      <a href="#/">&larr; Back to catalog</a>
    </p>
  `;

  // Wire up Download as PNG. Render the SVG to a 2x canvas for a crisp file.
  document.getElementById("cert-download").addEventListener("click", () => {
    const stage = document.getElementById("cert-stage");
    const svgEl = stage.querySelector("svg");
    if (!svgEl) return;
    const xml = new XMLSerializer().serializeToString(svgEl);
    const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width  = 1200 * scale;
      canvas.height = 760  * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        if (!blob) return;
        const dl = URL.createObjectURL(blob);
        const a  = document.createElement("a");
        a.href = dl;
        a.download = `qargo-academy-certificate-${certId}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(dl), 1000);
        toast("Certificate downloaded");
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast("Download failed — try again");
    };
    img.src = url;
  });

  // Copy share link.
  document.getElementById("cert-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(certUrl);
      toast("Link copied to clipboard");
    } catch {
      toast("Copy failed — your browser blocked it");
    }
  });
}

/* =========================================================================
   BLOCK RENDERERS
   ========================================================================= */
function renderBlock(el, block, markDone, ctx) {
  el.classList.add(`block-type-${block.type || "unknown"}`);
  switch (block.type) {
    case "text":       return renderText(el, block, markDone);
    case "accordion":  return renderAccordion(el, block, markDone);
    case "summary":    return renderSummary(el, block, markDone);
    case "quiz":       return renderQuiz(el, block, markDone);
    case "flashcards": return renderFlashcards(el, block, markDone);
    case "flipcard":   return renderFlashcards(el, block, markDone);
    case "match":      return renderMatch(el, block, markDone);
    case "embed":      return renderEmbed(el, block, markDone);
    case "image":      return renderImage(el, block, markDone);
    case "carousel":   return renderCarousel(el, block, markDone);
    case "fillblanks": return renderFillBlanks(el, block, markDone);
    case "process":    return renderProcess(el, block, markDone);
    case "timeline":   return renderTimeline(el, block, markDone);
    case "milestone":  return renderMilestone(el, block, markDone);
    case "tutor":      return renderTutor(el, block, markDone, ctx);
    default:
      el.innerHTML = `<span class="kind">unknown</span><p>Unknown block type: ${escape(block.type)}</p>`;
  }
}

/* Lesson context helper — pulls plain-text content from the lesson's
   text/summary blocks so the AI tutor can ground its answers. Cached on
   the lesson object so we don't re-stringify on every call. */
function buildLessonContext(lesson) {
  if (!lesson) return { title: "", body: "" };
  if (lesson._ctx) return lesson._ctx;
  const parts = [];
  (lesson.blocks || []).forEach(b => {
    if (b.type === "text") {
      if (b.title) parts.push(b.title);
      if (b.lead)  parts.push(b.lead);
      if (b.body)  parts.push(b.body);
    } else if (b.type === "summary") {
      if (b.title) parts.push(b.title);
      if (Array.isArray(b.points)) parts.push(b.points.join(". "));
    } else if (b.type === "accordion") {
      (b.items || []).forEach(it => parts.push(`${it.q || ""}: ${it.a || ""}`));
    } else if (b.type === "process") {
      (b.steps || []).forEach(s => parts.push(`${s.title || ""}: ${s.body || ""}`));
    } else if (b.type === "timeline") {
      (b.events || []).forEach(e => parts.push(`${e.date || ""} — ${e.title || ""}: ${e.body || ""}`));
    }
  });
  lesson._ctx = { title: lesson.title || "", body: parts.join("\n\n").slice(0, 4000) };
  return lesson._ctx;
}

function renderText(el, block, markDone) {
  el.innerHTML = `
    <span class="kind">Article</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <div class="prose">
      ${block.lead ? `<p class="lead-p">${escape(block.lead)}</p>` : ""}
      <p>${escape(block.body)}</p>
    </div>
  `;
  // Reading lessons count as done on render — we assume the user read it.
  markDone();
}

function renderAccordion(el, block, markDone) {
  el.classList.add("accordion-block");
  const items = Array.isArray(block.items) ? block.items : [];
  el.innerHTML = `
    <span class="kind">Accordion</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    ${block.intro ? `<p class="hint">${escape(block.intro)}</p>` : ""}
    <div class="accordion">
      ${items.map((it, i) => `
        <div class="acc-row" data-idx="${i}">
          <button class="acc-head" type="button" aria-expanded="false">
            <span class="acc-q">${escape(it.q)}</span>
            <svg class="acc-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="acc-body" hidden><p>${escape(it.a)}</p></div>
        </div>
      `).join("")}
    </div>
  `;
  const rows = Array.from(el.querySelectorAll(".acc-row"));
  const opened = new Set();
  rows.forEach(row => {
    const head = row.querySelector(".acc-head");
    const body = row.querySelector(".acc-body");
    head.addEventListener("click", () => {
      const isOpen = row.classList.toggle("open");
      head.setAttribute("aria-expanded", isOpen ? "true" : "false");
      body.hidden = !isOpen;
      if (isOpen) {
        opened.add(row.dataset.idx);
        if (opened.size >= rows.length) markDone();
      }
    });
  });
  if (!rows.length) markDone();
}

function renderSummary(el, block, markDone) {
  el.classList.add("summary-block");
  const points = Array.isArray(block.points) ? block.points : [];
  el.innerHTML = `
    <span class="kind">In summary</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <ul class="summary-points">
      ${points.map(p => `<li>${escape(p)}</li>`).join("")}
    </ul>
  `;
  markDone();
}

/*
 * Embed block — renders an iframe (Storylane demo, YouTube, virtual env, etc.)
 *
 * Config shape:
 *   {
 *     type: "embed",
 *     title: "Try the demo",           // optional
 *     kind:  "Interactive demo",       // optional pill label; defaults to "Embed"
 *     url:   "https://app.storylane.io/demo/abc123",  // required — must be https
 *     ratio: "16/9",                   // optional; any CSS aspect-ratio value; default "16/9"
 *     height: 520,                     // optional — fixed px height; if set, overrides ratio
 *     caption: "Finish the flow, then mark complete.",  // optional
 *     allow:  "fullscreen; clipboard-write",            // optional; sensible defaults applied
 *     autoComplete: false              // if true, block is marked done on render instead of on button click
 *   }
 */
function renderEmbed(el, block, markDone) {
  el.classList.add("embed");
  const url = String(block.url || "");
  const safeUrl = /^https:\/\//i.test(url) ? url : "";
  const kind = escape(block.kind || "Embed");
  const ratio = escape(block.ratio || "16 / 9");
  // Superset of what Storylane, Clueso, YouTube, Vimeo, Loom, Arcade, etc. expect.
  // Individual blocks can override via block.allow.
  const allow = escape(block.allow || "accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture");
  const frameStyle = block.height
    ? `height: ${Number(block.height)}px;`
    : `aspect-ratio: ${ratio};`;

  el.innerHTML = `
    <span class="kind">${kind}</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    ${safeUrl ? `
      <div class="frame" style="${frameStyle}">
        <iframe
          src="${safeUrl}"
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="${allow}"
          allowfullscreen></iframe>
      </div>
      ${block.caption ? `<p class="caption">${escape(block.caption)}</p>` : ""}
      <div class="done-row">
        <button class="done-btn" type="button">Mark as complete</button>
        <a class="open-new" href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
      </div>
    ` : `<p class="caption">Embed is missing a valid https:// URL.</p>`}
  `;

  if (!safeUrl) { markDone(); return; }

  if (block.autoComplete) {
    markDone();
    const btn = el.querySelector(".done-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Completed"; }
    return;
  }

  const btn = el.querySelector(".done-btn");
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Completed";
    markDone();
  });
}

function renderQuiz(el, block, markDone) {
  el.classList.add("quiz");
  // Build a unique name so multiple quizzes on a page don't share radios.
  const groupName = "quiz-" + Math.random().toString(36).slice(2, 9);
  const optionsHtml = block.options.map((opt, i) => `
    <label class="opt" data-idx="${i}">
      <input type="radio" name="${groupName}" value="${i}" />
      <span class="radio-dot"></span>
      <span class="opt-text">${escape(opt)}</span>
    </label>
  `).join("");
  el.innerHTML = `
    <span class="kind">Quiz</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <p class="quiz-question">${escape(block.question)}</p>
    <form class="options" novalidate>
      ${optionsHtml}
    </form>
    <div class="quiz-actions">
      <button type="button" class="submit-btn" disabled>Submit answer</button>
    </div>
    <div class="feedback" hidden></div>
  `;
  const opts = el.querySelector(".options");
  const fb = el.querySelector(".feedback");
  const submitBtn = el.querySelector(".submit-btn");
  const labels = Array.from(opts.querySelectorAll(".opt"));
  const inputs = labels.map(l => l.querySelector("input"));

  // Enable submit once the learner picks something; highlight the selected row.
  inputs.forEach((inp, i) => {
    inp.addEventListener("change", () => {
      submitBtn.disabled = false;
      labels.forEach(l => l.classList.remove("selected"));
      labels[i].classList.add("selected");
    });
  });

  submitBtn.addEventListener("click", () => {
    const chosen = inputs.findIndex(inp => inp.checked);
    if (chosen < 0) return;
    const isRight = chosen === block.correct;
    // Lock further interaction once submitted.
    inputs.forEach(inp => { inp.disabled = true; });
    labels.forEach(l => l.classList.add("locked"));
    labels[chosen].classList.add(isRight ? "correct" : "wrong");
    if (!isRight) labels[block.correct].classList.add("correct");
    submitBtn.disabled = true;
    submitBtn.textContent = isRight ? "Correct" : "Answer locked";
    fb.hidden = false;
    fb.className = "feedback " + (isRight ? "good" : "bad");
    fb.textContent = (isRight ? "Correct. " : "Not quite. ") + (block.explanation || "");
    markDone();
  });
}

function renderFlashcards(el, block, markDone) {
  el.innerHTML = `
    <span class="kind">Flashcards</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <p class="hint">Click a card to flip it.</p>
    <div class="flash"><div class="deck"></div></div>
  `;
  const deck = el.querySelector(".deck");
  let flipped = 0;
  block.cards.forEach((c, i) => {
    const wrap = document.createElement("div");
    wrap.className = "card-flip";
    wrap.innerHTML = `
      <div class="face front">${escape(c.front)}</div>
      <div class="face back">${escape(c.back)}</div>
    `;
    wrap.addEventListener("click", () => {
      const was = wrap.classList.contains("flipped");
      wrap.classList.toggle("flipped");
      if (!was) {
        flipped++;
        if (flipped >= Math.ceil(block.cards.length / 2)) markDone();
      }
    });
    deck.appendChild(wrap);
  });
}

function renderMatch(el, block, markDone) {
  el.innerHTML = `
    <span class="kind">Match</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <p class="hint">Drag a term from the left onto the matching definition on the right.</p>
    <div class="match">
      <div class="lanes">
        <div>
          <h4>Terms</h4>
          <div class="pool"></div>
        </div>
        <div>
          <h4>Definitions</h4>
          <div class="targets"></div>
        </div>
      </div>
      <div class="actions">
        <button class="primary" data-act="check">Check</button>
        <button class="ghost" data-act="reset">Reset</button>
      </div>
      <div class="feedback" hidden></div>
    </div>
  `;
  const pool = el.querySelector(".pool");
  const targets = el.querySelector(".targets");
  const fb = el.querySelector(".feedback");

  // shuffle both sides
  const shuffle = a => a.map(v => [Math.random(), v]).sort((x,y)=>x[0]-y[0]).map(x=>x[1]);
  const terms = shuffle(block.pairs.map((p, idx) => ({ text: p.term, idx })));
  const defs  = shuffle(block.pairs.map((p, idx) => ({ text: p.definition, idx })));

  function makeChip(t) {
    const c = document.createElement("div");
    c.className = "chip";
    c.draggable = true;
    c.textContent = t.text;
    c.dataset.idx = t.idx;
    c.addEventListener("dragstart", e => {
      c.classList.add("dragging");
      e.dataTransfer.setData("text/plain", t.idx);
      e.dataTransfer.effectAllowed = "move";
    });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
    return c;
  }

  terms.forEach(t => pool.appendChild(makeChip(t)));

  defs.forEach(d => {
    const row = document.createElement("div");
    row.className = "target";
    row.dataset.idx = d.idx;
    row.innerHTML = `<span class="label">${escape(d.text)}</span><span class="drop-slot"></span>`;
    const slot = row.querySelector(".drop-slot");
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("over"); });
    row.addEventListener("dragleave", () => row.classList.remove("over"));
    row.addEventListener("drop", e => {
      e.preventDefault();
      row.classList.remove("over");
      const idx = e.dataTransfer.getData("text/plain");
      // if slot already filled, return previous chip to the pool
      if (slot.firstChild) pool.appendChild(slot.firstChild);
      const chip = document.querySelector(`.chip[data-idx="${idx}"]`);
      if (chip) slot.appendChild(chip);
    });
    targets.appendChild(row);
  });

  el.querySelector('[data-act="check"]').addEventListener("click", () => {
    let correct = 0, total = block.pairs.length;
    targets.querySelectorAll(".target").forEach(row => {
      const chip = row.querySelector(".chip");
      row.classList.remove("correct", "wrong");
      if (chip && chip.dataset.idx === row.dataset.idx) {
        row.classList.add("correct"); correct++;
      } else if (chip) {
        row.classList.add("wrong");
      }
    });
    fb.hidden = false;
    fb.className = "feedback " + (correct === total ? "good" : "bad");
    fb.textContent = `${correct} / ${total} correct.` + (correct === total ? " Nice work." : " Try again.");
    if (correct === total) markDone();
  });

  el.querySelector('[data-act="reset"]').addEventListener("click", () => {
    targets.querySelectorAll(".target").forEach(row => {
      row.classList.remove("correct", "wrong");
      const chip = row.querySelector(".chip");
      if (chip) pool.appendChild(chip);
    });
    fb.hidden = true;
  });
}

/*
 * Image block — single image with optional caption.
 *
 * Config shape:
 *   { type: "image", src, alt?, caption?, title? }
 *
 * Marks done on render (presentation block).
 */
function renderImage(el, block, markDone) {
  el.classList.add("image-block");
  const src = String(block.src || "");
  const alt = escape(block.alt || "");
  el.innerHTML = `
    <span class="kind">Image</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    ${src ? `
      <div class="img-wrap">
        <img src="${escape(src)}" alt="${alt}" loading="lazy" />
      </div>
      ${block.caption ? `<p class="caption">${escape(block.caption)}</p>` : ""}
    ` : `<p class="caption">Image is missing a src.</p>`}
  `;
  markDone();
}

/*
 * Carousel block — set of slides the learner pages through.
 *
 * Config shape:
 *   {
 *     type: "carousel",
 *     title?,
 *     slides: [{ src, alt?, caption? }, ...]
 *   }
 *
 * Marks done once every slide has been viewed at least once.
 */
function renderCarousel(el, block, markDone) {
  el.classList.add("carousel-block");
  const slides = Array.isArray(block.slides) ? block.slides : [];
  if (!slides.length) {
    el.innerHTML = `<span class="kind">Carousel</span><p class="caption">Carousel has no slides.</p>`;
    markDone();
    return;
  }
  el.innerHTML = `
    <span class="kind">Carousel</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <div class="car-frame">
      <div class="car-track">
        ${slides.map(s => `
          <div class="car-slide">
            <img src="${escape(s.src || "")}" alt="${escape(s.alt || "")}" loading="lazy" />
            ${s.caption ? `<div class="car-cap">${escape(s.caption)}</div>` : ""}
          </div>
        `).join("")}
      </div>
      <button type="button" class="car-nav prev" aria-label="Previous slide">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <button type="button" class="car-nav next" aria-label="Next slide">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    </div>
    <div class="car-dots">
      ${slides.map((_, i) => `<button type="button" class="car-dot${i===0?" active":""}" data-idx="${i}" aria-label="Go to slide ${i+1}"></button>`).join("")}
    </div>
    <div class="car-progress">Slide 1 of ${slides.length}</div>
  `;
  const track = el.querySelector(".car-track");
  const dots  = Array.from(el.querySelectorAll(".car-dot"));
  const prev  = el.querySelector(".car-nav.prev");
  const next  = el.querySelector(".car-nav.next");
  const progress = el.querySelector(".car-progress");
  let idx = 0;
  const seen = new Set([0]);
  function go(i) {
    idx = Math.max(0, Math.min(slides.length - 1, i));
    track.style.transform = `translateX(-${idx * 100}%)`;
    dots.forEach((d, di) => d.classList.toggle("active", di === idx));
    prev.disabled = idx === 0;
    next.disabled = idx === slides.length - 1;
    progress.textContent = `Slide ${idx + 1} of ${slides.length}`;
    seen.add(idx);
    if (seen.size >= slides.length) markDone();
  }
  prev.addEventListener("click", () => go(idx - 1));
  next.addEventListener("click", () => go(idx + 1));
  dots.forEach(d => d.addEventListener("click", () => go(Number(d.dataset.idx))));
  el.tabIndex = 0;
  el.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft")  { e.preventDefault(); go(idx - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
  });
  go(0);
  if (slides.length === 1) markDone();
}

/*
 * Fill-in-the-blanks block — paragraph with `{answer}` tokens.
 *
 * Config shape:
 *   {
 *     type: "fillblanks",
 *     title?,
 *     prompt?: "Fill the gaps below.",
 *     text:    "The four core objects in Qargo are {orders}, {trips}, {invoices}, and {assets}.",
 *     caseSensitive?: false
 *   }
 *
 * Marks done when every blank is correct, or after the learner reveals answers.
 */
function renderFillBlanks(el, block, markDone) {
  el.classList.add("fillblanks-block");
  const raw  = String(block.text || "");
  const tokens = [];
  // Split on {answer} tokens, recording answer order.
  const html = raw.replace(/\{([^}]+)\}/g, (_m, ans) => {
    const i = tokens.length;
    tokens.push(ans);
    return `<input class="blank" data-idx="${i}" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Blank ${i+1}" />`;
  });
  el.innerHTML = `
    <span class="kind">Fill in the blanks</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    ${block.prompt ? `<p class="hint">${escape(block.prompt)}</p>` : ""}
    <p class="fill-text">${html || escape("(no text provided)")}</p>
    <div class="fill-actions">
      <button type="button" class="primary" data-act="check">Check answers</button>
      <button type="button" class="ghost"   data-act="reveal">Reveal</button>
      <span class="fill-feedback" hidden></span>
    </div>
  `;
  if (!tokens.length) { markDone(); return; }
  const inputs = Array.from(el.querySelectorAll("input.blank"));
  const fb     = el.querySelector(".fill-feedback");
  const cs     = !!block.caseSensitive;
  const norm   = s => cs ? String(s).trim() : String(s).trim().toLowerCase();

  function check() {
    let correct = 0;
    inputs.forEach((inp, i) => {
      inp.classList.remove("correct", "wrong");
      if (norm(inp.value) === norm(tokens[i])) {
        inp.classList.add("correct"); correct++;
      } else if (inp.value.trim()) {
        inp.classList.add("wrong");
      }
    });
    fb.hidden = false;
    fb.className = "fill-feedback " + (correct === tokens.length ? "good" : "bad");
    fb.textContent = `${correct} / ${tokens.length} correct.` + (correct === tokens.length ? " Nicely done." : "");
    if (correct === tokens.length) markDone();
  }
  function reveal() {
    inputs.forEach((inp, i) => {
      inp.value = tokens[i];
      inp.classList.remove("wrong");
      inp.classList.add("correct");
      inp.disabled = true;
    });
    fb.hidden = false;
    fb.className = "fill-feedback";
    fb.textContent = "Answers revealed.";
    markDone();
  }
  el.querySelector('[data-act="check"]').addEventListener("click", check);
  el.querySelector('[data-act="reveal"]').addEventListener("click", reveal);
  inputs.forEach(inp => {
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); check(); } });
  });
}

/*
 * Process steps block — vertical numbered stepper.
 *
 * Config shape:
 *   {
 *     type: "process",
 *     title?,
 *     steps: [{ title, body }, ...]
 *   }
 *
 * Marks done when every step has been opened (same as accordion).
 */
function renderProcess(el, block, markDone) {
  el.classList.add("process-block");
  const steps = Array.isArray(block.steps) ? block.steps : [];
  el.innerHTML = `
    <span class="kind">Process</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    ${block.intro ? `<p class="hint">${escape(block.intro)}</p>` : ""}
    <div class="steps">
      ${steps.map((s, i) => `
        <div class="step" data-idx="${i}">
          <span class="step-num">${i + 1}</span>
          <span class="step-title">${escape(s.title || `Step ${i+1}`)}</span>
          <span class="step-toggle" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </span>
          <div class="step-body">${escape(s.body || "")}</div>
        </div>
      `).join("")}
    </div>
  `;
  const rows = Array.from(el.querySelectorAll(".step"));
  const opened = new Set();
  rows.forEach(row => {
    row.addEventListener("click", () => {
      const isOpen = row.classList.toggle("open");
      if (isOpen) {
        opened.add(row.dataset.idx);
        if (opened.size >= rows.length) markDone();
      }
    });
  });
  if (!rows.length) markDone();
}

/*
 * Timeline block — vertical timeline of events.
 *
 * Config shape:
 *   {
 *     type: "timeline",
 *     title?,
 *     events: [{ date, title, body }, ...]
 *   }
 *
 * Marks done on render. IntersectionObserver fades each event in.
 */
function renderTimeline(el, block, markDone) {
  el.classList.add("timeline-block");
  const events = Array.isArray(block.events) ? block.events : [];
  el.innerHTML = `
    <span class="kind">Timeline</span>
    ${block.title ? `<h3>${escape(block.title)}</h3>` : ""}
    <div class="tl">
      ${events.map(ev => `
        <article class="tl-event">
          ${ev.date  ? `<div class="tl-date">${escape(ev.date)}</div>` : ""}
          ${ev.title ? `<h4 class="tl-title">${escape(ev.title)}</h4>` : ""}
          ${ev.body  ? `<p class="tl-body">${escape(ev.body)}</p>` : ""}
        </article>
      `).join("")}
    </div>
  `;
  const items = Array.from(el.querySelectorAll(".tl-event"));
  if (items.length && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.15 });
    items.forEach(i => io.observe(i));
  } else {
    items.forEach(i => i.classList.add("in"));
  }
  markDone();
}

/*
 * Milestone celebration block — congratulatory marker between key sections.
 *
 * Config shape:
 *   {
 *     type: "milestone",
 *     headline?: "Halfway there",
 *     message?:  "You've finished the foundations. Time to tackle dispatch.",
 *     cta?:      "Keep going"
 *   }
 *
 * Confetti burst fires once when the block scrolls into view. Marks done
 * when the learner clicks the CTA.
 */
function renderMilestone(el, block, markDone) {
  el.classList.add("milestone-block");
  el.innerHTML = `
    <canvas class="ms-confetti"></canvas>
    <span class="kind">Milestone</span>
    <div class="ms-badge" aria-hidden="true">👍</div>
    <h3 class="ms-headline">${escape(block.headline || "Milestone reached")}</h3>
    <p class="ms-sub">${escape(block.message || "Take a moment to reflect on what you've learned, then keep going.")}</p>
    <button type="button" class="ms-cta">${escape(block.cta || "Keep going")}</button>
  `;
  const cta = el.querySelector(".ms-cta");
  cta.addEventListener("click", () => {
    cta.disabled = true;
    cta.textContent = "Completed";
    markDone();
  });

  // Confetti — single burst when the milestone enters the viewport.
  const canvas = el.querySelector(".ms-confetti");
  let bursted = false;
  function burst() {
    if (bursted) return;
    bursted = true;
    const ctx = canvas.getContext("2d");
    const rect = el.getBoundingClientRect();
    canvas.width  = rect.width;
    canvas.height = rect.height;
    const colors = ["#00E85B", "#00C44C", "#BDF8D0", "#FFFFFF", "#FFC43D"];
    const particles = Array.from({ length: 90 }, () => ({
      x: rect.width / 2 + (Math.random() - 0.5) * 80,
      y: rect.height / 2 + (Math.random() - 0.5) * 30,
      vx: (Math.random() - 0.5) * 9,
      vy: -Math.random() * 11 - 3,
      g: 0.32 + Math.random() * 0.12,
      size: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 0,
    }));
    let frames = 0;
    function tick() {
      frames++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = 0;
      particles.forEach(p => {
        p.vy += p.g;
        p.x  += p.vx;
        p.y  += p.vy;
        p.rot += p.vr;
        p.life++;
        if (p.y < canvas.height + 20 && p.life < 220) alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size * 0.6);
        ctx.restore();
      });
      if (alive > 0 && frames < 240) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    tick();
  }
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(e => {
        if (e.isIntersecting) { burst(); obs.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    io.observe(el);
  } else {
    burst();
  }
}

/* =========================================================================
   AI TUTOR
   Lesson-aware chat block. Reads the learner's OpenAI API key from
   localStorage (LS_TUTOR_KEY). On first use, prompts for the key.

   IMPORTANT: this client-side approach is fine for personal use or a
   hosting setup behind a proxy that strips the key. For a public/static
   deploy (e.g. GitHub Pages) where the key would be shared across users,
   replace `callOpenAI()` with a call to a backend proxy that injects the
   key server-side. Search this file for `OPENAI_PROXY_URL` to swap.
   ========================================================================= */
const LS_TUTOR_KEY = "academy.openai_key";
const OPENAI_PROXY_URL = ""; // set this to a proxy URL to use a shared key safely

function getTutorKey() { return localStorage.getItem(LS_TUTOR_KEY) || ""; }
function setTutorKey(k) {
  if (k) localStorage.setItem(LS_TUTOR_KEY, k);
  else localStorage.removeItem(LS_TUTOR_KEY);
}

async function callOpenAI(messages) {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.4,
    max_tokens: 600,
  });
  if (OPENAI_PROXY_URL) {
    const r = await fetch(OPENAI_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!r.ok) throw new Error(`Proxy error ${r.status}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  }
  const key = getTutorKey();
  if (!key) throw new Error("No API key configured.");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenAI error ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function renderTutor(el, block, markDone, ctx) {
  el.classList.add("tutor-block");
  const lessonTitle = ctx?.lesson?.title || block.contextTitle || "this lesson";
  const lessonBody  = ctx?.lesson?.body  || block.contextBody  || "";
  const courseTitle = ctx?.course?.title || "Qargo Academy";
  const suggestions = Array.isArray(block.suggestions) && block.suggestions.length
    ? block.suggestions
    : [
        "Summarise this lesson in three bullets.",
        "What's a question I might be asked about this?",
        "Give me a real-world example.",
      ];

  el.innerHTML = `
    <div class="tutor-head">
      <div class="tutor-avatar" aria-hidden="true">AI</div>
      <div class="tutor-meta">
        <div class="tutor-name">${escape(block.title || "Tutor")}</div>
        <div class="tutor-status">${escape(block.subtitle || `Ask about: ${lessonTitle}`)}</div>
      </div>
      <button type="button" class="tutor-cog" aria-label="Tutor settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
    <div class="tutor-key-form" hidden>
      <p><strong>Add your OpenAI API key</strong> to enable the tutor. The key is stored only in this browser. For shared/remote use, route requests through a small backend proxy instead.</p>
      <input type="password" placeholder="sk-..." autocomplete="off" />
      <div class="key-actions">
        <button type="button" class="primary" data-act="save-key">Save</button>
        <button type="button" class="ghost"   data-act="clear-key">Clear</button>
      </div>
    </div>
    <div class="tutor-suggest">
      ${suggestions.map(s => `<button type="button" class="tutor-chip">${escape(s)}</button>`).join("")}
    </div>
    <div class="tutor-log" aria-live="polite"></div>
    <div class="tutor-input">
      <textarea placeholder="Ask anything about this lesson..." rows="1"></textarea>
      <button type="button" class="tutor-send">Send</button>
    </div>
  `;

  const log    = el.querySelector(".tutor-log");
  const ta     = el.querySelector("textarea");
  const send   = el.querySelector(".tutor-send");
  const cog    = el.querySelector(".tutor-cog");
  const keyForm  = el.querySelector(".tutor-key-form");
  const keyInput = keyForm.querySelector("input");
  const chips    = el.querySelectorAll(".tutor-chip");

  const history = [
    { role: "system", content:
      `You are a concise, friendly tutor for ${courseTitle}.
Answer questions grounded in the lesson context below. If a question goes outside the lesson, gently bring it back.
Keep answers under 120 words unless the learner asks for more.

Lesson title: ${lessonTitle}
Lesson context:
${lessonBody || "(no additional context provided)"}`
    }
  ];

  function appendMsg(role, text) {
    const div = document.createElement("div");
    div.className = `tutor-msg ${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }
  function appendSystem(text) { return appendMsg("system", text); }
  function appendError(text)  { return appendMsg("error", text); }
  function showTyping() {
    const div = document.createElement("div");
    div.className = "tutor-typing";
    div.innerHTML = `<span></span><span></span><span></span>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function ensureKey() {
    if (OPENAI_PROXY_URL) return true;
    if (getTutorKey()) return true;
    keyForm.hidden = false;
    keyInput.focus();
    return false;
  }

  cog.addEventListener("click", () => {
    keyForm.hidden = !keyForm.hidden;
    if (!keyForm.hidden) {
      keyInput.value = getTutorKey();
      keyInput.focus();
    }
  });
  keyForm.querySelector('[data-act="save-key"]').addEventListener("click", () => {
    const k = keyInput.value.trim();
    if (!k) return;
    setTutorKey(k);
    keyForm.hidden = true;
    appendSystem("API key saved to this browser.");
  });
  keyForm.querySelector('[data-act="clear-key"]').addEventListener("click", () => {
    setTutorKey("");
    keyInput.value = "";
    appendSystem("API key cleared.");
  });

  async function ask(question) {
    if (!question) return;
    if (!ensureKey()) return;
    appendMsg("user", question);
    ta.value = "";
    ta.style.height = "auto";
    send.disabled = true;
    const typing = showTyping();
    history.push({ role: "user", content: question });
    try {
      const reply = await callOpenAI(history);
      typing.remove();
      appendMsg("assistant", reply || "(empty response)");
      history.push({ role: "assistant", content: reply });
      markDone();
    } catch (err) {
      typing.remove();
      appendError(`Tutor error: ${err.message || err}`);
      history.pop();
    } finally {
      send.disabled = false;
      ta.focus();
    }
  }

  chips.forEach(c => c.addEventListener("click", () => ask(c.textContent)));
  send.addEventListener("click", () => ask(ta.value.trim()));
  ta.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(ta.value.trim());
    }
  });
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(140, ta.scrollHeight) + "px";
  });

  if (!OPENAI_PROXY_URL && !getTutorKey()) {
    appendSystem("Click the cog to add your OpenAI API key, then ask anything about this lesson.");
  } else {
    appendSystem(`Hi. I'm primed on "${lessonTitle}". What would you like to dig into?`);
  }
}

/* =========================================================================
   UTILITIES
   ========================================================================= */
function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

renderMe();
// Fire a raw page_view immediately on every load — no identity required.
// This gives a full visit count including first-time visitors who haven't
// completed the identity modal yet.
reportPageView();
const _l = getLearner();
// Fire one session_start per page load. For new learners, fire after the
// identity modal submits so the Worker has name/email/role to upsert.
// For returning learners, fire immediately. Each call also refreshes
// Country (from Cloudflare's request.cf) and bumps Login count.
const startSession = () => { try { reportSessionStart(); } catch (e) {} };

/* =========================================================================
   NOTIFICATIONS
   The header bell opens a popover listing categorised notifications. Three
   categories, each with its own icon and accent colour so a learner can
   tell at a glance what kind of update they are looking at:

     feature   - "New feature" updates to the Academy / Worker / platform
     academy   - Course content updates (new modules, paths, internal track)
     general   - Everything else (maintenance, holidays, policy changes)

   Notifications are defined inline below. To add a new one, push an object
   to NOTIFICATIONS with a stable unique id, a category, a short title,
   a one-line message, an ISO date, and an optional link (hash route or
   external URL). Newest first by `at` field; the renderer sorts so order
   in the array does not matter.

   Read state persists in localStorage under LS_NOTIFICATIONS_READ as an
   array of read ids. An unread count badge sits on the bell while there
   are unread items; opening the popover does not auto-mark, but clicking
   an individual notification does. Mark-all-read button clears the badge
   without forcing the user to click each item. */

const NOTIFICATIONS = [
  {
    id: "feature-sample-1",
    category: "feature",
    title: "Sample feature update",
    message: "This is example copy for a feature notification. Edit or remove it by changing the NOTIFICATIONS array in app.js when you have a real announcement to make.",
    at: "2026-05-02",
    link: null,
  },
  {
    id: "academy-2026-04-30-internal-track",
    category: "academy",
    title: "Internal track is live",
    message: "Qargo staff can now access the Look-and-Feel module behind the shared password. Pick the Internal role in your profile to unlock it.",
    at: "2026-04-30",
    link: "#/",
  },
];

const LS_NOTIFICATIONS_READ = "academy.notifications_read";

const NOTIFICATION_CATEGORIES = {
  feature: {
    label: "New feature",
    /* lightning bolt — "what's new" energy */
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
    className: "cat-feature",
  },
  academy: {
    label: "Academy update",
    /* graduation cap — content/curriculum */
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></svg>`,
    className: "cat-academy",
  },
  general: {
    label: "Notice",
    /* info circle — neutral */
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
    className: "cat-general",
  },
};

function getReadNotifications() {
  try {
    const raw = localStorage.getItem(LS_NOTIFICATIONS_READ);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function markNotificationRead(id) {
  try {
    const read = getReadNotifications();
    read.add(id);
    localStorage.setItem(LS_NOTIFICATIONS_READ, JSON.stringify([...read]));
  } catch (e) { /* localStorage unavailable, non-fatal */ }
}
function markAllNotificationsRead() {
  try {
    localStorage.setItem(
      LS_NOTIFICATIONS_READ,
      JSON.stringify(NOTIFICATIONS.map(n => n.id)),
    );
  } catch (e) {}
}

function unreadNotificationCount() {
  const read = getReadNotifications();
  return NOTIFICATIONS.filter(n => !read.has(n.id)).length;
}

function renderNotificationsBadge() {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  const count = unreadNotificationCount();
  if (count === 0) {
    badge.hidden = true;
    badge.textContent = "";
  } else {
    badge.hidden = false;
    badge.textContent = count > 9 ? "9+" : String(count);
  }
}

/* Relative-time formatter: "today", "yesterday", "3 days ago", "2 weeks
   ago", "Apr 12". Stays short so it fits the popover meta line. */
function formatRelativeDate(iso) {
  const then = new Date(iso);
  if (isNaN(then.getTime())) return iso;
  const now = new Date();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderNotificationsPopover() {
  const existing = document.getElementById("notif-popover");
  if (existing) existing.remove();
  const read = getReadNotifications();
  const items = [...NOTIFICATIONS].sort((a, b) => (b.at > a.at ? 1 : -1));
  const pop = document.createElement("div");
  pop.id = "notif-popover";
  pop.className = "notif-popover";
  pop.setAttribute("role", "menu");
  pop.innerHTML = `
    <div class="notif-popover-header">
      <span class="title">Notifications</span>
      <button type="button" class="link" id="notif-mark-all" ${unreadNotificationCount() === 0 ? "hidden" : ""}>Mark all as read</button>
    </div>
    <div class="notif-list">
      ${items.length === 0 ? `<div class="notif-empty">Nothing new right now.</div>` : items.map(n => {
        const cat = NOTIFICATION_CATEGORIES[n.category] || NOTIFICATION_CATEGORIES.general;
        const isUnread = !read.has(n.id);
        const tag = n.link ? "a" : "div";
        const linkAttrs = n.link
          ? `href="${escape(n.link)}"${n.link.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}`
          : "";
        return `
          <${tag} class="notif-item ${cat.className}${isUnread ? " unread" : ""}" data-notif-id="${escape(n.id)}" ${linkAttrs}>
            <span class="notif-icon" aria-hidden="true">${cat.icon}</span>
            <div class="notif-body">
              <div class="notif-meta">
                <span class="notif-cat">${escape(cat.label)}</span>
                <span class="notif-dot" aria-hidden="true">·</span>
                <span class="notif-time">${escape(formatRelativeDate(n.at))}</span>
              </div>
              <div class="notif-title">${escape(n.title)}</div>
              <div class="notif-message">${escape(n.message)}</div>
            </div>
            ${isUnread ? `<span class="notif-unread-dot" aria-label="Unread"></span>` : ""}
          </${tag}>
        `;
      }).join("")}
    </div>
  `;
  document.body.appendChild(pop);

  /* Position the popover under the bell. Computed at render time so it
     survives header layout changes without hard-coded offsets. */
  const btn = document.getElementById("notif-btn");
  if (btn) {
    const rect = btn.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 8}px`;
    pop.style.right = `${window.innerWidth - rect.right}px`;
  }

  /* Item click: mark as read, then either let the link navigate (anchor)
     or close the popover (div). */
  pop.querySelectorAll(".notif-item").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-notif-id");
      if (id) markNotificationRead(id);
      renderNotificationsBadge();
      // Let the link's default navigation happen on anchors; close the
      // popover for non-link items so the click feels resolved.
      if (el.tagName !== "A") closeNotificationsPopover();
    });
  });

  const markAllBtn = document.getElementById("notif-mark-all");
  if (markAllBtn) {
    markAllBtn.addEventListener("click", () => {
      markAllNotificationsRead();
      renderNotificationsBadge();
      renderNotificationsPopover(); // re-render so unread dots clear
    });
  }
}

function openNotificationsPopover() {
  const btn = document.getElementById("notif-btn");
  if (!btn) return;
  btn.setAttribute("aria-expanded", "true");
  renderNotificationsPopover();
  setTimeout(() => {
    document.addEventListener("click", notifOutsideListener);
    document.addEventListener("keydown", notifEscListener);
  }, 0);
}
function closeNotificationsPopover() {
  const pop = document.getElementById("notif-popover");
  if (pop) pop.remove();
  const btn = document.getElementById("notif-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", notifOutsideListener);
  document.removeEventListener("keydown", notifEscListener);
}
function notifOutsideListener(e) {
  const pop = document.getElementById("notif-popover");
  const btn = document.getElementById("notif-btn");
  if (!pop || !btn) return;
  if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    closeNotificationsPopover();
  }
}
function notifEscListener(e) {
  if (e.key === "Escape") closeNotificationsPopover();
}

function wireNotifications() {
  const btn = document.getElementById("notif-btn");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (document.getElementById("notif-popover")) closeNotificationsPopover();
    else openNotificationsPopover();
  });
  renderNotificationsBadge();
}

// Boot: load content from /content before the router runs. Errors here
// are fatal (no catalog without modules), so render a friendly message.
(async function boot() {
  try {
    await loadContent();
    // Re-render the avatar/menu now that content is available — the first
    // call ran before MODULES existed, so isPathComplete() returned false
    // even for learners who had finished the path.
    renderMe();
    wireNotifications();
  } catch (err) {
    console.error("[content] failed to load:", err);
    const appEl = document.getElementById("app");
    if (appEl) {
      appEl.innerHTML = `<section class="catalog"><h1 style="margin-top:48px">Content failed to load</h1><p style="max-width:560px">The Academy could not fetch its lessons. Please refresh the page. If the problem continues, share this error with the Academy team:</p><pre style="background:#F2F4F7;padding:12px;border-radius:8px;white-space:pre-wrap;max-width:720px">${String(err && err.message || err)}</pre></section>`;
    }
    return;
  }
  if (!_l || !_l.role) {
    // First-time visitor: after the welcome modal saves a profile, reload
    // content so an Internal learner picks up Internal modules immediately
    // (otherwise loadContent ran when no learner existed and skipped the
    // internal manifest). loadContent is fail-safe for internal fetches.
    showIdentityModal(async () => {
      try { await loadContent(); }
      catch (e) { console.warn("[content] reload after first profile failed:", e.message); }
      startSession();
      route();
    });
  } else { startSession(); route(); }
})();
