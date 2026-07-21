# Canvas — a capability template for infinite-canvas boards

> **Status:** LIVE + iterating (2026-07-21). Core shipped, then several live-feedback rounds
> (marquee/space model, styled toolbar + sticky options, search picker, polish). Spine: hand-
> rolled · canvas = a template-born prototype file (not a platform overlay) · shared state in KV
> · AI-legible via names. **New agents: read "Working on the canvas" at the bottom first** — file
> map, dev loop, gotchas, backlog. The advanced author-prototypes-on-canvas pass is the next big one.

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
2. **Node registry** — pluggable node types, each `render + serialize`. v1: `sticky`, `text`,
   `image`, `tile` (prototype embed).
3. **Board document** — JSON `{id, name, nodes:[…], focus:{…}}` in KV, keyed by the canvas
   file's URL.

## The one real performance rule

The infinite canvas is cheap; **live prototypes = iframes are the only heavy thing.** So:
**thumbnail (poster) at rest, live iframe only on focus/zoom-in, cap concurrent live iframes.**
Posters reuse go-vocal's capture stack (`scripts/shoot.mjs` / `og.mjs`).

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
- **A canvas instance IS a prototype**: `go-vocal/ux-ui-audit/prototypes/canvas/index.html` (a
  ~12-line loader) → lives at `/ux-ui-audit/canvas/`. Make more by copying that folder.

**Dev loop**
- `npm --prefix augur run offline` (run in the background) → http://localhost:8788/ux-ui-audit/canvas/
  (sign in `rob@govocal.com` / `augur-rob-2026` if the site chrome asks). It watches sibling clones
  + Augur and hot-reloads (~1s). ⚠️ **Offline KV is LIVE prod** — board/overlay writes are real.
- Edit `src/canvas/*`; **hard-refresh (⌘⇧R)** if a cached engine sticks.
- **Ship**: commit + push per repo to `main`. **Augur first** (engine/worker/build/catalog), THEN
  go-vocal (the page, via the auto-bump bridge). Stage ONLY your paths (shared checkout, never
  `git add -A`); commit trailers per `augur/CLAUDE.md`. Bump `UI_VERSION` only when you touch
  `comments.js` / the build shell (busts the `?v=` on injected overlay scripts).
- **No Playwright** in this checkout (a devDep, not installed) → headless browser tests need
  `npm i` first; otherwise smoke-test with curl + Rob's eyes on the live URL.

**Gotchas (each bought with a real bug)**
- SVG nodes: build via an innerHTML string (or `createElementNS`), never `createElement("svg")`
  (no namespace → never paints).
- Sticky text edit uses **manual double-tap detection** — pointer capture on the root eats the
  native `dblclick`.
- The board endpoint is **public by design** (a canvas is a published prototype; a gated board
  401s for signed-out or cross-account viewers).
- **Interaction model**: empty drag = marquee multi-select; pan = scroll/trackpad or Space-drag /
  hand tool. Don't revert to drag-to-pan.

**Backlog (pick with Rob — he reviews on the live URL and iterates fast)**
- **Advanced pass**: author a prototype ON the canvas (Claude generates HTML into a movable
  `srcdoc` iframe node; "you ask, I build it").
- Proper cache-busting for `/__canvas/*.js|css` (today: `must-revalidate` + hard-refresh).
- The **collaboration skill** — Claude reads board state + node names to co-work spatially
  (resolve "that", cluster, summarise). Enabled by the AI-legible model; not built.
- Connectors that snap to nodes; in-app "New canvas" button; multiplayer cursors (same live-KV rail).
