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
