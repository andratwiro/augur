# Link previews — what an instance looks like when its URL is pasted somewhere

Paste an instance's URL into Notion, Slack or iMessage and the unfurl bot fetches it
anonymously, so what it sees is the login gate. The gate's `<head>` is therefore the
instance's entire link preview, and it is branded per instance:

- **Title:** `<Workspace> · Augur` (the default space's `name`), plain `Augur` on an
  engine-only build.
- **Description:** the default space's `space.json "description"` if set, otherwise the
  engine tagline (the public repo's summary line): *"Real, clickable prototypes and the
  design system they are built from, on one site with login, comments and live boards
  on top."*
- **Icon and image:** `/space-icon.png` — the same public, KV-overridable icon
  `brandMark()` wears on the gate. It is both the favicon (`rel="icon"`) and the
  `og:image` (absolute URL, `twitter:card summary`), so an icon changed from the admin
  panel updates the unfurl with no deploy. No default space ⇒ both tags are omitted.
- **og:url:** the requested origin + path, query dropped. `og:site_name` is always
  `Augur`.

## Where it lives

- `previewHead(requestUrl)` in `src/_worker.js` composes the block; `loginPage()` uses
  it in full, `notFoundPage()` takes only the favicon link (bots never see the 404 —
  signed-out visitors get the gate for unknown URLs).
- The workspace name/description reach the worker on the space entry it already reads:
  `build.js` carries `space.json`'s `description` into `NAV_STATE.spaces`, which rides
  `routing.json` (assets mode) and each published manifest's `space` object (bundle
  mode, what live instances serve from). The publish sanitizer spreads declared fields,
  so no store migration is needed — the field appears with each space's next publish or
  the shell's next re-bake.
- `robots: noindex` stays on the gate: unfurl bots read meta regardless; search engines
  stay out.

## What this deliberately exposes

The workspace name, icon and one description line are readable by anyone who fetches
the URL — the same information the gate already shows a human visitor, now machine
readable and cached by unfurlers. Decided 2026-08-19 for all instances. An instance
that wants different copy sets `description` in its default space's `space.json`; the
name and icon it already controls.

Per-prototype previews (public URLs) are separate and predate this: `build.js` injects
og tags into content pages and `scripts/og.mjs` composes their 1200×630 cards.

Tests: `test/link-preview.test.mjs`.
