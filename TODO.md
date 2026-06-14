# TODO — GoVocal Prototypes

Pending work for this repo. Claude reads this at the start of each session and
surfaces what's next. Check items off (`- [x]`) as they land; add new ones freely.

## Skills & tooling
- [x] Create a **WCAG 2.2 (AA) accessibility** skill for prototypes — checklist +
      patterns so every prototype meets accessibility guidelines by default.
      → `skills/govocal-a11y/`: build-by-default checklist + tripwire patterns, plus
      `audit.mjs` (axe-core headless, WCAG 2.2 AA) via `npm run audit`. Non-blocking:
      flags violations in chat. Wired into CLAUDE.md as a hard rule.
- [x] Create a **govocal-ui** skill — reusable UI components / snippets for
      prototypes (complements the existing `skills/govocal-design/`).
      → `skills/govocal-ui/`: design tokens (`govocal-tokens.css`) + component CSS
      (`govocal-ui.css`, `.gv-*`) transcribed from `CitizenLabDotCo/citizenlab`
      @ 5d67730, a `components.md` catalog, a live `gallery.html`, and a per-city
      `?theme=` switcher (`govocal-themes.js`). Wired into CLAUDE.md. The 4 sample
      prototypes were retrofitted to use `--gv-tenant-*` vars + the switcher.
      Default `--gv-tenant-primary` nudged to AA-safe `#E10069` (exact brand
      `#ef0071` fails white-text AA by 0.23); all 4 prototypes pass `npm run audit`.
      → `skills/govocal-ui/`: source-grounded tokens + component CSS + `?theme=`
        city switcher + copy-paste catalog (`components.md`). Transcribed from the
        real `@citizenlab/cl2-component-library`.

## Review site — Patterns + Pages reference tabs
A top-right tab nav on the Cloudflare review site: **Prototypes · Patterns ·
Pages**. Prototypes stays the main page (`/`); Patterns + Pages are a glossary
for designers to review and copy from, so we never rebuild GoVocal twice.
- [x] **3-tab nav in `build.js`** — top-right `Prototypes · Patterns · Pages`,
      self-contained styles, injected into the gallery + generated index pages.
- [x] **Patterns tab** — the govocal-ui gallery shipped to `/patterns/` (build.js
      copies `skills/govocal-ui/gallery.html` + assets out of the skill). Live.
- [x] **Pages tab** — composed reference pages from a top-level `pages/<name>/`
      folder, carousel + Open/Download like prototypes. Live with 2 samples
      (`homepage` = Stadt Wien reference rebuild, `hello-world`).
- [ ] **More Pages** — project page, input form, map, page builder (one at a time,
      each reviewed for compliance before it lands).

## Cookie consent (resident-facing rule)
- [x] **Cookie-consent pattern** — `skills/govocal-ui/govocal-cookies.js`: drop-in
      English Edit/Decline/Accept dialog, themeable, shown first on resident/
      participant prototypes; admin/backend skip it. Rule in CLAUDE.md + components.md,
      demoed in the gallery (button-triggered). Scoped to real prototypes under
      `<opportunity>/prototypes/` — the Pages-tab reference reproductions do NOT show
      it (a blocking modal obscures the reference designers study/copy).

## Known a11y flags (faithful-but-flagged)
- [ ] **`gv-badge.inverse` looks like a rendering bug** — renders coloured text on
      grey (`#04884c` on `#bdbdbd`, 2.41:1) instead of filling with the colour +
      white text as `components.md` describes. Fix in `govocal-ui.css` or its usage.
- [ ] **Orange status label** (`--gv-orange-500` + white = 2.9:1) and the homepage
      **Klimateam placeholder tiles** (coloured text on coloured stand-in "photos")
      fail contrast. Decide keep-faithful vs nudge; tiles become real photos anyway.

## Context for agents
- [ ] Add a **GoVocal product context file** — what GoVocal is, its vocabulary,
      the product itself, and key concepts, so agents can ramp up fast.
      (Internal-only — keep it OUTSIDE any `prototypes/` folder so it never ships.)
- [ ] Add a **link to the GoVocal repository** (and any other key references) so
      Claude can jump in and research the real product quickly.
      → Done: public support/help base https://support.govocal.com/en/ (browsable,
        no login) saved as a reference. Still pending: the GoVocal source repo link.

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
  - [x] **Comments overlay** — `Shift+C` reveals a hidden review layer on any
        prototype: click to drop element-anchored pins, each a comment thread
        (reply/resolve/delete). Shadow-DOM so it can't clash with the prototype;
        inert inside the index previews. Shared via a KV-backed worker API
        (`/__review/api`); falls back to localStorage if the API is unreachable.
        Claude reads comments via `npm run comments` (secret-guarded export
        endpoint → gitignored `review-comments.local.md`). **LIVE on prod** —
        KV bound, export verified end-to-end (write → worker → pull script).
  - [x] **City colour theming** — switch a prototype's colour scheme per city via a
        URL param. Implemented as `?theme=N` in `skills/govocal-ui/govocal-themes.js`:
        a central `GV_THEMES` map drives the three tenant CSS vars
        (`--gv-tenant-primary/secondary/text`) plus an on-screen swatch picker.
        Templates: 0 GoVocal · 1 Ocean · 2 Forest · 3 Royal · 4 Sunset (extend the
        map to add cities). Prototypes must build with the tenant vars to re-skin.

## Review & critique
- [x] **Screenshot review** — capture is done: `skills/webapp-testing/` (Playwright,
      `.venv/bin/python`) handles screenshots, and CLAUDE.md hard-mandates "screenshot
      it + report in chat" on every front-end change. Decision: lean on existing tools,
      do NOT build a separate `govocal-screenshot` skill (redundant). The "visually
      review its own work" half is folded into the Persona critique item below.
- [ ] **Persona design critique** — a skill to walk through a prototype "in
      character" as a user persona I describe (e.g. low-tech, older, low
      digital-literacy, screen-reader user) and produce a design critique from
      that lens. Personas should be parameterizable/describable per run. (This is
      also the home for the structured "visually review the work" flow — screenshot
      via `webapp-testing`, then critique through the persona + design/a11y lenses.)

## Deploy & access
- [x] **Rolled the Cloudflare API token** — old (leaked) value invalidated; new
      token lives in gitignored `.env.deploy`. Deploy verified via `npm run deploy`.
- [x] **Auto-deploy on git push** — GitHub Actions (`.github/workflows/deploy.yml`)
      builds and runs `wrangler pages deploy` on every push to `main`, using the
      `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets. (Chose Actions
      over Cloudflare's native Git integration since the project is Direct Upload
      and can't be converted.) Local deploys still work via `npm run deploy`.
- [x] **Comments go-live** — KV backend wired for the review-comments overlay.
      Token got **Workers KV Storage → Edit**; created KV namespace
      `gv_review_comments` (id `98062803805e48a9a061cac648a1446f`), bound as
      `COMMENTS` at the **project level** via the Pages API
      (`deployment_configs.{production,preview}.kv_namespaces`, merged so
      `SITE_PASSWORD` was preserved) so both local and CI deploys inherit it.
      Generated `REVIEW_EXPORT_KEY`, set as a Pages secret + in gitignored
      `.env.deploy` (with `REVIEW_SITE_URL`). Verified end-to-end on prod:
      seeded KV → export endpoint (key-guarded, 403 on wrong key) →
      `npm run comments`. NOTE: bindings are project-level (not in repo), so a
      `wrangler.toml` is intentionally NOT used — don't add one expecting CI to
      set bindings.
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
