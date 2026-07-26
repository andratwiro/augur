# Canvas — a capability template for infinite-canvas boards

> **Status: LIVE** — the shared engine every canvas board mounts (`/__canvas/canvas.js`).
> Built 2026-07-21, then hardened through daily live use with Rob. History is in git;
> what matters is what's true NOW:
>
> **Editing** — FigJam-grade: full illustrated toolbar (marker/highlighter/washi + eraser,
> stickies, 16 shapes + connectors, text, sections, tables, stamps, speech bubbles, insert
> picker), marquee/Space-pan/pinch, ⌘D duplicate, ⌘Z/⌘⇧Z **undo/redo** (per-user — never
> reverts a teammate), 4-corner resize (Shift = aspect), **smart snapping with red alignment
> guides** (⌘ bypasses), Shift-drag axis lock, non-destructive image crop, sections that
> carry their contents, auto-grow/shrink boxes (`hFixed` after a manual resize).
> **Text** — real rich text (`node.rich`, sanitized HTML; `node.text` stays in sync for old
> boards): selection-level bold/italic/strike, bullet + numbered lists with **Tab/Shift-Tab
> nesting**, markdown input rules (`- ` `1. ` `**b**` `_i_` `~~s~~`), ⌘B/I/U/⇧S/⇧7/⇧8,
> font-size dropdown + custom px, text color, align.
> **Multiplayer** — every canvas is a live room (BoardRoom DO): colored cursors + name
> pills, presence chips (hover = name, click = **follow mode**), live drags at 20Hz (the
> cursor fast-path), peer **selection rings** + editing-focus rings, streamed co-typing,
> remote inserts pop / deletes fade, prototype demo sync inside live tiles, agents co-work
> as the Clawd mascot (`scripts/clawd-canvas.mjs`).
> **Persistence & KV economics** — the ROOM writes KV while live (45s dirty-alarm + flush
> on empty; client POST is the solo fallback); the camera lives in localStorage, never the
> doc; images live OUTSIDE the doc at `/__asset` (content-hashed, immutable, dedup);
> `/__test/` rooms never persist. Net: a hot multi-person board costs ≤ ~80 KV writes/hour.
>
> **New agents: read "Working on the canvas" below first**, then the Gotchas — every entry
> there was bought with a real bug. The `canvas.js` header has a section MAP.
>
> _(An in-canvas "ask AI → generate HTML" build node was prototyped and **removed** 2026-07-21 —
> Rob authors prototypes via the terminal, not an in-canvas generator; the canvas is where they
> live, not where they're typed into being. Don't rebuild that; build the scaffolding instead.)_

## What it is

A hand-rolled infinite canvas you open as a file: drop **prototype/screen tiles** and arrange
**sticky notes / text / images** around them to structure macro ideas, and **work the board
together with Claude**. A thinking surface, not a diagramming tool.

## The core model: a canvas is a file, not a feature

Augur is folders + files. A "prototype" is just *any file in the tree* — today HTML
prototypes and HTML slides, tomorrow whatever. **A canvas is one more file**, not a platform
primitive bolted onto Augur. What makes it special is only that it's **born from a template**:
you copy a starter that ships pre-wired with capabilities (infinite canvas, image drop,
iframe-embedded prototypes, sticky notes, talking to Claude).

So the repeatable layer we're really building is **new-from-template**, and canvas is the
flagship template. "Blank prototype" is a trivial template; "slide deck" is another. Canvas is
just the most capable member of the drawer.

**A canvas instance IS a prototype** — it lives in `<opportunity>/prototypes/<name>/`, ships,
and gates exactly like any prototype. No new publishing path, no special-casing in `build.js`.
In Rob's own framing ("a prototype = any file in our folders"), a canvas is literally a
prototype whose `index.html` is the canvas engine. The platform barely changes.

## The one seam: static file vs read-write board

A prototype file ships read-only. A canvas *is* its stickies and arrangement, which must
save. So split cleanly:

- **The file** = the template, copied into a folder, versioned, lives *with the work* it
  organizes. Created infrequently, so scaffold + push is fine (the normal way every file is
  born here). This keeps the "it's just a file" model intact.
- **The contents** (stickies, positions, which prototypes are dropped where) = live state saved
  to **KV**: no commit, instant, **shared** (Irene sees the board, it survives everything —
  decided 2026-07-21, KV over localStorage because this is shared work).

The contents ride **one generic "let a file persist state keyed by its own URL" endpoint** in
the worker — the same KV rail comments already use (a persistent per-URL blob). So this isn't
a canvas special-case; it's "Augur lets a static file remember things," and any future
interactive template reuses it. The file stays a file; only its memory is server-side.

## AI-legible by design (the collaboration constraint)

Working a canvas *with* Claude is tractable because the board is **structured data, not
pixels** — Claude reads the scene graph, it doesn't look at an image. To make co-work good,
the board state must expose three things from day one:

1. **Structured nodes** — `{id, type, x, y, w, h, content}` — so Claude reasons over geometry
   (proximity = grouping, columns = sequence) precisely, never losing a node.
2. **Named nodes** — every node (tile, image, sticky) is renameable, giving Rob and Claude a
   **shared vocabulary**. This is how deixis is solved: you refer by *name* ("move the onboarding
   tile next to voting"), not by pointing. Robust, async, works in plain chat with no cursor
   channel. Fresh/unnamed nodes fall back to an auto-name ("Sticky 4") or their own text, so
   everything always has a handle.
3. **Tile-to-source refs** — a tile names the prototype it embeds by path, so Claude reads the
   real prototype source, not a thumbnail.

Names are the lingua franca for humans too (Irene refers to "the onboarding tile"), and reuse
Augur's existing rename rail. Live **focus/selection tracking** (viewport, cursor) drops to a
*later* enhancement — needed only for location-deixis ("put one *here*") and real-time pointing,
both out of v1. Names carry reference; the cursor channel isn't required to collaborate.

Get those three right and the **collaboration skill** (resolve "that", describe the board back
spatially, cluster/summarise/connect on request, don't tidy away meaningful mess) is almost a
consequence rather than a separate build. Division of labour: Rob thinks spatially and makes
the productive mess; Claude keeps the structure honest, cross-references tile contents, and
re-clusters on demand. The canvas becomes shared 2D working memory on top of the linear chat.

**Scope of co-work:** turn-based (Rob arranges, then asks; Claude reads the board and acts) is
v1 and ~90% of the value. Real-time shoulder-to-shoulder (both dragging live) is later and
genuinely harder.

## Node schemas — the write-side reference (agents: this is your contract)

Everything below is a plain object in `board.nodes`. Positions/sizes are WORLD px. Every
node gets `id` (any unique string; the engine uses `n<rand>`) and should get a human `name`.
Omitted optional fields just take defaults. Write nodes through the daemon's `upsert` (or
`GVCanvas.addNode` in-page) — never a raw board POST while people are on the board.

| type | required | optional (what it means) |
|------|----------|--------------------------|
| `sticky` | `x y` | `w h` (160×160) · `text` · `rich` (see below) · `color` (pastel bg) · `author` · `fontSize` px · `bold` · `align` · `hFixed` (true = height pinned by a manual resize; omit = hugs its text) |
| `text` | `x y` | `text` · `rich` · `w` (none = hug/`max-content`; set = fixed width + wrap) · `fontSize` · `color` · `bold italic strike` · `align` |
| `shape` | `shape x y` | `w h` (per-shape default) · `text`/`rich` (centered) · `color` (fill). Shapes: square round circle diamond triangle triangle-down pill cylinder bubble star hexagon pentagon parallelogram trapezoid plus arrow-right |
| `image` | `x y src` | `w h` · `name` · `crop` `{x,y,w,h}` as FRACTIONS of the full src. `src` = an `/__asset/<hash>` URL (upload bytes with `POST /__asset`, image/* content-type) — data URLs are legacy-render-only, don't write new ones |
| `tile` | `x y url` | `w h` (420×300) · `name` · `device` desktop\|tablet\|phone (viewport the iframe renders at) · `liveUrl` (in-frame navigation, room-managed) |
| `arrow` | `x1 y1 x2 y2` | `kind` arrow\|elbow\|curved\|line (default arrow) |
| `draw` | `x y points` | `mode` marker\|highlighter\|tape · `color` · `size` stroke px · `w h` bbox · `points` = [[dx,dy],…] RELATIVE to x,y |
| `section` | `x y` | `w h` · `name` · `color` · `locked` "all" (contents inert) \| "bg" (bg only). Dragging a section carries every node whose CENTRE is inside |
| `table` | `x y` | `rows cols` (2×2) · `w h` · `cells` = { "r-c": text } (zero-based, e.g. "0-1") |
| `stamp` | `stamp x y` | `w h` (64×64). Stamps: thumbs-up +1 star question thumbs-down sticker laugh heart |

**Rich text (`node.rich`)** — sanitized HTML, whitelist: `b strong i em u s strike del br
div p ul ol li span`, ALL attributes stripped. One `<div>` per line; lists as `<ul>/<ol>`
runs, nesting = lists inside `<li>`. When you write `rich`, ALSO write `text` as the plain
`innerText` equivalent (it names the node and is the no-rich fallback). Anything outside
the whitelist is stripped on render — don't fight the sanitizer, it's the XSS gate for a
doc that round-trips through shared KV and the room socket.

## Architecture — hand-rolled, three layers, native to Augur's vanilla-JS stack

1. **Canvas engine** — one "world" layer, one CSS transform (`translate(x,y) scale(z)`); nodes
   absolutely positioned in world coords; pointer pan/drag/select; rAF-batched transform
   writes. DOM is plenty at this scale (tens–low-hundreds of nodes); no WebGL. Virtualize only
   if boards get big (not v1).
2. **Node registry** — pluggable node types, each `render + serialize`. Every box resizes from
   **all four corners** and every text-bearing node takes **rich text** (selection-level
   bold/italic/strike + bullet/numbered lists, `node.rich`). Today: `sticky`, `text`
   (auto-adapt `max-content` until resized, then fixed-width wrapping + node-level color/fontSize/bold/italic/strike/align),
   `image`, `tile` (prototype embed), `arrow` (kinds: straight/elbow/curved/line), `draw`
   (freehand marker/highlighter/washi strokes), `shape` (16 geometries + centered editable
   text), `section` (background container), `table` (plain FigJam grid; blue + strips on
   select add row/col), `stamp` (emoji, picked from a radial wheel; "+1" renders styled).
3. **Board document** — JSON `{id, name, nodes:[…], focus:{…}}` in KV, keyed by the canvas
   file's URL.

## The one real performance rule

The infinite canvas is cheap; **live prototypes = iframes are the only heavy thing.**
Since 2026-07-23 tiles are **ALWAYS LIVE** (the poster-at-rest model looked broken and
predates multiplayer): mounting is IntersectionObserver-gated (only tiles near the
viewport mount; posters remain as the placeholder for unseen tiles) with a
`MOUNT_BUDGET` LRU backstop that quietly unmounts offscreen tiles. Posters reuse
go-vocal's capture stack (`scripts/shoot.mjs` / `og.mjs`).

## Settled decisions (were open, now aren't)

- **Engine is a shared Augur asset**, never baked per-canvas — a canvas is a *capability*;
  instances stay 12-line loaders and every board upgrades centrally.
- **Creation is agent-scaffolds-the-file** (copy the loader folder); no in-app "New canvas"
  button (spaces/files are repos — creation is a terminal act, like everything else here).
- **Multiple canvases per opportunity** is normal. Tile-add is the insert **picker**.
- Still genuinely open: connectors that snap to nodes · frames/groups · voting/timers.

## The plumbing (what's where)

- **Engine:** `src/canvas/canvas.js` + `canvas.css` (this repo), emitted to `dist/__canvas/`
  by `build.js`, served public via `isPublicPath()`. The js header carries a section MAP.
- **Board doc:** worker `boardApi` (`/__board?path=<url>`), KV key `board:<path>`, 20MB cap.
  **PUBLIC route** (a canvas is a published prototype — no login to load). While a room
  socket is live the **BoardRoom DO persists instead of the client** (see Multiplayer).
- **Images:** worker `assetApi` (`/__asset`), KV `basset:<sha256[0:40]>`, content type in
  metadata, immutable cache headers, dedup on identical bytes. Nodes carry the URL; data-URL
  srcs are the legacy/fallback form and still render.
- **Room:** `realtime/` — a separate worker (`augur-realtime`, BoardRoom DO), deployed with
  `npm run deploy:realtime` (NOT via Pages CI — redeploy it yourself when you touch it).
  The Pages worker proxies `/__rt` → it, so clients stay same-origin.
- **Comments overlay:** two guarded hooks in `src/review/comments.js` (`pinXY`/`anchorAt`
  prefer `GVCanvas` world coords); the engine dispatches a window `scroll` on every transform
  so the overlay repositions. Pages without `GVCanvas` are byte-identical.
- **Instances:** e.g. `go-vocal/ux-ui-audit/prototypes/canvas/index.html` — a 12-line loader
  (`window.GV_CANVAS = {name}` + the two engine tags). Copy that folder to make a new board.
- **API:** `window.GVCanvas` = board + nodes()/addNode + screenToWorld/worldToScreen/
  onTransform/setTool — what the collaboration skill and the comment overlay drive.

## Multiplayer (2026-07-23) — every canvas is a live room

**The model.** A `BoardRoom` Durable Object per board path (the same key as the KV doc) relays
cursors, presence, node ops, live selections, and editing focus between everyone on that board
— and while it's live, **the room is also the persister** (2026-07-27): ops set a dirty flag,
a 45s alarm writes the doc to KV, and the last socket leaving flushes immediately; `/__test/`
rooms never persist. Clients POST `/__board` only as the **solo fallback** (socket down).
Strictly an **enhancement layer**: if the socket can't connect, the canvas behaves exactly as
solo. Public like `/__board` (the board is the credential).

**The pieces:**
- `realtime/` — the `augur-realtime` worker (BoardRoom DO, WebSocket Hibernation API). Deployed
  **standalone**, NOT via Pages: `npm run deploy:realtime` (Pages can't define DO classes).
  Live at `augur-realtime.rob-3d3.workers.dev`; protocol documented at the top of its index.js.
- `src/_worker.js` `rtProxy` — `/__rt` proxies the WebSocket same-origin to that worker (no
  hardcoded URL in the engine; works offline too, where it reaches the REAL prod rooms — same
  "offline Figma" posture as live KV).
- `src/canvas/canvas.js` "multiplayer" section + `canvas.css` tail — the client layer. **No
  hooks in the mutation paths**: a 120ms diff tick compares each node against a shadow
  signature (long strings collapsed, so image boards stay cheap) and broadcasts
  `upsert/del/name` ops; applying a remote op writes the shadow FIRST so the tick never echoes.
  Conflicts are per-node last-writer-wins; a node you're dragging/editing ignores remote writes
  (the tick then re-broadcasts your version). `board.view` is per-user and never synced.
  Geometry-only remote changes patch styles on the live element (`.gvc-remote-move` tween)
  instead of re-rendering — smooth drags, no iframe/image churn.
- **Cursors** — ONE glyph for everybody: the Figma-style arrow from piti mode
  (`pitis/piti.js` CURSOR_SVG), tinted per visitor from the room's palette. Your own OS
  pointer wears it too (your color, via injected style; tool/text cursors still win), peers
  render it with a name pill. Cursor layer lives OUTSIDE `#gvc-ui` so ⌘. keeps people visible.
  Names come from `/__me` (login), else "Guest".

**Prototype demo sync + the ALWAYS-LIVE tile model (2026-07-23, remodeled same day).**
Tiles are always live — there is NO ▶ Live/■ Stop anymore. Every tile mounts its real
iframe when it nears the viewport (IO-gated, `MOUNT_BUDGET` LRU backstop), under a
transparent `.gvc-hit` overlay so it selects/drags like any node (grab cursor = the
affordance). **Double-click a tile to interact** (overlay off, blue ring, you drive the
prototype); click outside or Esc leaves (Esc is caught INSIDE the frame too — the iframe
owns the keyboard once you click in). Interact mode is per-user; what you DO mirrors:
prototypes are SAME-ORIGIN, so `mpFrameLoad` hooks each frame document and clicks, input
values, scrolling and navigation broadcast as ephemeral `{t:"proto"}` relays. Navigation
also persists as `node.liveUrl` (synced), so late joiners and reloads mount at the URL you
navigated to. Anti-echo = `isTrusted` filter + a 400ms quiet window per frame after each
replay (scroll events are always trusted; the window is their only guard). Tile chrome is
FigJam-style: a name chip floats ABOVE the tile, counter-scaled (`scaleTileChrome`) so it
reads at 12px at any zoom; device/interact/open actions live on the floating selection
toolbar. A tile can embed ANOTHER canvas — it joins its own room from inside the tile
(correct, delightful, slightly recursive). Cross-origin tiles safely no-op. `node.live`
(the old Stop/Live shared state) is written nowhere and ignored everywhere. Limits: replay
is event-level, not DOM mirroring — mid-flow SPA state does not transfer to late joiners;
simultaneous drivers fight politely (LWW). rrweb-style snapshots deliberately out of scope.

**⚠️ Playwright/testing rule (bit on day one, twice):** blocking `POST **/__board` is **no
longer enough** — a test that opens a canvas page ALSO **joins its real room** and broadcasts
ops to real visitors. Tests must isolate the room by overriding `GV_CANVAS.boardPath` to a
throwaway path — and because instance HTML does `window.GV_CANVAS = {...}` (full overwrite),
a plain `addInitScript` value gets clobbered: use `Object.defineProperty(window, "GV_CANVAS",
...)` with a setter that forces `boardPath` back in, **guarded `if (window.top !== window)
return;`** — `addInitScript` runs in every frame, and an unguarded override leaks into tile
iframes, so a canvas-typed prototype embedded in a tile joins the TEST room and haunts
presence as phantom "Guest" chips (bit #2 — cost an afternoon of zombie-hunting). Also don't
navigate test tiles to canvas-typed prototypes (`customer-interviews` is one). (Rooms
self-heal — the doc cache drops when empty — but don't rely on that.) Reference test: the
mp-proto-e2e script pattern (two contexts, isolated room, mount/interact/mirror assertions).

## Canvas-owned prototypes (what "build a prototype on the canvas" means)

A canvas is a **container of prototypes**, not just a board of references. When Rob (in a terminal
session like this) says *"build a prototype on/in this canvas"*, it means:

1. **Author it the normal way — in the terminal.** Rob doesn't type prompts into an in-canvas
   widget; he asks an agent, and the agent writes a real prototype (static HTML/JS). The canvas is
   where prototypes **live and are arranged**, not where they're generated.
2. **It's scaffolded into a SUBFOLDER of the canvas**, not a loose folder in the opportunity:
   `<space>/<opp>/prototypes/<canvas>/<slug>/index.html` → ships at `/<opp>/<canvas>/<slug>/`.
   `build.js` copies the canvas folder recursively, so nested screens ship automatically and do
   **not** appear as separate opportunity cards — they belong to the canvas. (No build.js change.)
3. **A tile for it is auto-placed on the canvas board** (KV) so it shows up where Rob's working.
4. **It's OWNED by the canvas**: removing it from the canvas **deletes the folder** — gone in
   general, not merely unlinked. (Contrast: a tile added via the in-app **picker** that points at a
   pre-existing top-level prototype is a mere *reference* — removing that tile just unlinks it.)

**The tool that encodes this:** `node scripts/canvas-screen.mjs`
- `add <canvasUrl> <slug> [--title "T"]` — create the subfolder (+ a starter `index.html`) and
  place the tile. Then **write the real prototype into that index.html** and commit + push the
  space repo. Lives at `<site>/<opp>/<canvas>/<slug>/` once deployed.
- `dup <canvasUrl> <srcSlug> <newSlug> [--title "T"] [--tile "name"]` — **fork** an owned
  screen: copy the folder and repoint the duplicate tile at it. This is the terminal half of
  Rob's rule "duplicate the tile ⇒ duplicate the folder": Cmd+D in the canvas clones only the
  TILE (named "… copy", pointing at the SAME folder — the browser can't write git), so **any
  agent asked to change a duplicate must run `dup` FIRST** (it repoints the "… copy" tile, or
  `--tile <name>`, at the fresh fork), then edit the fork and commit + push. Never edit a
  folder two tiles share unless the change is meant for both.
- `rm  <canvasUrl> <slug>` — remove the tile **and** delete the folder (the ownership coupling).
  Commit + push so the deletion ships.
- `ls  <canvasUrl>` — reconcile view: nested screen folders vs board tiles; flags an orphaned
  folder (no tile) or a dangling tile (no folder).

It talks to two stores: **files** (space repo — you commit + push) and the **board** (KV, via the
public `/__board` API — immediate). Notes: the board mutation **retries** because Cloudflare KV is
eventually consistent (a single read-modify-write can miss a just-written node); avoid running it
while you're simultaneously dragging nodes on the live canvas (last full-state write wins). The
coupling is enforced HERE (terminal), because a canvas can't write git from the browser.

## Working on the canvas (start here if you're a fresh agent)

**DEFAULT WORKING MODE: co-work LIVE as Clawd.** When you're asked to change a board (add /
move / retitle / arrange / delete nodes), the default is to **join the board's multiplayer room
as a real participant and stream per-node ops** — NOT a full-state `POST /__board`. The human
then sees your **Clawd** cursor move, a focus ring on the node you're touching, and each edit
land live; and because it's per-node last-writer-wins, you never clobber their concurrent work.
Do this **unless prompted otherwise**.

- **The tool:** `augur/scripts/clawd-canvas.mjs` (`ClawdCanvas`, a raw-WS Node client — no
  browser). `const c = new ClawdCanvas({ boardPath }); await c.connect();` then the verbs:
  `c.moveCursorTo(x, y)` (glides so the human sees Clawd walk), `c.pose('thinking'|'sparkles'|
  'happy'|'sleeping'|'love'|'sunglasses'|'idle')` (Clawd's expression — act while you
  work), `c.focus(nodeId)` / `c.focus(null)`, `c.upsert(node)` / `c.del(id)` / `c.rename(name)`,
  `await c.save()` (no-op while connected — the ROOM persists; it POSTs `/__board` only as
  the disconnected fallback), `c.say(text)` / `c.unsay()` (an
  **ephemeral speech bubble** by the cursor — stream-only, follows Clawd, never yours to save;
  always `unsay()` when done), `c.streamUpsert(node)` / `c.streamDel(id)` (generic ephemeral
  ops), and `c.stub({x,y,w,h,label})` (a persistent "🔨 Clawd is building: …" placeholder
  section — see the protocol below). It reads the live doc on connect, so you edit **on top
  of** everyone's current work. CLI: `node clawd-canvas.mjs probe|demo|chill|daemon <boardPath>`.
- **SHOW ACTIVITY FIRST (the co-working protocol — Rob's standing rule).** The human watches
  the canvas, not your terminal. On ANY ask, your **first move is visual**, before real work:
  1. **Thinking:** walk to the relevant section → `pose('thinking')` → `say('reading the
     Intercom numbers…')` — *then* go read/reason. Update the bubble as your focus shifts.
  2. **Building:** walk to where the artifact will land → `stub({...})` the placeholder →
     `pose('sparkles')` + `say('building common ground…')` — *then* build. When the real
     nodes land, **`del` the stub — never retitle it into a permanent frame.** Rob's rule:
     a finished prototype tile stands ALONE on the board, no section wrapped around it.
  3. **Emotions as punctuation (full character):** `happy` when something lands, `sunglasses`
     when it ships live, `love` when the human likes it, `sleeping` when parked. Statuses are
     the grammar, emotions the punctuation.
  4. `focus(id)` whatever node you're editing; `focus(null)` + `unsay()` when the burst ends.
- **The daemon (how an agent stays commandable across turns):** `node clawd-canvas.mjs daemon
  <boardPath> <cmdFile>` — one connection, tails `<cmdFile>` (JSONL, see the header of the
  script for the command set), executes in order, and mirrors the live doc to
  `clawd-board.json` next to the command file. Reacting visually then costs one
  `echo '{"cmd":"pose","v":"thinking"}' >> <cmdFile>` — do that FIRST, then work.
  **Launch it DETACHED, not as a harness-tracked background task** (task-list cleanups kept
  reaping tracked daemons mid-session and Clawd vanished from the board):
  ```sh
  nohup node scripts/clawd-canvas.mjs daemon <boardPath> <cmdFile> --name '<session name>' \
    > <scratchpad>/clawd-daemon.log 2>&1 & echo $! > <scratchpad>/clawd-daemon.pid; disown
  ```
  A detached daemon does NOT die with the session — dismiss it explicitly when co-work ends
  (`{"cmd":"quit"}` to the cmd file, or `kill $(cat clawd-daemon.pid)`). Check the pidfile
  before launching (a live one means YOUR previous daemon is still up — reuse or quit it;
  two connections = two Clawd cursors). Never touch other sessions' daemons.
- **Ambient chill (daemon default):** connected-but-idle ≠ frozen. With no commands for ~12s
  and the pose plain `idle`, Clawd hangs out — fidgets in place, strolls near the human's
  cursor or around the content, the odd happy blip — so the presence reads as alive. Any
  command pauses it instantly; explicit poses (`thinking`/`sparkles`/`sleeping`) hold.
  `{"cmd":"chill","v":false}` turns it off.
- Work left-to-right / in a sensible order so the human can follow your cursor across a wide
  board (`board.view` is per-user — you can't pan them).
- **Park when idle (stay present):** when finished but staying available, **don't disconnect** —
  park Clawd asleep: `pose('sleeping')` + a quiet corner; the daemon (or `chill` mode) holds
  the process open, a 25s keepalive keeps Clawd in the room across turns; a sleeping agent
  stays **fully visible**.
- **When NOT to co-work live (the "prompted otherwise" cases):** the **bulk first-seed** of a
  brand-new board (use a full-state seed script while the board is closed — it's a clobber), or
  when explicitly told to work silently. Full-state `POST /__board` is whole-doc last-write-wins:
  only when nobody has the board open.
- **⚠️ Test on a throwaway `boardPath`** — opening a board page (or connecting a client) joins its
  REAL room and broadcasts to real visitors. See the isolation rule in the Multiplayer section.
- **Multi-agent (several Clawds at once):** each terminal session / subagent joins with its
  OWN identity — `node clawd-canvas.mjs daemon <boardPath> <cmdFile> --name Scout --color
  '#4e8fd9'` — its own daemon, name, color, and command file (use the session's scratchpad so
  they never collide). The engine renders each as its own tinted Clawd with a name pill;
  bubbles are per-name (the connect sweep only removes bubbles of agents NOT in the room);
  different parts of the board merge cleanly, same node = last-writer-wins. Clawd orange
  (`#d97757`) is the primary's — give siblings distinct names AND colors, and only ever
  `kill` your own daemon — never a blanket `pkill` (that murders sibling sessions' Clawds).
  **Naming is AUTOMATIC — don't pass `--name` for the session's own Clawd.** The pill on the
  canvas should say which terminal each Clawd is, i.e. the session's name; a daemon launched
  with **no** `--name` reads that name itself and keeps following it. Mechanism: Claude Code
  appends `{"type":"custom-title","customTitle":"…","sessionId":"…"}` to the session
  transcript on every `/rename`, so the last such line is the current name; the daemon
  locates its own transcript from the command-file path (the scratchpad carries the session
  id: `…/<project-slug>/<sessionId>/scratchpad/…` → `~/.claude/projects/<project-slug>/
  <sessionId>.jsonl`) and re-reads the appended tail every 5s, swapping identity on change.
  `--session-file <path>` overrides the derivation. **Passing `--name` PINS the identity and
  turns following off** — right for a sibling agent, wrong for the session's own Clawd.
  *(This replaced having the agent read the name out of a system-reminder and pass it by
  hand: it went stale the moment Rob renamed the session mid-turn, and the board showed the
  old name. Machinery beats attention.)*
  **Color is automatic:** it derives from the name (stable hash → palette; plain "Clawd" =
  the orange) and the presence chip wears the same color, so cursor and chip always match.
  `{"cmd":"identity","name":"…"}` still forces a rename by hand if you ever need it.
  ⚠️ `rename` renames the **BOARD**, not the agent — a sibling once titled the whole board
  after itself; identity changes go through `identity`.

**Where everything lives**
- **Engine** (Augur-owned, shared): `augur/src/canvas/canvas.js` + `canvas.css`, served public at
  `/__canvas/` (emitted by `build.js` mirroring `src/review/` → `dist/__review/`; gate-exempt in
  `isPublicPath`). Vanilla JS, no deps, one IIFE. `window.GVCanvas` exposes the board +
  `screenToWorld`/`worldToScreen`/`onTransform`.
- **Persistence**: `boardApi` in `augur/src/_worker.js` — `GET/POST /__board?path=<url>`, KV key
  `board:<path>` on `env.COMMENTS`, **PUBLIC** route (like `/__review/api`), full-state POST, 20MB cap.
- **Comments (board-anchored)**: `augur/src/review/comments.js` — `pinXY()`/`anchorAt()` use
  `window.GVCanvas` when present and store `cwx/cwy`; the engine dispatches a window `scroll` on
  every transform to re-run the overlay's `reposition()`. Normal pages: no `GVCanvas` → untouched.
- **Insert-picker catalog**: `build.js` writes `dist/__canvas/catalog.json` (prototypes + pages +
  components across spaces, with poster thumbs). The Prototype tool searches it.
- **Canvas-owned prototypes**: `scripts/canvas-screen.mjs` (see the section below) — scaffolds a
  prototype into a canvas subfolder + places its tile on the board.
- **A canvas instance IS a prototype**: `go-vocal/ux-ui-audit/prototypes/canvas/index.html` (a
  ~12-line loader) → lives at `/ux-ui-audit/canvas/`. Make more by copying that folder.

**Dev loop**
- `npm --prefix augur run offline` (run in the background) → http://localhost:8788/ux-ui-audit/canvas/
  (sign in `rob@govocal.com` / `augur-rob-2026` if the site chrome asks). It watches sibling clones
  + Augur and hot-reloads (~1s). ⚠️ **Offline KV is LIVE prod** — board/overlay writes are real.
- Edit `src/canvas/*` — the offline watcher now watches `src/canvas` + `src/review`, so it
  hot-reloads (~1s). `/__canvas/*` is served **`no-store`** (see `withAssetCache`), so a **reload**
  gets the fresh engine — no hard-refresh dance, no stale-JS ghosts (that bit twice: new CSS + old
  JS looked like "my fix didn't work").
- **Ship**: commit + push per repo to `main`. **Augur first** (engine/worker/build/catalog), THEN
  go-vocal (the page, via the auto-bump bridge). Stage ONLY your paths (shared checkout, never
  `git add -A`); commit trailers per `augur/CLAUDE.md`. Bump `UI_VERSION` only when you touch
  `comments.js` / the build shell (busts the `?v=` on injected overlay scripts).
- **Playwright IS available** via the sibling `go-vocal/node_modules/playwright` (+ cached
  chromium) — drive it against offline OR the live URL (the canvas page + `/__canvas/*` + `/__board`
  + `/__ai/build` are all public). **Always block `POST **/__board`** in tests (`route(...).abort()`
  on POST) so you never pollute the shared live board; the board loads read-only. This is how every
  canvas fix this session was verified before reporting — do the same, don't reason blind.

**Gotchas (each bought with a real bug)**
- SVG nodes: build via an innerHTML string (or `createElementNS`), never `createElement("svg")`
  (no namespace → never paints).
- **Resize handle needs a real starting size.** `startResize` reads `node.w/h` for `ow/oh`, but
  some nodes (text) carry neither until first resized → `ow + dx = NaN` and the handle silently
  did nothing. Fallback to the host's measured `offsetWidth/Height` when `node.w/h` are null. Text
  is width-only on resize (clear `style.height` → auto) so it wraps + grows like FigJam; only
  `renderText` applying `node.w` when present makes the width survive a re-render/reload.
- **A clipping host eats its own resize handles.** Corner handles straddle the node's edge, so any
  node whose host is `overflow:hidden` (stickies were) shows quarter-circles or nothing at all.
  Clip in an INNER wrap (`.gvc-stickyin`) and leave the host visible. Same reason `.gvc-image`
  never clips at host level.
- **Decor doesn't inherit the zoom fix.** Handles are world-space children, so at 40% zoom a 13px
  handle paints at 5px. `scaleDecor` counter-scales them (`transform: scale(1/zoom)`, origin
  centre, position `left/top: 0|100%` + a half-size negative margin so the centre sits exactly on
  the corner) and is registered on `transformCbs` — same trick as tile/section chrome.
- **Shift is overloaded on a node drag** — shift-CLICK toggles the selection, shift-DRAG locks the
  axis. Deciding at pointerDOWN broke one of them (the toggle removed the node, so the drag moved
  an empty selection). Decide at pointer-UP: apply the toggle only if `drag.moved` is false.
  Related: a finished DRAG must clear `lastTap`, or a second drag inside 350ms reads as a
  double-tap and drops you into the text editor.
- **Auto-adapt text = `max-content`, never `width:auto`.** `#gvc-world` (the node containing block)
  is `width:0`, so an `auto`-width absolutely-positioned text node shrink-to-fits to its *minimum*
  content width — a one-word-per-line column, not a hug. `renderText` sets `width: max-content` when
  `node.w` is null (hug + grow), an explicit px only after a resize drag.
- **Text is rich now — but only through the LINE model** (2026-07-26). `node.rich` holds sanitized
  HTML, `node.text` stays in sync as plain `innerText` and is the fallback when `rich` is absent
  (old boards render unchanged). Node-level styles (`bold/italic/strike/align/fontSize/color`,
  `applyTextStyle`) still exist and now mean "the whole box"; the toolbar applies to the SELECTION
  instead whenever one exists inside an editable (`toggleFormat`). Rules bought with bugs:
  - **Never `execCommand("insertUnorderedList")` on our boxes.** They're `white-space: pre-wrap`,
    where Chrome keeps Enter as a literal `"\n"`, so the browser sees ONE block and makes ONE
    bullet out of every line. Lists are ours: `flattenLines` → toggle `kind` → `serializeLines`
    (one `<div>` per plain line, consecutive same-kind lines merged into a `<ul>/<ol>` run).
  - **Map the selection to lines with MARKERS, not a second counter.** A hand-written
    line-counter drifted off by one on empty `<div><br></div>` lines. `markSelection` plants
    `<gv-mk1>/<gv-mk2>` and the SAME `flattenLines` reports which lines they landed on.
  - **Sanitize on render AND on commit.** Board HTML round-trips through shared KV and the
    multiplayer socket — a peer's `<img onerror>` would be stored XSS. `sanitizeRichEl`
    whitelists tags and strips every attribute; paste is forced to plain text.
  - **Format buttons need `keepFocus`** (mousedown `preventDefault`) or the native focus move
    blurs the editable and the selection is gone before the command runs.
  - `applyNodeStyle` patches the live `.gvc-txt` in place (never a re-render) so an active edit
    isn't torn down.
- **Stickies/shapes size themselves to their text** (`autoFit(node, allowShrink)`): grow so they
  never clip, and SHRINK back on edit while the height is still automatic. `allowShrink` is false
  on render, so opening an old board never reflows it; dragging a resize handle sets
  `node.hFixed` and the box stops hugging. A shape's text is inset 12% a side (hence `/0.76`) and
  its height is capped by those insets, so `scrollHeight` can't see that the content got shorter
  — measure the line blocks (`contentH`). Its `.gvc-txt` also needs `flex-direction: column`; as
  a flex ROW, rich-text line blocks lay out side by side.
- **Input rules can't assume the line model exists yet.** A brand-new sticky's text is a bare
  text node — no `<div>` line block until something re-renders it — so the "- " rule matched
  nothing on the most common case of all. `autoFormat` falls back to the editable itself as the
  line and anchors on the last `"\n"`, and eats exactly the marker it matched.
- **After an inline conversion, toggle the style OFF again.** `execCommand("bold")` on a range
  leaves the PENDING typing style on, so everything typed after `**bold**` stayed bold. Collapse
  to the end and run the same command a second time (invisible — it only flips the pending state).
- **KV WRITES ARE THE SCARCE RESOURCE — never spend one on the camera.** The free tier allows
  ~1k writes/day and the board doc runs to hundreds of KB with images inlined, yet every pan,
  every wheel-zoom step and every zoom-button click used to `scheduleSave()` the WHOLE document
  (Rob hit 50% of the daily quota on 2026-07-26 just from working on a board). The viewport is
  per-user — the room never syncs it — so it now lives in `localStorage` under `gvc:view:<path>`
  (`saveView`/`storedView`, doc `view` still read as a fallback), which also stops one person's
  camera from overwriting everyone else's. Belt and braces: `save()` compares a content
  signature (`docSig` = nodes + name) and skips the POST when only the camera moved, the save
  debounce is 1200ms so a burst is one write, and adopting a room doc reseeds the signature so
  every client doesn't re-persist the same change. If you add a feature that touches
  `board.view`, call `saveView()`, NOT `scheduleSave()`. As of 2026-07-27 the client POST
  only runs at all as the SOLO fallback — while the room socket is live, the BoardRoom DO
  is the persister (see `realtime/src/index.js`: `markDirty`/`alarm`/`persist`, flush on
  empty, `/__test/` rooms exempt). Playwright note: blocking `POST /__board` no longer
  proves "no KV writes" — the room writes server-side; test rooms must stay under
  `/__test/`, and blocking the socket needs a WebSocket-constructor stub (HTTP routes
  don't intercept upgrades).
- **Undo must be per-USER, not per-document, in a live room.** Restoring a whole-board snapshot
  would silently revert whatever a teammate did in the meantime. `histCommit` diffs the board
  against a shadow on the save debounce and records only the nodes that changed, as
  `{before, after}` pairs; `mpApplyOps` folds every REMOTE change straight into that shadow
  (`histSeen` / `histForget`), so a peer's work never enters your stack. Adopting a room doc
  (`mpAdoptDoc`) reseeds the shadow and clears both stacks — you can't undo "into" someone
  else's document. Inside a text box the browser's own undo wins (the global handler returns
  early while `editing`).
- **Snapshots share their strings.** `histClone` is a shallow copy with the mutable containers
  (`points`/`cells`/`crop`) deep-copied — never `JSON.parse(JSON.stringify(node))`, which would
  duplicate every inlined image data-URL on the board 60 times over.
- **Sections carry their contents by CENTRE containment**, resolved once at pointerdown
  (`withSectionChildren`) so what you pick up is what you saw. The passengers are excluded from
  the snap candidates (`armSnap(moving)`) or the section would snap to its own stickies, while
  the snap box stays the SELECTION's rect — you're aligning the section, not its contents.
- **Snapping is measured in SCREEN pixels** (`SNAP_PX / view.scale`), or it feels sticky zoomed
  out and unreachable zoomed in. Candidate rects are collected ONCE per drag (`armSnap`), never
  per pointermove, and a multi-selection snaps as one union box. Shift (axis lock) beats snapping
  on the pinned axis; ⌘/Ctrl bypasses it entirely — which is also what a test must hold down when
  it asserts exact pixel deltas.
- **Rename** (tile bar name, image `.gvc-name` label): **manual double-tap**, not native `dblclick`
  — the root's pointer capture eats `dblclick`; also `stopPropagation` so a tap doesn't start a drag.
- Insert-picker cards live in a **flex-column → grid**: without `flex:1; min-height:0` on the grid
  (scroll region) + `grid-auto-rows:max-content`, flex shrinks the grid and collapses the auto rows
  to ~8px, and `overflow:hidden` clips each poster to a sliver. `aspect-ratio` did NOT contribute
  block height there — use a fixed thumb height.
- **Wheel over the fixed UI** (`#gvc-ui`, e.g. the picker) must `return` early in the wheel handler
  (no `preventDefault`, no pan) or it eats the picker's native scroll and pans the board instead.
- Live **tile/build iframe**: render at a fixed DEVICE viewport width (`DEVICE_W`) and CSS-scale to
  fit (`fitFrame`), `transform-origin: top left`; clientWidth/Height are layout px (immune to the
  world transform). "Stop" **freezes** (keeps the iframe, `pointer-events:none`) so device/scroll
  state survives; cap is total loaded iframes (`MAX_LIVE_TILES`), LRU-evict to poster.
- The board + `/__ai/build` endpoints are **public by design** (a canvas is a published prototype).
- **Interaction model**: empty drag = marquee multi-select; pan = scroll/trackpad or Space-drag /
  hand tool. Don't revert to drag-to-pan. **Exception — touch**: one finger on empty canvas pans,
  two fingers pinch-zoom (phones have no trackpad/marquee need); armed tools still act on one
  finger. A second finger landing mid-stroke cancels the stroke (it's the palm) and pinches.
- **The FigJam toolbar** (rebuilt 2026-07-22, verified against real FigJam screenshots): tool
  state is one `TOOL` object (`setTool()`), sub-toolbars sync from it (`syncBars()`). Shortcuts:
  V select · H hand · M marker · S sticky · T text · E stamp (radial wheel picker) · R square ·
  O circle · L line · X elbow · ⇧S section · ⇧T table · C comment · Esc back to select. Drawing
  keeps the marker armed; shapes/sticky/text/table place once then return to select; stamps stay
  armed (FigJam behaviour). The eraser deletes whole `draw` strokes only. Sections render behind
  everything (`insertBefore`). The illustrated pen/sticky/cluster arts are inline SVGs in
  canvas.js (`PEN_ART`/`STICKY_ART`/`CLUSTER_ICON`) — keep gradients/ids unique, they're
  singletons in the bar; they hang below the pill and are clipped by `.artclip`, lifting on
  hover (FigJam). Small line icons are **Lucide** (the shadcn set) via `lucideIcon()` — extend
  with Lucide paths, don't hand-draw new glyphs. The **speech-bubble tool is the comment
  layer**: it dispatches the overlay's own Shift+C keydown (`toggleComments()`), no new node
  type. Default sticky color is FigJam blue (`#a9cbf5`).

**Backlog (pick with Rob — he reviews on the live URL and iterates fast)**
- **DONE 2026-07-21** (this session): device picker + freeze-on-Stop, Cmd+D duplicate, tile/image
  rename, picker-collapse + wheel-scroll fixes, no-store engine, and **canvas-owned prototypes**
  (the `canvas-screen.mjs` scaffolding — nested subfolder + auto-placed tile + ownership coupling).
- The **collaboration skill** — Claude reads board state + node names to co-work spatially
  (resolve "that", cluster, summarise). **First cut SHIPPED 2026-07-23:** `scripts/clawd-canvas.mjs`
  (`ClawdCanvas`) — a raw-WS Node client that joins a board's room as a real participant
  ("Clawd", `kind=agent`), glides its cursor, raises a focus ring on the node it's working, and
  streams `upsert/del/name` ops (live, per-node LWW — no full-state clobber). The engine renders
  agent peers as the Clawd mascot (`MP_CLAWD` / `.gvc-cursor.agent`) tinted by a pinned color
  (Clawd orange for the primary; humans always take a palette slot). STILL AHEAD: the "read the
  board + reason spatially" half (resolve "that", cluster, summarise on request) and a continuous
  presence loop (today the agent works in bursts, turn-by-turn, not a sub-second cursor).
- Canvas-owned-prototype polish: an in-app "remove screen" affordance on owned tiles that records
  the deletion for the terminal to reconcile (today: `canvas-screen.mjs rm`); a poster shot for a
  new screen so its tile isn't blank until you go Live.
- Proper cache-busting for `/__canvas/*.js|css` if we move off `no-store` (today: no-store).
- Connectors that snap to nodes; in-app "New canvas" button.
- **DONE 2026-07-23:** multiplayer (cursors/presence/live ops/co-typing) — see the
  "Multiplayer" section; NOT the old "live-KV rail" idea, a Durable Object room per board.
