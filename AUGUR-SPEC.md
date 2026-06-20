# Augur — Vision & Platform Spec

> Internal. Never published (lives outside any `prototypes/` folder).
> This is the contract the backend redesign makes into **hard rules**. Where this
> doc and old habits disagree, this doc wins.

## North star — Augur components behave like Figma components

A prototype **imports** a component as a **live instance**: a reference + its own
props (state, copy), never a pasted block of HTML. The canonical library is a
**read-only master** you can only read from. Editing a master **propagates to every
instance everywhere**. You can deliberately **detach** an instance to get a local,
editable copy that stops tracking — but that is an explicit choice, never the default.

"Linked" carries the **shape and the look**; the **state and copy are just props you
set per instance**. So an instance is fully linked *and* still has its own active
item / different label — exactly like a Figma variant. The two are not in tension.

## The hard rules

1. **Everything is an instance.** Every component is a function `GV.<name>(props)`
   that returns canonical markup, styled by the shared `.gv-*` CSS. **No consumer —
   library demo OR prototype — hand-authors `.gv-*` markup.** They call the renderer.
   (This is the `GVWidgets` pattern, generalised from widgets to *all* components.)

2. **Linked by default, detach explicitly.** Prototypes reference canonical instances;
   they do **not** copy markup or assets. `npm run detach <prototype> <component>`
   flattens one instance to local markup + a local CSS copy and marks it forked.
   Default state of every component in every prototype is **linked**.

3. **Tokens are law — ours is the *corrected* reference.** Every value references a
   token; **no literals** in canonical or in linked instances. The real GoVocal
   product has drifted off-grid; we **snap to the corrected scales** even where it
   visibly differs from production ("better, not different"). Source-grounded fidelity
   checkpoints are **re-baselined** to the corrected values, not treated as regressions.

   Corrected scales (each dimension on its own sensible steps):
   - **space**: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`
   - **type**: `12 / 14 / 16 / 18 / 20 / 24 / 30 / 36` (fonts get a clean scale, **not** a 4px grid)
   - **radius**: `4 / 8 / 12 / full`
   - **border / elevation**: defined scales, no one-off shadows
   - Off-grid literal in canonical or a linked instance = **lint failure**.

4. **Theming contract is unchanged.** Front office binds exactly the 4 city vars
   (`--gv-tenant-primary` / `secondary` / `text` / `font`). **Back office stays the
   neutral BO palette — it does not theme to a city.** "Linked colours where relevant"
   = FO components only.

5. **Linkage is visible (Shift + C).** Comment mode shows two things at once:
   - **Layer tint** — Tokens / Base / Components / Patterns / Pages each a colour, so
     you can see *what every part is*.
   - **Health badge** — `linked` (good) · `detached` (deliberately forked) ·
     `off-grid / hardcoded` (violation), so you can see *right vs off* at a glance.

6. **Lean for agents.** A slim index lets an agent load **only the component(s) it
   needs**, never the whole system. No front-loading the design system.

   **Token Experiment mode (Tokens page) — a feature, NOT a gate.** The correction is
   fully automated: Augur picks sensible corrected scales by engineering judgment and
   snaps everything to them, so the system is consistent **without the user tuning
   anything** ("I expect not to touch this"). The Experiment toggle still ships as a
   *visualization/convenience* on the Tokens page — edit the scales live, every linked
   component reflows, "copy corrected values" exports — but it is never a prerequisite
   for shipping a consistent system.

7. **Simplified scaffolding.** The manifests/instructions are cut down to what *this*
   project needs. No premature abstraction; no over-engineered pipeline.

## The engine (how an instance works)

```js
// canonical, in skills/govocal-ui/ — defined ONCE
GV.sidebar({ active: 'projects', items: [...], labels: {...} })
//   → returns canonical HTML
//   → styled by the live-linked shared .gv-* CSS (tokens flow in automatically)

// a prototype just calls it; it owns only its props (state + copy)
```

- One registry. Every component is an entry: `{ label, layer, tokens:[…], make(props) }`.
- Delivered via `<script src=".../govocal-instances.js">` + `<link>` for CSS — both
  resolve on `file://` and in `/dist`. **No `fetch()`** anywhere (that would break
  open-by-file).
- Props are the Figma "variants/properties": `active`, `items`, label overrides, etc.
- **Detach** is a build/CLI op that inlines the rendered markup and copies the CSS
  locally — the reverse of today's snapshot default.

## What changes from today (current → target)

| | Today | Target |
|---|---|---|
| Library demos (`components/`, `pages/`) | live-linked CSS ✓; markup hand-authored | instances; markup also linked |
| Widgets (`GVWidgets`) | true instance renderer ✓ (3 surfaces) | the **template** every component follows |
| Prototypes | copy assets into `assets/`, forked snapshots | **import instances, linked by default** |
| Tokens | partly off-grid, literals tolerated outside `gv-` | corrected scales, **no literals** in linked code |
| Overlay (Shift+C) | composition graph + `__GV_LINKED` badges | **layer tint + health badge** |
| Lint | guards `gv-` namespace, prototypes exempt | instances must be **linked or explicitly detached**; off-grid fails |

## Build sequence (gated, then parallel)

- **Phase 0 — Correct the tokens (gate).** Define the scales in `govocal-tokens.css`,
  snap primitives + components to tokens, re-baseline `verify:all`. *Blocks everything.*
- **Phase 1 — Pilot the engine (gate).** Convert the **back-office sidebar** to
  `GV.sidebar(props)`. Prove: a prototype imports it linked, sets its own `active`
  state, and `detach` works. Lock the conversion template.
- **Phase 2 — Fan out (parallel).** One agent per component family converts
  hand-authored components → instance renderers. Shared-atom edits go to
  `govocal-primitives.css` only, append-only, commit often.
- **Phase 3 — Overlay + lint + index (parallel).** Layer+health colours in the Shift+C
  overlay; lint extended to enforce linked-or-detached + no off-grid; slim agent index.
- **Phase 4 — Migrate + ship.** Rewrite all prototypes to linked imports, accept the
  visual shifts from snapping, re-shoot preview posters, deploy.

## Non-negotiables carried over

- Prototypes must still **open by `file://`** (no build step to *view* one).
- `build.js` publishes **only** `prototypes/` + library tiers + the canonical whitelist;
  internal docs (this file, `GOVOCAL.md`, `research.md`, `context.md`) never ship.
- Shared checkout: stage only changed paths, never `git add -A`; commit logical units.
