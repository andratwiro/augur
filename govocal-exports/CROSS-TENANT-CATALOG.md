# Cross-Tenant Front-Office Pattern Catalog — 6 GoVocal platforms

> **Internal / NEVER ships.** Lives outside `prototypes/`. Synthesis of 271 raw finds
> (162 flagged novel) from 5 discovery rounds across **6 real GoVocal front offices**.
> GoVocal is ONE product; every city re-themes it (palette, font, logo, photos, copy,
> language). So this catalog separates **STRUCTURE (system → primitive/token candidates)**
> from **SKIN (theme → `--gv-tenant-*` / `--gv-font-family`)**. All values are read from
> `styles.json` digests, never approximated off a PNG.

## Tenants surveyed

| # | Tenant | URL | Locale | Primary | Font | Notes |
|---|---|---|---|---|---|---|
| 1 | **Vienna** (Wien mitgestalten) | mitgestalten.wien.gv.at | de-DE | `#FF5A64` | WienerMelange | single-locale; photo hero |
| 2 | **Copenhagen** (København taler) | kobenhavntaler.kk.dk | da-DK | `#000C2E` navy | KBH-Regular / Public Sans | CB homepage; illustration hero |
| 3 | **St Louis** | stlouis.govocal.com | en | `#033D8B` deep blue | Public Sans | CB homepage; carousels; real folders |
| 4 | **Falkirk** (Participate+) | participateplus.falkirk.gov.uk | en-GB | `#198754` green | Public Sans | Weglot switcher; spotlight carousel |
| 5 | **Luxembourg** (Zesumme Vereinfachen) | zesumme-vereinfachen.lu | fr-FR | `#1B5E7D` teal | Public Sans | abstract-shape hero; tinted nav; 2-logo footer |
| 6 | **Linz** (Partizipation) | partizipation.linz.at | de-AT | `#604596` purple | LentiaNova | CB homepage; footer logo; '// ' headings |

**The big structural insight (all 6):** modern GoVocal homepages are **NOT** a fixed widget
stack — they are **Content-Builder-composed pages** (`#e2e-content-builder-frame`) assembling
generic layout cells (`e2e-single-column` / `e2e-two-column` / `e2e-three-column` /
`e2e-text-box` / `e2e-image` / `e2e-white-space`) interleaved with first-class platform
**widgets** (banner, spotlight, published-projects-and-folders, events, cta-banner). The frame
+ layout cells + widget set are **system**; the specific arrangement and prose are **tenant**.
Our library models only a fixed-module `pages/homepage` and the BO editor — there is **no FO
rendered Content-Builder layer**. This is the #1 gap.

---

## A. COMMON SYSTEM PATTERNS (3+ tenants → primitive/token candidates)

These are the GoVocal product spine — the same `e2e-*` / `data-testid` framework hooks across
tenants, only the skin changes. The more tenants share it, the more "system" it is.

### A1. Signed-out homepage hero / full-width banner — `component` — ALL 6 tenants ★★★
- **Hooks (identical across tenants):** `[data-testid=full-width-banner-layout]`,
  `[data-cy=e2e-homepage-banner]`, `.e2e-signed-out-header`, `.e2e-signed-out-header-title`,
  `.e2e-signed-out-header-subtitle`, `.e2e-signed-out-header-cta-button`,
  `.e2e-full-width-layout-header-image-overlay`.
- **System geometry (product defaults):** outer banner **1440×450** desktop / 350 mobile,
  fallback bg **`#EDEFF0`** (the app-canvas grey, shows while image loads = `--gv-bo-canvas`
  reused on FO), full-bleed background layer (image OR solid/shape) + a dark image-overlay,
  content column padded **50px 30px**, white **H1 30px/700**, white **subtitle 18px/400/lh23.4**,
  an avatar-count cluster, a single CTA.
- **CTA is the net-new `.Button.primary-inverse`** (see A2).
- **TWO structural sub-variants (resolve as variant classes, not forks):**
  - **Photo + dark-overlay, LEFT text column** — Wien (340px left column), St Louis (city
    skyline), Falkirk (skyline), Linz (bg image). Closest to our `.gv-hero`.
  - **Illustration/shape on tint, CENTERED text** — Copenhagen (pink tint + squiggle SVG),
    Luxembourg (abstract teal/orange CSS wedges, NO photo). Avatars ABOVE the CTA.
- **vs library:** `.gv-hero` is photo-led + tinted-overlay + left text; it lacks the
  primary-inverse CTA, the numeric overflow avatar bubble, the centered/shape variant, and the
  `#EDEFF0` fallback layer. **Build a `.gv-hero.signed-out` (+ `.centered` / `.shape-bg`)
  variant.**
- **Skin:** image/illustration, overlay tint, copy, font, CTA fill. **System:** the whole
  450px banner skeleton + count cluster + inverse CTA.

### A2. `button-primary-inverse` — `primitive` — Wien, St Louis, Linz (≥3, framework class) ★★★
- Class signature `.button.Button.primary-inverse`. **White fill `rgb(255,255,255)`, text
  `rgba(0,0,0,.87)`, border 1px solid transparent, radius 3px, padding 13px 22px** (the larger
  hero-CTA size vs base `9px 18px`), label span 16px/500.
- The inverse of `.gv-btn.primary` — a solid WHITE button for on-dark/photo banners. Distinct
  from `.gv-btn.on-color` (translucent) and `.primary-outlined` (transparent + border).
- **System, no tenant hex** (literally white + near-black). **Promote to a
  `.gv-btn.primary-inverse` variant in `govocal-primitives.css`, paired with the hero.**

### A3. Header / global nav chrome — `component` — ALL 6 tenants ★★★ (most systemic surface)
- **Hooks:** `#e2e-navbar`, `header.sc-kplVBS`, `nav[aria-label=Primary/Primäre]`,
  `.e2e-projects-dropdown-link`, `.e2e-navbar-login-menu-item`, overflow "More/Mehr ···".
- **System geometry:** fixed **78px** white bar, **box-shadow** `rgba(0,0,0,.1) 0 2px 4px -1px`,
  z-index **1004**, logo flush-left, primary nav (max-width ~940px, margin-left 35px), search
  icon + auth CTA flush-right. **Active item = 6px top accent bar + tinted cell + weight 500
  (not bold).** Overflow "More" appears only when items don't fit. Mobile = hamburger drawer.
- **Confirmed shadow-alpha variance:** `.1` (CPH/St Louis/Falkirk/Lux) — record as a token
  tolerance on `--gv-shadow-header`, NOT a per-tenant fork. (Earlier Wien note had a heavier
  value — reconcile to `.1`.)
- **Variants to fold in (already covered or minor):**
  - **Brand-tinted nav labels** (Luxembourg): all nav labels in tenant-primary `#1B5E7D`
    16px/500 instead of dark `rgba(0,0,0,.87)`. → a configurable `.gv-nav.tinted` mode.
  - **Dual signed-out auth CTAs** (Luxembourg): filled "Se connecter" **+** inverse
    "S'inscrire" + lang switch. Our signed-out header models only ONE CTA → support two.
  - **Language switcher in signed-OUT header** (Luxembourg `FR`): `.gv-lang` exists but only
    placed signed-in; allow it signed-out too.
  - **No overflow when items fit** (Falkirk 6 items, Lux 4 items): expected behaviour.
- **Skin:** logo, label colour, item set, font, CTA fill, locale. **System:** everything else.

### A4. Footer chrome — `component` — ALL 6 tenants ★★★
- **Hooks:** `#hook-footer`, `footer.sc-iJRxjq`, `.gv-footer__links`, cookie-settings `<button>`,
  go·vocal attribution.
- **System:** transparent footer, **legal-links secondary-nav row** (Terms · Privacy · Cookie ·
  [Accessibility] · [Site Map]), **"Cookie settings" is always a `<button>"** (re-opens consent),
  "Powered by go·vocal" (often "formerly CitizenLab"). 14px/400, `#596B7A` links.
- **Variants to fold in:**
  - **Footer logo band** (Linz `#hook-footer-logo` + Luxembourg 2-logo band): an OPTIONAL upper
    `.gv-footer__logos` strip (white, padding 50px 20px 20px, ~190px) above the legal row,
    holding tenant/government logos. Our `.gv-footer` omits this → **add an optional logo band.**
  - **Extended legal list** (Falkirk/St Louis add Accessibility statement + Site Map) — just a
    longer link list, no structural change.
  - **Suppressed attribution** (Luxembourg shows no go·vocal mark) — make attribution optional.
- **Skin:** link set, logos, locale. **System:** the row skeleton + cookie button + attribution.

### A5. Cookie-consent modal — `component` — Wien, Falkirk (+ EU-wide product hook) ★★
- **Hooks:** `data-testid=consent-manager`, `#e2e-modal-container`, `role=dialog`,
  `.e2e-accept-cookies-btn`, `.e2e-manage-preferences-btn`.
- **System:** reuses the `.gv-modal` shell — scrim `rgba(0,0,0,.75)`, white card **650px / radius
  3px**, leading product cookie icon, title + body + policy link, **three-action footer**:
  Manage (ghost `.button.text`) · Reject · Accept (tenant-filled primary). Global-chrome blocker.
- **vs library:** we ship `govocal-cookies.js` for prototypes but have **no reusable `.gv-*`
  cookie-consent CONTENT variant** (icon + 3-button layout). → Build as a `.gv-modal` content
  variant, not a new shell.
- **Skin:** accept-button fill, icon tint, copy. **System:** 650px card + 3-action layout.

### A6. Spotlight ("currently working on") widget — `component` — Copenhagen, Luxembourg, Linz (+Raleigh/wietsedemo base) ★★★ — **already in library**
- **Hook:** `.e2e-spotlight-widget`. Copy column (H1 **30px/700** + lead 16px/400 max-width
  400px + avatar bubbles + count + primary CTA, often rendered as styled `<a>`) beside a 376px
  media tile (photo or flat tinted illustration placeholder). Matches `.gv-spotlight` exactly.
- **Variant notes:** title is H1 30px/700 (vs our smaller eyebrow+title); CTA-as-anchor;
  Luxembourg tints the title brand-blue. All within existing variant range. **No new primitive.**

### A7. Featured / published-projects-and-folders project rows — `component` — ALL CB tenants ★★★ — **already in library**
- **Hook:** `e2e-published-projects-and-folders`, `e2e-light-project-card`, `e2e-project-card`.
- **System:** section **h2 25px/700**, cards with **376×282 (4:3)** thumb radius 3px, **18px/700**
  title (or 16/700 compact), participant/folder counts, avatar bubbles. Completed-status line
  uses **green `#04884C`/`#358545` success**. Maps to `.gv-pcard.light` / `.featured` / `.boxed`.
- **Skin:** photos, copy, counts. **System:** card skeleton + 376px thumb + green-success status.

### A8. Embedded community-monitor survey band — `component` — Linz (+ wietsedemo base) ★★ — **already in library**
- **System:** `.gv-monitorband` — tint = **tenant-primary @ 10%** (`--gv-tenant-primary-lighten90`),
  **padding 32px, radius 16px, gap 16px**, h2 25/700, sentiment-preview tile + CTA. Identical tint
  formula cross-tenant. **Variant to fold in:** Linz adds a tenant-primary "Dauer N Minuten"
  duration meta line. **No new primitive** — just add the optional duration line.

### A9. Avatar overflow-count bubble — `primitive` — Falkirk, Linz, St Louis, Copenhagen ★★★
- **System:** the `+N` overflow rendered AS a solid circle capping the overlap stack: bg cool-grey
  **`#596B7A`**, **36–38px**, **2px solid #fff** border, radius 50%, holding white **11px/400** text
  ("19.8k", "7443", "22.7k"). Real avatars = same-size, 2px white border, absolute overlap.
- **vs library:** `.gv-bubbles/.count` renders the count as ADJACENT TEXT, not a same-size circle
  in the stack. → **Add the overflow-circle to `.gv-bubbles`** (`.gv-bubbles .count.bubble`).
- **System** (cool-grey + abbreviated count). Skin = none.

### A10. Custom info / navbar page (CB rich-text page) — `page` — St Louis, Falkirk (+ all `/pages/*`) ★★★
- **System:** every tenant routes `/pages/<slug>` (Terms, Privacy, Cookie, Accessibility, Site
  Map, About, FAQ) through one layout: global chrome + a **left-aligned page title** (34px;
  weight **500 on projects-list vs 600 on Falkirk FAQ — reconcile which is canonical**) +
  constrained-column **Quill rich-text body** (`.gv-prose`, `ql-align-*`, strong runs as
  sub-headings). **No hero.** St Louis adds a **file-attachment download list** (PDF `<a>` rows
  with KB sizes) and an inline CTA. → **Build a reference info-page + a `.gv-attachment`
  download-row component.**
- **Skin:** copy, attachments. **System:** the page-title + prose layout + attachment block.

### A11. Centered rich-text / white-space homepage text-box — `component` — Wien, Luxembourg, Linz, Copenhagen ★★
- **Hook:** `.e2e-text-box`, `.ql-align-center`, `.e2e-white-space`. A Content-Builder text-box
  widget (max-width 1200, padding 24px 0) wrapping **centered** Quill prose; spacers
  (`e2e-white-space`) set vertical rhythm between homepage modules.
- **vs library:** `.gv-prose` is left-aligned project body copy; this is the **centered,
  CB-wrapped** homepage marketing variant. → Part of the FO Content-Builder render layer (B-tier).

---

## B. HIGH-VALUE SYSTEM GAPS (recur, NOT yet in library)

### B1. FO Content-Builder render layer — `page`/`primitive` — Copenhagen, St Louis, Luxembourg, Linz ★★★ (THE core gap)
- **Hooks:** `#e2e-content-builder-frame`, `e2e-single-column`, `e2e-two-column`,
  `e2e-three-column`, `e2e-two-row-layout-container`, `e2e-text-box`, `e2e-image`,
  `e2e-white-space`.
- **System:** a generic responsive **1/2/3-column grid + spacer** system (e.g. three-column =
  `display:flex; gap:24px; max-width:1200px`) that hosts both prose/image/spacer primitives AND
  widget slots. This is how every modern tenant assembles its homepage and custom pages.
- **vs library:** we have the **BO editor shell** (`.gv-bo-cb-*`) but **NO FO rendered output
  classes**. → **Build `.gv-cb-frame` + `.gv-cb-row` (single/two/three-column) + `.gv-cb-textbox`
  + `.gv-cb-image` + `.gv-cb-whitespace`** so prototypes can assemble CB-style homepages/pages.

### B2. Project carousel (paged scroll rail) — `component` — St Louis, Falkirk ★★★
- **Hooks:** `e2e-project-cards-show-more-button`, `e2e-event-previews-scroll-left/-right`
  (`.disabled` at start), "Press escape to skip carousel" (sr-only), `role=region`, a visible
  Scroll-right chevron button overlaid at the rail edge.
- **System:** the product's default homepage project-row presentation — a **paged** horizontal
  carousel with prev/next buttons + skip-carousel a11y + region semantics. Cards inside reuse
  `.gv-pcard.light` (some with title-over-image).
- **vs library:** `.gv-rail` is a free-scroll rail WITHOUT paged buttons or the a11y wrapper.
  → **Build a `.gv-carousel` variant of `.gv-rail`** (scroll-button + escape-to-skip + region).

### B3. CTA-banner block (full-width CB strip) — `component` — St Louis, Linz, Copenhagen ★★
- **Hook:** `[data-cy=e2e-cta-banner-button]` (generic CB block id).
- **System:** a thin full-bleed coloured strip (tenant-primary fill, e.g. St Louis `#033D8B`
  1440px) whose only content is a single centered CTA button. Linz/Copenhagen build the same from
  generic text-box + button widgets.
- **vs library:** distinct from `.gv-ctaband` (centered single-column proposals band with
  title+lead+CTA) and `.gv-monitorband`. → **Build a `.gv-cta-banner` full-width strip variant.**

### B4. Event card — STACKED date-chip variant — `component` — Copenhagen, Linz, Falkirk ★★★
- **Hooks:** `e2e-event-card`, `e2e-events`, `[data-testid=EventInformation]`,
  `e2e-event-attendance-button` (+ `.disabled` full state).
- **System variance to resolve:** our `.gv-event-card` = borderless grid card with an overlaid
  two-tone (m/d/y) chip. These three tenants render a **DIFFERENT** card:
  - **Bordered `<li>`, 6px radius, 1px `#CCC` border** (vs our 3px/#E0E0E0).
  - **3-TIER STACKED date chip** (75px): grey `#F5F6F7` top (day 14px + month 14px/500 uppercase)
    → **tenant-primary/navy bottom band** with white **year** (radius 0 0 3px 3px). Linz year band
    `#604596`, Copenhagen `#000C2E`, Falkirk `#198754`.
  - **`#F4F6F8` "Date & time" a11y info panel** inside the body (padding 12px 16px 4px).
  - **Image-LESS degrade** (Falkirk): no media → title-top + chip-top-right + info-panel +
    full-width Register footer. Real **disabled (full) Register** state.
- **vs library:** → **Build `.gv-event-card.bordered` + `.gv-event-datechip--stacked` +
  `.gv-event-info-panel` + the imageless + disabled states.** Don't mutate the base chip.
- This is shared GoVocal **EventsWidget** code (same chunk hash family) → high system-ness.

### B5. Folder card (project-count badge) — `component` — St Louis, Copenhagen ★★
- **Hooks:** `e2e-folder-card`, `e2e-folder-card-numberofprojects`,
  `e2e-folder-card-folder-description-preview`.
- **System:** white card, 3px radius, soft shadow `rgba(0,0,0,.06) 0 2px 4px -1px` (= `--gv-shadow`),
  **TALLER than a project card** (~583px — stacks child-project previews), padding 18px 0 25px,
  a **count badge** (number 14px/700 GREEN `#358545`/secondary + "N projects") + a
  **16px/300 light-weight description preview** + dark image overlay (threecolumns variant).
- **vs library:** our folder card is **reconstructed** (Westmere had no real folders). →
  **Re-ground `.gv-pcard.boxed` folder variant on St Louis real values** (count colour = secondary,
  description weight 300, taller card with child preview).

### B6. Two-column image+text+accordion CB section — `component` — St Louis (+ generic CB) ★★
- **System:** a CB two-column cell: image left + (h2 25/700 + intro `<p>` + **accordion** rows
  with **21px/700** headers) right — an "about + FAQ" homepage section. Both `.gv-prose` and
  `.gv-accordion` exist; the **composed section** does not. → Reference assembly, low new-CSS.

---

## C. TENANT-SPECIFIC / SKIN (theme only — do NOT promote)

- **Weglot language switcher** (Falkirk only) — a THIRD-PARTY paid add-on: fixed bottom-right
  floating pill (`aside.weglot_switcher`, 13px, flag + label + chevron, EN/PL/中文/Urdu-RTL),
  overlaying GoVocal's native multiloc. **Tenant integration skin**, but the **floating-pill
  PATTERN** is reusable if it recurs (it doesn't, in this set). a11y note: unstyled `2px groove
  blue` wrapper.
- **Centered closing logo band** (Falkirk only) — oversized `PARTICIPATE+` wordmark centered above
  the footer. Could be a configurable homepage logo widget or Falkirk-specific. Treat as skin
  until a 2nd tenant shows it; the "centered logo closer" pattern is reusable.
- **Brand-tinted nav labels** (Luxembourg) — a colour treatment, not structure (see A3).
- **'// ' section-heading prefix** (Linz) — tenant copy, not structure.
- **Trending-proposals plain-link list** (Copenhagen) — likely an author-built CB text-box with
  internal `<a>` links (default blue, no cards), not a dedicated widget. Reinforces B1, not a
  standalone component.
- **Suppressed go·vocal attribution** (Luxembourg) — footer config, see A4.

---

## D. LIBRARY GAPS — consolidated build backlog

| Gap | Layer | Tenants | Action |
|---|---|---|---|
| FO Content-Builder render layer (`.gv-cb-*`) | primitive/page | CPH, StL, Lux, Linz | **build B1** |
| Signed-out hero (+inverse CTA, count, centered/shape) | component | all 6 | **build A1** |
| `.gv-btn.primary-inverse` | primitive | Wien, StL, Linz | **build A2** |
| Project carousel (paged + a11y skip) | component | StL, Falkirk | **build B2** |
| Stacked-chip / bordered / imageless event card | component | CPH, Linz, Falkirk | **build B4** |
| CTA-banner full-width strip (`.gv-cta-banner`) | component | StL, Linz, CPH | **build B3** |
| Avatar overflow-count circle in `.gv-bubbles` | primitive | 4 tenants | **add A9** |
| Cookie-consent modal content variant | component | Wien, Falkirk | **add A5** |
| Folder card re-grounded on real values | component | StL, CPH | **reground B5** |
| Info/custom page + `.gv-attachment` download row | page/component | StL, Falkirk | **build A10** |
| Footer optional logo band + optional attribution | component | Linz, Lux | **add A4** |
| Centered CB text-box (`ql-align-center`) | component | Wien, Lux, Linz, CPH | **add A11/B1** |
| Header: tinted nav + dual auth CTA + signed-out lang | component | Lux | **add A3** |
| Monitor band: duration meta line | component | Linz | **add A8** |

---

## E. Method-body / detail-page gaps observed in capture folders (not in raw finds, flagged for future rounds)

The `govocal-exports/` tree shows captured-but-uncatalogued depth worth future synthesis:
idea-detail pages (`fo-cph-idea-detail`, `fo-linz-idea-detail`, `fo-lux-idea-detail`,
`fo-stlouis-r4-idea-detail`), proposal-detail (`fo-cph-proposal-detail`), proposals feeds &
states, sign-in/sign-up (`fo-*-signin/signup`), user profiles (`fo-lux-user-profile`,
`fo-cph-profile-edit`), survey-results (`fo-lux-survey-results`, `fo-stlouis-survey-results`),
and St Louis **policy/board-bill** flows. These are richer method/detail gaps (idea-detail,
proposal-detail, profile, results) to prioritise in the next campaign — they are higher-value
than re-confirming chrome.
