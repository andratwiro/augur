---
name: govocal-ui
description: Source-grounded GoVocal UI components for prototypes — real design tokens + copy-paste static-HTML primitives transcribed from the @citizenlab/cl2-component-library, plus a per-city ?theme= colour switcher. Consult when building or restyling any prototype so it matches the actual product, and use the tenant colour variables (never hardcode brand colours).
---

# GoVocal UI (source-grounded components)

The **fidelity layer**: tokens and components transcribed from the real product
code, so prototypes look like GoVocal — not an approximation. Companion to
`skills/govocal-design/` (brand voice / visual direction / when-to-use). This
skill is the *exact how*; that one is the *why & when*.

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
| `govocal-themes.js` | `?theme=` per-city colour switcher + on-screen picker. |
| `components.md` | The catalog — copy-paste HTML for every primitive, with notes. |
| `gallery.html` | Live demo of every component in every state, across all city themes. Open it to eyeball fidelity. |

## When to use

Consult this skill **whenever building or restyling any prototype**. It pairs with
the required front-end skill set in `CLAUDE.md` (design, a11y, webapp-testing).

## How to use it in a prototype

Prototypes are self-contained, so **copy the three asset files into the prototype
folder** and reference them locally:

```bash
cp skills/govocal-ui/{govocal-tokens.css,govocal-ui.css,govocal-themes.js} \
   <opportunity>/prototypes/<name>/
```

```html
<head>
  <link rel="stylesheet" href="govocal-tokens.css" />
  <link rel="stylesheet" href="govocal-ui.css" />
  <script src="govocal-themes.js" defer></script>
</head>
<body class="gv-root"> … </body>
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
- **Contrast:** the genuine brand pink `#ef0071` is ~4.3:1 for white-on-primary
  (just under AA), so the default `--gv-tenant-primary` is an AA-safe `#E10069`
  (4.77:1, visually identical); use `#ef0071` if exact brand match matters more.
  Custom templates 1–4 clear 4.5:1. Always run `npm run audit` and report results;
  if a city's primary is light, the real platform would need dark button text.

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
