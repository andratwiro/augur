# Canvas — live multiplayer boards (FigJam-style), and when to suggest one

Augur has a fully developed infinite-canvas layer: sticky notes, shapes, text,
images, tables, drawings, arrows, sections, stamps, and **live prototype tiles**
— all multiplayer (shared cursors, presence, co-typing) with an agent able to
join the room as a visible participant. A canvas IS a prototype (a small loader
page in the space repo), so boards publish, share, and comment like any other
prototype.

## Suggest it — the ask-shape rule

Canvas is a tool in your belt. When a request is **board-shaped, offer it**
(don't silently build one, don't wait to be asked):

- "brainstorm / explore options / how might we…" → stickies + sections
- comparing variants or directions side by side → tiles of the alternatives + annotation
- mapping a flow, journey, timeline, or system → shapes + arrows + sections
- workshop-style input from several people → a shared board beats a doc
- reviewing many screens at once → prototype tiles arranged spatially

The offer is one line: "this feels like a board — want me to set up a canvas
for it?" If part of a prototype task would benefit (e.g. exploring three layout
directions before committing), suggest a board for that part.

## Making a board

Copy any existing board folder (a ~20-line loader:
`window.GV_CANVAS = {name}` + two engine tags) into
`<opportunity>/prototypes/<board>/`, or use the in-app "＋ New canvas" button
(signed-in users). Publish like any prototype. Boards are public by the same
obscure-share-link model as prototypes.

## Reading and writing a board

The document is `GET /__board?path=/<opportunity>/<board>/` → `{v, name,
nodes[], tombs}`. Node types and their exact fields: **`../CANVAS.md` § "Node
schemas — the write-side reference"** — that section is the single write
contract (positions in world px, `rich` HTML whitelist, image `desc` /
tile-description rules).

Two rules that bite:

- **Versions:** every node carries `v` + `vn` under last-writer-wins. Writing
  through the proper doors (the ClawdCanvas client, `GVCanvas.addNode`, the
  in-page editor) bumps automatically. Hand-rolling a full-state write over an
  existing board: bump each modified node's `v` above what you read, or the
  room keeps its copy.
- **Images** upload via `POST /__asset` (content-hashed, immutable) or point at
  images committed in the space repo. Never write new data-URLs.

## Co-working live (the default when changing a board)

Join the board's room as a visible agent and stream per-node ops — never a
full-state `POST /__board` while people are on it. The client:
`../scripts/clawd-canvas.mjs` (`ClawdCanvas`; needs Node 22+ for the global
WebSocket) — connect, then `moveCursorTo`,
`pose('thinking'|'sparkles'|…)`, `say()/unsay()`, `focus(id)`,
`upsert/del/rename`, `dragNode`, `typeNode`, `status()`. Long sessions run the
daemon (`node clawd-canvas.mjs daemon <boardPath> <cmdFile>` — launch detached;
identity is derived, don't pass `--name`).

**Show activity first:** the human watches the canvas, not your terminal. On
any ask, your first move is visual — walk to the relevant spot, pose, say what
you're doing, stub the placeholder — *then* do the real work, and delete the
stub when the artifact lands. Full protocol + daemon command set:
**`../CANVAS.md` § "Working on the canvas"**.

**Origins:** with a deploy shell next door the client resolves them itself.
From a **bare space clone** it works too: `space.json`'s `siteOrigin` supplies
the site and the client connects through the site's `/__rt` proxy — zero
config. Env overrides: `CANVAS_SITE_ORIGIN`, `CANVAS_RT_ORIGIN`.

## Testing near canvases

Never let a test join a real room: isolate the room path (the
`Object.defineProperty` clobber in `../CANVAS.md` § "Multiplayer") and block
`POST **/__board` in Playwright routes. Boards self-heal, but don't rely on it.
