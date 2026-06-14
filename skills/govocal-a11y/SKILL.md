---
name: govocal-a11y
description: Design-level accessibility for GoVocal prototypes (WCAG 2.2 AA, the perceivable/visual parts). Prototypes are visual guidance, so get color contrast, use-of-color, legible type, target sizes, focus styling and motion right — deeper keyboard/ARIA/semantics are the dev team's job on the real codebase. Build compliant, run `npm run audit`, flag failings in chat.
---

# GoVocal Accessibility — design-level (WCAG 2.2 AA)

GoVocal's mission is *"hearing the many, not the few."* The real platform is
**WCAG 2.2 AA certified** (audited with AnySurfer). These prototypes are **visual
guidance** for what to build — not the shipping implementation — so this skill scopes
accessibility to **the decisions a mockup actually makes**: the *perceivable / visual*
layer. Complementary to `skills/govocal-design/`.

## Scope — what a prototype is responsible for

**✅ In scope (a design decision — get it right here):**
- **Color contrast** — text and meaningful UI must be legible. *The one we can't
  afford to fail.*
- **Use of color** — never let color be the *only* signal (status, errors, active
  state, links in text).
- **Legible type & scaling** — readable sizes; layout survives zoom; pinch-zoom never
  disabled.
- **Target sizes** — tap/click targets big enough and not cramped (≥ 24×24px).
- **Visible focus styling** — a clear focus *look* (the visual, not the JS behavior).
- **Motion** — no autoplaying/flashing motion; honor `prefers-reduced-motion`.
- **Meaningful imagery** — don't encode essential info in an image with no visible
  text equivalent.

**⛔ Out of scope (the dev team handles this on the real GoVocal codebase):**
full keyboard operability, ARIA roles/states, focus management & traps, screen-reader
semantics, live regions, form-error wiring. A prototype should *visually represent*
these states (show the focus ring, show the error style, show the open menu) — it does
**not** need to be perfectly keyboard- or screen-reader-operable. Don't over-engineer
ARIA into a mockup; represent the design, leave the implementation to engineering.

> Rule of thumb: if it's something you'd *see in a screenshot*, it's in scope. If it
> only matters when you *operate the thing with a keyboard or screen reader*, it's the
> dev team's.

## How this is enforced

Not by the build (these are prototypes) — by me, the agent:

1. **Build it right visually.** Apply the checklist below as I write markup.
2. **Audit, then flag in chat.** After building/modifying a prototype, run the audit
   and report any failings (rule, element, fix). Never silently ship a contrast or
   use-of-color failure.

## When to use

- Whenever building or modifying any prototype under `<opportunity>/prototypes/`.
- Before calling a prototype done / before deploy — run the audit, report the result.

## Run the audit

```bash
npm run audit                  # all prototypes — DESIGN-LEVEL checks only (default)
npm run audit -- <path>        # one prototype dir or .html file
npm run audit -- --all         # full WCAG 2.2 AA audit — for the dev handoff
```

Default run reports only the rules a mockup owns: **`color-contrast`,
`link-in-text-block`, `meta-viewport` (zoom), `target-size`**. It loads each prototype
in headless Chromium (axe-core) and prints impact, rule id, help text, and offending
selectors. Non-blocking (exits 0) — the point is awareness.

First run needs the browser once: `npx playwright install chromium`.

`--all` runs the complete WCAG 2.2 AA rule set (keyboard, ARIA, labels, landmarks,
etc.). Use it when packaging a prototype for engineering so they inherit the full
list — but don't hold a *prototype* to it.

## Flag the moment these come up (design-level)

When a request would bake in a *visual* accessibility failure, say so and do it right —
don't wait for the audit:

| Ask | The trap | Do this |
|---|---|---|
| **Color-only state** (active filter, error, status) | 1.4.1 Use of Color | Pair color with text, icon, underline, or shape |
| **Links by color alone** in body text | 1.4.1 | Underline them (or another non-color cue) |
| **Low-contrast text / muted grays** | 1.4.3 | Meet 4.5:1 (3:1 for large text) — pick a darker token |
| **Icon-only control** | Unlabeled + tiny | Add a visible label or tooltip text; target ≥ 24×24px |
| **Tiny / cramped tap targets** | 2.5.8 | ≥ 24×24px, or space them apart |
| **Disabled zoom** (`user-scalable=no`) | 1.4.4 | Never disable zoom |
| **Autoplaying / flashing motion** | 2.2.2 / 2.3.1 | No autoplay; honor `prefers-reduced-motion`; no >3 flashes/sec |

## Build-by-default checklist (perceivable)

**Color & contrast** *(most important)*
- Body text contrast ≥ **4.5:1**; large text (≥24px, or ≥18.7px bold) ≥ **3:1**.
- Meaningful UI elements & focus rings ≥ **3:1** vs adjacent color (1.4.11).
- **Never** use color as the only way to convey info — add text/icon/shape (1.4.1).
- Check both light and dark mode if the prototype themes.

**Type & layout**
- Readable sizes; don't disable pinch-zoom; layout holds at ~200% zoom / ~320px wide.

**Targets**
- Pointer targets ≥ **24×24px** or spaced apart (2.5.8).

**Focus (visual only)**
- Keep a visible focus style — never `outline: none` without a clear replacement. (The
  *styling* is design; full focus management is the dev team's.)

**Imagery**
- `<img>` gets `alt` (descriptive, or `alt=""` if decorative) — cheap, do it. Don't put
  essential info only inside an image with no visible text.

**Motion**
- Honor `@media (prefers-reduced-motion: reduce)`; no autoplaying or flashing content.

## Copy-paste snippets

```css
/* Visible focus style — the design of the focus state. */
:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration:.001ms!important; transition-duration:.001ms!important; }
}
```

```html
<!-- Status shown by MORE than color: icon/text alongside the color -->
<span class="badge badge--success">✓ Open for input</span>   <!-- not color alone -->

<!-- Links in body text carry a non-color cue -->
<p>Read the <a href="#" style="text-decoration:underline">full proposal</a>.</p>
```

## Handing off to engineering

When a prototype is greenlit for build, the deeper accessibility work is the dev
team's, against the real WCAG 2.2 AA codebase. Point them at:
- The full audit: `npm run audit -- --all`.
- **W3C ARIA Authoring Practices Guide** for correct keyboard/ARIA on interactive
  widgets: https://www.w3.org/WAI/ARIA/apg/patterns/

## Notes

- Prototypes stay self-contained static HTML/JS — snippets are inline/local, no shared
  dependency.
- Audit tooling (Playwright + axe-core) lives in **devDependencies**; it never ships
  inside a prototype or to `/dist`.
