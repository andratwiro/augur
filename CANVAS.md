# Canvas — a capability template for infinite-canvas boards

> **Status:** LIVE + iterating (2026-07-22). Core shipped, then many live-feedback rounds:
> marquee/space model, styled toolbar + sticky options, search picker, tile **device picker**
> (desktop/tablet/phone → real responsive preview) + **freeze-on-Stop**, **Cmd+D duplicate**,
> tile/image **rename**, and **canvas-owned prototypes** — a canvas is a *container*; a prototype
> "built on the canvas" is scaffolded (by an agent, in the terminal) into a **subfolder of the
> canvas** and auto-placed as a tile, owned by it (remove it → delete it). Spine: hand-rolled ·
> canvas = a template-born prototype file (not a platform overlay) · shared state in KV · AI-legible
> via names. **New agents: read "Working on the canvas" + "Canvas-owned prototypes" below first.**
> **2026-07-22: full FigJam toolbar rebuild** — illustrated marker + sticky + shape-cluster tools,
> draw sub-toolbar (marker/highlighter/washi/eraser · thin/thick · colors), shapes sub-toolbar
> (connectors + shape grid + More shapes), stamps, sections, tables, speech bubbles, freehand
> `draw` nodes, FigJam paper background, tool shortcuts, and **mobile/touch support** (one-finger
> pan, two-finger pinch zoom, compact toolbar). Playwright-verified ≥95% visual match to FigJam.
> Also 2026-07-22: **image crop** — double-tap an image enters Figma-style crop mode (full image
> ghosted, blue window handles, drag to slide the image under the window; click-out/Enter commits,
> Esc cancels). NON-destructive: `node.crop` = the window as fractions of the full `src`, rendered
> via percent sizing inside a clipping `.gvc-imgwrap`, so re-entering crop restores the hidden
> parts and free resize needs no JS. See the "image crop" section in canvas.js.
> **2026-07-23: MULTIPLAYER** — every canvas is a live multiplayer room (FigJam-style colored
> cursors + name pills, presence chips, live drags/edits/deletes, streamed co-typing with
> editing-focus rings). Template-level: it ships in the shared engine, so every canvas in every
> space has it with zero instance changes. Same day: **prototype demo sync** — ▶ Live/Stop/
> navigation are shared tile state, and clicks/typing/scrolling INSIDE a live prototype iframe
> mirror to the room (same-origin event replay). See "Multiplayer" below — including the
> TEST-ISOLATION rule (blocking POST /__board is no longer enough).
> **2026-07-23: text nodes grow up.** Text boxes **auto-adapt to their content by default**
> (`width: max-content` — hug the text, grow as you type) and become **fixed-width + wrapping**
> only once you drag the bottom-right handle (which sets `node.w`). Two bugs behind this: the
> handle was a no-op (text carried no `w`/`h`, so `ow + dx` = `NaN` → `startResize` now falls
> back to the MEASURED element size), and plain `width:auto` collapsed text to a one-word-per-line
> column because `#gvc-world` is **0-wide** (its containing block) — `max-content` is the fix, not
> `auto`. Text also gets the floating toolbar: **text color · font-size dropdown · Bold · Italic ·
> Strikethrough · Align (L/C/R)**. The size control is a FigJam-style **dropdown** (`#gvc-fontmenu`,
> modelled on the lock menu): presets Small/Medium/Large/Extra large/Huge rendered at their own
> scale + a **custom px input**, storing `node.fontSize` (px number; legacy `fontScale` s/m/l still
> resolved via `fontPx()`). All whole-box node styles (`bold/italic/strike/align/fontSize/color`),
> no rich-text model (link/list skipped — they'd need per-run HTML). Shared `applyTextStyle(txt,
> node)` styles both stickies + text. Next big one: the **collaboration skill**.
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

## Architecture — hand-rolled, three layers, native to Augur's vanilla-JS stack

1. **Canvas engine** — one "world" layer, one CSS transform (`translate(x,y) scale(z)`); nodes
   absolutely positioned in world coords; pointer pan/drag/select; rAF-batched transform
   writes. DOM is plenty at this scale (tens–low-hundreds of nodes); no WebGL. Virtualize only
   if boards get big (not v1).
2. **Node registry** — pluggable node types, each `render + serialize`. Today: `sticky`, `text`
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

## Scope

**v1:** engine (pan/zoom/drag/select) · sticky + text + image + tile nodes · scaffold-from-
template creation · KV persistence via the generic per-URL endpoint · thumbnail↔live tile
swap · AI-legible state (nodes + names + refs) · turn-based Claude co-work + the skill.

**Later:** connectors/arrows · frames/groups · in-app "New canvas" button (live git write) ·
multiplayer cursors/presence (same live-KV rail) · live focus/selection streaming (location-
deixis + pointing) · real-time Claude co-manipulation · voting/timers.

## Open sub-decisions

- **Engine: shared Augur asset vs baked into each canvas file.** Shared = thin instances,
  central updates, but not fully self-contained. Baked = self-contained/forkable but frozen at
  copy time. Lean shared (a canvas is a *capability*, more like the system layer than a one-off
  prototype).
- **Creation:** agent-scaffolds-the-file (v1, matches how everything is made) vs in-app "New
  canvas" button (needs a live git write; later).
- **Multiple canvases per opportunity vs one.** Lean multiple.
- **Tile-add UX:** pick from the opportunity's existing prototype cards / drag from a rail /
  paste a URL. Lean picker for v1.
- **Naming:** "Canvas" the feature, "a canvas" the file. OK, or another word?

## v1 core — what shipped (2026-07-21)

Hand-rolled, no dependencies, native to Augur's vanilla-JS stack.

- **Engine (Augur-owned, shared):** `src/canvas/canvas.js` + `canvas.css`, emitted to
  `dist/__canvas/` by `build.js` (mirroring how `src/review/` → `dist/__review/`) and served
  public via `isPublicPath()`. Pan (drag empty), zoom-to-cursor (⌘/ctrl-wheel), trackpad pan,
  node drag + resize, single-select + delete. Node types: `sticky`, `text`, `image`, `arrow`
  (free-floating, endpoint handles), `tile` (referenced prototype: `preview.webp` thumbnail at
  rest, live iframe on ▶, capped at 1 live). FigJam bottom toolbar (drag-out sticky/arrow;
  image → file picker; prototype → URL prompt), top-right back + rename, bottom-left zoom, and
  **⌘. toggles all UI**. Every node carries a `name` (AI-legibility). Image drop from desktop
  downscales to ≤1400px / JPEG q0.55 and inlines.
- **Persistence:** worker `boardApi` (`/__board?path=<url>`), KV key `board:<path>` on the
  `env.COMMENTS` binding, full-state POST (client owns the doc, like pins), 20MB cap, input-
  guarded. **PUBLIC route** (like `/__review/api`, NOT gated like `/__status`) — a canvas is a
  published prototype, so its board must load/save without login. `window.GVCanvas` exposes the
  board + `screenToWorld`/`worldToScreen`/`onTransform` for tools and the comment overlay.
- **Comments (board-anchored):** two guarded edits in `src/review/comments.js` — `pinXY()`
  prefers `GVCanvas.worldToScreen` for threads carrying world coords; `anchorAt()` records
  `cwx/cwy` when `GVCanvas` is present. The engine dispatches a window `scroll` on every
  transform, which re-runs the overlay's existing `reposition()`. Normal pages have no
  `GVCanvas` → byte-identical behaviour.
- **First instance:** `go-vocal/ux-ui-audit/prototypes/canvas/index.html` — a 12-line file that
  loads the engine and names the board. Lives at `/ux-ui-audit/canvas/`.

**Verified (platform):** build + emission, public asset serving, page loads engine + comments,
board round-trip + guards. **Pending (Rob, interactive):** pan/zoom/drag feel, sticky/arrow/
image/tile UX, comment pins tracking pan/zoom, ⌘. — the goal checklist.

**Deferred to the advanced pass:** author-a-prototype-on-the-canvas (⌘-generate HTML into a
movable `srcdoc` iframe node); connectors that snap to nodes; in-app "New canvas" button;
multiplayer cursors.

## Multiplayer (2026-07-23) — every canvas is a live room

**The model.** A `BoardRoom` Durable Object per board path (the same key as the KV doc) relays
cursors, presence, node ops, and editing focus between everyone on that board. Durable
persistence STAYS on the `/__board` KV rail, written by clients exactly as before — the room is
live session state only (it caches the latest doc so joiners start fresher than KV, and drops
the cache when the last socket leaves). Strictly an **enhancement layer**: if the socket can't
connect, the canvas behaves exactly as solo. Public like `/__board` (the board is the
credential).

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
- **Auto-adapt text = `max-content`, never `width:auto`.** `#gvc-world` (the node containing block)
  is `width:0`, so an `auto`-width absolutely-positioned text node shrink-to-fits to its *minimum*
  content width — a one-word-per-line column, not a hug. `renderText` sets `width: max-content` when
  `node.w` is null (hug + grow), an explicit px only after a resize drag.
- **Text formatting is node-level, not rich-text.** `node.text` is plain `innerText`, so styles
  (`bold/italic/strike/align/fontScale/color`) apply to the WHOLE box via `applyTextStyle` — no
  per-run markup. That's why link + list aren't in the text toolbar (they'd need a real rich-text
  model); don't bolt them on without that. `applyNodeStyle` patches the live `.gvc-txt` in place
  (never a re-render) so an active edit isn't torn down.
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
  (resolve "that", cluster, summarise). NOW the next big one; the AI-legible model + names make it
  high-leverage.
- Canvas-owned-prototype polish: an in-app "remove screen" affordance on owned tiles that records
  the deletion for the terminal to reconcile (today: `canvas-screen.mjs rm`); a poster shot for a
  new screen so its tile isn't blank until you go Live.
- Proper cache-busting for `/__canvas/*.js|css` if we move off `no-store` (today: no-store).
- Connectors that snap to nodes; in-app "New canvas" button.
- **DONE 2026-07-23:** multiplayer (cursors/presence/live ops/co-typing) — see the
  "Multiplayer" section; NOT the old "live-KV rail" idea, a Durable Object room per board.
