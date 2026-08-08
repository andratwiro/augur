# Canvas — a capability template for infinite-canvas boards

> **Status: LIVE** — the shared engine every canvas board mounts (`/__canvas/canvas.js`).
> Built 2026-07-21, then hardened through daily live use with Rob. History is in git;
> what matters is what's true NOW:
>
> **Editing** — full whiteboard-grade: full illustrated toolbar (marker/highlighter/washi + eraser,
> stickies, 16 shapes + connectors, text, sections, tables, stamps, speech bubbles, insert
> picker), marquee/Space-pan/pinch, ⌘D duplicate, **Option-drag to duplicate**, **⌘C/⌘X/⌘V copy-cut-paste across tabs and
> boards** (system clipboard, so a second board in a second tab pastes the same selection),
> **⌘⇧C copy as PNG** (a picture of the selection on the clipboard at 2x, whatever the zoom),
> ⌘Z/⌘⇧Z **undo/redo** (per-user — never
> reverts a teammate), 4-corner + 4-edge resize (corners: Shift = aspect; edges resize one
> axis), **smart snapping with red alignment
> guides** (⌘ bypasses), Shift-drag axis lock, non-destructive image crop, sections that
> carry their contents, auto-grow/shrink boxes (`hFixed` after a manual resize), **stickies that
> hold their square and shrink their TEXT to fit it** (FigJam's model — the note only grows once
> the text has floored).
> **Text** — real rich text (`node.rich`, sanitized HTML; `node.text` stays in sync for old
> boards): selection-level bold/italic/strike, bullet + numbered lists with **Tab/Shift-Tab
> nesting**, markdown input rules (`- ` `1. ` `**b**` `_i_` `~~s~~`), ⌘B/I/U/⇧S/⇧7/⇧8,
> font-size dropdown + custom px, text color, align.
> **Multiplayer** — every canvas is a live room (BoardRoom DO): colored cursors + name
> pills, presence chips (hover = name, click = **follow mode**: FigJam-style viewport
> mirroring — pan+zoom tracked via `{t:"view"}`, screen border + "Following ‹name›/Stop"
> pill in their color; agents fall back to cursor chase), live drags at 20Hz (the
> cursor fast-path), peer **selection rings** + editing-focus rings, streamed co-typing,
> remote inserts pop / deletes fade, prototype demo sync inside live tiles, agents co-work
> as the Clawd mascot (`scripts/clawd-canvas.mjs`).
> **Persistence & versioning (2026-08-07: the room OWNS the doc)** — the BoardRoom DO's
> own SQLite storage is the document's source of truth (per-node rows; strongly
> consistent; survives hibernation); Workers KV holds the same doc as a **write-through
> mirror** (45s dirty-alarm + flush on empty) serving the public GET and the solo
> fallback. Every node carries `v` (int, bumped by whoever mutates) + `vn` (random
> tiebreak); deletions leave tombstones — all writes are **version-checked LWW**
> (Figma/Excalidraw model), so a stale tab, a slept laptop, or an eventually-consistent
> KV read can merge but can never clobber. The camera lives in localStorage, never the
> doc; images live OUTSIDE the doc at `/__asset` (content-hashed, immutable, dedup);
> `/__test/` rooms never persist. Net: a hot multi-person board costs ≤ ~80 KV writes/hour.
>
> **Clawds feel human (2026-07-27, Rob's brief: "hide the terminal")** — agents on a board
> now: **walk in** from beside the content; **drag nodes** with cursor + node travelling
> together; **type** stickies word-by-word under their focus ring; **point by selecting**;
> sit in the top-right presence row as **Clawd avatar chips** beside the humans, status as the dot on the face — click one for its card: status text + Follow + Kick off board (face · working/idle/attention/
> done states, click to follow) while the top-right chips stay humans-only; wear a
> **name-hashed accessory** so multiple Clawds differ by silhouette; auto-idle and
> eventually **walk out** when their session dies (transcript heartbeat); and everyone has
> **cursor chat** (the "/" key) which daemons log to `clawd-events.jsonl` so words typed
> at a Clawd reach its agent next turn. Identity is DETERMINISTIC: name = session name,
> color = the session's `/color` (name hash only when none was ever set), default state =
> working; the daemon refuses `--name` without `--sibling`.
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

**Versions (2026-08-07, agents MUST respect this):** every node also carries `v` (int) +
`vn` (random tiebreak), and the room applies ops under version-checked LWW — an update that
doesn't OUT-version the room's copy bounces (a corrective comes back). Creating a node:
leave `v`/`vn` off, the engine/room stamps it. Updating one through the proper doors
(`ClawdCanvas.upsert/del/rename`, `GVCanvas` mutations, the in-page editor) — bumping is
automatic, do nothing. Hand-rolling ops or a **full-state seed script over an existing
board**: bump each modified node's `v` above the value you read (and randomize `vn`), or
the room will treat your write as a stale echo and keep its own copy. Deleted nodes leave
tombstones in `board.tombs` — recreating an id needs a `v` above the tomb's.

| type | required | optional (what it means) |
|------|----------|--------------------------|
| `sticky` | `x y` | `w h` (220×220) · `text` · `rich` (see below) · `color` (pastel bg) · `author` · `fontSize` px (a CEILING — the text shrinks below it to fit) · `bold` · `align` · `hFixed` (true = height pinned by a manual resize; omit = hugs its text) |
| `text` | `x y` | `text` · `rich` · `w` (none = hug/`max-content`; set = fixed width + wrap) · `fontSize` · `color` · `bold italic strike` · `align` |
| `shape` | `shape x y` | `w h` (per-shape default) · `text`/`rich` (centered) · `color` (fill). Shapes: square round circle diamond triangle triangle-down pill cylinder bubble star hexagon pentagon parallelogram trapezoid plus arrow-right |
| `image` | `x y src` | `w h` · `name` · `desc` (one line — the claim the image makes; see the description contract below) · `crop` `{x,y,w,h}` as FRACTIONS of the full src. `src` = any **same-origin path**: `/__asset/<hash>` for uploads (bytes via `POST /__asset`, image/* content-type) **or a path to an image committed in the space repo** (`/ux-ui-audit/…/img/04-method.jpg` — how hand-built and agent-built boards usually do it; most of the timings board is these). Data URLs are legacy-render-only, don't write new ones |
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

**Opaque nodes — the description contract (decided 2026-07-27).** `image` and `tile` are
the only node types whose meaning is not recoverable from the doc (every other type carries
its own text), so an agent can't tell whether one is worth opening without opening it. The
rules that fix that:

- **Images: write `desc` on the node** — one line stating the CLAIM the image makes
  ("today's builder: type palette left, questions as grey rows, no preview"), not what it
  looks like. `/__asset` images are content-hashed and immutable, so a desc written once
  never goes stale. Whoever uploads writes it. Not rendered anywhere — agent-facing only.
- **Tiles: never cache prototype meaning on the node — the PROTOTYPE owns it**, as a
  one-line `<meta name="description">` in its own `index.html`, updated in the same commit
  that changes the prototype (that is what kills staleness — a tile-side description is a
  cache of a living artifact that nobody refreshes). To read them: `/__canvas/catalog.json`
  carries `desc` for every top-level prototype; canvas-owned screens aren't in the catalog —
  fetch the tile's `url` (same-origin, cheap) or run `canvas-screen.mjs ls`, which flags
  opaque screens and desc-less images. The tile's `name` + surrounding stickies keep
  carrying the board-contextual claim ("BEFORE: input manager").
- **The rubric is global, this line:** *state the claim the node makes.* A board that needs
  special description instructions gets an "Agents: …" sticky on the board itself — agents
  read the whole doc anyway; no schema for rubrics.
- **Triage + disclose (Rob's standing rule):** descriptions exist so you can judge what's
  worth opening — but before writing conclusions next to tiles you haven't opened, either
  open them or SAY what you skipped. Silent skipping is the failure that created this rule.

## Architecture — hand-rolled, three layers, native to Augur's vanilla-JS stack

1. **Canvas engine** — one "world" layer, one CSS transform (`translate(x,y) scale(z)`); nodes
   absolutely positioned in world coords; pointer pan/drag/select; rAF-batched transform
   writes. DOM is plenty at this scale (tens–low-hundreds of nodes); no WebGL. Virtualize only
   if boards get big (not v1).
2. **Node registry** — pluggable node types, each `render + serialize`. Every box resizes from
   **all four corners and all four edges** (a text box has no draggable height, so it takes the
   e/w edges only) and every text-bearing node takes **rich text** (selection-level
   bold/italic/strike + bullet/numbered lists, `node.rich`). Today: `sticky`, `text`
   (auto-adapt `max-content` until resized, then fixed-width wrapping + node-level color/fontSize/bold/italic/strike/align),
   `image`, `tile` (prototype embed), `arrow` (kinds: straight/elbow/curved/line), `draw`
   (freehand marker/highlighter/washi strokes), `shape` (16 geometries + centered editable
   text), `section` (background container), `table` (plain white grid; blue + strips on
   select add row/col), `stamp` (emoji, picked from a radial wheel; "+1" renders styled).
3. **Board document** — JSON `{id, name, nodes:[…], focus:{…}}` in KV, keyed by the canvas
   file's URL.

## The one real performance rule

The infinite canvas is cheap; **live prototypes = iframes are the only heavy thing.**
Since 2026-07-23 tiles are **ALWAYS LIVE** (the poster-at-rest model looked broken and
predates multiplayer): mounting is IntersectionObserver-gated (only tiles near the
viewport mount; posters remain as the placeholder for unseen tiles) with a
`MOUNT_BUDGET` LRU backstop that quietly unmounts offscreen tiles. Posters reuse
the poster stack (`scripts/shoot.mjs` / `og.mjs`).

## Option-drag = duplicate (added 2026-07-30)

Hold Option and drag a node (or a whole selection) to leave a copy behind — the Figma/Miro
idiom. Every node shows the copy cursor while Option is held, so the gesture is discoverable
rather than folklore.

- ⚠️ **Option is a LIVE modifier, checked continuously for as long as the drag lasts — NOT a
  decision made once at pointerdown.** The first version read `e.altKey` at pointerdown only,
  which looked right in a test that held Option first and did nothing at all for the way people
  actually move: press-and-drag, then reach for Option a moment later. Press it, release it,
  press it again, any number of times mid-drag; `altCopySync()` owns the flip and is called from
  both `pointermove` and the Alt keydown/keyup (so it works with the mouse held still).
- **Entering:** the copy is born exactly where the drag has GOT TO and the original snaps back to
  where it started — the node under your cursor stays under your cursor. **Leaving:** the
  original takes over from wherever the copy had got to and the copy is deleted, so the drag
  carries on without a jump and releasing Option early is a clean plain move.
- **The originals keep their ids throughout.** Deep links (`#n=<id>`), comment threads and a
  tile's prototype folder all stay attached to the node that was already there — the thing
  you're placing is the new one.
- Copies are only ever made once the drag has actually **MOVED**. An Option-*click* that never
  moves must not leave an invisible duplicate stacked on the original.
- Dragging a **section** carries its contents, so Option-dragging one duplicates the section
  *and* its children (the drag was already armed with `withSectionChildren`).
  ⚠️ **⌘D does not** — it duplicates only the selection, so ⌘D on a section still gives you an
  empty section. Known asymmetry, left alone deliberately; fix it in `duplicateSelection` if it
  starts biting.
- After the split, snapping is re-armed on the copies — which makes the ORIGINALS valid snap
  targets, so a duplicate aligns to the node it came from.
- `cloneNode(n, dx, dy)` is shared with ⌘D. It leans on `histClone` for the deep-copy of
  `points`/`cells`/`crop`, so a copy never shares a mutable container with its original.

## Clipboard (⌘C · ⌘X · ⌘V — added 2026-07-30)

The payload rides the **system clipboard**, not a JS variable — that's the whole feature. ⌘C
serialises the selection to `{tag:"augur.canvas/1", origin:<board path>, nodes:[…]}` as
`text/plain`; ⌘V is a `paste` **event listener** (the only way to read clipboardData without a
permission prompt) that parses it back. So a second board in a second tab, another window, or
tomorrow, all paste the same thing.

- **Images cross for free** — an image node's `src` is an absolute `/__asset/<hash>` path, so
  what travels is a URL, not pixels. The trip that does NOT work is a **different origin**
  (`/__asset` is per-site; the node would land on a 404). Deliberately unsolved.
- ⌘V also accepts non-canvas clipboards: an **image** (screenshot, "copy image") goes through
  the same compress + `/__asset` upload a drop gets; **plain text** becomes a text node. Paste
  doing nothing read as broken.
- **Paste lands centred on the pointer**, not at the source coordinates — which mean nothing on
  another board. Repeat-pasting without moving the mouse walks the copies diagonally.
- ⌘X only deletes the originals **after** the clipboard write resolves — a failed write that had
  already deleted would be data loss with no undo affordance.
- **A pasted node is REBUILT field by field, never spread in** (`clipSanitize`). The clipboard is
  untrusted input, and whatever we accept goes into shared KV and out over the room socket into
  everyone else's DOM — a bad paste is stored XSS for the whole board. Known type, fresh id,
  numbers coerced, enums whitelisted, `rich` through `sanitizeRich`, **`color` hex-only**
  (renderShape/renderDraw concatenate it into innerHTML), and `image.src` / `tile.url` held to
  **same-origin paths** — no scheme, no protocol-relative `//host` (a tile is an *iframe*).
  ⚠️ The first cut of this restricted `image.src` to `/__asset/<hash>` because that's what the
  schema row above used to say. Most real images are repo paths, so copying them dropped every
  node and ⌘V answered "nothing pasteable". **Validate against a live board, not the doc** —
  `curl '<site>/__board?path=<board path>'` is public and takes two seconds.
- Undo/redo and multiplayer need nothing: `addNode` + `scheduleSave` means the diff tick picks
  the new nodes up as upserts and the history snapshot records them as one step.
- ⚠️ **`sanitizeRichEl` parses in a DOMParser document, on purpose.** Assigning untrusted markup
  to a live element's `innerHTML` — even a detached one — loads its resources *immediately*, so
  `<img src=x onerror=…>` fires before the strip-walk ever reaches it. Parse inert, clean, then
  hand the cleaned markup (whitelisted tags, zero attributes) to a live element. Don't "simplify"
  this back to `box.innerHTML = html`.

## Copy as PNG (⌘⇧C — added 2026-07-31)

A picture of the selection, straight onto the system clipboard, so a board can be pasted into
a chat without a manual screenshot. Also the camera button on the selection toolbar (that bar
is single-selection only, so multi-select capture stays keyboard-only). It **re-renders** the
nodes rather than grabbing the screen: 2x the node's NATURAL size regardless of
`board.view.scale` (a tile you're reading at 30% still comes out crisp), exact node bounds, no
permission prompt. The rasterizer is ~350 lines in **`src/canvas/capture.js`**, exposing one
board-agnostic `nodesToPng({els, rect, scale, background, poster, onInfo})`; `canvas.js` lazy-loads
it from `/__canvas/capture.js` on the first ⌘⇧C, so no board's `index.html` gains a script tag
and a session that never uses it pays nothing.

- **SCREENSHOT semantics, deliberately unlike Figma's** cut-out-on-transparency: the frame is
  the selection's box + a 12px bleed, holding *everything visible in that rectangle* — paper,
  dot grid, and every node that overlaps it. A note on a section brings the section's colour
  with it, which is what ⌘⇧4 would have given you. **Stripped as chrome:** selection rings,
  resize handles, the tile hit overlay and drag grip, peer selection/focus rings. Peer cursors,
  presence chips, the floating toolbar and comment pins need no stripping at all — they live
  outside `#gvc-world` (on `body` or in the review overlay's shadow root) and are never cloned.
- **Kept as content:** tile name chips, section labels and image name labels — rendered at
  their 100%-zoom size (their live counter-scale is reset), and the capture box GROWS upward to
  hold them, or the shot slices the name off the top.
- **Three layers, composited, so one bad node degrades instead of killing the shot:** paper +
  dot grid drawn natively into the 2D context; the nodes cloned into a mini-world at scale 1 and
  rasterized through `<foreignObject>`; then each live tile rasterized in its OWN isolated pass.
  Tiles are separate because a framed page carries its own stylesheet, which would leak over
  every other node in a shared document. The node passes are **cut at each tile** so z-order
  still holds (a note dropped on a prototype stays on top of it).
- **Fallback chain for a tile:** live frame → the tile's poster (`node.thumb || url +
  "preview.webp"`) → a neutral placeholder. The poster is what the node pass draws in the frame
  box anyway; a successful live pass simply paints over it.
- Clipboard failure **downloads the PNG** instead and says so. A ~40MP cap halves the scale
  rather than emitting a broken blob.

**Gotchas (each bought with a real bug):**
- ⚠️ **The SVG must be a `data:` URL, never a `blob:` URL.** An `<img>` loads the same SVG from
  either, but the blob one **taints the canvas** (opaque origin) — and the taint only surfaces
  at the very end, as `toBlob` throwing `SecurityError`. Verified in Chromium: data = clean,
  blob = tainted.
- ⚠️ **A rasterizing SVG is frozen at time ZERO**, so `animation: rise .45s both` is caught at
  its FIRST keyframe — usually `opacity: 0`. A slide deck came out as an empty panel with only
  its `position:fixed` nav and footer drawn. The fix is `animation-duration:0s` +
  `animation-delay:0s` (NOT `animation:none`), which lands every animation on its END state.
- ⚠️ **Nothing is fetched during rasterization.** Stylesheets are read out of
  `document.styleSheets`, every `url()` in them is absolutized and swallowed as a data URI, and
  every `<img>` src is swapped for one. Anything that can't be inlined is dropped rather than
  left as a broken reference. Cross-origin sheets (`cssRules` throws) are simply skipped.
- ⚠️ **Chrome-class stripping runs on the ENGINE's nodes only.** A framed page is somebody
  else's markup, where a class called `sel` or `active` is theirs and means something.
- A clone is inert markup, so live DOM state has to be written down: `<canvas>` → `toDataURL`
  as an `<img>`, input/textarea/select values → attributes. Source and clone are walked in
  parallel (`querySelectorAll` is document order in both).
- **⚠️ ORDER TRAP in the keydown handler:** with Shift held `e.key` is `"C"`, so the plain ⌘C
  branch matches ⌘⇧C too. The PNG branch sits ABOVE it and tests `e.shiftKey`; the ⌘C branch
  tests `!e.shiftKey`. Both guards must stay.
- The comment overlay (`src/review/comments.js`) used to own ⌘⇧C: its Shift+C binding is on
  `window` in the CAPTURE phase with `preventDefault()` and never excluded `metaKey`/`ctrlKey`,
  so ⌘⇧C silently toggled the overlay on **every prototype in every instance**. Fixed 2026-07-31.

**Known limits (accepted):** while *interacting* with a tile (double-clicked into a prototype)
the iframe owns the keyboard, so ⌘⇧C does nothing — Esc out, then capture. A framed page's own
scroll position isn't reproduced. On Windows Chrome `Ctrl+Shift+C` is DevTools and can't be
intercepted by a page (macOS Chrome is free — inspect element is ⌘⌥C).

## Settled decisions (were open, now aren't)

- **Engine is a shared Augur asset**, never baked per-canvas — a canvas is a *capability*;
  instances stay 12-line loaders and every board upgrades centrally.
- **Creation has two doors** (revised 2026-08-07 — was "no in-app button"). The repo way:
  agent scaffolds the loader folder (copy it, commit, push) — still how a canvas becomes a
  *published, public-linkable* prototype. The in-app way: the "＋ New canvas" folderbar
  button on Playground and every project folder, for signed-in users — see "Created
  canvases" below. Both serve the same engine and keep their contents in the same
  /__board doc.
- **Multiple canvases per opportunity** is normal. Tile-add is the insert **picker**.
- Still genuinely open: connectors that snap to nodes · frames/groups · voting/timers.

## Created canvases (the in-app "＋ New canvas" button, 2026-08-07)

A canvas needs no repo scaffold to be *born*: the loader is 12 generic lines and the
contents live in KV anyway. So folder index pages (Playground + each project folder)
carry a "＋ New canvas" folderbar button — signed-in users only (`/__me` reveals it) —
that registers `<dir><slug>/` in the `canvases` KV map via **`POST /__canvases`**
`{dir, name}` and navigates there. The worker serves the standard loader at any
registered path (404 fallthrough in the authed branch, and past the login gate for
signed-out visitors — `virtualCanvas` in `src/_worker.js`), so the page exists the
moment it's named. `NEWCANVAS_JS` (build.js)
also appends a card per registered canvas under the current folder, with a remove
button (`POST /__canvases {path, remove:true}` — the board doc is left in KV, so
recreating the same name restores the board).

The limits, by design:

- **Created canvases are public** (2026-08-07), same obscure-share-link model as
  published prototypes — the loader is served past the gate, and `/__board` +
  `/__rt` were always open. Boards under an admin-only space stay sealed
  (`isRestrictedPath` runs first). Materializing — committing the 12-line loader at
  the matching repo path (e.g. `playground/<slug>/index.html` or
  `<folder>/prototypes/<slug>/index.html`) and removing the registry entry — is now
  purely about promoting a board to a real repo file, not about shareability.
  Contents carry over untouched — the board doc is keyed by URL, and the URL
  doesn't change.
- **Creation refuses to shadow shipped files** (any non-404 at the target URL) and
  refuses the site root; dirs are slug-segment paths only.
- The registry is one KV key (`canvases`), same frugal pattern as statuses/names:
  one get per folder-page view (and one per 404 — real page loads never pay for it).

## The plumbing (what's where)

- **Engine:** `src/canvas/canvas.js` + `canvas.css` (this repo), emitted to `dist/__canvas/`
  by `build.js`, served public via `isPublicPath()`. The js header carries a section MAP.
  `capture.js` rides along in the same copy step — it is on NO page, `canvas.js` fetches it by
  absolute path on the first ⌘⇧C.
- **Board doc:** the AUTHORITATIVE copy lives in the BoardRoom DO's SQLite storage (see
  Multiplayer); worker `boardApi` (`/__board?path=<url>`, KV key `board:<path>`, 20MB cap)
  serves the KV **mirror** — the public GET, and the solo-fallback write, which the room
  folds back in (version-ruled) on its next cold load. **PUBLIC route** (a canvas is a
  published prototype — no login to load).
- **Images:** worker `assetApi` (`/__asset`), KV `basset:<sha256[0:40]>`, content type in
  metadata, immutable cache headers, dedup on identical bytes. Nodes carry the URL; data-URL
  srcs are the legacy/fallback form and still render.
- **Room:** `realtime/` — a separate worker (BoardRoom DO), deployed with
  `npm run deploy:realtime` (NOT via Pages CI — redeploy it yourself when you touch it).
  Its name + board KV live in the SHELL's `realtime.wrangler.toml`, one per instance
  (`realtime/wrangler.example.toml` is the template; `REALTIME_CONFIG` in `.env.deploy`
  points at yours). The Pages worker proxies `/__rt` → it, so clients stay same-origin.
- **Comments overlay:** two guarded hooks in `src/review/comments.js` (`pinXY`/`anchorAt`
  prefer `GVCanvas` world coords); the engine dispatches a window `scroll` on every transform
  so the overlay repositions. Pages without `GVCanvas` are byte-identical.
- **Instances:** e.g. `<space>/<opportunity>/prototypes/<board>/index.html` — a ~20-line loader
  (`window.GV_CANVAS = {name}` + the two engine tags). Copy an existing board folder to make a new one.
- **API:** `window.GVCanvas` = board + nodes()/addNode + screenToWorld/worldToScreen/
  onTransform/setTool — what the collaboration skill and the comment overlay drive.

## Multiplayer (2026-07-23) — every canvas is a live room

**The model.** A `BoardRoom` Durable Object per board path (the same key as the KV doc) relays
cursors, presence, node ops, live selections, and editing focus between everyone on that board
— and **the room OWNS the document** (2026-08-07; was "persists while live" since 07-27): the
doc lives in the DO's own SQLite storage (one row per node + a meta row with name/tombstones),
loaded before every welcome, written on every accepted ops batch, migrated lazily from KV the
first time a pre-rewrite board is touched. KV gets a **write-through mirror** on the old
cadence (dirty flag → 45s alarm → put; last-one-out flushes immediately; failed writes re-arm
and retry) and is folded back in on every cold load, so solo clients and terminal scripts that
wrote `/__board` while the room was empty are never steamrolled. Ops apply under
**version-checked last-writer-wins**: a write must out-version (`v`, then `vn`) what the room
holds; losers get a corrective op back; deletions leave tombstones that stale upserts can't
cross; a `{t:"doc"}` seed is **reconciled per-node, never adopted wholesale** — which is what
killed the whole "stale tab reverts the board" failure family. `/__test/` rooms stay RAM-only.
Clients POST `/__board` only as the **solo fallback** (socket down or provably stale — the
client force-closes a half-open socket whose pongs stop). Strictly an **enhancement layer**:
if the socket can't connect, the canvas behaves exactly as solo. Public like `/__board` (the
board is the credential). ⚠️ Room-side behavior needs the realtime worker redeployed per
instance (`npm run deploy:realtime`); the engine client is compatible with older rooms in the
meantime.

**The pieces:**
- `realtime/` — the room worker (BoardRoom DO, WebSocket Hibernation API). Deployed
  **standalone**, NOT via Pages: `npm run deploy:realtime` (Pages can't define DO classes).
  **One worker per instance** — rooms are keyed by board path, so two instances sharing a
  worker would share rooms *and* board storage. The engine carries only the code; the
  worker's name and its `BOARD_KV` binding come from the shell's `realtime.wrangler.toml`
  (template: `realtime/wrangler.example.toml`), and the site finds it through
  `realtimeOrigin` in `deploy.config.json`. Protocol documented at the top of its index.js.
- `src/_worker.js` `rtProxy` — `/__rt` proxies the WebSocket same-origin to that worker (no
  hardcoded URL in the engine; works offline too, where it reaches the REAL prod rooms — same
  live-KV-while-offline posture as the overlay data).
- `src/canvas/canvas.js` "multiplayer" section + `canvas.css` tail — the client layer. **No
  hooks in the mutation paths**: a 120ms diff tick compares each node against a shadow
  signature (long strings collapsed, so image boards stay cheap) and broadcasts
  `upsert/del/name` ops; applying a remote op writes the shadow FIRST so the tick never echoes.
  Conflicts are per-node last-writer-wins; a node you're dragging/editing ignores remote writes
  (the tick then re-broadcasts your version). `board.view` is per-user and never synced.
  Geometry-only remote changes patch styles on the live element (`.gvc-remote-move` tween)
  instead of re-rendering — smooth drags, no iframe/image churn.
- **Cursors** — ONE glyph for everybody: the custom arrow from piti mode
  (`pitis/piti.js` CURSOR_SVG), tinted per visitor from the room's palette. Your own OS
  pointer wears it too (your color, via injected style; tool/text cursors still win), peers
  render it with a name pill. Cursor layer lives OUTSIDE `#gvc-ui` so ⌘. keeps people visible.
  Names come from `/__me` (login), else "Guest".
- **Follow mode (2026-08-06, FigJam-parity)** — every client publishes its camera as
  `{t:"view", v:{x,y,s,w,h}}` (throttled ~10/s off `applyTransform` + resize, change-gated,
  kept on the socket attachment so a fresh follow syncs before the peer next moves). Click a
  presence chip → your camera soft-lerps to *their viewport*: their visible world rect fitted
  into your window, pan AND zoom, tracked live. Chrome while following: a border around the
  whole viewport + a top-centre "Following ‹name›" pill with a Stop button, both in the
  peer's identity color, plus the haloed chip. Your own pan/zoom/space-drag (or Stop, the
  chip, the peer leaving, a socket drop) breaks it. Agents publish no viewport (a daemon has
  no window) — following one falls back to the old centred cursor chase. Following chains
  (A follows B follows C) just work: B's chase moves B's camera, which B publishes.

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
replay (scroll events are always trusted; the window is their only guard). Tile chrome:
a name chip floats ABOVE the tile, counter-scaled (`scaleTileChrome`) so it
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
self-heal — the doc cache drops when empty — but don't rely on that.) Reference test
pattern: two browser contexts joined to one ISOLATED room (the clobber above), then
mount/interact in one and assert the mirror in the other.

## Session: the shared timer + music (2026-08-05)

The top-right corner is ONE white card holding the whole room: the presence avatars (humans
and Clawd agents alike) and a **session inset** (mini record + seven-segment time — light
border idle, lavender fill live) that opens a *Timer and music* panel. One timer and one track per board, the same for everyone; anyone can
drive it, like every other shared surface here. Start / pause / resume / stop / +1 min, up to
99:59; the digits are editable when idle (`7` → 7:00, `7:30` → 7m30s). At zero the pill and
digits shake, read a red 00:00 for everyone (panel open or not), and a short synthesized chime
rings — same per-user volume/mute as the music, silent for anyone the autoplay policy hasn't
unlocked yet. `+1 min` on a timer that already rang restarts it.

**The face (2026-08-05, FigJam-parity pass):** the clock renders in the DSEG7 seven-segment
font (`/__canvas/DSEG7Classic-Bold.woff2`, SIL OFL, license alongside — the input sits over an
unlit `88:88` ghost with identical box metrics); timer controls are circular with dark hover
tooltips (`data-tip`); the music section is an SVG **turntable** (record + grooves + label art,
tone arm, speaker grill) that spins and swings the arm on while playing; the track picker is a
dark popover whose rows carry the label art, selected row lit + checked. The **pill's** state
matrix: counting → live digits · music playing, no timer → track name + a per-user quick-mute
speaker · idle → the pending duration as ghost digits. Picking a track while playing switches
the room's track; while stopped it only selects locally.

**It is not board content.** Session state lives on the room (`ctx.storage` in the DO), never in
the document — no node, no ops tick, no undo, no KV doc write. `{t:"timer",do:…}` /
`{t:"music",do:…}` go up; the room broadcasts `{t:"session",timer,music}` to *everyone including
the sender*, and hands it to late joiners on `welcome`.

Three rules that were each bought with a bug:

- **The wire carries REMAINING ms, never a deadline.** Clients stamp arrival with
  `performance.now()` and count down locally. No clock agreement needed, and a board with ten
  people costs ten messages per *click*, not per second.
- **No alarm.** The DO has one alarm slot and it belongs to the KV persist rail. Expiry is
  computed client-side. A timer that borrowed the alarm would silently cancel a pending
  document write.
- **Session mutations are serialized** (`sessQ`). Two people hitting `+1 min` in the same tick
  must stack, not overwrite.

### Music is a hook, not content — the engine ships no audio

The picker is built from `/__canvas/tracks.json`, accumulated at build time from each space's
`tracks/` folder (same pattern as the insert-picker catalog) with ids namespaced `<space>:<id>`.
A space authors `tracks/tracks.json` as `[{id,name,file,duration,color?,motif?}]`; `duration`
(seconds) is what lets every client seek to the same point. `color` (CSS color) and `motif`
(one of the engine's abstract label drawings: `bird` · `face` · `burst` · `scribble` ·
`gridsun` · `sail`) dress the track's record label and picker icon; omitted, both derive
deterministically from the id hash — mind the `>>>` (a signed shift on a big hash indexes
nothing). No tracks installed → the turntable renders grayed + inert with a caption and the
timer is unaffected. Volume and mute are **per-user, localStorage, never synced**.

Position sync is the fiddly part, and every one of these was a silent failure:

- **Seek on the `playing` event**, not when you decide to. A paused element accepts a seek and
  then *sits* there (loading, or blocked by autoplay); every second it waits becomes a permanent
  offset once it starts.
- **Gate on `seekable`.** An origin that doesn't serve byte ranges makes the whole resource
  unseekable and the browser *drops every assignment without raising* — playback carries on and
  looks correct until you measure it. `wrangler pages dev` is such an origin, so **music position
  does not sync in offline preview**; Cloudflare Pages serves ranges, so it does live.
- **Dead zone 0.25s, not 1.5s.** This isn't a continuous drift corrector, so a loose dead zone
  smooths nothing — it just bakes the joiner's connection delay in as a permanent, audible offset.
- Re-run `sessApplyMusic()` when the manifest lands: the tracks fetch can lose the race against
  the room's welcome, and a welcome naming a track you can't resolve yet is dropped.
- Autoplay policy blocks a joiner who hasn't clicked. Don't fight it — mark it (the play button
  shows a waiting state) and let their next click anywhere on the board start playback.

**`tracks/` is gitignored in the space repos by design.** Audio you may listen to is not audio you
may redistribute, and the space repos build a public site. Personal listening material lives there
un-committed and plays in offline preview only.

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
- `add <canvasUrl> <slug> [--title "T"] [--desc "one-line claim"]` — create the subfolder
  (+ a starter `index.html` with the `<meta name="description">` scaffolded — the screen's
  agent-facing meaning, see the description contract above) and place the tile. Then **write
  the real prototype into that index.html** (updating the meta description with it) and
  commit + push the space repo. Lives at `<site>/<opp>/<canvas>/<slug>/` once deployed.
- `dup <canvasUrl> <srcSlug> <newSlug> [--title "T"] [--tile "name"]` — **fork** an owned
  screen: copy the folder and repoint the duplicate tile at it. This is the terminal half of
  Rob's rule "duplicate the tile ⇒ duplicate the folder": Cmd+D in the canvas clones only the
  TILE (named "… copy", pointing at the SAME folder — the browser can't write git), so **any
  agent asked to change a duplicate must run `dup` FIRST** (it repoints the "… copy" tile, or
  `--tile <name>`, at the fresh fork), then edit the fork and commit + push. Never edit a
  folder two tiles share unless the change is meant for both.
- `rm  <canvasUrl> <slug>` — remove the tile **and** delete the folder (the ownership coupling).
  Commit + push so the deletion ships.
- `gc  <canvasUrl>` — the **browser half of the remove coupling** (decided 2026-07-27): deleting
  a tile in the canvas UI can't delete the folder, so the folder lingers as an orphan. `gc`
  deletes orphaned folders after a **1-hour grace** (covers a ⌘Z that brings the tile back),
  anchored at the first gc run that noticed the orphan (the board doc carries no deletion
  times). **Run it whenever you start working a canvas**; commit + push if it deletes.
  Grace state: `godmode/.canvas-gc.json` (local only, never in a repo).
- `ls  <canvasUrl>` — reconcile view: nested screen folders vs board tiles; flags an orphaned
  folder (no tile), a dangling tile (no folder), and the board's **opaque nodes** — screens
  without a meta description and image nodes without `desc`.

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
- **The humanized verbs (2026-07-27) — PREFER THESE over raw upserts for visible work:**
  `await c.dragNode(id, x, y)` — walk over, grab (focus ring), node + cursor travel together
  (the cursor.drag fast-path), durable upsert on release. `await c.typeNode(node)` — create
  and TYPE the text word-by-word under your focus ring (`node` carries final text + optional
  rich; conversational scale only — bulk seeding stays instant). `c.sel(ids)` — point with
  selection rings ("these three"). `c.status(text, 'working'|'idle'|'attention'|'done')` —
  the status behind your **avatar chip** in the top-right presence row, one click away in
  your agent card (attention rings the chip amber + makes it jump = you need the
  human; done flashes green; the strip is how Rob works with the terminal hidden — keep it
  current). `c.chat(text)` — cursor-chat bubble (a moment; status is the state).
  `c.follow(name)` / `c.unfollow()` — trail a human at a respectful offset (accompany mode).
  Both `dragNode` and `typeNode` are POLITE: they `waitUnheld()` while a human has the node
  focused/selected. Daemon commands mirror all of these 1:1 (`move`, `type`, `sel`,
  `status`, `attention`, `done`, `chat`, `follow`/`unfollow`, `progress` for stub labels).
- **Humans can talk back on the board:** "/" opens cursor chat; every line a
  human types is appended to `<cmdfile dir>/clawd-events.jsonl` by the daemon (with command
  errors) — **read that file at the start of a turn** to hear what was said to you.
- **Lifecycle is automatic:** the daemon walks IN beside the content on launch, auto-idles
  (sleep pose + idle status) when the session transcript goes quiet, wakes on activity, and
  after `--linger` ms of a dead session says goodbye and walks out (default 3h; 0 = never).
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
  nohup node scripts/clawd-canvas.mjs daemon <boardPath> <cmdFile> \
    > <scratchpad>/clawd-daemon.log 2>&1 & echo $! > <scratchpad>/clawd-daemon.pid; disown
  ```
  Identity is deterministic — derived from the session's cmd-file path — so do NOT pass
  `--name` (the daemon refuses it; it's reserved for sibling agents launched with `--sibling`).
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
  brand-new board (use a full-state seed script while the board is closed), or when explicitly
  told to work silently. Full-state `POST /__board` writes only the KV mirror, and the room
  folds it in **per-node, version-ruled** on its next cold load — so on an EXISTING board a
  seed script must bump each node's `v` above what it read, or its changes read as stale and
  the room keeps its own copies (see "Versions" under the node schemas).
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
- **A canvas instance IS a prototype**: `<space>/<opportunity>/prototypes/<board>/index.html` (a
  ~20-line loader) → lives at `/<opportunity>/<board>/`. Make more by copying an existing board
  folder (or via the in-app "New canvas" button).

**Dev loop**
- `npm --prefix augur run offline` (run in the background) → http://localhost:8788/<opportunity>/<board>/
  (sign in with an admin account if the site chrome asks). It watches sibling clones
  + Augur and hot-reloads (~1s). ⚠️ **Offline KV is LIVE prod** — board/overlay writes are real.
- Edit `src/canvas/*` — the offline watcher now watches `src/canvas` + `src/review`, so it
  hot-reloads (~1s). `/__canvas/*` is served **`no-store`** (see `withAssetCache`), so a **reload**
  gets the fresh engine — no hard-refresh dance, no stale-JS ghosts (that bit twice: new CSS + old
  JS looked like "my fix didn't work").
- **Ship**: commit + push per repo to `main`. **Augur first** (engine/worker/build/catalog — its
  push auto-deploys via the engine pin bump), THEN the space repo (push saves the page; the page
  goes LIVE via the space's `augur publish`, not the push). Stage ONLY your paths (shared checkout, never
  `git add -A`); commit trailers per `augur/CLAUDE.md`. Bump `UI_VERSION` only when you touch
  `comments.js` / the build shell (busts the `?v=` on injected overlay scripts).
- **Playwright IS available** via a sibling space clone's `node_modules/playwright` (+ cached
  chromium) — drive it against offline OR the live URL (the canvas page + `/__canvas/*` + `/__board`
  are all public). **Always block `POST **/__board`** in tests (`route(...).abort()`
  on POST) so you never pollute the shared live board; the board loads read-only. This is how every
  canvas fix this session was verified before reporting — do the same, don't reason blind.

**Gotchas (each bought with a real bug)**
- SVG nodes: build via an innerHTML string (or `createElementNS`), never `createElement("svg")`
  (no namespace → never paints).
- **A node must never be a native HTML5 drag source.** The browser starts its own drag from a
  node's text run (and from `<img>`), which paints a ghost copy under the cursor AND fires
  `dragover` — so dragging a **text** node lit up the full-screen "Drop image to place it"
  overlay mid-drag. Two guards, keep both: `dragstart` on anything inside `.gvc-node` is
  `preventDefault`ed (except while the node is `.editing`, where dragging a text selection
  inside the box is a real affordance), and the drop overlay only answers to a drag actually
  carrying files (`dataTransfer.types` contains `"Files"`). The canvas moves nodes with its own
  pointer handlers; the native drag machinery has no job here.
- **Resize handle needs a real starting size.** `startResize` reads `node.w/h` for `ow/oh`, but
  some nodes (text) carry neither until first resized → `ow + dx = NaN` and the handle silently
  did nothing. Fallback to the host's measured `offsetWidth/Height` when `node.w/h` are null. Text
  is width-only on resize (clear `style.height` → auto) so it wraps + grows naturally; only
  `renderText` applying `node.w` when present makes the width survive a re-render/reload.
- **A clipping host eats its own resize handles.** Corner handles straddle the node's edge, so any
  node whose host is `overflow:hidden` (stickies were) shows quarter-circles or nothing at all.
  Clip in an INNER wrap (`.gvc-stickyin`) and leave the host visible. Same reason `.gvc-image`
  never clips at host level.
- **Decor doesn't inherit the zoom fix.** Handles are world-space children, so at 40% zoom a 13px
  handle paints at 5px. `scaleDecor` counter-scales them (`transform: scale(1/zoom)`, origin
  centre, position `left/top: 0|100%` + a half-size negative margin so the centre sits exactly on
  the corner) and is registered on `transformCbs` — same trick as tile/section chrome.
- **An edge handle can only counter-scale ONE axis.** The n/s/e/w handles are invisible 8px strips
  spanning a whole side, so `scale(1/zoom)` would shrink their LENGTH too and they'd stop covering
  the side. They get `scaleY(1/zoom)` (horizontal strips) or `scaleX(1/zoom)` (vertical) instead:
  constant 8px screen thickness, full-length always. They sit at `z-index:2` under the corners, so
  the last ~13px of each side still gives you the two-axis corner grab.
- **The resize math is direction-driven, and a one-letter direction is not a corner.** The drag
  branch derives `west/north` (which side is pinned) plus `doW/doH` (which axis moves at all) by
  explicit membership — inferring them from character positions (`dir.charAt(1) === "w"`) silently
  mis-reads `"w"` as not-west. An edge freezes the other axis at its drag-start value, and Shift's
  aspect lock is corner-only: applied to an edge it would move a side you never grabbed.
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
  `node.hFixed` and the box stops hugging.
  **A sticky shrinks its TEXT before it grows its BOX** (`fitStickyFont`, FigJam's model and the
  reason a sticky reads as a sticky): the size on the dropdown is a CEILING, and the text steps
  down `STICKY_FONT_RAMP` until it fits. Only when the bottom rung still overflows does the note
  grow. Two traps: (1) fit against the height the note WANTS — `STICKY_H` in auto mode, its own
  height once `hFixed` — never the current grown height, or the fit feeds back into itself
  (grow → text fits bigger → shrink → repeat). (2) `STICKY_PAD_V` must track `.gvc-stickyin`'s
  vertical padding in the CSS, or every fit measures the wrong box. The walk starts from the size
  already applied (cached on `txt.dataset.fit`), so a keystroke costs 1-2 reflows, not 16.
  **A sticky's auto floor is the size it was dropped at** (`STICKY_H`), not the CSS `min-height`:
  with the CSS floor, typing two words into a fresh 160px note collapsed it to 96 — the note you
  dropped is the note you should still have. The floor is skipped when `hFixed` (a height you
  dragged is yours) and on render (`allowShrink` false), so no existing board is regrown on open;
  an old collapsed sticky pops back to the floor the next time you edit it. A shape's text is inset 12% a side (hence `/0.76`) and
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
  `board.view`, call `saveView()`, NOT `scheduleSave()`. The client POST only runs as the
  SOLO fallback — the BoardRoom DO owns the doc (its SQLite storage) and writes the KV
  mirror itself (see `realtime/src/index.js`: `applyOps`/`markDirty`/`alarm`/`mirror`,
  flush on empty, `/__test/` rooms exempt). The solo save is honest since 2026-08-07: it
  confirms the 2xx before marking the doc saved, retries with backoff, ships `keepalive`
  so a close-during-save still lands, and beacons on `pagehide` too; a failed board LOAD
  holds saves off entirely (an empty stand-in must never overwrite the real board).
  Playwright note: blocking `POST /__board` no longer
  proves "no KV writes" — the room writes server-side; test rooms must stay under
  `/__test/`, and blocking the socket needs a WebSocket-constructor stub (HTTP routes
  don't intercept upgrades).
- **Undo must be per-USER, not per-document, in a live room.** Restoring a whole-board snapshot
  would silently revert whatever a teammate did in the meantime. `histCommit` diffs the board
  against a shadow on the save debounce and records only the nodes that changed, as
  `{before, after}` pairs; `mpApplyOps` folds every REMOTE change straight into that shadow
  (`histSeen` / `histForget`), so a peer's work never enters your stack. Adopting a room doc
  (`mpAdoptDoc`) folds each remotely-changed node through the same `histSeen`/`histForget`
  rail — identical protection, and since 2026-08-07 your undo stack SURVIVES a reconnect
  (adopt is a per-node diff now, not a wholesale replace that wiped both stacks and
  re-rendered every element). Inside a text box the browser's own undo wins (the global
  handler returns early while `editing`).
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
  world transform). Tiles are **always-live**: iframes mount on viewport approach
  (IntersectionObserver) under `MOUNT_BUDGET` (16); offscreen tiles beyond the budget quietly
  return to their poster (LRU by last sight) and remount on sight. `node.live` (the old shared
  Stop/Live) is ignored.
- The board endpoints are **public by design** (a canvas is a published prototype).
- **Interaction model**: empty drag = marquee multi-select; pan = scroll/trackpad or Space-drag /
  hand tool. Don't revert to drag-to-pan. **Exception — touch**: one finger on empty canvas pans,
  two fingers pinch-zoom (phones have no trackpad/marquee need); armed tools still act on one
  finger. A second finger landing mid-stroke cancels the stroke (it's the palm) and pinches.
- **The main toolbar** (rebuilt 2026-07-22, pixel-verified against the reference screenshots):
  tool state is one `TOOL` object (`setTool()`), sub-toolbars sync from it (`syncBars()`). Shortcuts:
  V select · H hand · M marker (⇧P too — "pencil") · S sticky · T text · E stamp (radial wheel picker) ·
  R square · O circle · L line · X elbow · ⇧S section · ⇧T table · C comment · Esc back to select.
  (⌘⇧C, ⌘C/⌘X/⌘V and ⌘D/⌘Z/⌘⇧Z are handled ahead of the tool letters, so ⌘C never toggles comments.)
  Drawing keeps the marker armed; shapes/sticky/text/table place once then return to select; stamps stay
  armed. The eraser deletes whole `draw` strokes only. Sections render behind
  everything (`insertBefore`). The illustrated pen/sticky/cluster arts are inline SVGs in
  canvas.js (`PEN_ART`/`STICKY_ART`/`CLUSTER_ICON`) — keep gradients/ids unique, they're
  singletons in the bar; they hang below the pill and are clipped by `.artclip`, lifting on
  hover. Small line icons are **Lucide** (the shadcn set) via `lucideIcon()` — extend
  with Lucide paths, don't hand-draw new glyphs. The **speech-bubble tool is the comment
  layer**: it dispatches the overlay's own Shift+C keydown (`toggleComments()`), no new node
  type. Default sticky color is the soft blue (`#a9cbf5`).
- **Deep links to one node** (2026-07-28): the last button on the selection bar (the camera —
  copy as PNG — sits just before it) — present for **every** node type — copies
  `<board URL>#n=<node id>`. Opening that link flies the camera
  to the node (`flyToRect`, fit with a margin, capped at 1:1 so a sticky doesn't slam you to
  400%), selects it and pulses it. Node ids are stable in the saved doc, so a link survives
  everything except deleting the node (which gets a toast, not a dead board).
  **The hash is CONSUMED on arrival** — `history.replaceState`'d away immediately — because
  comment threads scope themselves to `pathname + search + hash` (`src/review/comments.js`),
  so a lingering `#n=` would quietly file every comment made afterwards under a view nobody
  else is on. That's also why this isn't a `?query` param. Types with no styling controls
  (image, table, stamp, arrow) now get a selection bar for the first time, carrying the link
  button alone; `positionSelBar`/`anyRect` handle arrows, which have endpoints, not `x/y/w/h`.

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
- Connectors that snap to nodes. (The in-app "New canvas" button shipped — see "Created canvases".)
- **DONE 2026-07-23:** multiplayer (cursors/presence/live ops/co-typing) — see the
  "Multiplayer" section; NOT the old "live-KV rail" idea, a Durable Object room per board.
