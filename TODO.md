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

## ⭐ Main pending work — UI-compliant building blocks

The priority now is making the shared UI layer trustworthy end-to-end, so that a
prototype assembled from our primitives + pages is **actually compliant with the
real GoVocal UI** (visually faithful, themeable, a11y-clean) with no per-prototype
re-litigation. Three threads, interlocking:

- [ ] **Components / Primitives — test & refine** — the `components/<name>/` library
      (live on the **Components** tab) and the shared `.gv-*` CSS it draws from
      (`skills/govocal-ui/govocal-ui.css`). Goal: each primitive is a faithful,
      reusable, source-grounded building block.
  - Current set: `header-nav`, `footer`, `project-card`, `hero` (see
    `components/manifest.md`).
  - [ ] **Test each primitive**: screenshot (mobile + desktop) vs. the real product,
        run `npm run audit`, check every state + `?theme=` re-skin. Fix drift in the
        shared CSS (never fork it — `manifest.md` rule).
  - [ ] **Refine + grow the set**: tighten the existing 4, then add the primitives a
        prototype actually needs (e.g. buttons/inputs/forms, idea card, status pill,
        tabs, avatars/meta, modal/dialog). One at a time, each verified before it lands.
- [ ] **More Pages** — composed reference pages on the **Pages** tab: project page,
      input form, map, page builder (one at a time, each reviewed for compliance
      before it lands). These compose the primitives into full surfaces.
- [ ] **Prove the loop** — build (or retrofit) at least one real prototype purely
      from the refined primitives/pages to confirm the building blocks hold up in a
      real assembly and stay compliant.

### Review-site tabs (shipped)
A top-right tab nav on the Cloudflare review site: **Prototypes · Primitives ·
Components · Pages** — atoms → blocks → screens. Prototypes stays the main page (`/`);
the other three are a layered glossary for designers to review and copy from, so we
never rebuild GoVocal twice.
- [x] **4-tab nav in `build.js`** — `Prototypes · Primitives · Components · Pages`,
      self-contained styles, injected into the gallery + generated index pages.
- [x] **Primitives tab** (renamed from Patterns → `/primitives/`) — the govocal-ui
      gallery: tokens (colour/type/shadow) + base `.gv-*`. build.js copies
      `skills/govocal-ui/gallery.html` + assets out of the skill. Live.
- [x] **Components tab** — composed blocks from `components/<name>/`, shown as a
      **table** with a small live preview per row (`renderComponentsIndex`). build.js
      auto-discovers each subfolder; `components/manifest.md` is the recall index.
      Live with 4 (`header-nav` responsive/CSS-only drawer, `footer` w/ real go·vocal
      logo, `project-card`+rail stretched-link, `hero`).
- [x] **Pages tab** — composed reference pages from `pages/<name>/`, now a **4-up
      vertical grid** (was a carousel) for fast scanning + Open/Download. `homepage`
      rebuilt on the new components (high-fidelity Stadt Wien match; real footer logo).

## Cookie consent (resident-facing rule)
- [x] **Cookie-consent pattern** — `skills/govocal-ui/govocal-cookies.js`: drop-in
      English Edit/Decline/Accept dialog, themeable, shown first on resident/
      participant prototypes; admin/backend skip it. Rule in CLAUDE.md + components.md,
      demoed in the gallery (button-triggered). Scoped to real prototypes under
      `<opportunity>/prototypes/` — the Pages-tab reference reproductions do NOT show
      it (a blocking modal obscures the reference designers study/copy).

## Context for agents
- [x] Add a **GoVocal product context file** — what GoVocal is, its vocabulary,
      the product itself, and key concepts, so agents can ramp up fast.
      (Internal-only — keep it OUTSIDE any `prototypes/` folder so it never ships.)
      → `GOVOCAL.md` at repo root. Synthesized from all ~70 support-base articles
      (`support.govocal.com`, read 2026-06-14) + **Appendix A source-grounded
      from the repo** (`CitizenLabDotCo/citizenlab` @ 5d67730: exact participation-
      method keys, idea statuses, voting/reaction/input-term enums, front-office +
      admin URL patterns, survey/form `input_type` field types). Tiered: §1 big-
      picture + §2 vocabulary first, reference below, Appendix A = literal data
      model. NOT in a `prototypes/` folder, so `build.js` never ships it.
      **Wired in:** read at session start + referenced from govocal-design/ui
      skills + design-system section (CLAUDE.md).
      **Living doc:** §13 "Working knowledge" + a CLAUDE.md "Keeping GOVOCAL.md
      alive" rule — fold in learnings from convos / `research.md` / reviewer
      feedback as we go, so it becomes a faithful representation of the user's
      thinking about the project.
- [x] Add a **link to the GoVocal repository** (and any other key references) so
      Claude can jump in and research the real product quickly.
      → Public support/help base https://support.govocal.com/en/ (browsable, no
        login) saved as a reference. Source repo: github.com/CitizenLabDotCo/citizenlab
        (saved in memory + pinned in `skills/govocal-ui/SKILL.md`).

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
- [x] **Persona design critique** — `skills/govocal-persona-critique/`: a canon
      persona roster (`personas.md` — participants: Down syndrome, neurodivergent,
      low-literacy/older, non-native, savvy techie; admins: reluctant tender-assigned,
      quick-survey officer, expert participation officer, moderator) with per-run
      override, plus a critique runner (SKILL.md): screenshot via `webapp-testing`
      (mobile-first), walk the task in character, judge through persona + a11y +
      design lenses, output an in-character narrative + severity-ranked findings.
      Scoped to prototypes only; agent proactively offers the lens when building one.
      Wired into CLAUDE.md (skill table + mobile-first/proactive rule).

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
- [ ] Add real prototypes for the `departments/` opportunity. (Scaffolded with two
      hello-world placeholders: `department-spaces`, `sms-verification` — still need
      real flows.)

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
