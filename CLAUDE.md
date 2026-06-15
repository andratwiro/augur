# GoVocal Prototypes — Conventions

A monorepo of clickable design prototypes. `build.js` compiles the publishable
parts into `/dist`, which is deployed to a private URL (Cloudflare Pages + Access).

The point of this repo is **fast, private prototyping for GoVocal**. Keep the
default path light: nothing heavy loads at session start, you just build. The
GoVocal design-system machinery (components, theming, a11y, comments, status) all
still exists, but it is **opt-in** — pulled in only when a mode or an on-demand
command below calls for it. Don't front-load it.

## Always-on (the only standing rules)

These are cheap facts and guardrails — they cost no context and a couple of them
prevent leaking internal material. Everything else is opt-in.

### What GoVocal is (always know this much)

**GoVocal** (formerly **CitizenLab**) is a digital-democracy / community-engagement
SaaS used by 500+ governments, mostly municipalities. A city runs a branded
**platform** where **residents** participate in **projects**; staff configure and
analyze from a **back office**. The whole product hangs off one spine:
**Folder → Project → Phase → Participation method** — each phase runs exactly **one**
method (survey, ideation, voting, …). Every prototype is one of **two surfaces**:
**front office** (resident-facing, public, branded — gets the cookie banner) or
**back office** (staff config/moderation/analytics — no cookie banner). An **"input"**
is the generic word for anything a resident submits. Direction is heavily **AI**
(sensemaking, auto-theming, OCR). _That's the whole standing summary — for depth
(vocabulary, the 8 methods, roles, URLs, data model) read **`GOVOCAL.md`** at the repo
root; never auto-load it, re-call on a real product doubt._

### Folder convention

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

### What gets published (critical guardrail)

`build.js` copies **only** the contents of `prototypes/` folders into `/dist`.

- ✅ Published: everything inside `<opportunity>/prototypes/<name>/`
- 🚫 **NEVER published:** `research.md`, `context.md`, `GOVOCAL.md`, `TODO.md`, or
  anything outside a `prototypes/` folder. These hold internal/sensitive context and
  must never be copied to `/dist` or exposed at the public URL.

If you add a new kind of internal file, keep it **outside** `prototypes/`.

### Prototype rules

- Self-contained **static HTML/JS**. No build step, no server — a prototype must
  work by opening its `index.html` directly.
- Each prototype lives in its own folder under `<opportunity>/prototypes/`.
- Prefer `index.html` as the entry point (it becomes the clickable link).
- Keep assets (css/js/img) local to the prototype folder so the copy is complete.

### Build & deploy

- `node build.js` → regenerates `/dist` (cleaned each run) + `dist/index.html`
  landing page, sorted most-recently-modified first.
- Deployed to Cloudflare Pages via **Direct Upload** (`govocal-prototypes` project,
  isolated account). `/dist` and `node_modules` are gitignored.
- **Two ways to deploy:** Local `npm run deploy` (sources gitignored `.env.deploy`,
  builds, uploads); or push to `main` → GitHub Actions
  (`.github/workflows/deploy.yml`) builds + deploys, using repo secrets
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.
- The Cloudflare API token must **never** be pasted into chat — it lives only in
  `.env.deploy` (local) and the GitHub secret (CI).

**Deploy automatically (standing authorization).** After finishing a set of changes
that affect the **live site** — a prototype's files, or the landing/shell UI —
deploy without waiting to be asked: run `npm run deploy`, then report the URL. Don't
deploy half-finished work. (No deploy for internal-only edits like `research.md`,
`context.md`, `GOVOCAL.md`, or skills.)

**Commit & push automatically (standing authorization).** The user does not want to
manage git. After completing any change, commit and push without being asked:
commit directly to **`main`** (the deploy branch — no feature branches) with a clear
imperative message; push so the remote stays in sync. Commit logical units, not
half-finished edits. Never commit secrets (`.env.deploy` is gitignored).
**Shared checkout:** the user edits files concurrently — stage only the paths you
changed, never `git add -A`.

**Site UI version.** `build.js` has a `UI_VERSION` constant in every generated
page's footer. Bump it **only** when the prototypes-site UI changes (the build.js
shell/CSS, index pages, carousel/comments/download). **Not** for changes inside
individual prototypes — those are versioned by their own modified date.

## Modes (how front-end capability gets loaded)

Default to **Free mode**. Switch modes only when the user names one. Each mode
decides what skills/context load — that's the whole point: keep context minimal
until the work actually needs more.

### Free mode (default)

Just building a prototype, testing an idea. **Loads `skills/frontend-design/`** —
generic design craft (typography, palette, layout, non-templated direction). That's
the minimum, always, for prototype work. Nothing GoVocal-specific loads unless the
user asks for it ad-hoc ("make it GoVocal," "pull the survey kit," "read the
research"). Build fast and light.

### System-building mode

The user shares GoVocal screenshots / source and wants a **faithful, reusable
library** of primitives, components, and pages built into `skills/govocal-ui/` and
`components/` for future use or reference. Loads `skills/govocal-ui/` (real tokens,
`.gv-*` components, `components.md`, `gallery.html`, themes, icons) + the library
index (`LIBRARY.md`, `components/manifest.md`). This is the one mode where editing
the canonical library source is the goal.

> **Scaffolding TBD** — the user will flesh out the exact workflow when they next
> pick it up. For now: load `govocal-ui`, work source-grounded, keep the library
> tidy. **Parked backlog** (from the old TODO, build only when this mode is active):
> refine the existing `.gv-*` primitives (`header-nav`, `footer`, `project-card`,
> `hero`) vs the real product, and build the remaining reference Pages one at a time
> — Content Builder, Survey Builder, Perspectives, Voting, Common Ground, Ideation,
> Project List, Project Editor (pipeline: capture real HTML/screenshot → analyze vs
> `LIBRARY.md` → build from components → verify → land). Also still open: real
> prototypes for the `departments/` opportunity (currently hello-world placeholders).

### Future modes (not built yet — don't assume them)

- **GoVocal UI mode** — build a prototype in GoVocal's real visual language (loads
  `govocal-ui` + the GoVocal memory summary).
- **Testing mode** — run a prototype through personas + a11y, user corrects (loads
  `govocal-a11y`, `govocal-persona-critique`, `webapp-testing`).

## On-demand capabilities (pull only when asked / relevant)

None of these load by default. Reach for them when the task or the user calls for it.

- **GoVocal product depth** — a minimal GoVocal summary lives in agent memory. For
  anything deeper (the Folder→Project→Phase→method model, exact vocabulary, roles,
  asset specs, accumulated working knowledge), read **`GOVOCAL.md`** at the repo
  root. Search it when you have a product doubt; don't auto-load it.
- **Opportunity research** — each opportunity has `research.md` / `context.md`
  describing the problem, users, and constraints. Read them when building in that
  opportunity and the context matters. Internal-only, never ship.
- **GoVocal UI / fidelity** — `skills/govocal-ui/` for real tokens and `.gv-*`
  components. **Never hardcode brand colours** when you do use it — use
  `var(--gv-tenant-primary|secondary|text)` so cities re-theme via `?theme=`. Copy
  asset files into the prototype folder (prototypes are self-contained).
- **Cookie consent** — when building a **resident/participant-facing** prototype in
  GoVocal's language, copy `skills/govocal-ui/govocal-cookies.js` in and set
  `<body data-gv-cookies-city="Vienna">` so first-load shows the real consent modal.
  Skip for admin/backend prototypes and for reference reproductions.
- **A11y audit** — `skills/govocal-a11y/` + `npm run audit` (design-level: contrast,
  use-of-color, zoom, target size). Run before a real handoff or when the user asks;
  report results in chat. Flag immediately if a request would bake in a *visual* a11y
  failure (color-only state, low-contrast text, disabled zoom, tiny targets).
- **Persona critique** — `skills/govocal-persona-critique/` to critique a flow in
  character (participant/admin personas).
- **Review comments** — `npm run comments` pulls reviewer threads into a gitignored
  `review-comments.local.md`. Needs `REVIEW_SITE_URL` + `REVIEW_EXPORT_KEY` in
  `.env.deploy`; the export key is a secret — never paste it in chat.
- **Dev-status pipeline** — each prototype card on its opportunity index carries a
  dev-facing status badge (Playground / In progress / Dev ready / Shipped / Parked),
  cycled by clicking on the live site, persisted to KV via `src/_worker.js`. When the
  user moves one to **Parked** or **Shipped**, that's the cue to consolidate
  learnings into `GOVOCAL.md` and commit.
