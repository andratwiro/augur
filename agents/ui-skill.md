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
be opened: on disk (`file://`) and at the site root. (The rewrite still handles a
`/<id>/` prefix, but no instance mounts a space there any more — that tier is
retired.) Each space ships its own copy of its skill, so
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

Without a `skill.json`, a fixed default inventory of `<prefix>-*` names applies
(see `SHARED_ASSETS` in `build.js`). Skills should declare.

`skill.json` also names the CSS vocabulary the composition graph parses:

```json
{ "assets": ["acme-tokens.css", "acme-ui.css"], "cssPrefixes": ["acme"] }
```

`cssPrefixes` lists the class and token prefixes the stylesheets use (classes
`.acme-*`, tokens `--acme-*`). The graph reads tokens from
`<prefix>-tokens.css` and families from the canonical layer files, and the
review overlay's layer drilldown (Shift+C, then the arrow keys) badges exactly
what the graph knows: components, then base atoms, then token usage down to
spacing. Skills with no manifest get a fixed default prefix pair.

The build additionally generates `graph.js` (the composition graph) into the
shipped skill directory; that is derived output, not something to declare.

## registry.json — required once a skill exists

A space that carries a UI skill must also carry a `registry.json` at the SPACE
root: the overlay catalog naming the design system's families, so the comment
overlay and gallery cards can label components. The build fails loudly without
it (no silent unlabeled overlay). Shape:

```json
{ "items": [
  { "name": "card", "type": "component", "classes": ["acme-card"],
    "label": "Card", "description": "One line on what it is." }
] }
```

`type` is `primitive` (base tier), `component`, `pattern` or `page`; `classes`
lists the CSS family roots the overlay matches in the DOM. A space with no
skill needs no registry.

## Galleries

The tokens/primitives gallery tiers derive from the conventional file split
(`<prefix>-tokens.css`, `<prefix>-primitives.css`, `gallery.html`). A skill
without those files still builds, ships and serves fine — it just gets no
derived primitives gallery. The `base/ components/ patterns/ pages/` tiers at
the space root are independent of this and work with any skill.
