# GoVocal UI — component catalog

Static-HTML reproductions of the product's `@citizenlab/cl2-component-library`
primitives. Every snippet uses classes from `govocal-ui.css` and tokens from
`govocal-tokens.css`. **Provenance:** all values transcribed from
`CitizenLabDotCo/citizenlab @ 5d67730`, `front/app/component-library/`.

> **Golden rule:** never hardcode a brand colour. Use `var(--gv-tenant-primary)`,
> `var(--gv-tenant-secondary)`, `var(--gv-tenant-text)` (city-configurable) and the
> semantic tokens. This is what lets `?theme=` re-skin a prototype per city.

Storybook (visual ground-truth): each component has a `*.stories.tsx` in its
source folder; run the library's Storybook locally to compare pixel-for-pixel.

---

## Setup

A **prototype** copies the assets in (it's self-contained). A **library demo**
(`components/`, `pages/`) instead references canonical via `../../skills/govocal-ui/`
— never copy there. For a prototype, copy `govocal-tokens.css`,
`govocal-primitives.css`, `govocal-ui.css`, `govocal-themes.js` (+ `govocal-bo.css`
for back-office), then:

```html
<link rel="stylesheet" href="govocal-tokens.css" />
<link rel="stylesheet" href="govocal-ui.css" />   <!-- @imports govocal-primitives.css -->
<script src="govocal-themes.js" defer></script>   <!-- ?theme= switcher + picker -->
<body class="gv-root"> … </body>
```

---

## Button — `components/Button`

`.gv-btn` + a style + optional `.size-m|l|xl` + optional `.full`.

```html
<button class="gv-btn primary"><span class="gv-btn__label">Submit</span></button>
<button class="gv-btn primary-outlined">Cancel</button>
<button class="gv-btn secondary">Secondary</button>
<button class="gv-btn white">On colour</button>
<button class="gv-btn text">Text button</button>
<button class="gv-btn delete">Delete</button>
<button class="gv-btn admin-dark size-m">Admin</button>
<button class="gv-btn primary" disabled>Disabled</button>
<button class="gv-btn primary processing"><span class="gv-btn__label">Saving</span><span class="gv-spinner sm"></span></button>
```

- **Styles:** `primary` (tenant primary, white text), `primary-outlined`,
  `primary-inverse`, `secondary`, `white` (shadow), `text`, `admin-dark`,
  `admin-dark-outlined`, `admin-dark-text`, `delete` (red600).
- **Sizes:** default `9px 18px`/16px · `size-m` `11px 22px`/18px ·
  `size-l` `13px 24px`/21px · `size-xl` `15px 26px`/21px (lh 28). Radius 3px.
- **States:** `:hover` darkens (approximated via `filter: brightness`),
  `disabled` → opacity .37, `processing` hides the label and shows `.gv-spinner`.

## Text input / textarea — `defaultInputStyle`, `components/Input`

```html
<label class="gv-label" for="email">Email</label>
<input class="gv-input" id="email" type="email" placeholder="you@example.com" />

<input class="gv-input error" value="nope" aria-invalid="true" />
<p class="gv-error-text">⚠ Enter a valid email address.</p>

<input class="gv-input" disabled value="Disabled" />
<textarea class="gv-textarea" placeholder="Your idea…"></textarea>
```

- Height 48px, padding 12px, 1px `--gv-border-dark`, radius 3px, font 16px.
- Hover → border `#000`. Focus → 2px tenant-primary outline.
  `.error` → red600 border; error+focus → red glow (`--gv-shadow-error`).
- `.size-small` → 14px / 10px padding.

## Title & Text — `components/Title`, `components/Text`

```html
<h1 class="gv-title h1">Page title</h1>   <!-- h1=30 h2=25 h3=21 h4=18 h5=16 h6=14, bold, lh 1.3 -->
<p class="gv-text bodyM">Body copy.</p>    <!-- bodyL=18/600 bodyM=16 bodyS=14 bodyXs=12, lh 1.5 -->
<p class="gv-text bodyS gv-text--secondary">Muted secondary text.</p>
```

## Checkbox — `components/Checkbox`

Checked state is **success green** (`--gv-success`), not the tenant primary.

```html
<label class="gv-checkbox">
  <input type="checkbox" checked />
  <span class="box"><span class="check">✓</span></span>
  Keep me updated
</label>
```

24px box, radius 3px, border `--gv-border-dark`; hover border `#000`;
focus outline tenant-primary.

## Radio — `components/Radio`

```html
<label class="gv-radio">
  <input type="radio" name="opt" checked /><span class="circle"></span> Option A
</label>
<label class="gv-radio">
  <input type="radio" name="opt" /><span class="circle"></span> Option B
</label>
```

20px circle, 12px inner dot (`--gv-tenant-primary`). Hover border `#000`.

## Toggle — `components/Toggle`

```html
<label class="gv-toggle">
  <input type="checkbox" checked /><span class="track"></span>
  <span class="label">Notifications</span>
</label>
```

Track knob 21px; **off** `#ccc`, **on** `--gv-success`; disabled → opacity .25.

## Badge — `components/Badge`

```html
<span class="gv-badge" style="color: var(--gv-teal-500)">New</span>
<span class="gv-badge inverse" style="color: var(--gv-success)">Live</span>
```

Uppercase, 12px, weight 500, radius 3px. Outlined by default (`color` sets the
border+text); `.inverse` fills with that colour and white text.

## StatusLabel — `components/StatusLabel`

Filled status pill; set the background via `--bg`.

```html
<span class="gv-status-label" style="--bg: var(--gv-success)">Published</span>
<span class="gv-status-label" style="--bg: var(--gv-orange-500)">Pending</span>
<span class="gv-status-label outlined">Draft</span>
```

## Spinner — `components/Spinner`

```html
<span class="gv-spinner"></span>          <!-- 32px / 3px / #666 -->
<span class="gv-spinner sm"></span>       <!-- 20px -->
```

## Card & Divider

```html
<div class="gv-card hoverable"> … </div>   <!-- white, radius 3px, soft shadow, hover lift -->
<hr class="gv-divider" />
```

## Icons — `govocal-icons.js` (`components/Icon`)

The real GoVocal icon set (Material-Design-derived paths), transcribed verbatim from
`components/Icon/index.tsx`. Curated 67-icon subset of what the product UI actually uses.

```html
<script src="govocal-icons.js" defer></script>

<!-- Drop an icon anywhere; it fills with an inline <svg class="gv-icon"> -->
<span data-gv-icon="vote-up"></span>                 <!-- decorative → auto aria-hidden -->
<span data-gv-icon="comment" aria-label="Comments"></span>  <!-- meaningful → label it -->
<button class="gv-iconbtn" aria-label="Search"><span data-gv-icon="search"></span></button>
```

- **Sizing/colour:** `.gv-icon` is `1em` and `fill: currentColor` — set the parent's
  `font-size`/`color` and the icon follows (so it re-themes with `--gv-tenant-*`).
- **API:** `window.GVIcons.svg("search")` → markup string; `.names` → sorted list;
  `.render(root)` → rescan after injecting new `[data-gv-icon]` nodes.
- **Names (67):** navigation/UI — `search close menu dots-horizontal plus minus check
  edit delete settings filter refresh link open-in-new download send share
  chevron-{up,down,left,right} arrow-{up,down,left,right}`; participation — `vote-up
  vote-down idea comment comments basket basket-plus survey initiatives volunteer flag
  bookmark bookmark-outline eye eye-off stars`; meta — `user user-circle group calendar
  calendar-range clock location-simple gps map info-outline info-solid alert-circle
  check-circle lock key email notification home trend-up money-bag timeline pen label`;
  account menu (transcribed live from the user dropdown) — `shield` (Manage platform)
  `cogs` (My settings) `power` (Sign out).
- **More icons exist** in the repo (~130 total incl. SSO/sidebar glyphs); extend
  `govocal-icons.js` from `Icon/index.tsx` @ `5d67730` following the same discipline.

---

# Composed components (Components tab)

Section-level blocks assembled from the primitives above. Full, copy-ready demos live
in `components/<name>/index.html` (and ship to `/components/`); the recall index is
`components/manifest.md`. Skeletons below — open the demo for the complete markup.

> **Front office vs back office.** Everything below the next divider is **front-office**
> (resident-facing, city-themed via `?theme=`). The **back-office** (staff) surface uses
> GoVocal's own fixed teal/navy theme — load `govocal-bo.css` and scope under `.gv-bo`,
> which remaps `--gv-tenant-*` so the same primitives render in BO colours.

## Back-office sidebar — `.gv-bo-side` (`components/bo-sidebar/`)

Standalone, responsive. **Extended** 224px (teal brand band + navy nav, 24px blue
icons + white labels, active = dark cell). Collapses to an **80px icon rail** at
≤1200px — add `.is-rail` to force it, or `data-gv-side-auto` + the matchMedia snippet
to auto-toggle. Labels go in `.gv-bo-nav__label` (hidden in the rail); the count badge
overlaps the icon when collapsed.

```html
<nav class="gv-bo-side" aria-label="Admin">   <!-- + .is-rail to collapse to 80px -->
  <a class="gv-bo-side__brand" href="#">
    <span class="gv-bo-side__logo"><span data-gv-icon="arrow-left"></span></span>
    <span class="gv-bo-side__brandtext">To platform</span>
  </a>
  <div class="gv-bo-nav">
    <a class="gv-bo-nav__item is-active" href="#" title="Projects">
      <span class="gv-bo-nav__icon" data-gv-icon="survey"></span><span class="gv-bo-nav__label">Projects</span></a>
    <!-- …more items… -->
  </div>
  <div class="gv-bo-nav gv-bo-nav--bottom">
    <a class="gv-bo-nav__item" href="#" title="Notifications">
      <span class="gv-bo-nav__icon" data-gv-icon="notification"></span><span class="gv-bo-nav__label">Notifications</span><span class="gv-bo-count">29</span></a>
  </div>
</nav>
```
```js
// auto-collapse at 1200px (the product's breakpoint)
const mq = matchMedia("(max-width: 1200px)");
const sync = () => document.querySelectorAll("[data-gv-side-auto], .gv-bo-shell")
  .forEach((el) => el.classList.toggle("is-rail", mq.matches));
mq.addEventListener("change", sync); sync();
```

## Back-office app shell — `.gv-bo-shell` (`components/bo-app-shell/`)

The persistent staff chrome: navy sidebar + project top-bar + project tabs. Scope the
whole app under `.gv-bo`; mount the page in `.gv-bo-main`. Reuses `.gv-btn.admin-dark`
(primary, `#044D6C`), `.gv-btn.secondary-outlined`, `.gv-iconbtn` — no new button code.

```html
<div class="gv-bo gv-bo-shell">
  <nav class="gv-bo-side" aria-label="Admin">
    <a class="gv-bo-side__brand" href="#"><span class="gv-bo-side__logo">…</span> To platform</a>
    <div class="gv-bo-nav">
      <a class="gv-bo-nav__item is-active" href="#"><span class="gv-bo-nav__icon" data-gv-icon="survey"></span>Projects</a>
      <!-- …more items… -->
    </div>
    <div class="gv-bo-nav gv-bo-nav--bottom">
      <a class="gv-bo-nav__item" href="#"><span class="gv-bo-nav__icon" data-gv-icon="notification"></span>Notifications<span class="gv-bo-count">29</span></a>
    </div>
  </nav>
  <div class="gv-bo-main">
    <header class="gv-bo-topbar">
      <div class="gv-bo-topbar__row">
        <div>
          <h1 class="gv-bo-topbar__title">Project title</h1>
          <div class="gv-bo-meta"><span class="gv-bo-meta__item"><span class="gv-icon" data-gv-icon="eye"></span>Public</span></div>
        </div>
        <div class="gv-bo-topbar__actions">
          <button class="gv-btn admin-dark"><span data-gv-icon="check"></span><span class="gv-btn__label">Published</span></button>
        </div>
      </div>
      <nav class="gv-bo-tabs" aria-label="Project">
        <a class="gv-bo-tab is-active" href="#">Timeline</a>
        <a class="gv-bo-tab" href="#">Audience</a>
      </nav>
    </header>
    <!-- page content here -->
  </div>
</div>
```

---

## Back-office config forms — `.gv-bo-*` (`pages/bo-project-phase/`)

The deep project-configuration editor (`/admin/projects/<id>/…`). All values
source-grounded from the live captures (`bo-phase-setup`, `bo-project-general`,
`bo-project-audience`, `bo-project-events`); verified via the `bo-project-phase/*`
checkpoints. Everything scopes under `.gv-bo` so the BO palette applies.

- **Headings:** `.gv-bo-formhead` (21/700 blue), `.gv-bo-subhead` (18/700 blue),
  `.gv-bo-caption` (14/700 cool-grey), `.gv-bo-qlabel` (16/600 blue), `.gv-bo-help`
  (14 secondary).
- **Controls:** reuse `.gv-input`/`.gv-textarea`, `.gv-toggle`, `.gv-radio`
  (BO selected-dot is success-green via the `.gv-bo` scope), `.gv-checkbox`.
  New: `.gv-bo-select` (native select styled like `.gv-input`).
- **`.gv-bo-banner`** — light-teal info callout (icon + text, `--gv-teal-100`).
- **`.gv-bo-methods` / `.gv-bo-methodcard`(`.is-selected`)** — participation-method
  / view picker grid (icon · title · desc; selected = `--gv-teal-75` + blue border).
- **`.gv-bo-togglerow`** — label/help on the left, `.gv-toggle` pinned right; rows
  divided by a top border.
- **`.gv-bo-tags` / `.gv-bo-tag`(`.is-selected`)** — selectable tag chips (5px radius).
- **`.gv-bo-imageup`** (`__preview`/`__remove`) + **`.gv-bo-dropzone`** — image upload.
- **`.gv-bo-table`** (`thead th`, `__person`/`__avatar`/`__name`/`__sub`/`__opts`) +
  **`.gv-bo-toolbar`** (`.gv-bo-search`) + **`.gv-bo-pager`** — admin data table.
- **`.gv-bo-pane` / `.gv-bo-card`** — white card on a grey gutter (Messaging/Events).
- **`.gv-bo-empty`** (`__icon`/`__title`/`__text`) — empty state.
- **`.gv-bo-eventrow`** (`__main`/`__title`/`__dates`/`__count`/`__actions`) — events list.
- New button variant: **`.gv-btn.success`** (green CTA, `--gv-green-600`) + size **`.gv-btn.size-s`**.

The page wires the six project top-tabs (General · Timeline · Audience · Messaging ·
Events · 360 Input) to swap panels in JS, and the **Timeline → phase** panel wires four
`.pp-sub` sub-tabs (Setup · Input manager · Input form · Insights) — a clickable
starting point for BO flows.

### Phase sub-tab views (grounded on `bo-project-ideas`, `bo-input-form-builder`, `bo-phase-insights`)

- **Input manager** — `.gv-bo-imgr` (216px rail + table grid):
  - **`.gv-bo-table.is-bordered`** — posts-table card variant: 1px `--gv-grey-300`
    outline + 3px radius, even rows `--gv-bo-row-alt`. Blue 700 headers (the base
    `thead th` is now the grounded `--gv-bo-primary`/12px). `__check` (narrow checkbox
    col), `__num` (centred count cols), `__title` (idea link). **`.gv-bo-th--sort`**
    (`.is-sorted` → `--gv-grey-200` tint) = sortable header.
  - **`.gv-bo-filterrail`** (`__tabs`/`__tab`/`__group`/`__item`(`.is-active`)/`__count`)
    — bordered Timeline/Tags/Status facet rail with per-phase counts.
  - **`.gv-bo-banner--ai`** — the teal callout with a right-pushed `__cta`.
  - **`.gv-bo-headrow`** (`__title`/`__actions`), **`.gv-bo-count-line`**,
    **`.gv-bo-link`** (icon + text link, e.g. Exports).
- **Input form** — **`.gv-bo-eyebrow`** (uppercase section caption) +
  **`.gv-bo-importlist`** / **`.gv-bo-importcard`** (`__icon` light-blue tile · `__main`
  `__title`/`__desc` · `__actions` link + primary button). Source cards (Paper-OCR,
  Spreadsheet) measured at 1px `--gv-grey-300`/3px/12px.
- **Insights** (SHARED — both surfaces) — **`.gv-bo-statgrid`** auto-fill grid of
  **`.gv-bo-stat`** cards (`__top` label + `__icon`, `__num` 34/700 blue, `__delta`
  7-day change). White/3px/`var(--gv-shadow)`/17px. **`.gv-bo-chartcard`**
  (`__title`/`__sub` + inline `<svg>` area plot). Header pairs Download with a green
  `.gv-btn.success` AI-analysis CTA.

---

## Header + nav — `.gv-header` (`components/header-nav/`)

Responsive 78px chrome. CSS-only: dropdowns and the “Mehr ···” overflow are
`<details>`; the mobile drawer (`< 860px`) is `<details class="gv-nav-m">`. No JS.
Markup mirrors the live product — `header#e2e-navbar`, a `<nav aria-label="Primäre">`
primary-nav landmark around `<ul class="gv-nav__list">`, and the real GoVocal
filled three-bar hamburger icon.

```html
<header id="e2e-navbar" class="gv-header sticky">
  <div class="gv-header__inner">
    <a class="gv-brand" href="#" data-gv-logo aria-label="Home" aria-current="page"></a>  <!-- logo slot (themes per city) -->
    <nav class="gv-nav" aria-label="Primäre">
      <ul class="gv-nav__list">
        <li><a class="gv-nav__link" href="#" aria-current="page">Willkommen</a></li>
        <li><details class="gv-nav__dd"><summary class="gv-nav__link">Beteiligungsprojekte <svg class="gv-nav__chev">…</svg></summary>
          <div class="gv-nav__menu"><a href="#">Alle Projekte</a>…</div></details></li>
        <li><a class="gv-nav__link" href="#">Mitmachen</a></li>
        <li><details class="gv-nav__dd right"><summary class="gv-nav__link">Mehr <svg>…</svg></summary>
          <div class="gv-nav__menu">…</div></details></li>
      </ul>
    </nav>
    <div class="gv-header__actions">
      <button class="gv-iconbtn gv-desktop-only" aria-label="Suche">…</button>
      <button class="gv-btn primary gv-desktop-only">Anmelden</button>
      <details class="gv-nav-m">
        <summary aria-label="Mobiles Navigationsmenü anzeigen">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z"/></svg>
        </summary>
        <nav class="gv-nav-m__panel">…links… <button class="gv-btn primary full">Anmelden</button></nav>
      </details>
    </div>
  </div>
</header>
```
- The bar is **full-width** (`.gv-header__inner` is `width:100%`, `box-sizing:border-box`):
  logo flush-left, actions flush-right — like the live product — while page content stays capped.
- Active link → tenant **top-bar + subtle tinted cell** via `aria-current="page"`. **Not bold**
  (weight stays 500, matching the product). Add `sticky` to pin.
- Logo: `data-gv-logo` (themes per city) or drop a literal `<svg>`/`<img>` in `.gv-brand`.
- Primary nav is a `<nav aria-label="Primäre">` landmark; the `<ul>` carries `.gv-nav__list`.
- Hamburger uses the real GoVocal filled three-bar icon (`M3,6H21V8H3V6…`), not a generic stroked one.

### Signed-out vs signed-in — one component, a state switch

Same header; the **actions** cluster swaps. Wrap each cluster in `.gv-auth-out` /
`.gv-auth-in` and set `data-auth="out" | "in"` on a root (e.g. `<body>`): the matching
cluster shows, the other hides (`display:none`). Flip it for a quick demo of both —
no real auth logic. In the mobile drawer the wrappers are `display:contents`, so their
links flow into the drawer grid.

```html
<div class="gv-header__actions">
  <button class="gv-iconbtn gv-desktop-only" aria-label="Search">…</button>

  <span class="gv-auth-out gv-desktop-only"><button class="gv-btn primary">Sign in</button></span>

  <span class="gv-auth-in gv-desktop-only">
    <button class="gv-iconbtn" aria-label="Notifications, 3 unread">…bell…<span class="gv-iconbtn__badge">3</span></button>
    <details class="gv-nav__dd right gv-account-dd">                  <!-- account = a dropdown -->
      <summary class="gv-account"><span class="gv-avatar">GV</span><span class="gv-account__name">Go Vocal</span><svg class="gv-nav__chev">…</svg></summary>
      <div class="gv-nav__menu" style="min-width:220px">
        <a href="#">Manage platform <svg>…</svg></a>
        <a href="#">My activity <svg>…</svg></a>
        <a href="#">My settings <svg>…</svg></a>
        <div class="gv-menu-sep"></div>
        <button type="button">Sign out <svg>…</svg></button>
      </div>
    </details>
    <details class="gv-nav__dd right">                               <!-- language switcher -->
      <summary class="gv-lang">EN <svg class="gv-nav__chev">…</svg></summary>
      <div class="gv-nav__menu"><a href="#">English</a><a href="#">Español</a></div>
    </details>
  </span>
  <details class="gv-nav-m">…hamburger; put .gv-auth-out / .gv-auth-in inside the drawer too…</details>
</div>
```
- Account menu items are `.gv-nav__menu a` / `button` (flex, trailing icon, `.gv-menu-sep`
  divider before Sign out) — source-grounded on the live user menu (Manage platform · My
  activity · My settings · Sign out).

## Footer — `.gv-footer` (`components/footer/`)

```html
<footer class="gv-footer">
  <div class="gv-footer__inner">
    <nav class="gv-footer__links" aria-label="Secondary">
      <ul>
        <li><a href="#">Nutzungsbedingungen</a></li>
        <li><a href="#">Impressum &amp; Datenschutz</a></li>
        <li><a href="#">Cookierichtlinie</a></li>
        <li><a href="#">Richtlinie zur Barrierefreiheit</a></li>
        <li><button type="button">Cookie-Einstellungen</button></li>
        <li><a href="#">Sitemap</a></li>
      </ul>
    </nav>
    <div class="gv-footer__powered"><span>Ermöglicht durch</span>
      <a href="https://govocal.com/" target="_blank" rel="noopener" aria-label="Go Vocal">
        <img class="gv-powered-logo" src="govocal-logo.svg" alt="Go Vocal" /></a>
    </div>
  </div>
</footer>
```
- Source-grounded on the real `<footer id="hook-footer">`: a secondary-nav row of legal
  links + the powered-by mark, **no tenant logo** (that lives in the header).
- Links are a semantic `<ul>` in a `<nav aria-label="Secondary">`; **Cookie-Einstellungen
  is a `<button>`** (opens the cookie dialog), the rest are `<a>`. Middot separators are
  automatic. Desktop = links left / attribution right; under 720px it stacks & centers.
- Copy `govocal-logo.svg` into the prototype folder. The go·vocal mark is GoVocal’s brand
  (muted grey) — it doesn’t theme per city.

## Modal + login — `.gv-modal` (`components/login-modal/`)

The reusable dialog abstraction (mirrors GoVocal’s `#modal-portal` → `.modalcontent`):
an overlay scrim centres a card with a title header, a top-right close button, and a
scrollable body. The **card** is the dialog — put the ARIA on it, not the overlay.

```html
<div class="gv-modal-overlay is-open">                    <!-- scrim; toggle .is-open to show -->
  <div class="gv-modal size-s" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <div class="gv-modal__header"><h1 class="gv-modal__title" id="m-title">Before you participate</h1></div>
    <button class="gv-modal__close" type="button" aria-label="Close window"><svg viewBox="0 0 24 24">…X…</svg></button>
    <div class="gv-modal__body">
      <!-- any content. The login demo composes primitives: -->
      <label class="gv-label" for="email">Email</label>
      <input class="gv-input" id="email" type="email" autocomplete="email" required />
      <button class="gv-btn primary" type="submit">Continue</button>
      <div class="gv-or"><span>Or</span></div>                <!-- labelled divider -->
      <button class="gv-btn white full">…G… Continue with Google</button>
    </div>
  </div>
</div>
```
- Width via `--gv-modal-w` (real default 650 / `.size-s` 500 compact-auth / `.size-l` 820).
  Scrim is `rgba(0,0,0,.75)` with **no card shadow**; the card top-aligns with a 50px gap
  (not vertically centred), caps at `85vh`, and scrolls its body — all matching the live Modal.
- ARIA goes on the **card**: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
  → the `__title` id. Esc + backdrop-click close are demoed in JS; **real focus-trap and
  focus-restore are the dev team’s job** — don’t over-engineer it into a mockup.
- The `.gv-or` rule/label/rule divider is a standalone primitive — reuse it anywhere you
  split two choices.

## Project card + rail — `.gv-rail` / `.gv-pcard` (`components/project-card/`)

The card is an `<article>`, NOT an `<a>` — the title link is stretched to make the whole
card clickable. **Never nest `<a>` in `<a>`** (it breaks the layout).

```html
<div class="gv-rail">
  <article class="gv-pcard">                          <!-- + .wide (16:9, 360px) | .square (1:1, 210px) -->
    <div class="gv-pcard__thumb"><img src="…" alt="…" /></div>
    <h3 class="gv-pcard__title"><a href="#">Project name</a></h3>   <!-- stretched link -->
    <span class="gv-pcard__meta time">⏱ noch 3 Wochen</span>        <!-- .time | .people | .done -->
    <a class="gv-pcard__cta" href="#">Umfrage ausfüllen</a>          <!-- sits above the stretched link -->
  </article>
</div>
```

**Boxed grid card** — the homepage "All projects" layout: bordered/elevated cards in a
`.gv-pgrid` (3-col, `.span-2`/`.span-3` to widen). `.gv-pcard.boxed` adds the box; thumb
runs flush to the edges; content lives in `.gv-pcard__body`; `__spacer` pushes the
`__foot` (bubbles + CTA) to the bottom so cards in a row stay equal height.

```html
<div class="gv-pgrid">
  <!-- full-width feature card: image left, copy right -->
  <article class="gv-pcard boxed horizontal span-3">
    <div class="gv-pcard__thumb"><img src="…" alt="…" /></div>
    <div class="gv-pcard__body">
      <h3 class="gv-pcard__title"><a href="#">Die große Meidling-Umfrage</a></h3>
      <p class="gv-pcard__desc">…</p>
      <div class="gv-pcard__progress">
        <span class="gv-pcard__meta time">⏱ Noch 4 Wochen</span>
        <div class="gv-progress" role="progressbar" aria-valuenow="35" aria-valuemin="0" aria-valuemax="100"><div class="gv-progress__fill" style="width:35%"></div></div>
      </div>
      <div class="gv-pcard__foot">
        <span class="gv-bubbles"><span class="av"></span><span class="av"></span><span class="count">248</span><span class="gv-bubbles__label">Teilnehmende</span></span>
        <a class="gv-btn primary-outlined" href="#">Umfrage ausfüllen</a>
      </div>
    </div>
  </article>
```

**Contribution count** (`.gv-poststat`) — the green-dot "X Beiträge / contributions"
status meta the live product shows on an open project card (dot `#04884C`,
secondary cool-grey text). Add `.closed` for the muted finished state. Source:
`getComputedStyle` on mitgestalten.wien.gv.at.

```html
<span class="gv-poststat"><b>122</b>&nbsp;contributions</span>
<span class="gv-poststat closed"><b>503</b>&nbsp;contributions</span>

  <!-- standard card; no-image → .gv-pcard__thumb.icon; finished → .gv-status-label.finished -->
  <article class="gv-pcard boxed">
    <div class="gv-pcard__thumb icon"><svg viewBox="0 0 24 24" fill="currentColor"><!--building--></svg></div>
    <div class="gv-pcard__body">
      <h3 class="gv-pcard__title"><a href="#">Alt-Ottakring wie neu!</a></h3>
      <p class="gv-pcard__desc">…</p>
      <div class="gv-pcard__spacer"></div>
      <div class="gv-pcard__foot">
        <span class="gv-status-label finished">Abgeschlossen</span>
        <a class="gv-btn primary-outlined" href="#">Bericht lesen</a>
      </div>
    </div>
  </article>

  <!-- folder card: count badge pinned over the thumb -->
  <article class="gv-pcard boxed">
    <div class="gv-pcard__thumb">
      <span class="gv-pcard__count"><svg viewBox="0 0 24 24" fill="currentColor"><!--folder--></svg> 3 Projekte</span>
    </div>
    <div class="gv-pcard__body">
      <h3 class="gv-pcard__title"><a href="#">Wiener Klimateam</a></h3> …
    </div>
  </article>
</div>
```

## Homepage widgets — `.gv-spotlight` / `.gv-ptoolbar` / `.gv-ctaband` (`pages/homepage/`)

The modern GoVocal landing-page anatomy (source-grounded on the live signed-in homepage).
Compose with the boxed grid card above. All themeable via `--gv-tenant-*`.

```html
<!-- Banner overlay CTA: pin one project onto the hero (child of .gv-hero) -->
<a class="gv-hero__cta" href="#"><svg><!--arrow--></svg> <span>Sagen Sie Ihre Meinung zum …!</span></a>

<!-- Spotlight: "currently working on" featured project (copy + media) -->
<section class="gv-spotlight">
  <div class="gv-spotlight__inner">
    <div>
      <p class="gv-spotlight__eyebrow">Aktuell in Bearbeitung</p>
      <h2 class="gv-spotlight__title">Gesunde Blindengasse</h2>
      <p class="gv-spotlight__lead">…</p>
      <div class="gv-spotlight__actions">
        <a class="gv-btn primary size-m" href="#">Umfrage ausfüllen</a>
        <span class="gv-bubbles"><span class="av"></span><span class="count">145</span><span class="gv-bubbles__label">Teilnehmende</span></span>
      </div>
    </div>
    <!-- real photo → <img>; no photo → neutral placeholder + optional themed chip -->
    <div class="gv-spotlight__media gv-spotlight__media--placeholder"><span class="gv-spotlight__chip">A GREENER<br>MAIN STREET</span></div>
  </div>
</section>

<!-- Projects toolbar: status tabs (left) + filter selectors (right) -->
<div class="gv-ptoolbar">
  <div class="gv-tabs" role="tablist">
    <button class="gv-tab" role="tab" aria-selected="true">Veröffentlicht <span class="ct">(12)</span></button>
    <button class="gv-tab" role="tab" aria-selected="false">Archiviert <span class="ct">(5)</span></button>
  </div>
  <div class="gv-filterbar">
    <span class="gv-filterbar__label">Filtern nach</span>
    <button class="gv-filter-btn">Thema <svg><!--chevron--></svg></button>
  </div>
</div>

<!-- Show more -->
<div class="gv-showmore"><button class="gv-btn primary-outlined size-m">Mehr anzeigen <svg><!--chevron--></svg></button></div>

<!-- Events widget (empty state) -->
<div class="gv-events__head"><h2 class="gv-title h2">Veranstaltungen</h2><a class="gv-btn text" href="#">Alle ansehen</a></div>
<div class="gv-events__empty"><svg><!--calendar--></svg><p class="gv-text bodyM">Derzeit sind keine … geplant.</p></div>

<!-- Proposals / generic CTA band -->
<section class="gv-ctaband">
  <div class="gv-ctaband__inner">
    <h2 class="gv-ctaband__title">Was ist Ihr Anliegen?</h2>
    <p class="gv-ctaband__lead">…</p>
    <a class="gv-btn primary size-m" href="#">Alle Vorschläge entdecken</a>
  </div>
</section>

<!-- Rich-text block -->
<div class="gv-prose"><p>…</p><p><em>…</em></p></div>

<!-- Image placeholders: photo stand-ins so a page stays pure assembly (no inline
     gradient/hex). Neutral mirrors the product's real image-less card; tinted set
     reads like uploaded photography (content, fixed). Caption sizes a title tile. -->
<div class="gv-pcard__thumb gv-pcard__thumb--placeholder"></div>           <!-- neutral (= #EDEFF0) -->
<div class="gv-pcard__thumb gv-pcard__thumb--clay"><span class="gv-thumb-cap gv-thumb-cap--lg">THE BIG<br>DOWNTOWN SURVEY</span></div>
<!-- tints: --forest --ocean --clay --sage --civic --coral --sand · caption sizes: (base 22) --lg 26 / --sm 20 / --xs 18 -->
<!-- folder emblem inside a thumb -->
<div class="gv-pcard__thumb gv-pcard__thumb--coral"><div class="gv-pcard__badge"><span><span class="pre">our</span><b class="accent">Westside</b><b>climate<br>team</b></span></div></div>
```
- The whole page assembled: `pages/homepage/`. Cards stretch to equal height; `__spacer`
  pushes `__foot` down. Progress fill + tab underline + count bubble all use `--gv-tenant-primary`.
- **Pure assembly:** the page authors zero colour/elevation/type — image stand-ins use the
  `gv-pcard__thumb--*` placeholder tints, `gv-thumb-cap` caption sizes, `gv-pcard__badge`
  emblem and `gv-spotlight__chip` (all canonical in `govocal-ui.css`), so it re-skins per theme.

## Hero / banner — `.gv-hero` (`components/hero/`)

```html
<section class="gv-hero" style="--gv-hero-image:url('photo.jpg')">  <!-- omit var for placeholder -->
  <div class="gv-hero__inner">
    <h1 class="gv-hero__title">Wien mitgestalten</h1>
    <p class="gv-hero__lead">Die Beteiligungsplattform der Stadt Wien</p>
    <div class="gv-avatars"><span class="av"></span>…<span class="count">15.4k</span></div>
    <button class="gv-btn white">Registrieren</button>
  </div>
</section>
```
- Overlay tints with `--gv-tenant-primary` (re-themes per city), keeping white text legible.

## Phase timeline — `.gv-phases` (`components/phase-timeline/`)

Project phase navigation: a connected row of **chevron/arrow “ribbon” segments**
(number inside, label below); only the **current** phase is green with a “• N”.
Nav = `[‹ Previous] [● Current] [› Next]`. Content panel leads with a big green
numbered circle. The stepper is `role="tablist"`, each phase a `role="tab"`.

```html
<section class="gv-phases">
  <div class="gv-phases__bar">
    <h2>Phases</h2>
    <div class="gv-phases__nav">
      <button class="gv-pnav" aria-label="Previous phase"><span data-gv-icon="chevron-left"></span></button>
      <button class="gv-pnav" aria-label="Go to current phase"><span class="gv-dotmark"></span></button>
      <button class="gv-pnav" aria-label="Next phase"><span data-gv-icon="chevron-right"></span></button>
    </div>
  </div>
  <div class="gv-stepper" role="tablist" aria-label="Project phases">
    <button class="gv-phase" role="tab" aria-label="Phase 1: …"><span class="gv-pstep">1</span><span class="gv-phase__label">The one problem…</span></button>
    <!-- … -->
    <button class="gv-phase current" role="tab" aria-selected="true"><span class="gv-pstep"><span class="gv-pstep__dot"></span>10</span><span class="gv-phase__label">Development plan is announced</span></button>
  </div>
  <div class="gv-phasepanel" role="tabpanel">
    <div class="gv-phasepanel__head">
      <span class="gv-phasepanel__num">10</span>
      <div>
        <h3 class="gv-phasepanel__name">Development plan is announced</h3>
        <p class="gv-phasepanel__date">October 6, 2025 12:00 AM – No end date</p>
      </div>
    </div>
    <!-- phase content here -->
  </div>
</section>
```
- Switching phases (click a tab / prev-next) is JS in the page; the component is the markup + `.gv-*` styling. Current = green (`--gv-green-500`); chevrons via `clip-path`.

## Survey fields — `govocal-survey.css` + `govocal-survey.js` (`components/survey-fields/`)

The input-form / survey question types, as ONE shared, themeable kit (its own
stylesheet + JS engine on top of the gv-* primitives — not folded into govocal-ui.css).
Demo: `components/survey-fields/`; the whole runner powers the **Input Form** page.

Copy `govocal-tokens.css`, `govocal-primitives.css`, `govocal-ui.css`,
`govocal-survey.css`, `govocal-survey.js` into the prototype, then:

```html
<link rel="stylesheet" href="govocal-survey.css" />
<script src="govocal-survey.js" defer></script>

<!-- A) one field widget anywhere (recall just a matrix, ranking, rating, …) -->
<div id="q"></div>
<script>
  document.getElementById('q').innerHTML = GVSurvey.field({
    type: 'matrix', label: 'Please rate the following aspects',
    scale: ['Strongly disagree','Disagree','Neutral','Agree','Strongly agree'],
    statements: ['The park should prioritize quiet natural areas.', 'I’d prefer a fenced playground.']
  });
</script>

<!-- B) a whole page-by-page survey (wizard + progress + gating) -->
<main class="sv-wrap"><div id="survey"></div></main>
<script>
  GVSurvey.mount(document.getElementById('survey'), { pages: [ /* …FORM… */ ] }, { title: 'Survey' });
</script>
```

Field `type` ∈ `text · multiline_text · number · select · multiselect · rating ·
ranking · linear_scale · sentiment · multiselect_image · matrix · map · file_upload ·
shapefile_upload`. `gate:true` marks the types that block Next until answered
(rating/scale/sentiment/matrix — the real runner's behaviour). Every colour/font is a
`--gv-*` token, so fields re-skin per city via `?theme=`.

## Cookie consent — `govocal-cookies.js` (resident-facing, required)

**Rule:** every resident / participant-facing prototype shows this first, in English
(Edit / Decline / Accept). Backend/admin screens skip it. Drop-in, self-contained,
themeable via `--gv-tenant-primary`.

```html
<body class="gv-root" data-gv-cookies-city="Vienna">
  …
  <script src="govocal-cookies.js" defer></script>   <!-- auto-shows on first load -->
</body>
```

- Title is `Your cookie settings — <City>` (from `data-gv-cookies-city`; omit for no city).
- `data-gv-cookies="always"` shows it on every load (handy for review); `"off"` disables;
  `?cookies=reset` re-triggers a stored choice.
- **Edit** expands Essential (locked on) / Analytics / Marketing preferences + save.
- Choice persists in `localStorage`; fires a `gv-cookie-consent` event with the result.
- Manual control: `window.GVCookies.show()` / `.reset()` / `.choice()`.

---

## City theming (`govocal-themes.js`)

The product themes **primary, secondary, text colours + a custom font** per tenant
(`getTheme()` → `tenantPrimary/Secondary/Text` + `customFontName`). Build with
`var(--gv-tenant-*)` and `var(--gv-font-family)` and a prototype re-skins for free.

Templates ship as **real city tenants** (researched from each one's official brand):

| `?theme=` | City | Primary | Font (real → free stand-in) |
|---|---|---|---|
| `0` | GoVocal (default) | `#0E7C86` + `#E2603A` | Public Sans |
| `1` | Københavns Kommune | `#000C2E` (KBH Blå) | KBH → Archivo |
| `2` | Stadt Wien | `#FF5A64` (softened Wien-Rot) | WienerMelange → Libre Franklin |
| `3` | Engaged California | `#1C2745` + `#E79450` | Noto Sans |

- On-screen picker (bottom-right swatches) switches live and updates the URL.
- Opt out of the picker with `<body data-gv-theme-picker="off">`.
- Add a city: append `{id, name, primary, secondary, text, logo, font}` to `GV_THEMES`.

**City logos:** a theme's `logo` (inline `<svg>` or `<img>`) renders into any
`[data-gv-logo]` element, swapping live with the theme; a placeholder (city mark +
name) is generated until a real logo is set. **Fonts:** `font` sets the stack — the
real tenant font name first (used where licensed), then a free stand-in; proprietary
fonts (WienerMelange, KBH) fall back to Public Sans exactly as the live sites do.

```html
<a class="brand" data-gv-logo aria-label="City home"></a>   <!-- fills with the active city's logo -->
```

**Contrast caveat (faithful-but-flagged):** real brand colours are kept even when
they miss WCAG AA. Stadt Wien's in-product `#FF5A64` (a softened Wien-Rot) is only
~4:1 white-on-primary and the audit flags it — kept faithful. The GoVocal default is
an AA-safe **deep teal `#0E7C86`** (4.95:1) + warm coral `#E2603A` accent, chosen over
the literal product pink (`#E10069`/`#ef0071`, which barely cleared AA). On the real
platform a light primary would take dark button text.
