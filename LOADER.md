# Qargo Academy: content loader

This document describes how lesson content is stored, fetched and assembled at runtime. It pairs with `CONTEXT.md`, which covers the platform itself.

## 1. Why the split exists

Up to this point all path, module and lesson data lived inline in `index.html`. As lessons grow toward a fifty-plus library, that single file becomes painful to scan, painful to delegate authoring against, and painful to review on a per-lesson basis. The content tree separates concerns so that a single lesson can be added, edited or replaced without touching the platform code.

The hierarchy mirrors the platform's mental model: a Path collects Modules, a Module collects Lessons, a Lesson is a list of Blocks. Each layer owns only what belongs to it. References between layers are by ID.

## 2. File tree

```
/content
  manifest.json
  /paths
    super-admin-first-mile.json
  /tracks
    specialised.json
    extra-curricular.json
  /modules
    m0-logic-of-qargo.json
    m1-essential-setup.json
    sp-palletline.json
    ec-gdpr.json
    ...
  /lessons
    m0-l1-welcome.json
    m0-l2-core-objects.json
    ...
```

Paths are linear, ordered journeys with completion semantics. Tracks are flat collections of independent modules (specialised networks, extra-curricular topics) that the catalog groups together but does not require in any order. Both reference modules by ID. Modules reference lessons by ID.

## 3. JSON shapes

### Manifest

`/content/manifest.json` is the index of every file the loader is allowed to fetch. The loader fetches nothing it cannot find here.

```json
{
  "version": "2026-04-30-1",
  "paths": ["super-admin-first-mile"],
  "tracks": ["specialised", "extra-curricular"],
  "modules": ["m0-logic-of-qargo", "m1-essential-setup", "..."],
  "lessons": ["m0-l1-welcome", "m0-l2-core-objects", "..."]
}
```

The `version` field is the cache-bust key. Change anything in the content tree and bump it. The format is free-form (date-suffix is convenient) but it must be a string and it must change every time content changes.

### Path

```json
{
  "id": "super-admin-first-mile",
  "title": "The first mile: all aboard Qargo",
  "description": "...",
  "modules": ["m0-logic-of-qargo", "m1-essential-setup", "..."]
}
```

`modules` is an ordered array of module IDs. Order is the order learners progress through.

### Track

```json
{
  "id": "specialised",
  "title": "Specialised modules",
  "description": "...",
  "modules": ["sp-palletline", "sp-palletforce", "..."]
}
```

Same shape as a path, but the platform treats it as a flat catalog group rather than a journey.

### Module

```json
{
  "id": "m0-logic-of-qargo",
  "code": "M0",
  "title": "The Logic of Qargo",
  "description": "Orientation. Builds the mental model before you touch anything.",
  "roles": ["super_admin"],
  "locked": false,
  "lessons": ["m0-l1-welcome", "m0-l2-core-objects", "..."]
}
```

`code` is the short label on the catalog card (M0, M1, sp-, ec-). `roles` controls visibility per learner role. `locked: true` means the module renders as a locked card with no lessons. Tracks (specialised, extra-curricular) currently use `locked: true` and an empty lessons array; when content is added to one, set `locked: false` and populate `lessons`.

### Lesson

```json
{
  "id": "m0-l1-welcome",
  "title": "Welcome to Qargo",
  "blocks": [
    { "type": "text", "title": "...", "lead": "...", "body": "..." },
    { "type": "accordion", "title": "...", "items": [{ "q": "...", "a": "..." }] },
    { "type": "summary", "points": ["..."] },
    { "type": "quiz", "question": "...", "options": ["..."], "correct": 1, "explanation": "..." }
  ]
}
```

Block shapes are unchanged from the inline version. The canonical reference for each block type's required fields is the `renderBlock()` dispatcher and the per-type renderers in `index.html`; the live demo at `#/blocks` shows one working example of every type.

## 4. Loader contract (in `index.html`)

The loader runs once on boot, before the router. The flow is:

1. Fetch `/content/manifest.json` (always live, never from cache).
2. Look up `localStorage` key `academy.content_cache`. If it holds a bundle whose `version` matches the manifest, skip step 3.
3. Otherwise fetch every path, track, module and lesson listed in the manifest in parallel. Store the resulting bundle in `localStorage` keyed against the manifest version.
4. Assemble: resolve module IDs in path/track files into module objects, resolve lesson IDs in module files into lesson objects.
5. Populate the module-scope bindings (`MODULES`, `LEARNING_PATH`, `SPECIALISED_MODULES`, `EXTRA_CURRICULAR`, `COURSES`). These mutate the existing array references in place so anything that already captured them stays live.
6. Boot the router (`route()`) and the identity modal as before.

If any fetch fails, the loader renders a friendly error message inside `#app` and stops. The router never runs against partial content.

### Eager loading

Every lesson listed in the manifest is fetched on first boot, then served from `localStorage` until the manifest version changes. Catalog counts (lessons per module, blocks per lesson) are accurate the moment the home page paints. Lazy-loading would shave a fraction of a second on first paint at the cost of either denormalising counts into the module files or having the catalog show counts asynchronously; neither was worth the complexity at this scale.

### Cache contract

`localStorage` key: `academy.content_cache`. Value: `{ "version": "<manifest version>", "bundle": { paths, tracks, modules, lessons } }`. Read on boot, written after a successful fetch. The cache is invalidated by bumping `manifest.version`. There is no other way to evict it; a learner with a stale cache must either visit after a version bump or clear their browser storage.

## 5. Adding a new lesson

1. Write a JSON file at `/content/lessons/<lesson-id>.json` matching the lesson shape above. Lesson IDs follow the `m{N}-l{N}-{kebab-case-title}` convention from the authoring instructions.
2. Add the lesson ID to the `lessons` array of the parent module file (`/content/modules/<module-id>.json`), in the order learners should encounter it.
3. Add the lesson ID to the `lessons` array in `/content/manifest.json`.
4. Bump `version` in `manifest.json`.
5. Commit and deploy. GitHub Pages serves the new files; learners pick up the new content on their next visit.

## 6. Adding a new module

1. Write `/content/modules/<module-id>.json`. If the module has lessons, write each lesson file too.
2. Add the module ID to whichever container references it: a path file (for the linear journey) or a track file (for catalog grouping).
3. Add the module ID and any new lesson IDs to `manifest.json`. Bump `version`.

Modules can move between paths and tracks by editing references; the module file itself does not change.

## 7. Adding a new path or track

1. Write `/content/paths/<path-id>.json` or `/content/tracks/<track-id>.json`.
2. Add the ID to the appropriate top-level array in `manifest.json`. Bump `version`.
3. The platform currently boots the first path in the manifest. If you add a second path, decide explicitly which one is the default and update the loader's `assembleContent()` accordingly.

## 8. Constraints to keep

- **Lesson IDs are stable.** Once published, do not rename. Learner progress is keyed on the ID.
- **Manifest is the source of truth.** A file that exists on disk but is missing from the manifest is invisible to the loader. A file referenced in the manifest that does not exist is a hard error.
- **No circular references.** A module cannot list itself. A path cannot reference another path.
- **Block shapes are platform-owned.** Adding a new block field means updating `index.html`'s renderer first, then authoring against it. Adding a new block type is a platform change, not a content change.
- **Cache busting is manual.** Every content change must bump `manifest.version`. Forgetting to bump leaves learners on stale content until their cache happens to be cleared.
