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
  - [~] **Comments overlay** — `Shift+C` reveals a hidden review layer on any
        prototype: click to drop element-anchored pins, each a comment thread
        (reply/resolve/delete). Shadow-DOM so it can't clash with the prototype;
        inert inside the index previews. Shared via a KV-backed worker API
        (`/__review/api`); falls back to localStorage if the API is unreachable.
        Claude reads comments via `npm run comments` (secret-guarded export
        endpoint → gitignored `review-comments.local.md`). Client + worker + build
        wiring DONE and verified locally with `wrangler pages dev`.
        **Go-live pending** — needs the KV namespace + binding + export secret
        (see "Comments go-live" under Deploy & access).
  - [ ] **City colour theming** — switch a prototype's colour scheme per city via a
        URL param, e.g. `?city=1`, so the same prototype can be previewed in
        different cities' branding. Define the city→palette mapping centrally.

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
- [ ] **Comments go-live** — the review-comments code is shipped but the KV
      backend isn't wired yet. Steps:
  1. **(User)** Add **Workers KV Storage → Edit** to the deploy API token at
     dash.cloudflare.com/profile/api-tokens (currently Pages-only; `wrangler kv
     namespace list` fails with auth error 10000 until this is added).
  2. **(Claude)** Create a KV namespace, add a `wrangler.toml` binding it as
     `COMMENTS`, generate `REVIEW_EXPORT_KEY`, set it as a Pages secret
     (`wrangler pages secret put`) AND in gitignored `.env.deploy` (+
     `REVIEW_SITE_URL`), then deploy and verify `npm run comments` reads prod.
  - Until then the overlay still works per-browser via localStorage fallback;
    comments just aren't shared and Claude can't read them yet.
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
