# What the engine expects of a prototype

A prototype is a folder of **self-contained static HTML/JS** under
`<opportunity>/prototypes/<name>/` with `index.html` as the entry. No build
step: it must work opened directly (`file://`). The contents of `prototypes/`
folders are published — `research.md`, `context.md`, anything else outside a
published folder stays internal by the build's whitelist. **`playground/` also
ships** (verbatim, to the public `/playground/`), so nothing private belongs
there either.

Beyond that, the engine reads a few things *from* your prototype. None are
required, but each one improves how the site presents and reviews it:

## `<meta name="description">` — the prototype's one-line description

The engine treats it as the prototype's agent-facing and human-facing blurb:
gallery cards, link previews (OG description), and the canvas insert-picker
catalog all carry it. Write one sentence stating what the prototype shows.
It lives in the artifact, so it updates in the same commit that changes the
prototype — keep it true.

## `<body data-gv-screen="…">` — the screen contract for SPAs

The comment overlay scopes each pin to the screen it was dropped on.
Multi-page prototypes need nothing (the URL distinguishes screens). A
prototype that **swaps screens without changing the URL** must publish its
visible state to `<body data-gv-screen>` (update it whenever the screen
changes) — otherwise every screen shows every comment, and pins appear to
float on the wrong UI.

## Titles and display names

The folder name is the URL segment (kebab-case, name it like a URL). The
site's display name for a prototype or opportunity can be renamed live from
the site chrome (stored server-side, in KV — not in your repo), so don't fight
a bad folder name after the fact; rename the display instead.

## Status chips

An optional dev-status chip per prototype comes from `prototype-status.json`
at the space root (see its `_comment` for the format; values are `in-progress`,
`dev-ready`, `reviewed`, `ignore`); statuses are also cycled by clicking the
chip on the live site (stored in KV, overlaying the committed baseline).

## Posters and link cards

A `preview.webp` (gallery card) and `og.jpg` (link share) in the prototype
folder are welcome but not required — without them the card falls back to a live
iframe and links get no image; maintainers shoot them with `scripts/shoot.mjs` /
`scripts/og.mjs`.

## Comments overlay assets

Any file the overlay must load from a public page has to be public too — if an
image inside your prototype 404s or renders as a login page when logged out,
check it lives inside the prototype folder (published) rather than outside
(internal).
