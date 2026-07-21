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

  var MIN_SCALE = 0.1, MAX_SCALE = 4, GRID = 26, MAX_LIVE_TILES = 6; // total loaded iframes (live or frozen); LRU-evict oldest to poster
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
  var DEFAULT_STICKY = "#fce495";
  var FONT_SIZES = { s: "13px", m: "16px", l: "21px" };
  var ME = ""; // signed-in name, stamped as the sticky author (like FigJam)

  // ---- board state ---------------------------------------------------------
  var board = { v: 1, name: CFG.name || "Untitled canvas", view: { x: 0, y: 0, scale: 1 }, nodes: [] };
  var nodeEls = {};        // id -> DOM element
  var selected = [];       // ids of selected nodes (click, shift-add, or marquee = multi)
  var liveTiles = [];      // ids of tiles currently showing a live iframe (LRU, capped)
  var transformCbs = [];   // listeners notified on every pan/zoom (comments overlay, sel bar)

  function uid() { return "n" + Math.random().toString(36).slice(2, 9); }
  function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }
  // FigJam-style dot grid: dot SIZE is constant (the gradient stop is absolute px), and spacing
  // = GRID*scale is NORMALIZED into a comfortable band by doubling/halving — so it never becomes
  // a dense moire mush when zoomed out or huge gaps when zoomed in. Constant density.
  function gridStep(scale) { var s = GRID * scale; while (s < 22) s *= 2; while (s > 46) s /= 2; return s; }

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
  // Duplicate the current selection, offset diagonally so the copies land NEXT TO the
  // originals (grabbable), not stacked on top; the copies become the new selection so you
  // can immediately drag them. (Cmd/Ctrl-D — the Figma convention.)
  function duplicateSelection() {
    if (!selected.length) return;
    var dx = 32, dy = 32, newIds = [];
    selected.forEach(function (id) {
      var n = nodeById(id); if (!n) return;
      var c = {}; for (var k in n) if (n.hasOwnProperty(k)) c[k] = n[k];
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
      if (n && n.type === "sticky") showSelBar(n); else hideSelBar();
    } else hideSelBar();
  }
  function select(id) { setSelection(id ? [id] : []); }
  var decorEls = [];
  function clearDecor() { decorEls.forEach(function (e) { e.remove(); }); decorEls = []; }
  function decorate(id) {
    clearDecor();
    var node = nodeById(id), host = nodeEls[id];
    if (!node || !host || node.type === "arrow") return;
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
    else return;
    host.className = "gvc-node " + host.className;
    host.dataset.id = node.id;
    nodeEls[node.id] = host;
    world.appendChild(host);
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
    // Build the SVG as an innerHTML string so the HTML parser creates real SVG-namespaced nodes
    // — createElement("svg") makes a non-namespaced element that never paints.
    host.innerHTML = '<svg width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '" style="overflow:visible">'
      + '<path d="M' + lx1 + " " + ly1 + " L" + lx2 + " " + ly2 + '"/>'
      + '<path d="M' + a1x + " " + a1y + " L" + lx2 + " " + ly2 + " L" + a2x + " " + a2y + '"/></svg>';
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
  function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // ---- pointer interaction (pan / move / resize / arrow handles) -----------
  var drag = null, lastTap = { id: null, t: 0 }, panLock = false, spaceDown = false, marquee = null;
  root.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest("#gvc-ui")) return;
    var pan = spaceDown || panLock;
    var nodeHost = (!pan && e.target.closest) ? e.target.closest(".gvc-node") : null;
    if (nodeHost && nodeHost.classList.contains("editing")) return;
    if (pan) {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, ox: board.view.x, oy: board.view.y };
      root.classList.add("panning");
    } else if (nodeHost) {
      var id = nodeHost.dataset.id, node = nodeById(id), now = Date.now();
      if (id === lastTap.id && now - lastTap.t < 350 && (node.type === "sticky" || node.type === "text")) {
        lastTap = { id: null, t: 0 }; enterEdit(id); return; // double-tap → edit text, no drag
      }
      lastTap = { id: id, t: now };
      if (e.shiftKey) setSelection(isSelected(id) ? selected.filter(function (s) { return s !== id; }) : selected.concat([id]));
      else if (!isSelected(id)) setSelection([id]);
      drag = { mode: "move", sx: e.clientX, sy: e.clientY, moved: false, items: selected.map(function (sid) { var n = nodeById(sid); return { id: sid, arrow: n.type === "arrow", ox: n.x, oy: n.y, ox1: n.x1, oy1: n.y1, ox2: n.x2, oy2: n.y2 }; }) };
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
    if (!drag) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, sc = board.view.scale;
    if (drag.mode === "pan") { board.view.x = drag.ox + dx; board.view.y = drag.oy + dy; applyTransform(); }
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
      var l = Math.min(drag.sx, e.clientX), t = Math.min(drag.sy, e.clientY), w = Math.abs(dx), h = Math.abs(dy);
      marquee.style.left = l + "px"; marquee.style.top = t + "px"; marquee.style.width = w + "px"; marquee.style.height = h + "px";
      var hits = drag.base.slice();
      board.nodes.forEach(function (n) {
        var en = nodeEls[n.id]; if (!en) return;
        var r = en.getBoundingClientRect();
        if (r.right >= l && r.left <= l + w && r.bottom >= t && r.top <= t + h && hits.indexOf(n.id) < 0) hits.push(n.id);
      });
      setSelection(hits);
    }
    else if (drag.mode === "resize") { var n2 = drag.node; n2.w = Math.max(48, drag.ow + dx / sc); n2.h = Math.max(48, drag.oh + dy / sc); var re = nodeEls[n2.id]; re.style.width = n2.w + "px"; re.style.height = n2.h + "px"; if (n2.type === "tile") { var rb = re.querySelector(".gvc-tilebody"); if (rb) fitFrame(rb, n2); } positionSelBar(); }
    else if (drag.mode === "arrow") { var an = drag.node; if (drag.end === "1") { an.x1 = drag.px + dx / sc; an.y1 = drag.py + dy / sc; } else { an.x2 = drag.px + dx / sc; an.y2 = drag.py + dy / sc; } renderNode(an); }
  });
  root.addEventListener("pointerup", function () {
    if (!drag) return;
    root.classList.remove("panning");
    if (drag.mode === "marquee" && marquee) { marquee.remove(); marquee = null; }
    if (drag.mode === "arrow") renderNode(drag.node);
    drag = null;
    scheduleSave();
  });
  function startResize(e, node) { e.stopPropagation(); drag = { mode: "resize", node: node, sx: e.clientX, sy: e.clientY, ow: node.w, oh: node.h }; root.setPointerCapture(e.pointerId); }
  function startArrowHandle(e, node, end) { e.stopPropagation(); drag = { mode: "arrow", node: node, end: end, sx: e.clientX, sy: e.clientY, px: end === "1" ? node.x1 : node.x2, py: end === "1" ? node.y1 : node.y2 }; root.setPointerCapture(e.pointerId); }

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
    if (e.metaKey && e.key === ".") { e.preventDefault(); ui.classList.toggle("hidden"); return; }
    var ae = document.activeElement, tag = ae ? ae.tagName : "";
    var editing = ae && (ae.isContentEditable || tag === "INPUT" || tag === "TEXTAREA");
    // Hold Space to pan (hand cursor), Figma/FigJam convention; dragging empty space marquee-selects.
    if (e.code === "Space" && !editing && tag !== "BUTTON") { if (!spaceDown) { spaceDown = true; root.classList.add("hand"); } e.preventDefault(); return; }
    if (editing) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelection(); return; }
    if ((e.key === "Backspace" || e.key === "Delete") && selected.length) { e.preventDefault(); selected.slice().forEach(removeNode); setSelection([]); }
    if (e.key === "Escape") { setSelection([]); if (picker) picker.classList.add("hidden"); }
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "Space") { spaceDown = false; if (!panLock) root.classList.remove("hand"); }
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

  // ---- sticky selection toolbar + color palette ---------------------------
  var selBar, palette, picker, catalog = null;
  function showSelBar(node) {
    selBar.innerHTML = "";
    var dot = el("div", { class: "dot" }); dot.style.background = node.color || DEFAULT_STICKY;
    var sw = el("div", { class: "sw" }, [dot, el("div", { class: "chev", text: "▾" })]);
    guard(sw); sw.addEventListener("click", function (e) { e.stopPropagation(); togglePalette(node, dot); });
    var fb = el("div", { class: "btn", title: "Text size", html: '<span style="font-size:15px">A</span>' });
    guard(fb); fb.addEventListener("click", function (e) { e.stopPropagation(); var o = ["s", "m", "l"], i = o.indexOf(node.fontScale || "m"); node.fontScale = o[(i + 1) % 3]; applyStickyStyle(node); scheduleSave(); });
    var bb = el("button", { class: "btn" + (node.bold ? " on" : ""), type: "button", text: "B", title: "Bold" }); bb.style.fontWeight = "700";
    guard(bb); bb.addEventListener("click", function (e) { e.stopPropagation(); node.bold = !node.bold; bb.classList.toggle("on", node.bold); applyStickyStyle(node); scheduleSave(); });
    selBar.appendChild(sw); selBar.appendChild(el("div", { class: "div" })); selBar.appendChild(fb); selBar.appendChild(bb);
    selBar.classList.remove("hidden");
    positionSelBar();
  }
  function guard(elm) { elm.addEventListener("pointerdown", function (e) { e.stopPropagation(); }); }
  function applyStickyStyle(node) {
    var host = nodeEls[node.id]; if (!host) return;
    host.style.background = node.color || DEFAULT_STICKY;
    var txt = host.querySelector(".gvc-txt");
    if (txt) { txt.style.fontWeight = node.bold ? "700" : ""; txt.style.fontSize = FONT_SIZES[node.fontScale || "m"]; }
  }
  function togglePalette(node, dot) {
    if (!palette.classList.contains("hidden")) { palette.classList.add("hidden"); return; }
    palette.innerHTML = "";
    STICKY_COLORS.forEach(function (c) {
      var pc = el("div", { class: "pc" + (c === node.color ? " on" : "") }); pc.style.background = c;
      guard(pc); pc.addEventListener("click", function (e) { e.stopPropagation(); node.color = c; dot.style.background = c; applyStickyStyle(node); scheduleSave(); palette.classList.add("hidden"); });
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

  // ---- UI: toolbar + top bar + zoom ---------------------------------------
  var zoomPct, nameEl;
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

    // bottom-center: FigJam-style toolbar
    var bar = el("div", { id: "gvc-toolbar" });
    var cursor = toolBtn("cursor", "Select", svgIcon('<path fill="currentColor" stroke="none" d="M5 3.1l10.4 6.2-4.5.9 2.5 4.6-1.9 1-2.5-4.6-3.5 3z"/>'));
    var hand = toolBtn("hand", "Hand (pan)", svgIcon('<path d="M7 11V6.2a1.1 1.1 0 0 1 2.2 0V10m0-4.2a1.1 1.1 0 0 1 2.2 0V10m0-3.2a1.1 1.1 0 0 1 2.2 0V11c0 3-1.8 4.8-4.6 4.8-1.7 0-2.6-.6-3.6-1.9L6 12.1c-.5-.7.4-1.6 1.2-1.1z"/>'));
    cursor.classList.add("on");
    cursor.addEventListener("click", function () { panLock = false; cursor.classList.add("on"); hand.classList.remove("on"); root.classList.remove("hand"); });
    hand.addEventListener("click", function () { panLock = true; hand.classList.add("on"); cursor.classList.remove("on"); root.classList.add("hand"); });
    bar.appendChild(cursor); bar.appendChild(hand); bar.appendChild(el("div", { class: "sep" }));

    var TOOLS = [
      { t: "sticky", title: "Sticky note", svg: '<path d="M4 4h11v7l-4 4H4z" fill="#fce495" stroke="#dfbe57"/><path d="M15 11h-4v4" fill="none" stroke="#dfbe57"/>' },
      { t: "text", title: "Text", svg: '<path d="M4 5h12"/><path d="M10 5v11"/>' },
      { t: "arrow", title: "Arrow", svg: '<path d="M4 16 15 5"/><path d="M9.5 5H15v5.5"/>' },
      { t: "image", title: "Image", svg: '<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.4" cy="9" r="1.3"/><path d="M4 14l3.6-3.4 3 3 3-3L17 14"/>' },
      { t: "tile", title: "Prototype", svg: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 7.5h14"/>' }
    ];
    TOOLS.forEach(function (tool, i) {
      if (i === 3) bar.appendChild(el("div", { class: "sep" }));
      var b = toolBtn(tool.t, tool.title, svgIcon(tool.svg));
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); startToolDrag(e, tool.t, b); });
      bar.appendChild(b);
    });
    ui.appendChild(bar);

    selBar = el("div", { id: "gvc-selbar", class: "hidden" });
    palette = el("div", { id: "gvc-palette", class: "hidden" });
    ui.appendChild(selBar); ui.appendChild(palette);
    buildPicker();
    transformCbs.push(positionSelBar);
    window.addEventListener("resize", positionSelBar);
  }
  function toolBtn(t, title, svgHtml) {
    var b = el("div", { class: "tool" }); b.dataset.t = t;
    b.innerHTML = svgHtml + '<span class="tip">' + title + "</span>";
    return b;
  }

  function startToolDrag(e, type, chip) {
    if (type === "image") { pickImage(centerWorld()); return; }
    if (type === "tile") { openPicker(); return; }
    var ghost;
    if (type === "sticky") { ghost = el("div", { class: "gvc-ghost gvc-ghost-sticky" }); }
    else { ghost = el("div", { class: "gvc-ghost" }); ghost.appendChild(chip.cloneNode(true)); }
    ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px";
    document.body.appendChild(ghost);
    if (type === "sticky") requestAnimationFrame(function () { ghost.classList.add("in"); });
    function move(ev) { ghost.style.left = ev.clientX + "px"; ghost.style.top = ev.clientY + "px"; }
    function up(ev) {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); ghost.remove();
      if (ev.target.closest && ev.target.closest("#gvc-ui")) return;
      spawn(type, screenToWorld(ev.clientX, ev.clientY));
    }
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  function spawn(type, w) {
    if (type === "sticky") { var n = addNode({ type: "sticky", x: w.x - 80, y: w.y - 80, w: 160, h: 160, text: "", color: DEFAULT_STICKY, author: ME }); select(n.id); pop(n.id); setTimeout(function () { enterEdit(n.id); }, 0); }
    else if (type === "text") { var t = addNode({ type: "text", x: w.x, y: w.y, text: "" }); select(t.id); setTimeout(function () { enterEdit(t.id); }, 0); }
    else if (type === "arrow") { var a = addNode({ type: "arrow", x1: w.x - 60, y1: w.y, x2: w.x + 60, y2: w.y }); select(a.id); }
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
    nodes: function () { return board.nodes; }, addNode: addNode
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
