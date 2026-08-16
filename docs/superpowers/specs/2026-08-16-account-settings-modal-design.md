# Account settings modal

**Status:** design, approved 2026-08-16
**Touches:** `build.js` only
**Reference:** Figma's account menu → Settings modal → photo crop dialog

## Problem

Self-serve profile photos landed as two inline items in the rail's profile dropdown:

```
build.js:2613  <button data-prof-photo>      Add photo / Change photo
build.js:2614  <button data-prof-photo-rm>   Remove photo        (sub-item)
build.js:2615  <input type=file hidden>
```

That works, but it puts account editing in a place that cannot grow. The next things
a person will want to change about themselves — their email, their password — are not
menu items. They need labelled fields, a save affordance, and somewhere to put a
validation error. A dropdown has room for none of that, so each addition would either
be crammed in beside "Sign out" or trigger a redesign.

The photo flow is also blind. Picking a file applies a silent centre crop
(`build.js:3978–3985`) and the first the person sees of the result is their own face
already published to every comment they have ever written. A phone photo where the
subject is off-centre crops badly and there is no way to fix it beyond picking a
different file.

## Goals

- Account settings live in a modal with a tab bar, so email and password later slot in
  without moving anything that exists.
- The person sees and controls the crop before it is saved: zoom and pan over a
  circular mask, then an explicit save.
- The photo produced is byte-identical in format to today's, so the worker is untouched.
- The profile dropdown gets shorter, not longer.
- Nothing regresses for a signed-out visitor or an open (no-identity) build, where the
  chip and everything under it stay hidden.

## Non-goals

- Changing name, email, password or role. The rows render read-only; wiring them is
  later work with its own spec.
- Any change to `src/_worker.js`, `/__me`, `/__me/avatar` or the roster overlay.
- A second tab. `Account` ships alone; the tablist exists so a second one is additive.
- Replacing the `/admin/` people table. Personal settings and instance administration
  stay separate entries in the menu and separate surfaces.

## Design

### 1. The menu loses two items and gains one

`profileChip()` (`build.js:2600`) drops the two photo buttons and the hidden file input.
In their place, one item above the admin link:

```js
<button type="button" class="gvprof__item" role="menuitem" data-prof-settings>${IC_SLIDERS}<span>Settings</span></button>
```

`IC_SLIDERS` is new — Lucide `sliders-vertical`, matching the reference. `IC_GEAR` stays
on `Admin settings`, so the two entries read as different kinds of thing rather than two
spellings of one.

The menu becomes: identity block · Settings · Admin settings (admins only) · Sign out ·
version footer.

`IC_CAMERA`, `IC_TRASH` and `.gvprof__item--sub` each have exactly one use site today.
All three go dead with this change and are removed.

### 2. `settingsModal()` — a body-level dialog beside the help drawer

`appChrome` (`build.js:2843`) currently ends:

```js
return `${top}${sideRail(active)}<div class="gvscrim" data-side-scrim></div>${helpDrawer()}`;
```

`${settingsModal()}` appends to that list. Rendering at body level rather than inside
`<aside class="gvside">` keeps the dialog out of the rail's stacking and overflow
context — the same reason the help drawer sits there.

The modal copies the help drawer's structure, which is already proven in this codebase
(`build.js:2732`, CSS at `:2317`):

- `.gvset` — `position: fixed; inset: 0`, `[hidden]` by default, `.is-open` drives the
  transition
- `.gvset__scrim` — dismisses on click
- `.gvset__panel` — `role="dialog" aria-modal="true" aria-label="Settings"`, centred,
  max-width ~720px, max-height 80vh with the body scrolling inside
- header: `role="tablist"` on the left, `.gvset__x` with `IC_CLOSE` on the right
- Escape dismisses; focus moves into the panel on open and returns to `[data-prof-toggle]`
  on close

z-index sits just above the help drawer's `2147483200`: `.gvset` at `2147483210`.

One tab renders now:

```js
<button type="button" class="gvset__tab" data-set-tab="account" role="tab" aria-selected="true">Account</button>
```

A single tab reads as deliberate because the selected pill is styled (grey fill, dark
label) exactly as in the reference. Adding `Notifications` later is one `<button role=tab>`
plus one `<section role=tabpanel>` and no relayout.

### 3. The Account panel

Two columns, per the reference:

```
┌──────────────────────────────────────────┐
│ [Account]                            ✕   │
├──────────────────────────────────────────┤
│  ╭─────╮      Name                       │
│  │     │      <name>                     │
│  ╰─────╯                                 │
│   Edit        Email                      │
│               <email>                    │
│                                          │
│               Role                       │
│               Admin | User               │
└──────────────────────────────────────────┘
```

- **left column** — a 128px circle carrying `data-prof-av`, and an `Edit` button beneath it
- **right column** — three label/value rows separated by hairlines. Labels are headings,
  values are plain text. No "Change" links: nothing but the photo is editable yet, and a
  link that opens nothing is worse than its absence.

Below 640px the columns stack and the avatar centres.

**The values fill themselves.** `PROFILE_JS`'s `paint()` (`build.js:3930`) already writes
every `[data-prof-av]`, `[data-prof-name]` and `[data-prof-email]` it can find — but it
scopes those queries to `box` (`[data-prof]`), and the modal is outside it. Changing
those three queries from `box` to `document` is the whole integration: the modal's avatar,
name and email fill for free, photo or initials-on-colour, from the one `/__me` fetch that
already happens. `box.hidden` and the admin-link reveal stay `box`-scoped.

Only `Role` is a new hook (`data-set-role`), because the chip never showed it. It renders
`Admin` or `User` from `u.admin`.

### 4. The crop dialog

`Edit` opens a hidden `<input type="file" accept="image/*">`. On pick, the file is decoded
by the existing `load()` helper (`build.js:3987`), which keeps
`createImageBitmap(f, {imageOrientation: 'from-image'})` — that is what stops a portrait
phone photo arriving sideways, and it must survive the move. Then `.gvcrop` opens above
the settings panel (z-index `2147483220`).

```
┌────────────────────────────┐
│                        ✕   │
│      ╭──────────╮          │
│      │  image   │  ← drag  │
│      ╰──────────╯          │
│   −  ─────○───────  +      │
│                            │
│        [ Save image ]      │
└────────────────────────────┘
```

State is three numbers over the decoded bitmap:

- `scale` — `1` means the image's **short side exactly fills the circle** (a cover fit,
  the same framing today's silent crop produces). Range `1 → 3`, driven by an
  `<input type="range">` between the `−` and `+` buttons, which step it by `0.1`.
- `ox`, `oy` — pan offset in preview pixels, set by pointer drag on the canvas.

After every change, `ox`/`oy` are clamped so the drawn image still covers the circle in
both axes — the mask can never show a gap. Redraw is scheduled on `requestAnimationFrame`,
so a drag does at most one paint per frame.

The preview is a `<canvas>` (~320px) under a CSS circular mask, so what is drawn and what
is saved are the same transform at two resolutions.

**Save image** renders the region currently inside the circle to a 192×192 canvas —
white fill first, then `drawImage` — and calls `toDataURL('image/jpeg', 0.82)`.

Those constants are today's (`SIZE = 192`, quality `0.82`, white fill under transparency,
`build.js:3960–3985`) and they do not change. The POST body, the `/__me/avatar` contract
and the content-hashed URL the worker mints back are all unchanged, which is why
`src/_worker.js` is not touched and every worker test stays green.

`✕` and Escape cancel without saving. Escape closes the crop dialog first and the settings
modal second, never both at once.

On a successful save the response's `avatar` URL is applied and the chip, the modal circle
and any face on the page all repaint together (see §6).

### 5. Removing a photo

`DELETE /__me/avatar` and its tests stay exactly as they are. Nothing in the interface
calls it — the reference has no remove affordance and neither will this.

The handler gets one comment line saying the UI dropped it deliberately, so the next
reader does not remove a live, tested endpoint as dead code.

### 6. Where the code lives

`build.js` is ~6100 lines and `PROFILE_JS` is ~120 of them. The modal and the crop dialog
are roughly 300 more and are a distinct concern, so they get their own units rather than
growing an existing one:

- `SETTINGS_CSS` — appended to `NAV_CSS`, beside the help drawer's block
- `SETTINGS_JS` — injected at the two sites that already inject `PROFILE_JS`:
  `injectNav` (`build.js:3103`) and the shell page (`:4739`)

`PROFILE_JS` stays the single owner of *who is signed in and what they look like*.
Two one-line hooks connect the units, and neither reaches into the other's DOM:

- `PROFILE_JS`, at the end of `paint(u)`:
  `document.dispatchEvent(new CustomEvent('gv:me', {detail: u}))`
- `PROFILE_JS`, once at setup: listen for `gv:avatar`, set `ME.avatar` from the detail and
  re-`paint(ME)`

`SETTINGS_JS` listens for `gv:me` (to know the role, and to open only for a real user) and
dispatches `gv:avatar` after a successful POST. No globals, no second `/__me` fetch, and
no dependency on script order — `paint` runs from an async `fetch`, always after both
scripts have evaluated.

### Failure handling

- **Undecodable file** — the crop dialog does not open; an inline message appears under
  `Edit` ("Could not read that image"). Same failure the current `load().catch` handles.
- **Failed POST** — the crop dialog stays open with the framing intact and shows
  "Could not save photo" beside the save button, so the person can retry without
  re-picking and re-framing.
- **In flight** — `Save image` takes `aria-busy="true"`. The existing dim-and-inert rule
  (`build.js:2097`) is scoped to `.gvprof__item`, so `SETTINGS_CSS` carries its own copy
  for the modal's buttons rather than widening a rail selector to reach across the page.
- **No user** — `[data-prof]` is hidden for signed-out and open builds, so the only
  opener is unreachable. `SETTINGS_JS` additionally refuses to open before `gv:me`.

## Testing

The worker contract does not move, so `npm test` passes unchanged and that is itself the
regression check: if a worker test breaks, the crop step changed something it should not
have.

There are no DOM tests in this repo (`test/*.test.mjs` are all worker- and node-side), so
the interface is verified by driving it:

`npm run build && npm run dev`, sign in, then:

1. Open the menu — `Settings` is there, the two photo items are gone.
2. Settings → Account shows the current photo (or initials), name, email, role.
3. Edit → pick a **portrait phone photo with EXIF orientation** → the preview is upright,
   not sideways.
4. Zoom to max and drag hard in each direction — the circle never shows a gap.
5. Save → the modal circle, the rail chip and a comment face by that person all show the
   new crop. Reload — it survives.
6. Pick the **same file twice in a row** — the second pick still opens the crop dialog
   (`file.value = ''` on change, as today).
7. Pick a **PNG with transparency** — the saved photo is white behind it, not black.
8. Escape with the crop open closes the crop only; Escape again closes Settings.
9. Sign out — the chip and everything under it are hidden; no console error from
   `SETTINGS_JS`.
10. Narrow the window below 640px — the columns stack, nothing overflows.
