# Qargo Academy

A SCORM-style eLearning mockup for Qargo. Vanilla JS, no build step. The shell, all CSS, and all JS live in `index.html`; lesson content is loaded at runtime from the `content/` tree.

## Run locally

```
./serve.command
```

That starts a Python HTTP server on `http://localhost:8000/`. Opening `index.html` directly via `file://` will not work, because the runtime content loader uses `fetch()` which browsers block on the local-file protocol.

## Where to read next

- `CONTEXT.md` — full platform architecture: routing, block types, persistence, design tokens.
- `LOADER.md` — how the content tree is structured and how the loader fetches and assembles it.

## What lives where

The repo root holds the app (`index.html`), the public content tree (`content/`), the Cloudflare Worker that handles event reporting and gates the Internal track (`reporting-worker.js`, `wrangler.toml`), and the visitor-sync helper that pulls reporting events into a local snapshot (`sync-visitors.js`, `visitors.json`). The Internal track content (`internal-content/`) and local authoring tooling (`skills/`) are gitignored by design; see `.gitignore` for the full list and the reasoning.

For a complete file-by-file map, see the "File layout" section in `CONTEXT.md`.
