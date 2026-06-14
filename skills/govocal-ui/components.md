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

The product themes three colours per tenant: **primary, secondary, text**
(`getTheme()` → `tenantPrimary/Secondary/Text`). Build with those variables and a
prototype re-skins for free:

- `?theme=0` GoVocal (default) · `1` Ocean · `2` Forest · `3` Royal · `4` Sunset
- On-screen picker (bottom-right swatches) switches live and updates the URL.
- Opt out of the picker with `<body data-gv-theme-picker="off">`.
- Add a city: append `{id, name, primary, secondary, text}` to `GV_THEMES`.

**Contrast caveat:** the genuine brand pink `#ef0071` gives only ~4.3:1 for white
text on a `primary` button (just under WCAG AA). The default `--gv-tenant-primary`
is therefore an AA-safe pink (`#E10069`, 4.77:1) — visually identical, passes the
audit. Swap in `#ef0071` if exact brand match outweighs the 0.23 contrast gap.
Templates 1–4 also clear 4.5:1. A real city with a light primary would need dark
button text on the platform.
