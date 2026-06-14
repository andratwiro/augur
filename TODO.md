# TODO — GoVocal Prototypes

Pending work for this repo. Claude reads this at the start of each session and
surfaces what's next. Check items off (`- [x]`) as they land; add new ones freely.

## Skills & tooling
- [ ] Create a **WCAG 2.2 (AA) accessibility** skill for prototypes — checklist +
      patterns so every prototype meets accessibility guidelines by default.
- [ ] Create a **govocal-ui** skill — reusable UI components / snippets for
      prototypes (complements the existing `skills/govocal-design/`).

## Context for agents
- [ ] Add a **GoVocal product context file** — what GoVocal is, its vocabulary,
      the product itself, and key concepts, so agents can ramp up fast.
      (Internal-only — keep it OUTSIDE any `prototypes/` folder so it never ships.)
- [ ] Add a **link to the GoVocal repository** (and any other key references) so
      Claude can jump in and research the real product quickly.

## Deploy & access
- [ ] **Roll the Cloudflare API token** — it was pasted into chat. My Profile →
      API Tokens → ⋯ → Roll (or Delete). Setup no longer needs it.
- [ ] (Optional) **Auto-deploy on git push** — one-time GitHub↔Cloudflare OAuth in
      the dashboard (Workers & Pages → govocal-prototypes → Settings → Builds &
      deployments → Connect to Git). Until then deploys are manual:
      `node build.js && npx wrangler pages deploy dist --project-name govocal-prototypes --branch main`
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
  `3d37adccf204bcf2ca53a33b00c5886d`).
