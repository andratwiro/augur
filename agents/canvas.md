# Canvas — live multiplayer whiteboards, and when to suggest one

Augur has an infinite-canvas layer: sticky notes, shapes, text, images, tables,
drawings, arrows, sections, stamps, and **live prototype tiles** — all
multiplayer (shared cursors, presence, co-typing) with an agent able to join the
room as a visible participant. A canvas IS a prototype (a small loader page in
the space repo), so boards publish, share, and comment like any other prototype.

The deep reference — node schemas, the co-work protocol, engine internals — is
**`../CANVAS.md`**. This file is the agent-facing contract only.

## Suggest it — the ask-shape rule

Canvas is a tool in your belt. When a request is **board-shaped, offer it** (one
line: "this feels like a board — want me to set up a canvas?"); don't silently
build one, don't wait to be asked:

- "brainstorm / explore options / how might we…" → stickies + sections
- comparing variants side by side → tiles of the alternatives + annotation
- mapping a flow / journey / timeline / system → shapes + arrows + sections
- workshop-style input from several people → a shared board beats a doc
- reviewing many screens at once → prototype tiles arranged spatially

## Making a board

Copy any existing board folder — a short loader (`window.GV_CANVAS = {name}` +
the two engine tags) — into `<opportunity>/prototypes/<board>/`, or use the
in-app "＋ New canvas" button (signed-in users). Publish like any prototype.
Boards are public by the same obscure-share-link model as prototypes.

## Reading and writing a board

- **Read:** `GET /__board?path=/<opportunity>/<board>/` → `{doc}`, where `doc` is
  `{name, nameV, nodes, tombs, clock}` (or `{doc: null}` if the board was never
  saved). `nodes` and `tombs` live INSIDE `doc`. Node types and their exact
  fields: **`../CANVAS.md` § "Node schemas"** — the single write contract
  (positions in world px, `rich` HTML whitelist, image `desc` rules).
- **Write (full-state):** `POST /__board?path=…` with the body wrapped in a doc
  envelope — `{"doc": {…, "nodes": [...]}}`. A bare node array (or any body
  without `doc.nodes` as an array) 400s.
- **Versions:** every node carries `v` + `vn` under last-writer-wins. Writing
  through the proper doors (the ClawdCanvas client, `GVCanvas.addNode`, the
  in-page editor) bumps automatically. Hand-rolling a full-state write over an
  existing board: bump each modified node's `v` above what you read, or the room
  keeps its copy.
- **Images** upload via `POST /__asset` (content-hashed, immutable) — content
  type must be `image/jpeg|png|webp|gif` (else **415**), 4MB cap (else **413**);
  they read back at `GET /__asset/<40-hex-hash>`. Or point `src` at an image
  committed in the space repo. Never write new data-URLs.

## Co-working live (the default when changing a board)

Join the board's room as a visible agent and stream per-node ops — never a
full-state `POST /__board` while people are on it. The client:
`../scripts/clawd-canvas.mjs` (`ClawdCanvas`; needs **Node 22+** for the global
WebSocket) — connect, then `moveCursorTo`, `pose('thinking'|'sparkles'|…)`,
`say()/unsay()`, `focus(id)`, `upsert/del/rename`, `dragNode`, `typeNode`,
`status()`. Long sessions run the daemon (`node clawd-canvas.mjs daemon
<boardPath> <cmdFile>` — launch detached; identity is derived, don't pass
`--name` unless it's a `--sibling` agent — the daemon rejects a bare `--name`).

**Show activity first:** the human watches the canvas, not your terminal. On any
ask, your first move is visual — walk to the spot, pose, say what you're doing,
stub the placeholder — *then* do the real work, and delete the stub when the
artifact lands. Full protocol + daemon command set: **`../CANVAS.md` § "Working
on the canvas"**.

**Origins:** with a deploy shell next door the client resolves them itself. From
a bare space clone it works too: `space.json`'s `siteOrigin` supplies the site
and the client connects through the site's `/__rt` proxy. Env overrides:
`CANVAS_SITE_ORIGIN`, `CANVAS_RT_ORIGIN`.

## Testing near canvases

A test that opens a canvas page (or connects a client) **joins the real room and
writes real data**. Isolate the room path onto a throwaway path — and it **must
be under `/__test/`**: only `/__test/` rooms are RAM-only, every other path gets
real DO SQLite + KV writes (there is no self-healing for a non-`/__test/` path).
Use the `Object.defineProperty` clobber in **`../CANVAS.md` § "Multiplayer"** and
block `POST **/__board` in Playwright routes.
