# GoVocal Components — manifest (recall index)

> **Internal / never ships.** This file is the *lightweight index* of the composed
> component library. When building a prototype, scan this table, then open the one
> component file you need (don't load them all). Snippets live in
> `skills/govocal-ui/components.md`; the styling is in `skills/govocal-ui/govocal-ui.css`
> (the `.gv-*` classes). Live demos are shipped under `/components/<name>/` (Components tab).

Each component is a self-contained demo folder under `components/<name>/` (same
convention as `pages/` and prototypes — copies the shared assets locally). The
shared CSS source of truth is `skills/govocal-ui/govocal-ui.css`; never fork it.

| Component | Folder | Key classes | What it is |
|---|---|---|---|
| Header + nav | `components/header-nav/` | `.gv-header` `.gv-nav`/`.gv-nav__list` `.gv-nav__dd` `.gv-nav-m` | Responsive 78px site chrome (mirrors live `#e2e-navbar`): logo slot, `<nav aria-label="Primäre">` primary nav, dropdown + “Mehr ···” overflow, search, CTA; CSS-only hamburger drawer (real filled-bar icon) < 860px. |
| Footer | `components/footer/` | `.gv-footer` `.gv-footer__links` `.gv-powered-logo` | Centered tenant logo, middot legal links, “Ermöglicht durch go·vocal” attribution (real logo via CSS mask). |
| Project card + rail | `components/project-card/` | `.gv-rail` `.gv-pcard` (`.wide` `.square`) | Participation-project card (thumb, title, status meta, CTA) + horizontal scroll rail. Stretched-link card, no nested anchors. |
| Hero / banner | `components/hero/` | `.gv-hero` `.gv-avatars` | Full-bleed page banner: tenant-tinted overlay, title/lead, avatar+count stack, CTA. Image-agnostic. |

## How to reuse in a prototype

1. Copy the shared assets into the prototype folder (prototypes are self-contained):
   `govocal-tokens.css`, `govocal-ui.css`, `govocal-themes.js` (+ `govocal-logo.svg`
   if you use the footer, + `govocal-cookies.js` on resident-facing prototypes).
2. Grab the component markup from `skills/govocal-ui/components.md` (or the demo
   `index.html`) and theme via `--gv-tenant-primary|secondary|text` — never hardcode brand hex.
3. Cities can also override `--gv-font-family` (e.g. Vienna ships `WienerMelange_W_Rg`).

## Adding a component

1. `components/<name>/index.html` — self-contained demo (copy the asset files in).
2. Add its `.gv-*` styles to `skills/govocal-ui/govocal-ui.css` (shared source of truth).
3. Add a snippet to `skills/govocal-ui/components.md` and a row to this table.
4. Rebuild — `build.js` auto-discovers `components/<name>/` and lists it on the Components tab.
