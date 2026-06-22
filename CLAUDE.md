# Augur — the build/deploy platform (`andratwiro/augur`)

**Augur** is the platform that builds and ships the Go Vocal prototyping site. This repo
(`andratwiro/augur` on GitHub; the Cloudflare Pages project is still named
`govocal-prototypes`) owns `build.js`, the worker (`src/_worker.js`), the
comment/pin/status overlay layers, the build scripts, and the GitHub Actions → Cloudflare
Pages deploy. It is the **only** thing that builds and deploys the live site.

Augur does **not** own the prototypes or the design system — it **composes** them from two
git submodules mounted at its root:

```
augur/                       # THIS repo — build + deploy platform ONLY
├── build.js, src/           # the build + the worker (comment/pin/status overlays)
├── scripts/                 # platform scripts: shoot (posters), og, review (comments)
├── pitis/                   # the Pitis layer + its pet-agents
├── gv-design-system/        # submodule (DS_ROOT) — canonical design system + capture/skills pipeline  [READ-ONLY here]
└── gv-workspace/            # submodule (WS_ROOT) — opportunities + research + GOVOCAL.md
```

> Augur owns **only** the platform — prototype navigation, the comment system, token
> surfacing on the comment layer, Pitis (and later: users, workspace switching). The
> **design system pipeline** (capture/scrape, lint, the `govocal-ui`/`frontend-design`/
> `govocal-a11y`/`participation-design`/`govocal-persona-critique`/`webapp-testing` skills)
> lives in the **gv-design-system** repo. When a mode below references a skill or
> `npm run capture|verify|lint|audit`, that runs **from the DS repo**, not here.

`build.js` reads DS assets from `gv-design-system/` (`DS_ROOT`) and opportunities from
`gv-workspace/` (`WS_ROOT`), and emits `/dist`.

## Three-repo composition — edit where the source lives (read this first)

The design system is the **single source of truth**. Never copy `.gv-*` assets out of it or
redefine them in a consumer — edit the canonical source and let it flow into every build.

| To change…                                       | Edit in…                          | Then…                                    |
|--------------------------------------------------|-----------------------------------|------------------------------------------|
| a `.gv-*` token / primitive / component / page    | the **gv-design-system** repo     | push DS → bump Augur's pin (below)       |
| an opportunity, prototype, research, GOVOCAL.md   | the **gv-workspace** repo         | push WS → bump Augur's pin               |
| build/deploy, worker, overlays, landing, scripts  | **this repo** (Augur)             | push to `main` → auto-deploys            |

**Do DS and workspace edits in their own standalone clones** (siblings of this folder in the
god-mode checkout), **never** in the `gv-design-system/` / `gv-workspace/` copies nested here —
those are pinned, read-only mirrors used only for BUILDING. CI **fails the deploy** if the DS
submodule has local edits (read-only guard in `deploy.yml`). Primary enforcement is git
permissions: collaborators have no push to the DS repo.

**Bump a submodule pin** after pushing DS/workspace changes, so the next build picks them up:

```
git submodule update --remote gv-design-system   # or gv-workspace
git add gv-design-system                           # stage only the pin you bumped
git commit -m "Bump gv-design-system pin"
git push                                            # → CI builds + deploys
```

(An auto DS-push → pin-bump dispatch is the chosen model but **not built yet** — bump by hand.)

**CI auth — `.gitmodules` must stay HTTPS.** `deploy.yml` checks out the private submodules
with a PAT (`SUBMODULE_PAT`, Contents:read on all three repos). `actions/checkout` injects the
token by rewriting **HTTPS** submodule URLs — it cannot auth **SSH** URLs. So `.gitmodules`
URLs must be `https://github.com/…` or the CI submodule fetch fails. Locally a global
`url."git@github.com:".insteadOf "https://github.com/"` makes those HTTPS URLs resolve to SSH
transparently.

---

The point of all this is **fast, private prototyping for Go Vocal**. Keep the default path
light: nothing heavy loads at session start, you just build. The design-system machinery
(components, theming, a11y, comments, status) all exists, but it is **opt-in** — pulled in
only when a mode or an on-demand command below calls for it. Don't front-load it.

## Always-on (the only standing rules)

These are cheap facts and guardrails — they cost no context and a couple of them prevent
leaking internal material. Everything else is opt-in.

### What Go Vocal is (always know this much)

**Go Vocal** (formerly **CitizenLab**) is a digital-democracy / community-engagement SaaS used
by 500+ governments, mostly municipalities. A city runs a branded **platform** where
**residents** participate in **projects**; staff configure and analyze from a **back office**.
The whole product hangs off one spine: **Folder → Project → Phase → Participation method** —
each phase runs exactly **one** method (survey, ideation, voting, …). Every prototype is one of
**two surfaces**: **front office** (resident-facing, public, branded) or **back office** (staff
config/moderation/analytics). An **"input"** is the generic word for anything a resident
submits. Direction is heavily **AI** (sensemaking, auto-theming, OCR). _That's the whole
standing summary — for depth (vocabulary, the 8 methods, roles, URLs, data model) read
**`gv-workspace/GOVOCAL.md`**; never auto-load it, re-call on a real product doubt._

### Opportunity convention (lives in gv-workspace)

Opportunities and prototypes live in the **gv-workspace** submodule. Each top-level folder
there is an **opportunity** (a problem space / project area):

```
gv-workspace/<opportunity>/
├── research.md        # context for agents — NEVER published
├── context.md         # context for agents — NEVER published
└── prototypes/
    └── <prototype>/   # self-contained static HTML/JS — THIS is what ships
        └── index.html
```

Add opportunities/prototypes by editing the **gv-workspace** repo (then bump the pin).

### What gets published (critical guardrail)

`build.js` copies **only** the contents of `prototypes/` folders (under `gv-workspace/`) into
`/dist`.

- ✅ Published: everything inside `gv-workspace/<opportunity>/prototypes/<name>/`
- 🚫 **NEVER published:** `research.md`, `context.md`, `GOVOCAL.md`, `TODO.md`, or anything
  outside a `prototypes/` folder. These hold internal/sensitive context and must never be
  copied to `/dist` or exposed at the public URL.

If you add a new kind of internal file, keep it **outside** `prototypes/`.

### Prototype rules

- Self-contained **static HTML/JS**. No build step, no server — a prototype must work by
  opening its `index.html` directly.
- Each prototype lives in its own folder under `gv-workspace/<opportunity>/prototypes/`.
- Prefer `index.html` as the entry point (it becomes the clickable link).
- Keep assets (css/js/img) local to the prototype folder so the copy is complete.

### Build & deploy

- `node build.js` → regenerates `/dist` (cleaned each run) + `dist/index.html` landing page,
  sorted most-recently-modified first. Composes both submodules; needs them checked out.
- **Offline mode — `npm run offline`** (`scripts/offline.mjs`; Ctrl-C to stop). Local mirror of
  the live site, no network/Cloudflare/deploy: builds `dist`, runs `wrangler pages dev` so the
  **real `src/_worker.js`** executes against a **local KV** (overlays — comments/pins/status/
  names/piti — all work; password gate is off → open), then watches the build inputs (DS skills/
  components/pages/base/patterns/tokens/registry, the workspace, `build.js`, the worker) and
  rebuilds on change. Each build stamps a fresh `BUILD_ID`; on localhost the injected live-reload
  poller runs at ~1s (vs 10s live — see `withLiveReload`/`liveReloadSnippet`'s `fast` branch), so
  a save reloads open tabs in ~1s. Serves `http://localhost:8788` (`OFFLINE_PORT` to override).
- Deployed to Cloudflare Pages via **Direct Upload** (project name still **`govocal-prototypes`**,
  URL `https://govocal-prototypes.pages.dev`, isolated account). `/dist` and `node_modules` are
  gitignored.
- **Two ways to deploy:** Local `npm run deploy` (sources gitignored `.env.deploy`, builds,
  uploads); or push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) builds +
  deploys, using repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (+ `SUBMODULE_PAT`
  for the private submodules).
- The Cloudflare API token must **never** be pasted into chat — it lives only in `.env.deploy`
  (local) and the GitHub secret (CI).

**Deploy automatically (standing authorization).** After finishing a set of changes that affect
the **live site** — a prototype's files, or the landing/shell UI — deploy without waiting to be
asked: run `npm run deploy`, then report the URL. Don't deploy half-finished work. (No deploy
for internal-only edits like `research.md`, `context.md`, `GOVOCAL.md`, or skills.) When the
live-site change came from a DS/workspace edit, the deploy path is: push that repo → bump the
pin here → push Augur.

**Commit & push automatically (standing authorization).** The user does not want to manage git.
After completing any change, commit and push without being asked — **per repo**, directly to
**`main`** (no feature branches), with a clear imperative message. Commit logical units, not
half-finished edits. Never commit secrets (`.env.deploy` is gitignored). **Shared checkout:**
the user (and other agents) edit concurrently — stage only the paths you changed, never
`git add -A`.

**Site UI version.** `build.js` has a `UI_VERSION` constant in every generated page's footer.
Bump it **only** when the prototypes-site UI changes (the build.js shell/CSS, index pages,
carousel/comments/download). **Not** for changes inside individual prototypes — those are
versioned by their own modified date.

## Modes (how front-end capability gets loaded)

Default to **Free mode**. Switch modes only when the user names one. Each mode decides what
skills/context load — keep context minimal until the work actually needs more.

### Free mode (default)

Just building a prototype, testing an idea. **Loads `gv-design-system/skills/frontend-design/`**
(in the DS submodule) — generic design craft (typography, palette, layout, non-templated direction). That's the
minimum, always, for prototype work. Nothing Go-Vocal-specific loads unless the user asks for it
ad-hoc ("make it Go Vocal," "pull the survey kit," "read the research"). Build fast and light.

### System-building mode

The user shares Go Vocal screenshots / source and wants a **faithful, reusable library** of
primitives, components, and pages. **This work targets the `gv-design-system` repo** — edit it
in its **own standalone clone**, not the read-only submodule here; then bump Augur's pin. The
canonical assets live at `gv-design-system/skills/govocal-ui/` (real tokens, `.gv-*` components,
`components.md`, `gallery.html`, themes, icons) + galleries (`components/ pages/ base/
patterns/`) + `LIBRARY.md` / `components/manifest.md`.

> **The pipeline lives in the DS repo.** The capture/verify/lint/index npm scripts, the
> design skills, and `govocal-exports/` (~1.5GB captures, gitignored) all live under
> `gv-design-system/`. Do this work in the **standalone DS clone**: run `npm install` once
> (Playwright), set up `.env.capture` (copy `.env.capture.example`), then run the commands
> below **from the DS repo**. Commit DS edits there, then bump Augur's pin. Don't run them
> from Augur — the read-only submodule mirror here has no `scripts/`/`package.json`.

**The workflow is the source-grounded pipeline — follow it, don't eyeball.** Full docs in
`gv-design-system/skills/govocal-ui/SKILL.md` ("Building & extending") and
`gv-design-system/govocal-exports/BACK-OFFICE.md`. Per piece (run from the **DS repo**):

1. **Capture** — `npm run capture -- <url> --name <slug> --probe "<real selectors>"`. Read exact
   values from `styles.json.digest`; **never approximate colours/borders/shadows/fonts off the
   screenshot.**
2. **Build** — assemble from existing `.gv-*` primitives, map values to `--gv-*` tokens (never
   hardcode a hex you can alias). New visual → *new variant*, don't mutate the base out from
   under existing users.
3. **Verify** — `npm run verify -- <built.html> --against <slug> --map "real=mine|…"`; loop until
   it exits ✓.
4. **Register + ratchet** — add the checkpoint to `gv-design-system/govocal-exports/checkpoints.json`;
   after ANY shared-CSS change run `npm run verify:all` (green = real improvement, red = a
   dependent regressed — fix or back out). `--changed .gv-x` = blast radius.
5. **Store** — `components.md` snippet + `components/manifest.md` row (+ `govocal-bo.css` for
   back-office chrome), then `npm run index`. Run **`npm run lint`** — it must pass.

**The hardwired invariant (`npm run lint` enforces it):** primitives → components → pages are
linked in real time, one source of truth per layer. Library demos (`components/`, `pages/`)
**reference** the canonical assets via `../../skills/govocal-ui/<asset>` (relative within the DS
repo) — they **never copy assets, redefine a `.gv-*` class, or hardcode visual values.** A
component that needs a primitive-level change → **edit the primitive**, and it flows to every
consumer (confirm with `npm run verify:all`). A page is components *dragged in* — layout +
content only. **Only prototypes are exempt** (they copy and may fork/break). Don't re-introduce
per-folder asset copies — that was the old drift bug.

**Disciplines:** primitives are the durable asset (source-derived). Pages are pure assembly so
primitive gains flow into them for free; they're also the user's prototyping *starting point*
(pre-wired flows), so keep them clickable and hooked together.

**CSS files (edit the right one, all under `gv-design-system/skills/govocal-ui/`):**
`govocal-tokens.css` (rarely) · `govocal-primitives.css` (shared atoms — both surfaces) ·
`govocal-ui.css` (FO components, `@import`s primitives) · `govocal-bo.css` (BO chrome) ·
`govocal-survey.css` (the opt-in survey field kit, paired with `govocal-survey.js`). **Agents
split FO vs BO**; whoever needs a shared atom edits `govocal-primitives.css`. Append new rules,
don't reflow existing ones, and commit often so a co-worker's commit can't sweep half-finished
state.

**Discovery-phase working agreement (while still matching screens to the real UI):**
- The guards are **harden-checkpoints, not iteration-gates**. They govern ONLY the `gv-`
  namespace. Experiment freely with page-local non-`gv-` classes and literal values; the lint
  ignores everything outside `gv-`. Run `lint` before you *store* a piece, not mid-build.
- **Tokenize by judgment, case-by-case** — no rule forcing premature abstraction. Match the real
  screen first; promote a value to a token/primitive when the pattern recurs. The real product
  hardcodes CSS too, so canonical may hold genuine one-off literals (lint never checks
  canonical). Tokenize what's *systemic* (the design language), leave one-offs literal.
- **`verify:all` is advisory** — a red means a primitive change moved another checkpoint; review
  and re-capture it, don't treat it as a hard stop. Primitives are *meant* to churn while we
  learn; the ratchet shows blast radius so you change atoms knowingly.
- **Fidelity bar = numeric verify + eyeball:** a piece is "aligned" when its probed checkpoints
  pass AND a screenshot matches the real capture. Build against `styles.json` digest values,
  never approximate off the PNG.

> **Parked backlog** (build only when this mode is active): refine the existing `.gv-*`
> primitives (`header-nav`, `footer`, `project-card`, `hero`) vs the real product, and build the
> remaining reference Pages one at a time — Content Builder, Survey Builder, Perspectives,
> Voting, Common Ground, Ideation, Project List. (The project-configuration editor is already
> built — `pages/bo-project-phase/`.)

### Future modes (not built yet — don't assume them)

- **Go Vocal UI mode** — build a prototype in Go Vocal's real visual language (loads `govocal-ui`
  + the Go Vocal memory summary).
- **Testing mode** — run a prototype through personas + a11y, user corrects (loads `govocal-a11y`,
  `govocal-persona-critique`, `webapp-testing`).

## On-demand capabilities (pull only when asked / relevant)

None of these load by default. Reach for them when the task or the user calls for it.

- **Go Vocal product depth** — a minimal summary lives in agent memory. For depth (the
  Folder→Project→Phase→method model, exact vocabulary, roles, asset specs, accumulated working
  knowledge), read **`gv-workspace/GOVOCAL.md`**. Search it on a product doubt; don't auto-load.
- **Opportunity research** — each opportunity (in gv-workspace) has `research.md` / `context.md`
  describing the problem, users, and constraints. Read them when building in that opportunity and
  the context matters. Internal-only, never ship.
- **Go Vocal UI / fidelity** — `gv-design-system/skills/govocal-ui/` for real tokens and `.gv-*`
  components. **Never hardcode brand colours** when you use it — use
  `var(--gv-tenant-primary|secondary|text)` so cities re-theme via `?theme=`. Copy asset files
  into the prototype folder (prototypes are self-contained).
- **A11y audit** — `gv-design-system/skills/govocal-a11y/` + `npm run audit` (from the DS repo;
  design-level: contrast, use-of-color, zoom, target size). Run before a real handoff or when the
  user asks; report results in chat. Flag immediately if a request would bake in a *visual* a11y
  failure (color-only state, low-contrast text, disabled zoom, tiny targets).
- **Persona critique** — `gv-design-system/skills/govocal-persona-critique/` to critique a flow in
  character (participant/admin personas).
- **Review comments & annotations** — `npm run review` (`scripts/review.mjs`) reads reviewer
  threads straight from production and can resolve/reply/reopen/delete them. Needs
  `REVIEW_SITE_URL` + `REVIEW_EXPORT_KEY` in `.env.deploy`; the export key is a secret — never
  paste it in chat. The review overlay (`src/review/comments.js`,
  `Shift+C`) has two pin types: transient **comments** and always-on **annotations** (a comment
  promoted via the Aslam toggle — dev-delivery notes that render with review mode off and are
  **skipped on "resolve comments"**, so use `node scripts/review.mjs --open` for the actionable
  list and never resolve an annotation).
  - **Gate rule (bit twice — don't get bit again):** any file the overlay loads from `/__review/`
    (e.g. `comments.js`, `aslam.png`) **must be added to `isPublicPath()` in `src/_worker.js`**,
    or the password gate returns the login HTML in place of the asset (an `<img>` then silently
    fails). Same for any new asset embedded into public prototypes. Also avoid inline `data:`
    images for overlay UI — some browsers/blockers refuse to paint them; serve a real same-origin
    file instead.
  - **Screen contract (SPA prototypes):** the overlay scopes a comment to the screen it was made
    on. It keys off `<body data-gv-screen="…">`. Normal **multi-page** prototypes need nothing —
    scoping falls back to the URL. But a prototype that swaps "screens" **without changing the
    URL** (JS `display`/class toggles — e.g. the editor-builder's
    `setView`/`setFrame`/`setProjectState`/modals) **must publish its current screen** on
    `<body data-gv-screen>`, or comments bleed across every screen. Pattern (see
    `parallel-editor-builder-v*`): a small IIFE that composes a key from every visible-state axis
    (view + frame + state + phase + open modal), re-syncs after any click (deferred) and on load,
    and writes only when the key changes. Each distinct visible state = a distinct screen;
    off-screen comments are hidden entirely.
- **Dev-status pipeline** — each prototype card on its opportunity index carries a dev-facing
  status badge (Playground / In progress / Dev ready / Shipped / Parked), cycled by clicking on
  the live site, persisted to KV via `src/_worker.js`. When the user moves one to **Parked** or
  **Shipped**, that's the cue to consolidate learnings into `gv-workspace/GOVOCAL.md` and commit.
