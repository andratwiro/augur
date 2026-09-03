# The UI skill — a workspace's design system

A workspace's design system lives in one directory: `skills/<prefix>-ui/`. The build
auto-detects it (the dir under `skills/` ending in `-ui` that carries
`<dirname>.css`, e.g. `skills/acme-ui/acme-ui.css` → prefix `acme`); a workspace can
override the detection with `space.json` `{ "designSystem": { "skill": "<dir>" } }`.
A design system is optional — plain self-contained HTML builds fine without one.

## Referencing it

Prototypes and library demos reference skill assets by the canonical relative
path — `../../../skills/<prefix>-ui/<file>` (any `../` depth) — never by absolute
URL. The build rewrites those references so they resolve everywhere the page can
be opened: on disk (`file://`) and at the site root. (The rewrite still handles a
`/<id>/` prefix, but no instance mounts a workspace there any more — that tier is
retired.) Each workspace ships its own copy of its skill, so
primitives → components → pages stay hardwired to one source per workspace and a
workspace can diverge its design system without touching another. Prototypes may
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

Declaring them is what makes the generated **Tokens** tab yours. That page groups
by what a value IS — a colour is a colour, a single length is a size, a stack
ending in a generic family is a font family, a colour with three or more offsets
is a shadow — so it works with no naming convention at all. The one convention it
does recognise is a type scale: `--<prefix>-type-<role>-size`, `-lh` and
`-weight` are paired into one live sample per role, ordered by the size each role
resolves to. `<role>` is whatever you call it. Without `cssPrefixes`, the graph
looks for the default prefixes and finds none of your tokens, and the tab is
empty — that is the same one line that costs you the layer badges above.

The build additionally generates `graph.js` (the composition graph) into the
shipped skill directory; that is derived output, not something to declare.

## registry.json — required once a skill exists

A workspace that carries a UI skill must also carry a `registry.json` at the WORKSPACE
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
lists the CSS family roots the overlay matches in the DOM. A workspace with no
skill needs no registry.

It ships with every publish, at `/registry.json`, and so does the skill's own
`skill.json` beside the assets it declares. Both are inputs the build needs to
compose the space again, and `augur clone` puts them back where the build reads
them — a clone without them is a tree that cannot be published. Gated like the
pages they describe; neither names anything the composition graph does not.

## Galleries

The tokens/primitives gallery tiers derive from the conventional file split
(`<prefix>-tokens.css`, `<prefix>-primitives.css`, `gallery.html`). A skill
without those files still builds, ships and serves fine — it just gets no
derived primitives gallery. The `base/ components/ patterns/ pages/` tiers at
the workspace root are independent of this and work with any skill.

Those four tiers are **the canon** — the entries meant to be pulled by name, and
the reason "build it the way `invoice-detail` is built" resolves for an agent
that has never seen the workspace. What a name in them may be, and how a screen
built during ordinary work gets promoted into one, is [canon.md](./canon.md).
