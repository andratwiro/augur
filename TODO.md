# TODO — GoVocal Prototypes

Pending work for this repo. Claude reads this at the start of each session and
surfaces what's next. Check items off (`- [x]`) as they land; add new ones freely.

## Skills & tooling
- [x] Create a **WCAG 2.2 (AA) accessibility** skill for prototypes — checklist +
      patterns so every prototype meets accessibility guidelines by default.
      → `skills/govocal-a11y/`: build-by-default checklist + tripwire patterns, plus
      `audit.mjs` (axe-core headless, WCAG 2.2 AA) via `npm run audit`. Non-blocking:
      flags violations in chat. Wired into CLAUDE.md as a hard rule.
- [ ] Create a **govocal-ui** skill — reusable UI components / snippets for
      prototypes (complements the existing `skills/govocal-design/`).

## Context for agents
- [ ] Add a **GoVocal product context file** — what GoVocal is, its vocabulary,
      the product itself, and key concepts, so agents can ramp up fast.
      (Internal-only — keep it OUTSIDE any `prototypes/` folder so it never ships.)
- [ ] Add a **link to the GoVocal repository** (and any other key references) so
      Claude can jump in and research the real product quickly.

## Prototype review environment
- [ ] Turn the prototypes link into a proper **dev review environment** for
      capturing output/feedback, not just a list of links. Includes:
  - [x] **Carousel** navigation — big preview carousels on both the landing page
        (live-iframe cover per opportunity) and the opportunity page (live preview
        per prototype). Arrow buttons, dots, keyboard ←/→, scroll-snap; controls
        auto-hide when there's a single slide. (`build.js` shell + `CAROUSEL_JS`.)
  - [x] **Download HTML** button — on the opportunity (pre-prototype) page, each
        prototype card has a `↓ Download HTML` button that grabs its entry HTML
        (same-origin `download` attr, filename = prototype slug).
  - [ ] **Comments overlay** — a way to leave comments on top of a prototype
        (pin/annotate + a comment thread) so reviewers can capture feedback.
  - [ ] **City colour theming** — switch a prototype's colour scheme per city via a
        URL param, e.g. `?city=1`, so the same prototype can be previewed in
        different cities' branding. Define the city→palette mapping centrally.

## Review & critique
- [ ] **Screenshot review** — a skill/flow for Claude to screenshot a prototype
      and visually review its own work. (Note: the built-in `run` / `verify`
      skills can already drive the app and capture screenshots — decide whether to
      lean on those or wrap a dedicated `govocal-screenshot` skill.)
- [ ] **Persona design critique** — a skill to walk through a prototype "in
      character" as a user persona I describe (e.g. low-tech, older, low
      digital-literacy, screen-reader user) and produce a design critique from
      that lens. Personas should be parameterizable/describable per run.

## Deploy & access
- [x] **Rolled the Cloudflare API token** — old (leaked) value invalidated; new
      token lives in gitignored `.env.deploy`. Deploy verified via `npm run deploy`.
- [x] **Auto-deploy on git push** — GitHub Actions (`.github/workflows/deploy.yml`)
      builds and runs `wrangler pages deploy` on every push to `main`, using the
      `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets. (Chose Actions
      over Cloudflare's native Git integration since the project is Direct Upload
      and can't be converted.) Local deploys still work via `npm run deploy`.
- [ ] Add real prototypes for the `departments/` opportunity (currently empty).

## Recently done
- [x] Deployed to Cloudflare Pages (Direct Upload) → https://govocal-prototypes.pages.dev
- [x] Password gate: custom login page (password-only, no username) via `src/_worker.js`;
      password is the `SITE_PASSWORD` Pages secret.
- [x] Two-level nav (opportunities → prototypes → prototype) + 4 sample prototypes
      under `parallel-participation/`.

## Notes
- Mark items done with `- [x]`. Keep this file at the repo root; it is internal
  and never copied into `/dist`.
- Deploys need `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (account
  `3d37adccf204bcf2ca53a33b00c5886d`), kept in gitignored `.env.deploy`. Deploy
  with `npm run deploy` (sources `.env.deploy`, builds, then wrangler-uploads).
