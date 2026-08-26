# Canvas — infinite-canvas boards

The shared engine every canvas board mounts (`/__canvas/canvas.js`): a
whiteboard-grade infinite canvas — stickies, 16 shapes + connectors, rich text,
sections, tables, stamps, images, freehand drawing, and **live prototype tiles**
— fully multiplayer (colored cursors, presence, follow mode, co-typing), with
agents able to join a board's room as the Clawd mascot.

This file has two audiences. The **top half is the agent/consumer contract** —
node schemas, `/__board`, `/__asset`, the LWW write rule, the co-work protocol —
what you need to drive a board. The bottom half, **"Engine internals"**, is the
implementation forensics for editing `canvas.js` itself. The `canvas.js` header
carries a section MAP.

Prototypes are authored in the terminal, not typed into an in-canvas generator —
the canvas is where prototypes live and are arranged, not where they're written.

---

# The agent / consumer contract

## The model: a canvas is a file, not a feature

A canvas instance IS a prototype: it lives in `<opportunity>/prototypes/<name>/`,
ships, and gates exactly like any prototype — no new publishing path, no
special-casing in `build.js`. Its `index.html` is a short loader
(`window.GV_CANVAS = {name}` + the two engine tags); the engine is a shared
asset, so every board upgrades centrally. The one seam: the **file** ships
read-only (the template, versioned with the work), but the **contents**
(stickies, positions, dropped tiles) are live state in KV keyed by the file's URL
— the same generic per-URL persist rail comments use. The file stays a file; only
its memory is server-side.

## AI-legible by design

Co-work is tractable because the board is **structured data, not pixels** — Claude
reads the scene graph. Three things make it work: **structured nodes** (`{id,
type, x, y, w, h, …}`, so geometry = meaning: proximity = grouping, columns =
sequence); **named nodes** (every node renameable → a shared vocabulary, so you
refer by *name* — "move the onboarding tile next to voting" — not by pointing;
unnamed nodes fall back to an auto-name or their text); and **tile-to-source
refs** (a tile names its prototype by path, so Claude reads the real source, not a
thumbnail). The **collaboration skill** then follows: resolve "that", describe the
board back spatially, cluster/summarise/connect on request, don't tidy away
meaningful mess.

## Node schemas — the write-side reference (agents: this is your contract)

`doc.nodes` is an ARRAY of plain node objects (a full-state `POST /__board` with a
keyed map is refused as `bad-input`). Positions/sizes are WORLD px.
Every node gets `id` (any unique string; the engine uses `n<rand>`) and should
get a human `name`. Omitted optional fields take defaults. Write nodes through
the daemon's `upsert` (or `GVCanvas.addNode` in-page) — never a raw board POST
while people are on the board.

**Versions (agents MUST respect this):** every node also carries `v` (int) + `vn`
(random tiebreak), and the room applies ops under version-checked LWW — an update
that doesn't OUT-version the room's copy bounces (a corrective comes back).
Creating a node: leave `v`/`vn` off, the engine/room stamps it. Updating one
through the proper doors (`ClawdCanvas.upsert/del/rename`, `GVCanvas` mutations,
the in-page editor) bumps automatically — do nothing. Hand-rolling ops or a
**full-state seed over an existing board**: bump each modified node's `v` above
the value you read (and randomize `vn`), or the room treats your write as a stale
echo and keeps its own copy. Deleted nodes leave tombstones in `doc.tombs` —
recreating an id needs a `v` above the tomb's.

| type | required | optional (what it means) |
|------|----------|--------------------------|
| `sticky` | `x y` | `w h` (220×220) · `text` · `rich` (see below) · `color` (pastel bg) · `author` · `fontSize` px (a CEILING — the text shrinks below it to fit) · `bold` · `align` · `hFixed` (true = height pinned by a manual resize; omit = hugs its text) |
| `text` | `x y` | `text` · `rich` · `w` (none = hug/`max-content`; set = fixed width + wrap) · `fontSize` · `color` · `bold italic strike` · `align` |
| `shape` | `shape x y` | `w h` (per-shape default) · `text`/`rich` (centered) · `color` (fill). Shapes: square round circle diamond triangle triangle-down pill cylinder bubble star hexagon pentagon parallelogram trapezoid plus arrow-right |
| `image` | `x y src` | `w h` · `name` · `desc` (one line — the claim the image makes; see the description contract) · `crop` `{x,y,w,h}` as FRACTIONS of the full src · `alpha` (true = cut-out PNG, rendered without the card background; auto-probed on load when omitted). `src` = any **same-origin path**: `/__asset/<hash>` for uploads or a path to an image committed in the space repo (`/…/img/04-method.jpg`, how hand- and agent-built boards usually do it). Data URLs are legacy-render-only, don't write new ones |
| `tile` | `x y url` | `w h` (420×300) · `name` · `device` desktop\|tablet\|phone (viewport the iframe renders at) · `liveUrl` (in-frame navigation, room-managed) · `viewAt` (framed scroll view, room-managed) |
| `arrow` | `x1 y1 x2 y2` | `kind` arrow\|elbow\|curved\|line (default arrow) |
| `draw` | `x y points` | `mode` marker\|highlighter\|tape · `color` · `size` stroke px · `w h` bbox · `points` = [[dx,dy],…] RELATIVE to x,y |
| `section` | `x y` | `w h` · `name` · `color` · `locked` "all" (contents inert) \| "bg" (bg only). Dragging a section carries every node whose CENTRE is inside |
| `table` | `x y` | `rows cols` (2×2) · `w h` · `cells` = { "r-c": text } (zero-based, e.g. "0-1") |
| `stamp` | `stamp x y` | `w h` (46×46). Stamps: thumbs-up +1 star question thumbs-down sticker heart, plus **`avatar`** — the face stamp, which also carries `src` (the stamper's `/__avatar/<key>` path), `name` and `color` (the initials chip it falls back to when there's no photo). A face stamp shows WHOEVER STAMPED IT, so those three travel on the node. (`laugh` is a retired key that still paints, for boards made before the face slot.) |

**Every box node also accepts `rot`** — degrees, normalised to (−180, 180], clockwise,
about the box centre. It is a plain CSS transform on the node host, so children (a
sticky's text, an image, a live tile's iframe) come along and hit-testing follows. `x y w
h` stay the UNROTATED box; a node's occupied rect is the axis-aligned box of the rotated
one (`nodeRect`). Not applicable to `arrow` (it has endpoints, not a box) or `section` (a
container whose contents would not follow). Drag just outside any corner handle to rotate
(Shift = 15° detents, double-click the pad to straighten); stamps land with a few degrees
of tilt of their own. `rot` is a GEO_KEY, so a peer's rotation rides the geometry
fast-path — write `0` to straighten a node, never delete the field.

**Rich text (`node.rich`)** — sanitized HTML, whitelist: `b strong i em u s strike
del br div p ul ol li span`, ALL attributes stripped. One `<div>` per line; lists
as `<ul>/<ol>` runs, nesting = lists inside `<li>`. When you write `rich`, ALSO
write `text` as the plain `innerText` equivalent (it names the node and is the
no-rich fallback). **Unknown tags are UNWRAPPED — their text is kept, the tag
dropped**; `<script>`/`<style>` and every attribute are removed outright. This
sanitizer is the XSS gate for a doc that round-trips through shared KV and the
room socket — don't fight it.

**Opaque nodes — the description contract.** `image` and `tile` are the only node
types whose meaning isn't recoverable from the doc, so an agent can't tell whether
one is worth opening without opening it:

- **Images: write `desc` on the node** — one line stating the CLAIM the image
  makes ("today's builder: type palette left, questions as grey rows, no
  preview"), not what it looks like. `/__asset` images are immutable, so a desc
  written once never goes stale. Whoever uploads writes it. Agent-facing only,
  rendered nowhere.
- **Tiles: never cache prototype meaning on the node — the PROTOTYPE owns it**, as
  a one-line `<meta name="description">` in its own `index.html`, updated in the
  same commit that changes the prototype. To read them: `/__canvas/catalog.json`
  carries `desc` for every top-level prototype; canvas-owned screens aren't in the
  catalog — fetch the tile's `url` (same-origin, cheap) or run `canvas-screen.mjs
  ls`, which flags opaque screens and desc-less images.
- **The rubric is one line:** *state the claim the node makes.* A board that needs
  special instructions gets an "Agents: …" sticky on the board itself.
- **Triage + disclose:** descriptions exist so you can judge what's worth opening
  — but before writing conclusions next to tiles you haven't opened, either open
  them or SAY what you skipped. Silent skipping is the failure that created this
  rule.

## Reading & writing the board — `/__board`

`boardApi` (`src/_worker.js`) serves the KV mirror at `GET/POST
/__board?path=<url>` (KV key `board:<path>`, 20MB cap). **PUBLIC route** — a
canvas is a published prototype, no login to load.

- **GET** → `{doc}` (or `{doc: null}` if never saved). `doc` is the board document
  — `{name, nameV, nodes, tombs, clock}` as the room writes it, or the client's
  `{v, name, view, nodes, tombs}` from a solo POST. Either way `nodes` and `tombs`
  live INSIDE `doc`; there is no top-level `id` and no `focus`.
- **POST** full-state — the body MUST be the doc envelope `{"doc": {…, "nodes":
  […]}}`. A bare node array, or any body whose `doc.nodes` isn't an array, gets a
  400. This is the **solo fallback** only (see Multiplayer); the KV write is the
  mirror the room reconciles on its next cold load.

**The one write rule that bites:** on an EXISTING board, a hand-rolled full-state
POST must bump each modified node's `v` above what you read — the room folds the
mirror in **per-node, version-ruled**, so an un-bumped write reads as a stale echo
and is dropped. Prefer live per-node ops (below) over full-state writes.

## Images — `/__asset`

`assetApi` stores canvas images content-addressed and OUTSIDE the doc, so a doc
write never carries image bytes:

- **POST `/__asset`** with the image body; content type must be
  `image/jpeg|png|webp|gif` (else **415**), 4MB hard cap (else **413**). Returns
  `{url: "/__asset/<40-hex-hash>"}`. Identical bytes dedup to the same hash (no
  duplicate write).
- **GET `/__asset/<40-hex-hash>`** → the bytes, `immutable` cache. Old boards with
  inline data-URL `src`s still render; don't write new ones.

## Created canvases (the in-app "＋ New canvas" button)

A canvas needs no repo scaffold to be *born*: the loader is generic and the
contents live in KV anyway. Folder index pages (Playground + each project folder)
carry a "＋ New canvas" button — signed-in users only (`/__me` reveals it) — that
registers `<dir><slug>/` in the `canvases` KV map and navigates there. The worker
serves the standard loader at any registered path (`virtualCanvas` in
`src/_worker.js`), so the page exists the moment it's named.

`canvasesApi` (`POST /__canvases`) ops:

- `{dir, name}` — create: slugs `name`, refuses to shadow a real shipped file
  (any non-404 at the target URL) or the site root; dirs are slug-segment paths
  only. Returns `{map, path}`.
- `{path, rename: true, name}` — rename in place: the display name changes, the
  path (and its board doc) stays. Returns `{map}`.
- `{path, remove: true}` — unregister: the board doc (`board:<path>`) is left in
  KV, so recreating the same name restores the board. Returns `{map}`.
- **GET `/__canvases`** → `{map}`.

Created canvases are **public**, same obscure-share-link model as published
prototypes (boards under an admin-only space stay sealed — `isRestrictedPath`
runs first). Materializing — committing the loader at the matching repo path and
removing the registry entry — promotes a board to a real repo file; contents
carry over untouched (the doc is keyed by URL, which doesn't change). The registry
is one KV key (`canvases`): one get per folder-page view and per 404.

## Canvas-owned prototypes ("build a prototype on the canvas")

A canvas is a **container of prototypes**. "Build a prototype on this canvas"
means: author it the normal way (in the terminal — a real static HTML/JS
prototype), scaffolded into a SUBFOLDER of the canvas
(`<space>/<opp>/prototypes/<canvas>/<slug>/index.html` → ships at
`/<opp>/<canvas>/<slug>/`; `build.js` copies the canvas folder recursively, so
nested screens ship and do NOT appear as separate opportunity cards). A tile is
auto-placed on the board. The screen is **owned by the canvas**: removing it
deletes the folder (contrast a tile added via the picker pointing at a pre-existing
prototype — removing that just unlinks).

**The tool:** `node scripts/canvas-screen.mjs`

- `add <canvasUrl> <slug> [--title T] [--desc "one-line claim"]` — create the
  subfolder (+ a starter `index.html` with the `<meta name="description">`
  scaffolded) and place the tile. Then write the real prototype into that
  index.html and commit + push.
- `dup <canvasUrl> <srcSlug> <newSlug> [--title T] [--tile name]` — **fork** an
  owned screen: copy the folder and repoint the duplicate tile at it. Cmd+D in the
  canvas clones only the TILE (named "… copy", pointing at the SAME folder — the
  browser can't write git), so **any agent asked to change a duplicate must run
  `dup` FIRST** (it repoints the "… copy" tile, or `--tile <name>`, at the fork),
  then edit the fork and commit + push. Never edit a folder two tiles share unless
  the change is meant for both.
- `rm <canvasUrl> <slug>` — remove the tile AND delete the folder. Commit + push.
- `gc <canvasUrl>` — the browser half of the remove coupling: deleting a tile in
  the canvas UI can't delete the folder, so `gc` deletes orphaned folders after a
  **1-hour grace** (covers a ⌘Z), anchored at the first gc run that noticed the
  orphan. Run it whenever you start working a canvas; commit + push if it deletes.
  Grace state: `.canvas-gc.json` at the workspace root (local only).
- `ls <canvasUrl>` — reconcile view: nested screen folders vs board tiles; flags
  orphaned folders, dangling tiles, and opaque nodes (screens with no meta
  description, images with no `desc`).

It talks to two stores: **files** (space repo — you commit + push) and the
**board**. Board writes go **THROUGH THE ROOM**, not a raw KV overwrite:
`mutateBoard` opens the board as a `ClawdCanvas` room client, diffs the desired
doc against the live one, and sends the difference as per-node `upsert`/`del` ops
(the room folds them in and persists; when the room is empty the one-shot client
seeds from KV and flushes on disconnect). The ownership coupling is enforced here
(terminal) because a canvas can't write git from the browser.

## Working on the canvas (co-work live as Clawd)

**DEFAULT WORKING MODE:** when asked to change a board (add / move / retitle /
arrange / delete nodes), **join the board's multiplayer room as a real
participant and stream per-node ops** — NOT a full-state `POST /__board`. The
human then sees your Clawd cursor move, a focus ring on the node you touch, and
each edit land live; per-node LWW means you never clobber their concurrent work.
Do this unless prompted otherwise.

- **The tool:** `scripts/clawd-canvas.mjs` (`ClawdCanvas`, a raw-WS Node client —
  needs **Node 22+** for the global WebSocket). `const c = new
  ClawdCanvas({boardPath}); await c.connect();` then: `moveCursorTo(x,y)` (glides
  so the human sees Clawd walk), `pose('thinking'|'sparkles'|'happy'|'sleeping'|
  'love'|'sunglasses'|'idle')`, `focus(id)`/`focus(null)`, `upsert(node)`/
  `del(id)`/`rename(name)`, `save()` (no-op while connected — the ROOM persists;
  it POSTs `/__board` only as the disconnected fallback), `say(text)`/`unsay()`
  (an ephemeral speech bubble by the cursor — always `unsay()` when done),
  `streamUpsert/streamDel` (generic ephemeral ops), and `stub({x,y,w,h,label})`
  (a persistent "🔨 Clawd is building: …" placeholder section). A section's visible
  label is its **`name`**, not its `text` — so a hand-rolled placeholder must put
  the caption in `name` (`upsert({type:'section', name:'🔨 building…', …})`), or it
  renders blank. It reads the live doc on connect. CLI: `node clawd-canvas.mjs
  probe|demo|chill|daemon <boardPath>`.
- **Humanized verbs (PREFER these for visible work):** `dragNode(id,x,y)` (walk
  over, grab, node + cursor travel together), `typeNode(node)` (create and TYPE
  word-by-word under the focus ring — conversational scale only, bulk seeding
  stays instant), `sel(ids)` (point with selection rings), `status(text,
  'working'|'idle'|'attention'|'done')` (the state behind your avatar chip in the
  top-right presence row — `attention` rings the chip amber and jumps it = you
  need the human; `done` flashes green; keep it current, it's how the human works
  with the terminal hidden), `chat(text)` (cursor-chat bubble), `follow(name)`/
  `unfollow()`. `dragNode` and `typeNode` are POLITE — they `waitUnheld()` while a
  human has the node. Daemon commands mirror all of these 1:1.
- **Humans talk back on the board:** "/" opens cursor chat; every line a human
  types is appended to `<cmdfile dir>/clawd-events.jsonl` by the daemon — **read
  that file at the start of a turn** to hear what was said to you.

**SHOW ACTIVITY FIRST (the co-working protocol).** The human watches the canvas,
not your terminal. On ANY ask, your first move is visual, before real work:

1. **Thinking:** walk to the relevant section → `pose('thinking')` → `say('reading
   the numbers…')` — *then* read/reason. Update the bubble as focus shifts.
2. **Building:** walk to where the artifact will land → `stub({...})` → `pose(
   'sparkles')` + `say('building…')` — *then* build. When the real nodes land,
   **`del` the stub — never retitle it into a permanent frame.** A finished
   prototype tile stands ALONE on the board, no section wrapped around it.
3. **Emotions as punctuation:** `happy` when something lands, `sunglasses` when it
   ships live, `love` when the human likes it, `sleeping` when parked. Statuses
   are the grammar, emotions the punctuation.
4. `focus(id)` whatever node you're editing; `focus(null)` + `unsay()` when the
   burst ends.

**The daemon (staying commandable across turns):** `node clawd-canvas.mjs daemon
<boardPath> <cmdFile>` — one connection, tails `<cmdFile>` (JSONL; command set in
the script header), executes in order, mirrors the live doc to `clawd-board.json`.
Reacting visually costs one `echo '{"cmd":"pose","v":"thinking"}' >> <cmdFile>` —
do that FIRST, then work. **Launch it DETACHED**, not as a harness-tracked
background task (task-list cleanups reap tracked daemons and Clawd vanishes):

```sh
nohup node scripts/clawd-canvas.mjs daemon <boardPath> <cmdFile> \
  > <scratchpad>/clawd-daemon.log 2>&1 & echo $! > <scratchpad>/clawd-daemon.pid; disown
```

Identity is **deterministic** — derived from the session's cmd-file path — so do
NOT pass `--name` (the daemon **refuses a bare `--name`**; it's reserved for
sibling agents launched with `--sibling`). A detached daemon does NOT die with the
session — dismiss it explicitly (`{"cmd":"quit"}`, or `kill $(cat
clawd-daemon.pid)`). Check the pidfile before launching (a live one means YOUR
previous daemon is up — reuse or quit it; two connections = two cursors). Never
touch other sessions' daemons.

- **Ambient chill (daemon default):** connected-but-idle ≠ frozen. With no
  commands for ~12s and the pose plain `idle`, Clawd fidgets, strolls near the
  human's cursor, the odd happy blip — so presence reads as alive. Any command
  pauses it; explicit poses hold. `{"cmd":"chill","v":false}` turns it off.
- Work left-to-right / in a sensible order so the human can follow your cursor
  (`board.view` is per-user — you can't pan them).
- **Park when idle (stay present):** when finished but staying available, **don't
  disconnect** — `pose('sleeping')` in a quiet corner; the daemon (or chill mode)
  holds the process, a 25s keepalive keeps Clawd in the room across turns, and a
  sleeping agent stays fully visible.
- **When NOT to co-work live:** the **bulk first-seed** of a brand-new board (use
  a full-state seed script while the board is closed), or when told to work
  silently. A full-state seed over an EXISTING board must bump each node's `v` (see
  the write rule above).
- **⚠️ Test on a throwaway `boardPath` under `/__test/`** — opening a board (or
  connecting a client) joins its REAL room and writes real data. See the isolation
  rule under Multiplayer.

**Multi-agent (several Clawds at once):** each session joins with its OWN identity.
For the session's own Clawd, pass **no** `--name` — it reads the name from the
session transcript and follows `/rename`; color derives from the name (stable hash
→ palette; plain "Clawd" = the orange `#d97757`), and the presence chip wears the
same color. For a **sibling** agent that needs a separate fixed identity, launch
`node clawd-canvas.mjs daemon <boardPath> <cmdFile> --sibling --name Scout --color
'#4e8fd9'` — its own daemon, name, color, and command file (use the session's
scratchpad so they never collide). `--name` PINS identity and turns
session-following off (right for a sibling, rejected without `--sibling`). Only
ever `kill` your own daemon — never a blanket `pkill` (that murders siblings).
`{"cmd":"identity","name":"…"}` forces a rename by hand. ⚠️ `rename` renames the
**BOARD**, not the agent — identity changes go through `identity`.

## Multiplayer — every canvas is a live room

**The model.** A `BoardRoom` Durable Object per board path relays cursors,
presence, node ops, live selections, and editing focus between everyone on that
board — and **the room OWNS the document**: the doc lives in the DO's own SQLite
storage (one row per node + a meta row with name/tombstones; strongly consistent;
survives hibernation), loaded before every welcome, written on every accepted ops
batch, migrated lazily from KV the first time an older KV-only board is touched.
Workers KV holds the same doc as a **write-through mirror** (dirty flag → 45s
alarm → put; last-one-out flushes immediately; failed writes re-arm) serving the
public GET and the solo fallback, folded back in per-node on every cold load — so
solo clients and terminal scripts that wrote `/__board` while the room was empty
are never steamrolled. Ops apply under **version-checked LWW**: a write must
out-version (`v`, then `vn`) what the room holds; losers get a corrective op back;
deletions leave tombstones stale upserts can't cross; a `{t:"doc"}` seed is
reconciled per-node, never adopted wholesale. **`/__test/` rooms are RAM-only —
they never persist to SQLite or KV; every other path does.** Clients POST
`/__board` only as the **solo fallback** (socket down or provably stale). Strictly
an enhancement layer: if the socket can't connect, the canvas behaves exactly as
solo. Net: a hot multi-person board costs ≤ ~80 KV writes/hour.

**The solo rail cannot latch shut and cannot fail silently** (canvas.js, the save
watchdog): a save POST aborts after 20s instead of hanging forever, the in-flight
guard is a timestamp that expires rather than a boolean that can stick, and a 5s
watchdog re-kicks the rail whenever the doc holds unconfirmed edits with no live
room and nothing in flight, scheduled, or backing off. Once the dirt survives two
ticks the client shows a floating bottom-right chip — "Changes not saved —
retrying", or "Offline — changes not saved" when the browser reports no network —
that flips to a brief green "Saved" when the dirt lands (cleared by the next 2xx
or a live room). Closing the tab while the warning shows asks first, and
regaining connectivity kicks a save immediately instead of waiting out a backoff.
(Born of a measured failure: a dev-server restart hung one save fetch, the old
boolean guard then suppressed every save for the rest of the session, and an
hour's board edits existed only on screen.)

**The pieces:**
- `realtime/` — the room worker (BoardRoom DO, WebSocket Hibernation API).
  Deployed **standalone**, NOT via Pages: `npm run deploy:realtime` (Pages can't
  define DO classes). **One worker per instance** — rooms are keyed by board path,
  so two instances sharing a worker would share rooms and storage. The engine
  carries only the code; the worker's name and `BOARD_KV` binding come from the
  shell's `realtime.wrangler.toml` (template `realtime/wrangler.example.toml`),
  and the site finds it through `realtimeOrigin` in `deploy.config.json`. Protocol
  documented at the top of its `index.js`. Redeploy it yourself when you touch it.
- `src/_worker.js` `rtProxy` — `/__rt` proxies the WebSocket same-origin to that
  worker (no hardcoded URL; works offline too, where it reaches the REAL prod
  rooms — same live-KV-while-offline posture as the overlay data — **but only when
  `.env.deploy` also carries `RT_SHARED_SECRET`**: a secret-gated realtime worker
  403s a proxy without it and the canvas silently degrades to solo). In offline
  SANDBOX mode (no KV creds) the proxy is sealed shut (`GV_RT_DISABLE` → 501), so
  sandbox boards can't half-escape into the shared prod rooms.
- `src/canvas/canvas.js` "multiplayer" section — the client. **No hooks in the
  mutation paths**: a 120ms diff tick compares each node against a shadow signature
  (long strings collapsed, so image boards stay cheap) and broadcasts
  `upsert/del/name`; applying a remote op writes the shadow FIRST so the tick never
  echoes. Conflicts are per-node LWW; a node you're dragging/editing ignores remote
  writes. `board.view` is per-user, never synced. Geometry-only remote changes
  patch styles on the live element (`.gvc-remote-move` tween) instead of
  re-rendering — smooth drags, no iframe/image churn.
- **Cursors** — ONE glyph for everybody: the custom arrow from piti mode
  (`pitis/piti.js` CURSOR_SVG), tinted per visitor from the room palette. Your own
  OS pointer wears it too; peers render it with a name pill. Cursor layer lives
  OUTSIDE `#gvc-ui` so ⌘. keeps people visible. Names come from `/__me`, else
  "Guest".
- **Follow mode** — every client publishes its camera as
  `{t:"view", v:{x,y,s,w,h}}` (throttled ~10/s, change-gated, kept on the socket
  attachment so a fresh follow syncs before the peer next moves). Click a presence
  chip → your camera soft-lerps to *their viewport* (pan AND zoom), tracked live;
  a border + a "Following ‹name›" pill with a Stop button appear in the peer's
  color. Your own pan/zoom/space-drag (or Stop, the chip, the peer leaving, a
  socket drop) breaks it. Agents publish no viewport (a daemon has no window) —
  following one falls back to a centred cursor chase. Following chains just work.

**Tiles are ALWAYS LIVE** — there is no ▶ Live/■ Stop control; `node.live` (the
old shared Stop/Live state) is written nowhere and ignored everywhere. Every tile
mounts its real iframe when it nears the viewport (IntersectionObserver-gated,
`MOUNT_BUDGET` LRU backstop unmounts offscreen tiles to their poster), under a
transparent `.gvc-hit` overlay so it selects/drags like any node. **Double-click a
tile to interact** (overlay off, blue ring, you drive the prototype); click
outside or Esc leaves (Esc is caught inside the frame too). Interact mode is
per-user; what you DO mirrors: prototypes are SAME-ORIGIN, so `mpFrameLoad` hooks
each frame and clicks/input/scroll/navigation broadcast as ephemeral `{t:"proto"}`
relays. Navigation also persists as `node.liveUrl` (synced) so late joiners mount
at the URL you navigated to, and **where in that page you left it persists as
`node.viewAt`** — scroll a tile while driving it and that becomes the tile's view
for the board, restored on every later mount (reload, late joiner, LRU remount)
until the next person scrolls it. Only a driver writes it, it is stamped with the
page it was taken on (a stale view never lands on another page), and it is kept
out of the undo stack — an undo re-renders, and re-rendering a tile would reload
the prototype. Anti-echo = `isTrusted` filter + a 400ms quiet window
per frame after each replay. A tile can embed ANOTHER canvas (joins its own room
from inside). Cross-origin tiles safely no-op. Limits: replay is event-level, not
DOM mirroring — mid-flow SPA state doesn't transfer to late joiners; simultaneous
drivers fight politely (LWW).

**⚠️ Playwright/testing rule (bit on day one, twice).** Blocking `POST
**/__board` is NOT enough — a test that opens a canvas page ALSO **joins its real
room and broadcasts ops to real visitors**. Isolate the room by overriding
`GV_CANVAS.boardPath` to a throwaway `/__test/` path — and because instance HTML
does `window.GV_CANVAS = {...}` (full overwrite), a plain `addInitScript` value
gets clobbered: use `Object.defineProperty(window, "GV_CANVAS", ...)` with a
setter that forces `boardPath` back in, **guarded `if (window.top !== window)
return;`** — `addInitScript` runs in every frame, and an unguarded override leaks
into tile iframes, so a canvas-typed prototype embedded in a tile joins the TEST
room and haunts presence as phantom "Guest" chips (bit #2 — cost an afternoon of
zombie-hunting). Don't navigate test tiles to canvas-typed prototypes. Reference
pattern: two browser contexts joined to one ISOLATED room, then mount/interact in
one and assert the mirror in the other. (Rooms outside `/__test/` are NOT
self-healing — they write real SQLite + KV.)

## Session — the shared timer + music

The top-right corner is ONE white card holding the whole room: the presence
avatars (humans and Clawd agents alike) and a **session inset** (mini record +
seven-segment time) that opens a *Timer and music* panel. One timer and one track
per board, the same for everyone; anyone can drive it. Start / pause / resume /
stop / +1 min, up to 99:59; the digits are editable when idle (`7` → 7:00, `7:30`
→ 7m30s). **The ending is audible, not visual**: each of the last
five seconds carries a whole tick-TOCK (a bandpassed noise knock at two pitches,
260ms apart), a three-note mallet bell closes 00:00 — all synthesized, no
assets — and then the timer simply REVERTS to the duration it just ran, back
in its idle state ready to go again. Nothing turns red, nothing shakes, and no
alarm state is left parked in the corner of everyone's board. An expired countdown
wires as `null` from the room too, so a late joiner sees that same idle state.
Both sounds run through the per-user volume/mute (as the music does). The clock renders
in the DSEG7 font (`/__canvas/DSEG7Classic-Bold.woff2`, SIL OFL); the music section
is an SVG turntable that spins while playing.

**It is not board content.** Session state lives on the room (`ctx.storage` in the
DO), never in the document — no node, no ops tick, no undo, no KV doc write.
`{t:"timer",do:…}`/`{t:"music",do:…}` go up; the room broadcasts
`{t:"session",timer,music}` to everyone (including the sender) and hands it to late
joiners on `welcome`. Three rules bought with bugs:

- **The wire carries REMAINING ms, never a deadline.** Clients stamp arrival with
  `performance.now()` and count down locally — no clock agreement, and cost is per
  *click*, not per second.
- **No alarm.** The DO's one alarm slot belongs to the KV persist rail; a timer
  borrowing it would silently cancel a pending document write. Expiry is computed
  client-side.
- **Session mutations are serialized** (`sessQ`): two people hitting `+1 min` in
  the same tick must stack, not overwrite.

**Music is a hook, not content — the engine ships no audio.** The picker is built
from `/__canvas/tracks.json`, accumulated at build time from each space's `tracks/`
folder (ids namespaced `<space>:<id>`). A space authors `tracks/tracks.json` as
`[{id,name,file,duration,color?,motif?}]`; `duration` (seconds) lets every client
seek to the same point. `color` + `motif` (`bird`·`face`·`burst`·`scribble`·
`gridsun`·`sail`) dress the label, else both derive from the id hash. No tracks →
the turntable renders grayed + inert; the timer is unaffected. Volume/mute are
per-user, localStorage, never synced. `tracks/` is gitignored in space repos by
design (audio you may listen to isn't audio you may redistribute; the space repos
build a public site). Position-sync gotchas: **seek on the `playing` event** (a
paused element accepts a seek then sits, baking in an offset); **gate on
`seekable`** (an origin that doesn't serve byte ranges drops every seek silently —
`wrangler pages dev` is such an origin, so music position does NOT sync in offline
preview, but Cloudflare Pages does); dead zone 0.25s; re-run `sessApplyMusic()`
when the manifest lands (the fetch can lose the race against `welcome`); autoplay
policy blocks a joiner who hasn't clicked — mark it and let their next click start
playback.

## The plumbing (what's where)

- **Engine:** `src/canvas/canvas.js` + `canvas.css`, emitted to `dist/__canvas/`
  by `build.js`, served public via `isPublicPath()`. `capture.js` rides along in
  the same copy step — on NO page; `canvas.js` fetches it by absolute path on the
  first ⌘⇧C.
- **Board doc:** authoritative copy in the BoardRoom DO's SQLite; worker `boardApi`
  (`/__board`, KV key `board:<path>`, 20MB cap) serves the KV mirror. PUBLIC route.
- **Images:** worker `assetApi` (`/__asset`), KV `basset:<sha256[0:40]>`, immutable
  cache, dedup on identical bytes.
- **Room:** `realtime/` — separate worker (BoardRoom DO), `npm run deploy:realtime`.
- **Comments overlay:** two guarded hooks in `src/review/comments.js`
  (`pinXY`/`anchorAt` prefer `GVCanvas` world coords); the engine dispatches a
  window `scroll` on every transform so the overlay repositions. Pages without
  `GVCanvas` are byte-identical.
- **Insert-picker catalog:** `build.js` writes `dist/__canvas/catalog.json`
  (prototypes + pages + components across spaces, with poster thumbs).
- **API:** `window.GVCanvas` = board + `nodes()`/`addNode` + `screenToWorld`/
  `worldToScreen`/`onTransform`/`setTool`.

**Dev loop.** `npm --prefix augur run offline` (background) →
`http://localhost:8788/<opportunity>/<board>/`; watches sibling clones + Augur,
~1s hot reload. **⚠️ Offline KV is LIVE prod** — board/overlay writes are real.
`/__canvas/*.js|css|json` is served **`no-cache`** (a revalidation on every use, so
a reload gets the fresh engine while a 304 still lets the browser reuse its cached
copy — no stale-JS ghosts, no full re-download). **Ship:** commit + push per repo;
Augur first (its push auto-deploys via the engine pin bump), then the space repo
(push saves the page; it goes LIVE via `augur publish`, not the push). Stage only
your paths. Bump `UI_VERSION` only when you touch `comments.js` / the build shell.
**Playwright** is available via a sibling space clone's `node_modules/playwright`;
always block `POST **/__board` and test on a `/__test/` boardPath.

---

# Engine internals (editing canvas.js only)

Everything below is implementation forensics — read it when you're editing the
engine, not when you're driving a board. Every gotcha here is load-bearing;
where the anecdote doesn't change what you do, only the rule is kept.

## Architecture — three layers, native to Augur's vanilla-JS stack

1. **Canvas engine** — one "world" layer, one CSS transform (`translate(x,y)
   scale(z)`); nodes absolutely positioned in world coords; pointer
   pan/drag/select; rAF-batched transform writes. DOM is plenty at this scale
   (tens–low-hundreds of nodes); no WebGL. Virtualize only if boards get big.
2. **Node registry** — pluggable node types, each `render + serialize`. Every box
   resizes from all four corners + all four edges (a text box has no draggable
   height → e/w edges only) and every text-bearing node takes rich text.
3. **Board document** — the JSON described in the contract above, in KV/SQLite,
   keyed by URL.

## Tiles (the one real performance rule)

The infinite canvas is cheap; **live prototypes = iframes are the only heavy
thing** (mount policy in Multiplayer). Tiles render at a fixed DEVICE viewport
width (`DEVICE_W`) and CSS-scale to fit (`fitFrame`, `transform-origin: top left`;
clientWidth/Height are layout px, immune to the world transform). The name chip
floats above the tile, counter-scaled (`scaleTileChrome`) to read at 12px at any
zoom. Posters reuse the poster stack (`scripts/shoot.mjs` / `og.mjs`).

## Option-drag = duplicate; ⌘D

Hold Option and drag a node (or selection) to leave a copy behind (the duplicate-drag
idiom; the copy cursor shows while Option is held).

- **Option is a LIVE modifier, checked continuously for the whole drag — NOT
  decided once at pointerdown.** People press-and-drag, then reach for Option a
  moment later; `altCopySync()` owns the flip and is called from both
  `pointermove` and the Alt keydown/keyup (so it works with the mouse held still).
- Entering: the copy is born where the drag has GOT TO and the original snaps back
  to its start (the node under the cursor stays under it). Leaving: the original
  takes over from where the copy had got to and the copy is deleted (releasing
  Option early is a clean plain move).
- **Originals keep their ids** — deep links (`#n=<id>`), comment threads and a
  tile's prototype folder stay attached to the node already there; the new one is
  what you place.
- Copies are made only once the drag has MOVED (an Option-click must not leave an
  invisible stacked duplicate).
- Dragging a **section** carries its contents, so Option-drag duplicates the
  section AND children. ⚠️ **⌘D does not** — it duplicates only the selection, so
  ⌘D on a section gives an empty section. Known asymmetry, left alone; fix in
  `duplicateSelection` if it bites.
- After the split, snapping is re-armed on the copies (originals become valid snap
  targets). `cloneNode(n, dx, dy)` is shared with ⌘D and leans on `histClone` for
  the deep-copy of `points`/`cells`/`crop`.

## Clipboard (⌘C · ⌘X · ⌘V)

The payload rides the **system clipboard**, not a JS variable — that's the whole
feature. ⌘C serialises the selection to `{tag:"augur.canvas/1", origin:<board
path>, nodes:[…]}` as `text/plain`; ⌘V is a `paste` event listener (the only way
to read clipboardData without a permission prompt).

- **Images cross for free** — an image node's `src` is an absolute `/__asset/<hash>`
  path, so a URL travels, not pixels. A **different origin** does NOT work
  (`/__asset` is per-site — the node would 404). Deliberately unsolved.
- ⌘V also accepts non-canvas clipboards: an image → the same compress + `/__asset`
  upload a drop gets; plain text → a text node.
- **Paste lands centred on the pointer**, not at source coords (which mean nothing
  on another board). Repeat-paste without moving walks copies diagonally.
- ⌘X deletes originals only **after** the clipboard write resolves.
- **A pasted node is REBUILT field by field, never spread in** (`clipSanitize`).
  The clipboard is untrusted input that goes into shared KV and out over the room
  socket — a bad paste is stored XSS for the whole board. Known type, fresh id,
  numbers coerced, enums whitelisted, `rich` through `sanitizeRich`, **`color`
  hex-only** (renderShape/renderDraw concatenate it into innerHTML), `image.src` /
  `tile.url` held to **same-origin paths** — no scheme, no protocol-relative
  `//host` (a tile is an iframe). ⚠️ Validate `src` acceptance against a LIVE board
  (`curl '<site>/__board?path=<path>'`), not the schema doc: most real images are
  repo paths, and an over-strict `/__asset`-only rule silently drops every node.
- ⚠️ **`sanitizeRichEl` parses in a DOMParser document, on purpose.** Assigning
  untrusted markup to a live element's `innerHTML` — even detached — loads its
  resources immediately, so `<img src=x onerror=…>` fires before the strip-walk
  reaches it. Parse inert, clean, then hand the cleaned markup to a live element.
  Don't "simplify" this back to `box.innerHTML = html`.

## Copy as PNG (⌘⇧C)

A picture of the selection straight onto the clipboard (also the camera button on
the single-selection toolbar). It **re-renders** the nodes rather than grabbing the
screen: 2x the node's NATURAL size regardless of `board.view.scale`, exact bounds,
no permission prompt. Rasterizer: `nodesToPng({els, rect, scale, background,
poster, onInfo})` in `src/canvas/capture.js`, lazy-loaded from
`/__canvas/capture.js` on first use. SCREENSHOT semantics (not a cut-out on transparency):
the frame is the selection box + 12px bleed, holding everything visible in that
rectangle; selection/resize/hit/focus chrome is stripped, but tile/section/image
labels are kept (rendered at 100%-zoom, the box GROWS upward to hold them). Three
composited layers so one bad node degrades instead of killing the shot: paper + dot
grid native; nodes cloned into a mini-world at scale 1 through `<foreignObject>`;
each live tile in its OWN pass (a framed page's stylesheet would leak; node passes
cut at each tile so z-order holds). Per-tile fallback: live frame → poster →
placeholder. Clipboard failure downloads the PNG; ~40MP cap halves the scale.

Gotchas that change what you do:
- ⚠️ **The SVG must be a `data:` URL, never `blob:`.** A blob taints the canvas
  (opaque origin), and the taint surfaces only at the end as `toBlob` throwing
  `SecurityError`.
- ⚠️ **A rasterizing SVG is frozen at time ZERO**, so `animation: rise .45s both`
  is caught at its FIRST keyframe (usually `opacity:0`) — a slide came out blank.
  Fix: `animation-duration:0s` + `animation-delay:0s` (NOT `animation:none`), which
  lands every animation on its END state.
- ⚠️ **Nothing is fetched during rasterization** — stylesheets read from
  `document.styleSheets`, every `url()` absolutized + inlined as a data URI, every
  `<img>` src swapped for one; anything un-inlinable is dropped; cross-origin sheets
  (`cssRules` throws) skipped.
- ⚠️ **Chrome-class stripping runs on the ENGINE's nodes only** — a framed page is
  someone else's markup, where `sel`/`active` are theirs.
- Live DOM state must be written into the inert clone: `<canvas>` → `toDataURL` img,
  input/textarea/select values → attributes (source and clone walked in parallel).
- ⚠️ **ORDER TRAP in the keydown handler:** with Shift held `e.key` is `"C"`, so the
  plain ⌘C branch matches ⌘⇧C too. The PNG branch sits ABOVE it and tests
  `e.shiftKey`; the ⌘C branch tests `!e.shiftKey`. Both guards must stay. (The
  comment overlay's Shift+C binding also had to stop swallowing ⌘⇧C.)
- Limits: while interacting inside a tile the iframe owns the keyboard, so ⌘⇧C
  no-ops — Esc out first. On Windows Chrome `Ctrl+Shift+C` is DevTools and can't be
  intercepted.

## Rich text — through the LINE model

`node.rich` holds sanitized HTML, `node.text` stays in sync as plain `innerText`
(the fallback when `rich` is absent). Node-level styles
(`bold/italic/strike/align/fontSize/color`, `applyTextStyle`) mean "the whole box";
the toolbar applies to the SELECTION when one exists (`toggleFormat`).

- **Never `execCommand("insertUnorderedList")` on our boxes.** They're `white-space:
  pre-wrap`, where Chrome keeps Enter as literal `"\n"`, so the browser makes ONE
  bullet from every line. Lists are ours: `flattenLines` → toggle `kind` →
  `serializeLines` (one `<div>` per line, same-kind runs merged into `<ul>/<ol>`).
- **Map the selection to lines with MARKERS, not a counter** — a hand-written
  counter drifts on empty `<div><br></div>` lines. `markSelection` plants
  `<gv-mk1>/<gv-mk2>` and the same `flattenLines` reports where they landed.
- **Sanitize on render AND on commit** (board HTML round-trips through shared KV +
  the socket). `sanitizeRichEl` whitelists tags and strips every attribute; paste
  is forced to plain text.
- **Format buttons need `keepFocus`** (mousedown `preventDefault`) or the focus
  move blurs the editable before the command runs.
- After an inline conversion (`execCommand("bold")` on a range), **toggle the style
  OFF again** — it leaves the PENDING typing style on, so text after `**bold**`
  stays bold. Collapse to end, run the command a second time.
- Input rules can't assume the line model exists: a brand-new sticky's text is a
  bare text node with no `<div>`, so `autoFormat` falls back to the editable itself
  and anchors on the last `"\n"`.
- Typed shorthands convert in place: `- `/`* `/`1. ` open a list, `**bold**` /
  `_italic_` / `~~strike~~` convert on the closing delimiter, and `->` (or `-->`)
  becomes `→` as the `>` lands.

## Sticky / shape auto-sizing

Stickies and shapes size to their text (`autoFit(node, allowShrink)`): grow so they
never clip, shrink back on edit while the height is auto. `allowShrink` is false on
render, so opening an old board never reflows it; a resize-drag sets `node.hFixed`
and the box stops hugging.

- **A sticky shrinks its TEXT before it grows its BOX** (`fitStickyFont`, the sticky-note
  model): `fontSize` is a CEILING, the text steps down `STICKY_FONT_RAMP` until it
  fits; only when the bottom rung overflows does the note grow. Two traps: (1) fit
  against the height the note WANTS (`STICKY_H` in auto mode, its own height once
  `hFixed`) — never the current grown height, or the fit feeds back into itself; (2)
  `STICKY_PAD_V` must track `.gvc-stickyin`'s vertical CSS padding. The walk starts
  from the cached size (`txt.dataset.fit`), so a keystroke costs 1–2 reflows.
- **A sticky's auto floor is the size it was dropped at** (`STICKY_H`), not the CSS
  `min-height` (with the CSS floor, two words collapsed a 160px note to 96). Floor
  skipped when `hFixed` and on render.
- A shape's text is inset 12%/side (hence `/0.76`) and height-capped by the insets,
  so `scrollHeight` can't see shorter content — measure the line blocks (`contentH`).
  Its `.gvc-txt` needs `flex-direction: column` or rich-text line blocks lay out in
  a row.

## Resize, snapping, sections, drag

- **Resize handle needs a real starting size.** `startResize` reads `node.w/h` for
  `ow/oh`, but text nodes carry neither until first resized → `ow+dx = NaN` and the
  handle silently did nothing. Fall back to the host's measured
  `offsetWidth/Height`. Text is width-only on resize (clear `style.height` → auto).
- **A clipping host eats its own resize handles** — corner handles straddle the
  edge, so an `overflow:hidden` host shows quarter-circles. Clip in an INNER wrap
  (`.gvc-stickyin`), leave the host visible (same for `.gvc-image`).
- **Decor doesn't inherit the zoom fix.** Handles are world-space children, so at
  40% zoom a 13px handle paints at 5px; `scaleDecor` counter-scales them
  (`transform: scale(1/zoom)`, registered on `transformCbs`). An **edge** handle
  counter-scales ONE axis only (`scaleY`/`scaleX`) so it keeps full length; edges
  sit at `z-index:2` under the corners.
- **Resize math is direction-driven; a one-letter direction is not a corner.**
  Derive `west/north` + `doW/doH` by explicit membership, not character positions
  (`dir.charAt(1)==="w"` mis-reads `"w"`). Shift's aspect lock is corner-only.
- **Resizing a ROTATED node happens in the node's own axes.** Rotate the pointer
  delta into node space first (`ldx/ldy`), and place the result by the ANCHOR rule:
  the side opposite the one you grabbed stays fixed in world space, which — because
  CSS rotates about the centre — means `c1 = c0 + R·(a_before − a_after)`, never
  "x = ox + (ow − w)". At `rot 0` the two are the same expression, so upright
  resizing is unchanged. Snap guides are axis-aligned and switch OFF while rotated;
  a tilted box has no edge to latch onto.
- **The rotate pad is OUTSIDE the corner, and below it.** `.gvc-rot` hangs off each
  corner (22px, invisible, cursor-only) with `transform-origin` set to that corner so
  the same `scaleDecor` counter-scale keeps it pinned; `z-index` under the resize dot,
  so the overlap always resizes. Double-click straightens.
- **Shift is overloaded on a node drag** — shift-CLICK toggles selection, shift-DRAG
  locks the axis. Decide at pointer-UP: apply the toggle only if `drag.moved` is
  false. A finished drag must clear `lastTap`, or a second drag within 350ms reads
  as a double-tap into the editor.
- **Auto-adapt text = `max-content`, never `width:auto`.** `#gvc-world` is
  `width:0`, so an `auto`-width absolutely-positioned text node shrinks to its
  minimum content width (one word per line). `renderText` sets `max-content` when
  `node.w` is null, explicit px only after a resize.
- **Sections carry contents by CENTRE containment**, resolved once at pointerdown
  (`withSectionChildren`). Passengers are excluded from snap candidates
  (`armSnap(moving)`), but the snap box stays the SELECTION's rect.
- **Snapping is measured in SCREEN pixels** (`SNAP_PX / view.scale`). Candidate rects
  collected ONCE per drag (`armSnap`), never per pointermove. Shift beats snapping on
  the pinned axis; ⌘/Ctrl bypasses it entirely (also what a test holds to assert
  exact pixel deltas).
- **A node must never be a native HTML5 drag source.** The browser starts its own
  drag from a text run (and from `<img>`), painting a ghost and firing `dragover` —
  which lit the "Drop image" overlay mid-drag of a text node. Two guards: `dragstart`
  inside `.gvc-node` is `preventDefault`ed (except while `.editing`), and the drop
  overlay only answers a drag carrying files (`dataTransfer.types` has `"Files"`).
- **Rename** (tile bar, image label): **manual double-tap**, not native `dblclick`
  (the root's pointer capture eats `dblclick`); `stopPropagation` so a tap doesn't
  start a drag.

## Undo / history

- **Undo must be per-USER, not per-document, in a live room** — restoring a
  whole-board snapshot would revert a teammate's work. `histCommit` diffs against a
  shadow on the save debounce and records only changed nodes as `{before, after}`;
  `mpApplyOps` folds every REMOTE change into that shadow (`histSeen`/`histForget`)
  so a peer's work never enters your stack. Adopting a room doc (`mpAdoptDoc`) folds
  per-node through the same rail, so your undo stack survives a reconnect (adopt is a
  per-node diff, not a wholesale replace). Inside a text box the browser's own undo
  wins.
- **Snapshots share their strings.** `histClone` is a shallow copy with
  `points`/`cells`/`crop` deep-copied — never `JSON.parse(JSON.stringify(node))`,
  which would duplicate every inlined image data-URL dozens of times.

## KV writes — the scarce resource

The free tier allows ~1k writes/day and the doc runs to hundreds of KB with images
inlined. **The rule: never spend a KV write on the camera.** The viewport is
per-user (the room never syncs it), so it lives in `localStorage` under
`gvc:view:<path>` (`saveView`/`storedView`), which also stops one person's camera
overwriting everyone else's. If you add a feature that touches `board.view`, call
**`saveView()`, NOT `scheduleSave()`.** Belt and braces: `save()` compares a content
signature (`docSig` = nodes + name) and skips the POST when only the camera moved;
the save debounce is 1200ms; adopting a room doc reseeds the signature. The client
POST runs only as the SOLO fallback — the BoardRoom DO owns the doc and writes the
KV mirror itself (`realtime/src/index.js`: `applyOps`/`markDirty`/`alarm`/`mirror`,
flush on empty, `/__test/` rooms exempt). The solo save confirms the 2xx before
marking saved, retries with backoff, ships `keepalive`, beacons on `pagehide`, and
a failed board LOAD holds saves off entirely (an empty stand-in must never overwrite
the real board). Playwright note: blocking `POST /__board` doesn't prove "no KV
writes" — the room writes server-side; test rooms must stay under `/__test/`, and
blocking the socket needs a WebSocket-constructor stub (HTTP routes don't intercept
upgrades).

## SVG, toolbar, wheel, deep links

- SVG nodes: build via an innerHTML string (or `createElementNS`), never
  `createElement("svg")` (no namespace → never paints).
- Insert-picker cards live in a **flex-column → grid**: without `flex:1;
  min-height:0` on the grid + `grid-auto-rows:max-content`, flex collapses the auto
  rows to ~8px and `overflow:hidden` clips each poster. `aspect-ratio` did NOT
  contribute block height — use a fixed thumb height.
- **Wheel over the fixed UI** (`#gvc-ui`, e.g. the picker) must `return` early in the
  wheel handler (no `preventDefault`, no pan) or it eats native scroll and pans the
  board.
- **Interaction model:** empty drag = marquee multi-select; pan = scroll/trackpad or
  Space-drag / hand tool. Don't revert to drag-to-pan. Touch exception: one finger on
  empty canvas pans, two fingers pinch-zoom; a second finger mid-stroke cancels the
  stroke (palm) and pinches.
- **The main toolbar:** tool state is one `TOOL` object (`setTool()`), sub-toolbars
  sync via `syncBars()`. Shortcuts: V select · H hand · M marker (⇧P too) · S sticky
  · T text · E stamp · R square · O circle · L line · X elbow · ⇧S section · ⇧T
  table · C comment · Esc select. ⌘⇧C, ⌘C/⌘X/⌘V and ⌘D/⌘Z/⌘⇧Z are handled ahead of
  the tool letters, so ⌘C never toggles comments.
- **←↑→↓ nudge the selection** one WORLD unit, ⇧ ten — world, not
  screen, so alignment done at 400% survives zooming out. `nudge()` reuses the drag's
  `withSectionChildren` (a section takes its contents along) and ends on the same
  `scheduleSave()`, so key-repeat lands as ONE undo step and one write. It is handled
  ABOVE the tool letters: with Shift held that branch reads the key as a letter chord
  and returns, which would swallow ⇧←. Snapping deliberately stays out — the nudge is
  what you reach for when the snap put a node where you didn't want it.
- **The selection bar styles the WHOLE selection.** `showSelBar(nodes)` takes the
  selection, not a node: ten stickies go blue in one click, a run of text nodes takes
  one size. Two rules keep it honest — a control only appears when `uniformType()`
  says every selected node is the same type (a colour means a different thing to a
  sticky and to a drawing; mixed selections get "copy as PNG" alone), and each control
  READS its state off the first selected node and WRITES that one value to all of
  them. Never a per-node flip: ⌘B on a mixed-bold selection must land everything bold,
  not invert each node into a new mess. Single-only by nature: the two list buttons
  (they work through a live editable, and entering an edit collapses the selection to
  one node), Interact/Open on a tile, and the deep link (it addresses ONE node id).
  The bar is suppressed mid-marquee — the hit list changes on every pointermove and a
  bar rebuilt that often strobes over the nodes you're sweeping — and re-formed on
  pointerup, which is why `setSelection` reads `drag.mode`.
- **⚠️ A node must NEVER be a native HTML5 drag source, editing or not.** The
  `dragstart` handler cancels unconditionally. Letting an EDITING node through (it
  once did, to allow dragging a text selection inside the box) means pressing inside
  the text box you just typed into — i.e. going to MOVE it — hands Chromium a
  selection drag, and Chromium paints that drag image from the DOM *without* the
  world's zoom transform: an 80px "Huge" text node smears a translucent page-sized
  copy of itself across the board while the node doesn't move. The eraser deletes whole `draw`
  strokes only; sections render behind everything (`insertBefore`). Illustrated arts
  are inline SVGs (`PEN_ART`/`STICKY_ART`/`CLUSTER_ICON` — keep gradient ids unique);
  small line icons are **Lucide** via `lucideIcon()` (extend with Lucide paths, don't
  hand-draw). The speech-bubble tool IS the comment layer (dispatches
  `toggleComments()`, no new node type). Default sticky color is soft blue
  (`#a9cbf5`).
- **The stamp wheel's left slot is YOUR FACE.** It paints the signed-in user's avatar
  (initials on their room colour when there's no photo), and what it stamps carries
  that identity on the node — a face stamp shows who pressed it, for everyone. Identity
  lands asynchronously (`/__me`, then the room's colour), so the slot is repainted by
  `refreshFaceStamp()` rather than being drawn once at boot.
- **Deep links to one node:** the link button on the selection bar (present for every
  node type) copies `<board URL>#n=<node id>`. Opening it flies the camera to the node
  (`flyToRect`, capped at 1:1), selects and pulses it. **The hash is CONSUMED on
  arrival** (`history.replaceState`'d away) — comment threads scope to `pathname +
  search + hash`, so a lingering `#n=` would file later comments under a view nobody
  else is on (that's also why it isn't a `?query`). Deleting the node gets a toast,
  not a dead board.

## Backlog (open items — pick with the human on the live URL)

- Connectors that snap to nodes.
- Frames / groups.
- Voting / timers as board primitives.
- A poster shot for a freshly-created owned screen so its tile isn't blank until it
  mounts live.
- Proper cache-busting for `/__canvas/*.js|css` if we move off `no-cache`.
- The "read the board + reason spatially" half of the collaboration skill (resolve
  "that", cluster, summarise on request) and a continuous sub-second presence loop
  (today the agent works in turn-by-turn bursts).
