# Input Form — capture & anatomy (slug: `input-form`)

**Source:** `https://wietsedemo.govocal.com/.../surveys/new?phase_id=3a3fd1e1-…`
(project `c70be359-…`, phase `3a3fd1e1-…`). A deliberate **kitchen-sink demo survey**
("Redesigning Coffman Park") that exercises essentially every GoVocal `input_type`.

## How it was captured (reproducible, no auth)

The resident render is gated ("This survey is not currently active"), **but the
form-definition API is public**:

```
GET /web_api/v1/phases/<phase_id>/custom_fields   → 200, full form JSON (this is the source of truth)
GET …/custom_fields/json_forms_schema             → 401 (pre-rendered schema needs auth — not needed)
```

Saved here:
- `custom_fields.json` — the complete form definition (60 KB). `data[]` = fields in
  `ordering`; `included[]` = 41 `custom_field_option`, 9 `custom_field_matrix_statement`,
  4 `image`, 4 `map_config`, 1 `custom_form`.
- `images/` — the 4 multiselect-image options, downloaded locally (self-contained).

This is the **reusable structure**: any prototype can load this JSON (or a trimmed copy)
and render the form. That's the "capture once, reproduce anywhere" goal.

## Structure (Pages → questions) — 10 pages, 18 questions, 17 field types

| # | Page | Questions (input_type) |
|---|---|---|
| 1 | We're renovating Coffman Park! | *(intro page, copy only)* |
| 2 | 👋 About you | `select` age · `number` household |
| 3 | 🌿 How you use the park today | `select` proximity · `select` frequency · `text` one-word · `multiselect` activities · `rating` (★ max 5) |
| 4 | 🧠 Ideas & improvements | `multiline_text` · `ranking` · `linear_scale` (1–7) · `sentiment_linear_scale` (emoji, 5) |
| 5 | 🎨 Design preferences | `multiselect_image` (4 imgs) · `matrix_linear_scale` (9 statements × 5) · `file_upload` |
| 6 | 🚧 Recreation Features demolition | `linear_scale` (1–5) · `text` why · `select` alt |
| 7 | 🗺️ Spatial feedback | `line` (map) · `polygon` (map) · `point` (map) |
| 8 | 👷 Planner / GIS pro | `shapefile_upload` (Esri) |
| 9 | ✅ Final thoughts | `multiline_text` |
| 10 | Thank you! | *(end page, copy only)* |

Field attrs that matter: `title_multiloc`, `description_multiloc`, `required`,
`input_type`, `ordering`, `logic` (conditional page jumps), `maximum` (scale/rating
length), `page_layout`, plus `map_config_id` on the spatial fields.

## Component mapping → library (the 17 field types become Components)

Each `input_type` is one reusable **field component** (themeable `--gv-*`, label +
description + required marker + error state). Grouped by build complexity:

**Simple (form primitives — likely partly in `govocal-ui.css` already):**
- `text` → single-line input · `multiline_text` → textarea · `number` → number input
- `select` → radio group (single) · `multiselect` → checkbox group
- `linear_scale` → 1–N segmented scale w/ min/max labels
- `rating` → star rating (max N)

**Composite (new canonical components needed):**
- `ranking` → drag-to-order list (keyboard up/down fallback for a11y)
- `sentiment_linear_scale` → emoji/face scale (5 faces)
- `multiselect_image` → image-card multi-choice grid
- `matrix_linear_scale` → statements × scale grid (mobile: stacked)
- `file_upload` / `shapefile_upload` → dropzone (shapefile = Esri `.zip`/`.shp` hint)
- `line` / `polygon` / `point` → map field (Leaflet/MapLibre + draw control; config
  from `map_config`: `tile_provider`, `zoom_level`, `center_geojson`, `layers`, Esri ids)

**Shell (the Page):**
- multi-step wizard: progress bar, page title/desc, Back/Next, page-by-page validation,
  "leave/save" affordance, final submit + thank-you. Conditional logic via `logic`.

## Reuse-list vs. gaps (fill after scanning LIBRARY.md)
- [ ] scan `LIBRARY.md` — which field primitives already exist in `govocal-ui.css`
- [ ] gaps → new canonical `components/<name>/` (one per missing field type)
- [ ] Page shell `pages/input-form/index.html` composes them, driven by `custom_fields.json`

## Live capture (done) — `walk/`

`scripts/capture-input-form.py` walked the live form (phase opened by the user) and
saved per page in `walk/page-NN/`: `desktop-empty.png`, `desktop-filled.png`,
`dom.html`, `form.html` (+ `mobile-*` where captured).
- **Desktop:** all 9 content pages (00–08) captured, empty + filled + DOM. Stops at the
  **Submit** on page 08 *without submitting* (no fake response on the tenant).
- **Mobile:** pages 00–04 captured (incl. ranking, image-select, matrix). 05–08 skipped
  — see gate note below; they're simple single-column pages + the maps.

### Real UI confirmed from the capture (build to these)
- **ranking** → list of cards, each = a **numbered rank dropdown** (left) + label +
  **drag handle ⋮⋮** (right). (`Community gathering spaces`, `Public restrooms`, …)
- **linear_scale** → segmented **1…N buttons** in a row, with `(1 = …, N = …)` caption;
  selected = filled navy.
- **sentiment_linear_scale** → **5 emoji faces** (Very bad→Very good) + labels; selected
  face gets a checkmark badge.
- **rating** → row of **star** SVGs (max N).
- **multiselect_image** → 2-col grid of **image cards** (photo + expand icon + checkbox +
  label). Caption `(Select one image)` even though type is multiselect.
- **matrix_linear_scale** → `#e2e-matrix-control`, **9 statement rows × 5-point** radios
  (45 radios). Mobile stacks the rows.
- **map (line/polygon/point)** → map with **zoom ±, undo, locate-me**, instruction
  *"Click on the map to draw…"*, draw-tool thumbnail. Esri tiles need auth → render blank
  headless; **use a placeholder/static map in the rebuild** (don't embed live Esri).
- **Chrome:** "Survey" titlebar + ✕, navy page heading, italic page description,
  questions with bold label + grey `(optional)`, **bottom bar = yellow progress bar +
  "NN% complete" + Previous (outline) / Next (filled)**, a11y widget bottom-left.

### ⚠️ Product finding (fold into GOVOCAL.md): "optional" but Next-gating
Although **every field is `required:false`**, the **Next** button stays `aria-disabled`
until certain field types are answered — confirmed gates: **rating** and
**matrix_linear_scale** (and the linear/sentiment scales behave the same). So GoVocal's
client treats scale/rating/matrix as *de-facto required to advance* even when marked
optional. Pages with only text/select/checkbox advance unfilled. (This is why the capture
walker must answer those controls before Next enables.)

## Open decision — visual fidelity source (RESOLVED: live capture above)
Phase is closed → no anonymous live render. Need real screenshots of each field type to
ground the build. Options: (a) user temporarily opens/activates the phase so I can drive
it page-by-page with Playwright; (b) build from the `citizenlab` repo component source
(govocal-ui is already transcribed from it) + this schema, no live render.
