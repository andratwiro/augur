# GoVocal Prototypes — Conventions

A monorepo of clickable design prototypes. `build.js` compiles the publishable
parts into `/dist`, which is deployed to a private URL (Cloudflare Pages + Access).

## Folder convention

Each top-level folder is an **opportunity** (a problem space / project area):

```
<opportunity>/
├── research.md        # context for agents — NEVER published
├── context.md         # context for agents — NEVER published
└── prototypes/
    └── <prototype>/   # self-contained static HTML/JS — THIS is what ships
        └── index.html
```

Current opportunities: `parallel-participation/`, `departments/`. Add more by
creating a new top-level folder with a `prototypes/` subfolder.

## What gets published (critical)

`build.js` copies **only** the contents of `prototypes/` folders into `/dist`.

- ✅ Published: everything inside `<opportunity>/prototypes/<name>/`
- 🚫 **NEVER published:** `research.md`, `context.md`, or anything outside a
  `prototypes/` folder. These hold internal/sensitive context and must never be
  copied to `/dist` or otherwise exposed at the public URL.

If you add a new kind of internal file, keep it **outside** `prototypes/`.

## research.md & context.md

Every opportunity has a `research.md` and `context.md`. **Agents should read
these for context** before building or modifying a prototype — they describe the
problem, users, and constraints. They are internal-only and must never ship.

## Prototypes

- Self-contained **static HTML/JS**. No build step, no server — a prototype must
  work by opening its `index.html` directly.
- Each prototype lives in its own folder under `<opportunity>/prototypes/`.
- Prefer `index.html` as the entry point (it becomes the clickable link).
- Keep assets (css/js/img) local to the prototype folder so the copy is complete.

## Design system

A design-system skill lives in `skills/govocal-design/`. **Consult it when
building any prototype** so visuals, components, and tone stay consistent across
opportunities.

## Build & deploy

- `node build.js` → regenerates `/dist` (cleaned each run) + `dist/index.html`
  landing page, sorted most-recently-modified first.
- Deployed via Cloudflare Pages: build command `node build.js`, output dir `dist`.
- `/dist` and `node_modules` are gitignored; `/dist` is built by CI on deploy.
