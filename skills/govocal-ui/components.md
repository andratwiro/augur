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

Copy the three asset files into the prototype folder (prototypes must be
self-contained), then:

```html
<link rel="stylesheet" href="govocal-tokens.css" />
<link rel="stylesheet" href="govocal-ui.css" />
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

---

# Composed components (Components tab)

Section-level blocks assembled from the primitives above. Full, copy-ready demos live
in `components/<name>/index.html` (and ship to `/components/`); the recall index is
`components/manifest.md`. Skeletons below — open the demo for the complete markup.

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
- Active link → red top indicator via `aria-current="page"`. Add `sticky` to pin.
- Logo: `data-gv-logo` (themes per city) or drop a literal `<svg>`/`<img>` in `.gv-brand`.
- Primary nav is a `<nav aria-label="Primäre">` landmark; the `<ul>` carries `.gv-nav__list`.
- Hamburger uses the real GoVocal filled three-bar icon (`M3,6H21V8H3V6…`), not a generic stroked one.

## Footer — `.gv-footer` (`components/footer/`)

```html
<footer class="gv-footer">
  <div class="gv-footer__inner">
    <div class="gv-footer__logo"><a href="#" data-gv-logo></a></div>
    <nav class="gv-footer__links"><a href="#">Nutzungsbedingungen</a><a href="#">Impressum</a>…</nav>
    <div class="gv-footer__powered"><span>Ermöglicht durch</span>
      <a href="https://govocal.com/" target="_blank" rel="noopener" aria-label="Go Vocal">
        <img class="gv-powered-logo" src="govocal-logo.svg" alt="Go Vocal" /></a>
    </div>
  </div>
</footer>
```
- Legal links get middot separators automatically. Copy `govocal-logo.svg` into the
  prototype folder. The go·vocal mark is GoVocal’s brand (muted grey) — it doesn’t theme.

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
| `0` | GoVocal (default) | `#E10069` | Public Sans |
| `1` | Københavns Kommune | `#000C2E` (KBH Blå) | KBH → Archivo |
| `2` | Stadt Wien | `#FF0000` (Wien Rot) | WienerMelange → Libre Franklin |
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
they miss WCAG AA. `Wien Rot #FF0000` is only ~4:1 white-on-primary and the audit
flags it — that's the official colour, kept faithful. The GoVocal default uses an
AA-safe pink (`#E10069`, 4.77:1; exact brand `#ef0071` ≈ 4.3:1). On the real
platform a light primary would take dark button text.
