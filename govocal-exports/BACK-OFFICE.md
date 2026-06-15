# Back-office UI — capture spec & component queue (internal, never ships)

The staff-facing surface. GoVocal has ~two UIs: **front office** (resident-facing,
city-themed via `?theme=`) and **back office** (staff config/moderation/analytics,
GoVocal's own fixed teal/navy theme). Same type/spacing/radius/primitives, different
colour layer. This file = the measured BO spec + the build queue.

## Source captures (`govocal-exports/`)

All from the demo platform `uxusertesting.govocal.com` (City of Raleigh), captured
with `npm run capture`. Each folder has `page.png` · `viewport.png` · `dom.html` · `meta.json`.

| Folder | Screen | Best for |
|---|---|---|
| `bo-project-ideas/` | Phase → Input manager (posts table) | shell, tabs, phase ribbon, table, filter bar, AI banner |
| `bo-projects-list/` | Admin projects list | shell (default), list table, top filter bar |
| `bo-phase-setup/` | Phase → Setup (Edit phase form) | BO form patterns, multiloc lang tabs, date picker |
| `bo-input-form-builder/` | Phase → Input form | import-source cards, section headers |
| `bo-phase-insights/` | Phase → Insights | stat cards, AI-analysis button, charts (shared/crossover) |
| `fo-project-page/` | Public project page | front-office contrast (themed header, hero, CTAs, sticky bar) |

## Measured BO theme (live `getComputedStyle`)

- Font **Public Sans**, base **14px** (FO base is 16px), text `rgba(0,0,0,.87)` / `#333`.
- **`#003349`** sidebar bg (dark teal/navy) · active/hover cell ≈ `rgba(0,0,0,.3)`.
- **`#044D6C`** = `--gv-blue-500` — BO **primary**: button fills (`.gv-btn.admin-dark`),
  headings, table text, active tab text. (Already in the token file as "admin primary".)
- **`#4183C4`** link/anchor blue; also the **sidebar icon tint** (labels stay light).
- Outline buttons: `#596B7A` (`--gv-cool-grey-600`) border, transparent.
- Inputs: `#767676` border, radius **3px**, 48px tall. Buttons 45px / `9px 18px`.
- Alt table row / hover `#FCFCFC` (`--gv-grey-50`). Radius **3px** throughout.

→ Encoded as `--gv-bo-*` tokens in `govocal-tokens.css`; chrome in `govocal-bo.css`;
the `.gv-bo` scope remaps `--gv-tenant-*` so primitives need no BO-specific code.

## Architecture decision (BO vs FO)

- **Shared base** (type, radius, spacing, greys, semantic colours): unchanged.
- **FO theme** = per-city `--gv-tenant-*` (via `?theme=`).
- **BO theme** = fixed `--gv-bo-*`, applied by scoping under `.gv-bo`.
- Components get a surface in the manifest: front-office / back-office / **shared**
  (charts, stat cards, tables likely cross over — tag `shared`, theme by scope).

## Component queue (build from the captures above, one at a time, verify-loop each)

Pipeline per piece: probe exact values → build from existing primitives → render +
screenshot + compare to capture → fix → store (govocal-bo.css + components.md + manifest + `npm run index`).

- [x] **bo-app-shell** — sidebar + project top-bar + project tabs. ✅ built & verified.
- [ ] **bo-phase-ribbon** — the green interlocking chevron phase stepper + Prev/Current/Next + "New phase". (FO already has `.gv-phases`; reconcile/extend for BO.)
- [ ] **bo-sub-tabs** — phase sub-tab row (Setup/Description/Input manager/…). May just be `.gv-bo-tabs--sub` + a phase header block (green numbered circle + name + date).
- [ ] **bo-table** — the posts/data table (checkbox, sortable headers, status meta, row actions, pagination dots) + the left filter rail (Timeline/Tags/Status, phase list w/ counts).
- [ ] **bo-filter-bar** — "Any administrator" dropdown + toggle + Exports + Search (reused atop tables).
- [ ] **bo-stat-cards** — Insights metric cards (label, big number, 7-day change, icon). Tag **shared** (also used in reporting/FO dashboards). Charts come after.
- [ ] **bo-ai-banner** — the teal "Explore AI-powered summaries" promo row.
- [ ] **bo-form** — Edit-phase form patterns: section headings, **multiloc language tabs** (EN / ES-ES), labelled inputs, date-range picker, Save bar.
- [ ] **bo-import-cards** — input-form import sources (Paper/OCR, Spreadsheet) row cards.

Then assemble a **Pages**-tier `bo-project-phase` reference screen from these legos.
