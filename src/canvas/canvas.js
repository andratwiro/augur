/* Augur Canvas — hand-rolled infinite-canvas engine. Served from /__canvas/canvas.js.
 *
 * A "canvas" is a prototype that mounts this engine. The board (nodes + view + name) is one
 * JSON document persisted to KV via /__board, keyed by the page URL — the same per-URL rail
 * comments use, so it isolates per-space for free.
 *
 * Model: one #gvc-world layer with a single CSS transform (translate + scale); nodes are
 * absolutely positioned in WORLD coordinates inside it; the UI (#gvc-ui) is a fixed layer
 * above, untransformed. Everything is DOM — no WebGL — which is plenty at this scale.
 *
 * The toolbar is a full whiteboard toolset: select/hand · marker (draw sub-toolbar:
 * marker/highlighter/washi/eraser + thin/thick + colors) · sticky · shape cluster (shapes
 * sub-toolbar: connectors + shape grid + More shapes) · text/section/table/stamp/bubble ·
 * prototypes · insert. Node types: sticky, text, image, tile, arrow (straight/elbow/curved/
 * line), draw (freehand strokes), shape (geometry + centered text), section, table, stamp.
 *
 * AI-legibility: nodes are plain data ({id,type,name,x,y,w,h,...}); every node carries a
 * human name so Claude and Rob share a vocabulary ("the onboarding tile"), not pixel pointing.
 * window.GVCanvas exposes the board + coordinate transforms for the comment overlay and tools.
 *
 * MAP (grep "// ----" for the section headers, in file order):
 *   state/scaffold   board state · tool state · DOM scaffold · coordinate transforms
 *   model            node helpers (add/duplicate/remove) · selection + decor (resize handles)
 *   text             render · rich text (sanitizer, node.rich) · LINE model (lists, Tab
 *                    nesting, markers) · markdown input rules · autoFit (grow/shrink)
 *   node renderers   sticky · text · image (+ nameLabel/wireRename) · tile (live iframe) ·
 *                    connectors · freehand draw · shapes · sections · tables · stamps
 *   interaction      pointer (pan/move/resize/marquee/pinch, deferred double-tap) ·
 *                    Option-drag duplicate ·
 *                    snapping + guides · axis lock · image crop · wheel/keyboard · image drop ·
 *                    clipboard (⌘C/⌘X/⌘V — cross-tab, cross-board, via the system clipboard) ·
 *                    copy as PNG (⌘⇧C — rasterizer lazy-loaded from capture.js)
 *   chrome           selection toolbar · Lucide icons · toolbar/sub-toolbars/topbar/zoom ·
 *                    insert picker
 *   data             persistence (save = SOLO fallback; camera → localStorage) ·
 *                    undo/redo (per-user snapshot-diff history) · public API (GVCanvas)
 *   multiplayer      socket + protocol · diff tick · remote ops (mpPatchGeo) · proto demo
 *                    sync · peer cursors · Clawd mascot · presence chips · follow mode
 *                    (viewport mirroring via {t:"view"} + border/pill chrome) ·
 *                    editing focus + selection rings · boot
 *
 * Deep docs + the gotchas that were each bought with a real bug: augur/CANVAS.md.
 */
(function () {
  "use strict";
  if (window.__GV_CANVAS_BOOTED) return;
  window.__GV_CANVAS_BOOTED = true;

  var CFG = window.GV_CANVAS || {};
  var BOARD_PATH = CFG.boardPath || location.pathname;
  var BOARD_API = "/__board?path=" + encodeURIComponent(BOARD_PATH);

  var MIN_SCALE = 0.1, MAX_SCALE = 4, GRID = 16;
  // A live tile renders its page at a chosen DEVICE viewport width, then scales to fit the tile —
  // so a device toggle (not tile-resize) drives the page's real responsive breakpoints. ASPECT
  // (w:h) shapes the tile to the device when you pick one; you can still resize freely after.
  var DEVICE_W = { desktop: 1280, tablet: 820, phone: 390 };
  // canvas-friendly default frame sizes per device (picking a device snaps the tile to one of
  // these so it looks like that device; resize stays free afterwards)
  var DEVICE_SIZE = { desktop: { w: 640, h: 400 }, tablet: { w: 480, h: 690 }, phone: { w: 300, h: 650 } };
  var DEV_ICON = {
    desktop: '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="1.5" y="2.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 14h4M8 11.5V14" stroke="currentColor" stroke-width="1.4"/></svg>',
    tablet: '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="3.5" y="1.5" width="9" height="13" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 12.5h2" stroke="currentColor" stroke-width="1.4"/></svg>',
    phone: '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="5" y="1.5" width="6" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.2 12.6h1.6" stroke="currentColor" stroke-width="1.4"/></svg>'
  };
  var IMG_MAX_DIM = 1400, IMG_QUALITY = 0.55; // aggressive: size over quality (Rob's call)
  // pastel sticky palette (white, grey, red, orange, yellow, green, teal, blue, purple, pink)
  var STICKY_COLORS = ["#ffffff", "#e9ecef", "#f4a9a8", "#f7c99a", "#fce495", "#bfe5a0", "#a9e5db", "#a9cbf5", "#cbb8f2", "#f5b3d7"];
  var DEFAULT_STICKY = "#a9cbf5"; // soft default blue (Rob's pick)
  // the size a sticky is dropped at — and, while its height is still automatic, the floor
  // autoFit will not shrink it below (a note you typed two words into stays a note).
  // 220, not 160: measured against FigJam, a sticky's line box is ~10% of its width (its
  // default note is 240 world px). At 160 our 16px default read 13.5% — a third too big —
  // so the same sentence needed 6 lines where FigJam fit 4. Growing the NOTE keeps 16px
  // readable and lands the ratio at 16 * 1.35 / 220 = 9.8%.
  var STICKY_W = 220, STICKY_H = 220;
  // .gvc-stickyin vertical padding (19 top + 40 bottom, the bottom leaving room for the author)
  var STICKY_PAD_V = 59;
  // The ladder a sticky's text steps DOWN as it outgrows the note (see fitStickyFont). The
  // top of the ladder is whatever size the user picked; these are the stops below it.
  var STICKY_FONT_RAMP = [80, 64, 48, 40, 32, 28, 24, 21, 18, 16, 14, 12, 11, 10, 9, 8];
  // marker palette (draw sub-toolbar dots, left to right)
  var DRAW_COLORS = ["#1e1e1e", "#f24822", "#ff9f2e", "#ffd233", "#35c759", "#3aa2ff", "#8a5cff", "#ffffff"];
  var TEXT_COLORS = ["#1e1e1e", "#6b7280", "#e03131", "#e8590c", "#f0a000", "#2f9e44", "#0c8599", "#1971c2", "#7048e8", "#c2255c"];
  // Section colors: each is the SOLID label-chip color; the section fill is a
  // light tint of it (see renderSection). Medium-dark bases so the white chip text stays legible.
  var SECTION_COLORS = ["#6b7280", "#e03131", "#e8590c", "#f0a000", "#2f9e44", "#0c8599", "#1971c2", "#7048e8", "#c2255c"];
  // stamp wheel, clockwise from the top — a die-cut sticker set, drawn as flat
  // SVGs with a white outline (paint-order:stroke) so they read as stickers, not OS emoji.
  // "laugh" fills the avatar slot with an emoji rendered through the same sticker filter.
  var STAMPS = ["thumbs-up", "+1", "star", "question", "thumbs-down", "sticker", "laugh", "heart"];
  var S_OUT = ' stroke="#ffffff" stroke-width="3" paint-order="stroke" stroke-linejoin="round"';
  var THUMB = '<path d="M13.5 17.5 18 7.2c.5-1.2 1.7-2 3-2 1.9 0 3.4 1.5 3.4 3.4 0 .4-.1.8-.2 1.2l-1.3 4.4h7.6c1.9 0 3.3 1.8 2.9 3.6l-2.3 9.4a3 3 0 0 1-2.9 2.3H13.5z"/><rect x="6" y="17.2" width="7.5" height="12.4" rx="1.8"/>';
  function stickerSvg(inner) { return '<svg viewBox="0 0 40 40" class="stk">' + inner + "</svg>"; }
  var STAMP_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  var STAMP_ART = {
    "thumbs-up": stickerSvg('<g fill="#41a04c"' + S_OUT + ">" + THUMB + "</g>"),
    "thumbs-down": stickerSvg('<g transform="rotate(180 20 19)" fill="#5677e8"' + S_OUT + ">" + THUMB + "</g>"),
    "+1": stickerSvg('<text x="20" y="28" text-anchor="middle" font-family="' + STAMP_FONT + '" font-size="26" font-weight="900" font-style="italic" fill="#7b52e0" stroke="#ffffff" stroke-width="5.2" paint-order="stroke" stroke-linejoin="round">+1</text><text x="20" y="28" text-anchor="middle" font-family="' + STAMP_FONT + '" font-size="26" font-weight="900" font-style="italic" fill="#7b52e0" stroke="#7b52e0" stroke-width="1.3" paint-order="stroke" stroke-linejoin="round">+1</text>'),
    star: stickerSvg('<polygon points="20,2.5 24.9,14.2 37.5,15.2 27.9,23.4 30.9,35.7 20,29 9.1,35.7 12.1,23.4 2.5,15.2 15.1,14.2" fill="none" stroke="#ffffff" stroke-width="6.5" stroke-linejoin="round"/><polygon points="20,2.5 24.9,14.2 37.5,15.2 27.9,23.4 30.9,35.7 20,29 9.1,35.7 12.1,23.4 2.5,15.2 15.1,14.2" fill="#f6c514" stroke="#f6c514" stroke-width="2.6" stroke-linejoin="round"/>'),
    question: stickerSvg('<text x="20" y="30.5" text-anchor="middle" font-family="' + STAMP_FONT + '" font-size="31" font-weight="900" fill="#e2571d" stroke="#ffffff" stroke-width="5.2" paint-order="stroke" stroke-linejoin="round">?</text><text x="20" y="30.5" text-anchor="middle" font-family="' + STAMP_FONT + '" font-size="31" font-weight="900" fill="#e2571d" stroke="#e2571d" stroke-width="1.3" paint-order="stroke" stroke-linejoin="round">?</text>'),
    heart: stickerSvg('<path d="M20 34.7C10.6 28.4 5.6 22.8 5.6 16.4c0-4.1 3.3-7.4 7.4-7.4 2.8 0 5.4 1.6 7 4a8.1 8.1 0 0 1 7-4c4.1 0 7.4 3.3 7.4 7.4 0 6.4-5 12-14.4 18.3z" fill="#ee7a6c"' + S_OUT + "/>"),
    sticker: stickerSvg('<circle cx="20" cy="19.5" r="12.5" fill="#b6bfcc"' + S_OUT + '/><path d="M7.8 22.8a12.5 12.5 0 0 0 9.5 8.9c-.9-4.7-4.2-7.8-9.5-8.9z" fill="#e9edf3"/><path d="M7.8 22.8c5.3 1.1 8.6 4.2 9.5 8.9" stroke="#98a3b3" stroke-width=".8" fill="none"/>'),
    laugh: '😂'
  };
  function stampHtml(key) { var a = STAMP_ART[key]; return a && a.indexOf("<svg") === 0 ? a : null; }
  // Named presets + a custom numeric fallback. Size is stored as node.fontSize
  // (px number); node.fontScale is the legacy s/m/l — still resolved so old boards are unchanged.
  var FONT_PRESETS = [
    { label: "Small", px: 16, disp: 13 },
    { label: "Medium", px: 24, disp: 16 },
    { label: "Large", px: 32, disp: 19 },
    { label: "Extra large", px: 48, disp: 23 },
    { label: "Huge", px: 80, disp: 28 },
  ];
  var LEGACY_FONT = { s: 13, m: 16, l: 21 };
  function fontPx(node) { return node.fontSize || LEGACY_FONT[node.fontScale] || 16; }
  function fontLabel(node) { var px = fontPx(node); for (var i = 0; i < FONT_PRESETS.length; i++) if (FONT_PRESETS[i].px === px) return FONT_PRESETS[i].label; return px + ""; }
  var ME = ""; // signed-in name, stamped as the sticky author
  var MIN_NODE = 48; // smallest side a resize drag can reach (world px)

  // ---- board state ---------------------------------------------------------
  var board = { v: 1, name: CFG.name || "Untitled canvas", view: { x: 0, y: 0, scale: 1 }, nodes: [] };
  var nodeEls = {};        // id -> DOM element
  var selected = [];       // ids of selected nodes (click, shift-add, or marquee = multi)
  var transformCbs = [];   // listeners notified on every pan/zoom (comments overlay, sel bar)

  // ---- tool state ----------------------------------------------------------
  // TOOL.kind: select | hand | draw | eraser | shape | connector | section | place
  // draw substate lives in drawStyle; shape/connector carry what to draw; place carries type.
  var TOOL = { kind: "select" };
  var drawStyle = { mode: "marker", size: "thin", color: "#1e1e1e" };
  var armedShape = "square", armedConnector = "arrow", armedStamp = STAMPS[0];

  function uid() { return "n" + Math.random().toString(36).slice(2, 9); }
  function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }
  // ease the viewport onto a world point (jumping to a peer, and anything else that needs to
  // move the camera for you) — a teleport loses you, 300ms of travel doesn't
  var flyRaf = null;
  function flyTo(wx, wy, scale) {
    var v = board.view, s0 = v.scale, s1 = clampScale(scale || v.scale), x0 = v.x, y0 = v.y;
    var x1 = innerWidth / 2 - wx * s1, y1 = innerHeight / 2 - wy * s1, t0 = Date.now();
    if (flyRaf) cancelAnimationFrame(flyRaf);
    (function step() {
      var k = Math.min(1, (Date.now() - t0) / 320), e = 1 - Math.pow(1 - k, 3);
      v.x = x0 + (x1 - x0) * e; v.y = y0 + (y1 - y0) * e; v.scale = s0 + (s1 - s0) * e;
      applyTransform();
      if (k < 1) flyRaf = requestAnimationFrame(step); else { flyRaf = null; saveView(); }
    })();
  }
  // A world box for ANY node type. nodeRect() has no answer for arrows (they carry endpoints,
  // not x/y/w/h) and deep links have to be able to frame one, so this fills that hole.
  function anyRect(n) {
    if (!n) return null;
    if (n.type === "arrow") {
      if (n.x1 == null) return null;
      return { x: Math.min(n.x1, n.x2), y: Math.min(n.y1, n.y2), w: Math.max(1, Math.abs(n.x2 - n.x1)), h: Math.max(1, Math.abs(n.y2 - n.y1)) };
    }
    return nodeRect(n);
  }
  // Frame a world box: centre it, pick the scale that fits with a margin. Capped at 1:1 so
  // arriving on one sticky doesn't slam the camera to 400% — "show me this", not "fill the screen".
  function flyToRect(r) {
    if (!r) return;
    var pad = 140;
    var fit = Math.min((innerWidth - pad) / r.w, (innerHeight - pad) / r.h);
    flyTo(r.x + r.w / 2, r.y + r.h / 2, Math.min(1, fit));
  }
  // dot grid: the grid scales WITH zoom (world-space feel) — spacing = GRID*scale,
  // so zooming IN spreads the dots apart and grows them, zooming OUT packs them and shrinks
  // them. It only octave-corrects at the extremes (≈9–96px) so it never mushes into moiré or
  // gaps hugely. The dot RADIUS is proportional to the spacing (a fixed ratio, clamped), so
  // wider gaps = bigger dots. Returns { step, r } in screen px.
  var DOT_COLOR = "#c8c8c8";
  function gridSpec(scale) {
    var s = GRID * scale;
    while (s < 9) s *= 2;
    while (s > 96) s /= 2;
    var r = s * 0.05; if (r < 0.7) r = 0.7; else if (r > 3) r = 3;
    return { step: s, r: r };
  }

  // ---- DOM scaffold --------------------------------------------------------
  var root = el("div", { id: "gvc-root" });
  var world = el("div", { id: "gvc-world" });
  var ui = el("div", { id: "gvc-ui" });
  root.appendChild(world); root.appendChild(ui);

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k in n && k !== "list") { try { n[k] = attrs[k]; } catch (e) { n.setAttribute(k, attrs[k]); } }
      else n.setAttribute(k, attrs[k]);
    }
    if (kids) kids.forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function svgIcon(paths) {
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
  }
  // Lucide icons (lucide.dev, ISC — the set shadcn/Augur already use) render in their native
  // 24-viewBox; slightly thinner stroke than stock to sit with the toolbar's line weight.
  function lucideIcon(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
  }

  // ---- coordinate transforms ----------------------------------------------
  function screenToWorld(sx, sy) { var v = board.view; return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale }; }
  function worldToScreen(wx, wy) { var v = board.view; return { x: wx * v.scale + v.x, y: wy * v.scale + v.y }; }

  var xfDirty = false;
  function applyTransform() {
    if (xfDirty) return; xfDirty = true;
    requestAnimationFrame(function () {
      xfDirty = false;
      var v = board.view;
      world.style.transform = "translate(" + v.x + "px," + v.y + "px) scale(" + v.scale + ")";
      // Inverse zoom factor for screen-constant chrome INSIDE the scaled world —
      // selection outlines etc. multiply by this so they read the same at any zoom
      // (a world-unit stroke vanishes zoomed out, dominates zoomed in).
      world.style.setProperty("--gvc-inv", String(1 / v.scale));
      var g = gridSpec(v.scale);
      root.style.backgroundImage = "radial-gradient(circle, " + DOT_COLOR + " " + g.r + "px, transparent " + (g.r + 0.6) + "px)";
      root.style.backgroundSize = g.step + "px " + g.step + "px";
      root.style.backgroundPosition = v.x + "px " + v.y + "px";
      if (zoomPct) zoomPct.textContent = Math.round(v.scale * 100) + "%";
      // comments.js repositions pins on window scroll; a canvas pan/zoom IS a scroll of the
      // world, so tell it. Board-anchored threads read GVCanvas.worldToScreen (comments hook).
      try { window.dispatchEvent(new Event("scroll")); } catch (e) {}
      for (var i = 0; i < transformCbs.length; i++) { try { transformCbs[i](); } catch (e) {} }
      mpSendView(); // live camera → the room (throttled + change-gated; follow mode mirrors it)
    });
  }
  function zoomAt(sx, sy, factor) {
    var v = board.view, ns = clampScale(v.scale * factor), f = ns / v.scale;
    v.x = sx - (sx - v.x) * f; v.y = sy - (sy - v.y) * f; v.scale = ns;
    applyTransform(); saveView(); // camera only — never a KV write
  }

  // ---- node model helpers --------------------------------------------------
  function nodeById(id) { for (var i = 0; i < board.nodes.length; i++) if (board.nodes[i].id === id) return board.nodes[i]; return null; }
  function autoName(type) {
    var base = { sticky: "Sticky", text: "Text", image: "Image", tile: "Prototype", arrow: "Connector", draw: "Drawing", shape: "Shape", section: "Section", table: "Table", stamp: "Stamp" }[type] || "Node";
    var n = 0; board.nodes.forEach(function (x) { if (x.type === type) n++; });
    return base + " " + (n + 1);
  }
  function addNode(node) {
    node.id = node.id || uid();
    if (!node.name) node.name = autoName(node.type);
    board.nodes.push(node);
    renderNode(node);
    scheduleSave();
    return node;
  }
  // Duplicate the current selection, offset diagonally so the copies land NEXT TO the
  // originals (grabbable), not stacked on top; the copies become the new selection so you
  // can immediately drag them. (Cmd/Ctrl-D — the standard duplicate shortcut.)
  // One node → a fresh, independent copy of it, offset by (dx,dy). Shared by ⌘D and by
  // Option-drag; histClone already deep-copies the mutable containers (points/cells/crop) so
  // the copy never shares them with the original.
  function cloneNode(n, dx, dy) {
    var c = histClone(n);
    c.id = uid();
    // duplicated tiles get a distinct name — names are the shared vocabulary ("change the
    // copy"), and canvas-screen.mjs dup finds the "… copy" tile to repoint at a forked folder
    if (c.type === "tile" && c.name) c.name = c.name + " copy";
    if (n.type === "arrow") { c.x1 = n.x1 + dx; c.y1 = n.y1 + dy; c.x2 = n.x2 + dx; c.y2 = n.y2 + dy; }
    else { c.x = (n.x || 0) + dx; c.y = (n.y || 0) + dy; }
    return c;
  }
  function duplicateSelection() {
    if (!selected.length) return;
    var newIds = [];
    selected.forEach(function (id) {
      var n = nodeById(id); if (!n) return;
      var c = cloneNode(n, 32, 32);
      addNode(c); newIds.push(c.id); pop(c.id);
    });
    setSelection(newIds);
    scheduleSave();
  }
  function removeNode(id) {
    var i = board.nodes.findIndex(function (n) { return n.id === id; });
    if (i < 0) return;
    board.nodes.splice(i, 1);
    if (nodeEls[id]) { nodeEls[id].remove(); delete nodeEls[id]; }
    selected = selected.filter(function (s) { return s !== id; }); if (selected.length !== 1) hideSelBar();
    scheduleSave();
  }

  // ---- selection (click, shift-add, or marquee = multi-select) -------------
  function isSelected(id) { return selected.indexOf(id) >= 0; }
  function setSelection(ids) {
    selected.forEach(function (id) { if (nodeEls[id]) nodeEls[id].classList.remove("sel"); });
    clearDecor();
    selected = ids.slice();
    if (typeof mpSendSel === "function") mpSendSel(); // live selection → the room (throttled)
    selected.forEach(function (id) { if (nodeEls[id]) nodeEls[id].classList.add("sel"); });
    if (selected.length === 1) {
      var n = nodeById(selected[0]);
      decorate(selected[0]);
      // EVERY node type gets the bar now — the ones with no styling controls (image, table,
      // stamp, arrow) still need somewhere to hang "copy link to this node".
      if (n) showSelBar(n); else hideSelBar();
    } else hideSelBar();
  }
  function select(id) { setSelection(id ? [id] : []); }
  var decorEls = [];
  function clearDecor() { decorEls.forEach(function (e) { e.remove(); }); decorEls = []; }
  function decorate(id) {
    clearDecor();
    var node = nodeById(id), host = nodeEls[id];
    if (!node || !host || node.type === "arrow") return;
    if (node.type === "table") {
      // table add affordances: a blue + strip along the bottom (row) and right (column)
      var ar = el("div", { class: "gvc-addrow", text: "+" });
      guard(ar); ar.addEventListener("click", function (e) { e.stopPropagation(); node.h = node.h / node.rows * (node.rows + 1); node.rows++; renderNode(node); scheduleSave(); });
      var ac = el("div", { class: "gvc-addcol", text: "+" });
      guard(ac); ac.addEventListener("click", function (e) { e.stopPropagation(); node.w = node.w / node.cols * (node.cols + 1); node.cols++; renderNode(node); scheduleSave(); });
      host.appendChild(ar); host.appendChild(ac); decorEls.push(ar, ac);
    }
    if (!node.locked) {
      // ALL FOUR corners resize (nw/ne/sw/se) — dragging a west/north corner moves the
      // node's x/y as well as its size, so the opposite corner stays pinned. The four EDGES
      // (n/s/e/w) resize one axis: invisible strips straddling the whole border, so you can
      // grab a side anywhere along it, not just at a corner. Corners sit above them (z-index)
      // so the last ~9px of each side still gives you the two-axis grab.
      // A text box has no draggable height (it wraps and auto-grows), so it gets e/w only.
      var dirs = ["nw", "ne", "sw", "se", "e", "w"];
      if (node.type !== "text") dirs.push("n", "s");
      dirs.forEach(function (dir) {
        var rz = el("div", { class: "gvc-resize " + dir + (dir.length === 1 ? " edge" : "") });
        rz.addEventListener("pointerdown", function (e) { startResize(e, node, dir); });
        host.appendChild(rz); decorEls.push(rz);
      });
      scaleDecor();
    }
  }
  // handles are world-space children, so counter-scale them (like tile/section chrome) to keep
  // a constant ~9px screen size — otherwise they vanish when zoomed out and bloat zoomed in.
  // An edge strip spans its whole side, so only its THICKNESS is counter-scaled (scaleY on a
  // horizontal strip, scaleX on a vertical one) — centred, so it keeps straddling the border.
  function scaleDecor() {
    var s = board.view.scale, inv = 1 / s;
    decorEls.forEach(function (e) {
      if (!e.classList.contains("gvc-resize")) return;
      if (!e.classList.contains("edge")) e.style.transform = "scale(" + inv + ")";
      else e.style.transform = (e.classList.contains("n") || e.classList.contains("s") ? "scaleY(" : "scaleX(") + inv + ")";
    });
  }
  transformCbs.push(scaleDecor);

  // ---- render --------------------------------------------------------------
  function render() {
    Object.keys(nodeEls).forEach(function (id) { nodeEls[id].remove(); });
    nodeEls = {};
    board.nodes.forEach(renderNode);
    if (selected.length) setSelection(selected.slice());
  }
  function place(host, node) {
    host.style.left = node.x + "px"; host.style.top = node.y + "px";
    if (node.w != null) host.style.width = node.w + "px";
    if (node.h != null) host.style.height = node.h + "px";
  }
  function renderNode(node) {
    var old = nodeEls[node.id]; if (old) old.remove();
    var host;
    if (node.type === "sticky") host = renderSticky(node);
    else if (node.type === "text") host = renderText(node);
    else if (node.type === "image") host = renderImage(node);
    else if (node.type === "tile") host = renderTile(node);
    else if (node.type === "arrow") host = renderArrow(node);
    else if (node.type === "draw") host = renderDraw(node);
    else if (node.type === "shape") host = renderShape(node);
    else if (node.type === "section") host = renderSection(node);
    else if (node.type === "table") host = renderTable(node);
    else if (node.type === "stamp") host = renderStamp(node);
    else return;
    host.className = "gvc-node " + host.className;
    host.dataset.id = node.id;
    nodeEls[node.id] = host;
    // sections are background containers — keep them under every other node
    if (node.type === "section") world.insertBefore(host, world.firstChild);
    else world.appendChild(host);
    if (isSelected(node.id)) { host.classList.add("sel"); if (selected.length === 1) decorate(node.id); }
    autoFit(node, false); // never render a box that clips its own text (no-op for other types)
    return host;
  }

  // ---- rich text (inline formatting + lists) --------------------------------
  // Text is HTML now: `node.rich` holds sanitized markup — inline **bold / italic /
  // underline / strike on a SELECTION** plus bullet + numbered lists. The old
  // `node.text` plain string is still written on every edit (it names the node, and it's what
  // old boards carry), and it's the fallback whenever `node.rich` is absent — so every
  // existing board renders byte-identically and a plain sticky stays a plain string on the wire.
  // SANITIZE ON BOTH SIDES: board content round-trips through shared KV and the multiplayer
  // socket, so unfiltered HTML from a peer (or a paste) would be stored XSS.
  var RICH_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, BR: 1, DIV: 1, P: 1, UL: 1, OL: 1, LI: 1, SPAN: 1 };
  // PARSE INERT, THEN CLEAN. Assigning untrusted markup to a live element's innerHTML — even a
  // detached one — starts loading its resources immediately, so `<img src=x onerror=…>` fires
  // BEFORE the walk below ever reaches it: the sanitizer strips the element from the doc but the
  // script has already run. A DOMParser document is inert (nothing loads, nothing executes), so
  // the walk happens somewhere harmless and only the cleaned markup — whitelisted tags, zero
  // attributes, so nothing that can load anything — is handed to a live element.
  function sanitizeRichEl(html) {
    var box = document.createElement("div");
    var inert;
    try { inert = new DOMParser().parseFromString("<!doctype html><body>" + String(html == null ? "" : html), "text/html").body; }
    catch (e) { box.textContent = String(html == null ? "" : html); return box; } // no DOMParser: text only, never markup
    (function clean(parent) {
      var c = parent.firstChild;
      while (c) {
        var next = c.nextSibling;
        if (c.nodeType === 3) { /* text node — keep */ }
        else if (c.nodeType !== 1 || c.nodeName === "SCRIPT" || c.nodeName === "STYLE") parent.removeChild(c);
        else if (RICH_TAGS[c.nodeName]) { for (var i = c.attributes.length - 1; i >= 0; i--) c.removeAttribute(c.attributes[i].name); clean(c); }
        else { clean(c); while (c.firstChild) parent.insertBefore(c.firstChild, c); parent.removeChild(c); } // unknown tag → unwrap, keep its text
        c = next;
      }
    })(inert);
    box.innerHTML = inert.innerHTML; // safe now: whitelisted tags, no attributes, nothing loadable
    return box;
  }
  function sanitizeRich(html) { return sanitizeRichEl(html).innerHTML; }
  // Render = sanitize, then NORMALIZE to canonical lines (see the line model below), so the
  // DOM the user edits always has one block per line — plain `node.text` boards included.
  function richHtml(node) {
    var box;
    if (node.rich != null) box = sanitizeRichEl(node.rich);
    else { box = document.createElement("div"); box.textContent = String(node.text || ""); }
    return serializeLines(flattenLines(box));
  }
  function hasRichMarkup(h) { return /<(b|strong|i|em|u|s|strike|del|ul|ol|li)[\s>]/i.test(h); }
  // commit the live DOM back onto the node (called on every keystroke so the multiplayer diff
  // tick streams formatting too, not just characters)
  function commitRich(node, txt) {
    node.text = txt.innerText;
    var h = sanitizeRich(txt.innerHTML);
    if (hasRichMarkup(h)) node.rich = h; else delete node.rich;
  }
  // execCommand is deprecated-but-universal and the only way to get real selection-level
  // formatting out of contenteditable. styleWithCSS=false keeps the output as <b>/<i>/<s>
  // tags (which the sanitizer whitelists) instead of style attributes (which it strips).
  function execRich(cmd, val) {
    try { document.execCommand("styleWithCSS", false, false); } catch (e) {}
    try { return document.execCommand(cmd, false, val == null ? null : val); } catch (e) { return false; }
  }

  // ---- the LINE model (what makes lists possible) ---------------------------
  // Our text boxes are `white-space: pre-wrap`, so a line break can be a literal "\n", a <br>,
  // or a block — and `execCommand("insertUnorderedList")` on a \n-separated box makes ONE
  // bullet out of every line (verified in Chrome). So lists are ours, not the browser's: we
  // flatten the box to a flat array of LINES (each carrying its inline markup + an optional
  // list kind), toggle the lines the selection touches, and re-serialize. Canonical output is
  // one <div> per plain line and consecutive same-kind lines merged into one <ul>/<ol> run.
  var INLINE_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, SPAN: 1 };
  var BLOCK_TAGS = { DIV: 1, P: 1, LI: 1 };
  function flattenLines(root) {
    var lines = [], cur = document.createDocumentFragment(), kind = null, depth = -1; // depth: nesting level of the enclosing list, -1 = not in one
    function push(force) { if (force || cur.childNodes.length) { lines.push({ kind: kind, depth: Math.max(0, depth), frag: cur }); cur = document.createDocumentFragment(); } }
    function newline() { lines.push({ kind: kind, depth: Math.max(0, depth), frag: cur }); cur = document.createDocumentFragment(); }
    function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var parts = String(c.nodeValue).split("\n");
          for (var i = 0; i < parts.length; i++) {
            if (i) newline();
            if (parts[i]) cur.appendChild(document.createTextNode(parts[i]));
          }
        } else if (c.nodeType !== 1) continue;
        else if (c.nodeName === "BR") newline();
        else if (c.nodeName === "UL" || c.nodeName === "OL") {
          push(false);
          var prev = kind; kind = c.nodeName === "OL" ? "ol" : "ul"; depth++;
          walk(c); push(false);
          depth--; kind = prev;
        } else if (BLOCK_TAGS[c.nodeName]) {
          push(false); var before = lines.length; walk(c);
          if (cur.childNodes.length) push(true); else if (lines.length === before) push(true); // an empty block is a blank line
        } else if (c.nodeName === "GV-MK1" || c.nodeName === "GV-MK2") {
          cur.appendChild(document.createElement(c.nodeName.toLowerCase())); // selection marker, see markSelection
        } else if (INLINE_TAGS[c.nodeName]) {
          // an inline run can straddle a line break (bold spanning two lines) — flatten it and
          // re-wrap each piece in its own copy of the tag
          var sub = flattenLines(c), tag = c.nodeName.toLowerCase();
          sub.forEach(function (ln, i) {
            if (i) newline();
            if (ln.frag.childNodes.length) { var w = document.createElement(tag); w.appendChild(ln.frag); cur.appendChild(w); }
          });
        } else walk(c); // unknown wrapper → transparent
      }
    }
    walk(root);
    push(false);
    return lines;
  }
  function serializeLines(lines) {
    var box = document.createElement("div");
    var stack = [], lastLi = []; // per depth: the open <ul>/<ol>, and the <li> a deeper list nests into
    function block(tag, frag) {
      var e2 = document.createElement(tag);
      if (frag.childNodes.length) e2.appendChild(frag); else e2.appendChild(document.createElement("br"));
      return e2;
    }
    lines.forEach(function (ln) {
      if (!ln.kind) { stack.length = 0; lastLi.length = 0; box.appendChild(block("div", ln.frag)); return; }
      var d = Math.min(Math.max(0, ln.depth || 0), stack.length); // a level can never be skipped
      stack.length = Math.min(stack.length, d + 1);
      var list = stack[d];
      if (!list || list.nodeName.toLowerCase() !== ln.kind) {
        list = document.createElement(ln.kind);
        if (d === 0) box.appendChild(list); else lastLi[d - 1].appendChild(list); // nest INSIDE the line above
        stack[d] = list;
      }
      var li = block("li", ln.frag);
      list.appendChild(li);
      lastLi[d] = li; lastLi.length = d + 1;
    });
    return box.innerHTML;
  }
  // Which lines does the selection touch? Rather than counting line breaks a SECOND way (that
  // drifted: an empty `<div><br></div>` counted twice), plant two marker elements at the
  // selection's edges and run the SAME flattenLines over the live DOM — then read back which
  // lines they landed on. The markers are stripped before serializing, so nothing leaks.
  function markSelection(txt) {
    var s = getSelection();
    if (!s || !s.rangeCount || !txt.contains(s.anchorNode) || !txt.contains(s.focusNode)) return false;
    var r = s.getRangeAt(0);
    var end = r.cloneRange(); end.collapse(false); end.insertNode(document.createElement("gv-mk2"));
    var start = r.cloneRange(); start.collapse(true); start.insertNode(document.createElement("gv-mk1")); // end first: inserting shifts offsets
    return true;
  }
  function markedLines(lines) {
    var a = -1, b = -1;
    lines.forEach(function (ln, i) {
      if (!ln.frag.querySelector) return;
      if (a < 0 && ln.frag.querySelector("gv-mk1")) a = i;
      if (ln.frag.querySelector("gv-mk2")) b = i;
      var junk = ln.frag.querySelectorAll("gv-mk1, gv-mk2");
      for (var k = 0; k < junk.length; k++) junk[k].parentNode.removeChild(junk[k]);
    });
    if (a < 0 && b < 0) return null;
    if (a < 0) a = b; if (b < 0) b = a;
    return b < a ? { a: b, b: a } : { a: a, b: b };
  }
  // the DOM element that holds each line, in document order (nested lists included) — used to
  // put the caret back after a rebuild
  function lineEls(root) {
    var out = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (c.nodeName === "UL" || c.nodeName === "OL") walk(c);
        else if (c.nodeName === "LI") { out.push(c); walk(c); } // its own line first, then anything nested under it
        else out.push(c);
      }
    })(root);
    return out;
  }
  // Bullet / numbered toggle. Applies to the lines the selection touches (whole box when the
  // node is selected but not being edited — the "turn this sticky into a list" move).
  function toggleList(node, wantKind) {
    var txt = editingTxt(node);
    if (!txt) { enterEdit(node.id); txt = editingTxt(node); }
    if (!txt) return;
    var marked = markSelection(txt);
    var lines = flattenLines(txt);
    if (!lines.length) lines = [{ kind: null, frag: document.createDocumentFragment() }];
    var range = marked ? markedLines(lines) : null;
    var a = range ? range.a : 0, b = range ? range.b : lines.length - 1; // no selection → whole box
    b = Math.max(0, Math.min(b, lines.length - 1));
    a = Math.max(0, Math.min(a, b));
    var allOn = true;
    for (var i = a; i <= b; i++) if (lines[i].kind !== wantKind) { allOn = false; break; }
    for (var j = a; j <= b; j++) { lines[j].kind = allOn ? null : wantKind; if (allOn) lines[j].depth = 0; } // second click un-lists
    rebuildLines(node, txt, lines, b);
  }
  // Tab / Shift-Tab inside a list nests and un-nests it, like every editor. Depth lives on the
  // LINE; serializeLines turns it back into real <ul>/<ol> nesting.
  function indentLines(node, delta) {
    var txt = editingTxt(node); if (!txt) return false;
    var marked = markSelection(txt);
    var lines = flattenLines(txt);
    var range = marked ? markedLines(lines) : null;
    if (!range || !lines.length) return false;
    var touched = false;
    for (var i = range.a; i <= Math.min(range.b, lines.length - 1); i++) {
      var ln = lines[i]; if (!ln.kind) continue;
      var above = i > 0 && lines[i - 1].kind ? lines[i - 1].depth : -1; // you can only nest UNDER a line, never leap a level
      var d = (ln.depth || 0) + delta;
      if (delta > 0 && d > above + 1) continue;
      if (d < 0) { ln.kind = null; ln.depth = 0; } // Shift-Tab at the outer level leaves the list
      else ln.depth = d;
      touched = true;
    }
    if (!touched) return false;
    rebuildLines(node, txt, lines, range.b);
    return true;
  }
  // re-render the editable from the line array and put the caret back at the end of `caretLine`
  function rebuildLines(node, txt, lines, caretLine) {
    txt.innerHTML = serializeLines(lines);
    var els = lineEls(txt), last = els[Math.max(0, Math.min(caretLine, els.length - 1))];
    if (last) { var r = document.createRange(); r.selectNodeContents(last); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    txt.focus();
    commitRich(node, txt); autoFit(node, true); scheduleSave();
  }
  // the live editable of a node, only while it's actually being typed in
  function editingTxt(node) {
    var host = nodeEls[node.id]; if (!host) return null;
    var t = host.querySelector(".gvc-txt");
    return t && t.contentEditable === "true" ? t : null;
  }
  // B / I / S mean two different things depending on context — and the button and the ⌘-key
  // must agree: while you're EDITING they act on the text (the selection, or the style the
  // next characters will take if the caret is collapsed); with the node merely selected they
  // toggle the whole box.
  function toggleFormat(node, btn, cmd, prop) {
    var t = editingTxt(node);
    if (t) { execRich(cmd); commitRich(node, t); autoFit(node, true); scheduleSave(); return; }
    node[prop] = !node[prop];
    if (btn) btn.classList.toggle("on", !!node[prop]);
    applyNodeStyle(node); scheduleSave();
  }

  function editableText(node, host, cls) {
    var txt = el("div", { class: "gvc-txt " + cls, contentEditable: "false", html: richHtml(node) });
    // Editing is entered via manual double-tap detection in the pointerdown handler (native
    // dblclick is unreliable while the root holds pointer capture) → enterEdit(id).
    txt.addEventListener("blur", function () {
      host.classList.remove("editing"); txt.contentEditable = "false";
      commitRich(node, txt);
      // A text node IS its text — emptied out (cut, select-all-delete, or placed and never
      // typed in) it has nothing left to be, so it goes when you leave the edit. Stickies and
      // shapes are boxes that happen to hold text; those stay.
      if (node.type === "text" && !(node.text || "").trim()) { removeNode(node.id); return; }
      if (node.type !== "image" && node.type !== "tile") node.name = (node.text || "").split("\n")[0].slice(0, 60) || autoName(node.type);
      autoFit(node, true);
      scheduleSave();
    });
    txt.addEventListener("input", function (e) {
      if (!autoFormat(node, txt, e)) commitRich(node, txt); // autoFormat commits its own rewrite
      autoFit(node, true);
    });
    txt.addEventListener("pointerdown", function (e) { if (host.classList.contains("editing")) e.stopPropagation(); });
    // keydown is swallowed so canvas shortcuts don't fire mid-typing. Text shortcuts are run
    // HERE rather than left to the browser's native contenteditable handling, so the result is
    // the same in every browser and the markup lands on the node immediately.
    txt.addEventListener("keydown", function (e) {
      e.stopPropagation();
      // Tab nests the current list item (Shift-Tab un-nests, and pops it out of the list at the
      // outer level). Outside a list it inserts a tab instead of escaping the box like the
      // browser's default would.
      if (e.key === "Tab") {
        e.preventDefault();
        if (!indentLines(node, e.shiftKey ? -1 : 1)) execRich("insertText", "\t");
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      var k = (e.key || "").toLowerCase(), code = e.code || "", cmd = null;
      if (k === "b") cmd = "bold";
      else if (k === "i") cmd = "italic";
      else if (k === "u") cmd = "underline";
      else if (k === "s" && e.shiftKey) cmd = "strikeThrough";
      else if (e.shiftKey && code === "Digit8") cmd = "ul"; // ⌘⇧8 / ⌘⇧7 — the Docs/Notion list keys
      else if (e.shiftKey && code === "Digit7") cmd = "ol";
      if (!cmd) return;
      e.preventDefault();
      if (cmd === "ul" || cmd === "ol") { toggleList(node, cmd); return; }
      execRich(cmd); commitRich(node, txt); autoFit(node, true); scheduleSave();
    });
    // paste as PLAIN text — pasted web markup would otherwise land in the doc (fonts, colours,
    // whole layouts). Formatting is something you apply here, not something you import.
    txt.addEventListener("paste", function (e) {
      var cd = e.clipboardData; if (!cd || (cd.files && cd.files.length)) return;
      var t = cd.getData("text/plain"); if (t == null) return;
      e.preventDefault();
      execRich("insertText", t);
      commitRich(node, txt); autoFit(node, true); scheduleSave();
    });
    return txt;
  }
  // ---- markdown-ish input rules ---------------------------------------------
  // Type the formatting instead of reaching for the toolbar: "- " or "* " at
  // the head of a line becomes a bullet, "1. " a numbered item, and **bold** / _italic_ /
  // ~~strike~~ convert the moment you close the delimiter. The typed markers are eaten.
  var MD_INLINE = [
    { re: /(^|[\s(])\*\*([^*\n]+)\*\*$/, cmd: "bold", mark: 2 },
    { re: /(^|[\s(])__([^_\n]+)__$/, cmd: "bold", mark: 2 },
    { re: /(^|[\s(])~~([^~\n]+)~~$/, cmd: "strikeThrough", mark: 2 },
    { re: /(^|[\s(])\*([^*\n]+)\*$/, cmd: "italic", mark: 1 },
    { re: /(^|[\s(])_([^_\n]+)_$/, cmd: "italic", mark: 1 },
  ];
  // the block element a node sits in (one <div>/<li> per line — see the line model)
  function lineElOf(root, n) {
    while (n && n !== root) { if (n.nodeType === 1 && (BLOCK_TAGS[n.nodeName] || n.nodeName === "LI")) return n; n = n.parentNode; }
    return null;
  }
  function autoFormat(node, txt, ev) {
    var s = getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return false;
    var at = s.anchorNode, off = s.anchorOffset;
    if (!at || at.nodeType !== 3 || !txt.contains(at)) return false;
    var typed = ev && ev.data;

    // 1. list markers — at the head of a line (a real line block, or after the last "\n" in a
    // box the browser hasn't blocked out yet, e.g. a brand-new sticky), on the closing space
    if (typed === " ") {
      var line = lineElOf(txt, at) || txt;
      if (line.nodeName !== "LI") {
        var head = document.createRange(); head.selectNodeContents(line); head.setEnd(at, off);
        var mk = /(^|\n)([-*•]|\d+[.)])\s$/.exec(head.toString());
        if (mk && off >= mk[2].length + 1) {
          var eat = document.createRange(); eat.setStart(at, off - (mk[2].length + 1)); eat.setEnd(at, off);
          eat.deleteContents(); // the marker is typed, never left in the text
          eat.collapse(true);
          s.removeAllRanges(); s.addRange(eat);
          toggleList(node, /[-*•]/.test(mk[2]) ? "ul" : "ol"); // commits + saves
          return true;
        }
      }
    }

    // 2. inline markers
    var before = at.nodeValue.slice(0, off);
    for (var i = 0; i < MD_INLINE.length; i++) {
      var rule = MD_INLINE[i], m = rule.re.exec(before);
      if (!m) continue;
      var start = m.index + m[1].length, inner = m[2];
      var close = document.createRange(); close.setStart(at, off - rule.mark); close.setEnd(at, off); close.deleteContents();
      var open = document.createRange(); open.setStart(at, start); open.setEnd(at, start + rule.mark); open.deleteContents();
      var body = document.createRange(); body.setStart(at, start); body.setEnd(at, start + inner.length);
      s.removeAllRanges(); s.addRange(body);
      execRich(rule.cmd);
      s = getSelection(); s.collapseToEnd();
      execRich(rule.cmd); // toggle the PENDING style back off so what you type next is plain
      commitRich(node, txt); scheduleSave();
      return true;
    }
    return false;
  }

  // The ladder for ONE sticky: the size the user picked, then every ramp stop below it.
  // The picked size is the CEILING — text never renders bigger than what the dropdown says.
  function stickyRamp(node) {
    var ceil = fontPx(node), out = [ceil];
    for (var i = 0; i < STICKY_FONT_RAMP.length; i++) if (STICKY_FONT_RAMP[i] < ceil) out.push(STICKY_FONT_RAMP[i]);
    return out;
  }
  // FigJam's sticky model, and the reason a sticky reads as a sticky: the NOTE holds its shape
  // and the TEXT shrinks to fit it. Step down the ladder until the words fit `h`; only when the
  // bottom rung still overflows does autoFit let the note grow (so nothing is ever clipped).
  //
  // Walks from the size currently applied (cached on the node's own element) rather than from
  // the top of the ladder, so a keystroke costs 1-2 forced reflows, not 16. Returns the px used.
  function fitStickyFont(node, txt, h) {
    var ramp = stickyRamp(node), avail = Math.max(1, h - STICKY_PAD_V);
    var i = ramp.indexOf(+txt.dataset.fit); if (i < 0) i = 0;
    txt.style.fontSize = ramp[i] + "px";
    if (txt.scrollHeight > avail) {
      while (i < ramp.length - 1 && txt.scrollHeight > avail) { i++; txt.style.fontSize = ramp[i] + "px"; }
    } else {
      while (i > 0) {                                     // deleted text — climb back toward the ceiling
        txt.style.fontSize = ramp[i - 1] + "px";
        if (txt.scrollHeight > avail) { txt.style.fontSize = ramp[i] + "px"; break; }
        i--;
      }
    }
    txt.dataset.fit = ramp[i];
    return ramp[i];
  }
  // A sticky/shape sizes itself to its text: it grows so it never clips, and in auto mode it
  // SHRINKS back when you delete text. Dragging a resize handle sets an explicit height
  // (node.hFixed) — from then on the box only ever grows, never shrinks under you.
  // allowShrink is false on render, so opening an old board never reflows it.
  // A sticky AUTO-SIZING has the size it was dropped at (STICKY_H) as its floor: a fresh note you
  // type two words into must stay the note you dropped — only text that outgrows it makes it
  // taller. A height you set by hand (hFixed) is yours, floor or no floor; and the floor is
  // deliberately NOT applied on render, so opening an old board still never reflows it.
  //
  // A sticky shrinks its TEXT before it grows its BOX (fitStickyFont). The height it fits the
  // text against is the height the note WANTS — the square floor in auto mode, its own height
  // once you've sized it by hand. Never the current grown height: fitting against a height the
  // fit itself just changed is a feedback loop (grow -> text fits bigger -> shrink -> repeat).
  function autoFit(node, allowShrink) {
    if (!node || (node.type !== "sticky" && node.type !== "shape")) return;
    var host = nodeEls[node.id]; if (!host) return;
    var txt = host.querySelector(".gvc-txt"); if (!txt) return;
    var need, min;
    if (node.type === "sticky") {
      fitStickyFont(node, txt, allowShrink && !node.hFixed ? STICKY_H : (node.h || STICKY_H));
      need = txt.scrollHeight + STICKY_PAD_V;
      min = allowShrink && !node.hFixed ? STICKY_H : 96;   // 96 = the CSS min-height
    }
    else { need = contentH(txt) / 0.76; min = MIN_NODE; }                   // shape text is inset 12% a side
    need = Math.max(min, Math.ceil(need));
    var h = node.h || 0, target = h;
    if (need > h) target = need;                          // never clip
    else if (allowShrink && !node.hFixed) target = need;  // auto mode: hug the text
    if (Math.abs(target - h) < 1) return;
    node.h = target; host.style.height = target + "px";
    positionSelBar(); scheduleSave();
  }
  // A shape's text box is height-constrained by its insets, so scrollHeight can't see that the
  // content got SHORTER — measure the line blocks themselves.
  function contentH(txt) {
    if (!txt.children.length) return txt.scrollHeight;
    var sum = 0;
    for (var i = 0; i < txt.children.length; i++) sum += txt.children[i].offsetHeight;
    return Math.max(sum, 0);
  }
  function enterEdit(id) {
    var node = nodeById(id), host = nodeEls[id];
    if (!node || !host || node.type === "tile") return;
    var txt = host.querySelector(".gvc-txt"); if (!txt) return;
    select(id); host.classList.add("editing");
    txt.contentEditable = "true"; txt.focus();
    var r = document.createRange(); r.selectNodeContents(txt);
    var s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  // Node-level text styling shared by stickies + text nodes (whole-box, so no rich-text model).
  // Only text nodes take a text COLOR (a sticky's node.color is its background).
  function applyTextStyle(txt, node) {
    txt.style.fontSize = fontPx(node) + "px";
    txt.style.fontWeight = node.bold ? "700" : "";
    txt.style.fontStyle = node.italic ? "italic" : "";
    txt.style.textDecoration = node.strike ? "line-through" : "";
    txt.style.textAlign = node.align || "";
    if (node.type === "text") txt.style.color = node.color || "";
  }
  function renderSticky(node) {
    node.w = node.w || STICKY_W; node.h = node.h || STICKY_H;
    var host = el("div", { class: "gvc-sticky" });
    host.style.background = node.color || DEFAULT_STICKY;
    var txt = editableText(node, host, "");
    applyTextStyle(txt, node);
    // inner wrap does the clipping so the corner resize handles (which straddle the host's
    // edges) stay visible — see .gvc-stickyin
    host.appendChild(el("div", { class: "gvc-stickyin" }, [txt, el("div", { class: "gvc-author", text: node.author || "" })]));
    place(host, node);
    return host;
  }
  function renderText(node) {
    var host = el("div", { class: "gvc-text" });
    var txt = editableText(node, host, "");
    applyTextStyle(txt, node);
    host.appendChild(txt);
    host.style.left = node.x + "px"; host.style.top = node.y + "px";
    // Default = auto-adapt: the box hugs its text. It must be max-content, NOT plain width:auto —
    // the #gvc-world containing block is 0-wide, so auto collapses to one-word-per-line. Once the
    // user drags the width handle the node carries an explicit w and becomes fixed-width + wrapping.
    host.style.width = node.w != null ? node.w + "px" : "max-content";
    return host;
  }
  // Editable floating name label above a node — the rename affordance for images (tiles carry
  // their name in the bar; stickies/text are identified by their own content). Manual double-tap
  // because the root's pointer capture eats native dblclick; single tap selects, Esc cancels.
  //
  // ONE rename behavior for every name label (image label, tile bar name, section chip):
  // double-tap → edit (manual detection — root pointer-capture eats native dblclick;
  // stopPropagation so a tap on the name never starts a drag), single tap → select,
  // Enter commits, Esc restores, blur trims + falls back to the old name.
  function wireRename(nm, node) {
    var tap = 0;
    nm.addEventListener("pointerdown", function (e) {
      if (isPan()) return; // drag/hand mode: labels are inert — the tap pans like anywhere else
      if (nm.contentEditable === "true") return; // already editing → let the click place the caret
      e.stopPropagation();
      var now = Date.now();
      if (now - tap < 350) { tap = 0; nm.contentEditable = "true"; nm.focus(); if (document.execCommand) document.execCommand("selectAll", false, null); }
      else { tap = now; select(node.id); }
    });
    nm.addEventListener("blur", function () { nm.contentEditable = "false"; node.name = nm.textContent.trim() || node.name; nm.textContent = node.name; scheduleSave(); });
    nm.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); nm.blur(); } else if (e.key === "Escape") { nm.textContent = node.name; nm.blur(); } });
    return nm;
  }
  function nameLabel(node) {
    return wireRename(el("div", { class: "gvc-name", text: node.name || "", contentEditable: "false", title: "Double-click to rename" }), node);
  }
  // An image node is a white CARD (paper stock + a drop shadow) — right for a photo, wrong
  // for a cut-out, which then reads as a flare floating on a white rectangle. node.alpha (set
  // at drop/paste time) drops the stock and the shadow so a transparent image sits directly
  // on the board. Images that predate the flag have it undefined, so probe them once on load.
  function renderImage(node) {
    node.w = node.w || 240; node.h = node.h || 180;
    var img = el("img", { src: node.src, alt: node.name || "" });
    if (node.crop) applyCrop(img, node.crop);
    var host = el("div", { class: "gvc-image" + (node.alpha ? " alpha" : "") }, [el("div", { class: "gvc-imgwrap" }, [img])]);
    if (node.alpha === undefined) img.addEventListener("load", function () { probeAlpha(node, img, host); });
    host.appendChild(nameLabel(node));
    place(host, node);
    return host;
  }
  // Legacy backfill. Cheap on purpose: alpha survives a downscale, so probe a thumbnail-sized
  // copy rather than the full bitmap. The result is applied to the ELEMENT only and never
  // written to node.alpha — persisting it would push a doc write (and a room op) for every
  // image on every load, and the probe is cheap enough to just redo. Assets are same-origin,
  // so the canvas doesn't taint; a cross-origin src throws and is simply left as a card.
  function probeAlpha(node, img, host) {
    if (!img.naturalWidth) return;
    try {
      var s = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight));
      var pw = Math.max(1, Math.round(img.naturalWidth * s)), ph = Math.max(1, Math.round(img.naturalHeight * s));
      var c = document.createElement("canvas"); c.width = pw; c.height = ph;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, pw, ph);
      var d = ctx.getImageData(0, 0, pw, ph).data;
      for (var i = 3; i < d.length; i += 4) {
        if (d[i] < 255) { host.classList.add("alpha"); return; }
      }
    } catch (err) { /* tainted or oversized — leave it as a card */ }
  }
  // A crop is NON-destructive: src keeps the full image, node.crop = the visible window as
  // fractions {x,y,w,h} of it. Percent sizing (relative to the clipping wrap) keeps the
  // window correct under free node resize with no JS in the resize path.
  function applyCrop(img, c) {
    img.className = "cropped";
    img.style.width = (100 / c.w) + "%"; img.style.height = (100 / c.h) + "%";
    img.style.left = (-100 * c.x / c.w) + "%"; img.style.top = (-100 * c.y / c.h) + "%";
  }
  // ALWAYS LIVE, inert until entered. Every tile mounts its real iframe as soon as it comes
  // near the viewport (IntersectionObserver, generous margin) — no ▶ Live step, so boards
  // never look broken. The iframe sits under a transparent hit overlay: the tile selects and
  // drags like any node (grab cursor = the affordance); DOUBLE-CLICK enters the prototype
  // (overlay off, ring on, you're interacting), click outside or Esc leaves. Tile chrome:
  // a name chip floating ABOVE the tile, counter-scaled so it stays readable
  // at any zoom; device/open/interact actions live on the floating selection toolbar.
  // Offscreen tiles beyond MOUNT_BUDGET quietly return to their poster (LRU by last sight)
  // and remount on sight. node.live (the old shared Stop/Live) is ignored; node.liveUrl
  // still tracks in-frame navigation for the room + late joiners.
  var MOUNT_BUDGET = 16;
  var tileVis = {}, tileSeen = {}, tileClock = 0, interactId = null;
  var tileIO = typeof IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      var id = en.target.dataset.id;
      if (en.target !== nodeEls[id]) { tileIO.unobserve(en.target); return; } // stale re-rendered host
      var node = nodeById(id); if (!node || node.type !== "tile") return;
      tileVis[id] = en.isIntersecting;
      if (en.isIntersecting) { tileSeen[id] = ++tileClock; mountTile(node); trimTiles(); }
    });
  }, { rootMargin: "600px" }) : null;

  function renderTile(node) {
    node.w = node.w || 420; node.h = node.h || 300;
    var body = el("div", { class: "gvc-tilebody" });
    var nm = wireRename(el("div", { class: "gvc-tilename", text: node.name || node.url, contentEditable: "false", title: "Double-click to rename — " + node.url }), node);
    // drag handle, visible only while interacting (the iframe eats the pointer then, so the
    // grip is how you still move the tile). No stopPropagation: its pointerdown bubbles to
    // the root and rides the normal select+move drag path.
    var grip = el("div", { class: "gvc-draghandle", title: "Drag to move", html: lucideIcon('<path d="M5 9 2 12l3 3"/><path d="M9 5l3-3 3 3"/><path d="m15 19-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>') });
    var host = el("div", { class: "gvc-tile" }, [nm, body, grip]);
    showThumb(node, body);
    place(host, node);
    scaleTileChrome(node, host);
    if (tileIO) tileIO.observe(host);
    else setTimeout(function () { if (nodeEls[node.id] === host) mountTile(node); }, 0);
    return host;
  }
  // counter-scale the floating chrome (name chip, drag grip) so it reads at a constant
  // screen size at ANY zoom (like frame titles); the name is width-capped to the tile's
  // VISUAL width so long names truncate, not spill
  function scaleTileChrome(node, host) {
    var s = board.view.scale;
    var nm = host.querySelector(".gvc-tilename");
    if (nm) {
      nm.style.transform = "scale(" + 1 / s + ")";
      nm.style.maxWidth = Math.max(80, node.w * s) + "px";
    }
    var grip = host.querySelector(".gvc-draghandle");
    if (grip) grip.style.transform = "scale(" + 1 / s + ")";
  }
  // Section label chips are like tile/prototype names: counter-scale so they stay legible
  // at any zoom (origin left-bottom, so the chip stays anchored above the section's top-left).
  function scaleSectionLabel(node, host) {
    var lab = host.querySelector(".gvc-seclabel");
    if (lab) {
      var s = board.view.scale;
      lab.style.transform = "scale(" + 1 / s + ")";
      lab.style.maxWidth = Math.max(80, node.w * s) + "px";
    }
  }
  transformCbs.push(function () {
    board.nodes.forEach(function (n) {
      if (!nodeEls[n.id]) return;
      if (n.type === "tile") scaleTileChrome(n, nodeEls[n.id]);
      else if (n.type === "section") scaleSectionLabel(n, nodeEls[n.id]);
    });
  });
  // The BOARD is a light surface (canvas.css has no dark mode at all), but a tile is its own
  // document, so it answers the VIEWER's prefers-color-scheme — on an OS in dark mode every
  // prototype went black against a white board. Prototypes are same-origin and the house viz
  // style already guards its dark block with :root:where(:not([data-theme="light"])), so
  // stamping data-theme="light" on the frame's root pins a tile to the board's own theme.
  // Standalone (opened at its own URL) a prototype still follows the viewer. Cross-origin
  // tiles safely no-op. Re-stamped on every load, since in-frame navigation fires load again.
  function themeFrame(frame) {
    try {
      var doc = frame.contentDocument;
      if (doc && doc.documentElement) doc.documentElement.setAttribute("data-theme", "light");
    } catch (e) {}
  }
  // Stamp as early as the real document exists, not just on load, or the tile paints dark for
  // a beat and then flips — a visible flash on every mount.
  function themeFrameEarly(frame) {
    var n = 0;
    var t = setInterval(function () {
      themeFrame(frame);
      var done = false;
      try { done = !frame.isConnected || (frame.contentDocument && frame.contentDocument.readyState === "complete"); }
      catch (e) { done = true; } // cross-origin: nothing to do
      if (done || ++n > 60) clearInterval(t);
    }, 30);
  }
  function mountTile(node) {
    var host = nodeEls[node.id]; if (!host) return;
    var body = host.querySelector(".gvc-tilebody");
    if (!body || body.querySelector("iframe")) return;
    body.innerHTML = "";
    var frame = el("iframe", { src: node.liveUrl || node.url });
    frame.addEventListener("load", function () { themeFrame(frame); mpFrameLoad(node, frame); });
    body.appendChild(frame);
    themeFrameEarly(frame);
    var hit = el("div", { class: "gvc-hit" });
    if (interactId === node.id) { hit.style.display = "none"; host.classList.add("interacting"); }
    body.appendChild(hit);
    fitFrame(body, node);
  }
  function trimTiles() {
    var mounted = board.nodes.filter(function (n) { return n.type === "tile" && nodeEls[n.id] && nodeEls[n.id].querySelector("iframe"); });
    if (mounted.length <= MOUNT_BUDGET) return;
    mounted
      .filter(function (n) { return !tileVis[n.id] && n.id !== interactId; })
      .sort(function (a, b) { return (tileSeen[a.id] || 0) - (tileSeen[b.id] || 0); })
      .slice(0, mounted.length - MOUNT_BUDGET)
      .forEach(function (n) { showThumb(n, nodeEls[n.id].querySelector(".gvc-tilebody")); });
  }
  // interact mode — per-user (who's driving is not shared state; what they DO mirrors
  // through the demo-sync channel). One tile at a time.
  function enterInteract(node) {
    exitInteract();
    var host = nodeEls[node.id]; if (!host) return;
    interactId = node.id;
    mountTile(node);
    var hit = host.querySelector(".gvc-hit"); if (hit) hit.style.display = "none";
    host.classList.add("interacting");
    select(node.id);
  }
  function exitInteract() {
    if (!interactId) return;
    var id = interactId;
    interactId = null;
    var host = nodeEls[id];
    if (host) { host.classList.remove("interacting"); var hit = host.querySelector(".gvc-hit"); if (hit) hit.style.display = ""; }
    // keep the floating toolbar's Interact/Stop label honest (Esc, click-out, remote paths)
    if (selected.length === 1 && selected[0] === id) { var n = nodeById(id); if (n) showSelBar(n); }
  }
  // Pick a device viewport for a tile: shape it to that device's proportions, reflow the
  // iframe, refresh the floating toolbar's segment state.
  function setDevice(node, d) {
    node.device = d;
    var sz = DEVICE_SIZE[d] || DEVICE_SIZE.desktop;
    node.w = sz.w; node.h = sz.h;
    var host = nodeEls[node.id]; if (!host) return;
    host.style.width = node.w + "px"; host.style.height = node.h + "px";
    var body = host.querySelector(".gvc-tilebody");
    if (body && body.querySelector("iframe")) fitFrame(body, node);
    scaleTileChrome(node, host);
    if (isSelected(node.id) && selected.length === 1) showSelBar(node);
    positionSelBar();
    scheduleSave();
  }
  function showThumb(node, body) {
    body.innerHTML = "";
    var img = el("img", { alt: node.name || "" });
    var ph = el("div", { class: "ph", text: "Loading " + node.url + " …" });
    // A missing poster 404s asynchronously, and the tile may have been mounted (live
    // iframe, body cleared) by the time it does. Only fall back to the placeholder while
    // this poster is still what the tile is showing — otherwise the text ends up stranded
    // on top of a working frame and never goes away.
    img.addEventListener("error", function () {
      if (img.parentNode !== body) return;
      img.remove();
      if (!body.contains(ph)) body.appendChild(ph);
    });
    img.src = node.thumb || (node.url.replace(/\/?$/, "/") + "preview.webp");
    body.appendChild(img);
  }
  // A responsive page in a small frame either clips (fixed min-width) or reflows to a stray
  // mobile breakpoint. Instead we render the live iframe at a fixed DESKTOP viewport width and
  // CSS-scale it down to the tile — you always see the whole desktop page, top-aligned, matching
  // the poster thumbnail. clientWidth/Height are layout px (immune to the world's transform).
  function fitFrame(body, node) {
    var frame = body.querySelector("iframe"); if (!frame) return;
    var vw = body.clientWidth, vh = body.clientHeight; if (!vw) return;
    var dw = DEVICE_W[(node && node.device) || "desktop"] || DEVICE_W.desktop;
    var s = vw / dw;
    frame.style.width = dw + "px";
    frame.style.height = Math.ceil(vh / s) + "px";
    frame.style.transform = "scale(" + s + ")";
  }

  // ---- connectors (straight arrow / elbow / curved / plain line) -----------
  function renderArrow(node) {
    var x1 = node.x1, y1 = node.y1, x2 = node.x2, y2 = node.y2;
    var minX = Math.min(x1, x2), minY = Math.min(y1, y2), w = Math.max(1, Math.abs(x2 - x1)), h = Math.max(1, Math.abs(y2 - y1));
    var pad = 8;
    var host = el("div", { class: "gvc-arrow" });
    host.style.left = (minX - pad) + "px"; host.style.top = (minY - pad) + "px"; host.style.width = (w + pad * 2) + "px"; host.style.height = (h + pad * 2) + "px";
    var lx1 = x1 - minX + pad, ly1 = y1 - minY + pad, lx2 = x2 - minX + pad, ly2 = y2 - minY + pad;
    var kind = node.kind || "arrow", d, ang;
    if (kind === "elbow") {
      var mx = (lx1 + lx2) / 2;
      d = "M" + lx1 + " " + ly1 + " L" + mx + " " + ly1 + " L" + mx + " " + ly2 + " L" + lx2 + " " + ly2;
      ang = lx2 >= mx ? 0 : Math.PI;
    } else if (kind === "curved") {
      var cx = (lx1 + lx2) / 2 + (ly1 - ly2) * 0.3, cy = (ly1 + ly2) / 2 + (lx2 - lx1) * 0.3;
      d = "M" + lx1 + " " + ly1 + " Q" + cx + " " + cy + " " + lx2 + " " + ly2;
      ang = Math.atan2(ly2 - cy, lx2 - cx);
    } else {
      d = "M" + lx1 + " " + ly1 + " L" + lx2 + " " + ly2;
      ang = Math.atan2(ly2 - ly1, lx2 - lx1);
    }
    // Build the SVG as an innerHTML string so the HTML parser creates real SVG-namespaced nodes
    // — createElement("svg") makes a non-namespaced element that never paints.
    var svg = '<svg width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '" style="overflow:visible"><path d="' + d + '"/>';
    if (kind !== "line") {
      var ah = 11;
      var a1x = lx2 - ah * Math.cos(ang - Math.PI / 7), a1y = ly2 - ah * Math.sin(ang - Math.PI / 7);
      var a2x = lx2 - ah * Math.cos(ang + Math.PI / 7), a2y = ly2 - ah * Math.sin(ang + Math.PI / 7);
      svg += '<path d="M' + a1x + " " + a1y + " L" + lx2 + " " + ly2 + " L" + a2x + " " + a2y + '"/>';
    }
    host.innerHTML = svg + "</svg>";
    if (isSelected(node.id) && selected.length === 1) {
      [["1", lx1, ly1], ["2", lx2, ly2]].forEach(function (p) {
        var hd = el("div", { class: "gvc-handle" });
        hd.style.left = p[1] + "px"; hd.style.top = p[2] + "px";
        hd.addEventListener("pointerdown", function (e) { startArrowHandle(e, node, p[0]); });
        host.appendChild(hd);
      });
    }
    return host;
  }

  // ---- freehand drawing (marker / highlighter / washi tape) ----------------
  // A draw node's points are relative to (x,y); the host box is the stroke bbox and the svg
  // hangs -pad outside it so round caps never clip. Quadratic midpoint smoothing.
  function pathD(pts) {
    if (!pts.length) return "";
    if (pts.length < 3) {
      var d0 = "M" + pts[0][0] + " " + pts[0][1];
      return pts.length > 1 ? d0 + " L" + pts[1][0] + " " + pts[1][1] : d0 + " l.01 0";
    }
    var d = "M" + pts[0][0] + " " + pts[0][1];
    for (var i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += " Q" + pts[i][0] + " " + pts[i][1] + " " + mx + " " + my;
    }
    return d + " L" + pts[pts.length - 1][0] + " " + pts[pts.length - 1][1];
  }
  function strokeSvg(d, mode, color, width, w, h, pad) {
    var s = '<svg width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '" style="left:-' + pad + 'px;top:-' + pad + 'px">';
    if (mode === "highlighter") s += '<path d="' + d + '" stroke="' + color + '" stroke-width="' + width + '" stroke-opacity=".42"/>';
    else if (mode === "tape") s += '<path d="' + d + '" stroke="' + color + '" stroke-width="' + width + '" stroke-opacity=".9"/><path d="' + d + '" stroke="#fff" stroke-opacity=".5" stroke-width="' + (width * 0.45) + '" stroke-dasharray="0.5 ' + (width * 0.8) + '"/>';
    else s += '<path d="' + d + '" stroke="' + color + '" stroke-width="' + width + '"/>';
    return s + "</svg>";
  }
  function renderDraw(node) {
    var pad = Math.ceil((node.size || 3) / 2) + 8;
    var host = el("div", { class: "gvc-draw" + (node.mode === "highlighter" ? " hl" : "") });
    place(host, node);
    var pts = node.points.map(function (p) { return [p[0] + pad, p[1] + pad]; });
    host.innerHTML = strokeSvg(pathD(pts), node.mode, node.color || "#1e1e1e", node.size || 3, node.w || 1, node.h || 1, pad);
    return host;
  }
  function strokeWidth() {
    var thin = { marker: 3, highlighter: 12, tape: 16 }, thick = { marker: 7, highlighter: 20, tape: 26 };
    return (drawStyle.size === "thick" ? thick : thin)[drawStyle.mode] || 3;
  }
  // Eraser removes WHOLE strokes it touches (never partial strokes), draw nodes only.
  function eraseAt(wx, wy) {
    var r = 10 / board.view.scale + 4;
    for (var i = board.nodes.length - 1; i >= 0; i--) {
      var n = board.nodes[i];
      if (n.type !== "draw") continue;
      var hit = r + (n.size || 3) / 2;
      if (wx < n.x - hit || wx > n.x + (n.w || 0) + hit || wy < n.y - hit || wy > n.y + (n.h || 0) + hit) continue;
      var px = wx - n.x, py = wy - n.y, pts = n.points, found = false;
      for (var j = 0; j < pts.length && !found; j++) {
        var ax = pts[j][0], ay = pts[j][1];
        if (j === pts.length - 1) { found = Math.hypot(px - ax, py - ay) < hit; break; }
        var bx = pts[j + 1][0], by = pts[j + 1][1];
        var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        var t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        found = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) < hit;
      }
      if (found) removeNode(n.id);
    }
  }

  // ---- shapes (geometry + centered editable text) --------------------------
  // Geometry is authored in a 0..100 box and stretched (preserveAspectRatio=none);
  // vector-effect keeps the stroke width constant while the geometry scales.
  var VE = ' vector-effect="non-scaling-stroke"';
  var SHAPE_GEO = {
    square: '<rect x="1.5" y="1.5" width="97" height="97" rx="2"' + VE + "/>",
    round: '<rect x="1.5" y="1.5" width="97" height="97" rx="14"' + VE + "/>",
    circle: '<ellipse cx="50" cy="50" rx="48.5" ry="48.5"' + VE + "/>",
    diamond: '<polygon points="50,1.5 98.5,50 50,98.5 1.5,50"' + VE + "/>",
    triangle: '<polygon points="50,3 97,97 3,97"' + VE + "/>",
    "triangle-down": '<polygon points="3,3 97,3 50,97"' + VE + "/>",
    pill: '<rect x="1.5" y="1.5" width="97" height="97" rx="30"' + VE + "/>",
    cylinder: '<path d="M2 16v68c0 8 21.5 14 48 14s48-6 48-14V16"' + VE + '/><ellipse cx="50" cy="15" rx="48" ry="12"' + VE + "/>",
    bubble: '<path d="M11 2h78a9 9 0 0 1 9 9v54a9 9 0 0 1-9 9H40L14 97l8-23H11a9 9 0 0 1-9-9V11a9 9 0 0 1 9-9z"' + VE + "/>",
    star: '<polygon points="50,2 61.8,35.5 97.6,35.5 68.9,57.5 79.4,91.5 50,71 20.6,91.5 31.1,57.5 2.4,35.5 38.2,35.5"' + VE + "/>",
    hexagon: '<polygon points="25,3 75,3 97,50 75,97 25,97 3,50"' + VE + "/>",
    pentagon: '<polygon points="50,2 97,38 79,97 21,97 3,38"' + VE + "/>",
    parallelogram: '<polygon points="22,3 97,3 78,97 3,97"' + VE + "/>",
    trapezoid: '<polygon points="25,3 75,3 97,97 3,97"' + VE + "/>",
    plus: '<path d="M35 3h30v32h32v30H65v32H35V65H3V35h32z"' + VE + "/>",
    "arrow-right": '<path d="M3 35h55V12l39 38-39 38V65H3z"' + VE + "/>"
  };
  var SHAPE_SIZE = { square: [140, 140], round: [140, 140], circle: [140, 140], diamond: [150, 150], triangle: [150, 130], "triangle-down": [150, 130], pill: [180, 80], cylinder: [140, 160], bubble: [180, 130], star: [150, 150], hexagon: [150, 140], pentagon: [150, 140], parallelogram: [170, 120], trapezoid: [160, 120], plus: [140, 140], "arrow-right": [170, 120] };
  function shapeIcon(shape) {
    return '<svg viewBox="0 0 100 100" class="shp" preserveAspectRatio="none"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">' + SHAPE_GEO[shape] + "</g></svg>";
  }
  function renderShape(node) {
    var def = SHAPE_SIZE[node.shape] || [140, 140];
    node.w = node.w || def[0]; node.h = node.h || def[1];
    var host = el("div", { class: "gvc-shape" });
    host.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><g fill="' + (node.color || "#ffffff") + '" stroke="#777a80" stroke-width="1.4" stroke-linejoin="round">' + (SHAPE_GEO[node.shape] || SHAPE_GEO.square) + "</g></svg>";
    var txt = editableText(node, host, "");
    if (node.bold) txt.style.fontWeight = "700";
    host.appendChild(txt);
    place(host, node);
    return host;
  }

  // ---- sections (background containers with a colored label chip) ----------
  // node.color = the SOLID chip color; the fill is a light tint of it. node.locked =
  // "all" (frame + contents inert) | "bg" (only the background inert; work on top freely).
  function renderSection(node) {
    node.w = node.w || 520; node.h = node.h || 360;
    var host = el("div", { class: "gvc-section" });
    if (node.color) { host.style.background = node.color + "1f"; host.style.border = "2px solid " + node.color; }
    if (node.locked) host.classList.add("locked");
    host.appendChild(sectionLabel(node));
    place(host, node);
    scaleSectionLabel(node, host);
    return host;
  }
  // The label is a chip: section icon + editable name (+ a lock glyph when
  // locked). Solid color bg when colored; stays clickable even when the section is locked,
  // so the chip is how you re-select a locked section to unlock it.
  function sectionLabel(node) {
    var chip = el("div", { class: "gvc-seclabel" + (node.color ? " colored" : "") });
    if (node.color) chip.style.background = node.color;
    chip.innerHTML = '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">' + I_SECTION + "</svg>";
    var nm = wireRename(el("div", { class: "gvc-name", text: node.name || autoName("section"), contentEditable: "false", title: "Double-click to rename" }), node);
    chip.appendChild(nm);
    if (node.locked) chip.insertAdjacentHTML("beforeend", '<svg class="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' + I_LOCK + "</svg>");
    return chip;
  }
  // The section (if any) that locks a given node with "lock all" — i.e. the node's center
  // sits inside an all-locked section. Used to make locked contents inert (topmost wins).
  function sectionLockingNode(id) {
    var n = nodeById(id); if (!n || n.type === "section") return null;
    var cx = n.type === "arrow" ? (n.x1 + n.x2) / 2 : n.x + (n.w || 0) / 2;
    var cy = n.type === "arrow" ? (n.y1 + n.y2) / 2 : n.y + (n.h || 0) / 2;
    for (var i = board.nodes.length - 1; i >= 0; i--) {
      var s = board.nodes[i];
      if (s.type === "section" && s.locked === "all" && cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) return s;
    }
    return null;
  }

  // ---- tables (plain white cells; + strips on select add row/col)
  function renderTable(node) {
    node.rows = node.rows || 2; node.cols = node.cols || 2;
    node.w = node.w || node.cols * 190; node.h = node.h || node.rows * 88;
    node.cells = node.cells || {};
    var host = el("div", { class: "gvc-table" });
    host.style.gridTemplateColumns = "repeat(" + node.cols + ",1fr)";
    host.style.gridTemplateRows = "repeat(" + node.rows + ",1fr)";
    for (var r = 0; r < node.rows; r++) for (var c = 0; c < node.cols; c++) {
      var cell = el("div", { class: "gvc-cell", text: node.cells[r + "-" + c] || "" });
      cell.dataset.rc = r + "-" + c;
      cell.contentEditable = "false";
      cell.addEventListener("keydown", function (e) { e.stopPropagation(); });
      cell.addEventListener("pointerdown", function (e) { if (e.currentTarget.contentEditable === "true") e.stopPropagation(); });
      host.appendChild(cell);
    }
    place(host, node);
    return host;
  }
  function editCell(node, cellEl) {
    select(node.id);
    cellEl.contentEditable = "true"; cellEl.focus();
    if (document.execCommand) document.execCommand("selectAll", false, null);
    cellEl.addEventListener("blur", function onb() {
      cellEl.removeEventListener("blur", onb);
      cellEl.contentEditable = "false";
      node.cells[cellEl.dataset.rc] = cellEl.innerText.trim();
      scheduleSave();
    });
  }

  // ---- stamps --------------------------------------------------------------
  // Sticker keys render their die-cut SVG; anything else (old boards stored emoji chars)
  // falls back to text, so legacy stamps keep painting.
  function renderStamp(node) {
    node.w = node.w || 64; node.h = node.h || 64;
    var host = el("div", { class: "gvc-stamp" });
    var art = stampHtml(node.stamp);
    if (art) host.innerHTML = art;
    else {
      host.textContent = STAMP_ART[node.stamp] || node.stamp || "👍";
      host.style.fontSize = Math.round(node.h * 0.78) + "px";
    }
    place(host, node);
    return host;
  }

  // ---- pointer interaction (pan / move / resize / draw / place / pinch) ----
  var drag = null, lastTap = { id: null, t: 0 }, spaceDown = false, marquee = null;
  var pointers = {}; // live canvas pointers (touch) — two at once = pinch zoom/pan
  function isPan() { return spaceDown || TOOL.kind === "hand"; }
  function pinchBase() {
    var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]];
    return { dist: Math.max(12, Math.hypot(b.x - a.x, b.y - a.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function startPinch() {
    if (drag) {
      if (drag.mode === "stroke") drag.host.remove(); // a second finger mid-stroke = the palm — drop the stroke, zoom instead
      if (drag.mode === "marquee" && marquee) { marquee.remove(); marquee = null; }
    }
    root.classList.remove("panning");
    var b = pinchBase();
    drag = { mode: "pinch", dist0: b.dist, mid0: b.mid, v0: { x: board.view.x, y: board.view.y, scale: board.view.scale } };
  }
  root.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "touch" && e.button !== 0) return;
    if (e.target.closest && e.target.closest("#gvc-ui")) return;
    if (e.pointerType === "touch") {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(pointers).length === 2) { startPinch(); root.setPointerCapture(e.pointerId); return; }
      if (Object.keys(pointers).length > 2) return;
    }
    closePops();
    // a pointerdown anywhere OUTSIDE the interacting tile leaves interact mode (clicks
    // inside its iframe never reach the root, so interaction itself is unaffected)
    if (interactId && !(e.target.closest && e.target.closest(".gvc-node") === nodeEls[interactId])) exitInteract();
    if (cropState) { commitCrop(); return; } // click outside crop mode = commit; crop UI handlers stop propagation
    if (!isPan()) {
      // an armed tool takes precedence over node interaction — drawing happens on top of things
      if (TOOL.kind === "draw") {
        var sw = screenToWorld(e.clientX, e.clientY);
        var tmp = el("div", { class: "gvc-drawing" });
        world.appendChild(tmp);
        drag = { mode: "stroke", pts: [[sw.x, sw.y]], host: tmp };
        root.setPointerCapture(e.pointerId);
        return;
      }
      if (TOOL.kind === "eraser") {
        var ew = screenToWorld(e.clientX, e.clientY);
        eraseAt(ew.x, ew.y);
        drag = { mode: "erase" };
        root.setPointerCapture(e.pointerId);
        return;
      }
      if (TOOL.kind === "shape" || TOOL.kind === "section") {
        drag = { mode: "newshape", start: screenToWorld(e.clientX, e.clientY), node: null };
        root.setPointerCapture(e.pointerId);
        return;
      }
      if (TOOL.kind === "connector") {
        drag = { mode: "newconn", start: screenToWorld(e.clientX, e.clientY), node: null };
        root.setPointerCapture(e.pointerId);
        return;
      }
      if (TOOL.kind === "place") { placeAt(e); return; }
    }
    var pan = isPan();
    var nodeHost = (!pan && e.target.closest) ? e.target.closest(".gvc-node") : null;
    if (nodeHost && nodeHost.classList.contains("editing")) return;
    if (pan) {
      mpUnfollow();
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.view.x, oy: board.view.y };
      root.classList.add("panning");
    } else if (nodeHost) {
      var id = nodeHost.dataset.id, node = nodeById(id), now = Date.now();
      // "lock all" makes contents inert: a click on locked content selects the locking
      // section instead (so you can unlock), never the content itself.
      var lockSec = sectionLockingNode(id);
      if (lockSec) { setSelection([lockSec.id]); lastTap = { id: null, t: 0 }; return; }
      // Double-tap is detected on the second pointerDOWN but the ACTION is deferred to
      // pointer-UP, and only fires if the pointer didn't move in between — native dblclick
      // semantics. Acting at down bit hard: click-select then quickly drag (<350ms) threw
      // fast users into text-edit instead of moving the node.
      var dblAction = null;
      if (id === lastTap.id && now - lastTap.t < 350) {
        if (node.type === "sticky" || node.type === "text" || node.type === "shape") {
          dblAction = function () { enterEdit(id); }; // double-tap → edit text
        } else if (node.type === "table") {
          var cellEl = e.target.closest && e.target.closest(".gvc-cell");
          if (cellEl) dblAction = function () { editCell(node, cellEl); };
        } else if (node.type === "image") {
          dblAction = function () { enterCrop(node); }; // double-tap → crop mode
        } else if (node.type === "tile") {
          dblAction = function () { enterInteract(node); }; // double-tap → drive the prototype
        }
        if (dblAction) lastTap = { id: null, t: 0 };
      }
      if (!dblAction) lastTap = { id: id, t: now };
      // Shift means two things: shift-CLICK toggles the selection, shift-DRAG
      // locks the move to one axis. Resolve the ambiguity on pointerUP — a shift-click on an
      // already-selected node only drops it from the selection if the pointer never moved,
      // otherwise the shift was meant as the axis lock and the selection must survive it.
      var shiftToggle = null;
      if (e.shiftKey) { if (isSelected(id)) shiftToggle = id; else setSelection(selected.concat([id])); }
      else if (!isSelected(id)) setSelection([id]);
      // a section drags its contents with it; snapping still uses the SELECTION's box (you're
      // aligning the section, not its stickies) and must not treat the passengers as targets
      var moving = withSectionChildren(selected);
      drag = { mode: "move", sx: e.clientX, sy: e.clientY, moved: false, shiftToggle: shiftToggle, dblAction: dblAction, bbox: selectionRect(selected), items: moving.map(function (sid) { var n = nodeById(sid); return { id: sid, origId: sid, arrow: n.type === "arrow", ox: n.x, oy: n.y, ox1: n.x1, oy1: n.y1, ox2: n.x2, oy2: n.y2 }; }) };
      // Option-drag duplicates (the Figma idiom) — `origId` and `selBefore` are what let the
      // drag swap between the originals and their copies as Option goes down and up.
      drag.copying = false;
      drag.selBefore = selected.slice();
      armSnap(moving);
    } else if (e.pointerType === "touch") {
      // touch: one finger on empty canvas pans (no mouse to scroll with); two fingers pinch
      setSelection([]);
      mpUnfollow();
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.view.x, oy: board.view.y };
    } else {
      // empty drag → marquee selection; panning is Space-drag or scroll/trackpad
      if (!e.shiftKey) setSelection([]);
      drag = { mode: "marquee", sx: e.clientX, sy: e.clientY, base: selected.slice() };
      marquee = el("div", { class: "gvc-marquee" });
      marquee.style.left = e.clientX + "px"; marquee.style.top = e.clientY + "px";
      root.appendChild(marquee);
    }
    root.setPointerCapture(e.pointerId);
  });
  // ---- smart snapping + alignment guides ------------------------------------
  // Every node radiates six invisible alignment lines — its left/centre/right and
  // top/middle/bottom. While you drag or resize, the moving box latches onto the nearest one
  // within a few SCREEN pixels (so the feel is the same at every zoom) and a red guide is
  // drawn spanning both boxes. Hold ⌘/Ctrl to drag past them.
  var SNAP_PX = 6;
  var snapCands = null, guideLayer = null;
  function nodeRect(n) {
    if (!n || n.type === "arrow" || n.x == null) return null;
    var host = nodeEls[n.id];
    var w = n.w != null ? n.w : (host ? host.offsetWidth : 0);
    var h = n.h != null ? n.h : (host ? host.offsetHeight : 0);
    return w && h ? { x: n.x, y: n.y, w: w, h: h } : null;
  }
  // computed once per drag: every OTHER node's rect (the ones you're moving can't snap to
  // themselves, and re-walking the board on every pointermove would be wasteful)
  function armSnap(excludeIds) {
    snapCands = [];
    board.nodes.forEach(function (n) {
      if (excludeIds.indexOf(n.id) >= 0) return;
      var r = nodeRect(n); if (r) snapCands.push(r);
    });
  }
  function disarmSnap() { snapCands = null; clearGuides(); }
  // xs/ys = the world coords of the moving box's own edges that are allowed to latch on.
  // Returns the correction to apply plus the guides to draw.
  function snapRect(rect, xs, ys) {
    var out = { dx: 0, dy: 0, guides: [] };
    if (!snapCands || !snapCands.length) return out;
    var tol = SNAP_PX / board.view.scale, bx = null, by = null;
    snapCands.forEach(function (t) {
      [t.x, t.x + t.w / 2, t.x + t.w].forEach(function (tv) {
        xs.forEach(function (mv) {
          var d = tv - mv;
          if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d: d, v: tv, t: t };
        });
      });
      [t.y, t.y + t.h / 2, t.y + t.h].forEach(function (tv) {
        ys.forEach(function (mv) {
          var d = tv - mv;
          if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d: d, v: tv, t: t };
        });
      });
    });
    if (bx) { out.dx = bx.d; out.guides.push({ axis: "x", v: bx.v, a: rect, b: bx.t }); }
    if (by) { out.dy = by.d; out.guides.push({ axis: "y", v: by.v, a: rect, b: by.t }); }
    return out;
  }
  function showGuides(guides) {
    if (!guideLayer) { guideLayer = el("div", { id: "gvc-guides" }); root.appendChild(guideLayer); }
    guideLayer.innerHTML = "";
    guides.forEach(function (g) {
      var d = el("div", { class: "gvc-guide " + g.axis });
      if (g.axis === "x") {
        var a = worldToScreen(g.v, Math.min(g.a.y, g.b.y)), b = worldToScreen(g.v, Math.max(g.a.y + g.a.h, g.b.y + g.b.h));
        d.style.left = a.x + "px"; d.style.top = a.y + "px"; d.style.height = Math.max(1, b.y - a.y) + "px";
      } else {
        var c = worldToScreen(Math.min(g.a.x, g.b.x), g.v), e2 = worldToScreen(Math.max(g.a.x + g.a.w, g.b.x + g.b.w), g.v);
        d.style.left = c.x + "px"; d.style.top = c.y + "px"; d.style.width = Math.max(1, e2.x - c.x) + "px";
      }
      guideLayer.appendChild(d);
    });
  }
  function clearGuides() { if (guideLayer) guideLayer.innerHTML = ""; }
  // A section is a CONTAINER: dragging it takes everything sitting inside it along.
  // Membership is by the node's CENTRE being inside — forgiving for things that stick out a
  // little — and it's resolved at grab time, so what you pick up is exactly what you saw.
  function inRect(r, x, y) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
  function sectionChildIds(secId) {
    var sec = nodeById(secId); if (!sec || sec.type !== "section") return [];
    var sr = nodeRect(sec); if (!sr) return [];
    var out = [];
    board.nodes.forEach(function (n) {
      if (n.id === secId) return;
      if (n.type === "arrow") { // no box — carry it only if BOTH ends are inside
        if (inRect(sr, n.x1, n.y1) && inRect(sr, n.x2, n.y2)) out.push(n.id);
        return;
      }
      var r = nodeRect(n); if (!r) return;
      if (inRect(sr, r.x + r.w / 2, r.y + r.h / 2)) out.push(n.id);
    });
    return out;
  }
  // ---- Option-drag = duplicate ---------------------------------------------
  // Option is a LIVE MODIFIER, checked continuously for as long as the drag lasts — not a
  // decision made once at pointerdown. That's how Figma behaves and it's the only model that
  // survives contact with real hands: people press-and-drag first and reach for Option a
  // moment later, or let go of Option before the mouse. Both directions work, any number of
  // times, mid-drag.
  //
  // Entering: the copy is born exactly where the drag has GOT TO and the original snaps back
  // to where it started — so the node under your cursor stays under your cursor, and what you
  // let go of is the new one. Leaving: the original takes over from wherever the copy had got
  // to and the copy is deleted, so the drag carries on without a jump.
  //
  // The ORIGINALS keep their ids throughout. Deep links (#n=<id>), comment threads and a
  // tile's prototype folder stay attached to the node that was already there.
  function dragPos(n, arrow) { return arrow ? { x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 } : { x: n.x, y: n.y }; }
  function setDragPos(n, p, arrow) {
    if (arrow) { n.x1 = p.x1; n.y1 = p.y1; n.x2 = p.x2; n.y2 = p.y2; renderNode(n); }
    else { n.x = p.x; n.y = p.y; var h = nodeEls[n.id]; if (h) { h.style.left = n.x + "px"; h.style.top = n.y + "px"; } }
  }
  function altCopyEnter() {
    var map = {}, fresh = [];
    drag.items.forEach(function (it) {
      var n = nodeById(it.id); if (!n) return;
      var c = cloneNode(n, 0, 0);           // born where the drag has got to
      addNode(c);
      setDragPos(n, it.arrow ? { x1: it.ox1, y1: it.oy1, x2: it.ox2, y2: it.oy2 } : { x: it.ox, y: it.oy }, it.arrow);
      it.id = c.id;
      map[it.origId] = c.id; fresh.push(c.id);
    });
    if (!fresh.length) return;
    drag.copying = true;
    // the selection follows the copies, so the selection bar acts on what you're dragging and
    // releasing leaves the new nodes selected (drag them again, ⌘D them, style them)
    setSelection(drag.selBefore.map(function (id) { return map[id] || id; }));
    drag.shiftToggle = null; // a shift-toggle armed against the original is moot now
    // re-arm snapping on the copies — which also makes the originals valid snap targets, so a
    // duplicate can align to the node it came from
    armSnap(fresh);
  }
  function altCopyExit() {
    drag.copying = false;
    drag.items.forEach(function (it) {
      var copy = nodeById(it.id), orig = nodeById(it.origId);
      if (copy && orig && copy !== orig) { setDragPos(orig, dragPos(copy, it.arrow), it.arrow); removeNode(copy.id); }
      it.id = it.origId;
    });
    setSelection(drag.selBefore.slice());
    armSnap(drag.items.map(function (it) { return it.id; }));
  }
  // The gate: only ever flip during a move-drag that has actually MOVED — an Option-CLICK
  // that never moves must not leave an invisible duplicate stacked on the original.
  function altCopySync(wanted) {
    if (!drag || drag.mode !== "move" || !drag.moved) return;
    if (!!wanted === !!drag.copying) return;
    if (wanted) altCopyEnter(); else altCopyExit();
  }
  function withSectionChildren(ids) {
    var out = ids.slice();
    ids.forEach(function (id) {
      var n = nodeById(id);
      if (n && n.type === "section") sectionChildIds(id).forEach(function (cid) { if (out.indexOf(cid) < 0) out.push(cid); });
    });
    return out;
  }
  // the union box of everything being dragged — a multi-selection snaps as ONE box
  function selectionRect(ids) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    ids.forEach(function (id) {
      var r = nodeRect(nodeById(id)); if (!r) return;
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    });
    return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // Axis lock: holding Shift while dragging kills the off-axis component, so a move runs
  // dead horizontal or dead vertical (never diagonal). The dominant axis wins, and it can
  // switch mid-drag — Shift is read live off the pointer event, not latched at pointerdown.
  function axisLock(dx, dy, shift) {
    if (!shift) return [dx, dy];
    return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
  }
  root.addEventListener("pointermove", function (e) {
    if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (!drag) return;
    if (drag.mode === "pinch") {
      if (Object.keys(pointers).length < 2) return;
      var pb = pinchBase(), v = board.view;
      var ns = clampScale(drag.v0.scale * pb.dist / drag.dist0), f = ns / drag.v0.scale;
      v.x = pb.mid.x - (drag.mid0.x - drag.v0.x) * f;
      v.y = pb.mid.y - (drag.mid0.y - drag.v0.y) * f;
      v.scale = ns;
      applyTransform();
      return;
    }
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, sc = board.view.scale;
    if (drag.mode === "pan") { board.view.x = drag.ox + dx; board.view.y = drag.oy + dy; applyTransform(); }
    else if (drag.mode === "stroke") {
      var w = screenToWorld(e.clientX, e.clientY);
      var lp = drag.pts[drag.pts.length - 1];
      if (Math.hypot(w.x - lp[0], w.y - lp[1]) > 1.2) {
        drag.pts.push([w.x, w.y]);
        drag.host.innerHTML = '<svg style="overflow:visible" width="2" height="2"><path d="' + pathD(drag.pts) + '" fill="none" stroke="' + drawStyle.color + '" stroke-width="' + strokeWidth() + '" stroke-opacity="' + (drawStyle.mode === "highlighter" ? ".42" : "1") + '" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
    }
    else if (drag.mode === "erase") { var ep = screenToWorld(e.clientX, e.clientY); eraseAt(ep.x, ep.y); }
    else if (drag.mode === "newshape") {
      var sp = screenToWorld(e.clientX, e.clientY), st = drag.start;
      if (!drag.node && Math.hypot(sp.x - st.x, sp.y - st.y) * sc > 6) {
        drag.node = addNode(TOOL.kind === "section"
          ? { type: "section", x: st.x, y: st.y, w: 1, h: 1 }
          : { type: "shape", shape: TOOL.shape, x: st.x, y: st.y, w: 1, h: 1, text: "", color: "#ffffff" });
      }
      if (drag.node) {
        drag.node.x = Math.min(st.x, sp.x); drag.node.y = Math.min(st.y, sp.y);
        drag.node.w = Math.max(1, Math.abs(sp.x - st.x)); drag.node.h = Math.max(1, Math.abs(sp.y - st.y));
        place(nodeEls[drag.node.id], drag.node);
      }
    }
    else if (drag.mode === "newconn") {
      var cp = screenToWorld(e.clientX, e.clientY), cs = drag.start;
      if (!drag.node && Math.hypot(cp.x - cs.x, cp.y - cs.y) * sc > 6) {
        drag.node = addNode({ type: "arrow", kind: TOOL.conn, x1: cs.x, y1: cs.y, x2: cp.x, y2: cp.y });
      }
      if (drag.node) { drag.node.x2 = cp.x; drag.node.y2 = cp.y; renderNode(drag.node); }
    }
    else if (drag.mode === "move") {
      var mv = axisLock(dx, dy, e.shiftKey), wdx = mv[0] / sc, wdy = mv[1] / sc;
      drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 2;
      altCopySync(e.altKey); // Option can go down or up at any point in the drag
      if (drag.bbox && !(e.metaKey || e.ctrlKey)) {
        var pr = { x: drag.bbox.x + wdx, y: drag.bbox.y + wdy, w: drag.bbox.w, h: drag.bbox.h };
        var sn = snapRect(pr, [pr.x, pr.x + pr.w / 2, pr.x + pr.w], [pr.y, pr.y + pr.h / 2, pr.y + pr.h]);
        var lockedAxis = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? "y" : "x") : null; // never snap the axis Shift pinned
        if (lockedAxis !== "x") { wdx += sn.dx; pr.x += sn.dx; }
        if (lockedAxis !== "y") { wdy += sn.dy; pr.y += sn.dy; }
        showGuides(sn.guides.filter(function (g) { return g.axis !== lockedAxis; }));
      } else clearGuides();
      drag.items.forEach(function (it) {
        var n = nodeById(it.id); if (!n) return;
        if (it.arrow) { n.x1 = it.ox1 + wdx; n.y1 = it.oy1 + wdy; n.x2 = it.ox2 + wdx; n.y2 = it.oy2 + wdy; renderNode(n); }
        else { n.x = it.ox + wdx; n.y = it.oy + wdy; var h = nodeEls[it.id]; if (h) { h.style.left = n.x + "px"; h.style.top = n.y + "px"; } }
      });
      positionSelBar();
    }
    else if (drag.mode === "marquee") {
      var l = Math.min(drag.sx, e.clientX), t = Math.min(drag.sy, e.clientY), w2 = Math.abs(dx), h2 = Math.abs(dy);
      marquee.style.left = l + "px"; marquee.style.top = t + "px"; marquee.style.width = w2 + "px"; marquee.style.height = h2 + "px";
      var hits = drag.base.slice();
      board.nodes.forEach(function (n) {
        var en = nodeEls[n.id]; if (!en) return;
        var r = en.getBoundingClientRect();
        if (r.right >= l && r.left <= l + w2 && r.bottom >= t && r.top <= t + h2 && hits.indexOf(n.id) < 0) hits.push(n.id);
      });
      setSelection(hits);
    }
    else if (drag.mode === "resize") {
      // Any corner OR any edge: what you grabbed follows the pointer, the opposite side stays
      // pinned — so a west/north drag changes x/y as well as w/h. An edge (n/s/e/w) drives ONE
      // axis and freezes the other. Shift = keep the original aspect ratio (corners only:
      // locking the ratio off an edge would move a side you never touched).
      var n2 = drag.node, re = nodeEls[n2.id], d = drag.dir || "se";
      var west = d === "w" || d === "nw" || d === "sw", east = d === "e" || d === "ne" || d === "se";
      var north = d === "n" || d === "nw" || d === "ne";
      var doW = west || east, doH = north || d === "s" || d === "sw" || d === "se";
      var nw2 = doW ? Math.max(MIN_NODE, drag.ow + (west ? -dx : dx) / sc) : drag.ow;
      var nh2 = doH ? Math.max(MIN_NODE, drag.oh + (north ? -dy : dy) / sc) : drag.oh;
      if (e.shiftKey && doW && doH && n2.type !== "text" && drag.ow && drag.oh) {
        var ar = drag.ow / drag.oh;
        if (nw2 / ar >= nh2) nh2 = Math.max(MIN_NODE, nw2 / ar); else nw2 = Math.max(MIN_NODE, nh2 * ar);
      } else if (!(e.metaKey || e.ctrlKey)) {
        // snap the edges you're actually dragging to the neighbours' alignment lines
        var pr2 = { x: west ? drag.ox + (drag.ow - nw2) : drag.ox, y: north ? drag.oy + (drag.oh - nh2) : drag.oy, w: nw2, h: nh2 };
        var sn2 = snapRect(pr2, doW ? [west ? pr2.x : pr2.x + pr2.w] : [], doH ? [north ? pr2.y : pr2.y + pr2.h] : []);
        if (sn2.dx) nw2 = Math.max(MIN_NODE, nw2 + (west ? -sn2.dx : sn2.dx));
        if (sn2.dy) nh2 = Math.max(MIN_NODE, nh2 + (north ? -sn2.dy : sn2.dy));
        showGuides(sn2.guides);
      } else clearGuides();
      n2.w = nw2; re.style.width = n2.w + "px";
      if (west) { n2.x = drag.ox + (drag.ow - n2.w); re.style.left = n2.x + "px"; }
      // text: fixed WIDTH, auto height — the box wraps and grows downward as you type.
      if (n2.type === "text") { re.style.height = ""; }
      else {
        n2.h = nh2; re.style.height = n2.h + "px";
        if (north) { n2.y = drag.oy + (drag.oh - n2.h); re.style.top = n2.y + "px"; }
        if (n2.type === "tile") { var rb = re.querySelector(".gvc-tilebody"); if (rb) fitFrame(rb, n2); }
      }
      // draw strokes: the svg is px-fixed and the eraser/hit tests read points against
      // w/h, so a resize rescales the point cloud (from the captured base) and re-renders.
      if (n2.type === "draw" && drag.pts0) {
        var kx = drag.ow ? n2.w / drag.ow : 1, ky = drag.oh ? n2.h / drag.oh : 1;
        n2.points = drag.pts0.map(function (p) { return [p[0] * kx, p[1] * ky]; });
        renderNode(n2);
      }
      if (n2.type === "tile") scaleTileChrome(n2, re); else if (n2.type === "section") scaleSectionLabel(n2, re);
      positionSelBar(); }
    else if (drag.mode === "arrow") { var an = drag.node, av = axisLock(dx, dy, e.shiftKey); if (drag.end === "1") { an.x1 = drag.px + av[0] / sc; an.y1 = drag.py + av[1] / sc; } else { an.x2 = drag.px + av[0] / sc; an.y2 = drag.py + av[1] / sc; } renderNode(an); }
  });
  function onPointerEnd(e) {
    delete pointers[e.pointerId];
    disarmSnap();
    if (!drag) return;
    if (drag.mode === "pinch") {
      if (Object.keys(pointers).length < 2) { drag = null; saveView(); }
      return;
    }
    root.classList.remove("panning");
    if (drag.mode === "move" && drag.shiftToggle && !drag.moved) setSelection(selected.filter(function (s) { return s !== drag.shiftToggle; })); // shift-CLICK (no drag) = drop from selection
    if (drag.mode === "move" && drag.moved) lastTap = { id: null, t: 0 }; // a DRAG is not half a double-tap: two quick drags in a row must not open the text editor
    if (drag.mode === "move" && !drag.moved && drag.dblAction) { var act = drag.dblAction; drag = null; act(); scheduleSave(); return; } // the deferred double-tap: a real double-CLICK, not a click-then-drag
    if (drag.mode === "marquee" && marquee) { marquee.remove(); marquee = null; }
    if (drag.mode === "arrow") renderNode(drag.node);
    if (drag.mode === "resize" && (drag.node.type === "stamp" || drag.node.type === "draw")) renderNode(drag.node);
    if (drag.mode === "resize") {
      // you set a height by hand → the box stops hugging its text (it still grows rather than
      // clip, it just never shrinks under you again). Draw strokes are pure geometry — no
      // text to hug, so no hFixed on them (keeps the node schema clean).
      if (drag.node.type !== "text" && drag.node.type !== "draw" && Math.abs((drag.node.h || 0) - drag.oh) > 1) drag.node.hFixed = true;
      autoFit(drag.node, false); // a box dragged smaller than its text springs back now, not silently on the next reload
    }
    if (drag.mode === "stroke") {
      drag.host.remove();
      finishStroke(drag.pts);
    }
    if (drag.mode === "newshape") {
      var w = screenToWorld(e.clientX, e.clientY);
      var made = drag.node;
      if (!made) {
        made = TOOL.kind === "section"
          ? addNode({ type: "section", x: w.x - 260, y: w.y - 180 })
          : (function () { var d = SHAPE_SIZE[TOOL.shape] || [140, 140]; return addNode({ type: "shape", shape: TOOL.shape, x: w.x - d[0] / 2, y: w.y - d[1] / 2, text: "", color: "#ffffff" }); })();
      }
      select(made.id); pop(made.id);
      if (made.type === "shape") setTimeout(function () { enterEdit(made.id); }, 0);
      setTool("select");
    }
    if (drag.mode === "newconn") {
      var cw = screenToWorld(e.clientX, e.clientY);
      var conn = drag.node || addNode({ type: "arrow", kind: TOOL.conn, x1: cw.x - 70, y1: cw.y, x2: cw.x + 70, y2: cw.y });
      select(conn.id);
      setTool("select");
    }
    var wasPan = drag.mode === "pan";
    drag = null;
    if (wasPan) saveView(); else scheduleSave();
  }
  root.addEventListener("pointerup", onPointerEnd);
  root.addEventListener("pointercancel", onPointerEnd);
  function finishStroke(pts) {
    if (!pts.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); });
    var rel = pts.map(function (p) { return [Math.round((p[0] - minX) * 10) / 10, Math.round((p[1] - minY) * 10) / 10]; });
    var n = addNode({ type: "draw", mode: drawStyle.mode, color: drawStyle.color, size: strokeWidth(), x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY), points: rel });
    return n; // marker stays armed — keep sketching
  }
  function placeAt(e) {
    var w = screenToWorld(e.clientX, e.clientY);
    if (TOOL.type === "sticky") { spawnSticky(w); setTool("select"); }
    else if (TOOL.type === "text") { var t = addNode({ type: "text", x: w.x, y: w.y, text: "" }); select(t.id); setTimeout(function () { enterEdit(t.id); }, 0); setTool("select"); }
    else if (TOOL.type === "table") { var tb = addNode({ type: "table", x: w.x - 190, y: w.y - 88 }); select(tb.id); pop(tb.id); setTool("select"); }
    else if (TOOL.type === "stamp") { var st = addNode({ type: "stamp", stamp: armedStamp, x: w.x - 32, y: w.y - 32, w: 64, h: 64 }); pop(st.id); /* stamps stay armed */ }
  }
  function spawnSticky(w) {
    var n = addNode({ type: "sticky", x: w.x - STICKY_W / 2, y: w.y - STICKY_H / 2, w: STICKY_W, h: STICKY_H, text: "", color: DEFAULT_STICKY, author: ME });
    select(n.id); pop(n.id); setTimeout(function () { enterEdit(n.id); }, 0);
    return n;
  }
  // ow/oh fall back to the MEASURED element size — text nodes carry no w/h until first resized,
  // so reading node.w blind gave NaN and the handle silently did nothing (the "drag doesn't work" bug).
  function startResize(e, node, dir) { e.stopPropagation(); var h = nodeEls[node.id]; drag = { mode: "resize", node: node, dir: dir || "se", sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, ow: node.w != null ? node.w : (h ? h.offsetWidth : 150), oh: node.h != null ? node.h : (h ? h.offsetHeight : 100),
    // draw strokes rescale their POINTS (the model everything hit-tests against), always
    // from this captured base so a long drag never accumulates rounding drift
    pts0: node.type === "draw" && node.points ? node.points.map(function (p) { return p.slice(); }) : null }; armSnap([node.id]); root.setPointerCapture(e.pointerId); }
  function startArrowHandle(e, node, end) { e.stopPropagation(); drag = { mode: "arrow", node: node, end: end, sx: e.clientX, sy: e.clientY, px: end === "1" ? node.x1 : node.x2, py: end === "1" ? node.y1 : node.y2 }; root.setPointerCapture(e.pointerId); }

  // ---- image crop (double-tap an image; non-destructive) -------------------
  // Crop mode shows the FULL image ghosted at G (its world rect) with the visible window W
  // on top at full opacity: drag the corner/edge handles to move W's edges, drag anywhere
  // else (window or ghost) to slide the image under the window. Click outside or Enter
  // commits (node.x/y/w/h = W, crop = W as fractions of G); Esc cancels. src keeps the full
  // image, so double-tapping a cropped image later restores the hidden parts to re-adjust.
  var cropState = null;
  function enterCrop(node) {
    if (cropState) commitCrop();
    var c = node.crop || { x: 0, y: 0, w: 1, h: 1 };
    var G = { w: node.w / c.w, h: node.h / c.h };
    G.x = node.x - c.x * G.w; G.y = node.y - c.y * G.h;
    setSelection([]);
    if (nodeEls[node.id]) nodeEls[node.id].style.visibility = "hidden";
    var ghost = el("img", { class: "ghost", src: node.src });
    var winImg = el("img", { src: node.src });
    var win = el("div", { class: "gvc-cropwin" }, [el("div", { class: "clip" }, [winImg])]);
    var box = el("div", { class: "gvc-crop" }, [ghost, win]);
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(function (dir) {
      var h = el("div", { class: "gvc-croph " + (dir.length === 2 ? "corner " : "edge ") + dir });
      h.addEventListener("pointerdown", function (e) { startCropDrag(e, "win", dir); });
      win.appendChild(h);
    });
    box.addEventListener("pointerdown", function (e) { startCropDrag(e, "img", null); });
    box.addEventListener("pointermove", moveCropDrag);
    box.addEventListener("pointerup", endCropDrag);
    box.addEventListener("pointercancel", endCropDrag);
    world.appendChild(box);
    cropState = { node: node, G: G, W: { x: node.x, y: node.y, w: node.w, h: node.h }, box: box, win: win, winImg: winImg, drag: null };
    layoutCrop();
  }
  function layoutCrop() {
    var s = cropState, G = s.G, W = s.W;
    s.box.style.left = G.x + "px"; s.box.style.top = G.y + "px"; s.box.style.width = G.w + "px"; s.box.style.height = G.h + "px";
    s.win.style.left = (W.x - G.x) + "px"; s.win.style.top = (W.y - G.y) + "px"; s.win.style.width = W.w + "px"; s.win.style.height = W.h + "px";
    s.winImg.style.width = G.w + "px"; s.winImg.style.height = G.h + "px";
    s.winImg.style.left = (G.x - W.x) + "px"; s.winImg.style.top = (G.y - W.y) + "px";
  }
  function startCropDrag(e, kind, dir) {
    if (e.pointerType !== "touch" && e.button !== 0) return;
    e.stopPropagation();
    var s = cropState; if (!s) return;
    s.drag = { kind: kind, dir: dir || "", sx: e.clientX, sy: e.clientY, G0: { x: s.G.x, y: s.G.y }, W0: { x: s.W.x, y: s.W.y, w: s.W.w, h: s.W.h } };
    s.box.setPointerCapture(e.pointerId);
  }
  function moveCropDrag(e) {
    var s = cropState; if (!s || !s.drag) return;
    var d = s.drag, sc = board.view.scale, dx = (e.clientX - d.sx) / sc, dy = (e.clientY - d.sy) / sc;
    var G = s.G, W = s.W, MIN = 24;
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    if (d.kind === "img") {
      // slide the image under the fixed window, clamped so the window stays covered
      G.x = clamp(d.G0.x + dx, W.x + W.w - G.w, W.x);
      G.y = clamp(d.G0.y + dy, W.y + W.h - G.h, W.y);
    } else {
      // move the window edges named by dir ("nw" moves both), clamped inside G
      if (d.dir.indexOf("w") >= 0) { W.x = clamp(d.W0.x + dx, G.x, d.W0.x + d.W0.w - MIN); W.w = d.W0.x + d.W0.w - W.x; }
      if (d.dir.indexOf("e") >= 0) W.w = clamp(d.W0.w + dx, MIN, G.x + G.w - d.W0.x);
      if (d.dir.indexOf("n") >= 0) { W.y = clamp(d.W0.y + dy, G.y, d.W0.y + d.W0.h - MIN); W.h = d.W0.y + d.W0.h - W.y; }
      if (d.dir.indexOf("s") >= 0) W.h = clamp(d.W0.h + dy, MIN, G.y + G.h - d.W0.y);
    }
    layoutCrop();
  }
  function endCropDrag() { if (cropState) cropState.drag = null; }
  function commitCrop() {
    var s = cropState; if (!s) return;
    cropState = null;
    var n = s.node, G = s.G, W = s.W, r = function (v) { return Math.round(v * 1e4) / 1e4; };
    n.x = W.x; n.y = W.y; n.w = W.w; n.h = W.h;
    var c = { x: r((W.x - G.x) / G.w), y: r((W.y - G.y) / G.h), w: r(W.w / G.w), h: r(W.h / G.h) };
    if (c.w > 0.999 && c.h > 0.999) delete n.crop; else n.crop = c;
    s.box.remove();
    if (nodeEls[n.id]) nodeEls[n.id].style.visibility = "";
    renderNode(n); select(n.id); scheduleSave();
  }
  function cancelCrop() {
    var s = cropState; if (!s) return;
    cropState = null;
    s.box.remove();
    if (nodeEls[s.node.id]) nodeEls[s.node.id].style.visibility = "";
    select(s.node.id);
  }

  // ---- wheel zoom / trackpad pan ------------------------------------------
  root.addEventListener("wheel", function (e) {
    // Over the fixed UI layer (picker, etc.) let the browser scroll it natively — don't
    // preventDefault (which would eat the picker's scroll) and don't pan the canvas.
    if (e.target.closest && e.target.closest("#gvc-ui")) return;
    e.preventDefault();
    mpUnfollow(); // your hand on the camera always beats follow mode
    if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); }
    else { board.view.x -= e.deltaX; board.view.y -= e.deltaY; applyTransform(); saveView(); }
  }, { passive: false });

  // ---- keyboard ------------------------------------------------------------
  // The focused element, resolved THROUGH shadow roots: overlays (e.g. the comment
  // composer) render in shadow DOM, where document.activeElement is only the host
  // <div> — treating that as "not typing" made Space pan (and paste hijack) while
  // writing a comment on a board.
  function deepActive() {
    var ae = document.activeElement;
    while (ae && ae.shadowRoot && ae.shadowRoot.activeElement) ae = ae.shadowRoot.activeElement;
    return ae;
  }
  document.addEventListener("keydown", function (e) {
    if (cropState) { // crop mode owns the keyboard: Enter commits, Esc cancels, everything else is inert
      if (e.key === "Enter") { e.preventDefault(); commitCrop(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelCrop(); }
      return;
    }
    if (e.metaKey && e.key === ".") { e.preventDefault(); ui.classList.toggle("hidden"); return; }
    var ae = deepActive(), tag = ae ? ae.tagName : "";
    var editing = ae && (ae.isContentEditable || tag === "INPUT" || tag === "TEXTAREA");
    // Hold Space to pan (hand cursor); dragging empty space marquee-selects.
    if (e.code === "Space" && !editing && tag !== "BUTTON") { if (!spaceDown) { spaceDown = true; root.classList.add("hand"); } e.preventDefault(); return; }
    if (editing) return; // inside a text box the browser's own undo stack is the right one
    if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; } // the Windows redo key
    if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelection(); return; }
    // ⌘⇧C = a PICTURE of the selection, ⌘C = the nodes themselves. ⚠️ ORDER MATTERS: with Shift
    // held e.key is "C", so the ⌘C branch below matches this chord too — hence the shiftKey test
    // here, above it, and the !shiftKey test there. (Both must stay; either alone is a trap for
    // whoever reorders these lines next.)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); copyAsPng(); return; }
    // ⌘C/⌘X write the selection to the system clipboard; ⌘V is a `paste` listener (see the
    // clipboard section) because only the event carries clipboardData without a permission prompt
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "c" || e.key === "C")) { if (selected.length) { e.preventDefault(); clipCopy(false); } return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === "x" || e.key === "X")) { if (selected.length) { e.preventDefault(); clipCopy(true); } return; }
    if ((e.key === "Backspace" || e.key === "Delete") && selected.length) { e.preventDefault(); selected.slice().forEach(removeNode); setSelection([]); }
    if (e.key === "Escape") { exitInteract(); setSelection([]); if (picker) picker.classList.add("hidden"); if (sessPanel) sessToggle(false); setTool("select"); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // tool shortcuts
    var k = e.key.toLowerCase();
    if (e.shiftKey) {
      if (k === "s") setTool("section");
      else if (k === "t") setTool({ kind: "place", type: "table" });
      else if (k === "p") { drawStyle.mode = "marker"; setTool("draw"); } // ⇧P = pencil, same as M
      return;
    }
    if (e.key === "/") { e.preventDefault(); openCursorChat(); return; } // cursor chat
    if (k === "v") setTool("select");
    else if (k === "h") setTool("hand");
    else if (k === "m") { drawStyle.mode = "marker"; setTool("draw"); }
    else if (k === "s") setTool({ kind: "place", type: "sticky" });
    else if (k === "t") setTool({ kind: "place", type: "text" });
    else if (k === "e") setTool({ kind: "place", type: "stamp" });
    else if (k === "r") { armedShape = "square"; setTool({ kind: "shape", shape: "square" }); }
    else if (k === "o") { armedShape = "circle"; setTool({ kind: "shape", shape: "circle" }); }
    else if (k === "l") { armedConnector = "line"; setTool({ kind: "connector", conn: "line" }); }
    else if (k === "x") { armedConnector = "elbow"; setTool({ kind: "connector", conn: "elbow" }); }
    else if (k === "c") { setTool("select"); toggleComments(); }
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "Space") { spaceDown = false; if (TOOL.kind !== "hand") root.classList.remove("hand"); }
  });
  // Holding Option flips every node to the copy cursor, so the duplicate-drag is discoverable
  // instead of folklore. Cleared on window blur too — Option is how you reach a lot of macOS
  // shortcuts, and coming back to a canvas stuck on the copy cursor would just be a lie.
  // These also drive the duplicate itself, not just the cursor: pressing Option with the mouse
  // already down and STILL should flip the drag to copying right then. Waiting for the next
  // pointermove would mean holding Option changed nothing until you jiggled the mouse.
  function altCue(on) { root.classList.toggle("altcopy", !!on); altCopySync(on); }
  document.addEventListener("keydown", function (e) { if (e.key === "Alt") altCue(true); });
  document.addEventListener("keyup", function (e) { if (e.key === "Alt") altCue(false); });
  window.addEventListener("blur", function () { altCue(false); });

  // ---- image drop from desktop --------------------------------------------
  // Nodes are NEVER a native HTML5 drag source. The browser will happily start one of its own
  // from a node's text run or an <img> — which paints a ghost copy under the cursor and fires
  // dragover, lighting up the "drop image" overlay in the middle of an ordinary node drag (bit
  // by exactly that on text nodes). The canvas moves nodes with its own pointer handlers, so
  // kill it at the source. The one exception is a node being EDITED, where dragging a text
  // selection around inside the box is a real affordance.
  root.addEventListener("dragstart", function (e) {
    var t = e.target && e.target.closest ? e.target.closest(".gvc-node") : null;
    if (t && !t.classList.contains("editing")) e.preventDefault();
  });
  // ...and the overlay only ever answers to a drag carrying FILES, so no internal drag can
  // summon it even if one slips through.
  function dragHasFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, "Files") >= 0;
  }
  root.addEventListener("dragover", function (e) { if (!dragHasFiles(e)) return; e.preventDefault(); root.classList.add("dropping"); });
  root.addEventListener("dragleave", function (e) { if (e.target === root) root.classList.remove("dropping"); });
  root.addEventListener("drop", function (e) {
    e.preventDefault(); root.classList.remove("dropping");
    var files = e.dataTransfer && e.dataTransfer.files; if (!files || !files.length) return;
    var w = screenToWorld(e.clientX, e.clientY);
    Array.prototype.forEach.call(files, function (f, i) {
      if (!/^image\//.test(f.type)) return;
      compressImage(f, function (dataUrl, dim) { addNode({ type: "image", x: w.x + i * 24, y: w.y + i * 24, w: dim.w, h: dim.h, src: dataUrl, alpha: dim.alpha || undefined }); });
    });
  });
  // Does the drawn bitmap actually USE its alpha channel? JPEG has none, so re-encoding a
  // cut-out PNG as JPEG composites it onto the canvas's transparent black and lands a solid
  // BLACK box on the board (bit by exactly that on a dropped lens-flare PNG). Photos are the
  // common case and JPEG is much smaller than the alpha-capable formats, so don't switch
  // format blind — look. A JPEG source can't carry alpha at all, so skip the scan there.
  // getImageData can't taint here: the bitmap came from a local File, not a remote URL.
  function usesAlpha(ctx, w, h, file) {
    if (file && file.type === "image/jpeg") return false;
    var d;
    try { d = ctx.getImageData(0, 0, w, h).data; } catch (err) { return true; } // can't tell → keep alpha
    for (var i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
    return false;
  }
  // Compress, then get the image OUT of the document: upload it once to /__asset
  // (content-hashed, immutable) and hand back the tiny URL — so the board doc, every KV
  // write, every room seed and every diff-tick stringify stops carrying the pixels. The
  // data-URL path survives as the fallback (upload failed / offline sandbox); old boards
  // with inlined data URLs render unchanged (<img src> takes either form).
  function compressImage(file, cb) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, IMG_MAX_DIM / Math.max(img.width, img.height));
      var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      var dw = Math.min(w, 360), dh = Math.round(dw * h / w);
      // Transparent images go out as WebP: it keeps alpha and stays far smaller than PNG on
      // the photo-ish artwork these tend to be. Quality is higher than IMG_QUALITY because
      // that aggressive 0.55 visibly bands the smooth gradients cut-outs are usually made of.
      // A browser that can't encode the type falls back to PNG on its own (the toBlob spec),
      // which also keeps alpha — so label the upload from blob.type, not from what we asked
      // for. /__asset already accepts and stores jpeg/png/webp/gif and serves the type back.
      var alpha = usesAlpha(ctx, w, h, file);
      var fmt = alpha ? "image/webp" : "image/jpeg", quality = alpha ? 0.8 : IMG_QUALITY;
      function dataUrlFallback() {
        var out; try { out = c.toDataURL(fmt, quality); } catch (err) { out = c.toDataURL(); }
        cb(out, { w: dw, h: dh, alpha: alpha });
      }
      try {
        c.toBlob(function (blob) {
          if (!blob) return dataUrlFallback();
          fetch("/__asset", { method: "POST", headers: { "content-type": blob.type || fmt }, body: blob })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { if (d && d.url) cb(d.url, { w: dw, h: dh, alpha: alpha }); else dataUrlFallback(); })
            .catch(dataUrlFallback);
        }, fmt, quality);
      } catch (err) { dataUrlFallback(); }
    };
    img.src = URL.createObjectURL(file);
  }

  // ---- clipboard: copy · cut · paste (⌘C / ⌘X / ⌘V) ------------------------
  // Cross-tab and cross-BOARD, because the payload rides the SYSTEM clipboard and not a JS
  // variable: ⌘C serialises the selection to JSON and writes it as text/plain, ⌘V parses it
  // back. That IS the feature — an in-memory clipboard would only work inside one page, and
  // the thing people actually want is "these three stickies, over there, in the other tab".
  // Images ride along for free: an image node's `src` is an absolute, immutable
  // /__asset/<hash> path, so what travels is a URL, not pixels. The one trip that does NOT
  // work is pasting into a DIFFERENT ORIGIN — /__asset is per-site, so the node would land
  // pointing at a 404 (deliberately not solved: re-uploading someone else's site's bytes on
  // paste is a much bigger decision than it looks).
  //
  // ⌘V also takes things that never came from a canvas: an image on the clipboard (a
  // screenshot, "copy image" from anywhere) becomes an image node through the same
  // compress + upload path as a drop, and plain text becomes a text node. Paste doing
  // NOTHING was the old behaviour and it read as broken.
  var CLIP_TAG = "augur.canvas/1";
  var CLIP_MAX = 400;               // one paste can't carpet-bomb a board
  // renderNode's dispatch, mirrored — anything not in here is not a node we know how to draw
  var CLIP_TYPES = { sticky: 1, text: 1, image: 1, tile: 1, arrow: 1, draw: 1, shape: 1, section: 1, table: 1, stamp: 1 };
  var CLIP_MODES = { marker: 1, highlighter: 1, tape: 1 };
  var CLIP_KINDS = { arrow: 1, elbow: 1, curved: 1, line: 1 };
  var CLIP_ALIGN = { left: 1, center: 1, right: 1 };
  var CLIP_DEVICE = { desktop: 1, tablet: 1, phone: 1 };

  function clipCopy(cut) {
    var nodes = [];
    selected.forEach(function (id) { var n = nodeById(id); if (n) nodes.push(histClone(n)); });
    if (!nodes.length) return;
    var text = JSON.stringify({ tag: CLIP_TAG, origin: BOARD_PATH, nodes: nodes });
    var label = nodes.length + (nodes.length === 1 ? " node" : " nodes");
    // the delete half of a CUT only runs once the clipboard write actually landed — a failed
    // write that had already deleted the nodes would be data loss with no undo affordance
    var done = function () {
      if (cut) { nodes.forEach(function (n) { removeNode(n.id); }); setSelection([]); }
      toast((cut ? "Cut " : "Copied ") + label + " — ⌘V on any board");
    };
    var fail = function () { toast("Couldn't reach the clipboard"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { if (legacyCopy(text)) done(); else fail(); });
      return;
    }
    if (legacyCopy(text)) done(); else fail();
  }

  // Paste lands at the POINTER, centred — "where I'm looking" beats "where it came from",
  // and it's the only sane answer when the source board's coordinates mean nothing here.
  // Pasting repeatedly without moving the mouse walks the copies diagonally instead of
  // stacking them into one unclickable pile.
  var pasteAnchor = null, pasteNudge = 0;
  function clipTarget() {
    var w = screenToWorld(lastMouse.x, lastMouse.y);
    if (pasteAnchor && Math.abs(pasteAnchor.x - w.x) < 1 && Math.abs(pasteAnchor.y - w.y) < 1) pasteNudge += 28;
    else { pasteAnchor = { x: w.x, y: w.y }; pasteNudge = 0; }
    return { x: w.x + pasteNudge, y: w.y + pasteNudge };
  }
  // geometry without touching the DOM — these nodes aren't rendered yet, so nodeRect() (which
  // measures hug-width text off its element) has nothing to read
  function clipRect(n) {
    if (n.type === "arrow") return { x: Math.min(n.x1, n.x2), y: Math.min(n.y1, n.y2), w: Math.abs(n.x2 - n.x1), h: Math.abs(n.y2 - n.y1) };
    return { x: n.x || 0, y: n.y || 0, w: n.w || 160, h: n.h || 160 };
  }
  function clipMove(n, dx, dy) {
    if (n.type === "arrow") { n.x1 += dx; n.y1 += dy; n.x2 += dx; n.y2 += dy; }
    else { n.x = (n.x || 0) + dx; n.y = (n.y || 0) + dy; }
  }

  // ---- sanitizing an incoming node ----------------------------------------
  // The clipboard is UNTRUSTED INPUT. Whatever we accept is pushed into board.nodes, written
  // to shared KV, and broadcast over the room socket into everyone else's DOM — so a bad
  // paste is stored XSS for the whole board, not just for you. A pasted node is therefore
  // REBUILT field by field, never spread in: known type, fresh id, rich text through the same
  // sanitizer the editors use, numbers coerced, enums whitelisted, and the fields that become
  // a live URL held to same-origin paths.
  function clipNum(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clipStr(v, max) { return v == null ? "" : String(v).slice(0, max || 4000); }
  // Colour is the sharp edge: renderShape and renderDraw CONCATENATE node.color into an
  // innerHTML string, so a colour of `"/><img src=x onerror=…>` executes. Hex literals only.
  function clipColor(v) { v = String(v == null ? "" : v); return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : ""; }
  // Same-origin absolute path. Never protocol-relative (`//host` is another origin), never a
  // scheme — which is what keeps `javascript:` and someone else's server out.
  function clipPath(v) { v = String(v == null ? "" : v); return /^\/(?!\/)[^\s"'<>]*$/.test(v) ? v : ""; }
  // An image src is ANY same-origin path, not just /__asset/<hash>. CANVAS.md's schema row
  // describes uploads, but boards are also built by hand and by agents pointing straight at
  // images committed in the space repo (`/ux-ui-audit/…/img/04-method.jpg`) — on the timings
  // board that's most of them. Held to the same rule as a tile url: an <img> at a same-origin
  // path can do nothing worse than 404.
  function clipSrc(v) {
    v = String(v == null ? "" : v);
    if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]*$/.test(v)) return v; // legacy inlined boards
    return clipPath(v);
  }

  function clipSanitize(raw) {
    if (!raw || typeof raw !== "object" || !CLIP_TYPES[raw.type]) return null;
    var n = { id: uid(), type: raw.type };
    if (raw.type !== "arrow") { n.x = clipNum(raw.x, 0); n.y = clipNum(raw.y, 0); }
    if (raw.w != null) n.w = Math.max(1, clipNum(raw.w, 160));
    if (raw.h != null) n.h = Math.max(1, clipNum(raw.h, 160));
    if (raw.name != null) n.name = clipStr(raw.name, 200);
    if (raw.desc != null) n.desc = clipStr(raw.desc, 600);
    if (raw.author != null) n.author = clipStr(raw.author, 120);
    if (raw.text != null) n.text = clipStr(raw.text, 20000);
    if (raw.rich != null) { var h = sanitizeRich(raw.rich); if (hasRichMarkup(h)) n.rich = h; }
    var col = clipColor(raw.color); if (col) n.color = col;
    if (raw.fontSize != null) n.fontSize = Math.max(6, Math.min(400, clipNum(raw.fontSize, 16)));
    if (raw.bold) n.bold = true;
    if (raw.italic) n.italic = true;
    if (raw.strike) n.strike = true;
    if (raw.hFixed) n.hFixed = true;
    if (CLIP_ALIGN[raw.align]) n.align = raw.align;
    if (raw.locked === true) n.locked = true;
    else if (raw.locked === "all" || raw.locked === "bg") n.locked = raw.locked;

    if (n.type === "image") {
      n.src = clipSrc(raw.src);
      if (!n.src) return null; // an image we can't vouch for the src of isn't an image
      if (raw.alpha) n.alpha = true; // carry the cut-out flag, or the paste flashes a white card until the probe lands
      if (raw.crop) n.crop = { x: clipNum(raw.crop.x, 0), y: clipNum(raw.crop.y, 0), w: clipNum(raw.crop.w, 1), h: clipNum(raw.crop.h, 1) };
    } else if (n.type === "tile") {
      n.url = clipPath(raw.url);
      if (!n.url) return null;
      var live = clipPath(raw.liveUrl); if (live) n.liveUrl = live;
      if (CLIP_DEVICE[raw.device]) n.device = raw.device;
    } else if (n.type === "arrow") {
      n.x1 = clipNum(raw.x1, 0); n.y1 = clipNum(raw.y1, 0);
      n.x2 = clipNum(raw.x2, 120); n.y2 = clipNum(raw.y2, 0);
      if (CLIP_KINDS[raw.kind]) n.kind = raw.kind;
    } else if (n.type === "draw") {
      if (!Array.isArray(raw.points) || !raw.points.length) return null;
      // points go straight into an SVG `d` attribute — coerce every one to a real number
      n.points = raw.points.slice(0, 5000).map(function (p) { return [clipNum(p && p[0], 0), clipNum(p && p[1], 0)]; });
      if (CLIP_MODES[raw.mode]) n.mode = raw.mode;
      n.size = Math.max(1, Math.min(200, clipNum(raw.size, 3)));
    } else if (n.type === "shape") {
      n.shape = SHAPE_GEO[raw.shape] ? raw.shape : "square";
    } else if (n.type === "stamp") {
      n.stamp = STAMPS.indexOf(raw.stamp) >= 0 ? raw.stamp : STAMPS[0];
    } else if (n.type === "table") {
      n.rows = Math.max(1, Math.min(60, Math.round(clipNum(raw.rows, 2))));
      n.cols = Math.max(1, Math.min(30, Math.round(clipNum(raw.cols, 2))));
      n.cells = {};
      if (raw.cells && typeof raw.cells === "object") {
        for (var k in raw.cells) if (/^\d{1,3}-\d{1,3}$/.test(k)) n.cells[k] = clipStr(raw.cells[k], 4000);
      }
    }
    return n;
  }

  function clipPasteNodes(payload, target) {
    var clean = [];
    for (var i = 0; i < payload.nodes.length && clean.length < CLIP_MAX; i++) {
      var n = clipSanitize(payload.nodes[i]);
      if (n) clean.push(n);
    }
    if (!clean.length) { toast("Nothing pasteable on the clipboard"); return; }
    // centre the whole group on the pointer, preserving the layout the copy was made in
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    clean.forEach(function (n) {
      var r = clipRect(n);
      if (r.x < x0) x0 = r.x; if (r.y < y0) y0 = r.y;
      if (r.x + r.w > x1) x1 = r.x + r.w; if (r.y + r.h > y1) y1 = r.y + r.h;
    });
    var dx = target.x - (x0 + x1) / 2, dy = target.y - (y0 + y1) / 2;
    var sameBoard = payload.origin === BOARD_PATH, ids = [];
    clean.forEach(function (n) {
      clipMove(n, dx, dy);
      // same-board tile copies get a distinct name for the same reason ⌘D's do — names are the
      // shared vocabulary, and canvas-screen.mjs dup looks for the "… copy" tile
      if (sameBoard && n.type === "tile" && n.name) n.name = n.name + " copy";
      addNode(n); ids.push(n.id); pop(n.id);
    });
    setSelection(ids);
    scheduleSave();
    var dropped = payload.nodes.length - clean.length;
    toast("Pasted " + clean.length + (clean.length === 1 ? " node" : " nodes") + (dropped > 0 ? " (" + dropped + " skipped)" : ""));
  }

  document.addEventListener("paste", function (e) {
    // a text box owns its own paste (the sticky/text editors handle it, plain-text-only) and
    // crop mode owns the whole keyboard; deepActive: shadow-DOM overlay inputs count too
    var ae = deepActive(), tag = ae ? ae.tagName : "";
    if (ae && (ae.isContentEditable || tag === "INPUT" || tag === "TEXTAREA")) return;
    if (cropState) return;
    var cd = e.clipboardData; if (!cd) return;

    // 1) an image on the clipboard → the same compress + /__asset upload a drop gets
    var imgs = [];
    for (var i = 0; i < (cd.files ? cd.files.length : 0); i++) if (/^image\//.test(cd.files[i].type)) imgs.push(cd.files[i]);
    if (imgs.length) {
      e.preventDefault();
      var at = clipTarget(), landed = [];
      imgs.forEach(function (f, k) {
        compressImage(f, function (src, dim) {
          var n = addNode({ type: "image", x: at.x + k * 24, y: at.y + k * 24, w: dim.w, h: dim.h, src: src, alpha: dim.alpha || undefined });
          pop(n.id); landed.push(n.id); setSelection(landed.slice());
          scheduleSave();
        });
      });
      return;
    }

    var txt = cd.getData("text/plain") || "";
    if (!txt) return;

    // 2) nodes copied off a canvas — this tab's or any other
    if (txt.charAt(0) === "{" && txt.indexOf(CLIP_TAG) > 0) {
      var payload = null;
      try { payload = JSON.parse(txt); } catch (err) { payload = null; }
      if (payload && payload.tag === CLIP_TAG && Array.isArray(payload.nodes)) {
        e.preventDefault();
        clipPasteNodes(payload, clipTarget());
        return;
      }
    }

    // 3) anything else is text — a text node, so a paste is never a no-op
    e.preventDefault();
    var w = clipTarget();
    var t = addNode({ type: "text", x: w.x, y: w.y, w: 360, text: txt.slice(0, 20000), name: txt.split("\n")[0].slice(0, 60) || "Text" });
    pop(t.id); setSelection([t.id]);
    scheduleSave();
  });

  // ---- copy as PNG (⌘⇧C) ---------------------------------------------------
  // The keystroke replaces the manual screenshot round-trip: a picture of the selection, on
  // the system clipboard, ready to paste into a chat. Two things make it worth more than ⌘⇧4:
  // it renders at 2x the node's NATURAL size whatever the board is zoomed to (a tile you're
  // reading at 30% still comes out crisp), and it knows where the node ends, so no cropping.
  //
  // SCREENSHOT semantics, deliberately unlike Figma's cut-out-on-transparency: the shot is the
  // selection's box plus a small bleed, holding EVERYTHING visible in that rectangle — the
  // paper, the grid, and every node that overlaps it. A note sitting on a section brings the
  // section's colour with it, which is what a screenshot would have given you. What does NOT
  // come along is editor chrome (selection rings, handles, peer cursors, comment pins): those
  // are how you WORK the board, not what's on it.
  var PNG_SCALE = 2, PNG_BLEED = 12;
  var captureLoad = null;
  function loadCapture() {
    if (window.GVCanvasCapture) return Promise.resolve(window.GVCanvasCapture);
    if (captureLoad) return captureLoad;
    // ~350 lines of rasterizer that most sessions never need — fetched on the first ⌘⇧C and
    // then cached. /__canvas/* is served no-store, so this is never a stale-engine risk.
    captureLoad = new Promise(function (resolve, reject) {
      var s = el("script", { src: "/__canvas/capture.js" });
      s.onload = function () { if (window.GVCanvasCapture) resolve(window.GVCanvasCapture); else reject(new Error("capture")); };
      s.onerror = function () { captureLoad = null; reject(new Error("capture")); };
      document.head.appendChild(s);
    });
    return captureLoad;
  }
  // A frame's name chip and a section's label float ABOVE their node's box, so a shot framed on
  // the box alone slices the label off the top. They're content (they're the node's name), so
  // the box grows to hold them — and only them; every other overhanging child is chrome.
  var PNG_LABELS = ".gvc-tilename,.gvc-seclabel,.gvc-name";
  function labelBox(host, r) {
    if (!host) return r;
    Array.prototype.forEach.call(host.children, function (ch) {
      if (!ch.matches || !ch.matches(PNG_LABELS) || !ch.offsetHeight) return;
      var lx = host.offsetLeft + ch.offsetLeft, ly = host.offsetTop + ch.offsetTop;
      var lw = ch.offsetWidth, lh = ch.offsetHeight;
      r = { x: Math.min(r.x, lx), y: Math.min(r.y, ly),
            w: Math.max(r.x + r.w, lx + lw) - Math.min(r.x, lx),
            h: Math.max(r.y + r.h, ly + lh) - Math.min(r.y, ly) };
    });
    return r;
  }
  function pngRect() {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    selected.forEach(function (id) {
      var r = anyRect(nodeById(id)); if (!r) return;
      r = labelBox(nodeEls[id], r);
      any = true;
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    if (!any) return null;
    // the bleed keeps a sticky's drop shadow (and a section's label chip) inside the frame
    return { x: x0 - PNG_BLEED, y: y0 - PNG_BLEED, w: (x1 - x0) + PNG_BLEED * 2, h: (y1 - y0) + PNG_BLEED * 2 };
  }
  // every node whose box overlaps the shot, in DOM order = Z-ORDER. offsetLeft/Top/Width/Height
  // are layout px, immune to the world transform — the same reason fitFrame reads them.
  function pngEls(rect) {
    var out = [];
    Array.prototype.forEach.call(world.children, function (ch) {
      var id = ch.dataset ? ch.dataset.id : null;
      if (!id || nodeEls[id] !== ch) return;
      var l = ch.offsetLeft, t = ch.offsetTop, w = ch.offsetWidth, h = ch.offsetHeight;
      if (l + w < rect.x || t + h < rect.y || l > rect.x + rect.w || t > rect.y + rect.h) return;
      out.push(ch);
    });
    return out;
  }
  function pngPoster(host) {
    var n = nodeById(host.dataset.id);
    if (!n || n.type !== "tile" || !n.url) return null;
    return n.thumb || (n.url.replace(/\/?$/, "/") + "preview.webp"); // the tile's own fallback
  }
  function pngBackground() {
    var g = gridSpec(1); // the capture is at natural scale, so the grid is its scale-1 spec
    var fill = "#f6f6f6";
    try { fill = getComputedStyle(root).backgroundColor || fill; } catch (e) {}
    return { fill: fill, dot: DOT_COLOR, step: g.step, r: g.r };
  }
  function pngName() {
    var n = selected.length === 1 ? nodeById(selected[0]) : null;
    var base = (n && n.name) || board.name || "canvas";
    base = base.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
    return (base || "canvas") + ".png";
  }
  function downloadPng(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = el("a", { href: u, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 8000);
  }
  function copyAsPng() {
    var rect = selected.length ? pngRect() : null;
    if (!rect) { toast("Select something to copy as PNG"); return; }
    var name = pngName(), info = null;
    toast("Copying as PNG…");
    var blobP = loadCapture().then(function (cap) {
      return cap.nodesToPng({
        els: pngEls(rect), rect: rect, scale: PNG_SCALE,
        background: pngBackground(), poster: pngPoster,
        onInfo: function (i) { info = i; }
      });
    });
    // ⚠️ The PROMISE goes to the clipboard, not the blob — Safari only allows a clipboard write
    // in the same task as the gesture that asked for it, and rasterizing takes far longer than
    // that. ClipboardItem accepts a pending blob for exactly this reason.
    var wrote = null;
    try {
      if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === "function") {
        wrote = navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
      }
    } catch (e) { wrote = null; }
    var ok = function () {
      var extra = info && info.downgraded ? " (scaled down to fit)" : (info && info.frames.failed ? " (a live frame fell back to its poster)" : "");
      toast("Copied as PNG" + extra);
    };
    // any clipboard refusal downloads the file instead — never silently nothing
    var fallback = function () {
      blobP.then(function (b) { downloadPng(b, name); toast("Clipboard refused it — downloaded " + name); }, function () {});
    };
    blobP.catch(function () { toast("Couldn't render that as a PNG"); });
    if (wrote) wrote.then(ok, fallback); else blobP.then(function (b) { downloadPng(b, name); toast("This browser can't put images on the clipboard — downloaded " + name); }, function () {});
  }

  // ---- selection toolbar (sticky / shape / draw / table) -------------------
  var selBar, palette, lockMenu, fontMenu, picker, catalog = null;
  function showSelBar(node) {
    selBar.innerHTML = "";
    // tiles: device viewport segment + interact + open — the actions that used to crowd the
    // tile bar, now at constant screen size on the floating toolbar
    if (node.type === "tile") {
      ["desktop", "tablet", "phone"].forEach(function (d) {
        var b = el("button", { type: "button", class: "btn dev" + ((node.device || "desktop") === d ? " on" : ""), title: d.charAt(0).toUpperCase() + d.slice(1), html: DEV_ICON[d] });
        guard(b); b.addEventListener("click", function (e) { e.stopPropagation(); setDevice(node, d); });
        selBar.appendChild(b);
      });
      selBar.appendChild(el("div", { class: "div" }));
      var driving = interactId === node.id;
      var ib = el("button", { type: "button", class: "btn wide" + (driving ? " on" : ""), title: driving ? "Stop interacting (or Esc / click outside)" : "Interact with the prototype (or double-click it)", text: driving ? "■ Stop" : "▶ Interact" });
      guard(ib); ib.addEventListener("click", function (e) { e.stopPropagation(); if (interactId === node.id) exitInteract(); else enterInteract(node); showSelBar(node); });
      selBar.appendChild(ib);
      var ob = el("button", { type: "button", class: "btn", title: "Open in new tab", text: "↗" });
      guard(ob); ob.addEventListener("click", function (e) { e.stopPropagation(); window.open(node.url, "_blank"); });
      addLinkBtn(node);
      selBar.classList.remove("hidden");
      positionSelBar();
      return;
    }
    // The color swatch belongs only to the types togglePalette actually knows how to paint;
    // image/table/stamp/arrow reach this bar for the link action alone.
    if (PALETTED[node.type]) {
      var dot = el("div", { class: "dot" }); dot.style.background = node.color || (node.type === "draw" || node.type === "text" ? "#1e1e1e" : node.type === "shape" ? "#ffffff" : node.type === "section" ? "#c4c9d4" : DEFAULT_STICKY);
      var sw = el("div", { class: "sw" }, [dot, el("div", { class: "chev", text: "▾" })]);
      guard(sw); sw.addEventListener("click", function (e) { e.stopPropagation(); togglePalette(node, dot); });
      selBar.appendChild(sw);
    }
    if (node.type === "section") {
      selBar.appendChild(el("div", { class: "div" }));
      var lb = el("button", { type: "button", class: "btn lock" + (node.locked ? " on" : ""), title: node.locked ? "Locked" : "Lock",
        html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">' + (node.locked ? I_LOCK : I_LOCK_OPEN) + '</svg><span class="chev">▾</span>' });
      guard(lb); lb.addEventListener("click", function (e) { e.stopPropagation(); toggleLockMenu(node, lb); });
      selBar.appendChild(lb);
    }
    if (node.type === "sticky" || node.type === "shape" || node.type === "text") {
      selBar.appendChild(el("div", { class: "div" }));
      if (node.type === "sticky" || node.type === "text") {
        var fb = el("button", { class: "btn wide fontbtn", type: "button", title: "Font size", html: '<span class="fslabel"></span><span class="chev">▾</span>' });
        fb.querySelector(".fslabel").textContent = fontLabel(node);
        guard(fb); fb.addEventListener("click", function (e) { e.stopPropagation(); toggleFontMenu(node, fb); });
        selBar.appendChild(fb);
      }
      // B / I / S apply to the SELECTED TEXT when you're editing (bold one word) and to the
      // whole box otherwise — see toggleFormat. keepFocus stops the click from blurring the
      // editable, which would drop the selection before the command could run.
      var bb = el("button", { class: "btn" + (node.bold ? " on" : ""), type: "button", text: "B", title: "Bold (⌘B)" }); bb.style.fontWeight = "700";
      guard(bb); keepFocus(bb); bb.addEventListener("click", function (e) { e.stopPropagation(); toggleFormat(node, bb, "bold", "bold"); });
      selBar.appendChild(bb);
      var itb = el("button", { class: "btn" + (node.italic ? " on" : ""), type: "button", text: "I", title: "Italic (⌘I)" }); itb.style.fontStyle = "italic"; itb.style.fontFamily = "Georgia, 'Times New Roman', serif";
      guard(itb); keepFocus(itb); itb.addEventListener("click", function (e) { e.stopPropagation(); toggleFormat(node, itb, "italic", "italic"); });
      selBar.appendChild(itb);
      var stb = el("button", { class: "btn" + (node.strike ? " on" : ""), type: "button", text: "S", title: "Strikethrough (⌘⇧S)" }); stb.style.textDecoration = "line-through";
      guard(stb); keepFocus(stb); stb.addEventListener("click", function (e) { e.stopPropagation(); toggleFormat(node, stb, "strikeThrough", "strike"); });
      selBar.appendChild(stb);
      // lists: the selected lines (or the whole box when the node isn't being edited)
      var ulb = el("button", { class: "btn", type: "button", title: "Bulleted list", html: lucideIcon(I_LIST) });
      guard(ulb); keepFocus(ulb); ulb.addEventListener("click", function (e) { e.stopPropagation(); toggleList(node, "ul"); });
      selBar.appendChild(ulb);
      var olb = el("button", { class: "btn", type: "button", title: "Numbered list", html: lucideIcon(I_LIST_NUM) });
      guard(olb); keepFocus(olb); olb.addEventListener("click", function (e) { e.stopPropagation(); toggleList(node, "ol"); });
      selBar.appendChild(olb);
      if (node.type === "text") {
        var ALIGN = ["left", "center", "right"];
        var AL_ICON = { left: '<line x1="15" x2="3" y1="12" y2="12"/><line x1="17" x2="3" y1="6" y2="6"/><line x1="21" x2="3" y1="18" y2="18"/>', center: '<line x1="17" x2="7" y1="12" y2="12"/><line x1="19" x2="5" y1="6" y2="6"/><line x1="21" x2="3" y1="18" y2="18"/>', right: '<line x1="21" x2="9" y1="12" y2="12"/><line x1="21" x2="7" y1="6" y2="6"/><line x1="21" x2="3" y1="18" y2="18"/>' };
        var alb = el("button", { class: "btn", type: "button", title: "Align text", html: lucideIcon(AL_ICON[node.align || "left"]) });
        guard(alb); alb.addEventListener("click", function (e) { e.stopPropagation(); var i = ALIGN.indexOf(node.align || "left"); node.align = ALIGN[(i + 1) % 3]; alb.innerHTML = lucideIcon(AL_ICON[node.align]); applyNodeStyle(node); scheduleSave(); });
        selBar.appendChild(alb);
      }
    }
    addLinkBtn(node);
    selBar.classList.remove("hidden");
    positionSelBar();
  }
  // ---- deep links: copy a link to one node ---------------------------------
  // The last button on every selection bar. A link is the board's own URL + #n=<node id>;
  // node ids are stable in the saved doc, so it survives everything but deleting the node.
  var PALETTED = { sticky: 1, text: 1, shape: 1, draw: 1, section: 1 };
  var KIND = { sticky: "sticky", text: "text", image: "image", tile: "prototype", arrow: "connector", draw: "drawing", shape: "shape", section: "section", table: "table", stamp: "stamp" };
  function nodeKind(node) { return KIND[node.type] || "node"; }
  // The take-it-with-you group, closing every selection bar: a picture of it (⌘⇧C) and a link
  // to it. The bar is single-selection only, so multi-select capture stays keyboard-only.
  function addLinkBtn(node) {
    if (selBar.childNodes.length) selBar.appendChild(el("div", { class: "div" }));
    var c = el("button", { type: "button", class: "btn", title: "Copy as PNG (⌘⇧C)", html: lucideIcon(I_CAMERA) });
    guard(c); c.addEventListener("click", function (e) { e.stopPropagation(); copyAsPng(); });
    selBar.appendChild(c);
    var b = el("button", { type: "button", class: "btn", title: "Copy link to this " + nodeKind(node), html: lucideIcon(I_LINK) });
    guard(b); b.addEventListener("click", function (e) { e.stopPropagation(); copyNodeLink(node); });
    selBar.appendChild(b);
  }
  function copyNodeLink(node) {
    var u; try { u = new URL(location.href); u.hash = "n=" + node.id; u = u.href; }
    catch (e) { u = location.href.split("#")[0] + "#n=" + node.id; }
    var done = function () { toast("Link copied — it opens on this " + nodeKind(node)); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(u).then(done, function () { if (legacyCopy(u)) done(); else toast("Couldn't copy the link"); });
      return;
    }
    if (legacyCopy(u)) done(); else toast("Couldn't copy the link");
  }
  // clipboard API needs a secure context; this is the fallback for anything that isn't one
  function legacyCopy(text) {
    try {
      var ta = el("textarea", { value: text });
      ta.style.cssText = "position:fixed;top:-2000px;left:0;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  // one-line confirmation, bottom centre — the canvas had no such rail until the link action
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = el("div", { id: "gvc-toast" }); ui.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.classList.remove("show"); }, 2400);
  }
  // Arriving on a deep link: fly to the node, select it, pulse it. The hash is CONSUMED —
  // stripped from the address bar immediately — because comment threads scope themselves to
  // pathname+search+hash (src/review/comments.js), so a lingering #n= would quietly file every
  // comment made afterwards under a view nobody else is looking at.
  function openDeepLink() {
    var m = /^#n=([A-Za-z0-9_-]+)$/.exec(location.hash || "");
    if (!m) return;
    var id = m[1];
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    var n = nodeById(id);
    if (!n) { toast("That part of the board isn't here any more"); return; }
    flyToRect(anyRect(n));
    setSelection([id]);
    var host = nodeEls[id];
    if (host) { host.classList.add("gvc-linked"); setTimeout(function () { host.classList.remove("gvc-linked"); }, 1700); }
  }
  function guard(elm) { elm.addEventListener("pointerdown", function (e) { e.stopPropagation(); }); }
  // a toolbar button that must not steal focus from the text being edited — without this the
  // native mousedown focus move blurs the editable and the text selection is gone by click time
  function keepFocus(elm) { elm.addEventListener("mousedown", function (e) { e.preventDefault(); }); }
  function applyNodeStyle(node) {
    var host = nodeEls[node.id]; if (!host) return;
    if (node.type === "sticky" || node.type === "text") {
      if (node.type === "sticky") host.style.background = node.color || DEFAULT_STICKY;
      var txt = host.querySelector(".gvc-txt");
      if (txt) applyTextStyle(txt, node); // patch in place so an active edit isn't torn down
      // picking a size from the dropdown moves the sticky's CEILING, so the fit has to be
      // re-run — otherwise the note keeps whatever rung it had stepped down to.
      if (node.type === "sticky") autoFit(node, true);
    } else renderNode(node); // shapes/draws re-render their svg
  }
  function togglePalette(node, dot) {
    if (!palette.classList.contains("hidden")) { palette.classList.add("hidden"); return; }
    if (lockMenu) lockMenu.classList.add("hidden");
    if (fontMenu) fontMenu.classList.add("hidden");
    palette.innerHTML = "";
    var colors = node.type === "draw" ? DRAW_COLORS : node.type === "text" ? TEXT_COLORS : node.type === "section" ? SECTION_COLORS : STICKY_COLORS;
    colors.forEach(function (c) {
      var pc = el("div", { class: "pc" + (c === node.color ? " on" : "") }); pc.style.background = c;
      guard(pc); pc.addEventListener("click", function (e) { e.stopPropagation(); node.color = c; dot.style.background = c; applyNodeStyle(node); scheduleSave(); palette.classList.add("hidden"); });
      palette.appendChild(pc);
    });
    palette.classList.remove("hidden");
    positionSelBar();
  }
  // lock dropdown for sections: Lock all / Lock background only / Unlock.
  function toggleLockMenu(node, btn) {
    if (!lockMenu.classList.contains("hidden")) { lockMenu.classList.add("hidden"); return; }
    if (palette) palette.classList.add("hidden");
    if (fontMenu) fontMenu.classList.add("hidden");
    lockMenu.innerHTML = "";
    var items = node.locked === "all" ? [["bg", "Lock background only"], [null, "Unlock"]]
      : node.locked === "bg" ? [["all", "Lock all"], [null, "Unlock"]]
      : [["all", "Lock all"], ["bg", "Lock background only"]];
    items.forEach(function (it) {
      var row = el("div", { class: "item", text: it[1] });
      guard(row); row.addEventListener("click", function (e) {
        e.stopPropagation();
        if (it[0]) node.locked = it[0]; else delete node.locked;
        renderNode(node); setSelection([node.id]); scheduleSave();
        lockMenu.classList.add("hidden");
      });
      lockMenu.appendChild(row);
    });
    var r = btn.getBoundingClientRect();
    lockMenu.classList.remove("hidden");
    var mw = lockMenu.offsetWidth || 190;
    lockMenu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left)) + "px";
    lockMenu.style.top = (r.bottom + 6) + "px";
  }
  // font-size dropdown: named presets rendered at their own scale + a custom px input.
  function setFontSize(node, px, btn) {
    node.fontSize = Math.max(6, Math.min(400, px)); delete node.fontScale;
    applyNodeStyle(node); scheduleSave();
    if (btn) { var lbl = btn.querySelector(".fslabel"); if (lbl) lbl.textContent = fontLabel(node); }
    positionSelBar();
  }
  function toggleFontMenu(node, btn) {
    if (!fontMenu.classList.contains("hidden")) { fontMenu.classList.add("hidden"); return; }
    if (palette) palette.classList.add("hidden");
    if (lockMenu) lockMenu.classList.add("hidden");
    fontMenu.innerHTML = "";
    var cur = fontPx(node);
    FONT_PRESETS.forEach(function (p) {
      var row = el("div", { class: "item" + (p.px === cur ? " on" : "") });
      row.appendChild(el("span", { class: "ck", text: p.px === cur ? "✓" : "" }));
      var lb = el("span", { class: "lb", text: p.label }); lb.style.fontSize = p.disp + "px";
      row.appendChild(lb);
      guard(row); row.addEventListener("click", function (e) { e.stopPropagation(); setFontSize(node, p.px, btn); fontMenu.classList.add("hidden"); });
      fontMenu.appendChild(row);
    });
    var inp = el("input", { class: "num", type: "number", min: "6", max: "400", value: String(cur) });
    guard(inp);
    function applyNum() { setFontSize(node, parseInt(inp.value, 10) || cur, btn); }
    inp.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); applyNum(); fontMenu.classList.add("hidden"); } });
    inp.addEventListener("change", applyNum);
    fontMenu.appendChild(inp);
    var r = btn.getBoundingClientRect();
    fontMenu.classList.remove("hidden");
    var mw = fontMenu.offsetWidth || 150;
    fontMenu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left)) + "px";
    fontMenu.style.top = (r.bottom + 6) + "px";
  }
  function positionSelBar() {
    if (!selBar || selBar.classList.contains("hidden")) return;
    if (selected.length !== 1) { hideSelBar(); return; }
    var node = nodeById(selected[0]); if (!node) { hideSelBar(); return; }
    // anyRect, not node.x/node.w — arrows carry endpoints instead, and they get a bar now too
    var r = anyRect(node) || { x: node.x || 0, y: node.y || 0, w: node.w || 150 };
    var p = worldToScreen(r.x + r.w / 2, r.y);
    var bw = selBar.offsetWidth || 200;
    var left = Math.max(8, Math.min(innerWidth - bw - 8, p.x - bw / 2));
    var top = Math.max(8, p.y - 52);
    selBar.style.left = left + "px"; selBar.style.top = top + "px";
    if (!palette.classList.contains("hidden")) {
      var pw = palette.offsetWidth || 300;
      palette.style.left = Math.max(8, Math.min(innerWidth - pw - 8, p.x - pw / 2)) + "px";
      palette.style.top = Math.max(8, top - 46) + "px";
    }
  }
  function hideSelBar() { if (selBar) selBar.classList.add("hidden"); if (palette) palette.classList.add("hidden"); if (lockMenu) lockMenu.classList.add("hidden"); if (fontMenu) fontMenu.classList.add("hidden"); }

  // ---- toolbar: icons — Lucide (the shadcn set) wherever one exists --------
  var I_SELECT = '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>'; // mouse-pointer-2
  var I_HAND = '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'; // hand
  var I_TEXT = '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'; // type
  var I_SECTION = '<rect x="3.2" y="3.4" width="13.6" height="13.6" rx="2.2"/><path d="M3.2 7.6h4.2V3.4"/>'; // custom (square section glyph — no Lucide equivalent)
  var I_LOCK = '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'; // lock (Lucide)
  var I_LOCK_OPEN = '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'; // lock-open (Lucide)
  var I_LIST = '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'; // list (Lucide)
  var I_LIST_NUM = '<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'; // list-ordered (Lucide)
  var I_TABLE = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 9v12"/><path d="M15 9v12"/>'; // table with header row
  var I_STAMP = '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"/>'; // stamp
  var I_BUBBLE = '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'; // message-circle
  var I_WIDGETS = '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>'; // shapes
  var I_PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>'; // plus
  var I_CHEVRON = '<path d="m9 18 6-6-6-6"/>'; // chevron-right (phone toolbar expander; flips left when open)
  var I_CLOCK = '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'; // clock
  var I_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'; // x
  var I_SPEAKER = '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/>';
  var I_VOL = I_SPEAKER + '<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 5.6a9 9 0 0 1 0 12.7"/>'; // volume-2
  var I_VOL_OFF = I_SPEAKER + '<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'; // volume-x
  var I_PLAY = '<polygon points="6 3 20 12 6 21 6 3"/>'; // play
  var I_PAUSE = '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'; // pause
  var I_STOP = '<rect width="16" height="16" x="4" y="4" rx="2"/>'; // square
  var I_IMAGE = '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'; // image
  var I_LINK = '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'; // link (Lucide)
  var I_CAMERA = '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'; // camera (Lucide)
  var I_PROTO = '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>'; // app-window
  var IC_ELBOW = '<path d="m10 9 5-5 5 5"/><path d="M4 20h7a4 4 0 0 0 4-4V4"/>'; // corner-right-up
  var IS_FLOW = '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>'; // network
  var IC_CURVE = '<path d="M5 19C6.2 10.6 11.4 6.3 18.6 7.1"/><path d="m15.2 3.9 3.9 3.1-3.1 3.9"/>'; // custom spline + arrowhead
  var IC_ARROW = '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'; // arrow-up-right
  var IC_LINE = '<path d="M19 5 5 19"/>'; // slash
  // the big illustrated shape cluster: square high-left, curved arrow diving to a heavy circle low-right
  var CLUSTER_ICON = '<svg viewBox="0 0 48 42" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="5" width="20" height="20" rx="1.6"/><path d="M25.5 8.2c3.4-4.4 9.3-5.2 13.9-2.4"/><path d="M38.2 2l1.2 3.8-3.9 1.1"/><circle cx="37" cy="30.5" r="9.6"/></svg>';
  // illustrated tools — measured against the reference shots (round-6 pixel report):
  // pen = short rounded black nib on a WIDE concave shoulder flaring to full body width by
  // mid-height, seam ~2/3 down, left-lit; sticky = muted-pink 3-sheet stack fanning toward
  // bottom-left, front sheet rotated ~-2.5° with a LARGE top-left corner curl (lighter
  // underside, concave silhouette, crease shadow). Both crop flush at the pill bottom.
  var PEN_ART = '<svg viewBox="0 0 26 44" class="art pen"><defs><linearGradient id="gvpen-b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".42" stop-color="#f3f4f7"/><stop offset=".78" stop-color="#dcdfe4"/><stop offset="1" stop-color="#bfc3cc"/></linearGradient><linearGradient id="gvpen-c" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fafbfc"/><stop offset=".55" stop-color="#e4e6eb"/><stop offset="1" stop-color="#b9bdc7"/></linearGradient></defs><path d="M13 .6c1.8 0 3.1 1.1 3.5 2.7L18 10.5H8l1.5-7.2C9.9 1.7 11.2.6 13 .6z" fill="#1e1f24"/><path d="M13 .6c-1.8 0-3.1 1.1-3.5 2.7L8 10.5h6.4L13.2.7z" fill="#32333a"/><path d="M8 10.5h10c3 3.3 6.5 6 7.5 11.5H.5C1.5 16.5 5 13.8 8 10.5z" fill="url(#gvpen-c)"/><path d="M.5 22h25v22H.5z" fill="url(#gvpen-b)"/><rect x="2.2" y="23.4" width="2.2" height="20.6" fill="#ffffff" opacity=".65"/><rect x=".5" y="26.4" width="25" height=".8" fill="#c9cdd5"/></svg>';
  // blue, not pink — the art matches the DEFAULT_STICKY blue family. Three sheets stacked
  // per Rob's zoomed reference asset: the FRONT sheet is upright with the
  // curl on its TOP-RIGHT corner; the BACK sheets carry the rotation, fanning out at the
  // BOTTOM-LEFT — a second sheet (+9°) wedges out of the lower half of the left edge,
  // widening toward the crop, and a third tongue (+17°) protrudes beyond it.
  var STICKY_ART = '<svg viewBox="-3 0 55 44" class="art sticky"><defs><linearGradient id="gvst-f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9defb"/><stop offset="1" stop-color="#9ec2f2"/></linearGradient><filter id="gvst-s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.8" flood-color="#000" flood-opacity="0.28"/></filter></defs><g transform="translate(-2 4.5) rotate(17 28 30)" filter="url(#gvst-s)"><rect x="2" y="30" width="26" height="16" fill="#7da9e2"/></g><g transform="translate(-1.5 4) rotate(9 30 17)" filter="url(#gvst-s)"><rect x="6.5" y="17" width="36" height="32" fill="#8fb7ec"/></g><g filter="url(#gvst-s)"><path d="M8 0h26c1.6 6.4 7 11.3 16 13.2V44H8z" fill="url(#gvst-f)"/><path d="M33.4.8C38.6 7.6 44 11.6 49.4 13.4c-5-.2-10.4-4-15.4-10z" fill="#5f83c0" opacity=".28"/><path d="M34 0C39.4 6.8 44.8 11.4 50 13.2 50.8 7.4 48 2.6 43.2 1 39.9.1 36.8 0 34 0z" fill="#e0edfd"/><path d="M34 0C39.4 6.8 44.8 11.4 50 13.2" stroke="#7d9fd6" stroke-width=".8" fill="none"/></g></svg>';
  // draw sub-toolbar mini illustrations
  var MINI_MARKER = '<svg viewBox="0 0 26 26"><g transform="rotate(42 13 13)"><path d="M13 0 17 7.2H9z" fill="#1e1f24"/><rect x="9" y="7" width="8" height="3" fill="#b9bcc4"/><rect x="8.2" y="10" width="9.6" height="16" rx="2" fill="#f4f5f7" stroke="#c2c5cd" stroke-width=".9"/></g></svg>';
  var MINI_HL = '<svg viewBox="0 0 26 26"><g transform="rotate(42 13 13)"><path d="M9.6.6h6.8l1.7 5.8H7.9z" fill="#f4b62c"/><rect x="7.9" y="6.4" width="10.2" height="3" fill="#e5e6ea"/><rect x="7.2" y="9.4" width="11.6" height="16" rx="2" fill="#ffd75e" stroke="#e3b83e" stroke-width=".9"/></g></svg>';
  var MINI_TAPE = '<svg viewBox="0 0 26 26"><rect x="3.5" y="3.5" width="19" height="19" rx="3.4" fill="#efeaff" stroke="#b6a3f5" stroke-width="1.2"/><path d="M8.7 3.5v19M13.6 3.5v19M18.4 3.5v19M3.5 8.7h19M3.5 13.6h19M3.5 18.4h19" stroke="#cabcf8" stroke-width="1"/></svg>';
  var MINI_ERASER = '<svg viewBox="0 0 26 26"><g transform="rotate(-16 13 13)"><rect x="2.8" y="8.2" width="20.4" height="11.6" rx="2.6" fill="#f4aab6"/><path d="M2.8 10.8a2.6 2.6 0 0 1 2.6-2.6h7.4l-2.6 11.6H5.4a2.6 2.6 0 0 1-2.6-2.6z" fill="#e2798d"/><rect x="4" y="9.4" width="18" height="3" rx="1.5" fill="#ffffff" opacity=".4"/><path d="M2.8 17h20.4" stroke="#d16a7f" stroke-width=".8"/></g></svg>';
  var SQUIG_THIN = '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 13.5c2.4-6.5 5.3-6.5 7.7 0s5 6.5 8.3 0"/></svg>';
  var SQUIG_THICK = '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round"><path d="M4 13.5c2.2-5.5 4.8-5.5 7 0s4.6 5.5 7 0"/></svg>';

  // ---- UI: toolbar + sub-toolbars + top bar + zoom -------------------------
  var zoomPct, nameEl, topbarEl, topRightEl;
  var barEls = {}, drawBar, shapeBar, stampBar, moreShapes, plusMenu, colorInput;
  function setTool(t) {
    TOOL = typeof t === "string" ? { kind: t } : t;
    // phone: picking a tool folds the expanded bar back to select + hand
    if (barEls.bar) { barEls.bar.classList.remove("open"); barEls.bar.scrollLeft = 0; }
    root.classList.toggle("hand", TOOL.kind === "hand");
    root.classList.toggle("crosshair", ["draw", "eraser", "shape", "connector", "section", "place"].indexOf(TOOL.kind) >= 0);
    clearGhost();
    if (TOOL.kind === "place" && (TOOL.type === "sticky" || TOOL.type === "stamp")) makeGhost();
    closePops();
    syncBars();
  }
  var toolGhost = null;
  function moveGhost(e) {
    if (!toolGhost) return;
    toolGhost.style.left = e.clientX + "px"; toolGhost.style.top = e.clientY + "px";
    var over = document.elementFromPoint(e.clientX, e.clientY);
    toolGhost.style.opacity = over && over.closest && over.closest("#gvc-ui") ? "0" : "";
  }
  function makeGhost() {
    if (TOOL.type === "sticky") toolGhost = el("div", { class: "gvc-ghost gvc-ghost-sticky in" });
    else {
      toolGhost = el("div", { class: "gvc-ghost gvc-ghost-stamp" });
      setStampFace(toolGhost, armedStamp);
    }
    toolGhost.style.left = "-999px";
    document.body.appendChild(toolGhost);
    document.addEventListener("pointermove", moveGhost);
  }
  function setStampFace(elm, key) {
    var art = stampHtml(key);
    if (art) elm.innerHTML = art;
    else elm.textContent = STAMP_ART[key] || key;
  }
  // the speech-bubble tool IS the comment layer — fire the overlay's own Shift+C toggle
  function toggleComments() {
    try { window.dispatchEvent(new KeyboardEvent("keydown", { shiftKey: true, code: "KeyC", key: "C" })); } catch (e) {}
  }
  function clearGhost() {
    if (!toolGhost) return;
    document.removeEventListener("pointermove", moveGhost);
    toolGhost.remove(); toolGhost = null;
  }
  function closePops() {
    if (lockMenu) lockMenu.classList.add("hidden");
    if (fontMenu) fontMenu.classList.add("hidden");
    if (moreShapes) moreShapes.classList.add("hidden");
    if (plusMenu) plusMenu.classList.add("hidden");
    if (barEls.bar) barEls.bar.classList.remove("plusopen");
  }
  function syncBars() {
    if (!barEls.select) return;
    barEls.select.classList.toggle("on", TOOL.kind === "select");
    barEls.hand.classList.toggle("on", TOOL.kind === "hand");
    barEls.marker.classList.toggle("armed", TOOL.kind === "draw" || TOOL.kind === "eraser");
    barEls.sticky.classList.toggle("armed", TOOL.kind === "place" && TOOL.type === "sticky");
    barEls.cluster.classList.toggle("armed", TOOL.kind === "shape" || TOOL.kind === "connector");
    barEls.text.classList.toggle("on", TOOL.kind === "place" && TOOL.type === "text");
    barEls.section.classList.toggle("on", TOOL.kind === "section");
    barEls.table.classList.toggle("on", TOOL.kind === "place" && TOOL.type === "table");
    barEls.stamp.classList.toggle("on", TOOL.kind === "place" && TOOL.type === "stamp");
    drawBar.classList.toggle("hidden", TOOL.kind !== "draw" && TOOL.kind !== "eraser");
    shapeBar.classList.toggle("hidden", !(TOOL.kind === "shape" || TOOL.kind === "connector"));
    stampBar.classList.toggle("hidden", !(TOOL.kind === "place" && TOOL.type === "stamp"));
    syncDrawBar(); syncShapeBar(); syncStampBar();
  }

  function buildUI() {
    // top-left: back + rename
    var back = el("button", { class: "back", type: "button", html: '<span class="arr">&larr;</span><span class="bl">Back</span>' });
    back.addEventListener("click", function () { save(); if (history.length > 1) history.back(); else location.href = BOARD_PATH.replace(/[^/]+\/?$/, ""); });
    var nm = el("div", { class: "nm", contentEditable: "false", title: "Rename canvas", text: board.name });
    nm.addEventListener("click", function () { if (nm.contentEditable !== "true") { nm.contentEditable = "true"; nm.focus(); document.execCommand("selectAll", false, null); } });
    nm.addEventListener("blur", function () { nm.contentEditable = "false"; board.name = nm.textContent.trim() || "Untitled canvas"; nm.textContent = board.name; document.title = board.name; save(); });
    nm.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); nm.blur(); } });
    nameEl = nm;
    topbarEl = el("div", { id: "gvc-topbar" }, [back, nm]);
    ui.appendChild(topbarEl);

    // bottom-left: zoom
    zoomPct = el("div", { class: "pct", text: "100%" });
    zoomPct.addEventListener("click", resetView);
    var zin = el("button", { type: "button", html: "+" }), zout = el("button", { type: "button", html: "&minus;" });
    zin.addEventListener("click", function () { zoomAt(innerWidth / 2, innerHeight / 2, 1.2); });
    zout.addEventListener("click", function () { zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); });
    ui.appendChild(el("div", { id: "gvc-zoom" }, [zout, zoomPct, zin]));

    buildToolbar();
    buildDrawBar();
    buildShapeBar();
    buildStampBar();
    buildPlusMenu();
    buildSession();

    selBar = el("div", { id: "gvc-selbar", class: "hidden" });
    palette = el("div", { id: "gvc-palette", class: "hidden" });
    lockMenu = el("div", { id: "gvc-lockmenu", class: "hidden" });
    fontMenu = el("div", { id: "gvc-fontmenu", class: "hidden" });
    ui.appendChild(selBar); ui.appendChild(palette); ui.appendChild(lockMenu); ui.appendChild(fontMenu);
    buildPicker();
    transformCbs.push(positionSelBar);
    window.addEventListener("resize", positionSelBar);
    syncBars();
    // phone (Rob's call 2026-08-06): you're navigating, not editing — pan by default,
    // toolbar collapsed behind the chevron, topbar shrunk to the bare arrow. LIVE query,
    // not a boot-time check: rotation / devtools responsive mode / window resizes flip it.
    var mq = matchMedia("(max-width: 640px)");
    function applyMobile() {
      document.body.classList.toggle("gvc-mobile", mq.matches);
      setTool(mq.matches ? "hand" : "select");
    }
    if (mq.matches) applyMobile();
    if (mq.addEventListener) mq.addEventListener("change", applyMobile);
    else if (mq.addListener) mq.addListener(applyMobile); // older Safari
  }

  function toolBtn(t, title, svgHtml, key) {
    var b = el("div", { class: "tool" }); b.dataset.t = t;
    b.innerHTML = svgHtml + '<span class="tip">' + title + (key ? '<span class="k">' + key + "</span>" : "") + "</span>";
    return b;
  }

  // bottom-center: the main toolbar. Groups: [select hand] | [marker sticky] | [shapes] | [inserts +]
  function buildToolbar() {
    var bar = el("div", { id: "gvc-toolbar" });
    barEls.select = toolBtn("cursor", "Select", lucideIcon(I_SELECT), "V");
    barEls.select.addEventListener("click", function () { setTool("select"); });
    barEls.hand = toolBtn("hand", "Hand tool", lucideIcon(I_HAND), "H");
    barEls.hand.addEventListener("click", function () { setTool("hand"); });
    bar.appendChild(barEls.select); bar.appendChild(barEls.hand);
    bar.appendChild(el("div", { class: "sep" }));

    barEls.marker = toolBtn("marker", "Marker", '<span class="artclip">' + PEN_ART + "</span>", "M");
    barEls.marker.classList.add("big");
    barEls.marker.addEventListener("click", function () { if (TOOL.kind === "draw" || TOOL.kind === "eraser") setTool("select"); else setTool("draw"); });
    bar.appendChild(barEls.marker);

    barEls.sticky = toolBtn("sticky", "Sticky note", '<span class="artclip">' + STICKY_ART + "</span>", "S");
    barEls.sticky.classList.add("big");
    barEls.sticky.addEventListener("pointerdown", function (e) { e.preventDefault(); startStickyPress(e); });
    bar.appendChild(barEls.sticky);

    barEls.cluster = toolBtn("shapes", "Shapes and connectors", CLUSTER_ICON, "R");
    barEls.cluster.classList.add("cluster");
    barEls.cluster.addEventListener("click", function () {
      if (TOOL.kind === "shape" || TOOL.kind === "connector") { setTool("select"); return; }
      setTool({ kind: "shape", shape: armedShape });
    });
    bar.appendChild(barEls.cluster);
    bar.appendChild(el("div", { class: "sep" }));

    barEls.text = toolBtn("text", "Text", lucideIcon(I_TEXT), "T");
    barEls.text.addEventListener("click", function () { setTool({ kind: "place", type: "text" }); });
    barEls.section = toolBtn("section", "Section", svgIcon(I_SECTION), "⇧S");
    barEls.section.addEventListener("click", function () { setTool("section"); });
    barEls.table = toolBtn("table", "Table", lucideIcon(I_TABLE), "⇧T");
    barEls.table.addEventListener("click", function () { setTool({ kind: "place", type: "table" }); });
    barEls.stamp = toolBtn("stamp", "Stamp", lucideIcon(I_STAMP), "E");
    barEls.stamp.addEventListener("click", function () { setTool({ kind: "place", type: "stamp" }); });
    barEls.bubble = toolBtn("bubble", "Comment", lucideIcon(I_BUBBLE), "C");
    barEls.bubble.addEventListener("click", function () { setTool("select"); toggleComments(); });
    barEls.widgets = toolBtn("widgets", "Prototypes and pages", lucideIcon(I_WIDGETS));
    barEls.widgets.addEventListener("click", function () { openPicker(); });
    bar.appendChild(barEls.text); bar.appendChild(barEls.section); bar.appendChild(barEls.table);
    bar.appendChild(barEls.stamp); bar.appendChild(barEls.bubble); bar.appendChild(barEls.widgets);

    barEls.plus = toolBtn("plus", "Insert", lucideIcon(I_PLUS));
    barEls.plus.classList.add("plus");
    barEls.plus.addEventListener("click", function (e) {
      e.stopPropagation();
      plusMenu.classList.toggle("hidden");
      bar.classList.toggle("plusopen", !plusMenu.classList.contains("hidden"));
    });
    bar.appendChild(barEls.plus);

    // phone: the bar boots collapsed to select + hand — this chevron expands/closes
    // the full set (CSS under .gvc-mobile does the hiding; desktop never sees it)
    barEls.more = toolBtn("more", "More tools", lucideIcon(I_CHEVRON));
    barEls.more.classList.add("morebtn");
    barEls.more.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!bar.classList.toggle("open")) bar.scrollLeft = 0; // folding resets the row scroll — the pill must never open clipped
    });
    bar.appendChild(barEls.more);

    barEls.bar = bar;
    ui.appendChild(bar);
  }

  // Big sticky press: a real drag rides the classic ghost-out-of-the-bar spawn; a plain
  // click arms the sticky tool (the note then follows the cursor until you click).
  function startStickyPress(e) {
    var sx = e.clientX, sy = e.clientY, moved = false, ghost = null;
    function mv(ev) {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) {
        moved = true;
        ghost = el("div", { class: "gvc-ghost gvc-ghost-sticky" });
        document.body.appendChild(ghost);
        requestAnimationFrame(function () { ghost.classList.add("in"); });
      }
      if (ghost) { ghost.style.left = ev.clientX + "px"; ghost.style.top = ev.clientY + "px"; }
    }
    function up(ev) {
      document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up);
      if (ghost) ghost.remove();
      if (!moved) {
        if (TOOL.kind === "place" && TOOL.type === "sticky") setTool("select");
        else setTool({ kind: "place", type: "sticky" });
        return;
      }
      if (ev.target.closest && ev.target.closest("#gvc-ui")) return;
      spawnSticky(screenToWorld(ev.clientX, ev.clientY));
    }
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  }

  // draw sub-toolbar: marker / highlighter / washi / eraser · thin / thick · colors
  var drawEls = {};
  function buildDrawBar() {
    drawBar = el("div", { id: "gvc-drawbar", class: "gvc-subbar hidden" });
    [["marker", MINI_MARKER, "Marker"], ["highlighter", MINI_HL, "Highlighter"], ["tape", MINI_TAPE, "Washi tape"], ["eraser", MINI_ERASER, "Eraser"]].forEach(function (m) {
      var b = el("div", { class: "sbtn", html: m[1] + '<span class="tip">' + m[2] + "</span>" });
      b.addEventListener("click", function () {
        if (m[0] === "eraser") setTool("eraser");
        else { drawStyle.mode = m[0]; setTool("draw"); }
      });
      drawEls[m[0]] = b; drawBar.appendChild(b);
    });
    drawBar.appendChild(el("div", { class: "dsep" }));
    [["thin", SQUIG_THIN, "Thin"], ["thick", SQUIG_THICK, "Thick"]].forEach(function (s) {
      var b = el("div", { class: "sbtn", html: s[1] + '<span class="tip">' + s[2] + "</span>" });
      b.addEventListener("click", function () { drawStyle.size = s[0]; if (TOOL.kind === "eraser") setTool("draw"); else syncDrawBar(); });
      drawEls[s[0]] = b; drawBar.appendChild(b);
    });
    drawBar.appendChild(el("div", { class: "dsep" }));
    drawEls.dots = [];
    DRAW_COLORS.forEach(function (c) {
      var d = el("div", { class: "dot" + (c === "#ffffff" ? " white" : "") });
      d.style.background = c; d.dataset.c = c;
      d.addEventListener("click", function () { drawStyle.color = c; if (TOOL.kind === "eraser") setTool("draw"); else syncDrawBar(); });
      drawEls.dots.push(d); drawBar.appendChild(d);
    });
    var rb = el("div", { class: "dot rainbow", title: "Custom color" });
    colorInput = el("input", { type: "color", value: "#1e1e1e" });
    colorInput.addEventListener("input", function () { drawStyle.color = colorInput.value; if (TOOL.kind === "eraser") setTool("draw"); else syncDrawBar(); });
    rb.appendChild(colorInput);
    drawEls.rainbow = rb; drawBar.appendChild(rb);
    ui.appendChild(drawBar);
  }
  function syncDrawBar() {
    if (!drawEls.marker) return;
    ["marker", "highlighter", "tape"].forEach(function (m) { drawEls[m].classList.toggle("on", TOOL.kind === "draw" && drawStyle.mode === m); });
    drawEls.eraser.classList.toggle("on", TOOL.kind === "eraser");
    drawEls.thin.classList.toggle("on", drawStyle.size === "thin");
    drawEls.thick.classList.toggle("on", drawStyle.size === "thick");
    var preset = false;
    drawEls.dots.forEach(function (d) { var on = d.dataset.c === drawStyle.color; d.classList.toggle("selc", on); preset = preset || on; });
    drawEls.rainbow.classList.toggle("selc", !preset);
  }

  // shapes sub-toolbar: current ▾ · connectors · shape grid · More shapes
  var shapeEls = { conns: {}, shapes: {} };
  var BAR_SHAPES = ["square", "circle", "diamond", "triangle", "triangle-down", "pill", "cylinder"];
  var MORE_SHAPES = ["round", "star", "hexagon", "pentagon", "parallelogram", "trapezoid", "plus", "arrow-right"];
  var SHAPE_NAME = { square: "Square", round: "Rounded rectangle", circle: "Circle", diamond: "Diamond", triangle: "Triangle", "triangle-down": "Inverted triangle", pill: "Oval", cylinder: "Cylinder", bubble: "Speech bubble", star: "Star", hexagon: "Hexagon", pentagon: "Pentagon", parallelogram: "Parallelogram", trapezoid: "Trapezoid", plus: "Plus", "arrow-right": "Arrow" };
  var SHAPE_KEY = { square: "R", circle: "O" };
  var CONNS = [["elbow", IC_ELBOW, "Elbow connector", "X"], ["curved", IC_CURVE, "Curved connector"], ["arrow", IC_ARROW, "Arrow", ""], ["line", IC_LINE, "Line", "L"]];
  function tipHtml(name, key) { return '<span class="tip">' + name + (key ? '<span class="k">' + key + "</span>" : "") + "</span>"; }
  var CHEV = '<svg class="chev" viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="#444" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>';
  function buildShapeBar() {
    shapeBar = el("div", { id: "gvc-shapebar", class: "gvc-subbar hidden" });
    shapeEls.cur = el("div", { class: "cur", html: shapeIcon(armedShape) + CHEV });
    shapeEls.cur.addEventListener("click", function (e) { e.stopPropagation(); moreShapes.classList.toggle("hidden"); });
    shapeBar.appendChild(shapeEls.cur);
    shapeBar.appendChild(el("div", { class: "dsep" }));
    CONNS.forEach(function (c) {
      var b = el("div", { class: "sbtn", html: lucideIcon(c[1]) + tipHtml(c[2], c[3]) });
      b.addEventListener("click", function () { armedConnector = c[0]; setTool({ kind: "connector", conn: c[0] }); });
      shapeEls.conns[c[0]] = b; shapeBar.appendChild(b);
    });
    BAR_SHAPES.forEach(function (s) {
      var b = el("div", { class: "sbtn", html: shapeIcon(s) + tipHtml(SHAPE_NAME[s], SHAPE_KEY[s]) });
      b.addEventListener("click", function () { armedShape = s; setTool({ kind: "shape", shape: s }); });
      shapeEls.shapes[s] = b; shapeBar.appendChild(b);
    });
    // the 12th slot: the flowchart glyph — opens the extended shape tray
    var flow = el("div", { class: "sbtn", html: lucideIcon(IS_FLOW) + tipHtml("More shapes") });
    flow.addEventListener("click", function (e) { e.stopPropagation(); moreShapes.classList.toggle("hidden"); });
    shapeBar.appendChild(flow);
    shapeBar.appendChild(el("div", { class: "dsep" }));
    var more = el("button", { class: "more", type: "button", text: "More shapes" });
    more.addEventListener("click", function (e) { e.stopPropagation(); moreShapes.classList.toggle("hidden"); });
    shapeBar.appendChild(more);
    ui.appendChild(shapeBar);
    moreShapes = el("div", { id: "gvc-moreshapes", class: "hidden" });
    MORE_SHAPES.forEach(function (s) {
      var b = el("div", { class: "sbtn", html: shapeIcon(s) + tipHtml(SHAPE_NAME[s]) });
      b.addEventListener("click", function () { armedShape = s; setTool({ kind: "shape", shape: s }); });
      shapeEls.shapes[s] = b; moreShapes.appendChild(b);
    });
    ui.appendChild(moreShapes);
  }
  function syncShapeBar() {
    if (!shapeEls.cur) return;
    shapeEls.cur.innerHTML = shapeIcon(TOOL.kind === "shape" ? TOOL.shape : armedShape) + CHEV;
    CONNS.forEach(function (c) { shapeEls.conns[c[0]].classList.toggle("sel", TOOL.kind === "connector" && TOOL.conn === c[0]); });
    Object.keys(shapeEls.shapes).forEach(function (s) { shapeEls.shapes[s].classList.toggle("sel", TOOL.kind === "shape" && TOOL.shape === s); });
  }

  // stamp wheel — a radial picker: 8 stamps on a segmented ring around a hub
  var stampEls = [];
  function buildStampBar() {
    stampBar = el("div", { id: "gvc-stampwheel", class: "hidden" });
    stampBar.appendChild(el("div", { class: "hub", text: "😂🙏\n👌🔥👀" }));
    var R = 78, C = 108;
    STAMPS.forEach(function (s, i) {
      var b = el("div", { class: "stampb" });
      b.dataset.s = s;
      setStampFace(b, s);
      var a = (-90 + i * (360 / STAMPS.length)) * Math.PI / 180;
      b.style.left = (C + Math.cos(a) * R) + "px";
      b.style.top = (C + Math.sin(a) * R) + "px";
      b.addEventListener("click", function () {
        armedStamp = s; syncStampBar();
        if (toolGhost && toolGhost.classList.contains("gvc-ghost-stamp")) setStampFace(toolGhost, s);
      });
      stampEls.push(b); stampBar.appendChild(b);
    });
    ui.appendChild(stampBar);
  }
  function syncStampBar() {
    stampEls.forEach(function (b) { b.classList.toggle("sel", b.dataset.s === armedStamp); });
  }

  // + insert menu (image upload · prototype tile)
  function buildPlusMenu() {
    plusMenu = el("div", { id: "gvc-plusmenu", class: "hidden" });
    [["Image", I_IMAGE, function () { pickImage(centerWorld()); }], ["Prototype", I_PROTO, function () { openPicker(); }]].forEach(function (it) {
      var row = el("div", { class: "row", html: lucideIcon(it[1]) + "<span>" + it[0] + "</span>" });
      row.addEventListener("click", function () { plusMenu.classList.add("hidden"); it[2](); });
      plusMenu.appendChild(row);
    });
    ui.appendChild(plusMenu);
  }

  function pop(id) { var h = nodeEls[id]; if (!h) return; h.classList.add("gvc-pop"); setTimeout(function () { h.classList.remove("gvc-pop"); }, 240); }
  function centerWorld() { return screenToWorld(innerWidth / 2, innerHeight / 2); }
  function pickImage(w) {
    var inp = el("input", { type: "file", accept: "image/*", multiple: true }); inp.style.display = "none"; document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      Array.prototype.forEach.call(inp.files, function (f, i) { if (/^image\//.test(f.type)) compressImage(f, function (u, d) { addNode({ type: "image", x: w.x + i * 24, y: w.y + i * 24, w: d.w, h: d.h, src: u }); }); });
      inp.remove();
    });
    inp.click();
  }
  // ---- insert picker: search prototypes / pages / components --------------
  var pickTab = "all", pickQuery = "";
  function buildPicker() {
    picker = el("div", { id: "gvc-picker", class: "hidden" });
    var inp = el("input", { type: "text", placeholder: "Search prototypes, pages, components…" });
    inp.addEventListener("input", function () { pickQuery = inp.value.trim().toLowerCase(); renderPicker(); });
    inp.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Escape") picker.classList.add("hidden"); });
    var x = el("button", { class: "x", type: "button", html: "&times;" });
    x.addEventListener("click", function () { picker.classList.add("hidden"); });
    var tabs = el("div", { class: "tabs" });
    [["all", "All"], ["prototype", "Prototypes"], ["page", "Pages"], ["component", "Components"]].forEach(function (t) {
      var tb = el("div", { class: "tab" + (t[0] === "all" ? " on" : ""), text: t[1] });
      tb.addEventListener("click", function () { pickTab = t[0]; tabs.querySelectorAll(".tab").forEach(function (o) { o.classList.remove("on"); }); tb.classList.add("on"); renderPicker(); });
      tabs.appendChild(tb);
    });
    picker.appendChild(el("div", { class: "head" }, [inp, x]));
    picker.appendChild(tabs);
    picker.appendChild(el("div", { class: "grid" }));
    ui.appendChild(picker);
  }
  function openPicker() {
    picker.classList.remove("hidden");
    var inp = picker.querySelector("input"); inp.value = ""; pickQuery = ""; inp.focus();
    if (catalog) renderPicker();
    else fetch("/__canvas/catalog.json").then(function (r) { return r.json(); }).then(function (d) { catalog = d || []; renderPicker(); }).catch(function () { catalog = []; renderPicker(); });
  }
  function renderPicker() {
    var grid = picker.querySelector(".grid"); grid.innerHTML = "";
    var items = (catalog || []).filter(function (it) {
      if (pickTab !== "all" && it.type !== pickTab) return false;
      if (pickQuery && (it.title + " " + (it.group || "") + " " + it.url).toLowerCase().indexOf(pickQuery) < 0) return false;
      return true;
    }).slice(0, 60);
    if (!items.length) { grid.appendChild(el("div", { class: "empty", text: catalog ? "No matches" : "Loading…" })); return; }
    items.forEach(function (it) {
      var thumb = el("div", { class: "thumb" });
      if (it.thumb) thumb.style.backgroundImage = "url(" + it.thumb + ")"; else thumb.textContent = it.type;
      var card = el("div", { class: "card is-" + it.type }, [thumb, el("div", { class: "cap" }, [el("div", { class: "t", text: it.title }), el("div", { class: "ty", text: it.type })])]);
      card.addEventListener("click", function () { insertTile(it); });
      grid.appendChild(card);
    });
  }
  function insertTile(it) {
    var w = centerWorld();
    var n = addNode({ type: "tile", x: w.x - 210, y: w.y - 150, w: 420, h: 300, url: it.url, name: it.title, thumb: it.thumb || undefined });
    select(n.id); picker.classList.add("hidden");
  }
  function resetView() { mpUnfollow(); board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; applyTransform(); saveView(); }

  // ---- session: the shared timer + music -----------------------------------
  // One timer and one track per board, the same for everyone — a facilitation surface, not
  // board content. It never touches the document: no node, no ops tick, no undo, no KV. The
  // room (BoardRoom) holds it and is the only authority; this client renders what it's told.
  //
  // WHY THE COUNTDOWN NEVER TICKS OVER THE WIRE: the room sends REMAINING MILLISECONDS as of
  // the moment it sent them, and we stamp arrival with performance.now() — a monotonic clock
  // that no NTP correction or wrong system time can shift. Everyone therefore counts down
  // from the same authoritative number using a clock only ever compared against itself, and
  // a board with ten people costs ten messages per timer CLICK rather than per second.
  //
  // Anyone can drive it, like every other shared surface here (node ops, live tile demos).
  // Facilitator-only control would need a notion of who's running the session, which this
  // engine deliberately doesn't have.
  var TRACKS = null;         // null = manifest not loaded yet; [] = none installed
  var sessPill, sessPillTime, sessPillRec, sessPillSpk, sessPanel, sessDigits, sessIdle, sessRun, sessPauseBtn, sessMusicBody, sessDeck, sessTrackBtn, sessTrackMenu, sessTrackChoice, sessPlayBtn, sessVolIn, sessVolIcon;
  var I_CHEV = '<path d="m6 9 6 6 6-6"/>'; // chevron-down (Lucide)
  var I_CHECK = '<path d="M20 6 9 17l-5-5"/>'; // check (Lucide)
  var sess = { timer: null, music: null }; // last snapshot from the room
  var sessAt = 0;            // performance.now() when that snapshot landed
  var sessRang = false;      // this countdown's 00:00 has already been announced
  var sessAudio = null, sessBlocked = false, sessSeekTries = 0;
  // A board rendered inside a frame is a PREVIEW (a card thumbnail on a listing page,
  // an embed inside another board) — it still joins the room to draw the current
  // state, but it must stay silent. Session music is room state, so without this a
  // single visible thumbnail of a board whose music is playing fills the page it's
  // embedded in with sound coming from nowhere the reader can see or stop.
  var EMBEDDED = (function () { try { return window.top !== window.self; } catch (e) { return true; } })();
  var sessVol = 0.6, sessMuted = false, sessPending = 300000; // 5:00 is the default round

  try {
    var sv = localStorage.getItem("gvc-vol");
    if (sv != null) sessVol = Math.min(1, Math.max(0, parseFloat(sv) || 0));
    sessMuted = localStorage.getItem("gvc-muted") === "1";
  } catch (e) {}

  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  // the live remaining time: the room's number, rolled forward on OUR monotonic clock
  function sessRemain() {
    if (!sess.timer) return null;
    if (!sess.timer.running) return sess.timer.remain;
    return Math.max(0, sess.timer.remain - (performance.now() - sessAt));
  }
  function sessRunning() { var r = sessRemain(); return r != null && sess.timer.running && r > 0; }

  function buildSession() {
    // pill: mini record + seven-segment time (or track name), plus a per-user quick-mute
    // speaker that only appears while music plays. The speaker is a span, not a nested
    // button (invalid HTML): it stops propagation so it never toggles the panel.
    sessPillTime = el("span", { class: "t" });
    sessPillRec = el("span", { class: "rec", html: sessRecIcon() });
    sessPillSpk = el("span", { class: "spk", role: "button", "aria-label": "Mute" });
    sessPillSpk.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    sessPillSpk.addEventListener("click", function (e) { e.stopPropagation(); sessSetMuted(!sessMuted); });
    sessPill = el("button", { class: "gvc-sesspill", type: "button", "aria-label": "Timer and music" },
      [sessPillRec, sessPillTime, sessPillSpk]);
    sessPill.addEventListener("click", function (e) { e.stopPropagation(); sessToggle(); });
    // Top RIGHT: ONE white card for the whole room (Rob's call 2026-08-05, FigJam-parity):
    // presence avatars — humans and Clawds — on the left, and the session control as a
    // colored INSET segment inside the same card. The card is #gvc-topright itself; the
    // presence row mounts before the pill when multiplayer boots. A timer you set alone
    // must not vanish with hidden presence, so the pill never hides.
    topRightEl = el("div", { id: "gvc-topright" }, [sessPill]);
    ui.appendChild(topRightEl);

    // ---- panel
    var close = el("button", { class: "x", type: "button", html: lucideIcon(I_X), "aria-label": "Close" });
    close.addEventListener("click", function () { sessToggle(false); });
    var head = el("div", { class: "head" }, [el("div", { class: "ttl", text: "Timer and music" }), close]);

    // volume (per-user, never synced — your ears, your setting)
    sessVolIcon = el("button", { class: "vol", type: "button", "aria-label": "Mute" });
    sessVolIcon.addEventListener("click", function () { sessSetMuted(!sessMuted); });
    sessVolIn = el("input", { type: "range", min: "0", max: "100", value: String(Math.round(sessVol * 100)) });
    sessVolIn.addEventListener("input", function () {
      sessVol = (parseInt(sessVolIn.value, 10) || 0) / 100;
      if (sessMuted && sessVol > 0) sessMuted = false;
      sessSaveVol(); sessSyncVol(); sessApplyMusic();
    });
    var volRow = el("div", { class: "row vol" }, [sessVolIcon, sessVolIn]);

    // timer — a seven-segment clock over its unlit "88:88" ghost. The ghost mirrors the
    // input's exact box metrics (same font, size, padding) so lit segments land on unlit
    // ones; the input on top keeps manual entry ("7" → 7:00, "7:30") working unchanged.
    sessDigits = el("input", { class: "digits", value: "05:00", spellcheck: false, "aria-label": "Timer" });
    sessDigits.addEventListener("keydown", function (e) {
      e.stopPropagation(); // the canvas owns single-key shortcuts — don't place a sticky mid-edit
      if (e.key === "Enter") { e.preventDefault(); sessDigits.blur(); sessStart(); }
      if (e.key === "Escape") {
        e.preventDefault();
        // restore the value DIRECTLY, not via sessSyncTimer: its hard rewrite skips a
        // focused field, so the blur below would commit the very edit being abandoned
        var r0 = sessRemain();
        sessDigits.value = mmss(r0 != null ? r0 : sessPending);
        sessDigits.blur();
      }
    });
    sessDigits.addEventListener("blur", sessCommitDigits);
    sessDigits.addEventListener("focus", function () { if (!sessDigits.readOnly) sessDigits.select(); });
    // the ghost is an INPUT too, not a div: a single-line input vertically centers its
    // text where a div sits it on the line box, so only a twin input renders the unlit
    // 88:88 through the exact same path as the digits — pixel-identical cells
    var ghost = el("input", { class: "ghost", value: "88:88", readOnly: true, tabIndex: -1, "aria-hidden": "true" });
    var clock = el("div", { class: "clock" }, [ghost, sessDigits]);

    // idle: "+1 min" nudges the pending duration locally (the room only hears "start");
    // typing into the digits is the other, unchanged way in. Both clamp at 99:59.
    var addIdle = el("button", { class: "act wide", type: "button", html: lucideIcon(I_PLUS) + "<span>1 min</span>" });
    addIdle.addEventListener("click", function () {
      sessPending = Math.min(sessPending + 60000, 99 * 60000 + 59000);
      sessSyncTimer(true);
    });
    var startBtn = el("button", { class: "go", type: "button", html: lucideIcon(I_PLAY), "data-tip": "Start timer" });
    startBtn.addEventListener("click", sessStart);
    sessIdle = el("div", { class: "idle" }, [addIdle, el("div", { class: "sp" }), startBtn]);

    var addBtn = el("button", { class: "act wide", type: "button", html: lucideIcon(I_PLUS) + "<span>1 min</span>" });
    addBtn.addEventListener("click", function () { mpSend({ t: "timer", do: "add", ms: 60000 }); });
    var stopBtn = el("button", { class: "act stopbtn", type: "button", html: lucideIcon(I_STOP), "data-tip": "Stop" });
    stopBtn.addEventListener("click", function () { mpSend({ t: "timer", do: "stop" }); });
    sessPauseBtn = el("button", { class: "act pausebtn", type: "button" });
    sessPauseBtn.addEventListener("click", function () {
      mpSend({ t: "timer", do: sessRunning() ? "pause" : "resume" });
    });
    sessRun = el("div", { class: "run" }, [addBtn, el("div", { class: "sp" }), stopBtn, sessPauseBtn]);

    var timerBlock = el("div", { class: "row timer" }, [clock, sessIdle, sessRun]);

    // music
    sessMusicBody = el("div", { class: "row music" });
    sessPanel = el("div", { id: "gvc-sesspanel", class: "hidden" }, [head, volRow, timerBlock, sessMusicBody]);
    ui.appendChild(sessPanel);
    sessPanel.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    // Track-menu dismissal on capture, because the panel (above) and the canvas both stop
    // pointerdown from bubbling to the document.
    document.addEventListener("pointerdown", function (e) {
      if (!sessTrackMenu || sessTrackMenu.classList.contains("hidden")) return;
      if (sessTrackMenu.contains(e.target) || (sessTrackBtn && sessTrackBtn.contains(e.target))) return;
      sessTrackMenuToggle(false);
    }, true);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sessTrackMenu && !sessTrackMenu.classList.contains("hidden")) {
        e.stopPropagation(); sessTrackMenuToggle(false);
      }
    }, true);

    sessSyncVol();
    sessSyncTimer(true);
    sessRenderMusic();
    setInterval(sessTick, 200);
    // Autoplay policy blocks sound until this tab has been interacted with, so a joiner who
    // walks into a playing room gets silence. Their first click anywhere is the permission —
    // take it and start, rather than making them find a button to fix something they didn't break.
    document.addEventListener("pointerdown", sessUnblock, true);
    document.addEventListener("keydown", sessUnblock, true);
    // The manifest is the whole music hook: drop tracks into a space's tracks/ folder and
    // this list fills itself. Until then the section renders its empty state and the rest
    // of the panel works exactly as it will with tracks installed.
    fetch("/__canvas/tracks.json", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { TRACKS = Array.isArray(list) ? list : []; sessTracksReady(); })
      .catch(function () { TRACKS = []; sessTracksReady(); });
  }

  // The manifest is a separate fetch, so it can lose the race against the room's welcome — and
  // a welcome that names a track this client can't resolve yet is dropped on the floor. Re-run
  // the music state once the names are known, or a joiner who arrives mid-track sits in silence
  // until somebody happens to press something.
  function sessTracksReady() {
    sessRenderMusic();
    sessApplyMusic();
  }

  function sessToggle(force) {
    var open = force == null ? sessPanel.classList.contains("hidden") : force;
    sessPanel.classList.toggle("hidden", !open);
    sessPill.classList.toggle("on", open);
    if (open) sessUnblock();
  }
  function sessSaveVol() {
    try { localStorage.setItem("gvc-vol", String(sessVol)); localStorage.setItem("gvc-muted", sessMuted ? "1" : "0"); } catch (e) {}
  }
  function sessSetMuted(m) { sessMuted = m; sessSaveVol(); sessSyncVol(); sessApplyMusic(); }
  function sessSyncVol() {
    var off = sessMuted || sessVol <= 0;
    sessVolIcon.innerHTML = lucideIcon(off ? I_VOL_OFF : I_VOL);
    sessVolIcon.setAttribute("aria-label", off ? "Unmute" : "Mute");
    var p = Math.round((sessMuted ? 0 : sessVol) * 100);
    sessVolIn.value = String(p);
    // the filled side of the slider — a gradient split at the thumb, repainted per input
    sessVolIn.style.background = "linear-gradient(90deg,#4f46e5 " + p + "%,#e5e7eb " + p + "%)";
    sessSyncPill();
  }

  function sessCommitDigits() {
    if (sessDigits.readOnly) return;
    // "7" → 7:00 · "7:30" → 7m30s · anything else snaps back to the last good value
    var m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(sessDigits.value);
    if (m) {
      var ms = (parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0)) * 1000;
      if (ms >= 1000) sessPending = Math.min(ms, 99 * 60000 + 59000);
    }
    sessSyncTimer(true);
  }
  function sessStart() {
    sessCommitDigits();
    mpSend({ t: "timer", do: "start", ms: sessPending });
  }

  // paint the timer chrome for the current mode (idle vs counting). `hard` also rewrites the
  // digits — the 200ms tick calls it without that so it can't fight a field you're typing in.
  function sessSyncTimer(hard) {
    var r = sessRemain(), live = r != null;
    sessRun.classList.toggle("hidden", !live);
    sessIdle.classList.toggle("hidden", live);
    sessDigits.readOnly = live;
    sessDigits.classList.toggle("live", live);
    sessDigits.classList.toggle("over", live && r <= 0);
    if (sessPauseBtn) {
      var running = sessRunning();
      sessPauseBtn.innerHTML = lucideIcon(running ? I_PAUSE : I_PLAY);
      sessPauseBtn.setAttribute("data-tip", running ? "Pause" : "Resume");
      sessPauseBtn.classList.toggle("hidden", live && r <= 0); // nothing left to pause
    }
    if (hard && document.activeElement !== sessDigits) sessDigits.value = mmss(live ? r : sessPending);
    sessSyncPill();
  }

  // One paint for the pill's whole state matrix — derived, never latched: counting shows the
  // digits; otherwise a playing track shows its name; otherwise the pending duration sits
  // there as unlit ghost digits. The speaker (per-user mute) and the spinning record only
  // exist while music plays.
  function sessSyncPill() {
    if (!sessPill) return;
    var r = sessRemain(), live = r != null, playing = !!(sess.music && sess.music.playing);
    var t = playing ? sessTrack(sess.music.track) : null;
    sessPill.classList.toggle("live", live && r > 0);
    sessPill.classList.toggle("over", live && r <= 0);
    sessPill.classList.toggle("music", playing);
    sessPillRec.classList.toggle("spin", playing);
    var lbl = sessPillRec.querySelector(".lbl");
    if (lbl) lbl.setAttribute("fill", playing ? sessArt(t || sessTrack(sessTrackChoice)).color : "#8b8c90");
    sessPillSpk.classList.toggle("shown", playing);
    if (playing) sessPillSpk.innerHTML = lucideIcon(sessMuted || sessVol <= 0 ? I_VOL_OFF : I_VOL);
    if (live) { sessPillTime.setAttribute("data-mode", "digits"); sessPillTime.textContent = mmss(r); }
    else if (t) { sessPillTime.setAttribute("data-mode", "name"); sessPillTime.textContent = t.name || t.id; }
    else { sessPillTime.setAttribute("data-mode", "ghost"); sessPillTime.textContent = mmss(sessPending); }
  }

  function sessTick() {
    var r = sessRemain();
    if (r == null) return;
    var txt = mmss(r);
    if (document.activeElement !== sessDigits && sessDigits.value !== txt) sessDigits.value = txt;
    if (sessPillTime.getAttribute("data-mode") === "digits" && sessPillTime.textContent !== txt) sessPillTime.textContent = txt;
    if (r <= 0 && !sessRang) { sessRang = true; sessRing(); }
  }

  // 00:00. Everyone announces it locally off the same authoritative countdown, so it lands
  // together without the room having to broadcast anything at the moment it matters.
  function sessRing() {
    sessSyncTimer(true);
    sessChime();
    [sessPill, sessDigits].forEach(function (n) {
      if (!n) return;
      n.classList.remove("gvc-rang");
      void n.offsetWidth; // restart the animation even if it just ran
      n.classList.add("gvc-rang");
    });
  }

  // The 00:00 chime — synthesized, not an asset, through the same per-user volume/mute as
  // the music. Scheduled only on a RUNNING AudioContext: a suspended one (this tab never
  // interacted, autoplay policy) would hold the notes and fire them stale on the next click,
  // so it's nudged for next time and this ring stays visual-only.
  var sessAudioCtx = null;
  function sessChime() {
    var vol = sessMuted ? 0 : sessVol;
    if (vol <= 0 || EMBEDDED) return; // same reason as the music: a preview is silent
    try {
      if (!sessAudioCtx) sessAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = sessAudioCtx;
      if (ctx.state !== "running") { ctx.resume().catch(function () {}); return; }
      [880, 1174.7].forEach(function (hz, i) { // A5 then D6 — a doorbell's worth of ceremony
        var t0 = ctx.currentTime + i * 0.18;
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "triangle"; o.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.4 * vol, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.75);
      });
    } catch (e) {}
  }

  // ---- music: driven entirely by the room's shared offset -------------------
  function sessTrack(id) {
    if (!TRACKS) return null;
    for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i];
    return null;
  }
  // ---- record-label art: abstract motifs, deterministic per track ----------
  // The engine owns a small set of label drawings and a palette; a track picks both by id
  // hash, so any manifest gets distinct-looking labels with zero config, and a space that
  // cares sets `color` / `motif` per track in its tracks/tracks.json.
  var SESS_COLORS = ["#58ba66", "#ffd43b", "#5b5bd6", "#f76d3c", "#ea8fd0", "#7cc4f8"];
  var SESS_MOTIFS = {
    bird: '<path d="M7 15c2.5.6 6-.2 7.6-2.6M9 9.5c1.8-2 5-2.3 7-.8-1 .6-1.4 1.4-1.2 2.4M9 9.5 5.6 8.9l1.7 2.3c-1.2 2.6-.2 4.6 1.7 5.4M15.9 8.6l2.5.9-2.1 1"/>',
    face: '<circle cx="12" cy="12.5" r="5.6"/><path d="M4.6 12.5a7.4 7.4 0 0 1 14.8 0M4.6 12.5v2.2M19.4 12.5v2.2"/><path d="M9.8 13.6c.5.9 1.1 1.3 2.2 1.3s1.7-.4 2.2-1.3"/><circle cx="10" cy="11.2" r=".4"/><circle cx="14" cy="11.2" r=".4"/>',
    burst: '<path d="M12 4.5 13.6 9l4.1-2.7-1.9 4.5 4.7.4-4.2 2.3 3.2 3.5-4.6-.9.3 4.7-3.2-3.5-2.4 4.1-.8-4.6-4.3 1.9 2.6-4-4.5-1.5 4.5-1.4-2.4-4 4.3 1.7L12 4.5Z"/>',
    scribble: '<path d="M6 14.5c1.5-4 4-7 6-6.5s-2.5 3.5-1 5.5 5-1 5.5-3.5-2-3.5-3.5-2.5 1 3.5 3.5 4.5 3-1 2.5-2"/>',
    gridsun: '<circle cx="12" cy="10" r="4.6"/><path d="M8.2 8.4h7.6M7.6 10.2h8.8M8.4 12h7.2"/><path d="M5 17.5h14M7.5 15.5h9M10.5 19.5h3M12 15.5l2.5 4M9.5 15.5l-3 4M14.8 15.5l4 4"/>',
    sail: '<path d="M12 5v9M12 5c3 2 4.5 4.5 4.8 7.2L12 14M12 6.5C9.8 8 8.6 10.4 8.4 13H12"/><path d="M6.5 16h11l-1.6 2.6a1.4 1.4 0 0 1-1.2.7H9.3a1.4 1.4 0 0 1-1.2-.7L6.5 16Z"/>',
  };
  var SESS_MOTIF_KEYS = ["bird", "face", "burst", "scribble", "gridsun", "sail"];
  function sessHash(s) { var h = 5381, i; for (i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h; }
  function sessArt(t) {
    if (!t) return { color: "#c9cacd", motif: SESS_MOTIFS.bird };
    var h = sessHash(String(t.id));
    return {
      color: typeof t.color === "string" ? t.color : SESS_COLORS[h % SESS_COLORS.length],
      motif: SESS_MOTIFS[t.motif] || SESS_MOTIFS[SESS_MOTIF_KEYS[(h >>> 3) % SESS_MOTIF_KEYS.length]], // >>> — a signed shift goes negative on big hashes and indexes nothing
    };
  }
  // a track's square icon (picker rows + trigger): label color behind its motif
  function sessChip(t) {
    var a = sessArt(t);
    return '<span class="chip" style="background:' + a.color + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + a.motif + "</svg></span>";
  }
  // the pill's mini record (label recolored live) with its little star
  function sessRecIcon() {
    return '<svg viewBox="0 0 24 24" fill="none"><g class="disc"><circle cx="11" cy="12" r="9" fill="#1b1c1e"/>' +
      '<circle cx="11" cy="12" r="6.2" stroke="#3a3b3e" stroke-width="1"/>' +
      '<path d="M4.6 8.4a7.4 7.4 0 0 1 3-3" stroke="rgba(255,255,255,.35)" stroke-width="1.6" stroke-linecap="round"/>' +
      '<circle cx="11" cy="12" r="3.4" class="lbl" fill="#8b8c90"/><circle cx="11" cy="12" r="1" fill="#e8e8ea"/></g>' +
      '<path d="m18.6 2.6 1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z" fill="#ffd43b" stroke="#e3a008" stroke-width=".8"/></svg>';
  }
  // the turntable: record (grooves + label art) + tone arm + speaker grill, measured off
  // the reference frame: disc INSIDE the box (r43 at 30% width) over a soft shadow, arm
  // pivot at 64%, dot grill at 84%. The vinyl and the arm answer to CSS (.deck.playing
  // spins the record and swings the arm onto the label).
  function sessDeckSvg(t) {
    var a = sessArt(t);
    return '<svg class="decksvg" viewBox="0 0 288 104" fill="none">' +
      '<defs><filter id="gvc-softsh" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter></defs>' +
      sessGrill(242, 52) +
      // the disc's resting shadow — OUTSIDE the spinning group so it never rotates
      '<ellipse cx="86" cy="96" rx="42" ry="4.5" fill="#000" opacity=".16" filter="url(#gvc-softsh)"/>' +
      '<g class="vinyl"><circle cx="86" cy="52" r="43" fill="#1b1c1e"/>' +
      '<circle cx="86" cy="52" r="37" stroke="#2c2d30" stroke-width="1"/>' +
      '<circle cx="86" cy="52" r="32" stroke="#2c2d30" stroke-width="1"/>' +
      '<circle cx="86" cy="52" r="27" stroke="#2c2d30" stroke-width="1"/>' +
      '<path d="M53 40a35 35 0 0 1 16-16" stroke="rgba(255,255,255,.25)" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M119 64a35 35 0 0 1-16 16" stroke="rgba(255,255,255,.25)" stroke-width="2" stroke-linecap="round"/>' +
      '<g class="label"><circle cx="86" cy="52" r="19" fill="' + a.color + '"/>' +
      '<g transform="translate(72.8,38.8) scale(1.1)" stroke="#1a1a1a" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">' + a.motif + "</g></g>" +
      '<circle cx="86" cy="52" r="2.4" fill="#e8e8ea"/></g>' +
      // the arm paints AFTER the record — it passes over the disc, like the reference's
      '<g class="arm"><path d="M160 14 148 60l-20 10" stroke="#cfd0d3" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M128 70l-9 6" stroke="#b4b5b8" stroke-width="9" stroke-linecap="round"/>' +
      '<circle cx="160" cy="14" r="8.5" fill="#d8d9db"/><circle cx="160" cy="14" r="3.2" fill="#9b9c9f"/></g>' +
      "</svg>";
  }
  function sessGrill(cx, cy) {
    var d = "", step = 7.5, n = 4; // a diamond of dots, reference-dense
    for (var i = -n; i <= n; i++) for (var j = -n; j <= n; j++) {
      if (Math.abs(i) + Math.abs(j) > n) continue;
      d += '<circle cx="' + (cx + i * step) + '" cy="' + (cy + j * step) + '" r="1.7" fill="#b3b5b9"/>';
    }
    return d;
  }

  // Built ONCE per manifest, not per session message: a peer starting a timer must not
  // collapse a dropdown you have open (sessSyncMusic only toggles classes and labels).
  function sessRenderMusic() {
    if (!sessMusicBody) return;
    sessMusicBody.innerHTML = "";
    sessTrackBtn = sessTrackMenu = sessPlayBtn = sessDeck = null;
    if (TRACKS === null) return; // manifest still in flight — render nothing rather than a guess
    // No tracks installed (a deployed build ships none unless a space commits a tracks/
    // catalog): hide music entirely — panel row, title, the pill's record — rather than
    // tease an inert turntable that can't work there. It all returns when a catalog ships.
    var ttl = sessPanel ? sessPanel.querySelector(".ttl") : null;
    sessMusicBody.classList.toggle("hidden", !TRACKS.length);
    if (ttl) ttl.textContent = TRACKS.length ? "Timer and music" : "Timer";
    if (sessPill) sessPill.setAttribute("aria-label", TRACKS.length ? "Timer and music" : "Timer");
    if (sessPillRec) sessPillRec.classList.toggle("hidden", !TRACKS.length);
    if (!TRACKS.length) return;
    sessDeck = el("div", { class: "deck" });
    sessMusicBody.appendChild(sessDeck);
    if (!sessTrackChoice || !sessTrack(sessTrackChoice)) sessTrackChoice = TRACKS[0].id;
    // a trigger + dark menu instead of a native select, so rows can carry the label art
    sessTrackBtn = el("button", { class: "trackbtn", type: "button", "aria-haspopup": "listbox" });
    sessTrackBtn.addEventListener("click", function () { sessTrackMenuToggle(); });
    sessTrackMenu = el("div", { class: "trackmenu hidden", role: "listbox" });
    TRACKS.forEach(function (t) {
      var row = el("button", {
        class: "item", type: "button", role: "option", "data-id": t.id,
        html: '<span class="tick">' + lucideIcon(I_CHECK) + "</span>" + sessChip(t) + '<span class="nm"></span>',
      });
      row.querySelector(".nm").textContent = t.name || t.id;
      row.addEventListener("click", function () {
        sessTrackMenuToggle(false);
        var playing = !!(sess.music && sess.music.playing);
        sessTrackChoice = t.id;
        // picking while playing switches the room's track; while stopped it just selects
        if (playing && sess.music.track !== t.id) sessPlay(t.id, true);
        else sessSyncMusic();
      });
      sessTrackMenu.appendChild(row);
    });
    sessTrackMenu.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault(); e.stopPropagation();
      var items = [].slice.call(sessTrackMenu.querySelectorAll(".item"));
      var i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    });
    sessPlayBtn = el("button", { class: "go", type: "button" });
    sessPlayBtn.addEventListener("click", function () {
      sessUnblock();
      if (sess.music && sess.music.playing) {
        if (mpLive()) mpSend({ t: "music", do: "stop" });
        else sessApply({ timer: sess.timer, music: null }); // solo: no room to relay the stop
      }
      else sessPlay(sessTrackChoice, false);
    });
    sessMusicBody.appendChild(el("div", { class: "musicrow" }, [sessTrackBtn, sessPlayBtn]));
    sessMusicBody.appendChild(sessTrackMenu);
    sessSyncMusic();
  }
  function sessTrackMenuToggle(force) {
    if (!sessTrackMenu) return;
    var open = force == null ? sessTrackMenu.classList.contains("hidden") : force;
    sessTrackMenu.classList.toggle("hidden", !open);
    sessTrackBtn.classList.toggle("on", open);
    if (open) {
      var sel = sessTrackMenu.querySelector(".item.sel");
      (sel || sessTrackMenu.firstChild).focus();
    }
  }
  // Starting a track it isn't already on enters at a RANDOM point in the mix, so a board you
  // open every day doesn't always open on the same bar. The offset is picked here and made
  // authoritative by the room, so everyone lands on the same one.
  // With no live room socket, ops sent via mpSend drop SILENTLY — which made the
  // play button a dead control whenever the socket had died (e.g. a server restart
  // under an open tab). Music degrades to solo instead: apply the same state change
  // the room's echo would have carried. When the socket returns, the room snapshot
  // wins as always ("the room's word is final").
  function mpLive() { return !!(mp && mp.readyState === 1); }
  function sessPlay(id, force) {
    var t = sessTrack(id), same = !force && sess.music && sess.music.track === id;
    var at = !same && t && t.duration ? Math.floor(Math.random() * t.duration * 1000) : 0;
    sessUnblock();
    if (mpLive()) mpSend({ t: "music", do: "play", track: id, at: at });
    else sessApply({ timer: sess.timer, music: { playing: true, track: id, elapsed: at } });
  }
  function sessSyncMusic() {
    var playing = !!(sess.music && sess.music.playing);
    var pt = playing ? sessTrack(sess.music.track) : null;
    if (pt) sessTrackChoice = pt.id; // the room's playing track wins the local pick
    var cur = sessTrack(sessTrackChoice) || null;
    if (sessDeck) {
      sessDeck.classList.toggle("playing", playing);
      var want = (cur && cur.id) || "";
      // rebuilt only when the track changes, so a session message can't restart the spin
      if (sessDeck.dataset.track !== want) { sessDeck.dataset.track = want; sessDeck.innerHTML = sessDeckSvg(cur); }
    }
    if (sessTrackBtn) {
      sessTrackBtn.innerHTML = sessChip(cur) + '<span class="nm"></span><span class="chev">' + lucideIcon(I_CHEV) + "</span>";
      sessTrackBtn.querySelector(".nm").textContent = cur ? (cur.name || cur.id) : "";
      var rows = sessTrackMenu.querySelectorAll(".item");
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("sel", rows[i].getAttribute("data-id") === sessTrackChoice);
    }
    if (sessPlayBtn) {
      sessPlayBtn.innerHTML = lucideIcon(playing ? I_STOP : I_PLAY);
      sessPlayBtn.classList.toggle("playing", playing);
      sessPlayBtn.setAttribute("data-tip", playing ? "Stop music" : "Play music");
      sessPlayBtn.classList.toggle("blocked", sessBlocked);
    }
    sessSyncPill();
  }
  function sessApplyMusic() {
    var m = sess.music, t = m && sessTrack(m.track);
    if (EMBEDDED) { if (sessAudio) sessAudio.pause(); return; } // previews stay silent
    if (!m || !m.playing || !t) { if (sessAudio) sessAudio.pause(); sessSyncMusic(); return; }
    if (!sessAudio) {
      // in the DOM, not a detached `new Audio()`: it renders nothing without `controls`, and
      // being inspectable in devtools is worth more than the tidiness of hiding it
      sessAudio = el("audio", { class: "gvc-audio", loop: true, preload: "none" });
      document.body.appendChild(sessAudio);
    }
    var a = sessAudio;
    if (a.dataset.track !== m.track) { a.dataset.track = m.track; a.src = t.url; }
    a.volume = sessMuted ? 0 : sessVol;
    // Seek to the room's position so everyone hears the same bar at the same moment — timed to
    // the `playing` event, i.e. the instant sound actually comes out. Seeking any earlier is a
    // trap: a paused element accepts the seek and then SITS there (still loading, or blocked by
    // the autoplay policy waiting for a click), and every second it waits becomes a permanent
    // offset the moment it finally starts. `playing` is the only point at which "the room's
    // current position" and "this element's position" mean the same thing.
    if (a.paused) {
      a.addEventListener("playing", sessSeek, { once: true });
      var p = a.play();
      // autoplay policy: a joiner who hasn't clicked yet can't be given sound. Don't fight
      // it — mark it and let their next click anywhere on the board start playback.
      if (p && p.catch) p.catch(function () { sessBlocked = true; sessSyncMusic(); });
    } else {
      sessSeek(); // already playing: a re-sync, so correct it now
    }
    sessSyncMusic();
  }
  // Recomputed at the moment of the seek, never captured beforehand: when this is deferred to
  // loadedmetadata, a second or more has passed since the decision to seek was made.
  // A 1.5s dead zone, because re-seeking on every small drift is audible and this is ambient
  // background music, not a click track.
  function sessSeek() {
    var m = sess.music, t = m && sessTrack(m.track), a = sessAudio;
    if (!m || !t || !a) return;
    var dur = t.duration || a.duration;
    if (!dur || !isFinite(dur)) return;
    var want = ((m.elapsed + (m.playing ? performance.now() - sessAt : 0)) / 1000) % dur;
    // Tight, and deliberately so. This is not a continuous drift corrector that would chatter —
    // it runs on state changes and on load — so the dead zone only needs to skip a seek that
    // would move nothing. A loose one (1.5s was the first guess) doesn't smooth anything: it
    // just bakes the joiner's connection delay in as a PERMANENT offset, which is audible as an
    // echo the moment two people sit in the same room.
    if (Math.abs(a.currentTime - want) <= 0.25) return;
    // Only assign if the target is actually reachable. An origin that doesn't serve byte ranges
    // makes the whole resource unseekable, and the browser then DROPS every assignment without
    // raising — playback just carries on from wherever it was, which reads exactly like a
    // working seek until you measure it.
    if (sessSeekable(a, want)) { try { a.currentTime = want; } catch (e) {} }
    // Bounded recheck, because the target may simply not have downloaded yet. Costs nothing once
    // in sync: the recheck recomputes `want`, which has advanced by as much as currentTime has,
    // so it returns at the dead zone above. And it gives up rather than spinning when the origin
    // serves no ranges at all — everyone still hears the track, just not from the same point.
    if (sessSeekTries < 4) { sessSeekTries++; setTimeout(sessSeek, 500); }
  }
  function sessSeekable(a, t) {
    try {
      for (var i = 0; i < a.seekable.length; i++) {
        if (a.seekable.end(i) <= 0) continue; // a degenerate [0,0] range means "not seekable"
        if (t >= a.seekable.start(i) && t <= a.seekable.end(i)) return true;
      }
    } catch (e) {}
    return false;
  }
  function sessUnblock() {
    if (!sessBlocked) return;
    sessBlocked = false;
    sessApplyMusic();
  }

  // the room's word is final — adopt it wholesale and re-render
  function sessApply(msg) {
    var wasRemain = sessRemain(), wasTrack = sess.music && sess.music.track;
    sess = { timer: msg.timer || null, music: msg.music || null };
    sessAt = performance.now();
    // a new track (or a restart) is a fresh seek target — give it its own retry budget
    if (!sess.music || sess.music.track !== wasTrack) sessSeekTries = 0;
    // a fresh countdown re-arms the 00:00 announcement; one that's already at zero doesn't
    var r = sessRemain();
    if (!sess.timer || (r > 0 && (wasRemain == null || r > wasRemain))) sessRang = false;
    sessSyncTimer(true);
    sessApplyMusic(); // re-syncs the track picker and play button on its way through
  }

  // ---- persistence ---------------------------------------------------------
  var saveTimer = null;
  function scheduleSave() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); histSchedule(); }

  // ---- undo / redo (⌘Z · ⌘⇧Z) ----------------------------------------------
  // Snapshot-diff history, not a command log: nothing in the mutation paths has to know about
  // it. A debounced tick compares the board against a shadow copy and records ONLY the nodes
  // that changed, as {before, after} pairs — so undo puts those nodes back rather than
  // restoring the whole doc. That's what keeps it safe in a live room: remote edits are folded
  // into the shadow as they arrive (histSeen), so they never enter YOUR history and your ⌘Z
  // can never revert a teammate's work. Same debounce as the save, so a burst of typing or one
  // drag is one undo step.
  var histUndo = [], histRedo = [], histShadow = {}, histTimer = null, histBusy = false;
  var HIST_MAX = 60;
  function histClone(n) {
    var c = {}; for (var k in n) if (n.hasOwnProperty(k)) c[k] = n[k];
    if (n.points) c.points = n.points.map(function (p) { return p.slice(); });
    if (n.cells) { c.cells = {}; for (var ck in n.cells) c.cells[ck] = n.cells[ck]; }
    if (n.crop) c.crop = { x: n.crop.x, y: n.crop.y, w: n.crop.w, h: n.crop.h };
    return c;
  }
  function histSeed() { histShadow = {}; board.nodes.forEach(function (n) { histShadow[n.id] = histClone(n); }); }
  function histSeen(node) { if (node) histShadow[node.id] = histClone(node); }   // remote change: mine to ignore
  function histForget(id) { delete histShadow[id]; }
  function histSchedule() { if (histBusy) return; if (histTimer) clearTimeout(histTimer); histTimer = setTimeout(histCommit, 500); }
  function histCommit() {
    histTimer = null;
    var entry = [], seen = {};
    board.nodes.forEach(function (n) {
      seen[n.id] = true;
      var was = histShadow[n.id];
      if (!was) { entry.push({ id: n.id, before: null, after: histClone(n) }); histShadow[n.id] = histClone(n); return; }
      if (mpSig(was) !== mpSig(n)) { entry.push({ id: n.id, before: was, after: histClone(n) }); histShadow[n.id] = histClone(n); }
    });
    for (var id in histShadow) if (!seen[id]) { entry.push({ id: id, before: histShadow[id], after: null }); delete histShadow[id]; }
    if (!entry.length) return;
    histUndo.push(entry);
    if (histUndo.length > HIST_MAX) histUndo.shift();
    histRedo.length = 0; // a fresh edit forks the timeline
  }
  // apply one side of an entry: `dir` picks which snapshot wins
  function histApply(entry, dir) {
    histBusy = true;
    if (histTimer) { clearTimeout(histTimer); histTimer = null; }
    var touched = [];
    entry.forEach(function (it) {
      var want = dir === "before" ? it.before : it.after;
      var i = board.nodes.findIndex(function (n) { return n.id === it.id; });
      if (!want) { // the node shouldn't exist on this side
        if (i >= 0) { board.nodes.splice(i, 1); if (nodeEls[it.id]) { nodeEls[it.id].remove(); delete nodeEls[it.id]; } }
        histForget(it.id);
        return;
      }
      var copy = histClone(want);
      if (i >= 0) board.nodes[i] = copy; else board.nodes.push(copy);
      histShadow[it.id] = histClone(copy);
      touched.push(copy);
    });
    selected = selected.filter(function (id) { return !!nodeById(id); });
    touched.forEach(renderNode);
    if (selected.length === 1) setSelection(selected.slice()); else hideSelBar();
    save();
    histBusy = false;
    return touched;
  }
  function undo() {
    var entry = histUndo.pop(); if (!entry) return false;
    histApply(entry, "before");
    histRedo.push(entry);
    return true;
  }
  function redo() {
    var entry = histRedo.pop(); if (!entry) return false;
    histApply(entry, "after");
    histUndo.push(entry);
    return true;
  }
  // Writes are the scarce resource on Workers KV (the free tier is a THOUSAND a day) and this
  // doc runs to hundreds of KB once images are inlined — so never spend a write we don't owe.
  // If only the camera moved, the content signature is unchanged and the POST is skipped.
  var lastSavedSig = null;
  function docSig() { return JSON.stringify({ n: board.nodes, m: board.name }); }
  function save() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    // While the room socket is live, the ROOM persists (it sees every op and writes KV on
    // its own alarm) — a client POST here would only duplicate the write and re-open the
    // two-browsers-stomp problem. This rail is the SOLO fallback: socket down or never up.
    if (mp && mp.readyState === 1 && mpReady) return;
    var sig = docSig();
    if (sig === lastSavedSig) return;
    lastSavedSig = sig;
    fetch(BOARD_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: board }) }).catch(function () {});
  }
  // The viewport is PER-USER — the room never syncs it — so it has no business in the shared
  // doc, where every pan and every zoom step used to trigger a full-document KV write AND
  // overwrite everyone else's stored camera. It lives in localStorage now, keyed by board path;
  // the doc's `view` is still read as a fallback so existing boards open where they always did.
  var VIEW_KEY = "gvc:view:" + BOARD_PATH, viewTimer = null;
  function saveView() {
    if (viewTimer) return;
    viewTimer = setTimeout(function () {
      viewTimer = null;
      try { localStorage.setItem(VIEW_KEY, JSON.stringify(board.view)); } catch (e) {}
    }, 400);
  }
  function storedView() {
    try {
      var v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
      if (v && typeof v.x === "number" && typeof v.y === "number" && typeof v.scale === "number") return v;
    } catch (e) {}
    return null;
  }
  window.addEventListener("beforeunload", function () {
    if (mp && mp.readyState === 1 && mpReady) return; // the room outlives this tab and flushes on empty
    if (!saveTimer || docSig() === lastSavedSig) return;
    try { navigator.sendBeacon(BOARD_API, new Blob([JSON.stringify({ doc: board })], { type: "application/json" })); } catch (e) {}
  });
  function load(done) {
    fetch(BOARD_API).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.doc && d.doc.nodes) { board = d.doc; board.view = board.view || { x: 0, y: 0, scale: 1 }; board.name = board.name || CFG.name || "Untitled canvas"; }
      else { board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; }
      var mine = storedView();
      if (mine) board.view = mine;
      histSeed();
      lastSavedSig = docSig(); // freshly loaded == already saved
      done();
    }).catch(function () { board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; histSeed(); done(); });
  }

  // ---- public API for the comment overlay + tools --------------------------
  window.GVCanvas = {
    get board() { return board; },
    get view() { return board.view; },
    screenToWorld: screenToWorld, worldToScreen: worldToScreen, world: world,
    onTransform: function (cb) { transformCbs.push(cb); },
    nodes: function () { return board.nodes; }, addNode: addNode,
    setTool: setTool
  };

  // ---- multiplayer (cursors · presence · live ops · co-editing) ------------
  // Every canvas is born multiplayer: the engine opens a WebSocket to /__rt (proxied to the
  // augur-realtime worker — one BoardRoom Durable Object per board path, the same key as the
  // KV doc). Live cursors, presence chips, node ops and editing focus flow through the room;
  // durable persistence STAYS on the /__board KV rail exactly as before. Strictly an
  // enhancement layer: if the socket can't connect the canvas behaves exactly as solo.
  //
  // Sync model: no hooks in the mutation paths. A 120ms diff tick compares every node
  // against a shadow signature and broadcasts changes as {op:"upsert"|"del"|"name"} —
  // catching drags mid-flight (which don't scheduleSave until pointer-up), text mid-edit,
  // and even GVCanvas.addNode calls from the collaboration skill. Applying a remote op
  // writes the shadow FIRST, so the tick never echoes it back. Conflicts are per-node
  // last-writer-wins; a node you're actively dragging or editing ignores remote writes
  // (the tick then re-broadcasts your version — deterministic convergence). The doc's
  // `view` is per-user viewport and is never synced.
  var mp = null, mpSid = null, mpName = "", mpColor = "#0d0d0d", mpAvatar = null;
  var mpPeers = {};        // sid -> {name,color,focus,cx,cy,el,idle}
  var mpShadow = {};       // node id -> signature as last seen/sent
  var mpShadowName = null; // board name as last seen/sent
  var mpReady = false, mpRetry = 1000;
  var mpCursorLayer = null, mpPresence = null, mpCurPend = null, mpCurTimer = null;
  var GEO_KEYS = ["x", "y", "w", "h", "x1", "y1", "x2", "y2"];

  // signature = JSON with long strings (inlined image src) collapsed to length + edges,
  // so the 120ms tick stays cheap on image-heavy boards
  function mpSig(node) {
    return JSON.stringify(node, function (k, v) {
      return typeof v === "string" && v.length > 2048 ? "#" + v.length + ":" + v.slice(0, 40) + v.slice(-40) : v;
    });
  }
  function mpGeoLessSig(node) {
    var c = {}; for (var k in node) if (node.hasOwnProperty(k) && GEO_KEYS.indexOf(k) < 0) c[k] = node[k];
    return mpSig(c);
  }
  // tile signature ALSO ignoring live/liveUrl — a change in only those is a live-state
  // transition handled in place (keep the iframe's DOM state), never a rebuild
  function mpTileSig(node) {
    var c = {}; for (var k in node) if (node.hasOwnProperty(k) && GEO_KEYS.indexOf(k) < 0 && k !== "live" && k !== "liveUrl") c[k] = node[k];
    return mpSig(c);
  }
  function mpSeedShadow() {
    mpShadow = {};
    board.nodes.forEach(function (n) { mpShadow[n.id] = mpSig(n); });
    mpShadowName = board.name;
  }
  function mpSend(msg) { if (mp && mp.readyState === 1) { try { mp.send(JSON.stringify(msg)); } catch (e) {} } }

  // the outbound diff tick. Skipped while the tab is hidden — stringifying the whole board
  // 8×/s in a background tab is pure waste; visibilitychange runs one catch-up tick so
  // anything an agent mutated while hidden still syncs the moment you come back.
  function mpTick() {
    if (document.hidden) return;
    if (!mp || mp.readyState !== 1 || !mpReady) return;
    var ops = [], seen = {};
    board.nodes.forEach(function (n) {
      var s = mpSig(n); seen[n.id] = true;
      if (mpShadow[n.id] !== s) { mpShadow[n.id] = s; ops.push({ op: "upsert", node: n }); }
    });
    for (var id in mpShadow) if (!seen[id]) { delete mpShadow[id]; ops.push({ op: "del", id: id }); }
    if (board.name !== mpShadowName) { mpShadowName = board.name; ops.push({ op: "name", name: board.name }); }
    if (ops.length) mpSend({ t: "ops", ops: ops });
  }

  function mpDragInvolves(id) {
    if (!drag) return false;
    if (drag.items) return drag.items.some(function (it) { return it.id === id; });
    return !!(drag.node && drag.node.id === id);
  }
  function mpLocallyEditing(id) {
    var host = nodeEls[id];
    return !!(host && host.querySelector('[contenteditable="true"]'));
  }
  // remove a node because a PEER deleted it — removeNode minus scheduleSave (their client saves)
  function mpRemoveLocal(id) {
    var i = board.nodes.findIndex(function (n) { return n.id === id; });
    if (i >= 0) board.nodes.splice(i, 1);
    // a peer's delete FADES out instead of blinking away — the element is already
    // out of the model and the els map, it just lingers 160ms on its way out
    var host = nodeEls[id];
    if (host) {
      delete nodeEls[id];
      host.style.transition = "opacity .16s ease-out"; host.style.opacity = "0";
      setTimeout(function () { host.remove(); }, 170);
    }
    selected = selected.filter(function (s) { return s !== id; });
    if (selected.length !== 1) hideSelBar();
  }
  function mpApplyOps(ops) {
    var focusDirty = false;
    ops.forEach(function (op) {
      if (!op) return;
      if (op.op === "upsert" && op.node && op.node.id) {
        var r = op.node;
        mpShadow[r.id] = mpSig(r); // anti-echo — set BEFORE deciding whether to apply
        histSeen(r);               // a peer's edit is not mine to undo
        if (mpDragInvolves(r.id) || mpLocallyEditing(r.id)) return; // local interaction wins
        var local = nodeById(r.id), host = nodeEls[r.id];
        if (local && host && mpGeoLessSig(r) === mpGeoLessSig(local) && local.type !== "arrow") {
          // geometry-only change (a peer dragging/resizing): patch styles on the live element
          // instead of rebuilding it — smooth at tick rate, no iframe/image churn
          mpPatchGeo(local, host, r);
        } else if (local && host && local.type === "tile" && r.type === "tile" && mpTileSig(r) === mpTileSig(local)) {
          // navigation/geometry-only change on a tile — act on the existing element so the
          // iframe's in-page state survives; never a rebuild (tiles are always live now)
          GEO_KEYS.forEach(function (k) { if (r[k] != null) local[k] = r[k]; });
          local.liveUrl = r.liveUrl;
          place(host, local);
          scaleTileChrome(local, host);
          var tb = host.querySelector(".gvc-tilebody");
          var fr = tb && tb.querySelector("iframe");
          if (fr) {
            fitFrame(tb, local);
            if (r.liveUrl) { // stale frame? follow the shared navigation
              try {
                var cl = fr.contentWindow.location;
                if (cl.pathname + cl.search + cl.hash !== r.liveUrl) fr.contentWindow.location.replace(r.liveUrl);
              } catch (e) {}
            }
          }
          if (isSelected(r.id)) positionSelBar();
        } else {
          var i = board.nodes.findIndex(function (n) { return n.id === r.id; });
          var isNew = i < 0;
          if (i >= 0) board.nodes[i] = r; else board.nodes.push(r);
          renderNode(r);
          if (isNew) pop(r.id); // a peer's new node lands with the same pop yours do
          focusDirty = true;
        }
      } else if (op.op === "del" && op.id) {
        delete mpShadow[op.id];
        histForget(op.id);
        mpRemoveLocal(op.id);
      } else if (op.op === "name" && typeof op.name === "string") {
        board.name = op.name; mpShadowName = op.name;
        document.title = op.name; if (nameEl) nameEl.textContent = op.name;
      }
    });
    if (focusDirty) mpRenderFocus(); // renderNode replaced elements — re-hang focus rings
  }
  // adopt the room's live doc (fresher than our KV read) — keep OUR viewport
  function mpAdoptDoc(doc) {
    if (!doc || !Array.isArray(doc.nodes)) return;
    var view = board.view;
    board = doc;
    board.view = view;
    board.name = board.name || "Untitled canvas";
    document.title = board.name; if (nameEl) nameEl.textContent = board.name;
    render();
    mpSeedShadow();
    lastSavedSig = docSig(); // the room's doc is the peer's to persist — don't duplicate their write
    histSeed(); histUndo.length = 0; histRedo.length = 0; // not your edit — no undoing "into" it
    mpRenderFocus();
  }

  // ---- prototype demo sync (inside live tile iframes) ----------------------
  // Prototypes are SAME-ORIGIN, so the engine can reach inside a live tile: clicks, typed
  // input, scrolling and navigation are mirrored to everyone on the board — pressing ▶ Live
  // demos to the room, not just yourself. Symmetric (anyone can drive, like node ops).
  // Anti-echo: replayed events are synthetic (isTrusted=false) and every replay opens a
  // short quiet window on that frame, so mirrored interaction never re-broadcasts.
  // Navigation rides node.liveUrl through the normal op sync (late joiners mount there);
  // in-frame events ride ephemeral {t:"proto"} relays. Cross-origin tiles safely no-op.
  function mpFrameLoad(node, frame) {
    var win, doc;
    try { win = frame.contentWindow; doc = win.document; if (!doc || !doc.documentElement) return; } catch (e) { return; }
    var href = win.location.pathname + win.location.search + win.location.hash;
    var want = href === node.url ? undefined : href;
    if (node.liveUrl !== want) node.liveUrl = want; // diff tick syncs; peers already there absorb it
    if (frame.__mpHooked === doc) return;
    frame.__mpHooked = doc;
    // once you click into a prototype the iframe owns the keyboard — catch Esc in there
    // so leaving interact mode works no matter where focus sits
    doc.addEventListener("keydown", function (e) { if (e.key === "Escape") { try { exitInteract(); } catch (err) {} } });
    function quiet() { return win.__mpQuiet && Date.now() < win.__mpQuiet; }
    doc.addEventListener("click", function (e) {
      if (!e.isTrusted || quiet()) return;
      mpSend({ t: "proto", id: node.id, ev: { k: "click", sel: mpSelOf(e.target, doc), x: e.clientX, y: e.clientY } });
    }, true);
    var inpT = null, inpEl = null;
    function inpFlush() {
      if (inpT) { clearTimeout(inpT); inpT = null; }
      if (!inpEl) return;
      var ev = { k: "input", sel: mpSelOf(inpEl, doc) };
      if (inpEl.type === "checkbox" || inpEl.type === "radio") ev.c = !!inpEl.checked;
      else ev.v = inpEl.value;
      inpEl = null;
      mpSend({ t: "proto", id: node.id, ev: ev });
    }
    function onInput(e) {
      if (!e.isTrusted || quiet()) return;
      var t = e.target; if (!t || !t.tagName || t.value == null) return;
      if (inpEl && inpEl !== t) inpFlush();
      inpEl = t;
      if (inpT) clearTimeout(inpT);
      inpT = setTimeout(inpFlush, 150);
    }
    doc.addEventListener("input", onInput, true);
    doc.addEventListener("change", onInput, true);
    var scT = null, scEl = null;
    win.addEventListener("scroll", function (e) {
      if (quiet()) return; // scroll events are always trusted — the quiet window is the only guard
      scEl = e.target;
      if (scT) return;
      scT = setTimeout(function () {
        scT = null;
        try {
          if (!scEl || scEl === doc || scEl === win || scEl === doc.documentElement || scEl === doc.body)
            mpSend({ t: "proto", id: node.id, ev: { k: "scroll", sel: "@win", top: win.scrollY, left: win.scrollX } });
          else mpSend({ t: "proto", id: node.id, ev: { k: "scroll", sel: mpSelOf(scEl, doc), top: scEl.scrollTop, left: scEl.scrollLeft } });
        } catch (err) {}
      }, 120);
    }, true);
  }
  // css path for an element inside a prototype frame — id if there is one, else an
  // nth-child chain (clicks also carry x/y, elementFromPoint is the fallback)
  function mpSelOf(t, doc) {
    if (!t || !t.tagName) return null;
    var esc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : s; };
    if (t.id) return "#" + esc(t.id);
    var path = [], el2 = t;
    while (el2 && el2.tagName && el2 !== doc.body && path.length < 14) {
      var p = el2.parentElement, i = 1, s = el2.previousElementSibling;
      while (s) { i++; s = s.previousElementSibling; }
      path.unshift(el2.tagName.toLowerCase() + ":nth-child(" + i + ")");
      if (p && p.id) { path.unshift("#" + esc(p.id)); return path.join(" > "); }
      el2 = p;
    }
    return "body > " + path.join(" > ");
  }
  function mpProtoApply(m) {
    var host = nodeEls[m.id]; if (!host) return;
    var frame = host.querySelector("iframe"); if (!frame) return;
    var win, doc;
    try { win = frame.contentWindow; doc = win.document; if (!doc) return; } catch (e) { return; }
    win.__mpQuiet = Date.now() + 400;
    var ev = m.ev || {};
    try {
      if (ev.k === "click") {
        var t = null;
        if (ev.sel) { try { t = doc.querySelector(ev.sel); } catch (e) {} }
        if (!t && ev.x != null) t = doc.elementFromPoint(ev.x, ev.y); // same DEVICE_W everywhere → same layout
        if (t) t.click();
      } else if (ev.k === "input") {
        var ie = ev.sel && doc.querySelector(ev.sel);
        if (ie) {
          if (ev.c != null) ie.checked = ev.c;
          if (ev.v != null) ie.value = ev.v;
          ie.dispatchEvent(new win.Event("input", { bubbles: true }));
          ie.dispatchEvent(new win.Event("change", { bubbles: true }));
        }
      } else if (ev.k === "scroll") {
        if (ev.sel === "@win") win.scrollTo(ev.left || 0, ev.top || 0);
        else { var se = ev.sel && doc.querySelector(ev.sel); if (se) { se.scrollTop = ev.top || 0; se.scrollLeft = ev.left || 0; } }
      }
    } catch (e) {}
  }

  // ---- peer cursors --------------------------------------------------------
  // ONE arrow glyph for everybody, tinted per visitor. The glyph is the
  // custom pointer from piti mode (pitis/piti.js CURSOR_SVG — dark arrow, white
  // outline, hotspot at the tip 5,3): peers render it in their room color, and your own
  // OS pointer wears it too (in YOUR color) whenever a canvas file is open.
  var MP_ARROW = '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 912 892"><g transform="translate(0.000000,892.000000) scale(0.100000,-0.100000)"><path d="M2604 7445 c-38 -17 -89 -66 -111 -109 -19 -36 -20 -144 -4 -351 6 -71 16 -186 21 -255 5 -69 14 -181 20 -250 5 -69 21 -267 35 -440 32 -400 72 -900 85 -1055 5 -66 14 -181 20 -255 6 -74 15 -193 20 -265 6 -71 15 -188 20 -260 6 -71 15 -184 20 -250 5 -66 14 -183 20 -260 6 -77 15 -187 20 -245 6 -58 14 -168 20 -245 6 -77 15 -194 21 -260 5 -66 16 -201 24 -300 8 -99 19 -236 25 -305 6 -69 15 -183 20 -255 5 -71 15 -191 21 -265 6 -74 14 -180 18 -235 9 -117 26 -161 84 -210 64 -55 159 -71 235 -40 63 27 67 31 227 280 18 28 99 156 180 285 204 324 374 593 465 735 42 66 128 201 190 300 180 287 200 315 290 405 166 168 374 283 595 329 59 12 295 27 670 41 149 6 376 15 505 20 129 5 366 15 525 20 490 19 576 25 621 48 105 54 152 186 105 294 -24 55 -47 75 -216 192 -77 52 -207 142 -290 199 -82 57 -332 229 -555 382 -223 153 -443 305 -490 337 -47 32 -152 105 -235 161 -149 103 -421 290 -1063 732 -183 127 -393 271 -465 320 -73 50 -206 142 -297 205 -91 62 -235 161 -320 220 -85 59 -229 158 -320 220 -91 63 -228 157 -305 210 -77 53 -160 110 -185 129 -25 18 -60 39 -79 47 -42 18 -146 17 -187 -1z" fill="{C}" stroke="#ffffff" stroke-width="620" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke"/></g></svg>';
  function mpArrowSvg(color) { return MP_ARROW.replace("{C}", color); }
  // ---- Clawd: the real Anthropic "Clawd" icon (icons8, user-provided), tintable, STATE-driven --
  // Agent peers render as CLAWD (body/legs/arms take the peer color; eyes are black). The DISPLAY
  // state is derived from behaviour by agentPose(): moving → walking (looks left/right + a bob),
  // working a node (has focus) → SPARKLES (the icons8 sparkles variant), quiet/parked → sleeping,
  // else idle. A white outline (feMorphology) keeps it legible on any background. viewBox 0 0 48 48.
  var CLAWD_K = "#1a1a1a";
  function clawdBody(color) {
    return '<rect width="36" height="24" x="6" y="18" fill="' + color + '"/>' +
      '<rect width="3" height="9" x="9" y="39" fill="' + color + '"/>' +
      '<rect width="3" height="9" x="15" y="39" fill="' + color + '"/>' +
      '<rect width="3" height="9" x="30" y="39" fill="' + color + '"/>' +
      '<rect width="3" height="9" x="36" y="39" fill="' + color + '"/>' +
      '<rect width="7.5" height="6" x="0" y="33" fill="' + color + '"/>' +
      '<rect width="7.5" height="6" x="40.5" y="33" fill="' + color + '"/>';
  }
  function clawdEye(x, fill) { return '<rect width="3" height="6" x="' + x + '" y="24" fill="' + fill + '"/>'; }
  // pixel heart (5x4 cells, cell size c) — the "Clawd In Love" accessory shape
  function clawdHeart(x, y, c) {
    var f = ' fill="#e03131"/>';
    return '<rect width="' + 2 * c + '" height="' + c + '" x="' + x + '" y="' + y + '"' + f +
      '<rect width="' + 2 * c + '" height="' + c + '" x="' + (x + 3 * c) + '" y="' + y + '"' + f +
      '<rect width="' + 5 * c + '" height="' + c + '" x="' + x + '" y="' + (y + c) + '"' + f +
      '<rect width="' + 3 * c + '" height="' + c + '" x="' + (x + c) + '" y="' + (y + 2 * c) + '"' + f +
      '<rect width="' + c + '" height="' + c + '" x="' + (x + 2 * c) + '" y="' + (y + 3 * c) + '"' + f;
  }
  function clawdEyesMarkup(pose) {
    if (pose === "sleeping") return '<rect width="4" height="2" x="11.5" y="28" fill="' + CLAWD_K + '"/><rect width="4" height="2" x="32.5" y="28" fill="' + CLAWD_K + '"/>';
    if (pose === "lookLeft") return clawdEye(10, CLAWD_K) + clawdEye(31, CLAWD_K);
    if (pose === "lookRight") return clawdEye(14, CLAWD_K) + clawdEye(35, CLAWD_K);
    if (pose === "happy") return '<rect width="4" height="2" x="11.5" y="25" fill="' + CLAWD_K + '"/><rect width="4" height="2" x="32.5" y="25" fill="' + CLAWD_K + '"/>';
    if (pose === "sunglasses") return '<rect width="27" height="4" x="9" y="24" fill="' + CLAWD_K + '"/>' + clawdEye(12, CLAWD_K) + clawdEye(33, CLAWD_K);
    return clawdEye(12, CLAWD_K) + clawdEye(33, CLAWD_K); // idle / sparkles / thinking
  }
  // the exact icons8 sparkles overlay (from the user-provided "Clawd Sparkles" variant)
  var CLAWD_SPARKLES = '<rect width="3" height="7" x="39" y="4" fill="#0091ff"/><rect width="3" height="7" x="39" y="4" fill="#0091ff" transform="rotate(90 40.5 7.5)"/><rect width="3" height="13" x="21" y="0" fill="#0091ff"/><rect width="3" height="13" x="21" y="0" fill="#0091ff" transform="rotate(90 22.5 6.5)"/><rect width="3" height="3" x="31" y="12" fill="#0091ff"/><rect width="7" height="7" x="19" y="3" fill="#0091ff"/>';
  function clawdAcc(pose) {
    if (pose === "sparkles") return CLAWD_SPARKLES;
    if (pose === "thinking") return '<rect width="2.5" height="2.5" x="43" y="13" fill="' + CLAWD_K + '"/><rect width="2" height="2" x="45.5" y="8" fill="' + CLAWD_K + '"/>';
    // "Clawd In Love" (icons8): eyes stay NORMAL — a big pixel heart floats above the head
    // top-right, with a few stray heart-pixels drifting off it
    if (pose === "love") return clawdHeart(31, 2, 3) +
      '<rect width="3" height="3" x="25" y="4" fill="#e03131"/>' +
      '<rect width="2" height="2" x="28" y="10" fill="#e03131"/>' +
      '<rect width="2" height="2" x="21" y="1" fill="#e03131"/>';
    return "";
  }
  var clawdSeq = 0;
  // Multiple Clawds on one board differ by silhouette, not just tint: a deterministic
  // accessory from the NAME hash (same recipe as the identity color, so it's stable across
  // sessions with zero coordination). The primary orange "Clawd" stays bare — it's the icon.
  function clawdWearable(name) {
    if (!name || String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-") === "clawd") return "";
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    var kind = h % 4, c = "#f6f0e4"; // cream, matching the die-cut outline — reads on any tint
    if (kind === 0) return ""; // some Clawds just don't do hats
    if (kind === 1) // antenna with a bobble
      return '<rect x="22.5" y="11" width="3" height="7" fill="' + c + '"/><rect x="21" y="7.5" width="6" height="4" fill="' + c + '"/>';
    if (kind === 2) // beanie with a pompom
      return '<rect x="13" y="13.5" width="22" height="4.5" fill="' + c + '"/><rect x="21" y="9.5" width="6" height="4" fill="' + c + '"/>';
    return '<rect x="30" y="12.5" width="4" height="5" fill="' + c + '"/><rect x="35.5" y="11" width="5" height="8" fill="' + c + '"/>'; // jaunty side cap
  }
  function clawdSvg(pose, color, name) {
    var fid = "clawd-o-" + (++clawdSeq);
    var inner = clawdBody(color) + clawdEyesMarkup(pose) + clawdAcc(pose) + clawdWearable(name);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
      '<defs><filter id="' + fid + '" x="-25%" y="-25%" width="150%" height="150%">' +
      '<feMorphology in="SourceAlpha" operator="dilate" radius="1.5" result="d"/>' +
      '<feFlood flood-color="#fff"/><feComposite in2="d" operator="in" result="o"/>' +
      '<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
      '<g filter="url(#' + fid + ')">' + inner + '</g></svg>';
  }
  // small, tightly-framed Clawd for the presence chip (white body on the colored chip)
  function clawdChipSvg(color) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="14" viewBox="0 18 48 30">' + clawdBody(color) + clawdEyesMarkup("idle") + '</svg>';
  }
  // DERIVE the display state from behaviour: walking (moving) > working/sparkles (focused) >
  // an explicit emotion the agent broadcast > sleeping (quiet/parked) > idle.
  function agentPose(p) {
    var now = Date.now();
    if (p.petLove) return "love"; // being petted (hovered) beats everything — heart eyes
    if (p.walkUntil && now < p.walkUntil) return p.dir === "L" ? "lookLeft" : "lookRight";
    if (p.focus) return "sparkles";
    if (p.pose && p.pose !== "idle" && p.pose !== "sleeping") return p.pose;
    if (p.pose === "sleeping" || !p.lastMoveTs || now - p.lastMoveTs > 4500) return "sleeping";
    return "idle";
  }
  // glyph for a peer: Clawd (in its derived state) if it's an agent, the arrow otherwise
  function mpGlyph(p) { return p && p.kind === "agent" ? clawdSvg(agentPose(p), p.color, p.name) : mpArrowSvg(p.color); }
  // swap just the glyph svg in place (pose change) — keep the name label
  function mpUpdateGlyph(p) {
    if (!p.el) return;
    var svg = p.el.querySelector("svg"); if (!svg) return;
    var tmp = document.createElement("div"); tmp.innerHTML = mpGlyph(p);
    if (tmp.firstChild) p.el.replaceChild(tmp.firstChild, svg);
  }
  // re-derive each agent's Clawd state (walking / working / sleeping / idle) ~5x/s; only rebuild
  // the glyph when the state actually changes, and toggle the walking-bob class
  function mpPoseTick() {
    var now = Date.now();
    for (var sid in mpPeers) {
      var p = mpPeers[sid];
      if (!p || p.kind !== "agent" || !p.el) continue;
      p.el.classList.toggle("walking", !!(p.walkUntil && now < p.walkUntil));
      var np = agentPose(p);
      if (np !== p.shownPose) { p.shownPose = np; mpUpdateGlyph(p); }
    }
  }
  // your own pointer: injected <style> so the tool cursors keep winning where they should —
  // hand/pan/crosshair modes and text editing stay native, everything else wears the arrow
  var mpCursorStyleEl = null;
  function mpApplyLocalCursor() {
    var uri = "data:image/svg+xml," + encodeURIComponent(mpArrowSvg(mpColor));
    if (!mpCursorStyleEl) { mpCursorStyleEl = document.createElement("style"); document.head.appendChild(mpCursorStyleEl); }
    mpCursorStyleEl.textContent =
      "#gvc-root,#gvc-root .gvc-node{cursor:url('" + uri + "') 5 3,auto}" +
      "#gvc-root.hand .gvc-node,#gvc-root.panning .gvc-node,#gvc-root.crosshair .gvc-node{cursor:inherit}" +
      '#gvc-root .gvc-node.editing,#gvc-root .gvc-node [contenteditable="true"]{cursor:text}';
  }
  function mpEnsureCursor(p) {
    if (p.el) return p.el;
    p.el = el("div", { class: "gvc-cursor" + (p.kind === "agent" ? " agent" : ""), html: mpGlyph(p) + '<span class="lbl"></span><span class="chat hidden"></span>' });
    if (p.kind === "agent") {
      p.shownPose = agentPose(p);
      // pet: hovering flips the mascot to the "In Love" state (heart eyes) — the pose
      // tick picks petLove up and swaps the glyph; pointerover/out survive glyph swaps
      // because they live on the container
      p.el.addEventListener("pointerover", function () { p.petLove = true; });
      p.el.addEventListener("pointerout", function () { p.petLove = false; });
      // poke: clicking a Clawd makes it hop (listener on the container — the svg gets
      // swapped on pose changes; class removal + reflow restarts the animation)
      p.el.addEventListener("click", function () {
        p.el.classList.remove("poked"); void p.el.offsetWidth;
        p.el.classList.add("poked");
        setTimeout(function () { p.el.classList.remove("poked"); }, 750);
      });
    }
    var lbl = p.el.querySelector(".lbl");
    lbl.textContent = p.name; lbl.style.background = p.color;
    mpCursorLayer.appendChild(p.el);
    mpApplyStatus(p);
    return p.el;
  }
  // Status is a STATE, so it lives on the Clawd's avatar chip in the presence row — the
  // dot on the face (working/idle/attention/done), the chip itself jumping when the agent
  // needs you (Rob's call 2026-08-05: agents present the way PEOPLE do, one row for the
  // whole room). The cursor only carries the amber attention pulse, for locality when the
  // Clawd that needs you happens to be on screen. The status TEXT lives one click away,
  // in the agent's card (mpAgentPopOpen).
  function mpApplyStatus(p) {
    if (p.el) p.el.classList.toggle("attention", !!(p.status && p.status.state === "attention"));
    mpRenderPresence();
    mpAgentPopSync();
  }
  // default state is DETERMINISTIC: working. Idle is only ever set explicitly (the
  // daemon's heartbeat owns it) — deriving it from the mascot's quiet-pose made the
  // chips flap and fight the heartbeat's wake.
  function mpAgentState(p) {
    var s = (p && p.status) || {};
    var state = s.state || "working";
    return {
      state: state,
      text: s.text || (state === "idle" ? "idle" : state === "attention" ? "needs you" : state === "done" ? "done ✓" : "working…"),
    };
  }
  // The agent card: click a Clawd's chip and its status text + actions open beneath —
  // Follow (the same fly-and-chase humans get) and Kick off board. Kick is
  // {t:"kick",sid}: the room relays it to the target only, whose daemon logs it and ENDS
  // its process (agents only, worker-enforced — a human's tab belongs to that human).
  var mpAgentPopEl = null, mpAgentPopSid = null;
  function mpAgentPopClose() {
    if (!mpAgentPopEl) return;
    mpAgentPopEl.remove(); mpAgentPopEl = null; mpAgentPopSid = null;
    document.removeEventListener("pointerdown", mpAgentPopDocDown, true);
    document.removeEventListener("keydown", mpAgentPopDocKey, true);
  }
  function mpAgentPopDocDown(e) { if (mpAgentPopEl && !mpAgentPopEl.contains(e.target)) mpAgentPopClose(); }
  function mpAgentPopDocKey(e) { if (e.key === "Escape") { e.stopPropagation(); mpAgentPopClose(); } }
  function mpAgentPopOpen(sid, chip) {
    if (mpAgentPopSid === sid) { mpAgentPopClose(); return; } // second click folds it back
    mpAgentPopClose();
    if (!mpPeers[sid]) return;
    mpAgentPopSid = sid;
    mpAgentPopEl = el("div", { id: "gvc-agentpop" });
    document.body.appendChild(mpAgentPopEl);
    mpAgentPopSync();
    // under the chip, right-aligned to it, nudged inside the viewport
    var r = chip.getBoundingClientRect();
    mpAgentPopEl.style.top = r.bottom + 9 + "px";
    mpAgentPopEl.style.left = Math.max(8, Math.min(innerWidth - mpAgentPopEl.offsetWidth - 8, r.right - mpAgentPopEl.offsetWidth)) + "px";
    document.addEventListener("pointerdown", mpAgentPopDocDown, true);
    document.addEventListener("keydown", mpAgentPopDocKey, true);
  }
  // (re)paint the open card from the live peer — status updates land while it's open, and
  // the peer leaving (or being kicked) takes the card with it
  function mpAgentPopSync() {
    if (!mpAgentPopEl) return;
    var sid = mpAgentPopSid, p = mpPeers[sid];
    if (!p) { mpAgentPopClose(); return; }
    var st = mpAgentState(p);
    mpAgentPopEl.innerHTML = "";
    var face = el("span", { class: "face", html: clawdChipSvg("#f6f0e4") });
    face.style.background = p.color;
    mpAgentPopEl.appendChild(el("div", { class: "hd" }, [face, el("span", { class: "who", text: p.name }), el("span", { class: "dot " + st.state })]));
    mpAgentPopEl.appendChild(el("div", { class: "txt " + st.state, text: st.text }));
    var follow = el("button", { type: "button", text: mpFollowSid === sid ? "Unfollow" : "Follow" });
    follow.addEventListener("click", function () {
      if (mpFollowSid === sid) mpUnfollow(); else mpFollow(sid);
      mpAgentPopClose();
    });
    var kick = el("button", { class: "kick", type: "button", text: "Kick off board" });
    kick.addEventListener("click", function () {
      mpSend({ t: "kick", sid: sid });
      mpAgentPopClose(); // the chip goes when its leave arrives — the room's word, not ours
    });
    mpAgentPopEl.appendChild(el("div", { class: "acts" }, [follow, kick]));
  }
  // cursor chat: a bubble at the cursor for ~6s, then gone. A moment, not a state.
  function mpShowChat(p, text) {
    mpEnsureCursor(p);
    var c = p.el.querySelector(".chat"); if (!c) return;
    c.textContent = text; c.style.background = p.color;
    c.classList.remove("hidden");
    p.el.classList.remove("idle");
    clearTimeout(p.chatT);
    p.chatT = setTimeout(function () { c.classList.add("hidden"); }, 6000);
  }
  // MY side of cursor chat: "/" opens a small input at the pointer, Enter
  // sends {t:"chat"} + echoes the bubble locally, Esc closes. Clawd daemons log incoming
  // chat to their events file, so talking to an agent here reaches it on its next turn.
  // Where the pointer last was over the canvas, in SCREEN px. Cursor chat opens here and
  // ⌘V lands here, so it's tracked unconditionally — it used to be wired up inside mpBoot,
  // which quietly made "paste at the cursor" depend on the multiplayer layer booting.
  var chatInput = null, lastMouse = { x: innerWidth / 2, y: innerHeight / 2 };
  root.addEventListener("pointermove", function (e) { lastMouse.x = e.clientX; lastMouse.y = e.clientY; });
  function openCursorChat() {
    if (chatInput) { chatInput.querySelector("input").focus(); return; }
    chatInput = el("div", { id: "gvc-cursorchat" }, [el("input", { type: "text", placeholder: "Say something…", maxLength: "200" })]);
    chatInput.style.left = Math.min(innerWidth - 240, lastMouse.x + 14) + "px";
    chatInput.style.top = Math.min(innerHeight - 48, lastMouse.y + 16) + "px";
    document.body.appendChild(chatInput);
    var inp = chatInput.querySelector("input");
    inp.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") {
        var t = inp.value.trim();
        if (t) {
          mpSend({ t: "chat", text: t });
          mpShowChat(mpSelfPeer(), t); // echo at my own cursor so I see what everyone sees
        }
        closeCursorChat();
      } else if (e.key === "Escape") closeCursorChat();
    });
    inp.addEventListener("blur", function () { setTimeout(closeCursorChat, 120); });
    inp.focus();
  }
  function closeCursorChat() { if (chatInput) { chatInput.remove(); chatInput = null; } }
  // a pseudo-peer for my own cursor bubble (I have no .gvc-cursor element of my own — fake
  // one anchored at the live pointer, cleaned up by the same 6s timer)
  var selfBubble = null;
  function mpSelfPeer() {
    if (!selfBubble) {
      selfBubble = { name: mpName, color: mpColor, el: el("div", { class: "gvc-cursor self", html: '<span class="chat hidden"></span>' }) };
      mpCursorLayer.appendChild(selfBubble.el);
    }
    selfBubble.el.style.transform = "translate(" + Math.round(lastMouse.x) + "px," + Math.round(lastMouse.y) + "px)";
    selfBubble.color = mpColor;
    return selfBubble;
  }
  function mpPlaceCursor(p) {
    if (!p.el || p.cx == null) return;
    var s = worldToScreen(p.cx, p.cy);
    p.el.style.transform = "translate(" + Math.round(s.x) + "px," + Math.round(s.y) + "px)";
    // the MASCOT soft-scales with zoom (clamped); the name pill stays constant-size like a
    // human cursor's label — the CSS var drives only the svg (and the pill's anchor offset)
    if (p.kind === "agent") {
      var k = Math.max(0.45, Math.min(1.25, Math.pow(board.view.scale, 0.45)));
      p.el.style.setProperty("--clawd-k", k.toFixed(3));
    }
  }
  function mpPositionCursors() { for (var sid in mpPeers) mpPlaceCursor(mpPeers[sid]); }
  // Patch a node's geometry from a remote source IN PLACE (no rebuild): tween class for the
  // glide, place(), tile iframe refit, toolbar reposition. Shared by the cursor fast-path
  // and the ops tick — one behavior, one place.
  function mpPatchGeo(n, host, src) {
    GEO_KEYS.forEach(function (k) { if (src[k] != null) n[k] = src[k]; });
    if (n.type === "arrow") { renderNode(n); return; }
    // a resizing draw stroke ships its rescaled points (the svg is px-fixed —
    // stretching the host without them would leave the path misdrawn)
    if (n.type === "draw" && src.points) { n.points = src.points; renderNode(n); return; }
    host.classList.add("gvc-remote-move");
    clearTimeout(host.__mpMoveT);
    host.__mpMoveT = setTimeout(function () { host.classList.remove("gvc-remote-move"); }, 300);
    place(host, n);
    if (n.type === "tile") { var b = host.querySelector(".gvc-tilebody"); if (b && b.querySelector("iframe")) fitFrame(b, n); }
    if (isSelected(n.id)) positionSelBar();
  }
  // apply a peer's mid-drag geometry (the cursor fast-path). Shadow + history are updated
  // FIRST so our own diff tick doesn't echo the patch back as an op, and undo never records
  // a teammate's drag as ours. Local interaction still wins.
  function mpApplyDragGeo(list) {
    for (var i = 0; i < list.length; i++) {
      var g = list[i]; if (!g || !g.id) continue;
      if (mpDragInvolves(g.id) || mpLocallyEditing(g.id)) continue;
      var n = nodeById(g.id), host = nodeEls[g.id];
      if (!n || !host) continue;
      mpPatchGeo(n, host, g);
      mpShadow[g.id] = mpSig(n); histSeen(n); // same synchronous turn — the tick can't interleave
    }
  }
  function mpCursorMsg(m) {
    var p = mpPeers[m.sid] || (mpPeers[m.sid] = { name: m.name, color: m.color, focus: null, kind: m.kind || null });
    p.name = m.name; p.color = m.color; if (m.kind != null) p.kind = m.kind;
    if (m.drag) mpApplyDragGeo(m.drag);
    if (m.gone) { if (p.el) p.el.classList.add("idle"); return; }
    mpEnsureCursor(p);
    // agent walking: direction from horizontal delta, and a short window that marks "moving"
    if (p.kind === "agent" && p.cx != null) {
      var dx = m.x - p.cx;
      if (Math.abs(dx) > 0.4) p.dir = dx < 0 ? "L" : "R";
      p.walkUntil = Date.now() + 320;
    }
    p.lastMoveTs = Date.now();
    p.cx = m.x; p.cy = m.y;
    p.el.classList.remove("idle");
    clearTimeout(p.idle);
    p.idle = setTimeout(function () { if (p.el) p.el.classList.add("idle"); }, 5000);
    mpPlaceCursor(p);
    if (m.sid === mpFollowSid) mpFollowChase();
  }
  // my cursor out — world coords, trailing-throttled to ~20/s. Mid-drag, the SAME message
  // carries the dragged nodes' geometry (the fast-path): peers get 20Hz motion instead of
  // the 120ms ops tick, and it costs zero extra messages. The durable upserts still ride
  // the tick — this is display-only traffic.
  function mpDragGeo() {
    if (!drag) return null;
    var out = [];
    if (drag.mode === "move" && drag.items) {
      drag.items.forEach(function (it) {
        var n = nodeById(it.id); if (!n) return;
        if (it.arrow) out.push({ id: n.id, x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 });
        else out.push({ id: n.id, x: n.x, y: n.y });
      });
    } else if (drag.mode === "resize" && drag.node) {
      var n2 = drag.node;
      var op = { id: n2.id, x: n2.x, y: n2.y, w: n2.w, h: n2.h };
      // a draw stroke's geometry IS its points — without them a peer's render
      // stretches the svg box around an unchanged path mid-drag
      if (n2.type === "draw" && n2.points) op.points = n2.points;
      out.push(op);
    } else if (drag.mode === "arrow" && drag.node) {
      var a = drag.node;
      out.push({ id: a.id, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
    }
    return out.length && out.length <= 64 ? out : null;
  }
  function mpTrackPointer(e) {
    if (!mp || mp.readyState !== 1) return;
    mpCurPend = screenToWorld(e.clientX, e.clientY);
    if (mpCurTimer) return;
    mpCurTimer = setTimeout(function () {
      mpCurTimer = null;
      if (!mpCurPend) return;
      var msg = { t: "cursor", x: Math.round(mpCurPend.x * 10) / 10, y: Math.round(mpCurPend.y * 10) / 10 };
      var g = mpDragGeo(); if (g) msg.drag = g;
      mpSend(msg);
    }, 50);
  }

  // ---- presence chips (top-right) ------------------------------------------
  function mpInitials(name) {
    return String(name || "?").trim().split(/\s+/).map(function (w) { return w.charAt(0); }).slice(0, 2).join("").toUpperCase();
  }
  function mpRenderPresence() {
    if (!mpPresence) return;
    mpFollowChrome(); // the border + Following-pill track every presence repaint
    mpPresence.innerHTML = "";
    if (!mp || mp.readyState !== 1) { mpPresence.classList.add("hidden"); mpAgentPopClose(); return; }
    // ONE row for the whole room (Rob's call 2026-08-05): humans as initial chips, Clawds
    // as face chips right beside them, wearing their status as the dot on the avatar —
    // agents present the way people do. Humans first, then agents.
    var chips = [{ name: mpName, title: mpName + " (you)", color: mpColor, avatar: mpAvatar, me: true }];
    for (var sid in mpPeers) { var p = mpPeers[sid]; if (p.kind === "agent") continue; chips.push({ sid: sid, name: p.name, title: p.name, color: p.color, avatar: p.avatar, kind: p.kind, pose: p.pose }); }
    for (var sid2 in mpPeers) { var p2 = mpPeers[sid2]; if (p2.kind !== "agent") continue; chips.push({ sid: sid2, name: p2.name, title: p2.name, color: p2.color, kind: "agent", peer: p2 }); }
    if (chips.length < 2) { mpPresence.classList.add("hidden"); mpAgentPopClose(); return; } // alone — no chrome
    mpPresence.classList.remove("hidden");
    chips.forEach(function (c) {
      var isAgent = c.kind === "agent";
      var chip = el("div", { class: "gvc-peerchip" + (c.me ? " me" : "") + (isAgent ? " agent" : "") });
      // every chip wears its owner's identity color; agents get a cream mini Clawd on it,
      // humans their photo when their account carries one, else their initial — so the
      // chip always matches the cursor identity on the board
      chip.style.background = c.color;
      if (isAgent) chip.innerHTML = clawdChipSvg("#f6f0e4");
      else if (c.avatar) chip.style.background = "url(\"" + c.avatar + "\") center/cover, " + c.color;
      else chip.textContent = mpInitials(c.name);
      var following = !c.me && c.sid && mpFollowSid === c.sid;
      if (isAgent) {
        // the status dot rides the avatar; attention makes the whole chip jump. The text
        // and the actions (follow / kick) are one click away, in the agent's card.
        var st = mpAgentState(c.peer);
        chip.appendChild(el("span", { class: "st " + st.state }));
        chip.classList.toggle("attn", st.state === "attention");
        chip.classList.toggle("resting", st.state === "idle");
        chip.appendChild(el("span", { class: "lbl", text: st.state === "attention" ? c.title + " needs you — click" : c.title + " — " + st.text }));
        chip.classList.add("jump");
        if (following) { chip.classList.add("following"); chip.style.setProperty("--halo", c.color); }
        chip.addEventListener("click", function (e) { e.stopPropagation(); mpAgentPopOpen(c.sid, chip); });
      } else {
        // hover = who this is (a styled label, not the OS tooltip — that took a second to
        // appear and looked nothing like the board); click = fly to what they're looking at
        chip.appendChild(el("span", { class: "lbl", text: c.me ? c.title : following ? c.title + " — click to unfollow" : c.title + " — click to follow" }));
        if (!c.me && c.sid) {
          chip.classList.add("jump");
          if (following) { chip.classList.add("following"); chip.style.setProperty("--halo", c.color); }
          chip.addEventListener("click", function (e) {
            e.stopPropagation();
            if (mpFollowSid === c.sid) mpUnfollow(); else mpFollow(c.sid);
          });
        }
      }
      mpPresence.appendChild(chip);
    });
  }
  // ---- follow mode: mirror a peer's viewport (the FigJam idiom) --------------
  // Click a face → your camera glides to THEIR viewport and tracks it — pan AND zoom,
  // their visible world rect fitted into your window (peers publish it via {t:"view"}).
  // While following, the screen wears their color as a border and a "Following <name>"
  // pill with a Stop button sits top-centre. Agents publish no viewport (a daemon has no
  // window), so following one falls back to the old cursor chase. Any manual pan/zoom/
  // space-drag breaks the follow (your hand always wins) — as does Stop, clicking the
  // chip again, or the peer leaving.
  var mpFollowSid = null, mpFollowRaf = null;
  function mpFollow(sid) {
    mpFollowSid = sid;
    var p = mpPeers[sid];
    if (!(p && p.view)) mpJumpTo(sid); // no shared viewport — fly to their cursor instead
    mpRenderPresence();
    mpFollowChase();
  }
  function mpUnfollow() {
    if (!mpFollowSid) return;
    mpFollowSid = null;
    if (mpFollowRaf) { cancelAnimationFrame(mpFollowRaf); mpFollowRaf = null; }
    mpRenderPresence();
  }
  // where the camera should be right now to mirror the followed peer
  function mpFollowTarget() {
    var p = mpFollowSid && mpPeers[mpFollowSid];
    if (!p) return null;
    if (p.view) {
      var pv = p.view;
      var ww = pv.w / pv.s, wh = pv.h / pv.s;                            // their visible world rect
      var cx = (pv.w / 2 - pv.x) / pv.s, cy = (pv.h / 2 - pv.y) / pv.s;  // its centre
      var ts = clampScale(Math.min(innerWidth / ww, innerHeight / wh));  // fit it into MY window
      return { x: innerWidth / 2 - cx * ts, y: innerHeight / 2 - cy * ts, s: ts };
    }
    if (p.cx != null) { // cursor fallback (agents): keep them centred at my own zoom
      var v = board.view;
      return { x: innerWidth / 2 - p.cx * v.scale, y: innerHeight / 2 - p.cy * v.scale, s: v.scale };
    }
    return null;
  }
  // soft-glide loop: lerp toward the target each frame until settled; new view/cursor
  // data (or a resize) re-arms it. One raf at a time, ~zero cost once settled.
  function mpFollowChase() {
    if (mpFollowRaf || !mpFollowSid) return;
    mpFollowRaf = requestAnimationFrame(function () {
      mpFollowRaf = null;
      if (!mpFollowSid) return;
      if (flyRaf) { mpFollowChase(); return; } // the initial flyTo is still travelling — don't fight it
      var t = mpFollowTarget();
      if (!t) return;
      var v = board.view;
      var dx = t.x - v.x, dy = t.y - v.y, ds = t.s - v.scale;
      v.x += dx * 0.18; v.y += dy * 0.18; v.scale += ds * 0.18; // soft chase, not a hard lock
      applyTransform(); saveView();
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(ds) > 0.0005) mpFollowChase();
    });
  }
  // the follow chrome: a border in the followed person's color around the whole viewport
  // + the top-centre "Following <name>" pill with its Stop button. Rendered from
  // mpRenderPresence so name/color updates and every follow/unfollow path repaint it.
  var mpFollowFrame = null, mpFollowPill = null;
  function mpFollowChrome() {
    var p = mpFollowSid && mpPeers[mpFollowSid];
    if (!p) {
      if (mpFollowFrame) { mpFollowFrame.remove(); mpFollowFrame = null; }
      if (mpFollowPill) { mpFollowPill.remove(); mpFollowPill = null; }
      return;
    }
    if (!mpFollowFrame) { mpFollowFrame = el("div", { id: "gvc-follow-frame" }); document.body.appendChild(mpFollowFrame); }
    mpFollowFrame.style.borderColor = p.color;
    if (!mpFollowPill) {
      mpFollowPill = el("div", { id: "gvc-follow-pill" }, [el("span", { class: "who" }), el("button", { type: "button", class: "stop", text: "Stop" })]);
      mpFollowPill.querySelector(".stop").addEventListener("click", function (e) { e.stopPropagation(); mpUnfollow(); });
      document.body.appendChild(mpFollowPill);
    }
    mpFollowPill.querySelector(".who").textContent = "Following " + p.name;
    mpFollowPill.style.background = p.color; // the pill is part of the border — same color
  }
  // Fly to where a peer is: their live cursor, or the node they're typing in if they haven't
  // moved the mouse yet. Eases rather than teleports so you keep your bearings.
  function mpJumpTo(sid) {
    var p = mpPeers[sid]; if (!p) return;
    var wx = p.cx, wy = p.cy;
    if (wx == null && p.focus) {
      var n = nodeById(p.focus), r = n && nodeRect(n);
      if (r) { wx = r.x + r.w / 2; wy = r.y + r.h / 2; }
    }
    if (wx == null) return;
    flyTo(wx, wy);
    if (p.el) { p.el.classList.remove("idle"); p.el.classList.add("pinged"); setTimeout(function () { if (p.el) p.el.classList.remove("pinged"); }, 900); }
  }

  // ---- editing focus (who is typing where) ---------------------------------
  function mpRenderFocus() {
    document.querySelectorAll(".gvc-remote-focus").forEach(function (e) { e.remove(); });
    document.querySelectorAll(".gvc-peer-sel").forEach(function (e) { e.remove(); });
    for (var sid in mpPeers) {
      var p = mpPeers[sid];
      // togetherness cue: a thin outline in the peer's color on whatever they have
      // SELECTED (the thicker named ring below stays reserved for active typing)
      if (p.sel) p.sel.forEach(function (id) {
        var host = nodeEls[id];
        if (!host || id === p.focus) return;
        var ring = el("div", { class: "gvc-peer-sel" });
        ring.style.borderColor = p.color;
        host.appendChild(ring);
      });
      if (!p.focus || !nodeEls[p.focus]) continue;
      var ring2 = el("div", { class: "gvc-remote-focus" }, [el("span", { class: "who", text: p.name })]);
      ring2.style.borderColor = p.color;
      ring2.querySelector(".who").style.background = p.color;
      nodeEls[p.focus].appendChild(ring2);
    }
  }
  var mpMyFocus = null;
  function mpSendFocus(id) { if (id !== mpMyFocus) { mpMyFocus = id; mpSend({ t: "focus", id: id }); } }
  // my live selection → the room, trailing-throttled (marquee calls setSelection per
  // pointermove) and change-gated so a quiet selection costs nothing
  var mpSelSent = "", mpSelTimer = null;
  function mpSendSel() {
    if (mpSelTimer) return;
    mpSelTimer = setTimeout(function () {
      mpSelTimer = null;
      var key = selected.join(",");
      if (key === mpSelSent) return;
      mpSelSent = key;
      mpSend({ t: "sel", ids: selected.slice(0, 200) });
    }, 150);
  }

  // my viewport → the room, trailing-throttled and change-gated. This is what makes
  // follow mode a viewport mirror instead of a cursor chase: everyone publishes their
  // camera (pan/zoom) + window size, and a follower fits that rect into their own window.
  var mpViewTimer = null, mpViewSent = "";
  function mpSendView() {
    if (!mp || mp.readyState !== 1) return;
    if (mpViewTimer) return;
    mpViewTimer = setTimeout(function () {
      mpViewTimer = null;
      var v = board.view;
      var out = { x: Math.round(v.x), y: Math.round(v.y), s: Math.round(v.scale * 1000) / 1000, w: innerWidth, h: innerHeight };
      var key = out.x + "," + out.y + "," + out.s + "," + out.w + "," + out.h;
      if (key === mpViewSent) return;
      mpViewSent = key;
      mpSend({ t: "view", v: out });
    }, 90);
  }

  // ---- socket lifecycle ----------------------------------------------------
  function mpOnMessage(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || !m.t) return;
    if (m.t === "welcome") {
      mpSid = m.sid; mpRetry = 1000;
      if (m.color && m.color !== mpColor) { mpColor = m.color; mpApplyLocalCursor(); } // your pointer takes your room color
      mpPeers = {};
      (m.peers || []).forEach(function (p) { mpPeers[p.sid] = { name: p.name, color: p.color, avatar: p.avatar || null, focus: p.focus || null, kind: p.kind || null, pose: p.pose || null, sel: p.sel || null, status: p.status || null, view: p.view || null }; });
      if (m.doc) mpAdoptDoc(m.doc);
      else mpSend({ t: "doc", doc: board }); // seed the room (first in, or post-hibernation — KV is current when the room was idle)
      // walked in on a running timer / playing track: adopt it mid-flight
      sessApply(m.session || { timer: null, music: null });
      mpReady = true;
      mpRenderPresence(); mpRenderFocus();
      mpViewSent = ""; mpSendView(); // publish my camera now so a follower needn't wait for my first move
    } else if (m.t === "join") {
      mpPeers[m.peer.sid] = { name: m.peer.name, color: m.peer.color, avatar: m.peer.avatar || null, focus: m.peer.focus || null, kind: m.peer.kind || null, pose: m.peer.pose || null, status: m.peer.status || null };
      mpRenderPresence();
    } else if (m.t === "leave") {
      var p = mpPeers[m.peer.sid];
      if (p) { if (p.el) p.el.remove(); clearTimeout(p.idle); delete mpPeers[m.peer.sid]; }
      if (m.peer.sid === mpFollowSid) mpUnfollow();
      mpRenderPresence(); mpRenderFocus();
    } else if (m.t === "cursor") mpCursorMsg(m);
    else if (m.t === "proto") mpProtoApply(m);
    else if (m.t === "ops") mpApplyOps(m.ops || []);
    else if (m.t === "focus") { var fp = mpPeers[m.sid]; if (fp) { fp.focus = m.id || null; mpRenderFocus(); } }
    else if (m.t === "sel") { var sp = mpPeers[m.sid]; if (sp) { sp.sel = m.ids || null; mpRenderFocus(); } }
    else if (m.t === "view") { var vwp = mpPeers[m.sid]; if (vwp) { vwp.view = m.view || null; if (m.sid === mpFollowSid) mpFollowChase(); } }
    else if (m.t === "status") { var stp = mpPeers[m.sid]; if (stp) { stp.status = m.status || null; mpApplyStatus(stp); mpRenderPresence(); } }
    else if (m.t === "chat") { var cp = mpPeers[m.sid] || (mpPeers[m.sid] = { name: m.name, color: m.color, kind: m.kind || null, focus: null }); mpShowChat(cp, m.text); }
    else if (m.t === "pose") { var qp = mpPeers[m.sid]; if (qp) { qp.pose = m.pose || null; mpUpdateGlyph(qp); mpRenderPresence(); } }
    else if (m.t === "session") sessApply(m);
    else if (m.t === "doc") mpAdoptDoc(m.doc);
    else if (m.t === "docreq") mpSend({ t: "doc", doc: board });
  }
  function mpConnect() {
    var ws;
    try {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host +
        "/__rt?path=" + encodeURIComponent(BOARD_PATH) + "&name=" + encodeURIComponent(mpName || "Guest") +
        (mpAvatar ? "&avatar=" + encodeURIComponent(mpAvatar) : ""));
    } catch (e) { mpRetryLater(); return; }
    mp = ws;
    ws.onmessage = mpOnMessage;
    ws.onclose = ws.onerror = function () {
      if (mp !== ws) return;
      mp = null; mpReady = false;
      for (var sid in mpPeers) { var p = mpPeers[sid]; if (p.el) p.el.remove(); clearTimeout(p.idle); }
      mpPeers = {};
      mpUnfollow(); // sids don't survive a reconnect — a stale follow would chase a ghost
      mpRenderPresence(); mpRenderFocus();
      mpRetryLater();
    };
  }
  function mpRetryLater() { setTimeout(mpConnect, mpRetry); mpRetry = Math.min(Math.round(mpRetry * 1.6), 15000); }

  function mpBoot() {
    mpSeedShadow();
    mpApplyLocalCursor(); // the canvas cursor identity — dark until the room assigns your color
    mpCursorLayer = el("div", { id: "gvc-cursors" });
    document.body.appendChild(mpCursorLayer); // outside #gvc-ui so ⌘. keeps cursors visible
    mpPresence = el("div", { id: "gvc-presence", class: "hidden" });
    // into the top-right card, BEFORE the session pill (avatars left, session right —
    // the FigJam order), not straight onto the UI layer
    if (topRightEl) topRightEl.insertBefore(mpPresence, topRightEl.firstChild);
    else ui.appendChild(mpPresence);
    transformCbs.push(mpPositionCursors);
    root.addEventListener("pointermove", mpTrackPointer);
    document.addEventListener("mouseleave", function () { mpSend({ t: "cursor", gone: true }); });
    // co-editing: focus events bubble from every contentEditable (sticky/shape/text text,
    // table cells, name labels) — no per-renderer hooks needed
    document.addEventListener("focusin", function (e) {
      var host = e.target && e.target.closest && e.target.closest(".gvc-node");
      if (host && e.target.isContentEditable) mpSendFocus(host.dataset.id);
    });
    document.addEventListener("focusout", function (e) {
      var host = e.target && e.target.closest && e.target.closest(".gvc-node");
      if (host) mpSendFocus(null);
    });
    // live text: mirror keystrokes into the node so the diff tick streams them (the existing
    // blur handlers still commit name derivation exactly as before)
    document.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.closest || !t.classList) return;
      var host = t.closest(".gvc-node"); if (!host) return;
      var node = nodeById(host.dataset.id); if (!node) return;
      if (t.classList.contains("gvc-txt")) commitRich(node, t); // text AND inline markup/lists
      else if (t.classList.contains("gvc-cell") && node.cells) node.cells[t.dataset.rc] = t.innerText.trim();
    });
    setInterval(mpTick, 120);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { try { mpTick(); } catch (e) {} } });
    // a resized window changes what I can see — republish, and refit anyone I'm following
    window.addEventListener("resize", function () { mpViewSent = ""; mpSendView(); mpFollowChase(); });
    setInterval(mpPoseTick, 200); // animate agent Clawd state (walk/work/sleep) from behaviour
    // keepalive: the room's auto-responder pongs and timestamps us; sockets that stop
    // pinging (dropped transports) get swept server-side instead of haunting presence
    setInterval(function () { if (mp && mp.readyState === 1) { try { mp.send("ping"); } catch (e) {} } }, 25000);
    // resolve my display name (and avatar, if the account has one) first so the cursor
    // label and presence chip are right from the first frame
    fetch("/__me", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        mpName = (d && d.user && d.user.name) || ME || "Guest";
        var av = d && d.user && d.user.avatar;
        // same-origin paths only — this string rides the join URL to every peer
        if (typeof av === "string" && av.charAt(0) === "/" && av.length < 300) mpAvatar = av;
      })
      .catch(function () { mpName = ME || "Guest"; })
      .then(mpConnect);
  }

  // ---- boot ----------------------------------------------------------------
  try { fetch("/__me", { headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }).then(function (d) { if (d && d.user && d.user.name) ME = d.user.name; }).catch(function () {}); } catch (e) {}
  document.body.appendChild(root);
  buildUI();
  load(function () {
    document.title = board.name;
    if (nameEl) nameEl.textContent = board.name;
    render();
    applyTransform();
    openDeepLink();  // #n=<id> → fly there (after render, so nodeEls exist)
    mpBoot();
  });
  // pasting a link into the bar of an already-open board never reloads — catch it here
  window.addEventListener("hashchange", openDeepLink);
})();
