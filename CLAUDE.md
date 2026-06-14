# GoVocal Prototypes — Conventions

A monorepo of clickable design prototypes. `build.js` compiles the publishable
parts into `/dist`, which is deployed to a private URL (Cloudflare Pages + Access).

## Session start (read this first)

At the start of each session, read `TODO.md` at the repo root and briefly tell the
user what's pending / next before doing anything else. Keep `TODO.md` up to date:
check items off as they land and add new ones as they come up. `TODO.md` is
internal — it lives at the root, outside any `prototypes/` folder, so it never ships.

Also read `GOVOCAL.md` at the repo root — the internal **product-context brief and
living project brain** (what GoVocal is, its vocabulary, the
Folder→Project→Phase→method model, roles, constraints, asset specs, plus accumulated
working knowledge). It grounds everything you build: §1–2 are the quick ramp, the
rest is reference you scan when building a specific surface. Keep it alive — see
"Keeping GOVOCAL.md alive" below. Internal-only, outside `prototypes/`, never ships.

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

## Keeping `GOVOCAL.md` alive (the project brain)

`GOVOCAL.md` is not a static snapshot — it is meant to **grow into a faithful
representation of the user's thinking about this project**. Treat it like memory,
scoped to GoVocal product knowledge and how we work on it. As we go:

- **Fold in what's learned.** When a conversation, a prototype build, an opportunity's
  `research.md`/`context.md`, or reviewer feedback (`npm run comments`) surfaces
  something durable — a product fact, a correction, the user's opinion/priority, a
  terminology preference, a decision about how a surface should behave — add it to
  the **`§ Working knowledge`** section at the bottom of `GOVOCAL.md` (or correct the
  relevant reference section if it's a plain factual fix).
- **Capture the user's brain, not just the product.** Their product opinions,
  what they care about, recurring asks, and how they think about GoVocal belong here
  — this file should let a fresh agent think about the project the way the user does.
- **Keep it tidy & deduped** (same discipline as memory): update the existing line
  rather than appending a duplicate; delete what turns out wrong; date entries that
  are point-in-time. Don't let it sprawl — compress.
- **Cite where it matters.** For product facts, the help center
  (`support.govocal.com`) and the source repo (`CitizenLabDotCo/citizenlab`) are
  ground truth — re-fetch rather than guess, then record what you confirmed.
- **Do it proactively**, without being asked, whenever something worth remembering
  comes up — and mention in chat that you updated it.

## Prototypes

- Self-contained **static HTML/JS**. No build step, no server — a prototype must
  work by opening its `index.html` directly.
- Each prototype lives in its own folder under `<opportunity>/prototypes/`.
- Prefer `index.html` as the entry point (it becomes the clickable link).
- Keep assets (css/js/img) local to the prototype folder so the copy is complete.

## Front-end work — load these skills first (required)

**Before writing or modifying any front-end code** — a prototype's HTML/CSS/JS, or
the `build.js` shell / landing-page UI — read the SKILL.md files below into
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
| `skills/govocal-persona-critique/SKILL.md` | persona design lens | **prototypes only** — critique a flow in character (participant/admin personas); load when building a prototype |

The first five apply to all front-end work. **`govocal-persona-critique` is scoped to
prototypes** (`<opportunity>/prototypes/`) — load it when building/modifying one, skip
it for the build.js shell or reference pages.

Closing the loop on every front-end change: **screenshot it** (webapp-testing, via
`.venv/bin/python`) to confirm it renders, and **run `npm run audit`** (a11y) before
calling it done or deploying. Report both results in chat.

**Mobile-first, always** — check the phone viewport first (participants are
phone-primary; admins desktop-primary but mobile happens). **Proactively offer a
persona critique** when building or finishing a prototype: name the one or two
personas the flow most needs to serve and run the lens — don't wait to be asked (see
`skills/govocal-persona-critique/`).

## Design system

Ground the *product* in `GOVOCAL.md` (root) and the *look & feel* in the two skills
below. `GOVOCAL.md` tells you what a Project/Phase/Input/participation-method
actually is and the exact terminology + asset specs to mirror; the skills tell you
how it looks and sounds. Consult all three when building any prototype.

Two companion skills, **consult both when building any prototype**:

- `skills/govocal-design/` — brand voice, tone, visual direction, when-to-use.
- `skills/govocal-ui/` — the **source-grounded fidelity layer**: real design
  tokens (`govocal-tokens.css`), copy-paste component CSS (`govocal-ui.css`,
  `.gv-*` classes), a catalog (`components.md`), a live `gallery.html`, the real
  `govocal-logo.svg` (footer “powered by”), and a per-city `?theme=` colour + font
  switcher (`govocal-themes.js`). Transcribed from `CitizenLabDotCo/citizenlab`
  (pinned commit). **Never hardcode brand colours** — use
  `var(--gv-tenant-primary|secondary|text)` so cities re-theme via `?theme=`.
  Copy the asset files into a prototype folder (prototypes are self-contained):
  `govocal-tokens.css`, `govocal-ui.css`, `govocal-themes.js`, and — on
  resident-facing prototypes — `govocal-cookies.js` (see the cookie rule below),
  plus `govocal-logo.svg` if the footer is used.

**Library tiers (Primitives → Components → Pages).** The system is layered and the
review site has a tab per tier: **Primitives** (`/primitives/` = `gallery.html`,
tokens + base `.gv-*`), **Components** (`/components/` = composed blocks: header/nav,
footer, project-card+rail, hero — source in `components/<name>/`), and **Pages**
(`/pages/` = whole screens built from components). When building a prototype you can
pull from any tier. **To reuse a component without loading them all:** scan
`components/manifest.md` (the recall index), then open just the one component file or
grab its snippet from `components.md`.

**Reuse-first — read `LIBRARY.md` before you build (required).** `LIBRARY.md` at the
repo root is the **generated, always-current recall index** of everything reusable —
every Primitive, Component, Page, and existing Prototype, with its source path and a
one-line description. **Before building anything in a prototype, scan `LIBRARY.md`
first and start from an existing layer (Primitives → Components → Pages) instead of
rebuilding it.** Copy the asset/snippet into the prototype folder, then adapt it
freely — **a prototype is allowed to fork, restyle, version, and break a copied
component; that's the point.** The one rule: never edit the *canonical source*
(`skills/govocal-ui/govocal-ui.css`, the `components/<name>/` demos) from inside a
prototype — the library is shared truth, your prototype-local copy is yours to mangle.
Only build new when nothing fits; then consider promoting it into the library.
`LIBRARY.md` is generated by `npm run index` (`scripts/build-index.mjs`) and auto-
refreshes on every `npm run build`/`dev`/`deploy`; run `npm run index` after adding or
removing a library item. It's the agent-readable twin of the **⌘K search** on the
review site (same scan, two audiences). Internal-only — never ships.

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
- **Pages-tab & Components-tab reference reproductions** (`pages/<name>/`,
  `components/<name>/` — the Primitives/Components/Pages glossary) are **NOT**
  prototypes — **no cookie banner**. They exist for designers to study and
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

## Prototype dev-status — a pipeline for engineering (and the roll-up to memory)

Each prototype card on its **opportunity index page** carries a **dev-facing status
badge** that answers the one question a developer asks — *"what do I do with this?"*.
The user cycles it by clicking on the live review site; it advances through a
left-to-right pipeline (then loops):

| Status | Colour | Means | Dev reads it as |
|---|---|---|---|
| **Playground** | grey | Scratch / playing around | *Ignore — not a real proposal* |
| **In progress** *(default)* | amber | Real candidate, still being shaped | *Preview it, but don't build — it'll change* |
| **Dev ready** | green | Design decided — this is the intended build | *This is the spec — build it* |
| **Shipped** | blue | Built into the real product | *Done — delivered* |
| **Parked** | rose | Set aside / on hold / won't build for now | *Ignore* |

Colour is **never** the only signal — the badge always carries the text label (1.4.1).
State persists to the same KV the comments use, via the worker (`src/_worker.js` →
`/__review/status`, keyed `s:<prototype-path>`, gated by the site password). `build.js`
renders the badge + the `STATUS_JS` cycle into the opportunity index shell; the default
(`in_progress`, the absent KV key) is server-rendered, then corrected from KV on load.
The main carousel's opportunity cards show a read-only count chip per present status.

**Parked or Shipped is the cue to roll learnings into `GOVOCAL.md` §13.** When the
user moves a prototype to **Parked** (set aside) or **Shipped** (built) — or asks you
to — treat it as the checkpoint to consolidate what we learned building it: product
facts, decisions, the user's preferences → `GOVOCAL.md`'s Working knowledge (see
"Keeping GOVOCAL.md alive"), then commit. The user drives this and will usually ask;
`npm run comments` lists prototypes by status and flags the Parked/Shipped ones whose
learnings may not be captured yet.

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
