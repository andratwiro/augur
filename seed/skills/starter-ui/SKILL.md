# The starter design system

Three files, no build step, no dependencies:

- `starter-tokens.css` — every colour, size, space and radius as a CSS custom
  property. This is the file to edit first: change a token and every screen in
  the workspace moves with it.
- `starter-ui.css` — the components, all classed `.s-*`, all drinking from the
  tokens. Nothing here hard-codes a colour.
- `starter-ui.js` — one behaviour: a button with `data-s-copy="<selector>"`
  copies that element's text.

## Using it in a prototype

Reference the canonical path. The build rewrites it so the page works both on
disk and on the site:

```html
<link rel="stylesheet" href="../../../skills/starter-ui/starter-tokens.css">
<link rel="stylesheet" href="../../../skills/starter-ui/starter-ui.css">
<script src="../../../skills/starter-ui/starter-ui.js" defer></script>
<body class="s-page">
```

## The vocabulary

| Class | What it is |
| --- | --- |
| `.s-page` | ruled desk background; goes on `<body>` |
| `.s-sheet` | the sheet everything sits on |
| `.s-block` + `.s-block__rail` | a section with a plate number in the margin |
| `.s-eyebrow` `.s-title` `.s-h2` `.s-h3` `.s-lede` `.s-prose` `.s-caption` | type |
| `.s-card` (`--inset`, `--mark`) | a panel |
| `.s-btn` (`--mark`, `--quiet`, `--lg`) | a control |
| `.s-chip` (`--mark`, `--ok`) | a small status tag |
| `.s-cmd` + `.s-cmd__text` + `.s-cmd__btn` | a line to copy (`--paste` for prose) |
| `.s-steps` + `.s-step` | a numbered sequence |
| `.s-label` `.s-field` | a form control |
| `.s-stage` | a dark inset for media, 3D, terminals |
| `.s-table` | a ruled table |
| `.s-swatch` | a colour specimen |

## House rules

- One hot ink. `--starter-mark` marks the thing the reader is meant to act on
  and nothing else. If two things on a screen are red, neither one is.
- Hairlines, not shadows. `--starter-hair` separates; the sheet's single lift
  is the only shadow in the system.
- Display type is monospaced. It is the workspace's voice: plain files, plainly
  named.
- Add to the tokens before adding to the components, and to the components
  before writing a one-off style in a prototype.
