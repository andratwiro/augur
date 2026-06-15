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
| Project card + rail | `components/project-card/` | `.gv-rail` `.gv-pcard` (`.wide` `.square`) · **boxed:** `.gv-pcard.boxed` (`.horizontal`) `.gv-pcard__body`/`__spacer`/`__foot`/`__progress`/`__count` · grid `.gv-pgrid`(`.span-2`/`.span-3`) | Participation-project card (thumb, title, status meta, CTA). Two layouts: the **rail** (`.gv-rail` + borderless `.gv-pcard`) and the **boxed grid** card (`.gv-pcard.boxed` in a `.gv-pgrid` — bordered/elevated, padded `__body`, equal-height, with `.horizontal` full-width feature variant + folder `__count` badge). Stretched-link card, no nested anchors; boxed CTA is a real `.gv-btn` above the link. |
| **Homepage widgets** | `pages/homepage/` | `.gv-hero__cta` · `.gv-spotlight`/`__inner`/`__eyebrow`/`__title`/`__lead`/`__actions`/`__media` · `.gv-bubbles`/`.av`/`.count`/`__label` · `.gv-progress`/`__fill` · `.gv-ptoolbar` `.gv-tabs`/`.gv-tab` `.gv-filterbar`/`.gv-filter-btn` · `.gv-showmore` · `.gv-events__head`/`__empty` · `.gv-ctaband`/`__inner`/`__title`/`__lead` · `.gv-prose` · `.gv-status-label.finished` | The modern GoVocal landing-page anatomy, source-grounded on the live signed-in homepage (uxusertesting.govocal.com, Raleigh): banner overlay **CTA** pill, a "currently working on" **spotlight** (copy + media), **avatar bubbles + count**, **time-remaining progress bar**, the **projects toolbar** (status tabs + Tag/Area filter selectors), **show-more**, **events** empty state, **proposals CTA band**, and a **rich-text** block. Demoed end-to-end on the **Homepage** page. |
| Hero / banner | `components/hero/` | `.gv-hero` `.gv-avatars` | Full-bleed page banner: tenant-tinted overlay, title/lead, avatar+count stack, CTA. Image-agnostic. |
| Modal + login | `components/login-modal/` | `.gv-modal-overlay`/`.gv-modal` `.gv-modal__header`/`__title`/`__close`/`__body` `.gv-or` | Reusable dialog abstraction (overlay → card → title header + close + scrollable body), shown via GoVocal’s real “Before you participate” auth flow (email + “Or” + Google). ARIA on the card; primitives in body. |
| Survey fields | `components/survey-fields/` | `.sv-optcard` `.sv-rating` `.sv-scale` `.sv-sentiment` `.sv-rank` `.sv-imggrid`/`.sv-imgcard` `.sv-matrix` `.sv-map` `.sv-drop` · engine: `GVSurvey.field()` / `GVSurvey.mount()` | Every GoVocal input-form / survey **question type** (text · multiline · number · select · multiselect · rating · ranking · linear_scale · sentiment · image-select · matrix · map point/line/polygon · file/shapefile upload) **plus** the page-by-page runner (wizard, progress bar, Next-gating). Shared source = `skills/govocal-ui/govocal-survey.css` + `govocal-survey.js` — a self-contained kit on top of the gv-* primitives (its **own** stylesheet + JS, not folded into govocal-ui.css). Recall ONE widget: `el.innerHTML = GVSurvey.field({type:'matrix', …})`; build a whole survey: `GVSurvey.mount(el, FORM)`. Themeable `--gv-*`. Powers the **Input Form** page. |
| **Back-office app shell** | `components/bo-app-shell/` | scope `.gv-bo` · `.gv-bo-shell` `.gv-bo-side`/`__brand`/`__logo` `.gv-bo-nav`(`--bottom`)/`__item`(`.is-active`)/`__icon` `.gv-bo-count` · `.gv-bo-topbar`/`__title`/`__actions` `.gv-bo-meta`/`__item` · `.gv-bo-tabs`(`--sub`)/`.gv-bo-tab`(`.is-active`)/`__new` | **The first BACK-OFFICE component.** The staff-facing chrome shared by every BO screen: dark teal/navy sidebar (icon+label nav, active cell, red count badge), project top-bar (title · status pills · actions), and the project tab row. GoVocal's own fixed theme — **not** city-themed. The `.gv-bo` scope remaps `--gv-tenant-*` → the fixed BO palette (`govocal-bo.css` + `--gv-bo-*` tokens), so existing primitives (`.gv-btn.admin-dark`, `.gv-iconbtn`, inputs, focus) render in BO colours unchanged. Phase ribbon, sub-tabs, tables and stat cards mount inside `.gv-bo-main`. |
| Phase timeline | `components/phase-timeline/` | `.gv-phases__bar` `.gv-pnav`/`.gv-dotmark` `.gv-stepper` `.gv-phase`/`.gv-pstep`/`.gv-pstep__dot`/`.gv-phase__label` `.gv-phasepanel`/`__num`/`__name`/`__date` | GoVocal’s project phase nav: a connected row of **chevron/arrow “ribbon” segments** (interlocking, number inside, label below); only the **current** phase is green with a “• N”. 3-button nav (Previous · Current · Next) top-right. Content panel leads with a big green numbered circle + green name + date. `role=tablist`/`tab`/`tabpanel`. |

## How to reuse in a prototype

1. Copy the shared assets into the prototype folder (prototypes are self-contained):
   `govocal-tokens.css`, `govocal-ui.css`, `govocal-themes.js` (+ `govocal-logo.svg`
   if you use the footer, + `govocal-cookies.js` on resident-facing prototypes).
   **Back-office (staff) UI:** also copy `govocal-bo.css` and scope markup under
   `.gv-bo` — that surface uses GoVocal's fixed teal/navy theme, not `?theme=`.
2. Grab the component markup from `skills/govocal-ui/components.md` (or the demo
   `index.html`) and theme via `--gv-tenant-primary|secondary|text` — never hardcode brand hex.
3. Cities can also override `--gv-font-family` (e.g. Vienna ships `WienerMelange_W_Rg`).

## Adding a component

1. `components/<name>/index.html` — self-contained demo (copy the asset files in).
2. Add its `.gv-*` styles to `skills/govocal-ui/govocal-ui.css` (shared source of truth).
3. Add a snippet to `skills/govocal-ui/components.md` and a row to this table.
4. Rebuild — `build.js` auto-discovers `components/<name>/` and lists it on the Components tab.
