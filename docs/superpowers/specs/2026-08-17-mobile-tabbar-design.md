# Mobile bottom tab bar

**Status:** design, approved 2026-08-17
**Touches:** `build.js` only (mobile chrome, `@media (max-width: 860px)`)
**Reference:** iOS Files app bottom tab bar / iOS 26 "Liquid Glass" toolbar; Framework7's
current iOS toolbar implementation (`toolbar.less`, `toolbar-ios.less`,
`.ios-glass()` mixin) is the closest real, open-source match and is cited throughout
for exact values.

## Problem

Below 860px the rail becomes an off-canvas drawer (`build.js:2303-2309`) behind a
hamburger in `.gvtop` (`build.js:3032-3035`). That's a desktop pattern ported to
mobile rather than one designed for it: every navigation action is two taps (open
drawer, tap destination) and the drawer eats the full viewport height. Native iOS
apps in this space (Files, N26, Immich) use a persistent bottom tab bar instead —
zero taps to switch section, always visible, no scrim.

Separately, `.gvtop__brand` (`build.js:3034`) hardcodes the engine's own mark and the
literal text `"augur"`. That's harmless on desktop, where `spaceSwitcher()`
(`build.js:2751`) shows the real space identity further down the rail — but it means
the one piece of branding every mobile visitor sees first is wrong on every instance
except the reference one.

## Goals

- Below 860px, primary navigation is a fixed bottom tab bar: Projects, Playground,
  Design system, Pinned, Profile — reachable in one tap, no drawer, no scrim.
- The mobile header shows the active space's own icon + name (data `spaceSwitcher()`
  already has), not hardcoded engine branding — correct on every instance by
  construction, not by per-instance patching.
- Design System and Admin keep today's "one nav column at a time" behavior, just
  expressed through the bottom bar instead of the sidebar.
- Nothing on desktop (>860px) changes. `sideRail()`, `libraryRail()`, `adminRail()`
  and their CSS are untouched above the breakpoint.
- Visual language matches `.gvtop`'s existing translucency
  (`backdrop-filter: blur(14px) saturate(180%)`) rather than inventing a new one.

## Non-goals

- Any change to desktop nav, `sideRail()`'s markup, or above-860px CSS.
- Changing what the five/three destinations *are* — same routes, same icons, same
  `NAV_STATE`/`LIB_KEYS` data this file already computes.
- A native app / PWA install prompt. This is still a responsive website.
- Reworking `settingsModal()` (the Account tab dialog) — the Profile sheet opens the
  existing profile menu items unchanged; the settings modal itself is out of scope.
- Redesigning the Pinned data flow (`PINS_JS`, `data-pinned-list`) — the sheet reuses
  the existing pinned markup/empty-state, just relocated.

## Design

### 1. Breakpoint and removal

Everything below is gated inside the existing `@media (max-width: 860px)` block
(`build.js:2303`). Above it, `body { padding-left: var(--rail) }` and the permanent
`sideRail()` keep working exactly as today — this spec adds a parallel mobile-only
tree, it does not modify the desktop one.

Removed on mobile: `.gvburger` and its `data-side-toggle` handling in `chromeScript()`
(`build.js:3093` region), the `.gvside{transform:translateX(-100%)}` off-canvas
drawer behavior, and `.gvscrim`. `sideRail()`/`libraryRail()`/`adminRail()` as
*functions* are untouched (desktop still calls them) — mobile simply stops showing
`.gvside`/`.gvscrim` via CSS (`display: none` inside the 860px query) rather than
deleting the DOM they render, so no JS needs to know which mode it's in.

### 2. Header (`.gvtop`, mobile only)

Three-slot flex row, same glass treatment it has today
(`background: rgba(255,255,255,0.82); backdrop-filter: blur(14px) saturate(180%)`,
`build.js:2022`):

```
top level:        [        ]   [icon] Fulla        [ 🔍 ]
prototype page:    [ ‹ ]        Roommate Budget      [ 🔍 ]
DS / Admin:         [ ‹ ]        Design system        [ 🔍 ]
```

- **Left**: empty (an invisible spacer the same width as the search button, so the
  center slot stays visually centered) at top level. A `‹` back button appears
  whenever `active` is a prototype/opportunity page, or one of `LIB_KEYS`, or
  `"admin"` — i.e. every case that currently swaps the rail to something other than
  `sideRail()`'s primary view. Tapping it navigates to `/`.
- **Center**: `spaceSwitcher()`'s icon (`/space-icon.png`) + `active.name`
  (`build.js:2766-2771`) at top level — replacing `GV_MARK` + the literal `"augur"`
  text entirely on mobile. On a prototype page: the prototype's title. Inside DS:
  `"Design system"`. Inside Admin: `"Workspace settings"` (matches `adminRail()`'s
  own back-link label, `build.js:3080`).
- **Right**: a search icon-button. Tap expands `railSearch()`'s existing input
  (`SEARCH_ICON`, `data-filter`, `build.js:2710-2715`) inline in the header, replacing
  the center slot for the duration of the search (same collapse/expand a "🔍" button
  triggers in comparable native apps — no new search logic, just a new mount point
  for the existing filter wiring `chromeScript()` already does).

This reuses `NAV_STATE.spaces`/`activeSpace`, which `appChrome()` already has in scope
via `sideRail()`/`spaceSwitcher()` — no new data plumbing.

### 3. Bottom tab bar (new)

A floating glass pill, not full-width — inset from the screen edges, fixed above
`env(safe-area-inset-bottom)`. This mirrors Framework7's current iOS tabbar
(`toolbar-ios.less`): `border-radius: 32px`, `.ios-glass()` →
`backdrop-filter: saturate(180%) blur(16px)` + `box-shadow`, height `80px`
(`--f7-tabbar-icons-height`), icon size `28px`, label `12px`/weight `500`. Active tab
gets a highlight chip behind it (Framework7's `.tab-link-highlight`:
`background: rgba(0,0,0,0.1)` light / `rgba(255,255,255,0.15)` dark, inset `4px`,
`border-radius: inherit`) rather than just a color change — matches the pill
aesthetic instead of looking like a plain link state.

**Primary bar** (route not in `LIB_KEYS`, not `"admin"`) — five slots, same icons
`sideRail()` already imports:

| Slot | Label | Route | Icon | Behavior |
|---|---|---|---|---|
| 1 | Projects | `/` | `IC_HOME` | navigates, `aria-current` on match |
| 2 | Playground | `/playground/` | `IC_PLAY` | navigates; **blank spacer** if `!NAV_STATE.hasPlayground` (same condition as `build.js:2788`) |
| 3 | Design system | `/tokens/` | `IC_LIBRARY` | navigates to `/tokens/`, which enters the DS sub-bar (below) |
| 4 | Pinned | — | ★ (matches `data-pinned-list` rows' star glyph) | opens a bottom sheet, does not navigate; see §4 |
| 5 | Profile | — | avatar (`data-prof-av`) | opens a sheet, does not navigate; hidden until identity resolves (see §5) |

**DS sub-bar** (`active` ∈ `LIB_KEYS`) replaces slots 1-5 with `libraryRail()`'s own
five destinations, unchanged order/icons (`build.js:3060-3064`):

| Slot | Label | Route | Icon |
|---|---|---|---|
| 1 | Tokens | `/tokens/` | `IC_TOKEN` |
| 2 | Base | `/base/` | `IC_PRIM` |
| 3 | Components | `/components/` | `IC_COMP` |
| 4 | Patterns | `/patterns/` | `IC_PATTERN` |
| 5 | Pages | `/pages/` | `IC_PAGE` |

Five destinations, five slots — no blanks. The header's back chevron (§2) is the only
way out, mirroring `libraryRail()`'s own `.gvadmin__back` link today
(`build.js:3054-3057`) — there is no "6th" way back baked into the bar itself, same as
desktop.

**Admin sub-bar** (`active === "admin"`) replaces slots 1-5 with `adminRail()`'s three
tabs (`build.js:3084-3086`): People, Content, Settings. `adminRail()`'s `tab()` helper
renders these as text-only buttons today (no icon set to reuse), so the sub-bar
renders them label-only, same `flex: 1` slot width as the icon+label tabs. Slots 4-5
render as blank spacers. Same back-chevron-only exit as DS.

Swapping the bar's contents is the same `active === "admin" ? … : LIB_KEYS.includes(active) ? … : …`
branch `appChrome()` already computes for the rail (`build.js:3040-3042`) — the bottom
bar reads the same branch, it does not introduce a second source of truth for "which
nav is showing."

### 4. Pinned — bottom sheet, not a route

Tapping slot 4 (primary bar only — DS/Admin sub-bars have no Pinned slot, matching
today where `libraryRail()`/`adminRail()` don't show Pinned either) opens a sheet
sliding up from behind the tab bar:

```
┌──────────────────────────────┐
│  Pinned                  ✕   │
├──────────────────────────────┤
│ ★ Fava beans                 │
│ ★ Roommate Budget             │
│ ★ Scenic Pacific Trail        │
├──────────────────────────────┤
│ [Projects][Playground][DS]…  │
└──────────────────────────────┘
```

Content is `sideRail()`'s existing `data-pinned-list` / `data-pinned-empty` markup
(`build.js:2804-2806`), relocated into the sheet rather than reimplemented — `PINS_JS`
already fills/toggles it and needs no changes.

If there are zero pinned items (`data-pinned-empty` visible), the Pinned tab renders
dimmed/inert instead of opening an empty sheet — checked client-side against the same
element `PINS_JS` already toggles, so the tab bar's script watches one flag, it
doesn't duplicate the empty-state logic.

Dismiss: tap outside the sheet, tap ✕, or Escape (parallels `helpDrawer()`'s existing
scrim/Escape handling, `build.js:2320-2323`, `chromeScript()`).

### 5. Profile — bottom sheet reusing `profileChip()`'s menu

Tapping slot 5 opens a sheet containing exactly what `profileChip()`'s dropdown
already has (`build.js:2721-2742`): the identity block (avatar/name/email), a
Settings item (`data-prof-settings`, opens the existing `settingsModal()` — unchanged,
out of scope per Non-goals), Sign out, and the version footer — **plus** the two items
displaced from the sidebar's foot now that the drawer is gone:

- **Admin** (`build.js:2793-2795`) — same `data-space-admin` hidden-until-confirmed
  link, same href/data-space-id wiring. Visible only when `SPACE_JS` reveals
  `html.gv-space-admin`, exactly as today.
- **Changelog** (`build.js:2828`) — same `/changelog/` link with the `v${UI_VERSION}`
  badge.

This is additive markup inside the existing `.gvprof__menu`/sheet, not a new identity
source — `PROFILE_JS`'s `paint()` keeps filling avatar/name/email exactly as it does
for desktop's chip, because it's the same DOM structure in a sheet instead of a
dropdown.

Pre-auth (signed-out / open build): `profileChip()` renders `hidden` today
(`build.js:2722`) and PROFILE_JS reveals it once identity resolves. Slot 5 mirrors
that — the Profile tab itself stays hidden/inert until identity resolves, same
condition, no new gate to keep in sync.

### 6. Where the code lives

Following the account-settings-modal precedent (same file, new named units rather
than growing an existing one):

- `TABBAR_CSS` — appended to `NAV_CSS`, the pill/glass/highlight styles from §3,
  the header three-slot layout from §2, all scoped inside the existing
  `@media (max-width: 860px)` block plus the new safe-area rule.
- `tabBar(active)` — new function beside `sideRail()`, returns the bottom bar's markup
  for a given `active` key using the same three-way branch `appChrome()` already
  computes, called once per page exactly like `sideRail(active)` is now.
- `appChrome()` (`build.js:3031-3044`) gains `${tabBar(active)}` to its returned
  string; the mobile `.gvtop` markup (§2) replaces the current hardcoded brand row.
- `TABBAR_JS` — sheet open/close (Pinned, Profile), search expand/collapse, injected
  at the same two sites `chromeScript()`/`PROFILE_JS` already are
  (`build.js:3103`-ish and the shell page).

`UI_VERSION` (`build.js:388`, currently `"1.12"`) bumps for this change — it's shell
chrome, matching the convention the account-settings-modal spec followed.

### Failure handling

- **`space-icon.png` missing/404** — same as today's desktop failure mode
  (`spaceSwitcher()` doesn't handle it specially either); no new handling added here,
  consistent with existing behavior.
- **JS not yet loaded** (sheets/search rely on `TABBAR_JS`) — the bar's route links
  (Projects/Playground/DS/sub-pages) are plain `<a href>` and work with zero JS;
  only Pinned/Profile/search require the script, same trade-off `railSearch()`
  already makes today.
- **No `NAV_STATE.spaces`** (`spaceSwitcher()` returns `""` when `!spaces.length`,
  `build.js:2753`) — header center falls back to `GV_MARK` + `"augur"` (today's
  literal), since there's no space identity to show. This only fires for the
  engine-only/shell build case (`GV_ENGINE_ONLY=1`), which has no space to name.

## Testing

No DOM test suite in this repo (`npm test` is worker/node-only); verified by driving
it, same as the account-settings-modal spec:

`npm run offline` (or `OFFLINE_PORT=8791 npm --prefix augur run offline` from the
workspace root if another local dev server is already occupying the default port),
then in a real mobile viewport (Chrome DevTools device toolbar or an actual phone on
the tailnet):

1. Load `/` under 860px — bottom bar shows Projects/Playground/DS/Pinned/Profile,
   Projects active; header shows the space's icon + name centered, no hamburger
   anywhere.
2. Confirm on a second space (e.g. delta vs. fulla, or `OFFLINE_PORT` against both)
   that the header shows that space's own name/icon, not "augur".
3. Tap into a prototype — header swaps to back-chevron + prototype title; bottom bar
   unchanged, Projects still marked active.
4. Tap Design system — bottom bar swaps to Tokens/Base/Components/Patterns/Pages,
   header shows back-chevron + "Design system"; tap each sub-tab, confirm routes and
   active state; tap back — returns to primary bar at `/`.
5. As an admin, open Profile sheet → Admin → confirm bottom bar swaps to
   People/Content/Settings (2 blank slots) with back-chevron + "Workspace settings";
   back returns to primary bar.
6. With ≥1 pinned prototype: tap Pinned → sheet lists them, tap one → navigates and
   sheet closes. With 0 pinned: tab renders dimmed, tapping does nothing.
7. Tap Profile → sheet shows identity, Settings (opens the existing settings modal),
   Sign out, version, and — if admin — the Admin link and Changelog link.
8. Tap the header search icon → input expands inline, typing filters the current
   page's `[data-fitem]` cards exactly as the desktop rail's search does today.
9. Resize past 860px mid-session — bottom bar and mobile header disappear, permanent
   sidebar reappears, no leftover fixed-position elements or open sheets.
10. Signed-out / open build — Profile tab hidden/inert, everything else unchanged.
11. A device with a bottom safe-area inset (iPhone with a home indicator, via
    DevTools device frame or a real device) — bottom bar clears the home indicator,
    doesn't sit under it.
