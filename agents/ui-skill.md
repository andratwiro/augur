# The UI skill — a space's design system

A space's design system lives in one directory: `skills/<prefix>-ui/`. The build
auto-detects it (the dir under `skills/` ending in `-ui` that carries
`<dirname>.css`, e.g. `skills/acme-ui/acme-ui.css` → prefix `acme`); a space can
override the detection with `space.json` `{ "designSystem": { "skill": "<dir>" } }`.
A design system is optional — plain self-contained HTML builds fine without one.

## Referencing it

Prototypes and library demos reference skill assets by the canonical relative
path — `../../../skills/<prefix>-ui/<file>` (any `../` depth) — never by absolute
URL. The build rewrites those references so they resolve everywhere the page can
be opened: on disk (`file://`), as the default space at the site root, and
mounted under `/<id>/`. Each space ships its own copy of its skill, so
primitives → components → pages stay hardwired to one source per space and a
space can diverge its design system without touching another. Prototypes may
instead carry a byte-identical copy of an asset — they are the one tier allowed
to fork.

## What ships — `skill.json`

The skill declares its own published assets in a `skill.json` at the skill root:

```json
{ "assets": ["acme-tokens.css", "acme-ui.css", "vendor"] }
```

- Entries are file or directory names **relative to the skill root**; a
  directory ships wholesale (fonts, vendored bundles, image sets).
- The inventory belongs to the workspace, not the engine — forked or third-party
  design systems ship whatever they actually consist of.
- Markdown at the skill root (`SKILL.md`, `components.md` — internal notes) and
  `skill.json` itself never ship. Paths may not escape the skill directory.

Without a `skill.json`, a legacy fixed inventory of `<prefix>-*` names applies
(see `SHARED_ASSETS` in `build.js`) — kept for skills that predate the manifest.
New skills should always declare.

The build additionally generates `graph.js` (the composition graph) into the
shipped skill directory; that is derived output, not something to declare.

## Galleries

The tokens/primitives gallery tiers derive from the conventional file split
(`<prefix>-tokens.css`, `<prefix>-primitives.css`, `gallery.html`). A skill
without those files still builds, ships and serves fine — it just gets no
derived primitives gallery. The `base/ components/ patterns/ pages/` tiers at
the space root are independent of this and work with any skill.
