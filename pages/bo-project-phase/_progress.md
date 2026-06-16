# bo-project-phase — deep-fidelity build ledger (INTERNAL, never ships)

Cross-pass memory for the high-fidelity build of the back-office project-**phase**
configurator (`pages/bo-project-phase/index.html`). Lives OUTSIDE `prototypes/` so it
is never published. System-building mode.

Real source = auth-gated demo tenant **`uxusertesting.govocal.com`** (City of Raleigh),
captured with `npm run capture` (session in `scripts/capture/.auth/`, creds in
`.env.capture`). `styles.json.digest` = exact computed values; never eyeball `page.png`.

---

## Pass 0 — setup (DONE 2026-06-16)

### Capture auth — CONFIRMED WORKING
Ran a live probe capture of `/admin/projects` → returned the authenticated admin page
(72 distinct treatments, project rows, no sign-in form). The `.auth/state.json` shows
empty cookies but the persistent context still authenticates at runtime, so captures
succeed. **No re-login needed.** If a future capture bounces to sign-in, run:
`npm run capture -- <url> --name <slug> --probe "<sel>" --login --headed`.

### CANONICAL participation-method list (resolved from GOVOCAL.md §4 + Appendix)

The "7 vs 8" question: the **method picker shows 8 phase methods**. GOVOCAL.md §4 lists
8 phase options; "Poll" and "External survey" are *adjacent / non-phase* methods that
ALSO appear as choices in the live picker; the data model (Appendix A1) has 11 internal
keys (incl. inheritance + community_monitor_survey). For THIS page the relevant set is
the phase-method picker. Native vs paid:

| # | UI label (picker) | internal key | native / add-on | notes |
|---|---|---|---|---|
| 1 | **Collect input and feedback** (Ideation) | `ideation` | native | core method; List/Map/Feed views; title field locked |
| 2 | **Conduct a voting or prioritization exercise** | `voting` | native | 3 voting_methods: single_voting / multiple_voting / budgeting. Specialized ideation. |
| 3 | **Create a survey** (native) | `native_survey` | native | form-builder; rich field set; NO draft phase |
| 4 | **Proposals, petitions or initiatives** | `proposals` | native | up-vote only, threshold + cosponsors. Specialized ideation. |
| 5 | **Find common ground** (Beta) | `common_ground` | native | ≤120-char statements; agree/unsure/disagree; votes final |
| 6 | **Share information** | `information` | native | one-way; hosts Reports + embedded external survey host |
| 7 | **Recruit participants or volunteers** | `volunteering` | native | causes + signup button each |
| 8 | **Collect feedback on a document** | `document_annotation` | **PAID add-on (Konveio)** | one PDF/phase |

Adjacent picker options also surfaced in-product:
- **Poll** (`poll`) — native, single/multi choice only; no analytics/report builder.
- **Externally hosted survey** (`survey`) — native wrapper; embeds Typeform/Google/etc;
  URL set at phase creation only. `survey` ≠ `native_survey`.

So: **8 phase methods in the picker**, of which **1 is a paid add-on (document
annotation / Konveio)**; the rest are native. Plus 2 adjacent native picker options
(poll, external survey). This is the authoritative set for the per-method passes.

### Current page state (read 2026-06-16, 1328 lines)
Built deeply during the 5-run BO sweep. Existing sub-tab panels (`data-sub`):
- **setup** (ideation) — method picker (8 cards), user anonymity, action toggles — BUILT
- **votingsetup** — voting method cards + EUR Total/Min/Max + toggles — BUILT
- **pollsetup**, **volunteeringsetup**, **commongroundsetup**, **informationsetup** — BUILT (method-specific setup forms)
- **poll** (questions list), **volunteering** (causes), **report** (common-ground summary), **surveyresults** (external export) — BUILT
- **access** (Phase access and user data) — PARTIAL: a `.gv-bo-accordion` with 4 who-can-X
  rows (submit/comment/react/event), each with auth-flow radios; user-anonymity toggle is
  on the setup panel. **No user-data tier UI, no folder/project/phase nesting, no
  registration-fields/demographic-questions block yet.** ← PRIORITY for pass 9.
- **notifications** (phase-emails), **inputimporter** — BUILT

### Baseline gates
- `npm run verify:all`: **130 green · 1 red**. The 1 red is NOT a bo-project-phase
  checkpoint (none of the 16 `bo-project-phase/*` checkpoints fail) — it is a pre-existing
  FO red from concurrent work, out of scope. Advisory; will re-confirm it stays non-mine.
- 16 registered `bo-project-phase/*` checkpoints (setup/general/imgr/inputform/insights/
  canvas/content-card/topbar/tabstrip/tab-*/form-card) — all green.

---

## 10-pass plan

Per-pass loop: state-read → capture(`--probe`) → build (assemble `.gv-*`, tokenize) →
verify numeric (`--map`) → verify visual (screenshot vs page.png) → ratchet checkpoint +
`verify:all` + `lint` → recheck 2 nearest sections → ledger + commit (stage only touched
paths, never `git add -A`).

| Pass | Facet | Current | Priority |
|---|---|---|---|
| 1 | **Ideation** setup/config fidelity | partial-ok | normal |
| 2 | **Voting / prioritization** (3 voting_methods) setup | partial-ok | normal |
| 3 | **Native survey** setup + link to form builder | partial | normal |
| 4 | **Proposals / petitions** setup (threshold, cosponsors, up-vote only) | MISSING dedicated panel | normal |
| 5 | **Common ground** setup + report | partial-ok | normal |
| 6 | **Information** setup (minimal) | partial-ok | normal |
| 7 | **Volunteering** setup + causes | partial-ok | normal |
| 8 | **Document annotation** (Konveio, paid) + **Poll** + **External survey** adjacent | MISSING doc-annotation | normal |
| 9 | **Phase access** — 4 auth flows × folder/project/phase nesting + anonymous toggle | PARTIAL — biggest gap | **HIGH / deepest** |
| 10 | **User data** — 3 PII/demographic tiers + registration fields | MISSING | **HIGH / deepest** |
| 11 | Final audit — verify:all + lint green; written gap list | — | — |

Passes 9 + 10 (access + user data) are the priority: most stable/latest passes, deepest
verification. For each method pass, build the method-specific Setup form AND surface its
access/data sub-tab differences (e.g. ideation has comment/react auth rows; survey/info
do not; survey defaults to mandated anonymity).

### Open product questions to resolve before guessing (search GOVOCAL.md / support)
- Exact auth-flow option labels & per-method availability (does "None / anyone unregistered"
  appear only for surveys/ideation/proposals? GOVOCAL.md §3 says yes — confirm in capture).
- User-data tier UI: is it a 3-way radio or a per-field toggle set? (capture access-rights).
- Folder/project/phase inheritance UI (does phase inherit project access by default with an
  override?). Re-capture `r1-pe-access-rights` was flagged under-captured — RE-CAPTURE with
  longer settle / `--click` on the accordion.

---

## Per-pass log
(append one entry per completed pass: facet, captures used, checkpoints added, surprises,
open items)

### Pass 1 — Ideation (DONE 2026-06-16)
- Capture: `r1-pe-ideation-setup` (on disk). Digest confirmed established tokens — navy
  `#044D6C` labels 18/500, green toggle `#04884C`, meta `#84939E`, cool-grey `#43515D`; all
  already aliased to `--gv-*`, no new tokens.
- **SURPRISE / 7-vs-8 refined:** the live method picker on THIS tenant shows **7 cards, not 8**.
  Document annotation (Konveio, paid) is NOT provisioned here; poll / external-survey are NOT
  separate picker cards on this capture. Real 7 cards (exact DOM order + copy): Collect input
  and feedback in public · Proposals, petitions or initiatives · Find common ground · Create a
  survey · Conduct a voting or prioritization exercise · Share information · Recruit participants
  or volunteers. The 8th (doc annotation) appears only when the add-on is enabled.
- **BUILD:** ideation `setup` panel previously had 8 paraphrased cards (incl. fabricated
  poll / external-survey / doc-annotation cards + wrong copy "public space"). Replaced with the
  exact real 7-card set + verbatim copy ("public forum"), matching the `votingsetup` set. Rest
  of the panel (anonymity, naming, actions, likes/dislikes, similar-input thresholds, views,
  sorting, attachments) already faithful — kept.
- VERIFY: `lint` 0 violations. Ideation capture has no `probed` selectors → numeric coverage
  stays on `bo-phase-setup` (setup-input/select, unaffected by copy-only change). Picker copy
  verified by exact grep vs `r1-pe-ideation-setup/dom.html`.
- Checkpoints: none added (copy fidelity, not new measurable style).
- Open: confirm whether poll & external-survey picker cards appear under a feature flag
  (defer to pass 8).

### Pass 2 — Voting / prioritization (DONE 2026-06-16, no build change needed)
- Capture: `r1-pe-pb-ph1-setup` (Participatory Budget – District 2, budgeting phase). Digest
  99 entries, no probes.
- State: the `votingsetup` panel was already fully faithful. **3 voting-method cards verified
  verbatim vs DOM**: "One vote per option" (single_voting/approval — "Users can chose [sic] to
  approve any of the options"), "Multiple votes per option" (multiple_voting/cumulative —
  "Users are given an amount of tokens to distribute between options"), "Budget allocation"
  (budgeting — exact long desc match incl. the product's real typo "chose"). EUR Total-budget
  Min/Max row, comment/filter/auto-share toggles, similar-input detection, List/Map views,
  attachments all present and on-token.
- GOVOCAL.md A3 cross-check: budgeting state shows Min/Max total (correct). multiple_voting
  would swap to votes-per-participant/votes-per-option fields — panel is pinned to the
  budgeting state so current fields are right. (Future: could add JS to swap the budget row
  when a different voting-method card is picked — noted, not required for fidelity.)
- VERIFY: card copy grep-matched vs `r1-pe-pb-ph1-setup/dom.html`; `lint` 0 violations.
- Checkpoints: none added (no measurable-style change this pass).

### Pass 3 — Native survey (DONE 2026-06-16)
- Captures: `r1-pe-survey-external-setup` (actually the native "Public Healthcare Opinions
  Survey" phase Setup), `r1-pe-survey-form-edit` (form builder — already its own page
  `bo-survey-builder`), `r1-pe-survey-results`.
- **GAP found:** no native-survey Setup variant existed. The page had a `surveyform` tab
  (links to bo-survey-builder) and a `surveyresults` panel, but no `surveysetup` and no
  survey phase in the ribbon — so the survey method's per-method Setup differences weren't
  visible.
- **BUILD:** added `data-sub="surveysetup"` panel (minimal pattern, `pp-methodgrid`
  data-method="survey", all canonical `.gv-*`): Edit-Phase header, 7-card picker w/ "Create
  a survey" selected, **no-draft banner** ("goes live as soon as the phase starts — toggle
  Open for responses off to pause"), Survey-form link, **Open for responses** toggle,
  **mandated/anonymous-by-default** toggle (GOVOCAL.md §3 + §4: surveys default mandated
  anonymity). Added a **Community survey** phase to the PHASES ribbon (method "Survey phase",
  sub-tabs setup·description·surveyform·surveyresults·access·notifications — correctly NO
  input-manager/form/poll). Also fixed the shared `METHODS[collect]` description "public
  space"→"public forum" to match the real DOM (flows to all minimal-grid panels).
- VERIFY: `lint` 0; screenshot eyeballed (panel renders w/ correct chrome, ribbon, sub-tab
  set, picker selection, toggles); `verify:all` 130 green · 1 red (UNCHANGED from baseline —
  the red is the same pre-existing non-bo-project-phase FO checkpoint, not mine).
- RECHECK: information + voting setup panels intact (only shared-array string + additive
  panel/phase touched).
- Checkpoints: none added (panel reuses already-checkpointed primitives; no new measurable
  style — survey capture has no probes).
- Open: native survey *results* are per-question charts in the real product; the page reuses
  the external-export `surveyresults` panel for both. Acceptable for now; deeper per-Q survey
  results = future (would belong on bo-survey-builder or a results variant).

### Pass 4 — Proposals / petitions / initiatives (DONE 2026-06-16)
- **NEW CAPTURE:** `r2-proposals-setup` — captured the live new-phase form with
  `--click "#e2e-participation-method-choice-proposals"` to reveal proposal-specific fields
  (the SPA renders them only after selecting the card). Confirmed authenticated (0 signed-out
  markers, 7 `e2e-participation-method-choice-*` present, admin chrome). NOTE: method cards
  are `id="e2e-participation-method-choice-<key>"` (ids, not classes).
- **Real proposal-specific fields (measured, not guessed):** "Minimum number of votes to be
  considered" (threshold) + "Number of days to reach minimum number of votes" (time limit).
  Naming dropdown defaults to **Proposal** and adds **Initiative / Petition** (full option
  list captured). No "Submitting posts" toggle and no disliking field — proposals are
  **up-vote only** (matches GOVOCAL.md A1: proposals = ideation minus dislike).
- **BUILD:** added `data-sub="proposalssetup"` panel (all canonical `.gv-*`): Edit-Phase
  header, picker w/ proposals selected, **Proposal requirements** (min-votes 300 + days 90 +
  threshold-reached info banner), anonymity, naming→Proposal, Actions (comment/react + likes,
  NO dislike). Added a **Submit a proposal** phase to the ribbon (Proposals phase; sub-tabs
  setup·description·inputmgr·inputform·insights·access·notifications — proposals DO have an
  Input manager + statuses).
- **Also:** added the real **BETA badge** to the Find-common-ground method card (seen in the
  capture screenshot). Required a 1-line primitive add: `.gv-bo-methodcard__art { position:
  relative }` in `govocal-bo.css` to anchor the pill (layout-only, harmless to all consumers).
  Rendered the badge as canonical `.gv-bo-typebadge.is-type`.
- VERIFY: `lint` 0; screenshot eyeballed (panel + ribbon + sub-tabs + min-votes/days +
  up-vote-only actions + BETA pill all correct vs capture); `verify:all` **130 green · 1 red
  UNCHANGED** — the primitive `position:relative` add caused ZERO regression (layout-only,
  no probed computed-style moved).
- RECHECK: ideation + survey setup panels intact (additive panel/phase + 1 layout-only
  primitive prop).
- Checkpoints: none added (no new measurable computed-style treatment; threshold inputs reuse
  the already-checkpointed `.gv-input`).
- NOTE: a sibling agent (spawned in parallel on the same plan) independently re-confirmed
  Pass-1 selected-card fidelity (`--gv-teal-75` bg / `--gv-bo-primary` 1px border / 3px / 16px
  pad) and left an extra untracked capture `govocal-exports/p1-ideation-setup/` — harmless,
  not staged by me. The sibling correctly detected the collision and stopped; I remain the
  sole driver.

### Pass 5 — Common ground (DONE 2026-06-16, no build change needed)
- Capture: `r1-pe-commonground-setup` (Test Polis, "Polis process" phase). Screenshot
  confirms the real **sub-tab set: Setup · Description · Report · Phase access and user data ·
  Notifications** — exactly what the page's commonground phase declares. (Header shows
  "Information phase" — the SPA active-phase trap from Run 1; my "Common ground phase" label
  is more correct.)
- State: `commongroundsetup` panel already faithful — Edit-Phase header, picker w/
  common-ground selected (now also showing the BETA pill from Pass 4), **Statements editor**
  (max-120-char inputs w/ live N/120 count, agree/unsure/disagree stance chips, drag handle,
  delete, Add-a-statement) matching GOVOCAL.md §4.5. The `report` panel (consensus stats +
  most-consensus rows) also present.
- VERIFY: `lint` 0; screenshot eyeballed vs capture (sub-tab set + form structure match).
- Checkpoints: none added.
- Open: common-ground `/report` *depth* (real-time results map, per-statement breakdown) is
  still backlog (flagged since Run 1) — current report panel is a faithful summary, not the
  full results map. Future enhancement.

### Pass 6 — Information (DONE 2026-06-16)
- Captures: `r1-pe-information-setup` + NEW `r2-information-setup` (info phase c8502d40). NOTE
  the **SPA active-phase trap**: both captures default-render the project's FIRST phase
  (Initial Survey) regardless of the phase ID in the URL — the info phase is phase 2 and needs
  a ribbon click to load. So the info-Setup screenshot actually shows the SURVEY phase. Useful
  side-effect: it confirmed the real **survey sub-tab set = Setup · Description · Survey form ·
  Insights · Phase access and user data · Notifications** and method label **"In platform
  survey phase"**.
- **BUILD (info):** the "Share information" method card lists "Link with in-platform report
  builder" as a feature (found in the card description DOM). Added a **Report** section to the
  `informationsetup` panel with a "Link with in-platform report builder" toggle (the real
  distinguishing info-phase feature). Kept the info sub-tab set minimal (setup·description·
  access·notifications) — deliberately did NOT add a Report sub-tab, because the only `report`
  panel is common-ground-consensus-specific and reusing it for info would misrepresent.
- **BUILD (survey, corrected from Pass 3):** changed the survey phase method label to "In
  platform survey phase" and added **Insights** to its sub-tab set
  (setup·description·surveyform·insights·surveyresults·access·notifications) per the capture.
- VERIFY: `lint` 0; screenshot eyeballed (info panel: read-only banner, report-builder toggle,
  minimal sub-tabs, picker on Share information w/ BETA pill on common-ground); `verify:all`
  130 green · 1 red UNCHANGED.
- RECHECK: survey + proposals panels intact.
- Checkpoints: none added.

### Pass 7 — Volunteering (DONE 2026-06-16, no build change needed)
- Capture: `r1-pe-volunteering` (Showroom / Participation Garage, "Find volunteers" phase).
- State: both panels already faithful. **Sub-tab set confirmed: Setup · Description ·
  Volunteering · Insights · Phase access and user data · Notifications** — matches the page's
  volunteering phase. `volunteeringsetup` (picker w/ volunteering selected, banner →
  Volunteering tab, attachments) + the `volunteering` causes panel (Export volunteers
  top-right, "Add cause" admin-dark+plus, cause rows = teal-link title · N participants ·
  Delete · Edit) all match the capture screenshot verbatim.
- VERIFY: screenshot eyeballed vs `r1-pe-volunteering/viewport.png`; `lint` 0.
- Checkpoints: none added.

### Pass 8 — Document annotation (paid) + Poll + External survey (DONE 2026-06-16)
- **DEFINITIVE 7-vs-8 resolution (measured from the live picker `id`s):** the real method
  picker on this tenant has EXACTLY 7 cards —
  `ideation · proposals · common_ground · native_survey · voting · information · volunteering`
  (confirmed via `e2e-participation-method-choice-<key>` ids in BOTH `r2-proposals-setup` and
  `r1-pe-survey-external-setup`). **Document annotation (Konveio) is NOT in the picker** (paid
  add-on, not provisioned here); **there is NO separate poll or external-survey card** —
  poll/external-survey are configured via other routes, not as phase-method cards on this
  tenant. Internal key for native survey is `native_survey` (not `survey`); the `survey` key
  (thin external embed) does not appear.
- **ANTI-FABRICATION:** since doc annotation cannot be captured (no add-on), I did NOT invent
  its Setup UI. Pass 1 already removed the previously-fabricated poll/external/doc-annotation
  picker cards, so the page is now correct (7 cards).
- **Poll — verified at fidelity** vs `r1-pe-poll` (Forest Gate Community Assemblies, "Voting
  on Top 3 Priorities" poll phase): the `poll` panel matches verbatim — "Polls settings and
  results" head, "Export the poll results" top-right, the long help paragraph, question rows
  w/ "Edit answer options · Delete · Edit question", "Add a poll question" admin-dark+plus.
  Sub-tab set Setup·Description·Poll·Insights·Access·Notifications matches the page's poll phase.
- **External survey** — `r1-pe-survey-external-setup` is actually a NATIVE survey phase
  (Run-1 misnomer); no embed-URL/provider fields exist on this tenant. The `surveyresults`
  panel (Typeform export) covers the external-results case faithfully.
- VERIFY: `lint` 0; no page change this pass (correctness was already achieved in Pass 1).
- Checkpoints: none added.
- Open: if a future tenant has the Konveio add-on, capture `document_annotation` Setup (one
  PDF/phase) and add an 8th picker card + a doc-annotation Setup panel. NOT buildable now
  without the add-on (would be fabrication).

### Pass 9 — Phase access (PRIORITY, DONE 2026-06-16) — biggest fidelity gain
- **NEW CAPTURES:** `r2-access-rights` (collapsed, confirmed title + 4 accordion rows) and
  **`r2-access-expanded`** — captured with `--click "text=Who can submit inputs?" --settle 2800
  --viewport 1440x2200` to expand the accordion and reveal the FULL real UI (the SPA lazy-loads
  it). This single screen turned out to cover BOTH Pass 9 (auth) AND Pass 10 (user data).
- **Real expanded "Who can submit inputs?" structure (measured + copy verbatim):**
  1. Toggle **"Admins and collaborators only"** (i) — the admins-only escape hatch.
  2. **Authentication** heading + AUTH-FLOW CARDS (NOT radios as I previously had): **None**
     [NEW badge] ("Anyone can participate without signing up or logging in.") · **Email
     confirmation** ("...confirm their email with a one-time code.") · **Account creation**
     [selected] ("...create a full account with their name, confirmed email and password.").
     Only 3 cards on this tenant — **no SSO/verification card** (SSO needs Support setup).
  3. **Restrict participation to user group(s)** — "Select group(s)" dropdown + "Customize
     error message" input (i).
  4. **Demographic questions asked to users** + green **Add a question** btn; radios "Ask
     demographic questions before user participates" [sel] / "Collect demographic questions by
     adding a new page to the end of the form"; question rows (Place of residence / Year of
     birth / Commuting Method, each "Optional · Enabled in global registration flow" + Edit +
     delete) with drag handles.
  5. A 4-step participant-flow preview: 1 Enter your email · 2 Confirm your email · 3 Enter
     name, last name, and password · 4 Complete the demographic questions above · ✓.
- **MEASURED auth-card values (digest entry 11, NOT eyeballed):** selected card = `1px solid
  rgb(2,35,49)` = **`--gv-blue-700`** on `rgb(237,248,250)` = **`--gv-teal-50`**, radius 3px,
  pad 16px. Both already tokens — mapped, not hardcoded.
- **BUILD:** replaced the old 4-radio accordion bodies with the real UI. Added page-local
  `.pp-auth*`/`.pp-restrict`/`.pp-demo*`/`.pp-flow*` CSS (all values via `--gv-*` tokens; only
  this page consumes it — PROMOTE to a `.gv-bo-authcard` primitive when a 2nd consumer lands).
  Submit row gets the full UI; comment/react rows get the auth-card row (admins-toggle +
  3 cards). Auth cards single-select via JS (mirrors method-card binding). The NEW badge uses
  canonical `.gv-bo-typebadge.is-type`; green Add-a-question uses `.gv-btn.success`.
- VERIFY: `lint` 0; screenshot eyeballed — near-exact match to `r2-access-expanded/viewport.png`
  (toggle, 3 auth cards w/ correct selected styling, group-restrict, demographic block,
  flow stepper); `verify:all` **130 green · 1 red UNCHANGED** (page-local + page-HTML only, no
  canonical edit).
- RECHECK: surveyresults + poll panels (adjacent sub-tabs) intact.
- Checkpoints: **deferred** — the auth cards' only stable selector is a hashed styled-component
  class (`div.sc-beqWaB.bhxslC`), too brittle for a durable harden-point; build is
  digest-grounded (entry 11) + eyeball-verified per the discovery-phase agreement. Revisit if
  GoVocal adds an `e2e-`/`data-testid` hook.
- Pass 10 (user data) is now LARGELY DONE here — the demographic-tier UI lives in this same
  accordion. Pass 10 will add the explicit 3-tier framing + registration-fields cross-ref.

### Pass 10 — User data (PRIORITY, DONE 2026-06-16)
- The bulk of user-data UI (demographic-questions block: Add-a-question, ask-before/collect-at-
  end radios, the 3 question rows w/ "Enabled in global registration flow") was already built in
  Pass 9 — on the real product it lives INSIDE the same expanded "Who can submit?" accordion,
  not a separate sub-tab. Confirmed there is **no separate user-data-tier widget** in the real
  UI (scanned the full `r2-access-expanded` DOM): the 3 tiers are a conceptual OUTCOME of
  auth-flow + the Setup anonymity toggle + whether demographics are asked, per GOVOCAL.md §3.
- **Registration-fields cross-ref:** the demographic questions ("Place of residence / Year of
  birth / Commuting Method") are sourced from Settings → Registration (default Gender / Year of
  birth / Place of residence) — confirmed against the `bo-set-registration` capture. The phase
  panel correctly labels them "Optional · Enabled in global registration flow".
- **BUILD:** to make the 3 tiers VISIBLE (brief requirement) WITHOUT fabricating a control the
  product lacks, added a `.gv-bo-banner` **"Resulting user data" explainer** below the flow
  stepper: states the current config = full PII + demographics (tier 1), and how None /
  anonymous / full-anonymity drop to tiers 2-3 (incl. "full anonymity removes demographics too
  and disables demographic reporting", GOVOCAL.md §3 + constraint line 271). Clearly an
  explainer, canonical banner, no invented form control.
- VERIFY: `lint` 0; screenshot eyeballed (explainer reads correctly, sits under the demographic
  block); `verify:all` 130 green · 1 red UNCHANGED.
- RECHECK: Setup anonymity toggle (the PII lever) still present on every method Setup panel —
  consistent with the tier explainer's reference to it.
- Checkpoints: none added (page-local explainer on a canonical banner; no new measurable
  treatment).

---

## Pass 11 — final audit (DONE 2026-06-16)

### Gates — GREEN
- **`npm run lint` → 0 violations** ("every component & page references canonical; nothing
  redefines or copies"). The hardwired layering holds; bo-project-phase authors only page-local
  `.pp-*` layout + content and reuses canonical `.gv-*` everywhere.
- **`npm run verify:all` → 130 green · 1 red.** The single red is
  **`homepage-spotlight-heading`** (`.gv-spotlight__heading` not found in
  `pages/homepage/index.html`) — a FRONT-OFFICE homepage checkpoint, NOT mine. `homepage/
  index.html` was already modified (concurrent FO work) at session start per git status; it was
  red at my Pass-0 baseline and stayed red+unchanged through all 11 passes. No bo-project-phase
  change touched it. **All bo-project-phase checkpoints (16) pass.**
- One canonical edit this sweep: `.gv-bo-methodcard__art { position: relative }` (Pass 4,
  layout-only) — caused ZERO checkpoint movement.

### What was achieved
- **7-card method picker** locked to the real tenant (measured `e2e-participation-method-choice`
  ids): ideation, proposals, common_ground, native_survey, voting, information, volunteering.
  BETA badge on common-ground.
- **Per-method Setup variants** all present + verbatim copy: ideation, voting (3 voting-methods +
  EUR budget), native survey (no-draft + open-for-responses + mandated anonymity), **proposals
  (NEW — threshold + time-limit + up-vote-only)**, common ground (statement editor), information
  (+ report-builder link), volunteering. Method-aware sub-tab sets + phase ribbon (10 phases).
- **Phase access (Pass 9)** rebuilt to the real expanded UI: admins-only toggle, 3 Authentication
  cards (None[NEW]/Email confirmation/Account creation), group-restrict, demographic block,
  4-step flow preview — all token-grounded (selected card = --gv-blue-700 / --gv-teal-50).
- **User data (Pass 10):** demographic-questions UI + 3-tier explainer, registration-fields
  cross-referenced to bo-set-registration.

### Gap list — still below the fidelity bar (for future passes; none are fabrication-safe now)
1. **Document annotation (Konveio) Setup** — NOT buildable: paid add-on, absent from this
   tenant's picker. Needs a tenant with the add-on to capture. (Correctly NOT fabricated.)
2. **External-survey embed config** (provider + survey_embed_url) — `survey` method not
   selectable on this tenant; no capture. The `surveyresults` Typeform-export panel stands in.
3. **Auth-card numeric checkpoint** — deferred: only a brittle hashed styled-component selector
   exists (`div.sc-beqWaB.bhxslC`). Build is digest-grounded (entry 11) + eyeballed. Add a
   harden-point if/when GoVocal exposes an `e2e-`/`data-testid` hook on the card.
4. **SSO / identity-verification auth card** — not shown on this tenant (SSO needs Support
   setup), so only 3 auth cards built. A 4th would be fabrication until captured.
5. **Common-ground `/report` depth** — current report panel is a faithful summary, not the full
   real-time results map / per-statement breakdown (flagged since Run 1).
6. **Native-survey per-question results** — page reuses the external-export `surveyresults`
   panel; real native results are per-Q bar/donut cards (belongs on bo-survey-builder or a
   results variant).
7. **Voting-method field swap** — voting Setup is pinned to the budgeting state (EUR Min/Max).
   multiple_voting/single_voting would swap to votes-per-participant fields; could add JS to
   swap on card-pick. Not required for current fidelity (phase is a budgeting phase).
8. **comment/react/event access rows** — built with the auth-card row; the real per-action
   option sets may differ slightly (e.g. event signup is account/email only). Captured only the
   submit row expanded; others built by faithful analogy. Re-capture each expanded to confirm.

### Disposition
Passes 1-10 complete; both PRIORITY passes (9 access, 10 user data) deeply built from a
purpose-made expanded capture (`r2-access-expanded`) and token-grounded. Gates green (the lone
red is out-of-scope FO). No deploy (library/page work). The gap list above is honest residual,
not fabrication — every item needs a capture this tenant can't currently provide, or is a
known-summary stand-in.

---

# SWEEP 2 — INTERACTIONS & CONDITIONAL LOGIC (DONE 2026-06-16)

Sweep 1 brought the page to **static visual fidelity**. This sweep made it **BEHAVE** like
the real product: method selection branches the whole config, the access settings cascade,
toggles reveal/hide dependent fields, and save/dirty/validation states work. All page-local
JS + `.pp-*` classes; no canonical CSS edit; no new brittle checkpoints.

### Auth note (capture environment)
The deep SPA route `…/phases/<id>/access-rights` **bounces to "Log in"** on direct navigation
in this session (the saved session authenticates shallow `/admin/projects` — 72 treatments —
but the deep phase route redirects to sign-in; two retries with 5s settle both returned the
"Log in" DOM, 0 product markers). This is the documented auth-bounce trap. Per the
anti-fabrication rule I did **NOT** invent states off a bounced capture. The cascade *logic*
(which fields appear per auth choice, the flow-preview steps, the user-data tiers) is
**documented product behavior** (GOVOCAL.md §3 access-rights lines 104-115 + Anonymous
participation; the already-on-disk authoritative `r2-access-expanded` capture for the
Account-creation end-state). To re-capture the None/Email *visual* states, run:
`npm run capture -- "https://uxusertesting.govocal.com/en/admin/projects/dbfa9b1a-7625-4480-bd9a-344e65154ec6/phases/0fd4b191-dc32-4bf8-a42d-40aca0ec168d/access-rights" --name r3-access-none --click "<auth-card-sel>" --settle 3000 --viewport 1440x2200 --login --headed`
(needs an interactive `--login --headed` re-auth; left bounced probe dirs `r3-access-none/`,
`r3-access-probe/` untracked, NOT staged).

### Round-by-round (logic wired)
- **R1 — Method-selection branching.** Picking a participation-method card in ANY Setup picker
  (`.pp-picker`, incl. the rendered `.pp-methodgrid`) now rebuilds the config like the real
  flow: swaps to that method's Setup variant AND its method-aware sub-tab set (same branch the
  phase ribbon does). `TITLE_TO_KEY` maps verbatim card titles → method key; `METHOD_BRANCH`
  → {setup variant, sub-tabs}. Verified in headed browser: Survey→surveysetup (+surveyform/
  surveyresults tabs), Common ground→commongroundsetup (+report), Ideation→setup (+inputmgr/
  inputform/map), Voting→votingsetup. Branching marks the form dirty (you changed the method).
- **R2 — Phase access cascade (PRIORITY).** Each "Who can …" body now cascades: the
  **admins-only toggle** collapses the entire Authentication/group-restrict/demographic/flow
  block below it (verified all 7 child blocks → hidden). The **3 Authentication cards** rebuild
  the participant-flow preview live: None=[demographics only] · Email confirmation=[email→confirm
  →demographics] · Account creation=[email→confirm→name/password→demographics] (AUTH_FLOW map,
  GOVOCAL.md §3). **CSS bug found + fixed:** `[hidden]` was overridden by `.pp-authgrid{display:grid}`
  etc.; added page-local `[hidden]{display:none!important}`.
- **R3 — User-data tiers (PRIORITY).** The tier explainer (`.pp-tierbanner`) now **live-reflects**
  auth + Setup-anonymity: Account+demographics→tier 1 (full PII+demographics); None *or*
  anonymity→tier 2 (no PII, keep demographics, reporting still works); None **and** anonymity→
  tier 3 (full anonymity, no demographics, reporting disabled). The Setup anonymity toggle is
  wired to re-run the cascade across all access bodies.
- **R4 — Per-method Setup conditionals.** Voting sub-method swap (`.pp-votegrid`): approval /
  cumulative / budgeting each reveal a different field group (`.pp-votefields`: budgeting=Total
  budget EUR Min/Max [real], cumulative=votes-per-participant + max-per-option, approval=max
  votes per participant) + the helper banner copy updates. Ideation **Available views**: picking
  Map reveals the "needs a location field" note (`.pp-mapnote`). Ideation **Enable disliking**=
  Disabled hides the dislikes-per-participant field. **Similar-input-detection** toggle hides its
  threshold fields when off.
- **R5 — Cross-cutting + validation/dirty/save.** Tab/sub-tab switching + accordion expand
  already worked (sweep 1) — kept. Added: any form edit marks the active Setup panel **dirty**
  and enables its (previously always-disabled) **Save changes** button; clicking Save **validates**
  the required Phase-name (empty → `.pp-invalid` red border + `.pp-fielderror` message + focus),
  typing clears the error, a valid save flashes **"Saved ✓"** then disables Save again and reverts
  the label after 1.6s.

### Verify (interaction) — all green, 0 JS errors
Drove the built page in headless Chromium and asserted every transition end-state
programmatically + eyeballed screenshots (`/tmp/r1-*`, `r2-email-flow`, `r2-adminsonly3`,
`r2-none3`, `r4-cumulative`): branch swaps correct, auth flows correct, admins-only collapse
correct, tier text correct, voting field swap correct, validation/dirty/save correct. **Zero
pageerror/console errors** across the full walkthrough.

### Gates
- **`npm run lint` → 0 violations.** The bo-project-phase advisory line is `0 hex, 1 box-shadow,
  0 non-token font-size` — the 1 box-shadow is the page-local `.pp-invalid` validation ring
  (color via `--gv-red-500` token, no hardcoded hex); a genuine page-local state one-off, which
  lint explicitly permits.
- **`npm run verify:all` → 130 green · 1 red** (UNCHANGED). All 16 `bo-project-phase/*`
  checkpoints green; the lone red is `homepage-spotlight-heading` (FO concurrent work, confirmed
  not mine). No canonical CSS touched this sweep, so zero blast radius.
- **Checkpoints added: none.** Following the established sweep-1 discipline — the new behaviors
  are dynamic DOM toggles, not new measurable static treatments; the auth cards still expose only
  a brittle hashed styled-component selector. Builds are digest-/doc-grounded + drive-verified.

### Updated gap list (interaction residual)
1. **None/Email auth-card *visual* states uncaptured** — wired from documented logic + the
   Account-creation capture; the bounced deep route blocks a fresh capture without interactive
   `--login --headed` (command recorded above). Re-capture to pin the exact reveal/hide pixels.
2. **comment/react/event access rows** — only the *submit* row carries the full cascade
   (admins-only + 3 auth cards + flow + tiers); comment/react have the auth-card row but no flow/
   demographic block; event row is a simpler 2-radio set. Matches the real product's lighter
   secondary-action UI, but each expanded state is built by analogy, not captured — confirm.
3. **Group-restrict downstream** — selecting a user group doesn't yet gate anything visually
   (the real product would, e.g., show the custom error-message field as the only dependent).
   Low value; deferred.
4. **Carry-over from sweep 1** (unchanged, all capture-blocked or known stand-ins): doc-annotation
   Konveio Setup, external-survey embed config, SSO auth card, common-ground /report depth,
   native-survey per-Q results, auth-card numeric checkpoint.
