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
(matchMedia at 1200px — product is JS-driven). NOTE: as of the hardwiring refactor,
bo-app-shell / bo-project-phase **reference canonical `govocal-bo.css` directly** (no
per-folder copy), so the sidebar can no longer drift — edit canonical and both update.
Earlier wrong guesses now corrected: icon colour was not `#4183C4`, glyphs were generic Material,
labels were 14px — all fixed against the live capture.

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

Pipeline per piece:
1. **Capture with checkpoints** — `npm run capture -- <url> --name <slug> --probe "<the real selectors you'll rebuild>"`. (digest is automatic; `--probe` pins the verify targets.)
2. **Build from exact values** — read `styles.json` `digest`, assemble from existing `.gv-*` primitives, map values to `--gv-*` tokens (never eyeball / hardcode).
3. **Verify numerically** — `npm run verify -- <built.html> --against <slug> --map "realSel=mineSel|…"`. Fix every mismatch it prints; loop until it exits ✓. This replaces "eyeball the screenshot".
4. **Register the checkpoint (ratchet)** — once green, add an entry to `govocal-exports/checkpoints.json` (`id` · `built` · `against` · `map`). It's now guarded forever.
5. **Store** — govocal-bo.css + components.md + manifest + `npm run index`.

**The ratchet — primitives improve without regressing.** Primitives are *meant* to
get better on each capture, but a "refinement" of a shared class (`.gv-btn`,
`.gv-bo-side`, …) to match one screen can overfit and silently break the components
already using it. So after ANY change to shared CSS (`govocal-ui.css` /
`govocal-bo.css` / `govocal-tokens.css`) run **`npm run verify:all`** — it
re-renders every registered checkpoint and re-diffs it against its live capture.
Green = real improvement; red = you regressed a dependent (fix or back it out).
`npm run verify:all -- --changed .gv-btn` runs only the checkpoints whose built
file uses that class (deps auto-derived from the markup), so you can check just a
primitive's blast radius. (This is what catches drift like the bo-app-shell /
bo-sidebar copies diverging — register both, and a re-sync that misses one goes red.)

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
- [ ] **Input manager tab** — the posts/data table (checkbox, sortable headers, status meta, row actions, pagination dots) + left filter rail (Timeline/Tags/Status, phase list w/ counts) + filter bar ("Any administrator" dropdown, toggle, Exports, Search) + AI banner. (capture: `bo-project-ideas`)
- [ ] **Input form tab** — `.gv-bo-import-cards` (Paper/OCR, Spreadsheet sources) + "Edit input form" entry. (capture: `bo-input-form-builder`)
- [ ] **Insights tab** — `bo-stat-cards` (label · big number · 7-day change · icon; tag **shared**) + charts. (capture: `bo-phase-insights`)
- [ ] **General / Description / Map / Phase access / Notifications** tabs — capture as needed, build per pattern.
- [ ] **Project tabs** beyond Timeline: General (project settings), Audience, Messaging, Events.

Site: `/pages/` index is split **Back office / Front office** (build.js, via `<meta name="gv-surface">` / `bo-` prefix). New BO pages auto-group under Back office.
