---
name: govocal-design
description: GoVocal design system — consult when building any prototype to keep visuals, components, tone, and interaction patterns consistent. (STUB — fill in.)
---

# GoVocal Design System (stub)

> Placeholder skill. Replace the sections below with the real GoVocal design
> system so every prototype stays on-brand and consistent.

## When to use

Consult this skill **whenever building or modifying a prototype** under any
`<opportunity>/prototypes/` folder.

## Product grounding first: `GOVOCAL.md`

Before designing a GoVocal surface, read **`GOVOCAL.md`** (repo root) — the internal
product-context brief + living project brain. It defines what a
Project/Phase/Input/participation-method actually is, the exact terminology and asset
specs to mirror, the roles, and the constraints. This skill owns *how it looks and
sounds*; `GOVOCAL.md` owns *what the thing is*. Get the product model right there
first, then style it here.

## To fill in

- **Brand:** logo usage, voice & tone.
- **Color:** palette + semantic tokens (background, text, accent, states).
- **Typography:** font families, scale, weights, line-height.
- **Spacing & layout:** grid, spacing scale, breakpoints.
- **Components:** buttons, inputs, cards, nav — markup + styles to copy.
- **Patterns:** common flows and interaction conventions.
- **Assets:** where to find icons, illustrations, and shared CSS.

## Companion: govocal-ui (real components & tokens)

For the **exact, source-grounded** components and colour tokens — transcribed from
the real product (`@citizenlab/cl2-component-library`) — use the companion skill
`skills/govocal-ui/`. This skill (govocal-design) owns brand voice, tone, and
visual *direction / when-to-use*; govocal-ui owns the *exact how*: `--gv-*` tokens,
`.gv-*` component CSS, the catalog, and the per-city `?theme=` switcher. Build with
its `var(--gv-tenant-primary|secondary|text)` variables — never hardcode brand hex.

## Notes

Prototypes are self-contained static HTML/JS, so prefer copy-pasteable snippets
(inline CSS or a small local stylesheet) over a shared build dependency.
