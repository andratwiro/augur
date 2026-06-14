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

## Front-end work — load these skills first (required)

**Before writing or modifying any front-end code** — a prototype's HTML/CSS/JS, or
the `build.js` shell / landing-page UI — read all five SKILL.md files below into
context first. This is not optional and applies even to "quick" edits; the skills
are interdependent (design ↔ a11y ↔ review). If a task touches front-end output and
you have not loaded them this session, load them before your first edit.

| Skill | Read | Use it for |
|---|---|---|
| `skills/govocal-design/SKILL.md` | brand & tone | visual direction, voice, when-to-use |
| `skills/govocal-ui/SKILL.md` | real components & tokens | source-grounded `.gv-*` components, `--gv-*` tokens, `?theme=` city switcher |
| `skills/frontend-design/SKILL.md` | visual direction | typography, color, non-templated design |
| `skills/govocal-a11y/SKILL.md` | WCAG 2.2 AA | build compliant; run `npm run audit`; flag violations |
| `skills/webapp-testing/SKILL.md` | Playwright | screenshot & review the change before reporting done |

Closing the loop on every front-end change: **screenshot it** (webapp-testing, via
`.venv/bin/python`) to confirm it renders, and **run `npm run audit`** (a11y) before
calling it done or deploying. Report both results in chat.

## Design system

Two companion skills, **consult both when building any prototype**:

- `skills/govocal-design/` — brand voice, tone, visual direction, when-to-use.
- `skills/govocal-ui/` — the **source-grounded fidelity layer**: real design
  tokens (`govocal-tokens.css`), copy-paste component CSS (`govocal-ui.css`,
  `.gv-*` classes), a component catalog (`components.md`), a live `gallery.html`,
  and a per-city `?theme=` colour switcher (`govocal-themes.js`). Transcribed from
  `CitizenLabDotCo/citizenlab` (pinned commit). **Never hardcode brand colours** —
  use `var(--gv-tenant-primary|secondary|text)` so cities re-theme via `?theme=`.
  Copy the asset files into a prototype folder (prototypes are self-contained):
  `govocal-tokens.css`, `govocal-ui.css`, `govocal-themes.js`, and — on
  resident-facing prototypes — `govocal-cookies.js` (see the cookie rule below).

## Cookie consent — resident/participant-facing prototypes (required)

For realism, **every prototype that touches the resident / participant experience
must show the GoVocal cookie-consent dialog first** (the modal with **Edit /
Decline / Accept**). It is part of the real first-load experience, so a prototype
without it reads as fake.

- **In English.** Title `Your cookie settings — <City>`, Edit / Decline / Accept.
- **How:** copy `skills/govocal-ui/govocal-cookies.js` into the prototype folder and
  add `<script src="govocal-cookies.js" defer></script>` near the end of `<body>`.
  Set the city with `<body data-gv-cookies-city="Vienna">`. It auto-shows on load
  (once per browser; use `data-gv-cookies="always"` to always show for review,
  `…="off"` to disable). Themes with `--gv-tenant-primary`.
- **Backend / admin prototypes:** **skip it** — no cookie banner needed.
- **Pages-tab reference reproductions** (`pages/<name>/`, the Patterns/Pages glossary)
  are **NOT** prototypes — **no cookie banner**. They exist for designers to study and
  copy from; a blocking consent modal obscures the reference. The rule is scoped to the
  interactive prototypes under `<opportunity>/prototypes/`.
- When a request is for a resident-facing **prototype** and omits this, add it by default.

## Review comments (how to read reviewer feedback)

Every prototype ships with a hidden review overlay (`src/review/comments.js`,
injected by `build.js` as `/__review/comments.js`). Reviewers press **Shift+C**
to drop pinned comment threads on the live prototype. Threads are stored in
Cloudflare KV via the worker (`src/_worker.js` → `/__review/api`).

**To read reviewer feedback, run `npm run comments`.** It pulls every thread
from the secret-guarded export endpoint into a gitignored `review-comments.local.md`,
grouped by prototype with each pin's CSS-selector context, author, and timestamp.
Read that file to act on in-context feedback. It needs `REVIEW_SITE_URL` and
`REVIEW_EXPORT_KEY` in `.env.deploy` (the export key is also a Pages secret).

The `REVIEW_EXPORT_KEY` is a secret — never paste it into chat (same rule as the
Cloudflare token). The overlay tag is injected at build time only, so prototype
source stays clean and Download HTML strips it for a clean dev copy.

## Accessibility — design-level (WCAG 2.2 AA, perceivable parts)

Prototypes are **interactive guidance**, not the shipping build. Accessibility here is
scoped to what a mockup decides and demonstrates: **design and show ALL states** (error
/validation, focus, hover, disabled, loading, empty — that's the point of an
interactive prototype) plus the *perceivable / visual* layer — **color contrast
(non-negotiable, in every state), use of color, legible type & zoom, target sizes,
visible focus styling, motion**. Only the *deep implementation correctness* that a
keyboard/screen reader needs (full ARIA widget behavior, focus-trap robustness,
live-region timing) is the **dev team's** job on the real codebase. Demonstrating a
state is in scope; making it perfectly screen-reader-operable is not — don't
over-engineer ARIA into a mockup, but cheap obvious wiring is welcome.
The skill lives in `skills/govocal-a11y/`. **Consult it when building or modifying any
prototype** and:

- **Build it right visually by default** — apply its checklist as you write markup.
  Flag the user the moment a request would bake in a *visual* a11y failure (color-only
  state, links by color alone, low-contrast text, disabled zoom, tiny targets,
  autoplaying motion, …).
- **Audit before calling a prototype done / before deploy** — run `npm run audit`
  (design-level checks: contrast, use-of-color, zoom, target size) and **report
  results in chat**. Non-blocking; never silently ship a contrast/use-of-color
  failure. `npm run audit -- --all` runs the full WCAG 2.2 AA set for the dev handoff.

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
