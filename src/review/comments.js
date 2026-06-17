/*
 * GoVocal prototype review overlay.
 *
 * Injected into every prototype's HTML by build.js (as
 * `<script src="/__review/comments.js" defer>`), DORMANT until activated.
 *
 *   Shift+C  → toggle review mode. Turning it ON drops you straight into
 *              "placing" mode: click anywhere to attach a comment.
 *   Esc      → placing → browse (interact with the prototype, drag pins);
 *              then close an open thread; then turn review off.
 *
 * Pins are anchored to the element you click (CSS selector + offset) and to the
 * screen/URL they were made on. A collapsible right sidebar lists every comment;
 * clicking one opens it in place, navigating to its screen first if needed.
 *
 * Lifecycle: a comment lives as long as its anchor element exists. If you're on
 * the screen it was made on and that element is gone (removed by dev work), the
 * comment auto-deletes. On a different screen it's just hidden from the canvas
 * but stays listed (and navigable) in the sidebar.
 *
 * Annotations: open a thread and hit the cat toggle to promote it to an
 * ANNOTATION — a delivery note for devs. Annotations (1) render even with review
 * mode OFF, as the cat avatar instead of a numbered pin (hover/tap shows the
 * note); (2) are exempt from the orphan auto-delete; (3) are skipped by the
 * resolve-comments tooling (scripts/review.mjs). It's the inverse of a comment:
 * comments are transient feedback, annotations are persistent always-on spec.
 *
 * Shared via the worker's KV API (/__review/api); falls back to localStorage if
 * the API is unreachable. Completely inert inside the index-page preview iframes.
 */
(function () {
  "use strict";

  if (window.top !== window.self) return;        // never run in preview iframes
  if (window.__gvReview) return;
  window.__gvReview = true;

  var API = "/__review/api";
  var PATH = location.pathname;
  var LS_THREADS = "gv-review:" + PATH;
  var LS_NAME = "gv-review-name";
  var LS_ACTIVE = "gv-review-active";
  var LS_SB = "gv-review-sb-collapsed";
  var SS_PENDING = "gv-review-pending-open";

  // Annotations = comments promoted to always-on dev-delivery notes. They render
  // even when review mode is off, are skipped by the resolve-comments tooling, and
  // show as this avatar instead of a numbered pin. Data URI so the script stays
  // self-contained (no asset to copy into each prototype).
  var CAT = "data:image/webp;base64,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";

  var state = { threads: [], active: false, mode: "add", openId: null };
  var deleted = {};       // ids we've already issued a delete for
  var settled = false;    // becomes true after load grace period

  /* ---------- storage ---------- */

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_THREADS) || "[]"); }
    catch (e) { return []; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_THREADS, JSON.stringify(state.threads)); } catch (e) {}
  }
  async function apiCall(method, body) {
    var res = await fetch(API + "?path=" + encodeURIComponent(PATH), {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("api " + res.status);
    return res.json();
  }
  async function refresh() {
    try {
      var data = await apiCall("GET");
      state.threads = (data && data.threads) || [];
      saveLocal();
    } catch (e) {
      state.threads = loadLocal();
    }
    render();
    tryOpenPending();
  }
  async function mutate(op) {
    try {
      var data = await apiCall("POST", op);
      state.threads = (data && data.threads) || [];
      saveLocal();
    } catch (e) {
      applyLocal(op); saveLocal();
    }
    render();
  }
  function applyLocal(op) {
    var t;
    if (op.op === "add") state.threads.push(op.thread);
    else if (op.op === "reply") { t = find(op.id); if (t) t.messages.push(op.message); }
    else if (op.op === "resolve") { t = find(op.id); if (t) t.resolved = op.resolved; }
    else if (op.op === "move") {
      t = find(op.id);
      if (t) { t.sel = op.sel; t.fx = op.fx; t.fy = op.fy; t.px = op.px; t.py = op.py; t.view = op.view; }
    } else if (op.op === "annotate") { t = find(op.id); if (t) t.annotation = !!op.annotation; }
    else if (op.op === "delete") state.threads = state.threads.filter(function (x) { return x.id !== op.id; });
  }
  function find(id) { return state.threads.filter(function (t) { return t.id === id; })[0]; }
  function isAnno(t) { return !!t.annotation; }

  /* ---------- views & anchoring ---------- */

  function curView() { return location.pathname + location.search + location.hash; }
  function normView(v) {
    if (v == null) return null;
    try { var u = new URL(v, location.href); return u.pathname + u.search + u.hash; }
    catch (e) { return v; }
  }
  function onThisView(t) { return t.view == null || normView(t.view) === curView(); }
  function safeQuery(sel) { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } }
  function anchorOf(t) { return safeQuery(t.sel); }
  function resolvesHere(t) { return !!anchorOf(t); }
  // Listed in sidebar unless it's a confirmed orphan (own view, anchor gone).
  function isListed(t) { return resolvesHere(t) || !onThisView(t); }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "body";
    if (el === document.body || el === document.documentElement) return "body";
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 12) {
      var sel = el.nodeName.toLowerCase(), p = el.parentNode;
      if (p && p.children) {
        var same = [];
        for (var i = 0; i < p.children.length; i++)
          if (p.children[i].nodeName === el.nodeName) same.push(p.children[i]);
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(">");
  }
  function pinXY(t) {
    var el = anchorOf(t);
    if (!el) return null;
    // Body/page-level anchors use absolute page coords (the body box is the
    // whole page, so fractions are meaningless); element anchors use the rect.
    if (el === document.body || el === document.documentElement) {
      return { x: t.px - window.scrollX, y: t.py - window.scrollY };
    }
    var r = el.getBoundingClientRect();
    return { x: r.left + t.fx * r.width, y: r.top + t.fy * r.height };
  }
  function anchorAt(x, y) {
    // Fully hide the overlay while hit-testing — pointer-events:none on the host
    // isn't enough because the catcher re-enables pointer-events on itself.
    var prev = host.style.display;
    host.style.display = "none";
    var el = document.elementFromPoint(x, y);
    host.style.display = prev;
    if (!el || host.contains(el)) el = document.body;
    var r = el.getBoundingClientRect();
    return {
      sel: cssPath(el),
      fx: r.width ? (x - r.left) / r.width : 0.5,
      fy: r.height ? (y - r.top) / r.height : 0.5,
      px: x + window.scrollX, py: y + window.scrollY,
      view: curView(),
    };
  }

  function uid() { return Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36); }
  function nowIso() { return new Date().toISOString(); }
  function getName() { try { return localStorage.getItem(LS_NAME) || ""; } catch (e) { return ""; } }
  function setName(n) { try { localStorage.setItem(LS_NAME, n); } catch (e) {} }

  /* ---------- shadow UI ---------- */

  var host = document.createElement("div");
  host.id = "gv-review-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
  var root = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  root.innerHTML =
    '<style>' +
    ':host,*{box-sizing:border-box;}' +
    '.layer{position:fixed;inset:0;pointer-events:none;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;}' +
    '.hidden{display:none!important;}' +
    '.catcher{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;background:rgba(37,99,235,0.045);}' +
    '.pin{position:fixed;pointer-events:auto;transform:translate(-50%,-100%);cursor:grab;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50% 50% 50% 2px;background:#2563eb;color:#fff;font-weight:600;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid #fff;touch-action:none;}' +
    '.pin.resolved{background:#16a34a;}' +
    '.pin.active{outline:3px solid rgba(37,99,235,0.4);}' +
    '.pin.dragging{cursor:grabbing;opacity:0.85;}' +
    /* annotation pin: cat avatar, centred on its anchor, always-on */
    '.pin.anno{width:30px;height:30px;border-radius:50%;background:#fff;border:2px solid #fff;padding:0;overflow:hidden;transform:translate(-50%,-50%);box-shadow:0 2px 8px rgba(0,0,0,0.32);cursor:pointer;}' +
    '.pin.anno img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%;pointer-events:none;}' +
    '.pin.anno.active{outline:3px solid rgba(37,99,235,0.4);}' +
    /* hover/sticky note bubble for annotation pins (delivery mode) */
    '.atip{position:fixed;pointer-events:none;max-width:260px;background:#1a1a1a;color:#fff;padding:8px 11px;border-radius:10px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,0.28);transform:translate(-50%,-100%);opacity:0;transition:opacity .12s;white-space:pre-wrap;word-wrap:break-word;}' +
    '.atip.show{opacity:0.97;}' +
    /* sidebar */
    '.sb{position:fixed;top:0;right:0;height:100vh;width:300px;max-width:85vw;pointer-events:auto;background:#fff;border-left:1px solid #e5e7eb;box-shadow:-6px 0 24px rgba(0,0,0,0.10);display:flex;flex-direction:column;transition:transform .18s ease;}' +
    '.sb.collapsed{transform:translateX(100%);}' +
    '.sb header{display:flex;align-items:center;gap:8px;padding:14px 14px 10px;border-bottom:1px solid #f0f0f0;}' +
    '.sb header strong{font-size:14px;}' +
    '.sb header .cnt{color:#6b7280;font-size:12px;flex:1;}' +
    '.sb header button{font:inherit;cursor:pointer;border:1px solid #e5e7eb;background:#fff;color:#1a1a1a;border-radius:8px;width:30px;height:30px;line-height:1;font-size:16px;}' +
    '.sb header button:hover{background:#f3f4f6;}' +
    '.sb .hint{padding:8px 14px;color:#6b7280;font-size:12px;border-bottom:1px solid #f0f0f0;}' +
    '.sb .list{list-style:none;margin:0;padding:6px;overflow:auto;flex:1;}' +
    '.sb .it{display:flex;gap:9px;align-items:flex-start;padding:9px 8px;border-radius:9px;cursor:pointer;}' +
    '.sb .it:hover{background:#f3f4f6;}' +
    '.sb .it.active{background:#eef2ff;}' +
    '.sb .it .num{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:#2563eb;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:1px;}' +
    '.sb .it.resolved .num{background:#16a34a;}' +
    '.sb .it.anno .num{background:#fff;padding:0;overflow:hidden;}' +
    '.sb .it.anno .num img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%;}' +
    '.sb .it .txt{flex:1;min-width:0;}' +
    '.sb .it .body{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.sb .it .meta{display:block;color:#9ca3af;font-size:11px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.sb .it .away{color:#2563eb;}' +
    '.sb .empty{padding:18px 14px;color:#9ca3af;font-size:13px;}' +
    /* collapsed handle */
    '.tab{position:fixed;top:16px;right:16px;pointer-events:auto;display:flex;align-items:center;gap:7px;background:#2563eb;color:#fff;border:0;border-radius:999px;padding:9px 14px;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.22);}' +
    /* cards */
    '.card{position:fixed;pointer-events:auto;width:300px;max-width:calc(100vw - 24px);background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.22);padding:14px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;}' +
    '.card h4{margin:0 0 8px;font-size:13px;color:#6b7280;font-weight:600;}' +
    '.card .chead{display:flex;align-items:center;gap:8px;margin:0 0 8px;}' +
    '.card .chead h4{margin:0;flex:1;}' +
    '.anno-toggle{flex:0 0 auto;width:26px;height:26px;border-radius:50%;border:2px solid #e5e7eb;background:#fff;padding:0;overflow:hidden;cursor:pointer;opacity:.4;filter:grayscale(1);transition:opacity .12s,filter .12s,border-color .12s;}' +
    '.anno-toggle img{width:100%;height:100%;object-fit:cover;display:block;}' +
    '.anno-toggle.on{opacity:1;filter:none;border-color:#f59e0b;}' +
    '.msg{padding:8px 0;border-top:1px solid #f0f0f0;}' +
    '.msg:first-of-type{border-top:0;}' +
    '.msg .who{font-weight:600;font-size:12px;}' +
    '.msg .when{color:#9ca3af;font-size:11px;margin-left:6px;}' +
    '.msg .body{margin-top:2px;white-space:pre-wrap;word-wrap:break-word;}' +
    '.card input,.card textarea{width:100%;font:inherit;padding:8px 10px;border:1px solid #e5e7eb;border-radius:9px;margin-top:8px;background:#fafafa;color:#1a1a1a;}' +
    '.card textarea{min-height:64px;resize:vertical;}' +
    '.card .row{display:flex;gap:8px;margin-top:10px;align-items:center;justify-content:flex-end;}' +
    '.card .row .spacer{flex:1;}' +
    '.card button{font:inherit;cursor:pointer;border-radius:9px;padding:8px 14px;font-weight:500;border:1px solid #e5e7eb;background:#fff;color:#1a1a1a;}' +
    '.card button.primary{background:#2563eb;color:#fff;border-color:transparent;}' +
    '.card button.link{border:0;background:0;color:#6b7280;padding:8px 4px;}' +
    '.card button.danger{border:0;background:0;color:#dc2626;padding:8px 4px;}' +
    '.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);pointer-events:none;background:#1a1a1a;color:#fff;padding:8px 14px;border-radius:999px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;opacity:0;transition:opacity .2s;}' +
    '.toast.show{opacity:0.95;}' +
    '@media (prefers-color-scheme: dark){' +
    '.sb,.card{background:#161619;color:#f3f4f6;border-color:#26262b;}' +
    '.sb header,.sb .hint{border-color:#26262b;}' +
    '.sb header button{background:#161619;color:#f3f4f6;border-color:#26262b;}' +
    '.sb header button:hover,.sb .it:hover{background:#26262b;}' +
    '.sb .it.active{background:#1e2740;}' +
    '.card input,.card textarea{background:#0d0d0f;color:#f3f4f6;border-color:#26262b;}' +
    '.card button{background:#161619;color:#f3f4f6;border-color:#26262b;}' +
    '.card button.primary{background:#60a5fa;color:#0d0d0f;}' +
    '.msg{border-color:#26262b;}.msg:first-of-type{border-top:0;}' +
    '}' +
    '</style>' +
    '<div class="layer hidden">' +
    '  <div class="catcher hidden"></div>' +
    '  <div class="pins"></div>' +
    '  <aside class="sb">' +
    '    <header><strong>Comments</strong><span class="cnt"></span>' +
    '      <button class="newc" title="New comment">+</button>' +
    '      <button class="collapse" title="Collapse">&rsaquo;</button></header>' +
    '    <div class="hint"></div>' +
    '    <ul class="list"></ul>' +
    '  </aside>' +
    '  <button class="tab hidden">&#128172; <span class="cnt2"></span></button>' +
    '  <div class="cardholder"></div>' +
    '  <div class="atip"></div>' +
    '  <div class="toast"></div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var layer = $(".layer"), catcher = $(".catcher"), pinsEl = $(".pins"),
      sb = $(".sb"), listEl = $(".list"), cntEl = $(".cnt"), cnt2El = $(".cnt2"),
      hintEl = $(".hint"), tabEl = $(".tab"), cardholder = $(".cardholder"),
      tipEl = $(".atip"), toastEl = $(".toast");

  var sbCollapsed = false;
  try { sbCollapsed = localStorage.getItem(LS_SB) === "1"; } catch (e) {}

  /* ---------- rendering ---------- */

  function render() {
    // The layer itself is ALWAYS live — annotation pins must show with review off.
    // Only the review chrome (catcher, sidebar, tab) is gated by state.active.
    layer.classList.remove("hidden");
    var on = state.active;
    catcher.classList.toggle("hidden", !on || state.mode !== "add");
    sb.classList.toggle("hidden", !on);
    sb.classList.toggle("collapsed", sbCollapsed);
    tabEl.classList.toggle("hidden", !on || !sbCollapsed);
    if (!on) { closeCard(); }
    hintEl.textContent = state.mode === "add"
      ? "Click anywhere to place a comment · Esc to browse"
      : "Drag a pin to move it · + for a new comment";
    renderList();
    renderPins();
  }

  function listed() { return state.threads.filter(isListed); }
  // Pins shown on the canvas: everything in review mode, only annotations when off.
  function pinThreads() { return state.active ? listed() : listed().filter(isAnno); }

  function renderList() {
    var items = listed();
    var open = items.filter(function (t) { return !t.resolved; }).length;
    cntEl.textContent = items.length ? open + " open" + (items.length - open ? " · " + (items.length - open) + " done" : "") : "";
    cnt2El.textContent = items.length || "";
    listEl.textContent = "";
    if (!items.length) {
      var e = document.createElement("li");
      e.className = "empty";
      e.textContent = "No comments yet. Click the prototype to add one.";
      listEl.appendChild(e);
      return;
    }
    items.forEach(function (t, i) {
      var li = document.createElement("li");
      var anno = isAnno(t);
      li.className = "it" + (t.resolved ? " resolved" : "") + (anno ? " anno" : "") + (state.openId === t.id ? " active" : "");
      var away = !resolvesHere(t);
      li.innerHTML = '<span class="num"></span><span class="txt"><span class="body"></span>' +
        '<span class="meta"></span></span>';
      if (anno) {
        var av = document.createElement("img"); av.src = CAT; av.alt = "";
        var n = li.querySelector(".num"); n.textContent = ""; n.appendChild(av);
      } else {
        li.querySelector(".num").textContent = String(i + 1);
      }
      li.querySelector(".body").textContent = (t.messages[0] && t.messages[0].body) || "(empty)";
      li.querySelector(".meta").textContent = (anno ? "Annotation · " : "") + (t.messages[0] ? t.messages[0].author : "") +
        (away ? " · ↗ on another screen" : "") + (t.resolved ? " · resolved" : "");
      if (away) li.querySelector(".meta").className = "meta away";
      li.addEventListener("click", function () { openOrNavigate(t.id); });
      listEl.appendChild(li);
    });
  }

  function renderPins() {
    pinsEl.textContent = "";
    // Number by position in the full listed() set so pin N matches sidebar item N.
    var nums = {}; listed().forEach(function (t, i) { nums[t.id] = i + 1; });
    pinThreads().forEach(function (t) {
      var xy = pinXY(t);
      if (!xy) return; // elsewhere → sidebar only
      var b = document.createElement("button");
      var anno = isAnno(t);
      b.className = "pin" + (anno ? " anno" : "") + (t.resolved ? " resolved" : "") + (state.openId === t.id ? " active" : "");
      b.style.left = xy.x + "px"; b.style.top = xy.y + "px";
      if (anno) {
        var av = document.createElement("img"); av.src = CAT; av.alt = "";
        b.appendChild(av);
        b.addEventListener("mouseenter", function () { showTip(b, t.id); });
        b.addEventListener("mouseleave", hideTip);
      } else {
        b.textContent = String(nums[t.id] || "");
        b.title = (t.messages[0] && t.messages[0].body) || "";
      }
      attachPinDrag(b, t.id);
      pinsEl.appendChild(b);
    });
  }

  function reposition() {
    var pins = pinsEl.children, items = pinThreads().filter(function (t) { return pinXY(t); });
    for (var i = 0; i < pins.length && i < items.length; i++) {
      var xy = pinXY(items[i]);
      if (xy) { pins[i].style.left = xy.x + "px"; pins[i].style.top = xy.y + "px"; }
    }
    if (openCardAnchor) positionCard(openCardAnchor);
    if (tipEl.classList.contains("show")) hideTip(true); // anchor moved → drop bubble
  }

  /* ---------- pin dragging ---------- */

  function attachPinDrag(btn, id) {
    var sx, sy, moved, dragging, canDrag;
    btn.addEventListener("pointerdown", function (e) {
      // Draggable only in review mode — pins paint above the add-mode catcher.
      // With review off (delivery mode) a pin is read-only: tap toggles its note.
      e.preventDefault();
      e.stopPropagation();
      sx = e.clientX; sy = e.clientY; moved = false; dragging = true;
      canDrag = state.active;
      btn.setPointerCapture(e.pointerId);
      if (canDrag) btn.classList.add("dragging");
    });
    btn.addEventListener("pointermove", function (e) {
      if (!dragging || !canDrag) return;
      if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      moved = true;
      btn.style.left = e.clientX + "px"; btn.style.top = e.clientY + "px";
    });
    btn.addEventListener("pointerup", function (e) {
      if (!dragging) return;
      dragging = false; btn.classList.remove("dragging");
      try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
      if (!moved) {
        if (state.active) openThread(id);
        else toggleTip(btn, id); // delivery mode: tap a cat to pin/unpin its note
        return;
      }
      var a = anchorAt(e.clientX, e.clientY);
      mutate({ op: "move", id: id, sel: a.sel, fx: a.fx, fy: a.fy, px: a.px, py: a.py, view: a.view });
      toast("Comment moved");
    });
  }

  /* ---------- annotation note bubble (delivery mode hover/tap) ---------- */

  var tipSticky = null;
  function showTip(btn, id) {
    var t = find(id); if (!t) return;
    tipEl.textContent = (t.messages[0] && t.messages[0].body) || "";
    var r = btn.getBoundingClientRect();
    tipEl.style.left = (r.left + r.width / 2) + "px";
    tipEl.style.top = (r.top - 8) + "px";
    tipEl.classList.add("show");
  }
  function hideTip(force) { if (tipSticky && force !== true) return; tipSticky = null; tipEl.classList.remove("show"); }
  function toggleTip(btn, id) {
    if (tipSticky === id) { hideTip(true); return; }
    tipSticky = id; showTip(btn, id);
  }

  /* ---------- cards ---------- */

  var openCardAnchor = null;
  function closeCard() { cardholder.textContent = ""; state.openId = null; openCardAnchor = null; renderPins(); if (state.active) renderList(); }
  function positionCard(at) {
    var card = cardholder.firstElementChild; if (!card) return;
    var w = card.offsetWidth, h = card.offsetHeight;
    var rightLimit = window.innerWidth - (sbCollapsed ? 12 : 312) - w;
    card.style.left = Math.min(Math.max(12, at.x + 16), Math.max(12, rightLimit)) + "px";
    card.style.top = Math.min(Math.max(12, at.y), window.innerHeight - h - 12) + "px";
  }
  function makeCard(at) { cardholder.textContent = ""; var c = document.createElement("div"); c.className = "card"; cardholder.appendChild(c); openCardAnchor = at; return c; }

  function composeNew(loc) {
    state.openId = null; renderPins(); renderList();
    var card = makeCard({ x: loc.px - window.scrollX, y: loc.py - window.scrollY });
    var needName = !getName();
    card.innerHTML = '<h4>New comment</h4>' +
      (needName ? '<input class="nm" placeholder="Your name" />' : '') +
      '<textarea class="tx" placeholder="What\'s your feedback?"></textarea>' +
      '<div class="row"><button class="cancel link">Cancel</button>' +
      '<button class="save primary">Comment</button></div>';
    positionCard(openCardAnchor);
    var tx = card.querySelector(".tx"), nm = card.querySelector(".nm");
    (nm || tx).focus();
    card.querySelector(".cancel").addEventListener("click", closeCard);
    card.querySelector(".save").addEventListener("click", function () {
      var name = (nm ? nm.value.trim() : getName()) || "Anonymous";
      var text = tx.value.trim(); if (!text) { tx.focus(); return; }
      if (nm) setName(name);
      var thread = { id: uid(), sel: loc.sel, fx: loc.fx, fy: loc.fy, px: loc.px, py: loc.py,
        view: loc.view, resolved: false, messages: [{ author: name, body: text, at: nowIso() }] };
      closeCard();
      mutate({ op: "add", thread: thread });
      toast("Comment added");
    });
  }

  function openThread(id) {
    var t = find(id); if (!t) return;
    state.mode = "browse"; state.openId = id;
    var xy = pinXY(t) || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    render();
    var card = makeCard(xy);
    card.innerHTML = '<div class="chead">' +
      '<button class="anno-toggle' + (t.annotation ? ' on' : '') + '" title="' +
      (t.annotation ? 'Annotation — always visible, skipped on resolve. Click to make it a normal comment.' : 'Make this an annotation — always-on dev note, skipped when resolving comments.') +
      '"><img src="' + CAT + '" alt=""></button>' +
      '<h4>' + (t.annotation ? 'Annotation' : 'Comment') + (t.resolved ? ' · resolved' : '') + '</h4></div>' +
      '<div class="msgs"></div>' +
      '<textarea class="tx" placeholder="Reply…"></textarea>' +
      '<div class="row"><button class="del danger">Delete</button>' +
      '<button class="res link">' + (t.resolved ? 'Reopen' : 'Resolve') + '</button>' +
      '<span class="spacer"></span><button class="reply primary">Reply</button></div>';
    var msgs = card.querySelector(".msgs");
    t.messages.forEach(function (m) {
      var d = document.createElement("div"); d.className = "msg";
      d.innerHTML = '<span class="who"></span><span class="when"></span><div class="body"></div>';
      d.querySelector(".who").textContent = m.author;
      d.querySelector(".when").textContent = fmt(m.at);
      d.querySelector(".body").textContent = m.body;
      msgs.appendChild(d);
    });
    positionCard(xy);
    card.querySelector(".reply").addEventListener("click", function () {
      var tx = card.querySelector(".tx"), text = tx.value.trim(); if (!text) { tx.focus(); return; }
      mutate({ op: "reply", id: id, message: { author: getName() || "Anonymous", body: text, at: nowIso() } })
        .then(function () { openThread(id); });
    });
    card.querySelector(".res").addEventListener("click", function () {
      mutate({ op: "resolve", id: id, resolved: !t.resolved }).then(closeCard);
    });
    card.querySelector(".anno-toggle").addEventListener("click", function () {
      var willBe = !t.annotation;
      mutate({ op: "annotate", id: id, annotation: willBe }).then(function () {
        toast(willBe ? "Now an annotation · always-on for devs" : "Back to a comment");
        openThread(id);
      });
    });
    card.querySelector(".del").addEventListener("click", function () {
      if (!confirm("Delete this comment thread?")) return;
      deleted[id] = 1;
      mutate({ op: "delete", id: id }).then(closeCard);
    });
  }

  // Open a thread; if it lives on another screen, navigate there first.
  function openOrNavigate(id) {
    var t = find(id); if (!t) return;
    if (resolvesHere(t)) {
      var el = anchorOf(t);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
      setTimeout(function () { openThread(id); }, 60);
      return;
    }
    if (!onThisView(t) && t.view) {
      try { sessionStorage.setItem(SS_PENDING, id); } catch (e) {}
      var dest = new URL(t.view, location.href).href;
      if (dest === location.href) { tryOpenPending(); return; }
      location.href = dest; // reload or hashchange → tryOpenPending runs on arrival
      setTimeout(tryOpenPending, 80); // same-document (hash) case
    }
  }

  function tryOpenPending() {
    var id; try { id = sessionStorage.getItem(SS_PENDING); } catch (e) {}
    if (!id) return;
    var attempts = 0;
    (function poll() {
      var t = find(id);
      if (t && resolvesHere(t)) {
        try { sessionStorage.removeItem(SS_PENDING); } catch (e) {}
        if (!state.active) setActive(true);
        var el = anchorOf(t); if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
        setTimeout(function () { openThread(id); }, 60);
        return;
      }
      if (attempts++ < 20) setTimeout(poll, 100);
      else { try { sessionStorage.removeItem(SS_PENDING); } catch (e) {} }
    })();
  }

  function fmt(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
        d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  /* ---------- modes ---------- */

  function setActive(on) {
    state.active = on;
    try { sessionStorage.setItem(LS_ACTIVE, on ? "1" : "0"); } catch (e) {}
    hideTip(true);
    if (on) { state.mode = "add"; } else { closeCard(); }
    render();
    if (on) toast("Review on · click to comment · Esc to browse");
  }
  function setMode(m) { state.mode = m; if (m === "add") closeCard(); render(); }

  catcher.addEventListener("click", function (e) {
    composeNew(anchorAt(e.clientX, e.clientY));
  });

  $(".newc").addEventListener("click", function () { setMode("add"); });
  $(".collapse").addEventListener("click", function () { toggleSidebar(true); });
  tabEl.addEventListener("click", function () { toggleSidebar(false); });
  function toggleSidebar(collapse) {
    sbCollapsed = collapse;
    try { localStorage.setItem(LS_SB, collapse ? "1" : "0"); } catch (e) {}
    render();
  }

  var toastT;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 1900);
  }

  function isTyping(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  window.addEventListener("keydown", function (e) {
    // e.target is retargeted to the shadow host for events from inside our
    // shadow DOM, so check the real originating node via composedPath.
    var src = (e.composedPath && e.composedPath()[0]) || e.target;
    if (e.shiftKey && (e.code === "KeyC" || e.key === "C" || e.key === "c") && !isTyping(src)) {
      e.preventDefault(); setActive(!state.active);
    } else if (e.key === "Escape" && state.active) {
      if (state.openId) closeCard();
      else if (state.mode === "add") setMode("browse");
      else setActive(false);
    }
  }, true);

  /* ---------- lifecycle: orphan sweep + view changes ---------- */

  // A comment is an orphan when we're on its own screen but its anchor is gone.
  // Confirm after a short delay so a transient re-render doesn't delete it.
  var orphanTimers = {};
  function isOrphan(t) { return onThisView(t) && t.view != null && !resolvesHere(t); }
  function orphanSweep() {
    if (!settled) return;
    state.threads.forEach(function (t) {
      if (deleted[t.id]) return;
      if (isAnno(t)) return; // annotations are delivery notes — never auto-delete
      if (isOrphan(t)) {
        if (!orphanTimers[t.id]) {
          orphanTimers[t.id] = setTimeout(function () {
            orphanTimers[t.id] = null;
            var cur = find(t.id);
            if (cur && !deleted[cur.id] && isOrphan(cur)) {
              deleted[cur.id] = 1;
              mutate({ op: "delete", id: cur.id });
              toast("Comment removed (its UI is gone)");
            }
          }, 700);
        }
      } else if (orphanTimers[t.id]) { clearTimeout(orphanTimers[t.id]); orphanTimers[t.id] = null; }
    });
  }

  var reRenderT;
  function scheduleRerender() {
    clearTimeout(reRenderT);
    reRenderT = setTimeout(function () {
      if (state.active) renderList();
      renderPins(); // annotation pins repaint even with review off
      orphanSweep();
    }, 200);
  }
  if (window.MutationObserver) {
    new MutationObserver(scheduleRerender).observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition, { passive: true });
  window.addEventListener("hashchange", function () { if (state.active) { render(); } tryOpenPending(); setTimeout(orphanSweep, 1200); });
  window.addEventListener("popstate", function () { if (state.active) { render(); } tryOpenPending(); setTimeout(orphanSweep, 1200); });

  // Boot.
  try { state.active = sessionStorage.getItem(LS_ACTIVE) === "1"; } catch (e) {}
  refresh().then(function () {
    var grace = function () { settled = true; orphanSweep(); };
    if (document.readyState === "complete") setTimeout(grace, 1500);
    else window.addEventListener("load", function () { setTimeout(grace, 1500); });
  });
})();
