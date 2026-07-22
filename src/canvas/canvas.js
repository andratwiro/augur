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
 * The toolbar is a faithful FigJam rebuild: select/hand · marker (draw sub-toolbar:
 * marker/highlighter/washi/eraser + thin/thick + colors) · sticky · shape cluster (shapes
 * sub-toolbar: connectors + shape grid + More shapes) · text/section/table/stamp/bubble ·
 * prototypes · insert. Node types: sticky, text, image, tile, arrow (straight/elbow/curved/
 * line), draw (freehand strokes), shape (geometry + centered text), section, table, stamp.
 *
 * AI-legibility: nodes are plain data ({id,type,name,x,y,w,h,...}); every node carries a
 * human name so Claude and Rob share a vocabulary ("the onboarding tile"), not pixel pointing.
 * window.GVCanvas exposes the board + coordinate transforms for the comment overlay and tools.
 */
(function () {
  "use strict";
  if (window.__GV_CANVAS_BOOTED) return;
  window.__GV_CANVAS_BOOTED = true;

  var CFG = window.GV_CANVAS || {};
  var BOARD_PATH = CFG.boardPath || location.pathname;
  var BOARD_API = "/__board?path=" + encodeURIComponent(BOARD_PATH);

  var MIN_SCALE = 0.1, MAX_SCALE = 4, GRID = 16, MAX_LIVE_TILES = 6; // total loaded iframes (live or frozen); LRU-evict oldest to poster
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
  // FigJam pastel sticky palette (white, grey, red, orange, yellow, green, teal, blue, purple, pink)
  var STICKY_COLORS = ["#ffffff", "#e9ecef", "#f4a9a8", "#f7c99a", "#fce495", "#bfe5a0", "#a9e5db", "#a9cbf5", "#cbb8f2", "#f5b3d7"];
  var DEFAULT_STICKY = "#a9cbf5"; // FigJam's default blue (Rob's pick)
  // FigJam marker palette (draw sub-toolbar dots, left to right)
  var DRAW_COLORS = ["#1e1e1e", "#f24822", "#ff9f2e", "#ffd233", "#35c759", "#3aa2ff", "#8a5cff", "#ffffff"];
  // stamp wheel, clockwise from the top — FigJam's die-cut sticker set, re-created as flat
  // SVGs with a white outline (paint-order:stroke) so they read as stickers, not OS emoji.
  // "laugh" fills FigJam's avatar slot with an emoji rendered through the same sticker filter.
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
  var FONT_SIZES = { s: "13px", m: "16px", l: "21px" };
  var ME = ""; // signed-in name, stamped as the sticky author (like FigJam)

  // ---- board state ---------------------------------------------------------
  var board = { v: 1, name: CFG.name || "Untitled canvas", view: { x: 0, y: 0, scale: 1 }, nodes: [] };
  var nodeEls = {};        // id -> DOM element
  var selected = [];       // ids of selected nodes (click, shift-add, or marquee = multi)
  var liveTiles = [];      // ids of tiles currently showing a live iframe (LRU, capped)
  var transformCbs = [];   // listeners notified on every pan/zoom (comments overlay, sel bar)

  // ---- tool state ----------------------------------------------------------
  // TOOL.kind: select | hand | draw | eraser | shape | connector | section | place
  // draw substate lives in drawStyle; shape/connector carry what to draw; place carries type.
  var TOOL = { kind: "select" };
  var drawStyle = { mode: "marker", size: "thin", color: "#1e1e1e" };
  var armedShape = "square", armedConnector = "arrow", armedStamp = STAMPS[0];

  function uid() { return "n" + Math.random().toString(36).slice(2, 9); }
  function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }
  // FigJam-style dot grid: dot SIZE is constant (the gradient stop is absolute px), and spacing
  // = GRID*scale is NORMALIZED into a comfortable band by doubling/halving — so it never becomes
  // a dense moire mush when zoomed out or huge gaps when zoomed in. Constant density.
  function gridStep(scale) { var s = GRID * scale; while (s < 14) s *= 2; while (s > 28) s /= 2; return s; }

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
  // 24-viewBox; slightly thinner stroke than stock to sit with FigJam's line weight.
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
      var gstep = gridStep(v.scale);
      root.style.backgroundSize = gstep + "px " + gstep + "px";
      root.style.backgroundPosition = v.x + "px " + v.y + "px";
      if (zoomPct) zoomPct.textContent = Math.round(v.scale * 100) + "%";
      // comments.js repositions pins on window scroll; a canvas pan/zoom IS a scroll of the
      // world, so tell it. Board-anchored threads read GVCanvas.worldToScreen (comments hook).
      try { window.dispatchEvent(new Event("scroll")); } catch (e) {}
      for (var i = 0; i < transformCbs.length; i++) { try { transformCbs[i](); } catch (e) {} }
    });
  }
  function zoomAt(sx, sy, factor) {
    var v = board.view, ns = clampScale(v.scale * factor), f = ns / v.scale;
    v.x = sx - (sx - v.x) * f; v.y = sy - (sy - v.y) * f; v.scale = ns;
    applyTransform(); scheduleSave();
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
  // can immediately drag them. (Cmd/Ctrl-D — the Figma convention.)
  function duplicateSelection() {
    if (!selected.length) return;
    var dx = 32, dy = 32, newIds = [];
    selected.forEach(function (id) {
      var n = nodeById(id); if (!n) return;
      var c = {}; for (var k in n) if (n.hasOwnProperty(k)) c[k] = n[k];
      // deep-copy the mutable containers so the copy doesn't share them with the original
      if (n.points) c.points = n.points.map(function (p) { return p.slice(); });
      if (n.cells) { c.cells = {}; for (var ck in n.cells) c.cells[ck] = n.cells[ck]; }
      if (n.crop) c.crop = { x: n.crop.x, y: n.crop.y, w: n.crop.w, h: n.crop.h };
      c.id = uid();
      if (n.type === "arrow") { c.x1 = n.x1 + dx; c.y1 = n.y1 + dy; c.x2 = n.x2 + dx; c.y2 = n.y2 + dy; }
      else { c.x = (n.x || 0) + dx; c.y = (n.y || 0) + dy; }
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
    liveTiles = liveTiles.filter(function (t) { return t !== id; });
    selected = selected.filter(function (s) { return s !== id; }); if (selected.length !== 1) hideSelBar();
    scheduleSave();
  }

  // ---- selection (click, shift-add, or marquee = multi-select) -------------
  function isSelected(id) { return selected.indexOf(id) >= 0; }
  function setSelection(ids) {
    selected.forEach(function (id) { if (nodeEls[id]) nodeEls[id].classList.remove("sel"); });
    clearDecor();
    selected = ids.slice();
    selected.forEach(function (id) { if (nodeEls[id]) nodeEls[id].classList.add("sel"); });
    if (selected.length === 1) {
      var n = nodeById(selected[0]);
      decorate(selected[0]);
      if (n && (n.type === "sticky" || n.type === "shape" || n.type === "draw")) showSelBar(n); else hideSelBar();
    } else hideSelBar();
  }
  function select(id) { setSelection(id ? [id] : []); }
  var decorEls = [];
  function clearDecor() { decorEls.forEach(function (e) { e.remove(); }); decorEls = []; }
  function decorate(id) {
    clearDecor();
    var node = nodeById(id), host = nodeEls[id];
    if (!node || !host || node.type === "arrow" || node.type === "draw") return;
    if (node.type === "table") {
      // FigJam's add affordances: a blue + strip along the bottom (row) and right (column)
      var ar = el("div", { class: "gvc-addrow", text: "+" });
      guard(ar); ar.addEventListener("click", function (e) { e.stopPropagation(); node.h = node.h / node.rows * (node.rows + 1); node.rows++; renderNode(node); scheduleSave(); });
      var ac = el("div", { class: "gvc-addcol", text: "+" });
      guard(ac); ac.addEventListener("click", function (e) { e.stopPropagation(); node.w = node.w / node.cols * (node.cols + 1); node.cols++; renderNode(node); scheduleSave(); });
      host.appendChild(ar); host.appendChild(ac); decorEls.push(ar, ac);
    }
    var rz = el("div", { class: "gvc-resize" });
    rz.addEventListener("pointerdown", function (e) { startResize(e, node); });
    host.appendChild(rz); decorEls.push(rz);
  }

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
    return host;
  }

  function editableText(node, host, cls) {
    var txt = el("div", { class: "gvc-txt " + cls, contentEditable: "false", html: escapeHtml(node.text || "") });
    // Editing is entered via manual double-tap detection in the pointerdown handler (native
    // dblclick is unreliable while the root holds pointer capture) → enterEdit(id).
    txt.addEventListener("blur", function () {
      host.classList.remove("editing"); txt.contentEditable = "false";
      node.text = txt.innerText;
      if (node.type !== "image" && node.type !== "tile") node.name = (node.text || "").split("\n")[0].slice(0, 60) || autoName(node.type);
      scheduleSave();
    });
    txt.addEventListener("pointerdown", function (e) { if (host.classList.contains("editing")) e.stopPropagation(); });
    txt.addEventListener("keydown", function (e) { e.stopPropagation(); });
    return txt;
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

  function renderSticky(node) {
    node.w = node.w || 160; node.h = node.h || 160;
    var host = el("div", { class: "gvc-sticky" });
    host.style.background = node.color || DEFAULT_STICKY;
    var txt = editableText(node, host, "");
    txt.style.fontSize = FONT_SIZES[node.fontScale || "m"];
    if (node.bold) txt.style.fontWeight = "700";
    host.appendChild(txt);
    host.appendChild(el("div", { class: "gvc-author", text: node.author || "" }));
    place(host, node);
    return host;
  }
  function renderText(node) {
    var host = el("div", { class: "gvc-text" });
    host.appendChild(editableText(node, host, ""));
    host.style.left = node.x + "px"; host.style.top = node.y + "px";
    return host;
  }
  // Editable floating name label above a node — the rename affordance for images (tiles carry
  // their name in the bar; stickies/text are identified by their own content). Manual double-tap
  // because the root's pointer capture eats native dblclick; single tap selects, Esc cancels.
  function nameLabel(node) {
    var lab = el("div", { class: "gvc-name", text: node.name || "", contentEditable: "false", title: "Double-click to rename" });
    var tap = 0;
    lab.addEventListener("pointerdown", function (e) {
      if (lab.contentEditable === "true") return;
      e.stopPropagation();
      var now = Date.now();
      if (now - tap < 350) { tap = 0; lab.contentEditable = "true"; lab.focus(); if (document.execCommand) document.execCommand("selectAll", false, null); }
      else { tap = now; select(node.id); }
    });
    lab.addEventListener("blur", function () { lab.contentEditable = "false"; node.name = lab.textContent.trim() || node.name; lab.textContent = node.name; scheduleSave(); });
    lab.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); lab.blur(); } else if (e.key === "Escape") { lab.textContent = node.name; lab.blur(); } });
    return lab;
  }
  function renderImage(node) {
    node.w = node.w || 240; node.h = node.h || 180;
    var img = el("img", { src: node.src, alt: node.name || "" });
    if (node.crop) applyCrop(img, node.crop);
    var host = el("div", { class: "gvc-image" }, [el("div", { class: "gvc-imgwrap" }, [img])]);
    host.appendChild(nameLabel(node));
    place(host, node);
    return host;
  }
  // A crop is NON-destructive: src keeps the full image, node.crop = the visible window as
  // fractions {x,y,w,h} of it. Percent sizing (relative to the clipping wrap) keeps the
  // window correct under free node resize with no JS in the resize path.
  function applyCrop(img, c) {
    img.className = "cropped";
    img.style.width = (100 / c.w) + "%"; img.style.height = (100 / c.h) + "%";
    img.style.left = (-100 * c.x / c.w) + "%"; img.style.top = (-100 * c.y / c.h) + "%";
  }
  function renderTile(node) {
    node.w = node.w || 420; node.h = node.h || 300;
    var body = el("div", { class: "gvc-tilebody" });
    var nm = el("div", { class: "nm", text: node.name || node.url, contentEditable: "false", title: "Double-click to rename — " + node.url });
    // Manual double-tap: root pointer-capture eats the native dblclick, and stopping propagation
    // keeps a tap on the name from starting a tile drag. Double-tap → edit, single tap → select.
    var nmTap = 0;
    nm.addEventListener("pointerdown", function (e) {
      if (nm.contentEditable === "true") return; // already editing → let the click place the caret
      e.stopPropagation();
      var now = Date.now();
      if (now - nmTap < 350) { nmTap = 0; nm.contentEditable = "true"; nm.focus(); if (document.execCommand) document.execCommand("selectAll", false, null); }
      else { nmTap = now; select(node.id); }
    });
    nm.addEventListener("blur", function () { nm.contentEditable = "false"; node.name = nm.textContent.trim() || node.name; nm.textContent = node.name; scheduleSave(); });
    nm.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); nm.blur(); } else if (e.key === "Escape") { nm.textContent = node.name; nm.blur(); } });
    var liveBtn = el("button", { type: "button", class: "gvc-livebtn", text: "▶ Live" });
    var openBtn = el("button", { type: "button", text: "↗", title: "Open in new tab" });
    openBtn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    openBtn.addEventListener("click", function (e) { e.stopPropagation(); window.open(node.url, "_blank"); });
    liveBtn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    liveBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleLive(node, body, liveBtn); });
    // device toggle — desktop / tablet / phone viewport for the live render
    var dev = node.device || "desktop";
    var devSeg = el("div", { class: "gvc-dev" });
    ["desktop", "tablet", "phone"].forEach(function (d) {
      var b = el("button", { type: "button", class: dev === d ? "on" : "", title: d.charAt(0).toUpperCase() + d.slice(1) });
      b.dataset.dev = d; b.innerHTML = DEV_ICON[d];
      b.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      b.addEventListener("click", function (e) { e.stopPropagation(); setDevice(node, d); });
      devSeg.appendChild(b);
    });
    var bar = el("div", { class: "gvc-tilebar" }, [nm, devSeg, liveBtn, openBtn]);
    var host = el("div", { class: "gvc-tile" }, [bar, body]);
    showThumb(node, body);
    place(host, node);
    return host;
  }
  // Pick a device viewport for a tile: shape it to that device's proportions (at its current
  // width — resize stays free), mark the active segment, and reflow the live iframe if open.
  function setDevice(node, d) {
    node.device = d;
    var sz = DEVICE_SIZE[d] || DEVICE_SIZE.desktop;
    node.w = sz.w; node.h = sz.h;
    var host = nodeEls[node.id]; if (!host) return;
    host.style.width = node.w + "px"; host.style.height = node.h + "px";
    host.querySelectorAll(".gvc-dev button").forEach(function (b) { b.classList.toggle("on", b.dataset.dev === d); });
    var body = host.querySelector(".gvc-tilebody");
    if (body && body.querySelector("iframe")) fitFrame(body, node);
    positionSelBar();
    scheduleSave();
  }
  function showThumb(node, body) {
    body.innerHTML = "";
    var img = el("img", { alt: node.name || "" });
    var ph = el("div", { class: "ph", text: "No preview yet — click ▶ Live to load " + node.url });
    img.addEventListener("error", function () { img.remove(); if (!body.contains(ph)) body.appendChild(ph); });
    img.src = node.thumb || (node.url.replace(/\/?$/, "/") + "preview.webp");
    body.appendChild(img);
  }
  // Three tile states: poster (never loaded) → live (interactive iframe) ⇄ frozen (iframe kept but
  // inert). "Stop" FREEZES rather than unloading, so the exact render — device layout, scroll
  // position, in-page state — survives; the frozen iframe is pointer-events:none so the tile drags
  // normally. Loaded iframes (live OR frozen) cost the same, so the cap is on TOTAL loaded, LRU-
  // evicting the oldest back to its poster to keep pan/zoom smooth.
  function toggleLive(node, body, btn) {
    if (body.querySelector("iframe")) {
      var nowFrozen = body.classList.toggle("gvc-frozen");
      var badge = body.querySelector(".live-badge");
      if (nowFrozen) { if (badge) badge.remove(); btn.textContent = "▶ Live"; }
      else { if (!badge) body.appendChild(el("div", { class: "live-badge", text: "LIVE" })); fitFrame(body, node); btn.textContent = "■ Stop"; }
      return;
    }
    while (liveTiles.length >= MAX_LIVE_TILES) {
      var victim = liveTiles.shift(); var vn = nodeById(victim), ve = nodeEls[victim];
      if (vn && ve) { var vb = ve.querySelector(".gvc-tilebody"); vb.classList.remove("gvc-frozen"); showThumb(vn, vb); var vbtn = ve.querySelector(".gvc-livebtn"); if (vbtn) vbtn.textContent = "▶ Live"; }
    }
    body.classList.remove("gvc-frozen");
    body.innerHTML = "";
    body.appendChild(el("iframe", { src: node.url, loading: "lazy" }));
    body.appendChild(el("div", { class: "live-badge", text: "LIVE" }));
    fitFrame(body, node);
    btn.textContent = "■ Stop"; liveTiles.push(node.id);
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
  // Eraser removes WHOLE strokes it touches (the FigJam model), draw nodes only.
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

  // ---- sections (background containers with a name label) ------------------
  function renderSection(node) {
    node.w = node.w || 520; node.h = node.h || 360;
    var host = el("div", { class: "gvc-section" });
    host.appendChild(nameLabel(node));
    place(host, node);
    return host;
  }

  // ---- tables (FigJam-style: plain white cells; + strips on select add row/col)
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

  function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

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
    if (cropState) { commitCrop(); return; } // click outside crop mode = commit (Figma); crop UI handlers stop propagation
    if (!isPan()) {
      // an armed tool takes precedence over node interaction — FigJam draws on top of things
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
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.view.x, oy: board.view.y };
      root.classList.add("panning");
    } else if (nodeHost) {
      var id = nodeHost.dataset.id, node = nodeById(id), now = Date.now();
      if (id === lastTap.id && now - lastTap.t < 350) {
        if (node.type === "sticky" || node.type === "text" || node.type === "shape") {
          lastTap = { id: null, t: 0 }; enterEdit(id); return; // double-tap → edit text, no drag
        }
        if (node.type === "table") {
          var cellEl = e.target.closest && e.target.closest(".gvc-cell");
          if (cellEl) { lastTap = { id: null, t: 0 }; editCell(node, cellEl); return; }
        }
        if (node.type === "image") {
          lastTap = { id: null, t: 0 }; enterCrop(node); return; // double-tap → crop mode
        }
      }
      lastTap = { id: id, t: now };
      if (e.shiftKey) setSelection(isSelected(id) ? selected.filter(function (s) { return s !== id; }) : selected.concat([id]));
      else if (!isSelected(id)) setSelection([id]);
      drag = { mode: "move", sx: e.clientX, sy: e.clientY, moved: false, items: selected.map(function (sid) { var n = nodeById(sid); return { id: sid, arrow: n.type === "arrow", ox: n.x, oy: n.y, ox1: n.x1, oy1: n.y1, ox2: n.x2, oy2: n.y2 }; }) };
    } else if (e.pointerType === "touch") {
      // touch: one finger on empty canvas pans (no mouse to scroll with); two fingers pinch
      setSelection([]);
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.view.x, oy: board.view.y };
    } else {
      // empty drag → marquee selection (Figma/FigJam); panning is Space-drag or scroll/trackpad
      if (!e.shiftKey) setSelection([]);
      drag = { mode: "marquee", sx: e.clientX, sy: e.clientY, base: selected.slice() };
      marquee = el("div", { class: "gvc-marquee" });
      marquee.style.left = e.clientX + "px"; marquee.style.top = e.clientY + "px";
      root.appendChild(marquee);
    }
    root.setPointerCapture(e.pointerId);
  });
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
      var wdx = dx / sc, wdy = dy / sc;
      drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 2;
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
    else if (drag.mode === "resize") { var n2 = drag.node; n2.w = Math.max(48, drag.ow + dx / sc); n2.h = Math.max(48, drag.oh + dy / sc); var re = nodeEls[n2.id]; re.style.width = n2.w + "px"; re.style.height = n2.h + "px"; if (n2.type === "tile") { var rb = re.querySelector(".gvc-tilebody"); if (rb) fitFrame(rb, n2); } positionSelBar(); }
    else if (drag.mode === "arrow") { var an = drag.node; if (drag.end === "1") { an.x1 = drag.px + dx / sc; an.y1 = drag.py + dy / sc; } else { an.x2 = drag.px + dx / sc; an.y2 = drag.py + dy / sc; } renderNode(an); }
  });
  function onPointerEnd(e) {
    delete pointers[e.pointerId];
    if (!drag) return;
    if (drag.mode === "pinch") {
      if (Object.keys(pointers).length < 2) { drag = null; scheduleSave(); }
      return;
    }
    root.classList.remove("panning");
    if (drag.mode === "marquee" && marquee) { marquee.remove(); marquee = null; }
    if (drag.mode === "arrow") renderNode(drag.node);
    if (drag.mode === "resize" && drag.node.type === "stamp") renderNode(drag.node);
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
    drag = null;
    scheduleSave();
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
    var n = addNode({ type: "sticky", x: w.x - 80, y: w.y - 80, w: 160, h: 160, text: "", color: DEFAULT_STICKY, author: ME });
    select(n.id); pop(n.id); setTimeout(function () { enterEdit(n.id); }, 0);
    return n;
  }
  function startResize(e, node) { e.stopPropagation(); drag = { mode: "resize", node: node, sx: e.clientX, sy: e.clientY, ow: node.w, oh: node.h }; root.setPointerCapture(e.pointerId); }
  function startArrowHandle(e, node, end) { e.stopPropagation(); drag = { mode: "arrow", node: node, end: end, sx: e.clientX, sy: e.clientY, px: end === "1" ? node.x1 : node.x2, py: end === "1" ? node.y1 : node.y2 }; root.setPointerCapture(e.pointerId); }

  // ---- image crop (double-tap an image; Figma-style, non-destructive) ------
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
    if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); }
    else { board.view.x -= e.deltaX; board.view.y -= e.deltaY; applyTransform(); scheduleSave(); }
  }, { passive: false });

  // ---- keyboard ------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    if (cropState) { // crop mode owns the keyboard: Enter commits, Esc cancels, everything else is inert
      if (e.key === "Enter") { e.preventDefault(); commitCrop(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelCrop(); }
      return;
    }
    if (e.metaKey && e.key === ".") { e.preventDefault(); ui.classList.toggle("hidden"); return; }
    var ae = document.activeElement, tag = ae ? ae.tagName : "";
    var editing = ae && (ae.isContentEditable || tag === "INPUT" || tag === "TEXTAREA");
    // Hold Space to pan (hand cursor), Figma/FigJam convention; dragging empty space marquee-selects.
    if (e.code === "Space" && !editing && tag !== "BUTTON") { if (!spaceDown) { spaceDown = true; root.classList.add("hand"); } e.preventDefault(); return; }
    if (editing) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelection(); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && selected.length) { e.preventDefault(); selected.slice().forEach(removeNode); setSelection([]); }
    if (e.key === "Escape") { setSelection([]); if (picker) picker.classList.add("hidden"); setTool("select"); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // FigJam tool shortcuts
    var k = e.key.toLowerCase();
    if (e.shiftKey) {
      if (k === "s") setTool("section");
      else if (k === "t") setTool({ kind: "place", type: "table" });
      return;
    }
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

  // ---- image drop from desktop --------------------------------------------
  root.addEventListener("dragover", function (e) { e.preventDefault(); root.classList.add("dropping"); });
  root.addEventListener("dragleave", function (e) { if (e.target === root) root.classList.remove("dropping"); });
  root.addEventListener("drop", function (e) {
    e.preventDefault(); root.classList.remove("dropping");
    var files = e.dataTransfer && e.dataTransfer.files; if (!files || !files.length) return;
    var w = screenToWorld(e.clientX, e.clientY);
    Array.prototype.forEach.call(files, function (f, i) {
      if (!/^image\//.test(f.type)) return;
      compressImage(f, function (dataUrl, dim) { addNode({ type: "image", x: w.x + i * 24, y: w.y + i * 24, w: dim.w, h: dim.h, src: dataUrl }); });
    });
  });
  function compressImage(file, cb) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, IMG_MAX_DIM / Math.max(img.width, img.height));
      var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      var out; try { out = c.toDataURL("image/jpeg", IMG_QUALITY); } catch (err) { out = c.toDataURL(); }
      URL.revokeObjectURL(img.src);
      var dw = Math.min(w, 360), dh = Math.round(dw * h / w);
      cb(out, { w: dw, h: dh });
    };
    img.src = URL.createObjectURL(file);
  }

  // ---- selection toolbar (sticky / shape / draw / table) -------------------
  var selBar, palette, picker, catalog = null;
  function showSelBar(node) {
    selBar.innerHTML = "";
    var dot = el("div", { class: "dot" }); dot.style.background = node.color || (node.type === "draw" ? "#1e1e1e" : node.type === "shape" ? "#ffffff" : DEFAULT_STICKY);
    var sw = el("div", { class: "sw" }, [dot, el("div", { class: "chev", text: "▾" })]);
    guard(sw); sw.addEventListener("click", function (e) { e.stopPropagation(); togglePalette(node, dot); });
    selBar.appendChild(sw);
    if (node.type === "sticky" || node.type === "shape") {
      selBar.appendChild(el("div", { class: "div" }));
      if (node.type === "sticky") {
        var fb = el("div", { class: "btn", title: "Text size", html: '<span style="font-size:15px">A</span>' });
        guard(fb); fb.addEventListener("click", function (e) { e.stopPropagation(); var o = ["s", "m", "l"], i = o.indexOf(node.fontScale || "m"); node.fontScale = o[(i + 1) % 3]; applyNodeStyle(node); scheduleSave(); });
        selBar.appendChild(fb);
      }
      var bb = el("button", { class: "btn" + (node.bold ? " on" : ""), type: "button", text: "B", title: "Bold" }); bb.style.fontWeight = "700";
      guard(bb); bb.addEventListener("click", function (e) { e.stopPropagation(); node.bold = !node.bold; bb.classList.toggle("on", node.bold); applyNodeStyle(node); scheduleSave(); });
      selBar.appendChild(bb);
    }
    selBar.classList.remove("hidden");
    positionSelBar();
  }
  function guard(elm) { elm.addEventListener("pointerdown", function (e) { e.stopPropagation(); }); }
  function applyNodeStyle(node) {
    var host = nodeEls[node.id]; if (!host) return;
    if (node.type === "sticky") {
      host.style.background = node.color || DEFAULT_STICKY;
      var txt = host.querySelector(".gvc-txt");
      if (txt) { txt.style.fontWeight = node.bold ? "700" : ""; txt.style.fontSize = FONT_SIZES[node.fontScale || "m"]; }
    } else renderNode(node); // shapes/draws re-render their svg
  }
  function togglePalette(node, dot) {
    if (!palette.classList.contains("hidden")) { palette.classList.add("hidden"); return; }
    palette.innerHTML = "";
    var colors = node.type === "draw" ? DRAW_COLORS : STICKY_COLORS;
    colors.forEach(function (c) {
      var pc = el("div", { class: "pc" + (c === node.color ? " on" : "") }); pc.style.background = c;
      guard(pc); pc.addEventListener("click", function (e) { e.stopPropagation(); node.color = c; dot.style.background = c; applyNodeStyle(node); scheduleSave(); palette.classList.add("hidden"); });
      palette.appendChild(pc);
    });
    palette.classList.remove("hidden");
    positionSelBar();
  }
  function positionSelBar() {
    if (!selBar || selBar.classList.contains("hidden")) return;
    if (selected.length !== 1) { hideSelBar(); return; }
    var node = nodeById(selected[0]); if (!node) { hideSelBar(); return; }
    var p = worldToScreen(node.x + (node.w || 150) / 2, node.y);
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
  function hideSelBar() { if (selBar) selBar.classList.add("hidden"); if (palette) palette.classList.add("hidden"); }

  // ---- toolbar: icons — Lucide (the shadcn set) wherever one exists --------
  var I_SELECT = '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>'; // mouse-pointer-2
  var I_HAND = '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'; // hand
  var I_TEXT = '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'; // type
  var I_SECTION = '<rect x="3.2" y="3.4" width="13.6" height="13.6" rx="2.2"/><path d="M3.2 7.6h4.2V3.4"/>'; // custom (FigJam section glyph, square — no Lucide equivalent)
  var I_TABLE = '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 9v12"/><path d="M15 9v12"/>'; // table with header row (FigJam-style)
  var I_STAMP = '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"/>'; // stamp
  var I_BUBBLE = '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'; // message-circle
  var I_WIDGETS = '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>'; // shapes
  var I_PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>'; // plus
  var I_IMAGE = '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'; // image
  var I_PROTO = '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>'; // app-window
  var IC_ELBOW = '<path d="m10 9 5-5 5 5"/><path d="M4 20h7a4 4 0 0 0 4-4V4"/>'; // corner-right-up
  var IS_FLOW = '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>'; // network
  var IC_CURVE = '<path d="M5 19C6.2 10.6 11.4 6.3 18.6 7.1"/><path d="m15.2 3.9 3.9 3.1-3.1 3.9"/>'; // custom spline + arrowhead
  var IC_ARROW = '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'; // arrow-up-right
  var IC_LINE = '<path d="M19 5 5 19"/>'; // slash
  // the big illustrated shape cluster: square high-left, curved arrow diving to a heavy circle low-right
  var CLUSTER_ICON = '<svg viewBox="0 0 48 42" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="5" width="20" height="20" rx="1.6"/><path d="M25.5 8.2c3.4-4.4 9.3-5.2 13.9-2.4"/><path d="M38.2 2l1.2 3.8-3.9 1.1"/><circle cx="37" cy="30.5" r="9.6"/></svg>';
  // illustrated tools — measured against FigJam (figjam-refs/7 + the round-6 pixel report):
  // pen = short rounded black nib on a WIDE concave shoulder flaring to full body width by
  // mid-height, seam ~2/3 down, left-lit; sticky = muted-pink 3-sheet stack fanning toward
  // bottom-left, front sheet rotated ~-2.5° with a LARGE top-left corner curl (lighter
  // underside, concave silhouette, crease shadow). Both crop flush at the pill bottom.
  var PEN_ART = '<svg viewBox="0 0 26 44" class="art pen"><defs><linearGradient id="gvpen-b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".42" stop-color="#f3f4f7"/><stop offset=".78" stop-color="#dcdfe4"/><stop offset="1" stop-color="#bfc3cc"/></linearGradient><linearGradient id="gvpen-c" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fafbfc"/><stop offset=".55" stop-color="#e4e6eb"/><stop offset="1" stop-color="#b9bdc7"/></linearGradient></defs><path d="M13 .6c1.8 0 3.1 1.1 3.5 2.7L18 10.5H8l1.5-7.2C9.9 1.7 11.2.6 13 .6z" fill="#1e1f24"/><path d="M13 .6c-1.8 0-3.1 1.1-3.5 2.7L8 10.5h6.4L13.2.7z" fill="#32333a"/><path d="M8 10.5h10c3 3.3 6.5 6 7.5 11.5H.5C1.5 16.5 5 13.8 8 10.5z" fill="url(#gvpen-c)"/><path d="M.5 22h25v22H.5z" fill="url(#gvpen-b)"/><rect x="2.2" y="23.4" width="2.2" height="20.6" fill="#ffffff" opacity=".65"/><rect x=".5" y="26.4" width="25" height=".8" fill="#c9cdd5"/></svg>';
  // blue, not pink — the art matches the DEFAULT_STICKY blue family. Three sheets stacked
  // FigJam's way (Rob's zoomed asset, figjam-refs/10): the FRONT sheet is upright with the
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
  var zoomPct, nameEl;
  var barEls = {}, drawBar, shapeBar, stampBar, moreShapes, plusMenu, colorInput;
  function setTool(t) {
    TOOL = typeof t === "string" ? { kind: t } : t;
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
    var back = el("button", { class: "back", type: "button", html: "&larr; Back" });
    back.addEventListener("click", function () { save(); if (history.length > 1) history.back(); else location.href = BOARD_PATH.replace(/[^/]+\/?$/, ""); });
    var nm = el("div", { class: "nm", contentEditable: "false", title: "Rename canvas", text: board.name });
    nm.addEventListener("click", function () { if (nm.contentEditable !== "true") { nm.contentEditable = "true"; nm.focus(); document.execCommand("selectAll", false, null); } });
    nm.addEventListener("blur", function () { nm.contentEditable = "false"; board.name = nm.textContent.trim() || "Untitled canvas"; nm.textContent = board.name; document.title = board.name; save(); });
    nm.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); nm.blur(); } });
    nameEl = nm;
    ui.appendChild(el("div", { id: "gvc-topbar" }, [back, nm]));

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

    selBar = el("div", { id: "gvc-selbar", class: "hidden" });
    palette = el("div", { id: "gvc-palette", class: "hidden" });
    ui.appendChild(selBar); ui.appendChild(palette);
    buildPicker();
    transformCbs.push(positionSelBar);
    window.addEventListener("resize", positionSelBar);
    syncBars();
  }

  function toolBtn(t, title, svgHtml, key) {
    var b = el("div", { class: "tool" }); b.dataset.t = t;
    b.innerHTML = svgHtml + '<span class="tip">' + title + (key ? '<span class="k">' + key + "</span>" : "") + "</span>";
    return b;
  }

  // bottom-center: the FigJam toolbar. Groups: [select hand] | [marker sticky] | [shapes] | [inserts +]
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
    barEls.bar = bar;
    ui.appendChild(bar);
  }

  // Big sticky press: a real drag rides the classic ghost-out-of-the-bar spawn; a plain
  // click arms the sticky tool (FigJam: the note then follows the cursor until you click).
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
    // FigJam's 12th slot: the flowchart glyph — opens the extended shape tray
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

  // stamp wheel — FigJam's radial picker: 8 stamps on a segmented ring around a hub
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
  function resetView() { board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; applyTransform(); scheduleSave(); }

  // ---- persistence ---------------------------------------------------------
  var saveTimer = null;
  function scheduleSave() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
  function save() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    fetch(BOARD_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: board }) }).catch(function () {});
  }
  window.addEventListener("beforeunload", function () {
    if (!saveTimer) return;
    try { navigator.sendBeacon(BOARD_API, new Blob([JSON.stringify({ doc: board })], { type: "application/json" })); } catch (e) {}
  });
  function load(done) {
    fetch(BOARD_API).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.doc && d.doc.nodes) { board = d.doc; board.view = board.view || { x: 0, y: 0, scale: 1 }; board.name = board.name || CFG.name || "Untitled canvas"; }
      else { board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; }
      done();
    }).catch(function () { board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; done(); });
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

  // ---- boot ----------------------------------------------------------------
  try { fetch("/__me", { headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }).then(function (d) { if (d && d.user && d.user.name) ME = d.user.name; }).catch(function () {}); } catch (e) {}
  document.body.appendChild(root);
  buildUI();
  load(function () {
    document.title = board.name;
    if (nameEl) nameEl.textContent = board.name;
    render();
    applyTransform();
  });
})();
