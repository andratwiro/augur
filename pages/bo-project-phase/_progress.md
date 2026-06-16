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
