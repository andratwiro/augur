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
| Header + nav | `components/header-nav/` | `.gv-header` `.gv-nav`/`.gv-nav__list` `.gv-nav__dd` `.gv-nav-m` · signed-in: `.gv-account` `.gv-avatar` `.gv-iconbtn__badge` | Responsive 78px site chrome (mirrors live `#e2e-navbar`): logo slot, `<nav aria-label="Primäre">` primary nav, dropdown + “Mehr ···” overflow, search, CTA; CSS-only hamburger drawer (real filled-bar icon) < 860px. **Two states:** signed-out (search + Sign-in CTA) and signed-in (search · notification w/ count badge · account avatar+name). **Active item** = tenant-tinted filled cell (`color-mix` on `--gv-tenant-primary`) + top accent bar (mirrors live `#e2e-navbar`); hover / open-dropdown get the grey cell highlight. |
| Footer | `components/footer/` | `.gv-footer` `.gv-footer__links` `.gv-powered-logo` | Source-grounded on `#hook-footer`: secondary-nav `<ul>` of legal links (Cookie-Einstellungen is a `<button>`) + “Ermöglicht durch go·vocal” attribution. No tenant logo. Links left / attribution right, stacks < 720px. |
| Project card + rail | `components/project-card/` | `.gv-rail` `.gv-pcard` (`.wide` `.square`) | Participation-project card (thumb, title, status meta, CTA) + horizontal scroll rail. Stretched-link card, no nested anchors. |
| Hero / banner | `components/hero/` | `.gv-hero` `.gv-avatars` | Full-bleed page banner: tenant-tinted overlay, title/lead, avatar+count stack, CTA. Image-agnostic. |
| Modal + login | `components/login-modal/` | `.gv-modal-overlay`/`.gv-modal` `.gv-modal__header`/`__title`/`__close`/`__body` `.gv-or` | Reusable dialog abstraction (overlay → card → title header + close + scrollable body), shown via GoVocal’s real “Before you participate” auth flow (email + “Or” + Google). ARIA on the card; primitives in body. |
| Survey fields | `components/survey-fields/` | `.sv-optcard` `.sv-rating` `.sv-scale` `.sv-sentiment` `.sv-rank` `.sv-imggrid`/`.sv-imgcard` `.sv-matrix` `.sv-map` `.sv-drop` · engine: `GVSurvey.field()` / `GVSurvey.mount()` | Every GoVocal input-form / survey **question type** (text · multiline · number · select · multiselect · rating · ranking · linear_scale · sentiment · image-select · matrix · map point/line/polygon · file/shapefile upload) **plus** the page-by-page runner (wizard, progress bar, Next-gating). Shared source = `skills/govocal-ui/govocal-survey.css` + `govocal-survey.js` — a self-contained kit on top of the gv-* primitives (its **own** stylesheet + JS, not folded into govocal-ui.css). Recall ONE widget: `el.innerHTML = GVSurvey.field({type:'matrix', …})`; build a whole survey: `GVSurvey.mount(el, FORM)`. Themeable `--gv-*`. Powers the **Input Form** page. |
| Phase timeline | `components/phase-timeline/` | `.gv-phases__bar` `.gv-pnav`/`.gv-dotmark` `.gv-stepper` `.gv-phase`/`.gv-pstep`/`.gv-pstep__dot`/`.gv-phase__label` `.gv-phasepanel`/`__num`/`__name`/`__date` | GoVocal’s project phase nav: a connected row of **chevron/arrow “ribbon” segments** (interlocking, number inside, label below); only the **current** phase is green with a “• N”. 3-button nav (Previous · Current · Next) top-right. Content panel leads with a big green numbered circle + green name + date. `role=tablist`/`tab`/`tabpanel`. |

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
