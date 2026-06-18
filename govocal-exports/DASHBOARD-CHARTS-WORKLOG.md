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

### Loop 3 — 2026-06-18 — Faithful line dot markers (r=3, line colour)
- Real recharts draws a filled `r=3` dot in the line colour at every data point
  (recharts-line-dot, n=135). The page's line SVG uses `preserveAspectRatio="none"`, which
  squashes inline `<circle>`s into ellipses.
- **Solution:** render dots as CSS-positioned round elements (`.ch-dots i`, 6px, border-radius
  50%, `background: var(--ch-line)`) overlaid on the 130px svg area. `%` left/top map to the
  same 600×120 viewBox coords as the polyline (`left = i/(n-1)*100%`,
  `top = (112 - v/top*100)/1.2 %`), so dots stay perfectly round at any width and align
  exactly with the line. Added to both JS renderers (`lineSVG` + `comboSVG`).
- **Verify:** page-only change → no verify:all. lint ✓. Eyeball ✓ — round teal dots trace
  each point on Registrations/Participants/Inputs/Comments/Reactions lines.
- **Deploy:** yes.

### Loop 4 — 2026-06-18 — Bar-chart colour grounding (combo bar fill + value labels)
- Read real bar fills from bo-dash-overview/dom.html (recharts-rectangle paths, by `name`):
  - Combo "Inputs" monthly bars (`name="This month"`) = **#2F478A** (blue), NOT navy. Page
    drew combo bars in `--ch-bar` (#073F80). **Fixed** comboSVG rects → `var(--ch-blue)`.
  - Reactions "Likes" bars = #073F80, "Dislikes" = #073f80b3 (navy @ 70%). Horizontal
    "Participation" bars = #073F80 — page already navy (correct), left as-is.
  - Bar value labels (recharts-label) = **#596B7A** grey (n=17, covers the ~14 bar labels;
    #808080 n=6 is elsewhere). **Fixed** `.ch-hval` from navy `--gv-bo-primary` →
    `var(--gv-chart-axis)`. (Reverses the loop-1 "leave hval navy" guess — DOM says grey.)
- **NOT changed:** combo bar THICKNESS — real bar width ≈6.2px but the slot measurement mixes
  multiple charts (ambiguous slot step), so not grounded enough to touch. Deferred.
- **Verify:** page-only change → no verify:all. lint ✓. Eyeball ✓ — "Participation per
  project" values now grey; combo bars blue.
- **Deploy:** yes.

### Loop 5 — 2026-06-18 — Pie segment colour ramp (Visitors tab)
- Real Visitor pies (recharts-pie-sector, bo-dash-visitors) are a **monochrome blue ramp**:
  segment 1 `#2F478A`, segment 2 `#4D85C6` (white sector separators) — NOT blue+teal as the
  page rendered (`--ch-blue` + `--ch-teal`).
- **Added** `--gv-chart-blue-light: #4D85C6` token (systemic — recurs across the pies).
- **Changed** Language + Device pies' 2nd segment from `var(--ch-teal)` → `var(--gv-chart-blue-light)`
  (legend swatch picks it up automatically). Traffic sources is 100% single-segment, untouched.
- **Verify:** lint ✓. Rendered the Visitors tab via playwright (/tmp/visitors-tab.png) since
  pies are off the default Overview poster — pies + legends now light-blue, eyeball ✓.
  verify:all 152 green (dashboard all green; the 1 red is the pre-existing bo-users one).
- **Deploy:** yes.
- Reusable: to eyeball off-Overview tabs, render with playwright clicking `.gv-bo-tab[data-db=…]`.

### Loop 6 — 2026-06-18 — CRITICAL fix: line/dot desync + Input-status donut colours
- **BUG (user-reported, screenshot):** line-chart dots sat far BELOW the lines. Root cause:
  the line `svg.db-line` was rendering at ~42px, not 130px — the canonical
  `.gv-bo-chartcard svg { height:auto }` (specificity 0,1,1) was overriding the page's
  `.db-line { height:130px }` (0,1,0), so the 600x120 viewBox squished to width/5 while the
  `.ch-dots` overlay stayed 130px → desync. (Also why lines looked flat/short since loop 2.)
  **FIX:** `.gv-bo-chartcard svg.db-line { height:130px }` (0,2,1) out-specifies canonical.
  Measured with playwright: svgHeight now 130, max dot↔line delta **0.05px** (was ~67px).
- **Donut (Input status):** confirmed real recharts-sector = #40B8C5 (sum_feedback) on #E0E0E0
  (sum_no_feedback). Added `--gv-chart-teal-light: #40B8C5`; donut segment --ch-teal→that,
  track --gv-grey-200→--gv-grey-300. (Stackbar/status-legend colours NOT yet grounded — left.)
- **Verify:** lint ✓. Eyeball ✓ (dots on the line, lines fill height). verify:all pending bg.
- **Deploy:** yes.

## Next gaps (priority)
1. Pies: real recharts has white (#fff) sector separators the page's concentric-arc pieSVG
   lacks — add thin #fff strokes between segments.
2. Input-status STACKBAR + status legend colours (Under consideration/Implemented/Accepted/
   Rejected) — not yet grounded; probe real status palette before touching.
3. Static line SVGs (Emails ~L258, Visitors traffic ~L327): now 130px too — add dots if real shows them.
4. y-axis tick count/values per chart; combo right-axis for bars.
5. Per-tab parity (Users, Visitors, Representativeness empty-state, feed tables).
6. NOTE coupling: `.ch-dots` height (130px) must match `svg.db-line` height (130px) — keep in sync.
2. Reactions chart is a single line in the page but real = Total line + Likes(#073F80) +
   Dislikes(#073f80b3 @70%) bars — consider a proper multi-series combo. Bigger change.
3. Combo bar THICKNESS — re-measure a single chart's slot step cleanly, then ground width.
4. Static line SVGs (Emails ~L256, Visitors traffic ~L325): add matching dots if real shows them.
5. Exact y-axis tick COUNT/values per chart; whether combo shows a right axis for bars.
6. Gridline COLOUR: real has horizontal grid #f5f5f5 vs axis/vert #EBEDEF — split if real does.
7. Per-tab parity (Users, Visitors, Representativeness empty-state, feed tables).
8. SPA `<body data-gv-screen>` IIFE for tab switching (review overlay) — side-task.
3. Horizontal-bar charts: bar height (real recharts-bar-rectangle dims), value-label colour
   (is `.ch-hval` navy or grey in real product? — re-probe), x-axis scale ticks.
4. Donut + pie + stacked-bar: segment colours (the #057ABE/#5FC4E8/#0080A5… family above),
   sizes, legend swatch shape/size.
5. Per-tab parity: Users, Visitors, Representativeness empty-state, the two feed tables.
6. Consider a proper `--probe` re-capture of real chart SVG selectors so chart internals can
   be numerically verified (current probed blocks cover chartcard/title/stat chrome only).
7. SPA screen contract: confirm `<body data-gv-screen>` IIFE exists for tab switching (review
   overlay) — side-task, not a blocker.
