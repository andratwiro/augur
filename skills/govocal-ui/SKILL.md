---
name: govocal-ui
description: Source-grounded GoVocal UI components for prototypes — real design tokens + copy-paste static-HTML primitives transcribed from the @citizenlab/cl2-component-library, plus a per-city ?theme= colour switcher. Consult when building or restyling any prototype so it matches the actual product, and use the tenant colour variables (never hardcode brand colours).
---

# GoVocal UI (source-grounded components)

The **fidelity layer**: tokens and components transcribed from the real product
code, so prototypes look like GoVocal — not an approximation. This skill is the
*exact how* (tokens + components); for generic design craft (typography, palette,
layout direction) pair it with `skills/frontend-design/`.

For the **product model** behind the UI — what a Project/Phase/Input/participation
method is, the exact terminology, roles, and asset specs (image dimensions, etc.) —
read **`GOVOCAL.md`** (repo root), the internal product-context brief + living
project brain. Match its vocabulary when labelling components.

## Source & provenance

- Repo: `CitizenLabDotCo/citizenlab` (public). Pinned at commit **`5d67730`**.
- Path: `front/app/component-library/` (published on npm as
  `@citizenlab/cl2-component-library`). React + styled-components + TypeScript.
- Tokens come from `utils/styleUtils.ts`; each component from `components/<Name>/`.
- **Licence:** CitizenLab Commercial License v2 — no production/self-hosting use.
  We reproduce *appearance* for design prototypes; we do **not** copy their `.tsx`
  source into anything we publish. Keep that boundary.

## What's here

| File | What it is |
|---|---|
| `govocal-tokens.css` | Design tokens as CSS custom properties (`--gv-*`): full palette, type scale, radius (3px), shadows, focus, tenant colours. |
| `govocal-ui.css` | Component classes (`.gv-btn`, `.gv-input`, `.gv-checkbox`, …) built on the tokens. |
| `govocal-bo.css` | **Back-office** chrome (`.gv-bo-*`): app shell, sidebar, top-bar, tabs. The `.gv-bo` scope remaps `--gv-tenant-*` → GoVocal's fixed teal/navy BO palette, so the same primitives render in back-office colours. See `govocal-exports/BACK-OFFICE.md`. |
| `govocal-survey.css` + `govocal-survey.js` | The **survey field kit**: every input-form question type (rating, ranking, linear/sentiment scale, image-select, matrix, map, file/shapefile, …) + the page-by-page runner. `GVSurvey.field({type,…})` renders one widget; `GVSurvey.mount(el, FORM)` renders a whole survey. Built on the gv-* primitives; themeable. Demo: `components/survey-fields/`; used by the Input Form page. |
| `govocal-themes.js` | `?theme=` per-city colour + **font** switcher + on-screen picker + per-city logos. |
| `govocal-icons.js` | The real **GoVocal icon set** (67-icon curated subset, transcribed verbatim from the repo + the live account menu). Drop in, then `<span data-gv-icon="vote-up"></span>` → inline `<svg class="gv-icon">` that inherits text colour + size. |
| `govocal-logo.svg` | The real **go·vocal** wordmark (footer “powered by” attribution). Muted grey; use as `<img>`. |
| `components.md` | The catalog — copy-paste HTML for primitives **and composed components**, with notes. |
| `gallery.html` | Live demo of every primitive in every state, across all city themes. Open it to eyeball fidelity. |

## Library tiers — Primitives → Components → Pages

The design system is layered, and the review site has a tab per tier:

1. **Primitives** (`/primitives/`, the `gallery.html`) — tokens (colour, type, shadow,
   radius, focus) and base `.gv-*` primitives (button, input, badge, card…). The atoms.
2. **Components** (`/components/`) — composed, section-level blocks assembled from
   primitives: **header/nav, footer, project-card + rail, hero, modal + login**. Source lives in
   `components/<name>/` (self-contained demos); the recall index is
   [`components/manifest.md`](../../components/manifest.md). Styling is in `govocal-ui.css`.
3. **Pages** (`/pages/`) — whole screens (e.g. the Stadt Wien homepage) built from
   components. Source in `pages/<name>/`.

**Recall flow when building a prototype:** you don't need every component in context.
Scan `components/manifest.md` (one small table), then open just the one component file
you need, or grab its snippet from `components.md`. Prototypes can pull from any tier —
a token, a component, or a whole page as a starting point.

## When to use

Consult this skill **whenever building or restyling any prototype**. It pairs with
the required front-end skill set in `CLAUDE.md` (design, a11y, webapp-testing).

## How to use it in a prototype

Prototypes are self-contained, so **copy the three asset files into the prototype
folder** and reference them locally:

```bash
cp skills/govocal-ui/{govocal-tokens.css,govocal-ui.css,govocal-themes.js,govocal-icons.js} \
   <opportunity>/prototypes/<name>/
```

(Add `govocal-icons.js` only if you use icons; `govocal-cookies.js` on resident-facing
prototypes — see the cookie rule.)

```html
<head>
  <link rel="stylesheet" href="govocal-tokens.css" />
  <link rel="stylesheet" href="govocal-ui.css" />
  <script src="govocal-themes.js" defer></script>
  <script src="govocal-icons.js" defer></script>   <!-- if using icons -->
</head>
<body class="gv-root">
  …
  <span data-gv-icon="vote-up"></span>             <!-- decorative; auto aria-hidden -->
  <button class="gv-iconbtn" aria-label="Search"><span data-gv-icon="search"></span></button>
</body>
```

Then build markup from `components.md`. **Use the tokens for every colour** —
especially the three city-configurable ones:

- `var(--gv-tenant-primary)` — the city's main brand colour (buttons, links, focus)
- `var(--gv-tenant-secondary)` — secondary brand colour
- `var(--gv-tenant-text)` — body text colour

Never hardcode a hex for brand colour; that's what breaks city theming.

## City theming — `?theme=`

Each GoVocal city configures primary/secondary/text. The switcher lets you preview
a prototype across several city palettes:

- `?theme=0` GoVocal · `1` Ocean · `2` Forest · `3` Royal · `4` Sunset
- Live picker renders bottom-right (swatches); it also rewrites the URL so a view
  is shareable. Disable with `<body data-gv-theme-picker="off">`.
- Templates are **real city tenants** (researched from each one's official brand):
  `1` Københavns Kommune (`#000C2E`), `2` Stadt Wien (`#FF0000`), `3` Engaged
  California (`#1C2745` + `#E79450`), plus `0` GoVocal default. Add one by appending
  `{id, name, primary, secondary, text, logo, font}` to `GV_THEMES`.
- **City logos:** a theme's `logo` (inline `<svg>` or `<img>`) renders into any
  `[data-gv-logo]` slot and swaps with the theme; a placeholder is generated until a
  real logo is set. Put `<a data-gv-logo>` in a header.
- **City fonts:** a theme's `font` drives `var(--gv-font-family)` (real tenant font
  name first, then a free stand-in; proprietary fonts fall back to Public Sans like
  the live sites). Build text with `font-family: var(--gv-font-family)`.
- **Faithful-but-flagged:** real brand colours are kept even when under AA — `Wien Rot
  #FF0000` is ~4:1 white-on-primary and the audit flags it (expected, accepted).

## Accessibility notes (read with `skills/govocal-a11y/`)

- Focus is a visible 2px tenant-primary outline on every interactive component —
  keep it.
- Checked checkboxes/toggles are **success green**, not primary — that's the real
  product, and it means state isn't signalled by the brand hue alone.
- **Contrast:** the default GoVocal combination is a **deep teal `#0E7C86`
  primary** (4.95:1 white-on-primary, comfortable AA) + a **warm coral `#E2603A`
  secondary** (a brand accent — use dark/large text if filled, ~3.5:1 white-on-coral).
  This replaced the old hot-pink/black default (`#E10069`, which barely cleared AA).
  Custom templates 1–4 clear 4.5:1. Always run `npm run audit` and report results;
  if a city's primary is light, the real platform would need dark button text.

## Building & extending the library (System-building mode)

Everything above is about **consuming** the library in a prototype. This section is
the **contract for growing it** — the source-grounded pipeline that turns a live
GoVocal screen into a verified, reusable primitive/component/page. Follow it
whenever System-building mode is active; don't eyeball screens into approximate CSS.

The four tools (all `npm` scripts; full docs in `govocal-exports/BACK-OFFICE.md`):

| Step | Command | What it does |
|---|---|---|
| **1. Capture** | `npm run capture -- <url> --name <slug> --probe "<real selectors>"` | Logs into the demo platform, dumps `page.png` · `dom.html` · `styles.json` · `meta.json`. `styles.json.digest` = every distinct visual treatment with **exact computed values** (read these, never eyeball the PNG); `--probe` pins selectors into `styles.json.probed` as verify checkpoints. |
| **2. Build** | — | Assemble from existing `.gv-*` primitives; map digest values to `--gv-*` **tokens** (don't hardcode a hex you can alias). New visual? decide *new variant vs base fix* — extend, don't mutate the base out from under existing users. |
| **3. Verify** | `npm run verify -- <built.html> --against <slug> --map "realSel=mineSel|…"` | Renders your build and **numerically diffs** computed styles vs the capture's probed checkpoints. Loop until ✓. Replaces "compare to the screenshot by eye." |
| **4. Register (ratchet)** | add to `govocal-exports/checkpoints.json`, then `npm run verify:all` | Once green, pin the checkpoint so it's guarded forever. After ANY change to shared CSS (`govocal-ui.css`/`govocal-bo.css`/`govocal-tokens.css`) run `verify:all` — green = real improvement, red = you regressed a dependent. `--changed .gv-btn` runs only a primitive's blast radius. |

Then store: snippet in `components.md`, row in `components/manifest.md` (+ `govocal-bo.css`
for back-office chrome), and `npm run index` to refresh `LIBRARY.md`.

**Why the ratchet matters:** primitives are *meant* to improve on each capture, but a
refinement that matches one screen can overfit and silently break the components
already using it. `verify:all` is what makes shared CSS monotonic — improvements
only, no regressions. Register a checkpoint for every piece you build so the guard
has teeth (e.g. it catches the back-office shell and the standalone sidebar drifting
apart). **Pages stay pure assembly** (components + tokens, no local colour/border/
shadow values) so primitive gains flow into them automatically.

## Refreshing from source (when GoVocal's design system moves)

1. Find the new commit SHA on `master` and update the pin here + in file headers.
2. Re-pull `front/app/component-library/utils/styleUtils.ts` and diff the token
   values into `govocal-tokens.css`.
3. Re-pull changed `components/<Name>/index.tsx` and reconcile `govocal-ui.css`.
4. Re-copy the three assets into any prototype that uses them.
5. Open `gallery.html`, screenshot it (webapp-testing), and `npm run audit`.

## Scope

v1 covers the focused primitives prototypes actually reach for: Button, Input/
Textarea, Title, Text, Checkbox, Radio, Toggle, Badge, StatusLabel, Spinner, Card,
Divider. The library has ~35 components; extend by transcribing more from source
following the same provenance discipline.
