/* Augur Canvas — hand-rolled infinite-canvas engine. Served from /__canvas/canvas.js.
 *
 * A "canvas" is a prototype whose index.html mounts this engine. The board (nodes + view +
 * name) is one JSON document persisted to KV via /__board, keyed by the page URL — the same
 * per-URL rail comments use, so it isolates per-space for free.
 *
 * Model: one #gvc-world layer with a single CSS transform (translate + scale); nodes are
 * absolutely positioned in WORLD coordinates inside it; the UI (#gvc-ui) is a fixed layer
 * above, untransformed. Everything is DOM — no WebGL — which is plenty at this scale.
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

  var MIN_SCALE = 0.1, MAX_SCALE = 4, GRID = 26, MAX_LIVE_TILES = 1;
  var IMG_MAX_DIM = 1400, IMG_QUALITY = 0.55; // aggressive: size over quality (Rob's call)

  // ---- board state ---------------------------------------------------------
  var board = { v: 1, name: CFG.name || "Untitled canvas", view: { x: 0, y: 0, scale: 1 }, nodes: [] };
  var nodeEls = {};        // id -> DOM element
  var selected = null;     // single-selection id (v1)
  var liveTiles = [];      // ids of tiles currently showing a live iframe (LRU, capped)
  var transformCbs = [];   // listeners notified on every pan/zoom (comments overlay, etc.)

  function uid() { return "n" + Math.random().toString(36).slice(2, 9); }
  function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }

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
      root.style.backgroundSize = (GRID * v.scale) + "px " + (GRID * v.scale) + "px";
      root.style.backgroundPosition = v.x + "px " + v.y + "px";
      if (zoomPct) zoomPct.textContent = Math.round(v.scale * 100) + "%";
      // comments.js repositions pins on window scroll; a canvas pan/zoom IS a scroll of the
      // world, so tell it. Board-anchored comment threads read GVCanvas.worldToScreen (see
      // the canvas hook in comments.js), so this keeps their pins glued to the board.
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
    var base = { sticky: "Sticky", text: "Text", image: "Image", tile: "Prototype", arrow: "Arrow" }[type] || "Node";
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
  function removeNode(id) {
    var i = board.nodes.findIndex(function (n) { return n.id === id; });
    if (i < 0) return;
    board.nodes.splice(i, 1);
    if (nodeEls[id]) { nodeEls[id].remove(); delete nodeEls[id]; }
    liveTiles = liveTiles.filter(function (t) { return t !== id; });
    if (selected === id) selected = null;
    scheduleSave();
  }

  // ---- selection -----------------------------------------------------------
  function select(id) {
    if (selected && nodeEls[selected]) nodeEls[selected].classList.remove("sel");
    selected = id;
    if (id && nodeEls[id]) { nodeEls[id].classList.add("sel"); decorate(id); }
    else clearDecor();
  }
  var decorEls = [];
  function clearDecor() { decorEls.forEach(function (e) { e.remove(); }); decorEls = []; }
  function decorate(id) {
    clearDecor();
    var node = nodeById(id), host = nodeEls[id];
    if (!node || !host) return;
    if (node.type === "arrow") return; // arrows carry their own endpoint handles
    var rz = el("div", { class: "gvc-resize" });
    rz.addEventListener("pointerdown", function (e) { startResize(e, node); });
    host.appendChild(rz); decorEls.push(rz);
  }

  // ---- render --------------------------------------------------------------
  function render() {
    Object.keys(nodeEls).forEach(function (id) { nodeEls[id].remove(); });
    nodeEls = {};
    board.nodes.forEach(renderNode);
    if (selected) select(selected);
  }
  function place(host, node) {
    host.style.left = node.x + "px"; host.style.top = node.y + "px";
    if (node.w != null) host.style.width = node.w + "px";
    if (node.h != null) host.style.height = node.h + "px";
  }
  function nameLabel(node) {
    var lbl = el("div", { class: "gvc-name", text: node.name || "" });
    lbl.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      var v = prompt("Name this " + node.type, node.name || "");
      if (v != null) { node.name = v.trim(); lbl.textContent = node.name; scheduleSave(); }
    });
    return lbl;
  }

  function renderNode(node) {
    var old = nodeEls[node.id]; if (old) old.remove();
    var host;
    if (node.type === "sticky") host = renderSticky(node);
    else if (node.type === "text") host = renderText(node);
    else if (node.type === "image") host = renderImage(node);
    else if (node.type === "tile") host = renderTile(node);
    else if (node.type === "arrow") host = renderArrow(node);
    else return;
    host.className = "gvc-node " + host.className;
    host.dataset.id = node.id;
    nodeEls[node.id] = host;
    world.appendChild(host);
    if (node.id === selected) { host.classList.add("sel"); decorate(node.id); }
    return host;
  }

  function editableText(node, host, cls) {
    var txt = el("div", { class: "gvc-txt " + cls, contentEditable: "false", html: escapeHtml(node.text || "") });
    host.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      host.classList.add("editing"); txt.contentEditable = "true"; txt.focus();
      var r = document.createRange(); r.selectNodeContents(txt); var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    txt.addEventListener("blur", function () {
      host.classList.remove("editing"); txt.contentEditable = "false";
      node.text = txt.innerText;
      if (node.type !== "image" && node.type !== "tile") node.name = (node.text || "").split("\n")[0].slice(0, 60) || autoName(node.type);
      scheduleSave();
    });
    // while editing, keep keystrokes/spaces local (don't pan / delete node)
    txt.addEventListener("pointerdown", function (e) { if (host.classList.contains("editing")) e.stopPropagation(); });
    txt.addEventListener("keydown", function (e) { e.stopPropagation(); });
    return txt;
  }

  function renderSticky(node) {
    node.w = node.w || 150; node.h = node.h || 150;
    var host = el("div", { class: "gvc-sticky" });
    host.style.background = node.color || "#fef3c7";
    host.appendChild(editableText(node, host, ""));
    place(host, node);
    return host;
  }
  function renderText(node) {
    var host = el("div", { class: "gvc-text" });
    host.appendChild(editableText(node, host, ""));
    host.style.left = node.x + "px"; host.style.top = node.y + "px";
    return host;
  }
  function renderImage(node) {
    node.w = node.w || 240; node.h = node.h || 180;
    var host = el("div", { class: "gvc-image" }, [el("img", { src: node.src, alt: node.name || "" })]);
    place(host, node);
    return host;
  }
  function renderTile(node) {
    node.w = node.w || 420; node.h = node.h || 300;
    var body = el("div", { class: "gvc-tilebody" });
    var nm = el("div", { class: "nm", text: node.name || node.url, contentEditable: "false", title: node.url });
    nm.addEventListener("dblclick", function (e) { e.stopPropagation(); nm.contentEditable = "true"; nm.focus(); });
    nm.addEventListener("blur", function () { nm.contentEditable = "false"; node.name = nm.textContent.trim() || node.name; scheduleSave(); });
    nm.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); nm.blur(); } });
    var liveBtn = el("button", { type: "button", text: "▶ Live" });
    var openBtn = el("button", { type: "button", text: "↗", title: "Open in new tab" });
    openBtn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    openBtn.addEventListener("click", function (e) { e.stopPropagation(); window.open(node.url, "_blank"); });
    liveBtn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    liveBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleLive(node, body, liveBtn); });
    var bar = el("div", { class: "gvc-tilebar" }, [nm, liveBtn, openBtn]);
    var host = el("div", { class: "gvc-tile" }, [bar, body]);
    showThumb(node, body);
    place(host, node);
    return host;
  }
  function showThumb(node, body) {
    body.innerHTML = "";
    var img = el("img", { alt: node.name || "" });
    var ph = el("div", { class: "ph", text: "No preview yet — click ▶ Live to load " + node.url });
    img.addEventListener("error", function () { img.remove(); if (!body.contains(ph)) body.appendChild(ph); });
    img.src = node.thumb || (node.url.replace(/\/?$/, "/") + "preview.webp");
    body.appendChild(img);
  }
  function toggleLive(node, body, btn) {
    if (body.querySelector("iframe")) { showThumb(node, body); btn.textContent = "▶ Live"; liveTiles = liveTiles.filter(function (t) { return t !== node.id; }); return; }
    // enforce the live cap — swap the oldest live tile back to a thumbnail
    while (liveTiles.length >= MAX_LIVE_TILES) {
      var victim = liveTiles.shift(); var vn = nodeById(victim), ve = nodeEls[victim];
      if (vn && ve) { var vb = ve.querySelector(".gvc-tilebody"); showThumb(vn, vb); var vbtn = ve.querySelector(".gvc-tilebar button"); if (vbtn) vbtn.textContent = "▶ Live"; }
    }
    body.innerHTML = "";
    body.appendChild(el("iframe", { src: node.url, loading: "lazy" }));
    body.appendChild(el("div", { class: "live-badge", text: "LIVE" }));
    btn.textContent = "■ Stop"; liveTiles.push(node.id);
  }
  function renderArrow(node) {
    var x1 = node.x1, y1 = node.y1, x2 = node.x2, y2 = node.y2;
    var minX = Math.min(x1, x2), minY = Math.min(y1, y2), w = Math.max(1, Math.abs(x2 - x1)), h = Math.max(1, Math.abs(y2 - y1));
    var pad = 8;
    var host = el("div", { class: "gvc-arrow" });
    host.style.left = (minX - pad) + "px"; host.style.top = (minY - pad) + "px"; host.style.width = (w + pad * 2) + "px"; host.style.height = (h + pad * 2) + "px";
    var lx1 = x1 - minX + pad, ly1 = y1 - minY + pad, lx2 = x2 - minX + pad, ly2 = y2 - minY + pad;
    var ang = Math.atan2(ly2 - ly1, lx2 - lx1), ah = 11;
    var a1x = lx2 - ah * Math.cos(ang - Math.PI / 7), a1y = ly2 - ah * Math.sin(ang - Math.PI / 7);
    var a2x = lx2 - ah * Math.cos(ang + Math.PI / 7), a2y = ly2 - ah * Math.sin(ang + Math.PI / 7);
    var svg = el("svg", { width: w + pad * 2, height: h + pad * 2 });
    svg.innerHTML = '<path d="M' + lx1 + ' ' + ly1 + ' L' + lx2 + ' ' + ly2 + '"/><path d="M' + a1x + ' ' + a1y + ' L' + lx2 + ' ' + ly2 + ' L' + a2x + ' ' + a2y + '"/>';
    host.appendChild(svg);
    // endpoint handles (shown when selected)
    if (node.id === selected) {
      [["1", lx1, ly1], ["2", lx2, ly2]].forEach(function (p) {
        var hd = el("div", { class: "gvc-handle" });
        hd.style.left = p[1] + "px"; hd.style.top = p[2] + "px";
        hd.addEventListener("pointerdown", function (e) { startArrowHandle(e, node, p[0]); });
        host.appendChild(hd);
      });
    }
    return host;
  }

  function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // ---- pointer interaction (pan / move / resize / arrow handles) -----------
  var drag = null;
  root.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    var nodeHost = e.target.closest ? e.target.closest(".gvc-node") : null;
    // ignore clicks that land on the fixed UI layer
    if (e.target.closest && e.target.closest("#gvc-ui")) return;
    if (nodeHost && nodeHost.classList.contains("editing")) return;
    if (nodeHost) {
      var id = nodeHost.dataset.id, node = nodeById(id);
      select(id);
      drag = { mode: "move", id: id, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, ox1: node.x1, oy1: node.y1, ox2: node.x2, oy2: node.y2, moved: false };
    } else {
      select(null);
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.view.x, oy: board.view.y };
      root.classList.add("panning");
    }
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (drag.mode === "pan") { board.view.x = drag.ox + dx; board.view.y = drag.oy + dy; applyTransform(); }
    else if (drag.mode === "move") {
      var node = nodeById(drag.id); if (!node) return;
      var wdx = dx / board.view.scale, wdy = dy / board.view.scale;
      drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 2;
      if (node.type === "arrow") { node.x1 = drag.ox1 + wdx; node.y1 = drag.oy1 + wdy; node.x2 = drag.ox2 + wdx; node.y2 = drag.oy2 + wdy; renderNode(node); }
      else { node.x = drag.ox + wdx; node.y = drag.oy + wdy; var h = nodeEls[drag.id]; h.style.left = node.x + "px"; h.style.top = node.y + "px"; }
    }
    else if (drag.mode === "resize") { var n = drag.node; n.w = Math.max(40, drag.ow + dx / board.view.scale); n.h = Math.max(40, drag.oh + dy / board.view.scale); var hh = nodeEls[n.id]; hh.style.width = n.w + "px"; hh.style.height = n.h + "px"; }
    else if (drag.mode === "arrow") { var an = drag.node; if (drag.end === "1") { an.x1 = drag.px + dx / board.view.scale; an.y1 = drag.py + dy / board.view.scale; } else { an.x2 = drag.px + dx / board.view.scale; an.y2 = drag.py + dy / board.view.scale; } renderNode(an); }
  });
  root.addEventListener("pointerup", function (e) {
    if (!drag) return;
    root.classList.remove("panning");
    if (drag.mode === "move" && !drag.moved) { /* a click, not a drag */ }
    if (drag.mode === "arrow") renderNode(drag.node); // re-attach handles
    drag = null;
    scheduleSave();
  });
  function startResize(e, node) { e.stopPropagation(); drag = { mode: "resize", node: node, sx: e.clientX, sy: e.clientY, ow: node.w, oh: node.h }; root.setPointerCapture(e.pointerId); }
  function startArrowHandle(e, node, end) { e.stopPropagation(); drag = { mode: "arrow", node: node, end: end, sx: e.clientX, sy: e.clientY, px: end === "1" ? node.x1 : node.x2, py: end === "1" ? node.y1 : node.y2 }; root.setPointerCapture(e.pointerId); }

  // ---- wheel zoom / trackpad pan ------------------------------------------
  root.addEventListener("wheel", function (e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); }
    else { board.view.x -= e.deltaX; board.view.y -= e.deltaY; applyTransform(); scheduleSave(); }
  }, { passive: false });

  // ---- keyboard ------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    if (e.metaKey && e.key === ".") { e.preventDefault(); ui.classList.toggle("hidden"); return; }
    var editing = document.activeElement && (document.activeElement.isContentEditable || /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
    if (editing) return;
    if ((e.key === "Backspace" || e.key === "Delete") && selected) { e.preventDefault(); removeNode(selected); select(null); }
    if (e.key === "Escape") select(null);
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
      compressImage(f, function (dataUrl, dim) {
        addNode({ type: "image", x: w.x + i * 24, y: w.y + i * 24, w: dim.w, h: dim.h, src: dataUrl });
      });
    });
  });
  function compressImage(file, cb) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, IMG_MAX_DIM / Math.max(img.width, img.height));
      var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      var out;
      try { out = c.toDataURL("image/jpeg", IMG_QUALITY); } catch (err) { out = c.toDataURL(); }
      URL.revokeObjectURL(img.src);
      // display size capped so a huge photo doesn't dominate the board
      var dw = Math.min(w, 360), dh = Math.round(dw * h / w);
      cb(out, { w: dw, h: dh });
    };
    img.src = URL.createObjectURL(file);
  }

  // ---- UI: toolbar + top bar + zoom ---------------------------------------
  var zoomPct;
  function buildUI() {
    // top-right: back + rename
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

    // bottom-center: FigJam toolbar (drag out, or click to drop at center)
    var tools = [
      { t: "sticky", ic: "▧", lb: "Sticky" },
      { t: "text", ic: "T", lb: "Text" },
      { t: "arrow", ic: "↗", lb: "Arrow" },
      { t: "image", ic: "▣", lb: "Image" },
      { t: "tile", ic: "❐", lb: "Prototype" }
    ];
    var bar = el("div", { id: "gvc-toolbar" });
    tools.forEach(function (tool, i) {
      if (i === 3) bar.appendChild(el("div", { class: "sep" }));
      var chip = el("div", { class: "tool" }, [el("div", { class: "ic", text: tool.ic }), el("div", { text: tool.lb })]);
      chip.addEventListener("pointerdown", function (e) { e.preventDefault(); startToolDrag(e, tool.t, chip); });
      bar.appendChild(chip);
    });
    ui.appendChild(bar);
  }
  var nameEl;

  function startToolDrag(e, type, chip) {
    // image/tile open a picker instead of dragging a body around
    if (type === "image") { pickImage(centerWorld()); return; }
    if (type === "tile") { addPrototypeTile(centerWorld()); return; }
    var ghost = el("div", { class: "gvc-ghost" });
    ghost.appendChild(chip.cloneNode(true)); ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px";
    document.body.appendChild(ghost);
    function move(ev) { ghost.style.left = ev.clientX + "px"; ghost.style.top = ev.clientY + "px"; }
    function up(ev) {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); ghost.remove();
      var overUI = ev.target.closest && ev.target.closest("#gvc-ui");
      if (overUI) return;
      var w = screenToWorld(ev.clientX, ev.clientY);
      spawn(type, w);
    }
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  function spawn(type, w) {
    if (type === "sticky") { var n = addNode({ type: "sticky", x: w.x - 75, y: w.y - 75, w: 150, h: 150, text: "", color: "#fef3c7" }); select(n.id); editNow(n.id); }
    else if (type === "text") { var t = addNode({ type: "text", x: w.x, y: w.y, text: "Text" }); select(t.id); editNow(t.id); }
    else if (type === "arrow") { addNode({ type: "arrow", x1: w.x - 60, y1: w.y, x2: w.x + 60, y2: w.y }); }
  }
  function editNow(id) { var h = nodeEls[id]; if (h) { var d = new MouseEvent("dblclick", { bubbles: true }); h.dispatchEvent(d); } }
  function centerWorld() { return screenToWorld(innerWidth / 2, innerHeight / 2); }
  function pickImage(w) {
    var inp = el("input", { type: "file", accept: "image/*", multiple: true });
    inp.style.display = "none"; document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      Array.prototype.forEach.call(inp.files, function (f, i) { if (/^image\//.test(f.type)) compressImage(f, function (u, d) { addNode({ type: "image", x: w.x + i * 24, y: w.y + i * 24, w: d.w, h: d.h, src: u }); }); });
      inp.remove();
    });
    inp.click();
  }
  function addPrototypeTile(w) {
    var url = prompt("Prototype URL or path to embed (e.g. /ux-ui-audit/status/ )", "");
    if (!url) return; url = url.trim();
    if (!/^https?:/.test(url) && url[0] !== "/") url = "/" + url;
    addNode({ type: "tile", x: w.x - 210, y: w.y - 150, w: 420, h: 300, url: url });
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
      if (d && d.doc && d.doc.nodes) {
        board = d.doc;
        board.view = board.view || { x: 0, y: 0, scale: 1 };
        board.name = board.name || CFG.name || "Untitled canvas";
      } else {
        board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; // new board: origin mid-screen
      }
      done();
    }).catch(function () { board.view = { x: innerWidth / 2, y: innerHeight / 2, scale: 1 }; done(); });
  }

  // ---- public API for the comment overlay + tools --------------------------
  window.GVCanvas = {
    get board() { return board; },
    get view() { return board.view; },
    screenToWorld: screenToWorld,
    worldToScreen: worldToScreen,
    world: world,
    onTransform: function (cb) { transformCbs.push(cb); },
    nodes: function () { return board.nodes; },
    addNode: addNode
  };

  // ---- boot ----------------------------------------------------------------
  document.body.appendChild(root);
  buildUI();
  load(function () {
    document.title = board.name;
    if (nameEl) nameEl.textContent = board.name;
    render();
    applyTransform();
  });
})();
