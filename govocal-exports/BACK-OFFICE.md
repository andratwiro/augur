# Back-office UI — capture spec & component queue (internal, never ships)

The staff-facing surface. GoVocal has ~two UIs: **front office** (resident-facing,
city-themed via `?theme=`) and **back office** (staff config/moderation/analytics,
GoVocal's own fixed teal/navy theme). Same type/spacing/radius/primitives, different
colour layer. This file = the measured BO spec + the build queue.

## Source captures (`govocal-exports/`)

All from the demo platform `uxusertesting.govocal.com` (City of Raleigh), captured
with `npm run capture`. Each folder has `page.png` · `viewport.png` · `dom.html` ·
`styles.json` · `meta.json`.

**`styles.json` is the exact-value source — read it, don't eyeball the PNG.** It has:
- `digest` — every *distinct* visual treatment on the page (deduped by style
  signature), each with exact computed `background-color` / `border` / `box-shadow`
  / `border-radius` / `font-*` / `padding` and an occurrence `count`. Build from
  these numbers; map them back to `--gv-*` tokens (don't hardcode a hex you can
  alias). This is what closes the "80%, missing borders/shadows/fonts" gap.
- `probed` — the selectors passed to `--probe` at capture time, kept as **pinned
  checkpoints** for `npm run verify`. Null if you didn't probe.

| Folder | Screen | Best for |
|---|---|---|
| `bo-project-ideas/` | Phase → Input manager (posts table) | shell, tabs, phase ribbon, table, filter bar, AI banner |
| `bo-projects-list/` | Admin projects list | shell (default), list table, top filter bar |
| `bo-phase-setup/` | Phase → Setup (Edit phase form) | BO form patterns, multiloc lang tabs, date picker |
| `bo-input-form-builder/` | Phase → Input form | import-source cards, section headers |
| `bo-phase-insights/` | Phase → Insights | stat cards, AI-analysis button, charts (shared/crossover) |
| `fo-project-page/` | Public project page | front-office contrast (themed header, hero, CTAs, sticky bar) |
| `bo-sidebar-1024/`, `bo-sidebar-768/` | Admin at tablet widths | sidebar collapse behaviour |

**Sidebar (`components/bo-sidebar/`, verified via `#sidebar` checkpoint):** extended **224px**,
collapses to an **80px icon rail at ≤1200px** (1210 extended, 1200 rail). Brand band = teal
**`#147985`** (`--gv-teal-500`), 60px; nav navy `#003349`, `padding 0 0 35px`, line-height 20px;
items 40px, **labels 15px white**, active cell = **`rgba(0,0,0,.7)`** (no bold). Icons are
GoVocal's **real admin glyphs** transcribed from `#sidebar` (each `<a>`'s svg; viewBoxes vary —
24×24, 14×12, 16×16), rendered **24×20**, with per-state colour: inactive **`#00577C`**
(`--gv-blue-400`), **active item → `#01A1B1`** (`--gv-teal-400`), **Support → `#32B67A`**
(`--gv-green-400`). Notification badge red, overlaps the bell when collapsed. Driven by `.is-rail`
(matchMedia at 1200px — product is JS-driven). All BO demos reference canonical
`govocal-bo.css` directly (no per-folder copy), so the sidebar can't drift — edit
canonical and every consumer updates.

## Measured BO theme (live `getComputedStyle`)

- Font **Public Sans**, base **14px** (FO base is 16px), text `rgba(0,0,0,.87)` / `#333`.
- **`#003349`** sidebar bg (dark teal/navy) · active/hover cell ≈ `rgba(0,0,0,.3)`.
- **`#044D6C`** = `--gv-blue-500` — BO **primary**: button fills (`.gv-btn.admin-dark`),
  headings, table text, active tab text. (Already in the token file as "admin primary".)
- **`#4183C4`** link/anchor blue; also the **sidebar icon tint** (labels stay light).
- Outline buttons: `#596B7A` (`--gv-cool-grey-600`) border, transparent.
- Inputs: `#767676` border, radius **3px**, 48px tall. Buttons 45px / `9px 18px`.
- Alt table row / hover `#FCFCFC` (`--gv-grey-50`). Radius **3px** throughout.

**Type & state (measured `bo-phase-setup`, easy to get wrong):**
- **Tabs** (project + sub are the SAME component, `sc-lilDSw` wrapper) — 16px / lh 24px,
  **weight 400 even when active** (NOT bold); inactive text `#596B7A`, active text `#044D6C`;
  padding `16px 0`; tabs spaced **40px** apart. Active indicator = a **3px TEAL `#147985`
  (teal-500) bottom border on the wrapper** — NOT the navy text colour. Both tab rows sit on
  elevated `#FBFBFB` panels (project header `gceAGH` + tabs `kBjgE` flush; phase sub-tabs `jDYmOv`).
- **Field labels** (`.gv-bo-field > .gv-label`, e.g. "Phase name") — **18px / weight 500 /
  admin-blue `#044D6C`** (larger + lighter than a generic label, not small dark grey).
- Section headings (`Edit Phase` / `New ideas!`) **21px**/700 blue; meta rows **14px** `#596B7A`.
- **Phase ribbon chevrons** — **23px** tall, grey track `#D4D9DD` (`--gv-bo-step`) with
  cool-grey-700 numbers/labels; current phase fills **green-600 `#096F03`** (not green-500).
  Overrides scoped under `.gv-bo` so the shared FO ribbon primitive is untouched.

**Containers / elevation (the layer between content and page — measured `bo-phase-setup`):**
the staff content does **not** sit flat on white. It's a stack of elevated panels on a
light blue-grey **app canvas `#EDEFF0`** (`--gv-bo-canvas`; NOT white):
- **Tab strips** (project tabs + phase sub-tabs, `nav.sc-gEXpur`) are elevated **`#FBFBFB`**
  (`--gv-bo-tabstrip`) panel **headers** — rounded **top** corners (`3px 3px 0 0`) + the soft
  card shadow `0 2px 4px -1px rgba(0,0,0,.06)` (`--gv-shadow`), NOT a flat underline row.
- **Content cards** (`div.sc-loIdfG`) — white, **3px** radius, same `--gv-shadow` — float on
  the canvas with a gutter; form/table content lives inside them with **40px** internal padding
  (`div.jDPsVV`). The **phase header is its own content card** (`sc-loIdfG`, `margin-bottom 8px`)
  above the sub-tab strip, not bare text on the canvas.
- Encoded: `.gv-bo-shell` paints the canvas; `.gv-bo-tabs`/`--sub` are the strips;
  `.gv-bo-card` is the floating panel; `.gv-bo-section` is the transparent canvas gutter.
  Checkpoints `bo-project-phase/{canvas,content-card,tabstrip-project,tabstrip-sub}`.

→ Encoded as `--gv-bo-*` tokens in `govocal-tokens.css`; chrome in `govocal-bo.css`;
the `.gv-bo` scope remaps `--gv-tenant-*` so primitives need no BO-specific code.

## Architecture decision (BO vs FO)

- **Shared base** (type, radius, spacing, greys, semantic colours): unchanged.
- **FO theme** = per-city `--gv-tenant-*` (via `?theme=`).
- **BO theme** = fixed `--gv-bo-*`, applied by scoping under `.gv-bo`.
- Components get a surface in the manifest: front-office / back-office / **shared**
  (charts, stat cards, tables likely cross over — tag `shared`, theme by scope).

## Building (pipeline + guards)

The full workflow and the discovery-phase working agreement live in **CLAUDE.md**
(System-building) and **`skills/govocal-ui/SKILL.md`** ("Building & extending") — the
single source; don't restate them here. In short, per piece: capture (with `--probe`)
→ build from the `styles.json` digest → `npm run verify` + eyeball → register a
checkpoint → `npm run lint` → store. `npm run verify:all` is the ratchet (advisory
while we're still matching the UI: red = review + re-capture, not a hard stop).

**BO-specifics:** BO chrome → `govocal-bo.css`; shared atoms → `govocal-primitives.css`;
the `.gv-bo` scope remaps `--gv-tenant-*` so primitives need no BO-specific code. Tag
cross-surface pieces (tables, stat cards) **shared** in the manifest.

## Component queue (build from the captures above, one at a time)

**Focus (set 2026-06-15): the project-configuration editor** — `/admin/projects/<id>/…`
(phases, Setup, Input manager, etc.). Build these screens out deeply first.

- [x] **bo-app-shell** — sidebar + project top-bar + project tabs. ✅ built & verified.
- [x] **bo-phase-ribbon** — REUSED FO `.gv-phases`/`.gv-stepper` under `.gv-bo` + a flat `.gv-bo-addphase` "+ New phase" cell. ✅
- [x] **bo-sub-tabs + phase header** — `.gv-bo-tabs--sub` + `.gv-bo-phasehead` (title · meta · ⋯). ✅
- [x] **bo-form (Setup)** — `.gv-bo-field`, `.gv-bo-multiloc` (EN/ES-ES lang tabs), `.gv-bo-dateface`, reused `.gv-input`/`.gv-btn`. ✅
- [x] **Pages tier: `pages/bo-project-phase/`** — now the **full project-configuration editor**: all six project top-tabs wired to swap panels. Verified vs `bo-phase-setup` + `bo-project-general` (`bo-project-phase/*` checkpoints). Adds config classes `.gv-bo-formhead/-subhead/-caption/-qlabel/-help`, `.gv-bo-select`, `.gv-bo-banner`, `.gv-bo-methods/-methodcard`, `.gv-bo-togglerow`, `.gv-bo-tags/-tag`, `.gv-bo-imageup/-dropzone`, `.gv-bo-table/-toolbar/-search/-pager`, `.gv-bo-pane/-card/-empty/-eventrow` + `.gv-btn.success`/`.size-s` + tokens `--gv-teal-75`/`--gv-green-600`. New captures: `bo-project-{general,audience,messaging,events}`.
  - [x] **Setup** deepened to real complexity (method picker, anonymity, action toggles, likes/dislikes, similar-input detection, available views, sorting, attachments).
  - [x] **General** — full project-settings form (multiloc fields, tags, area/content radios, header/card image uploads, attachments).
  - [x] **Audience** — Participants data table (`.gv-bo-table`) + toolbar + pager.
  - [x] **Messaging** — "Send your first email" empty state on a card/grey pane.
  - [x] **Events** — project events list with registrant counts + row actions.
- [x] **Input manager tab** — `.gv-bo-table.is-bordered` posts table (checkbox, sortable blue headers, assignee dropdowns, like/dislike counts) + `.gv-bo-filterrail` (Timeline/Tags/Status + phase facets w/ counts) + filter bar (assignee select, need-feedback toggle, Exports, Search) + `.gv-bo-banner--ai` callout. Wired to the phase **Input manager** sub-tab. Checkpoints `imgr-table/-th/-title`. (capture: `bo-project-ideas`) ✅
- [x] **Input form tab** — `.gv-bo-importlist`/`.gv-bo-importcard` (Paper-OCR, Spreadsheet sources w/ icon tile + actions) + `.gv-bo-eyebrow` + "Edit input form" entry. Checkpoint `inputform-head`. (capture: `bo-input-form-builder`) ✅
- [x] **Container / elevation pass** — the layer between content and page: app canvas
  `#EDEFF0` (`--gv-bo-canvas`), elevated `#FBFBFB` tab strips (`--gv-bo-tabstrip`, rounded
  top + `--gv-shadow`), and white floating content cards (`.gv-bo-card`, 3px + shadow) with
  canvas gutters (`.gv-bo-section`). Re-captured `bo-phase-setup` with `--probe` on the
  canvas / card / both tab-strip selectors. Checkpoints `bo-project-phase/{canvas,content-card,tabstrip-project,tabstrip-sub}`. ✅
- [x] **Insights tab** — `.gv-bo-statgrid`/`.gv-bo-stat` stat cards (label · 34px number · 7-day change · icon; tagged **shared**) + green AI-analysis CTA + `.gv-bo-chartcard` participation chart. Checkpoint `insights-stat`. (capture: `bo-phase-insights`) ✅
- [ ] **Phase sub-tabs** beyond the built four: Description / Map / Phase access / Notifications — capture as needed, build per pattern.

## Top-level admin SECTION pages (the 12 sidebar destinations) — built 2026-06-15

All 12 reference Pages under `pages/bo-*/`, one per sidebar item, linked together via a
shared per-page `bo-chrome.js` (renders the sidebar, sets the active item, hrefs to
siblings). Standard section chrome = sidebar + a top **section tab strip**
(`.gv-bo-tabs--top` — measured 60px `#FBFBFB`, rounded top, soft shadow, 44px left inset)
where the screen has sub-views; otherwise a `.gv-bo-pagehead` title block. Net-new shared
chrome added: `.gv-bo-tabs--top`, `.gv-bo-table.is-list` (striped full-width list table),
`.gv-bo-listrow`, `.gv-bo-status`/`-substack`, `.gv-status-label.draft`/`.published`; base
`.gv-bo-table`/`.gv-bo-tabs` gained measured `#044D6C`/20px colour+leading.

| Screen | URL | Capture | Built | Notes |
|---|---|---|---|---|
| Dashboard | `/admin/dashboard/*` | `bo-dash-{overview,users,visitors,representation,moderation,management}` | ✅ | **All 6 tabs captured + built** (charts load with a 7s settle). Overview (lines + donut + bar charts using real numbers), Users (demographic bars), Visitors (stats + pies/lines), Representativeness (empty state), Participation feed (moderation table), Management feed (actions table). Chrome verified (`bo-dashboard/tabstrip`). |
| Projects | `/admin/projects` | `bo-projects-list` | ✅ | `.gv-bo-table.is-list` verified (`bo-projects/table-th`,`-row`). |
| Input manager | `/admin/ideas` | `bo-input-manager` | ✅ | Cross-project; reuses filter rail + bordered posts table. |
| Users | `/admin/users` | `bo-users` | ✅ | Two-pane: roles/groups rail + users table. |
| Messaging | `/admin/messaging` | `bo-messaging` | ✅ | DRAFT pill `#FF672F` verified (`bo-messaging/draft-label`). |
| Reporting | `/admin/reporting/report-builder` | `bo-reporting` | ✅ | Report rows on `.gv-bo-listrow`. |
| Community monitor | `/admin/community-monitor` | `bo-community-monitor` | ✅ | Health Score + sentiment battery (no data on demo). |
| Inspiration hub | `/admin/inspiration-hub` | `bo-inspiration-hub` | ✅ | Highlighted cards + project gallery. |
| Tools | `/admin/tools` | `bo-tools` | ✅ | Integration cards + locked premium buttons. |
| Pages & menu | `/admin/pages-menu` | `bo-pages-menu` | ✅ | Navbar item rows (live page also renders the FO navbar preview; reference keeps sidebar chrome only). |
| Settings | `/admin/settings/*` | `bo-set-{general,branding,registration,topics,areas,statuses,policies}` | ✅ | **All 7 sub-tabs captured + built**: General, Branding (colour fields + logo), Registration (helper text + demographic questions), Tags (platform tags), Areas, Statuses (Input/Proposal), Policies. |
| Notifications | — (bell flyout) | `bo-notifications` (404) | ✅ | No standalone page → reconstructed activity feed. |

Site: `/pages/` index is split **Back office / Front office** (build.js, via `<meta name="gv-surface">` / `bo-` prefix). New BO pages auto-group under Back office.

---

# 5-RUN DEEP RECONSTRUCTION SWEEP (started 2026-06-15)

Goal: screenshot-level fidelity across the WHOLE back office + abstract recurring UI
into canonical `.gv-*`. Orchestrator serializes all canonical CSS edits; page agents
do page-local work only. Captures for this sweep are prefixed `r1-*` (discovery),
`r2-*`, etc., so they never clobber the canonical capture set.

## Run 1 — Whole-BO map & gap register (DONE)

Four parallel read-only discovery agents enumerated every reachable BO route/state
and captured ~70 new screens (`govocal-exports/r1-{pe,an,cf,px}-*`). Real tenant =
Raleigh demo (`uxusertesting.govocal.com`). Measured palette confirmed everywhere:
navy `#044D6C` (headings/text), teal `#147985` (accents/status chips), cool-grey
`#596B7A` (meta/inactive), dividers `#E0E0E0`, header-card shadow
`rgba(0,0,0,.06) 0 2px 4px -1px`, radius 3px, Public Sans. Accent red `#E52516`
(notif badge, method chips). All `--gv-*`-aliasable.

### Project enumeration (Raleigh, 20 projects)
Method coverage PRESENT as live phases: ideation ✓, voting/**budgeting** ✓, native
survey ✓, poll ✓, volunteering ✓, information ✓, common-ground/Polis ✓ (as `/report`
tab). NOT present as configured phases (only as method-picker options): standalone
**proposals**, **external survey**, **document_annotation**. Reference projects:
- *Reimagine Dorothea Dix Park* `dbfa9b1a-7625-4480-bd9a-344e65154ec6` — multi-phase
  (ideation P1 `0fd4b191` → voting P2 → winners → implementation → new ideas).
- *Participatory Budget – District 2* `33eaf246…` — ideation `419f4a31` + **budgeting**
  `149d7728` (Total budget + EUR min/max).
- *Ctrl+Alt+Oslo* `d9f0f78c` — native survey (`/survey-form`). *Open survey test
  demographics* `76d99db8` — native survey. *Metro Line* `a0fa6185` — survey-results.
- *Public Healthcare Opinions* `fe77c6bd` — survey + **information** phase `c8502d40`.
- *Forest Gate Community Assemblies* `b3343dbb` — ideation+map + **poll** (`/polls`).
- *Showroom Participation Garage* `9c712d53` — **volunteering** `d17a4e60`.
- *Test Polis* `0c095f98` — **common-ground**/Polis `692cea20` (`/report`).
- **Active-phase trap:** the SPA only renders the *selected* phase's real sub-tabs;
  other phases collapse to generic `setup`/`ideas`. Identify a method from the active
  phase's tab signature or its ribbon label ("Voting phase ·", "Volunteering phase ·").

### Consolidated gap register (✗ = unbuilt, ◐ = partial, ✓ = built & ok)
**Project editor (biggest gap area):**
- ✗ Native **survey form builder** — `/phases/:id/survey-form/edit` — 3-pane (field
  palette / canvas of `Page N` + 51px field rows / settings); field-type chips +
  Required toggle + logic. `r1-pe-survey-form-edit`.
- ✗ Native **survey results** — `/survey-results` — per-question bar/donut cards.
- ✗ **Voting/budgeting Setup** — method cards (One vote per option / Multiple votes /
  Budget allocation), EUR Total/Min/Max numeric row. `r1-pe-pb-ph1-setup`. (No data
  `/voting` tab — options managed via Input manager; results in Insights/FO.)
- ✗ **Poll editor** — `/polls` — question list, single/multiple, Export. `r1-pe-poll`.
- ✗ **Volunteering** causes/opportunities — `/volunteering`. `r1-pe-volunteering`.
- ✗ **Common-ground** setup (≤120-char statements, agree/unsure/disagree) + `/report`.
  `r1-pe-commonground-{setup,report}`.
- ✗ **Information** phase setup (minimal; tabs Setup/Description/Report). `r1-pe-information-setup`.
- ◐ **Phase access-rights** — permissions/auth-flow matrix; under-captured, RE-CAPTURE
  with `--click`/longer settle. `r1-pe-access-rights`.
- ✗ **Phase description** = Content Builder (reuse bo-content-builder). `r1-pe-phase-description`.
- ✗ **Phase emails** — per-phase automated-email toggle list. `r1-pe-phase-emails`.
- ✗ **Input importer** — Excel/form dropzone. `r1-pe-input-importer`.
- ✗ **Project Timeline** top-tab (phase Gantt strip). `r1-pe-proj-timeline`.
- ✗ **"360 Input NEW"** project top-tab (after Events on every project).
- ✗ **New project** flow — From scratch / From a template gallery (collapsible facet
  rail Departments/Purposes/Levels + template cards Use template/More details). Form
  body = same as General tab (heavy reuse). `r1-pe-project-new`, `r1-px-projects-new{,-template}`.

**Analytics cluster:**
- ✗ **Report-builder EDITOR** — `/reporting/report-builder/:uuid/editor` — Content
  Builder: Widgets/✨AI rail, 17 draggable widget tiles, A4 canvas w/ logo + sections +
  "no data for filters" empty widget. BIGGEST single new page. `r1-an-reporting-editor`.
- ◐ Reporting **two tabs** (your-reports / service-reports) — built shows one. `r1-an-reporting-service`.
- ◐ **Community monitor** — live-monitor (Health Score `–/5`, quarter navigator
  `← Q2 2026 →`, 3 sentiment dimensions, 11 question rows w/ scale bars) + sub-tabs
  Participants / Reports / Settings / Settings→Popup. `r1-an-cm-*`.
- ◐ Dashboard date-range control cluster (All Time select + native date picker +
  project combobox + Days/Weeks/Months segmented). `r1-an-dash-daterange-open`.
- ✓ Dashboard 6 tabs, Inspiration hub (method chip red `#E52516` r=2px) — built ok.

**Config cluster:**
- ✗ **Users sub-views** — admins (seat summary Total/Assigned/Available + empty state),
  blocked, banned-emails (email-checker input+Check), seats table, single group view.
  `r1-cf-users-{admins,blocked,banned,seats,group}`.
- ✗ **Add-group modal** — the only TRUE modal in cluster: `role=dialog`, 650px white
  card, 3px radius, 46px circular close, Manual vs Smart group choice cards. `r1-cf-users-groupmodal`.
- ✗ Settings **add-forms (routes not modals)**: registration add-question (7 answer
  formats), areas add-area (multiloc), statuses **Proposal** tab (distinct lifecycle),
  pages-menu create-page. `r1-cf-set-reg-addq`, `r1-cf-set-areas-addmodal`, `r1-cf-set-statuses-proposal`, `r1-cf-pages-new`.
- ✗ **Tools**: widgets builder (dimensions/style/color form + preview), esri config
  (API key). `r1-cf-tools-{widgets,esri}`.

**Projects/messaging/inputs:**
- ✗ **Projects Arrange** tab — drag-reorder rows + Edit + Draft pill. `r1-px-projects-arrange`.
- ◐ Projects **Calendar** = "Enable calendar view" opt-in empty state (not a grid). `r1-px-projects-calendar`.
- ✗ **Messaging compose** editor — Sender/recipients + Subject multiloc (0/80 counter)
  + rich-text toolbar + Save as draft. `r1-px-messaging-compose`.
- ◐ **Automated emails** — grouped trigger registry (audience groups, View/Edit +
  on/off), distinct from custom campaign cards. `r1-px-messaging-automated`.
- ✗ **Exports menu** dropdown (input manager) + bell **notif flyout** (badge 29). `r1-px-input-manager-exports`, `r1-px-notif-flyout`.

### Canonical-component backlog (the abstraction mandate — orchestrator owns these)
HIGH (used ≥2 places, blocks builds): **`.gv-modal`/`.gv-bo-modal`** (missing
entirely — 650px, 3px, 46px circular close); **drag-handle vertical-grip icon**
(missing from `govocal-icons.js` — Areas/Statuses/Pages-menu/Arrange/survey rows);
**filled-grey badge variant** (`.gv-badge.is-filled`/DEFAULT — `#EBEDEF` bg, `#596B7A`,
12px/700 uppercase, 3px, pad 0 6px) + **method chip red** (`#E52516`, r=2px);
**`.gv-bo-segmented`** (scratch/template, Days/Weeks/Months).
MED: `.gv-bo-radiocard` (label+helper radio), color-picker field, `.gv-bo-menu`
dropdown, `.gv-bo-rte` rich-text toolbar + `.gv-bo-charcount`, `.gv-bo-scalebar`
(sentiment n/5), chart-card tokens `--gv-chart-*`, date-range control cluster,
`.gv-bo-templatecard` + collapsible `.gv-bo-facetgroup`, `.gv-bo-automatedrow`,
`.gv-bo-arrangerow` (drag), `.gv-bo-notifflyout`/`__item`, survey `.gv-bo-fieldrow` +
field-type chips, voting-method picker card + EUR min/max row, quarter navigator.
(Confirm `.gv-bo-empty`, `.gv-bo-multiloc` already exist — they do — and reuse.)

## Run 2 — Project editor, core methods (DONE)

Two parallel build agents (disjoint files), lint green, render-verified vs captures.
- **`pages/bo-project-phase`** extended: method-aware **phase ribbon** (PB 4-phase
  lifecycle Submit→Vote→**Budget allocation**[current]→Implementation); **voting/
  budgeting Setup** (3 voting-method cards via `.gv-bo-methodcard`, EUR Total/Min/Max
  numeric row, Options/Actions/Result-sharing toggles) matching `r1-pe-pb-ph1-setup`;
  **Access rights** sub-tab (page-local `.pp-accordion` "who can submit/comment/react"
  + auth-radio fieldset) matching `r2-access-rights`; **survey-results** panel (export
  variant — `r1-pe-survey-results` is the external-export panel, not per-Q charts);
  faithful **Timeline** strip; **Survey form** sub-tab links out to bo-survey-builder.
  (`r1-pe-proj-timeline` was a 404 — no separate Gantt route exists.)
- **`pages/bo-survey-builder`** (NEW) = native survey form builder, 3-pane, reuses the
  canonical content-builder editor shell (`.gv-bo-cb-*`): top bar (Open-for-responses
  pill, EN, Download PDF, View, Save) · left palette (13 field types, AI badge on
  short/long answer) · canvas (drag hint, Page-N groups w/ "Continues to…" logic line,
  ~51px field rows, locked Ending) · right per-field settings + **logic-rule editor**
  for single_choice/linear_scale/ranking. Matches `r1-pe-survey-form-edit`.

### Run-3 promotion queue (canonical needs reported by Run-2 agents, measured)
- **`.gv-bo-accordion`** — access-rights/who-can rows: head 21px(`--gv-fs-xl`)/500/navy,
  1px `--gv-divider`, chevron-right→down, body pad `0 0 22px`. (page-local `.pp-accordion` now)
- **`.gv-bo-fieldrow`** (survey) — flex, min-h 51px, pad `8px 18px`, top divider
  `1px var(--gv-grey-300)`; grip · `Question N`(16/700 `--gv-teal-500`) · title(16
  `--gv-grey-800`) · badges; hover `--gv-grey-100`, selected `--gv-teal-50` + inset
  `3px 0 0 --gv-teal-500`. + **`.gv-bo-typebadge`** (12/700 uppercase chip),
  **`.gv-bo-surveypage`** header, **`.gv-bo-logicbox`** (If→Go-to select pair).
- **drag-handle (6-dot grip) icon** + **`info` icon** + **13 question-type glyphs** —
  ABSENT from `govocal-icons.js` (only `info-solid/outline` exist). Add to registry.
- **voting-method picker card** variant + **EUR min/max field row** (labels 16/400
  `--gv-cool-grey-600`) + **`.gv-bo-infodot`** (16px info dot beside labels).
- Note: `.gv-bo-cb-topbar__view` is hardcoded `width:44px` (icon-only) — a *labeled*
  view/download button needs a variant (survey-builder used page-local `.sb-topbtn`).

## Run 3 — Component abstraction (DONE)

Orchestrator-serialized canonical additions, then parallel page-refactor agents
consumed them + deleted page-local fakes. `npm run lint` 0 violations; `verify:all`
88 green (the 2 reds are `fo-project/survey-band` — concurrent FO edits, out of scope).
- **`drag-handle`** 6-dot vertical grip → `govocal-icons.js` (83 icons now). Consumed
  by bo-pages-menu, bo-settings (Areas/Statuses/demographic-Q), bo-projects (Arrange).
- **`.gv-badge.is-filled`** → `govocal-primitives.css`: filled grey DEFAULT/category
  pill (`--gv-grey-200` bg, `--gv-cool-grey-600`, 700, 1px 6px, no border). Consumed
  by bo-pages-menu (navbar DEFAULT) + bo-inspiration-hub (method tags).
- **`.gv-bo-accordion`** (+`__row/__head/__title/__chev/__body`, chevron auto-rotates
  on `aria-expanded=true`) → `govocal-bo.css`; consumed by bo-project-phase access-rights
  (deleted page-local `.pp-accordion`).
- **`.gv-bo-fieldrow`** (+`__grip/__qno/__title/__badges`) + **`.gv-bo-typebadge`**
  (`.is-type` grey chip / `.is-required` teal) → `govocal-bo.css`; consumed by
  bo-survey-builder (deleted page-local `.sb-field*`/`.sb-badge*`; kept `.sb-fieldmore`).
- **Confirmed `.gv-modal` ALREADY EXISTS** in primitives (overlay, 650px, size-s/l,
  header, 46px close) — Run-1 config agent was wrong; Run-4 modals just consume it.
- Deferred (promote when a 2nd consumer lands in Run 4): `.gv-bo-segmented`,
  `.gv-bo-menu` dropdown, `.gv-bo-rte`, `.gv-bo-scalebar`, `.gv-bo-radiocard`,
  templatecard/facetgroup, automatedrow, notifflyout, quarter navigator, color-picker.

## Run 4 — Long-tail screens (DONE, two waves; lint 0 / verify:all 92 green)

Wave 1 (5 agents): **NEW `pages/bo-report-builder`** (Content-Builder report editor:
Widgets/AI rail, 17 widget tiles, A4 report sheet, no-data placeholders) ·
**bo-community-monitor** deepened (Live monitor Health Score + quarter navigator + 3
sentiment dimensions × 11 scale-bar rows; Participants/Reports/Settings/Popup) ·
**bo-users** (Admins/seats summary, Blocked, Banned-emails checker, Seats table,
single-group, **add-group modal consuming canonical `.gv-modal`**) · **bo-messaging**
(Custom/Automated tabs + grouped trigger registry + compose editor w/ multiloc 0/80
counter + rich-text toolbar) · **bo-project-phase** (poll / volunteering /
common-ground / information Setup variants + phase-emails + input-importer; ribbon now
8 method phases). Canonical fix: `.gv-bo-empty__icon svg` 1em-attr override.

Wave 2 (5 agents): **bo-tools** (Widget builder + Esri config) · **bo-settings**
(add-question / add-area forms, Proposal-statuses tab) · **bo-pages-menu**
(create-custom-page form) · **bo-reporting** (All/Progress tabs, rows → report editor)
· **bo-dashboard** (faithful date-range control cluster). Promotion: **`.gv-bo-segmented`**
(3 agents independently flagged it) added to govocal-bo.css w/ a11y focus ring;
dashboard + pages-menu consume it (page-local toggles deleted).

### Remaining backlog (flagged, not yet built — for future runs)
- Projects: **New project** flow (scratch/template gallery + facet rail), Calendar
  "enable" empty-state, Folder detail/new. Captures: `r1-px-projects-new{,-template}`,
  `r1-px-projects-calendar`, `r1-pe-project-new`.
- Input manager: **Exports dropdown** + **bell notif flyout**. `r1-px-input-manager-exports`, `r1-px-notif-flyout`.
- Project editor: common-ground **/report** view depth; external-survey provider embed
  config; 360-Input tab content; phase **Description** (Content Builder reuse).
- Canonical candidates still page-local (promote if a 2nd consumer appears):
  `.gv-bo-rte`+`.gv-bo-charcount` (messaging), `.gv-bo-scalebar` (community-monitor),
  colour-picker field (tools+branding), seat-summary card, automated-row, choice-card.

## Run 5 — Adversarial fidelity pass + deploy (DONE)

4 agents did region-by-region screenshot-vs-capture comparison across all 11 BO pages
and fixed residuals page-locally (type hierarchy, method-picker copy, banner/label
colours, modal choice-card icon backdrops, sort-header placement, add-form controls →
selects + green save + grey go-back, widget-builder accordion structure, report-sheet
type tiers). Orchestrator canonical tweaks from their findings: **`.gv-bo-subhead`
18px/500** (was /700), **`.gv-bo-fieldrow__qno` teal-400** (was teal-500), added
**`plus-circle`** icon. Reverted a page-local sort-header fake back to canonical
`.is-sorted` (kept the checkpoint green). Final gate: **lint 0 violations · verify:all
92 green / 0 red**. Built + deployed to Cloudflare Pages (`npm run deploy`).

## FINAL REPORT — BO reconstruction sweep (5 runs)

**Reproduced (route → page → key captures):** Dashboard (6 tabs + date controls),
Projects (list/folders/calendar/arrange), Input manager, Users (+admins/seats/blocked/
banned/groups + add-group modal), Messaging (custom/automated/compose), Reporting
(list tabs + **report-builder editor** NEW), Community monitor (live/participants/
reports/settings/popup), Inspiration hub, Tools (+widget builder + esri), Pages & menu
(+create-page), Settings (7 tabs + add-question/add-area/proposal-statuses), and the
**project-configuration editor** across methods: ideation, voting/**budgeting**, poll,
volunteering, common-ground, information, native-**survey form builder** (NEW page) +
survey-results, plus cross-method access-rights, phase-emails, input-importer, Timeline
& 360-Input top-tabs. New pages: `bo-survey-builder`, `bo-report-builder`.

**Canonical promotions this sweep:** icons `drag-handle`, `plus-circle`;
`.gv-badge.is-filled` (DEFAULT/category); `.gv-bo-accordion`; `.gv-bo-fieldrow` +
`.gv-bo-typebadge`; `.gv-bo-segmented` (+a11y focus); `.gv-bo-empty__icon svg` fix;
`.gv-bo-subhead`/`fieldrow__qno` measured corrections. Confirmed `.gv-modal` pre-exists.

**Prioritized remaining backlog:** New-project scratch/template gallery; input-manager
Exports dropdown + bell notif flyout; common-ground `/report` depth; external-survey
embed config; 360-Input content; phase Description (Content Builder reuse). Promote
when a 2nd consumer lands: `.gv-bo-rte`/`charcount`, `.gv-bo-scalebar`, colour-picker
field, seat-summary card, choice-card, automated-row. Register numeric checkpoints for
the new components (accordion/fieldrow/segmented/report-sheet) — deferred to keep the
green ratchet stable; builds are digest-grounded + eyeball-verified.

---

# RUN 6 — Overnight deep fidelity audit (started 2026-06-16)

Goal: recurse both surfaces, find Component/Primitive/Page drift vs the REAL product
(digest- and source-grounded, never eyeballed), fix the small details, build the
remaining long-tail. Method: read-only audit subagents capture+diff each screen and
return structured gap registers; the lead serializes canonical CSS edits, verifies,
pins checkpoints, commits per unit. Sweep captures prefixed `r6-*` (load-bearing ones
promoted to canonical names). Baseline at start: lint 0 · verify:all **121 green / 0 red**.

## Wave 1 — audit (4 read-only agents) → findings

**FO common-ground (`pages/project-common-ground`):** the 36 page-authored hex lint
flags are a **false positive** — every GoVocal-*rendered* surface (phase green
`#04884C`, number circle, panel shadow `--gv-shadow`, canvas `#EDEFF0`, head band) is
already correctly tokenized. The flagged literals are (a) the **cross-origin pol.is
iframe** reconstruction and (b) a **bespoke Westmere results panel with no real-DOM
equivalent** (the real phase body is just `<iframe src="pol.is/…">`). Verdict: promote
nothing. NOTE: the A1 agent claimed `var(--gv-border,#e0e4e4)` fallbacks were "dead" —
**they are NOT**: `--gv-border` is undefined (only `-dark`/`-light`), so the literal is
live. Left untouched. (Lesson: verify a token exists before "cleaning up" its fallback.)

**FO project page (`pages/project-page` + `govocal-ui.css`):** real SYSTEM drift found
and FIXED (commit `a49414b`), grounded on two tenants (uxusertesting + Wien, byte-identical):
- `.gv-phasepanel` padding `30px 30px` → **`30px 30px 35px`** (real `div.sc-ezPzSr`).
- `.gv-phasepanel__name` line-height `1.2` → **`1.3`** (21px×1.3 = 27.3px real).
- `.gv-phases__bar h2`: dropped **fabricated `letter-spacing:-0.01em`** (real = normal).
- project-page `h1`: dropped redundant inline `line-height:39px` (primitive 1.3 yields it).
- Pinned checkpoint `fo-project/phasepanel-name` vs new canonical capture `fo-projpage-wien`
  (props font-size/weight/line-height; font-family is themed → excluded). verify:all 122 green.
- Left page-local one-offs alone (Leaflet map block `.pp-*`): correctly scoped, not systemic.

## Wave 2 — build the two specced long-tail pieces

**BO Exports menu + bell notif flyout** (was unbuilt). Source-confirmed both are the SAME
component-library `<Dropdown>`. Canonical added (lead): token **`--gv-shadow-menu`**
`0 0 12px rgba(0,0,0,.18)`; **`.gv-bo-menu`/`__item`/`.is-flyout`** (260px) in govocal-bo.css;
**`.gv-badge.is-count`** (red `#E52516`, radius 2px, pad 0 4px) in primitives. All values
re-verified by the lead against `r1-px-input-manager-exports` + `r1-px-notif-flyout` digests.
Demo `components/bo-menu/` + checkpoints in progress.

**BO New-project flow** (scratch / template gallery) — SPEC ready (`r1-px-projects-new-template`
+ source `admin_project_templates`): mostly REUSE (`.gv-bo-segmented` toggle, `.gv-input`
search, `.gv-btn` variants, `.gv-bo-empty`); NEW `.gv-bo-templatecard` (grey-blue bordered,
21px/500 navy title, `#808080` desc) + `.gv-bo-facetgroup` (collapsible `FilterSelector`
disclosure). Page `pages/bo-project-new/`, linked from bo-projects "+ New project". Queued.

## Tooling finding (worth fixing)
`scripts/capture/grab.mjs --click` passes the raw string to Playwright's **default CSS
engine**, so `text=`/`:has-text()`/role selectors silently no-op — menu/flyout *reveal*
captures fail. Add a `text=`/role-aware click mode (or accept a JS-eval click) so future
sweeps can capture opened menus directly instead of falling back to older r1 captures.

## Next-wave targets (deeper, uncovered)
- FO methods as a resident, deep: voting/budgeting cast-vote, native survey runner page-by-page,
  poll, volunteering sign-up, proposals detail+threshold, idea/proposal comments + reactions.
- BO phase sub-tabs still unbuilt: Description (Content Builder), Map, Phase access (re-capture
  with working reveal), Notifications/emails depth.
- Re-pass "done" BO pages adversarially (states: hover/active/focus/checked; type hierarchy).
