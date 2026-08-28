# Mobile bottom tab bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile (≤860px) off-canvas drawer with a persistent floating bottom tab bar and a per-space-branded header, per `docs/superpowers/specs/2026-08-17-mobile-tabbar-design.md`.

**Architecture:** All changes live in `augur/build.js`. New CSS (`TABBAR_CSS`) and a new `tabBar(active)` function sit beside the existing `sideRail()`/`NAV_CSS`, gated inside the existing `@media (max-width: 860px)` query. `appChrome()` gains the bottom bar and a restructured `.gvtop`. Desktop's `sideRail()`/`libraryRail()`/`adminRail()` and their CSS are untouched — mobile hides `.gvside`/`.gvscrim` via CSS rather than deleting them, so no branch logic needs to know which mode is active. The Pinned and Profile sheets reuse existing markup/JS (`data-pinned-list`, `profileChip()`), which requires four small existing scripts (`PINS_JS`, `PROFILE_JS`, `SETTINGS_JS`, `SPACE_JS`) to go from "exactly one instance on the page" to "however many instances are on the page" — each already has the pattern proven in the codebase (`PROFILE_JS`'s `paint()` already does this for avatar/name/email).

**Tech Stack:** Vanilla JS/CSS emitted from template literals in `build.js` (no framework, no build step for the shell). Verification via `npm run offline` (real worker, live reload) + Playwright (existing devDependency) for mobile-viewport screenshots — there is no DOM test suite in this repo (`npm test` is worker/node-only).

## Global Constraints

- Every change stays inside `augur/build.js` (spec's "Touches"). No `src/_worker.js` changes.
- Nothing above the existing `@media (max-width: 860px)` breakpoint (`build.js:2303`) changes — desktop must render byte-identical before/after for `sideRail()`, `libraryRail()`, `adminRail()`, and their CSS.
- `UI_VERSION` (`build.js:388`, currently `"1.12"`) bumps to `"1.13"` as part of this change (shell-chrome convention, per the account-settings-modal precedent).
- No new dependencies. Reuse existing icon constants, `SEARCH_ICON`, `IC_*`, and existing sheet/drawer CSS conventions (`.gvhelp`'s scrim/panel pattern) rather than inventing new ones.
- Copy/labels exactly as the spec: "Projects" (or `PROJECTS_LABEL` override), "Playground", "Design system", "Pinned", "Profile"; DS sub-bar: "Tokens", "Base", "Components", "Patterns", "Pages"; Admin sub-bar: "People", "Content", "Settings".

---

## File Structure

Single file, `augur/build.js`. New units added (no new files, matching the account-settings-modal precedent of growing this file with clearly-bounded named blocks rather than splitting):

- `TABBAR_CSS` (new `const`, placed directly after `NAV_CSS`'s closing backtick, ~`build.js:2489` before `GV_MARK`) — all new mobile styles: header 3-slot layout, floating pill bar, sheets, safe-area.
- `tabBar(active)` (new `function`, placed directly after `sideRail()`'s closing brace, ~`build.js:2833`) — returns the bottom bar markup for a given `active` key.
- `mobilePinnedSheet()` (new `function`, beside `tabBar`) — the Pinned sheet's markup, a second copy of the pinned list/empty-state block.
- `mobileProfileSheet()` (new `function`, beside `tabBar`) — the Profile sheet's markup, wraps a second `profileChip()` call plus the Admin/Changelog items.
- `appChrome()` (`build.js:3031-3044`, modified) — new `.gvtop` markup, appends `tabBar(active)`, `mobilePinnedSheet()`, `mobileProfileSheet()`.
- `PINS_JS` (`build.js:3956`, modified) — `listEl`/`emptyEl` → arrays.
- `PROFILE_JS` (`build.js:4171`, modified) — `box` → array.
- `SETTINGS_JS` (`build.js:4268`, modified) — scope `pm`/`pt` lookup and focus-return to the clicked box.
- `SPACE_JS` (`build.js:4677`, modified) — `data-space-admin` lookup → loop.
- `chromeScript()` (`build.js:3093`, modified) — the search-filter block becomes a per-input loop instead of a single-instance block; the hamburger/drawer-toggle block is deleted outright.
- `TABBAR_JS()` (new `function`, beside `chromeScript()`) — sheet open/close, Pinned-empty dimming, header search toggle.
- `ADMIN_SECTIONS_JS` (`build.js:5148`, modified) — tab query widened from nav-scoped to document-wide.
- Two `<meta name="viewport">` tags (`build.js:5085`, `build.js:5594`, modified) — add `viewport-fit=cover`, required for `env(safe-area-inset-bottom)` to return a non-zero value on iOS.
- Two page-shell injection sites (`build.js:3349` in `injectNav()`, `build.js:5602`/`5632` in `shell()`, modified) — both gain `${TABBAR_CSS}` in their `<style>` and `${TABBAR_JS()}` as a new `<script>`.

---

### Task 1: `viewport-fit=cover` + `TABBAR_CSS` foundation (header + pill shell, no content yet)

**Files:**
- Modify: `build.js:5085`, `build.js:5594` (viewport meta tags)
- Modify: `build.js:2489` region (insert `TABBAR_CSS` before `GV_MARK`)

**Interfaces:**
- Produces: `TABBAR_CSS` (string constant) — consumed by Task 6 (injection into both page-shell `<style>` blocks).

- [ ] **Step 1: Add `viewport-fit=cover` to both viewport meta tags**

At `build.js:5085` and `build.js:5594`, change:
```html
<meta name="viewport" content="width=device-width, initial-scale=1" />
```
to:
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

- [ ] **Step 2: Add `TABBAR_CSS`**

Insert directly before the `GV_MARK` constant (`build.js:2489`):

```js
// Mobile (≤860px) bottom tab bar + restructured header. Replaces the off-canvas
// drawer (.gvside/.gvscrim, hidden below via NAV_CSS's 860px query) with a floating
// glass pill bar, mirroring Framework7's current iOS toolbar (.ios-glass(): backdrop-
// filter saturate(180%) blur(16px)) — the same translucency idiom .gvtop already uses.
// Scoped entirely inside the existing 860px query; nothing here reaches desktop.
const TABBAR_CSS = `
    @media (max-width: 860px) {
      /* ── Header: 3-slot row (back/spacer · brand or title · search) ─────────── */
      .gvtop { justify-content: space-between; }
      .gvtop__side {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 34px; flex: none;
      }
      .gvtop__back {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 34px; padding: 0; cursor: pointer;
        border-radius: 9px; border: 1px solid rgba(16,17,26,0.12); background: rgba(16,17,26,0.03); color: #16171a;
      }
      .gvtop__back:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
      .gvtop__back:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
      .gvtop__back svg { width: 16px; height: 16px; }
      .gvtop__center {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
        min-width: 0; overflow: hidden;
      }
      .gvtop__center-brand { display: inline-flex; align-items: center; gap: 8px; color: #16171a; text-decoration: none; }
      .gvtop__center-brand img { width: 22px; height: 22px; border-radius: 5px; flex: none; }
      .gvtop__center-brand span { font-family: var(--font-display); font-weight: 800; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gvtop__title { font-weight: 700; font-size: 15px; color: #16171a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gvtop__search-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 34px; padding: 0; cursor: pointer; flex: none;
        border-radius: 9px; border: 1px solid rgba(16,17,26,0.12); background: rgba(16,17,26,0.03); color: #16171a;
      }
      .gvtop__search-btn:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
      .gvtop__search-btn svg { width: 16px; height: 16px; }
      .gvtop__search-btn .gvic { width: 16px; height: 16px; }
      .gvtop__searchwrap { flex: 1; min-width: 0; }
      .gvtop__searchwrap .gvsearch { width: 100%; }
      body:not(.gv-mobile-searching) .gvtop__searchwrap { display: none; }
      .gv-mobile-searching .gvtop__center { display: none; }

      /* ── Floating pill tab bar ────────────────────────────────────────────── */
      .gvtabbar {
        position: fixed; left: 12px; right: 12px;
        bottom: calc(10px + env(safe-area-inset-bottom));
        z-index: 2147483100;
        height: 64px; border-radius: 32px;
        display: flex; align-items: stretch; padding: 4px;
        background: rgba(255,255,255,0.82);
        -webkit-backdrop-filter: blur(16px) saturate(180%); backdrop-filter: blur(16px) saturate(180%);
        box-shadow: 0 12px 32px -12px rgba(16,24,40,0.35), 0 0 0 1px rgba(16,17,26,0.06);
      }
      .gvtab {
        flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; border-radius: 26px; text-decoration: none; color: #6b7280;
        font: 500 11px/1 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        border: 0; background: none; cursor: pointer; position: relative;
      }
      .gvtab .gvic { width: 24px; height: 24px; }
      .gvtab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .gvtab[aria-current="page"] { color: #16171a; background: rgba(16,17,26,0.08); }
      .gvtab.is-blank { visibility: hidden; pointer-events: none; }
      .gvtab.is-disabled { opacity: 0.35; pointer-events: none; }
      .gvtab-label-only { font-size: 12.5px; font-weight: 600; }

      /* ── Sheets (Pinned / Profile) — same scrim/panel shape as the help drawer ── */
      .gvsheet { position: fixed; inset: 0; z-index: 2147483150; }
      .gvsheet[hidden] { display: none; }
      .gvsheet__scrim { position: absolute; inset: 0; background: rgba(16,17,26,0.34); opacity: 0; transition: opacity .2s ease; }
      .gvsheet.is-open .gvsheet__scrim { opacity: 1; }
      .gvsheet__panel {
        position: absolute; left: 0; right: 0; bottom: 0;
        max-height: 70vh; overflow-y: auto;
        background: #fff; border-radius: 20px 20px 0 0;
        padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
        box-shadow: 0 -24px 60px -28px rgba(16,24,40,0.45);
        transform: translateY(100%); transition: transform .24s ease;
        font: 500 13px/1.5 "Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #2c2f36;
      }
      .gvsheet.is-open .gvsheet__panel { transform: translateY(0); }
      .gvsheet__head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; margin-bottom: 6px; border-bottom: 1px solid rgba(16,17,26,0.08); }
      .gvsheet__title { margin: 0; font: 700 15px/1.2 "Inter", "Inter Variable", sans-serif; color: #16171a; }
      .gvsheet__x { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: #5b626e; cursor: pointer; }
      .gvsheet__x:hover { background: rgba(16,17,26,0.06); color: #16171a; }
      .gvsheet__x .gvic { width: 18px; height: 18px; }
    }
    @media (min-width: 861px) {
      .gvtabbar, .gvsheet { display: none; }
    }
`;
`;
```

**Note the double-close on the last line above is a typo guard for the plan author, not for you** — write the constant with exactly one closing `` `; `` after `.gvsheet { display: none; } }`.

- [ ] **Step 3: Verify the file still parses**

Run: `node -e "require('./build.js')" 2>&1 | head -20` from `augur/` — expect either a clean exit (no output) or an error unrelated to syntax (e.g. a top-level side-effect complaining about missing env). A `SyntaxError` means the template literal above wasn't closed correctly — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add build.js
git commit -m "Add TABBAR_CSS foundation for mobile bottom tab bar"
```

---

### Task 2: `tabBar(active)` — primary 5-tab bar

**Files:**
- Modify: `build.js:2833` region (insert `tabBar` after `sideRail`'s closing brace)

**Interfaces:**
- Consumes: `NAV_STATE.hasPlayground`, `NAV_STATE.opportunities` (existing globals `sideRail` already reads), `PROJECTS_LABEL`, `LIB_KEYS`, icon constants `IC_HOME`, `IC_PLAY`, `IC_LIBRARY`, `IC_TOKEN`, `IC_PRIM`, `IC_COMP`, `IC_PATTERN`, `IC_PAGE`.
- Produces: `tabBar(active)` — consumed by Task 8 (`appChrome`).

- [ ] **Step 1: Write `tabBar(active)`**

Insert directly after `sideRail()`'s closing `` ` } `` (`build.js:2832`):

```js
// Mobile bottom tab bar. Mirrors the same three-way branch appChrome() already
// computes for the rail (build.js:3040-3042) — "one nav column at a time" expressed
// as one bar content at a time, not a second source of truth for which nav shows.
// A pinned star icon (matches PINS_JS's rendered rows) has no existing IC_ constant,
// so it's inlined here once.
const IC_STAR = ic(`<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.42a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 10.204a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`); // star

function tabBar(active) {
  const tab = (href, label, key, icon, extraAttrs) =>
    `<a class="gvtab" href="${S(href)}"${active === key ? ' aria-current="page"' : ""}${extraAttrs || ""}>${icon}<span>${label}</span></a>`;
  const blankSlot = `<span class="gvtab is-blank" aria-hidden="true"></span>`;

  if (active === "admin") {
    // Same three destinations as adminRail() (build.js:3084-3086), label-only —
    // adminRail()'s tab() helper has no icon set to reuse. Two blank slots keep the
    // bar's 5-column width stable across every context.
    // Same data-admin-tab attribute + values adminRail()'s own tab() helper uses
    // (build.js:3073-3074: tab("people","People") etc.) — NOT a separate attribute.
    // ADMIN_SECTIONS_JS's show()/click-wiring is broadened in Task 8 to query the
    // whole document instead of just the desktop nav, so these buttons are picked up
    // by the exact same existing logic with no parallel mechanism to keep in sync.
    return `<nav class="gvtabbar" aria-label="Workspace settings">
      <button type="button" class="gvtab gvtab-label-only" data-admin-tab="people"><span>People</span></button>
      <button type="button" class="gvtab gvtab-label-only" data-admin-tab="content"><span>Content</span></button>
      <button type="button" class="gvtab gvtab-label-only" data-admin-tab="settings"><span>Settings</span></button>
      ${blankSlot}${blankSlot}
    </nav>`;
  }

  if (LIB_KEYS.includes(active)) {
    // Same five destinations as libraryRail() (build.js:3060-3064), same order.
    return `<nav class="gvtabbar" aria-label="Design system">
      ${tab("/tokens/", "Tokens", "tokens", IC_TOKEN)}
      ${tab("/base/", "Base", "base", IC_PRIM)}
      ${tab("/components/", "Components", "components", IC_COMP)}
      ${tab("/patterns/", "Patterns", "patterns", IC_PATTERN)}
      ${tab("/pages/", "Pages", "pages", IC_PAGE)}
    </nav>`;
  }

  const playground = NAV_STATE.hasPlayground
    ? tab("/playground/", "Playground", "playground", IC_PLAY)
    : blankSlot;
  return `<nav class="gvtabbar" aria-label="Primary">
    ${tab("/", PROJECTS_LABEL, "prototypes", IC_HOME)}
    ${playground}
    ${tab("/tokens/", "Design system", "library", IC_LIBRARY)}
    <button type="button" class="gvtab" data-tab-pinned aria-haspopup="dialog">${IC_STAR}<span>Pinned</span></button>
    <button type="button" class="gvtab" data-prof data-tab-profile aria-haspopup="dialog" hidden><span class="gvprof__av" data-prof-av aria-hidden="true"></span><span>Profile</span></button>
  </nav>`;
}
```

Note: the Profile tab button carries `data-prof` (in ADDITION to `data-tab-profile`) purely so it's swept up by `PROFILE_JS`'s `boxes = document.querySelectorAll('[data-prof]')` (Task 4 Step 2) and gets `hidden = false` for free once identity resolves, exactly like `profileChip()`'s own box. It has no `[data-prof-toggle]`/`[data-prof-menu]` descendants, so the rest of `PROFILE_JS`'s per-box wiring (Task 4 Step 2) simply finds nothing to attach inside it and skips — harmless. Without `data-prof` here, the button would stay `hidden` forever, since nothing else reveals it.

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "require('./build.js')" 2>&1 | head -20` from `augur/`.

- [ ] **Step 3: Commit**

```bash
git add build.js
git commit -m "Add tabBar(active): mobile bottom tab bar markup"
```

---

### Task 3: Pinned sheet — `mobilePinnedSheet()` + `PINS_JS` multi-instance fix

**Files:**
- Modify: `build.js:2833` region (insert `mobilePinnedSheet` beside `tabBar`)
- Modify: `build.js:3956-3999` (`PINS_JS`)

**Interfaces:**
- Consumes: same `data-pinned-list`/`data-pinned-empty` contract `sideRail()`'s pinned block already defines (`build.js:2804-2806`).
- Produces: `mobilePinnedSheet()` — consumed by Task 8 (`appChrome`).

- [ ] **Step 1: Write `mobilePinnedSheet()`**

Insert after `tabBar` (Task 2):

```js
// Second copy of the pinned list — sideRail()'s copy lives inside .gvside, which is
// display:none on mobile (NAV_CSS's 860px query), so it can't double as this sheet's
// content. PINS_JS is made multi-instance-aware below so both copies stay in sync
// off the one /__pins fetch.
function mobilePinnedSheet() {
  return `<div class="gvsheet" id="gvpinsheet" data-pin-sheet hidden>
    <div class="gvsheet__scrim" data-pin-sheet-scrim></div>
    <div class="gvsheet__panel" role="dialog" aria-modal="true" aria-label="Pinned">
      <div class="gvsheet__head">
        <h2 class="gvsheet__title">Pinned</h2>
        <button type="button" class="gvsheet__x" data-pin-sheet-close aria-label="Close">${IC_CLOSE}</button>
      </div>
      <div class="gvside__group" data-pinned-list></div>
      <p class="gvside__pinhint" data-pinned-empty hidden>Star a prototype to pin it here.</p>
    </div>
  </div>`;
}
```

- [ ] **Step 2: Make `PINS_JS` multi-instance-aware**

At `build.js:3958-3959`, change:
```js
  var listEl = document.querySelector('[data-pinned-list]');
  var emptyEl = document.querySelector('[data-pinned-empty]');
```
to:
```js
  var listEls = [].slice.call(document.querySelectorAll('[data-pinned-list]'));
  var emptyEls = [].slice.call(document.querySelectorAll('[data-pinned-empty]'));
```

At `build.js:3961`, change:
```js
  if(!listEl && !btns.length) return;
```
to:
```js
  if(!listEls.length && !btns.length) return;
```

At `build.js:3988-3999` (`renderList`), change:
```js
  function renderList(){
    if(!listEl) return;
    var keys = Object.keys(map).filter(inSpace);
    listEl.innerHTML = keys.map(function(k){
      var it = map[k] || {}; var parts = splitEmoji(labelOf(k, it));
      var glyph = parts[0] || '📌';
      var txt = esc(parts[1] || it.label || k);
      var cur = (it.href === location.pathname) ? ' aria-current="page"' : '';
      return '<a href="'+esc(it.href||k)+'" draggable="true" data-k="'+esc(k)+'"'+cur+'><span class="gvpin-ic" aria-hidden="true">'+esc(glyph)+'</span><span>'+txt+'</span></a>';
    }).join('');
    if(emptyEl) emptyEl.hidden = keys.length > 0;
  }
```
to:
```js
  function renderList(){
    if(!listEls.length) return;
    var keys = Object.keys(map).filter(inSpace);
    var html = keys.map(function(k){
      var it = map[k] || {}; var parts = splitEmoji(labelOf(k, it));
      var glyph = parts[0] || '📌';
      var txt = esc(parts[1] || it.label || k);
      var cur = (it.href === location.pathname) ? ' aria-current="page"' : '';
      return '<a href="'+esc(it.href||k)+'" draggable="true" data-k="'+esc(k)+'"'+cur+'><span class="gvpin-ic" aria-hidden="true">'+esc(glyph)+'</span><span>'+txt+'</span></a>';
    }).join('');
    listEls.forEach(function(el){ el.innerHTML = html; });
    emptyEls.forEach(function(el){ el.hidden = keys.length > 0; });
  }
```

(`draggable="true"` stays — inert on touch/mobile already since there's no native touch drag-and-drop for this attribute, not a regression.)

- [ ] **Step 3: Verify no other reference to the old singular names**

Run: `grep -n "listEl\b\|emptyEl\b" build.js` from `augur/` — expect zero matches (only `listEls`/`emptyEls` should remain). If any singular reference remains outside what was just edited, fix it.

- [ ] **Step 4: Commit**

```bash
git add build.js
git commit -m "Add mobile Pinned sheet; make PINS_JS multi-instance-aware"
```

---

### Task 4: Profile sheet — `mobileProfileSheet()` + `PROFILE_JS`/`SETTINGS_JS`/`SPACE_JS` multi-instance fixes

**Files:**
- Modify: `build.js:2833` region (insert `mobileProfileSheet` beside `tabBar`/`mobilePinnedSheet`)
- Modify: `build.js:4171-4257` (`PROFILE_JS`)
- Modify: `build.js:4290-4316` (`SETTINGS_JS`, the `open`/click-handler region)
- Modify: `build.js:4677-4710` (`SPACE_JS`)

**Interfaces:**
- Consumes: `profileChip()` (`build.js:2721`, called unchanged — no edits to that function), `IC_GEAR`, `IC_CHANGELOG`, `UI_VERSION`, `NAV_STATE.activeSpace`.
- Produces: `mobileProfileSheet()` — consumed by Task 8 (`appChrome`).

- [ ] **Step 1: Write `mobileProfileSheet()`**

Insert after `mobilePinnedSheet` (Task 3):

```js
// Second copy of the profile chip's identity block/menu, plus the two items the
// sidebar's foot carried (Admin, Changelog) that have nowhere else to live once the
// drawer is gone. profileChip() itself is called unchanged — see PROFILE_JS,
// SETTINGS_JS and SPACE_JS below for the matching multi-instance fixes this requires.
function mobileProfileSheet() {
  return `<div class="gvsheet" id="gvprofsheet" data-prof-sheet hidden>
    <div class="gvsheet__scrim" data-prof-sheet-scrim></div>
    <div class="gvsheet__panel" role="dialog" aria-modal="true" aria-label="Profile">
      <div class="gvsheet__head">
        <h2 class="gvsheet__title">Profile</h2>
        <button type="button" class="gvsheet__x" data-prof-sheet-close aria-label="Close">${IC_CLOSE}</button>
      </div>
      ${profileChip()}
      <a class="gvside__admin" href="/admin/" data-space-admin${
        NAV_STATE.activeSpace ? ` data-space-id="${escAttr(NAV_STATE.activeSpace)}"` : ""
      }>${IC_GEAR}<span>Admin</span></a>
      <a href="/changelog/">${IC_CHANGELOG}<span>Changelog</span><span class="gvside__ver">v${UI_VERSION}</span></a>
    </div>
  </div>`;
}
```

- [ ] **Step 2: Make `PROFILE_JS`'s reveal/version/toggle-wiring multi-instance-aware**

At `build.js:4172-4173`, change:
```js
  var box = document.querySelector('[data-prof]');
  if(!box) return;
```
to:
```js
  var boxes = [].slice.call(document.querySelectorAll('[data-prof]'));
  if(!boxes.length) return;
```

At `build.js:4199-4201` (inside `paint`), change:
```js
    document.documentElement.classList.toggle('gv-admin', !!u.admin);
    box.hidden = false;
    if(u.admin){ version(); }
```
to:
```js
    document.documentElement.classList.toggle('gv-admin', !!u.admin);
    boxes.forEach(function(b){ b.hidden = false; });
    if(u.admin){ version(); }
```

At `build.js:4226-4241` (`version`), change:
```js
  function version(){
    fetch('/__admin/version', {headers:{'Accept':'application/json'}})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(v){
        if(!v || !v.current) return;
        var row = box.querySelector('[data-prof-ver]');
        var cur = box.querySelector('[data-prof-vercur]');
        var lnk = box.querySelector('[data-prof-verlink]');
        if(cur) cur.textContent = 'Augur v' + v.current + (v.current.lastIndexOf('0.', 0) === 0 ? ' beta' : '');
        if(row) row.hidden = false;
        if(v.behind){
          var dot = box.querySelector('[data-prof-dot]'); if(dot) dot.hidden = false;
          if(lnk){ lnk.textContent = 'v' + v.latest + ' available'; if(v.url) lnk.href = v.url; lnk.hidden = false; }
        }
      }).catch(function(){});
  }
```
to:
```js
  function version(){
    fetch('/__admin/version', {headers:{'Accept':'application/json'}})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(v){
        if(!v || !v.current) return;
        boxes.forEach(function(box){
          var row = box.querySelector('[data-prof-ver]');
          var cur = box.querySelector('[data-prof-vercur]');
          var lnk = box.querySelector('[data-prof-verlink]');
          if(cur) cur.textContent = 'Augur v' + v.current + (v.current.lastIndexOf('0.', 0) === 0 ? ' beta' : '');
          if(row) row.hidden = false;
          if(v.behind){
            var dot = box.querySelector('[data-prof-dot]'); if(dot) dot.hidden = false;
            if(lnk){ lnk.textContent = 'v' + v.latest + ' available'; if(v.url) lnk.href = v.url; lnk.hidden = false; }
          }
        });
      }).catch(function(){});
  }
```

At `build.js:4249-4256` (toggle wiring), change:
```js
  var btn = box.querySelector('[data-prof-toggle]');
  var menu = box.querySelector('[data-prof-menu]');
  function open(o){ if(!menu) return; menu.hidden = !o; if(btn) btn.setAttribute('aria-expanded', o ? 'true' : 'false'); }
  if(btn && menu){
    btn.addEventListener('click', function(e){ e.stopPropagation(); open(menu.hidden); });
    document.addEventListener('click', function(e){ if(!box.contains(e.target)) open(false); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') open(false); });
  }
```
to:
```js
  boxes.forEach(function(box){
    var btn = box.querySelector('[data-prof-toggle]');
    var menu = box.querySelector('[data-prof-menu]');
    function open(o){ if(!menu) return; menu.hidden = !o; if(btn) btn.setAttribute('aria-expanded', o ? 'true' : 'false'); }
    if(btn && menu){
      btn.addEventListener('click', function(e){ e.stopPropagation(); open(menu.hidden); });
      document.addEventListener('click', function(e){ if(!box.contains(e.target)) open(false); });
      document.addEventListener('keydown', function(e){ if(e.key === 'Escape') open(false); });
    }
  });
```

(`paint()`'s own `avs`/`names`/`ems` loops at `build.js:4182-4191` are already `querySelectorAll`-based — no change needed there.)

- [ ] **Step 3: Scope `SETTINGS_JS`'s open/close to the box that was actually clicked**

At `build.js:4290-4298` (`open`), change:
```js
  function open(){
    if(!ME) return;
    if(hideT){ clearTimeout(hideT); hideT = null; }
    // Restore focus to the chip, not to the menu item — that is hidden by then.
    last = document.querySelector('[data-prof-toggle]') || document.activeElement;
    el.hidden = false;
    requestAnimationFrame(function(){ el.classList.add('is-open'); });
    var x = el.querySelector('[data-set-close]'); if(x) x.focus();
  }
```
to:
```js
  function open(returnEl){
    if(!ME) return;
    if(hideT){ clearTimeout(hideT); hideT = null; }
    // Restore focus to whichever chip/sheet-button opened this (desktop dropdown or
    // the mobile Profile-tab button) — there can be more than one on the page now.
    last = returnEl || document.activeElement;
    el.hidden = false;
    requestAnimationFrame(function(){ el.classList.add('is-open'); });
    var x = el.querySelector('[data-set-close]'); if(x) x.focus();
  }
```

At `build.js:4307-4316`, change:
```js
  [].forEach.call(document.querySelectorAll('[data-prof-settings]'), function(o){
    o.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      // The click never reaches PROFILE_JS's outside-click handler (and wouldn't
      // close the menu anyway, being inside it), so dismiss the menu here.
      var pm = document.querySelector('[data-prof-menu]'); if(pm) pm.hidden = true;
      var pt = document.querySelector('[data-prof-toggle]'); if(pt) pt.setAttribute('aria-expanded','false');
      open();
    });
  });
```
to:
```js
  [].forEach.call(document.querySelectorAll('[data-prof-settings]'), function(o){
    o.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      // Scope to the box this button lives in — there can be more than one
      // [data-prof] on the page (desktop chip + mobile Profile sheet).
      var box = o.closest('[data-prof]');
      // The click never reaches PROFILE_JS's outside-click handler (and wouldn't
      // close the menu anyway, being inside it), so dismiss the menu here.
      var pm = box && box.querySelector('[data-prof-menu]'); if(pm) pm.hidden = true;
      var pt = box && box.querySelector('[data-prof-toggle]'); if(pt) pt.setAttribute('aria-expanded','false');
      open(pt);
    });
  });
```

- [ ] **Step 4: Loop `SPACE_JS`'s admin-link href fixup**

At `build.js:4702-4707`, change:
```js
    if(open || (here && here.role === 'admin')){
      document.documentElement.classList.add('gv-space-admin');
      // Scope the Admin link to this workspace so the page opens on the right one.
      var link = document.querySelector('[data-space-admin]');
      if(link && id) link.setAttribute('href', '/admin/?space=' + encodeURIComponent(id));
    }
```
to:
```js
    if(open || (here && here.role === 'admin')){
      document.documentElement.classList.add('gv-space-admin');
      // Scope every Admin link to this workspace so each opens on the right one —
      // there can be more than one now (desktop rail + mobile Profile sheet).
      var links = document.querySelectorAll('[data-space-admin]');
      if(id) [].forEach.call(links, function(link){ link.setAttribute('href', '/admin/?space=' + encodeURIComponent(id)); });
    }
```

- [ ] **Step 5: Verify no stray singular references remain**

Run: `grep -n '\bbox\.' build.js` from `augur/` and confirm every remaining hit is either inside the new `boxes.forEach(function(box){...})` block (Task 4 Step 2) or inside `SETTINGS_JS`'s per-click `var box = o.closest(...)` block (Task 4 Step 3) — i.e. no leftover top-level singular `box` in `PROFILE_JS`.

- [ ] **Step 6: Commit**

```bash
git add build.js
git commit -m "Add mobile Profile sheet; make profile/settings/admin-link JS multi-instance-aware"
```

---

### Task 5: Header restructure — per-space branding, back chevron, search toggle

**Files:**
- Modify: `build.js:3031-3044` (`appChrome`)

**Interfaces:**
- Consumes: `spaceSwitcher()`'s data source (`NAV_STATE.spaces`/`activeSpace`, `build.js:2751-2775`), `GV_MARK`, `SEARCH_ICON`, `IC_CLOSE`, `railSearch()`.
- Produces: restructured `.gvtop` markup inside `appChrome()` — no other task consumes this directly, but Task 8 finalizes `appChrome()`'s full return value.

- [ ] **Step 1: Replace the `.gvtop` markup in `appChrome()`**

At `build.js:3032-3035`, change:
```js
  const top = `<header class="gvtop">
    <button type="button" class="gvburger" data-side-toggle aria-expanded="false" aria-controls="gvside" aria-label="Open navigation"><span class="gvburger__bars" aria-hidden="true"><span></span><span></span><span></span></span></button>
    <a class="gvtop__brand" href="${S("/")}">${GV_MARK}<span>augur</span></a>
  </header>`;
```
to:
```js
  // Mobile header center: the active space's own icon+name (same data spaceSwitcher()
  // reads, build.js:2751), replacing the hardcoded engine mark — correct on every
  // instance by construction. Falls back to GV_MARK+"augur" only when there's no
  // space to name (the engine-only/shell build case, spaceSwitcher() returns "" then
  // too — build.js:2753). A back chevron replaces the brand whenever this page's rail
  // would be library/admin/an opportunity — i.e. whenever sideRail() itself isn't the
  // active view (the same branch appChrome() computes below for `rail`).
  const spaces = NAV_STATE.spaces || [];
  const activeSpaceObj = spaces.find((s) => s.id === NAV_STATE.activeSpace) || spaces[0];
  const isSubView = active === "admin" || LIB_KEYS.includes(active) || (active && active !== "prototypes" && active !== "playground" && active !== "library" && active !== "changelog");
  const brandCenter = activeSpaceObj
    ? `<a class="gvtop__center-brand" href="${S("/")}"><img src="/space-icon.png" alt="" width="22" height="22" /><span>${escAttr(activeSpaceObj.name)}</span></a>`
    : `<a class="gvtop__center-brand" href="${S("/")}">${GV_MARK}<span>augur</span></a>`;
  const titleText = active === "admin" ? "Workspace settings" : active === "library" || LIB_KEYS.includes(active) ? "Design system" : "";
  const center = isSubView
    ? `<span class="gvtop__title">${titleText || ""}</span>`
    : brandCenter;
  const leftSlot = isSubView
    ? `<a class="gvtop__back" href="${S("/")}" aria-label="Back"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
    : `<span class="gvtop__side" aria-hidden="true"></span>`;
  const top = `<header class="gvtop">
    <button type="button" class="gvburger" data-side-toggle aria-expanded="false" aria-controls="gvside" aria-label="Open navigation"><span class="gvburger__bars" aria-hidden="true"><span></span><span></span><span></span></span></button>
    <a class="gvtop__brand" href="${S("/")}">${GV_MARK}<span>augur</span></a>
    ${leftSlot}
    <div class="gvtop__center">${center}</div>
    <div class="gvtop__searchwrap">${railSearch()}</div>
    <button type="button" class="gvtop__search-btn" data-mobile-search-toggle aria-label="Search">${SEARCH_ICON}</button>
  </header>`;
```

Note this keeps the original `.gvburger`/`.gvtop__brand` markup too — they stay desktop-dead-but-present is wrong; actually `.gvburger` and `.gvtop__brand` only ever rendered on mobile (`.gvtop` is `display:none` above 860px per `NAV_CSS`, `build.js:2020`), so leaving the old two elements in the same header alongside the new ones would show both. **Remove** the old `.gvburger` button and `.gvtop__brand` anchor lines entirely — the new `leftSlot`/`center`/searchwrap/search-btn fully replace them:

```js
  const top = `<header class="gvtop">
    ${leftSlot}
    <div class="gvtop__center">${center}</div>
    <div class="gvtop__searchwrap">${railSearch()}</div>
    <button type="button" class="gvtop__search-btn" data-mobile-search-toggle aria-label="Search">${SEARCH_ICON}</button>
  </header>`;
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "require('./build.js')" 2>&1 | head -20` from `augur/`.

- [ ] **Step 3: Commit**

```bash
git add build.js
git commit -m "Restructure mobile header: per-space branding, back chevron, search toggle"
```

---

### Task 6: Wire `tabBar`/sheets into `appChrome()`; remove hamburger/drawer JS

**Files:**
- Modify: `build.js:3031-3044` (`appChrome`, final assembly)
- Modify: `chromeScript()` region (`build.js:3093` onward) — remove `data-side-toggle` wiring
- Modify: `build.js:2303-2309` (`NAV_CSS`'s 860px query) — hide `.gvburger`/keep drawer CSS but it's now dead weight only if `.gvburger` markup is gone (it is, per Task 5)

**Interfaces:**
- Consumes: `tabBar(active)` (Task 2), `mobilePinnedSheet()` (Task 3), `mobileProfileSheet()` (Task 4), `TABBAR_CSS` (Task 1).
- Produces: final `appChrome(active)` return value.

- [ ] **Step 1: Append the new pieces to `appChrome()`'s return value**

At `build.js:3043` (post Task 5's edits, same line), change:
```js
  return `${top}${rail}<div class="gvscrim" data-side-scrim></div>${helpDrawer()}${settingsModal()}`;
```
to:
```js
  return `${top}${rail}<div class="gvscrim" data-side-scrim></div>${tabBar(active)}${mobilePinnedSheet()}${mobileProfileSheet()}${helpDrawer()}${settingsModal()}`;
```

- [ ] **Step 2: Delete the now-dead `.gvburger` CSS**

Task 5 already removed the `.gvburger` button and `.gvtop__brand` anchor markup from `appChrome()`'s `top` template, so this whole block (`build.js:2028-2043`) has no matching element left to style. `.gvside`/`.gvscrim` stay fully — those are desktop's permanent nav and untouched. Delete exactly:
```css
    .gvburger {
      width: 36px; height: 34px; flex: none; padding: 0; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 9px; border: 1px solid rgba(16,17,26,0.12); background: rgba(16,17,26,0.03); color: #16171a;
      transition: background .12s ease, border-color .12s ease;
    }
    .gvburger:hover { background: rgba(16,17,26,0.06); border-color: rgba(16,17,26,0.20); }
    .gvburger:focus-visible { outline: 2px solid #5e6ad2; outline-offset: 1px; }
    .gvburger__bars { position: relative; display: block; width: 16px; height: 12px; }
    .gvburger__bars span { position: absolute; left: 0; right: 0; height: 2px; border-radius: 2px; background: currentColor; transition: transform .18s ease, opacity .12s ease, top .18s ease; }
    .gvburger__bars span:nth-child(1) { top: 0; }
    .gvburger__bars span:nth-child(2) { top: 5px; }
    .gvburger__bars span:nth-child(3) { top: 10px; }
    .gvburger[aria-expanded="true"] .gvburger__bars span:nth-child(1) { top: 5px; transform: rotate(45deg); }
    .gvburger[aria-expanded="true"] .gvburger__bars span:nth-child(2) { opacity: 0; }
    .gvburger[aria-expanded="true"] .gvburger__bars span:nth-child(3) { top: 5px; transform: rotate(-45deg); }
```

Run: `grep -n "gvburger" build.js` — expect zero matches after this deletion (markup was removed in Task 5, CSS removed here).

- [ ] **Step 3: Inject `TABBAR_CSS` into both page-shell injection sites**

There are exactly two places `NAV_CSS` reaches a page (confirmed by `grep -n "chromeScript()\|NAV_CSS}\|NAV_CSS\`\|appChrome(" build.js`): `injectNav()` (`build.js:3349`) and `shell()` (`build.js:5602`). Both need `TABBAR_CSS` added; `TABBAR_JS()` (written in Task 7) also needs adding to both — do that part in Task 7 Step 2, not here.

At `build.js:3349`, change:
```js
    `${m[0]}\n  <style>${NAV_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${spaceContextScript()}</script>\n  <script>${PINS_JS}</script>\n  <script>${PROFILE_JS}</script>\n  <script>${SETTINGS_JS}</script>\n  <script>${SPACE_JS}</script>`
```
to:
```js
    `${m[0]}\n  <style>${NAV_CSS}${TABBAR_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${spaceContextScript()}</script>\n  <script>${PINS_JS}</script>\n  <script>${PROFILE_JS}</script>\n  <script>${SETTINGS_JS}</script>\n  <script>${SPACE_JS}</script>`
```

At `build.js:5602-5603`, change:
```js
  <style>${FONT_CSS}${PAGE_CSS}${NAV_CSS}${addon ? addon.css() : ""}
  </style>
```
to:
```js
  <style>${FONT_CSS}${PAGE_CSS}${NAV_CSS}${TABBAR_CSS}${addon ? addon.css() : ""}
  </style>
```

- [ ] **Step 4: Make `chromeScript()`'s search-filter wiring multi-instance-aware**

There will be two `[data-filter]` inputs on the page once Task 5's header ships (the relocated header search + the original one still inside `sideRail()`'s now off-canvas `.gvside` — `.gvside` stays in the DOM on mobile, just permanently translated off-screen since there's no more toggle to open it; this spec's "removed on mobile" is about capability, not deleting markup, matching how `sideRail()` itself stays untouched for desktop). Today's code (`build.js:3096-3278`) only ever wires the FIRST `[data-filter]` it finds via `document.querySelector`, so the second input would silently do nothing when typed into.

At `build.js:3096-3097`, change:
```js
  var input = document.querySelector('[data-filter]');
  if (input && !input.dataset.wired) {
    input.dataset.wired = '1';
```
to:
```js
  [].forEach.call(document.querySelectorAll('[data-filter]'), function(input){
  if (input && !input.dataset.wired) {
    input.dataset.wired = '1';
```

At `build.js:3278` (the line that closes this block, immediately before the `// ── Mobile rail drawer` comment), change:
```js
  }

  // ── Mobile rail drawer (hamburger + scrim) ───────────────────────────────
```
to:
```js
  }
  });

  // ── Mobile rail drawer (hamburger + scrim) ───────────────────────────────
```

Everything between those two edits (lines 3098-3277: `apply()`, the Cmd+K/`/` global shortcuts, the fuzzy-finder popover) stays byte-for-byte unchanged — each is now a closure over whichever `input` its own `forEach` iteration captured, so each of the two inputs gets its own fully independent, fully working copy of the filter + fuzzy-finder (each creates its own `.gvfind` results pane on first use). This is deliberately not deduplicated further: only one input is ever visible per viewport (CSS-gated), so the duplication costs nothing at runtime beyond two harmless independent `document.addEventListener('keydown', ...)` registrations for Cmd+K/`/` — on a real keyboard-and-mobile-viewport combination (rare: an external keyboard on a phone) the last-registered listener's `.focus()` call wins, which is a known, accepted minor edge case, not a regression path this plan chases further. The primary mobile interaction (tapping the header's search icon, wired in Task 7) calls `.focus()` directly and is unaffected.

- [ ] **Step 5: Remove the hamburger/drawer-toggle JS from `chromeScript()`**

At `build.js:3280-3292` (the `// ── Mobile rail drawer (hamburger + scrim) ──` block, now immediately following Step 4's inserted `});`), delete the entire block:
```js
  // ── Mobile rail drawer (hamburger + scrim) ───────────────────────────────
  var sideToggle = document.querySelector('[data-side-toggle]');
  var side = document.getElementById('gvside');
  var scrim = document.querySelector('[data-side-scrim]');
  if(sideToggle && side){
    function closeSide(){ sideToggle.setAttribute('aria-expanded','false'); side.classList.remove('is-open'); if(scrim) scrim.classList.remove('is-open'); }
    function openSide(){ sideToggle.setAttribute('aria-expanded','true'); side.classList.add('is-open'); if(scrim) scrim.classList.add('is-open'); }
    sideToggle.addEventListener('click', function(e){ e.stopPropagation(); side.classList.contains('is-open') ? closeSide() : openSide(); });
    if(scrim) scrim.addEventListener('click', closeSide);
    side.addEventListener('click', function(e){ if(e.target.closest('a')) closeSide(); });
    document.addEventListener('keydown', function(e){ if((e.key||'').toLowerCase() === 'escape') closeSide(); });
    window.addEventListener('resize', function(){ if(window.innerWidth > 860) closeSide(); });
  }

```
This is safe to remove outright: `data-side-toggle` no longer exists in any markup after Task 5 removed `.gvburger`, so this block was already inert dead code by that point — this step just deletes it rather than leaving it unreachable.

- [ ] **Step 6: Verify the file still parses**

Run: `node -e "require('./build.js')" 2>&1 | head -20` from `augur/`.

- [ ] **Step 7: Commit**

```bash
git add build.js
git commit -m "Wire tabBar/sheets into appChrome; make search-filter multi-instance-aware; remove dead hamburger drawer JS"
```

---

### Task 7: `TABBAR_JS` — sheet open/close, search toggle, DS/Admin sub-bar active state, Pinned-empty dimming

**Files:**
- Modify: `build.js:2833` region or beside `chromeScript()` — new `TABBAR_JS` constant
- Modify: both injection sites (`build.js:3349` and `build.js:5632`, same lines touched in Task 6 Step 3)

**Interfaces:**
- Consumes: `data-pin-sheet`/`data-pin-sheet-scrim`/`data-pin-sheet-close`/`data-tab-pinned` (Task 3), `data-prof-sheet`/`data-prof-sheet-scrim`/`data-prof-sheet-close`/`data-tab-profile` (Task 4), `data-mobile-search-toggle` (Task 5), `data-pinned-empty` (existing, now multi-instance per Task 3).
- Produces: `TABBAR_JS` — injected once per page, same site as `PINS_JS` etc.

- [ ] **Step 1: Write `TABBAR_JS`**

Insert as a new `const` beside `chromeScript()` (after its closing, or directly before it — either is fine, it's a standalone IIFE-returning string like `PINS_JS`):

```js
// Mobile tab bar behaviour: the two sheets (Pinned, Profile), the header's search
// toggle, and dimming the Pinned tab when there's nothing pinned. Route tabs
// (Projects/Playground/DS/DS-sub/Admin-sub) are plain <a>/<button data-admin-tab>
// links needing no JS of their own — this only wires what isn't a navigation.
function TABBAR_JS() {
  return `(function(){
  function wireSheet(openBtnSel, sheetSel, scrimSel, closeSel){
    var sheet = document.querySelector(sheetSel);
    var openBtn = document.querySelector(openBtnSel);
    if(!sheet || !openBtn) return;
    function open(){ if(openBtn.disabled) return; sheet.hidden = false; requestAnimationFrame(function(){ sheet.classList.add('is-open'); }); }
    function close(){ sheet.classList.remove('is-open'); setTimeout(function(){ sheet.hidden = true; }, 220); }
    openBtn.addEventListener('click', open);
    var scrim = sheet.querySelector(scrimSel);
    if(scrim) scrim.addEventListener('click', close);
    var x = sheet.querySelector(closeSel);
    if(x) x.addEventListener('click', close);
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !sheet.hidden) close(); });
  }
  wireSheet('[data-tab-pinned]', '[data-pin-sheet]', '[data-pin-sheet-scrim]', '[data-pin-sheet-close]');
  wireSheet('[data-tab-profile]', '[data-prof-sheet]', '[data-prof-sheet-scrim]', '[data-prof-sheet-close]');

  // Dim the Pinned tab when the (now possibly-multiple) empty-state hint is showing.
  // PINS_JS toggles [data-pinned-empty].hidden once its /__pins fetch resolves; watch
  // the first instance (they're always in sync — see PINS_JS's renderList()) rather
  // than duplicating the pins-map logic here.
  var emptyHint = document.querySelector('[data-pinned-empty]');
  var pinnedTab = document.querySelector('[data-tab-pinned]');
  if(emptyHint && pinnedTab){
    var mo = new MutationObserver(function(){
      var empty = emptyHint.hidden === false;
      pinnedTab.classList.toggle('is-disabled', empty);
      pinnedTab.disabled = empty;
    });
    mo.observe(emptyHint, {attributes:true, attributeFilter:['hidden']});
    // Initial state — MutationObserver only fires on future changes.
    pinnedTab.classList.toggle('is-disabled', emptyHint.hidden === false);
    pinnedTab.disabled = emptyHint.hidden === false;
  }

  // Header search toggle: swap the center brand/title for the omni search input.
  var searchBtn = document.querySelector('[data-mobile-search-toggle]');
  if(searchBtn){
    searchBtn.addEventListener('click', function(){
      var on = document.body.classList.toggle('gv-mobile-searching');
      if(on){ var input = document.querySelector('.gvtop__searchwrap [data-filter]'); if(input) input.focus(); }
    });
  }
})();
`;
}
```

- [ ] **Step 2: Inject `TABBAR_JS()` at both page-shell sites**

At the `injectNav()` injection line touched in Task 6 Step 3 (`build.js:3349`), change:
```js
    `${m[0]}\n  <style>${NAV_CSS}${TABBAR_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${spaceContextScript()}</script>\n  <script>${PINS_JS}</script>\n  <script>${PROFILE_JS}</script>\n  <script>${SETTINGS_JS}</script>\n  <script>${SPACE_JS}</script>`
```
to:
```js
    `${m[0]}\n  <style>${NAV_CSS}${TABBAR_CSS}</style>\n  ${appChrome(active)}\n  <script>${chromeScript()}</script>\n  <script>${spaceContextScript()}</script>\n  <script>${PINS_JS}</script>\n  <script>${PROFILE_JS}</script>\n  <script>${SETTINGS_JS}</script>\n  <script>${SPACE_JS}</script>\n  <script>${TABBAR_JS()}</script>`
```

At `shell()`'s injection (`build.js:5632-5633`, right after the `${SPACE_JS}` script tag), change:
```js
  <script>${SPACE_JS}
  </script>
  <script>${RESEARCH_JS}
```
to:
```js
  <script>${SPACE_JS}
  </script>
  <script>${TABBAR_JS()}
  </script>
  <script>${RESEARCH_JS}
```

- [ ] **Step 3: Verify the file still parses**

Run: `node -e "require('./build.js')" 2>&1 | head -20` from `augur/`.

- [ ] **Step 4: Commit**

```bash
git add build.js
git commit -m "Add TABBAR_JS: sheet open/close, search toggle, Pinned-empty dimming"
```

---

### Task 8: Admin sub-bar tab wiring — broaden `ADMIN_SECTIONS_JS` to the whole document

**Files:**
- Modify: `build.js:5148-5199` (`ADMIN_SECTIONS_JS`)

**Interfaces:**
- Consumes: `data-admin-tab="people"|"content"|"settings"` (Task 2's admin branch of `tabBar()`, reusing `adminRail()`'s own values verbatim — no new attribute).
- Produces: nothing new — this task only widens an existing selector's scope.

`ADMIN_SECTIONS_JS` (`build.js:5148`) already drives the People/Content/Settings switch entirely through `[data-admin-tab]` buttons and `[data-admin-sec]` panels (`build.js:5178-5199`). Its panel query (`document.querySelectorAll('[data-admin-sec]')`, `build.js:5187`) is already document-wide; only the TAB query (`nav.querySelectorAll(...)`, scoped to `[data-admin-nav]` — i.e. only `adminRail()`'s three desktop buttons) needs widening to also reach Task 2's three mobile sub-bar buttons, which live in the bottom bar, not inside `[data-admin-nav]`.

- [ ] **Step 1: Widen `show()`'s tab query**

At `build.js:5180-5186`, change:
```js
  function show(name){
    var tabs = nav.querySelectorAll('[data-admin-tab]');
    tabs.forEach(function(t){
```
to:
```js
  function show(name){
    // Document-wide, not nav-scoped: Task 2's mobile Admin sub-bar renders its three
    // buttons in the bottom tab bar, outside adminRail()'s [data-admin-nav] — same
    // data-admin-tab attribute/values, so one query now reaches both.
    var tabs = document.querySelectorAll('[data-admin-tab]');
    tabs.forEach(function(t){
```

- [ ] **Step 2: Widen the click-wiring query**

At `build.js:5191`, change:
```js
  nav.querySelectorAll('[data-admin-tab]').forEach(function(t){
```
to:
```js
  document.querySelectorAll('[data-admin-tab]').forEach(function(t){
```

`nav` itself (`build.js:5149`, `document.querySelector('[data-admin-nav]')`) stays exactly as-is and its `if(!nav) return;` guard (`build.js:5150`) stays too — it's still the correct existence check for "are we on an admin page at all," since Task 2's mobile sub-bar only ever renders when `active === "admin"`, which is exactly when `adminRail()` (and `[data-admin-nav]`) also renders.

- [ ] **Step 3: Verify no other `nav.querySelectorAll`/`nav.` reference was missed**

Run: `grep -n "^  var nav\|nav\.querySelectorAll\|nav\." build.js | grep -A0 -B0 "51[4-9][0-9]\|520[0-9]"` — informally, re-read `build.js:5148-5199` after the edit and confirm `nav` is now used only for the initial existence guard (`build.js:5150`), not for any remaining scoped query. (The `back` link fixup at `build.js:5165` uses `document.querySelector('[data-admin-back]')` already, unrelated to this task.)

- [ ] **Step 4: Verify the file still parses**

Run: `node -e "require('./build.js')" 2>&1 | head -20` from `augur/`.

- [ ] **Step 5: Commit**

```bash
git add build.js
git commit -m "Broaden ADMIN_SECTIONS_JS's tab query so the mobile Admin sub-bar drives the same panels"
```

---

### Task 9: `UI_VERSION` bump + full offline verification pass

**Files:**
- Modify: `build.js:388` (`UI_VERSION`)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this is the verification gate before push.

- [ ] **Step 1: Bump `UI_VERSION`**

At `build.js:388`, change:
```js
const UI_VERSION = "1.12";
```
to:
```js
const UI_VERSION = "1.13";
```

- [ ] **Step 2: Start the offline server**

From the workspace root (the parent folder containing this engine clone and its
sibling space clones), run:
```bash
OFFLINE_PORT=8791 npm --prefix augur run offline
```
(pick a port unlikely to clash with any other local dev server you may already have
running). Wait for the "ready"/listening log line before continuing.

- [ ] **Step 3: Playwright mobile-viewport smoke pass**

Write a throwaway script (not committed — scratch verification only) to a scratch
directory outside this repo, e.g. `/tmp/tabbar-check.mjs`:

```js
import { chromium, devices } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ ...devices["iPhone 13"] });
await page.goto("http://localhost:8791/");
await page.waitForSelector(".gvtabbar");
await page.screenshot({ path: "/tmp/tabbar-01-home.png" });

// Header shows space branding, not "augur"
const centerText = await page.locator(".gvtop__center").innerText();
console.log("header center:", JSON.stringify(centerText));

// No hamburger anywhere
const burgerCount = await page.locator(".gvburger").count();
console.log("gvburger count (expect 0):", burgerCount);

// Tap into Design System — bar swaps, back chevron appears
await page.locator('.gvtabbar a[href="/tokens/"], .gvtabbar a[href$="/tokens/"]').first().click();
await page.waitForSelector('.gvtabbar a[href$="/base/"]');
await page.screenshot({ path: "/tmp/tabbar-02-ds.png" });
const backVisible = await page.locator(".gvtop__back").count();
console.log("back chevron count in DS (expect 1):", backVisible);

// Back returns to primary bar
await page.locator(".gvtop__back").click();
await page.waitForSelector('.gvtabbar a[href$="/playground/"], .gvtabbar .gvtab.is-blank');
console.log("returned to primary bar OK");

// Resize to desktop — bottom bar and mobile header disappear
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(300);
const tabbarVisible = await page.locator(".gvtabbar").isVisible().catch(() => false);
console.log("gvtabbar visible at 1280px (expect false):", tabbarVisible);

await browser.close();
console.log("DONE");
```

Run: `node /tmp/tabbar-check.mjs`

Expected output: header center text is the space's name (not `"augur"`), `gvburger count: 0`, back chevron count in DS `1`, "returned to primary bar OK", `gvtabbar visible at 1280px: false`, `DONE`. If any expectation fails, fix the relevant task's code before continuing — do not proceed to Step 4 with a failing check.

- [ ] **Step 4: Visual review of the screenshots**

Read both PNGs (`tabbar-01-home.png`, `tabbar-02-ds.png`) with the Read tool and visually confirm: the pill bar floats above the bottom edge (not flush), the active tab has a visible highlight, the header brand is centered with the search icon on the right, and nothing overlaps or clips.

- [ ] **Step 5: Manual pass for what Playwright can't easily assert**

With the offline server still running, using Chrome DevTools' device toolbar (iPhone 14 Pro, so the simulated safe-area-inset-bottom is non-zero) at `http://localhost:8791/`:
- Tap Pinned (pin something first via a card's star button if none are pinned) — sheet opens, lists it, tapping it navigates and closes the sheet.
- Tap Profile — sheet opens with identity, Settings (opens the existing settings modal), Sign out, version footer, and (if signed in as admin) Admin + Changelog.
- Tap the header search icon — input expands, typing filters visible cards.
- Confirm the bottom pill clears the simulated home-indicator safe area (no visual overlap).

- [ ] **Step 6: Commit**

```bash
git add build.js
git commit -m "Bump UI_VERSION to 1.13 for the mobile tab bar shell change"
```

---

### Task 10: Push and confirm the live deploy

**Files:** none (deploy-only task).

- [ ] **Step 1: Push to `main`**

```bash
git push origin main
```

This fires the engine's `deploy-trigger.yml`, which dispatches to every instance shell. An instance on `TRACK: main` picks up the new engine pin automatically, typically within a couple of minutes. An instance that pins a release track does NOT auto-deploy on an engine push; it needs its own `engine-bump.yml` run — do not trigger that without being asked, since each instance is somebody's live site.

- [ ] **Step 2: Confirm the live build picked up the change**

Run: `curl -s https://demo.augur.works/_build.json` and confirm `engine.sha` (or equivalent field — check the actual key names in the response) matches the commit just pushed. Poll every ~15s up to ~2 minutes if it hasn't updated yet — do not just wait blindly.

- [ ] **Step 3: Report the live URL to the user**

Tell the user: `https://demo.augur.works/` is live with the change, and to check it on an actual phone (not just DevTools) since that's the only way to verify `env(safe-area-inset-bottom)` and the backdrop-filter glass effect render as intended on real iOS Safari/Android Chrome.
