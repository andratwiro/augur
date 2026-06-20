# GVWidgets model — one data object, any surface

The whole point: **a single plain data object is the source of truth.** Each surface
(project front office, homepage) is a pure function of that object — hand it the object,
get HTML back. **No editor required.** When you *do* use the content builder, it edits a
canvas that snapshots back into this exact same object, so the editor and a hand-authored
object are interchangeable.

```
            ┌─────────────────────┐
            │   MODEL OBJECT      │   ← you write it (or an editor edits it)
            └─────────────────────┘
          ╱           │            ╲
  project.mount   homepage.mount    content builder (OPTIONAL)
        ↓               ↓                    ↓
   Project FO       Homepage          edits → buildModel() → same object
```

One engine walks the blocks; only the **widget set** differs per surface. Shared widgets
(text, accordion, image, button, columns…) run the same code on both.

## The shape

```js
const model = {
  blocks: [
    { type: 'widget-name', data: { /* fields for that widget */ } },
    …
  ]
};
```

`data` is optional per block — omit it and the widget renders its sample defaults.

## Render a page (no editor)

```html
<div id="page"></div>
<script src="../../skills/govocal-ui/govocal-widgets.js"></script>
<script>
  GVWidgets.config({ img: 'img/' });                 // where this prototype's images live
  GVWidgets.project.mount(document.getElementById('page'), projectModel);   // resident project page
  // or:
  GVWidgets.homepage.mount(document.getElementById('page'), homepageModel); // city homepage
</script>
```

- Multiple pages → call `mount` once per element with its own object.
- `homepage.mount(el, {})` with no `blocks` renders the **default homepage** (every section, sample content) — a zero-config starting point.
- `GVWidgets.project.render(model)` / `GVWidgets.homepage.render(model)` return the HTML string instead of mounting, if you'd rather place it yourself.

## Project page blocks (`GVWidgets.project`)

`hero` → full-bleed banner · `title` → page heading · everything else flows in the reading column.

| type | data fields |
|---|---|
| `hero` | `src` |
| `title` | `text` |
| `text` | `html` (rich text) |
| `button` | `label`, `href`, `style` (`primary`\|`secondary`\|`link`) |
| `image` | `src`, `alt` |
| `accordion` | `title`, `body` |
| `file-attachment` | `name`, `meta` |
| `image-text-cards` | `caps` (array of captions) |
| `two-column` / `three-column` | `cols` (array of block-arrays) |
| `participation-box` | `pbox` (state object) |
| `extra-surveys` | `survey` (state object) |
| `timeline` | — (uses the project's phases) |
| `events` | `events` (array), `n`, `cardsOnly` |

## Homepage blocks (`GVWidgets.homepage`)

Data-driven so far (the rest render sample content; same recipe to extend):

| type | data fields |
|---|---|
| `homepage-banner` | `title`, `lead`, `ctaLabel`, `ctaHref`, `img`, `count`, `participants` |
| `spotlight` | `title`, `lead`, `ctaLabel`, `ctaHref`, `img`, `alt`, `count` |
| `events` | `title`, `events` (array) |
| `call-to-action` | `title`, `lead`, `ctaLabel`, `ctaHref` |
| `text` | `html` |

Other homepage sections (`areas`, `selection`, `published`, `community-monitor-cta`,
`projects`, `followed-items`, `image`, `button`, `accordion`, columns, `iframe`,
`video-embed`, `white-space`) render their sample content today; to data-drive one, give
its `make(d)` the same `d.field != null ? d.field : default` treatment as the widgets above.

## Example

```js
const homepageModel = {
  blocks: [
    { type: 'homepage-banner', data: { title: 'Shape the future of Rivertown', ctaLabel: 'Get involved' } },
    { type: 'spotlight',       data: { title: 'Riverside Greenway', count: '512' } },
    { type: 'events' },                                   // sample events
    { type: 'call-to-action',  data: { title: 'Got an idea?', ctaLabel: 'Propose it' } }
  ]
};
GVWidgets.homepage.mount(document.getElementById('page'), homepageModel);
```

> Prototypes are self-contained: copy `govocal-widgets.js` (and the CSS it needs) into the
> prototype folder. Library pages reference the canonical file via `../../skills/govocal-ui/`.
