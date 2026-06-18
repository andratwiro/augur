# Dashboard Charts Fidelity — Worklog (INTERNAL, never ships)

Autonomous system-building loop raising `pages/bo-dashboard/index.html` chart fidelity
to match the real GoVocal BO dashboard. Ground truth: `govocal-exports/bo-dash-*` and
`r1-an-dash-*` / `r8-dash-*` (source: `uxusertesting.govocal.com/admin/dashboard/*`).
Read this at the start of each loop; append after each iteration.

## Reference: real recharts colours (from bo-dash-overview/dom.html attribute counts)
- Line stroke `#7FBBCA` (n=144, dominant "Total" cumulative line)
- Line/combo stroke + fill `#2F478A` (n=33) — primary navy line/secondary series
- Bar fill `#073F80` (n=27) — recharts-bar-rectangle
- Teal accent `#01A1B1` = `--gv-teal-400`
- Likes/positive `#04884C` = `--gv-green-500`; Dislikes/negative `#E52516` = `--gv-red-500`
- Axis tick text `#596B7A` (n=159, recharts-cartesian-axis-tick-value) = `--gv-cool-grey-600`
- Gridlines `#EBEDEF` = `--gv-grey-200` (page already used this); minor grid `#f5f5f5`
- Other observed fills: `#596B7A` bars/text, `#43515D`, `#057ABE`, `#5FC4E8`, `#0080A5`,
  `#00577C`, `#40B8C5`, `#32B67A` (donut/pie segments — to ground in a later loop)

## Iterations

### Loop 1 — 2026-06-18 — Ground the chart palette + axis-tick colour system
- **Added** `--gv-chart-*` token block to `govocal-tokens.css` (navy/blue/line/teal/pos/neg/
  axis/grid), each grounded in the recharts DOM counts above. Series colours are systemic
  (recur across every dashboard chart) → tokens, not page one-offs.
- **Rewired** `pages/bo-dashboard` page-local `--ch-*` palette to alias the new tokens
  (was raw literals); fixed `--ch-red` from `#E5484D` → real `#E52516` (`--gv-chart-neg`).
- **Moved** axis-tick text (`.ch-axis span`, `.ch-yaxis`, `.ch-haxis__scale`, `.ch-vyaxis`,
  `.ch-vnum`, `.ch-vlabels span`, `.ch-hlabel`) from navy `--gv-bo-primary` to the real
  recharts grey `#596B7A` (`--gv-chart-axis`). Left `.ch-hval` (data value emphasis) navy.
- **Verify:** lint ✓ (bo-dashboard no longer authors raw chart hexes — dropped from styling
  warnings). Eyeball ✓ — axis labels + category labels now grey, bars navy, titles navy.
  `verify:all` advisory; change only ADDS tokens (no existing token value changed) so it
  cannot regress a registered checkpoint.
- **verify:all:** 152 green · 1 red. All three `bo-dashboard/*` checkpoints GREEN. The 1
  red is **pre-existing and unrelated**: `bo-users/people-header` — selector
  `.gv-bo-table.is-people thead th` not found in the bo-users render (stale selector on a
  different page; not touched by this loop). Flagged for the bo-users owner / a later loop.
- **Deploy:** yes (user-visible chart change). NOTE: `npm run deploy` first hit a flaky
  `ENOTEMPTY` rmdir on stale `dist/` — cleared with `rm -rf dist` then re-deployed.

### Loop 2 — 2026-06-18 — Line/combo stroke fidelity + gridline semantics
- **Grounded line geometry** from bo-dash-overview/dom.html: data lines are `stroke-width="1"`
  (n=144); dots are filled circles `r=3` same colour as line; NO area fill (no recharts-area);
  5 y-ticks; gridlines `stroke-width="0.5"`.
- **Set all data-line polylines** (JS `lineSVG`+`comboSVG` renderers AND the static Emails/
  Visitors SVGs) to `stroke-width="1"` + `vector-effect="non-scaling-stroke"` — was 1.5–2 in a
  `preserveAspectRatio="none"` stretched viewBox (which distorted the stroke). Now renders a
  true crisp 1px line like recharts.
- **Gridlines**: switched inline `<line>` stroke from `var(--gv-grey-200)` to the semantic
  `var(--gv-chart-grid)` (same value) + `non-scaling-stroke` for a predictable 0.5px hairline.
- **Verify:** page-only change (no shared CSS) → verify:all not required this loop. lint ✓.
  Eyeball ✓ — lines render thin/crisp.
- **Deploy:** yes.
- **Deferred:** dot markers (r=3) — adding `<circle>` into the `preserveAspectRatio="none"`
  stretched viewBox yields ellipses (x-scale≈0.64, y-scale≈0.93); needs a non-distorting
  approach (overlay SVG with normal aspect, or compute dot px positions). Next loop.

## Next gaps (priority)
1. Line dot markers (r=3 filled, line colour) at each data point — do WITHOUT distortion
   (the stretched viewBox turns circles into ellipses; render dots in a normal-aspect overlay
   or as px-positioned nodes). Then exact y-axis tick count/values per chart.
2. Gridline COLOUR grounding: real DOM has horizontal grid `#f5f5f5` (n=53) vs axis/vert
   `#EBEDEF` (n=43) — currently all use `--gv-chart-grid` (#EBEDEF). Split if real charts do.
3. Horizontal-bar charts: bar height (real recharts-bar-rectangle dims), value-label colour
   (is `.ch-hval` navy or grey in real product? — re-probe), x-axis scale ticks.
4. Donut + pie + stacked-bar: segment colours (the #057ABE/#5FC4E8/#0080A5… family above),
   sizes, legend swatch shape/size.
5. Per-tab parity: Users, Visitors, Representativeness empty-state, the two feed tables.
6. Consider a proper `--probe` re-capture of real chart SVG selectors so chart internals can
   be numerically verified (current probed blocks cover chartcard/title/stat chrome only).
7. SPA screen contract: confirm `<body data-gv-screen>` IIFE exists for tab switching (review
   overlay) — side-task, not a blocker.
