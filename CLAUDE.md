# GoVocal Prototypes — Conventions

A monorepo of clickable design prototypes. `build.js` compiles the publishable
parts into `/dist`, which is deployed to a private URL (Cloudflare Pages + Access).

## Session start (read this first)

At the start of each session, read `TODO.md` at the repo root and briefly tell the
user what's pending / next before doing anything else. Keep `TODO.md` up to date:
check items off as they land and add new ones as they come up. `TODO.md` is
internal — it lives at the root, outside any `prototypes/` folder, so it never ships.

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
- Deployed to Cloudflare Pages via **Direct Upload** (`govocal-prototypes` project,
  isolated account). `/dist` and `node_modules` are gitignored.
- **Two ways to deploy:**
  - Local: `npm run deploy` (sources gitignored `.env.deploy`, builds, uploads).
  - Push: GitHub Actions (`.github/workflows/deploy.yml`) builds + deploys on every
    push to `main`, using repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.
- The Cloudflare API token must **never** be pasted into chat — it lives only in
  `.env.deploy` (local) and the GitHub secret (CI).

### Deploy automatically (standing authorization)

After finishing a set of changes that affect the **live site** — a prototype's
files, or the landing/shell UI — deploy them without waiting to be asked: run
`npm run deploy`, then report the deployment URL. Don't deploy half-finished work;
deploy once a change is complete. (No deploy needed for internal-only edits like
`TODO.md`, `research.md`, `context.md`, or skills.)

### Commit & push automatically (standing authorization)

The user does not want to manage git. After completing any change, commit it and
push — without being asked:

- Commit directly to **`main`** (it is the deploy branch; do not create feature
  branches for this repo). Use a clear, imperative commit message.
- **Push to `main`** so the remote stays in sync. Pushing also triggers the CI
  autodeploy; combined with the local `npm run deploy` rule above the two are
  idempotent (same `/dist`), so a redundant CI deploy is harmless.
- Commit logical units of work as they complete, not half-finished edits. Group
  related file changes into one commit.
- Never commit secrets — `.env.deploy` is gitignored and must stay that way.

### Site UI version

`build.js` has a `UI_VERSION` constant shown in every generated page's footer
(`v0.01`). Bump it **only** when the prototypes-site UI changes — the build.js
shell/CSS, index pages, or features like carousel/comments/download. **Do not**
bump it for changes inside individual prototypes; those are versioned by their own
modified date, not this number.
