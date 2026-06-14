/*
 * GoVocal prototype review overlay.
 *
 * Injected into every prototype's HTML by build.js (as
 * `<script src="/__review/comments.js" defer>`), but DORMANT until activated.
 *
 *   Shift+C  → toggle the review layer (pins + toolbar) on/off
 *   click    → (in add mode) drop a pin anchored to the clicked element
 *   Esc      → leave add mode / hide the layer
 *
 * Comments are shared via the worker's KV-backed API (/__review/api). If that
 * API is unreachable (e.g. the file was downloaded and opened locally), it
 * silently falls back to localStorage so the prototype itself never breaks.
 *
 * Everything lives in a shadow root so it cannot collide with the prototype's
 * own CSS/JS. It stays completely inert inside the index-page preview iframes.
 */
(function () {
  "use strict";

  // Never run inside the little preview iframes on the index pages.
  if (window.top !== window.self) return;
  // Avoid double-injection.
  if (window.__gvReview) return;
  window.__gvReview = true;

  var API = "/__review/api";
  var PATH = location.pathname;
  var LS_THREADS = "gv-review:" + PATH;
  var LS_NAME = "gv-review-name";
  var LS_ACTIVE = "gv-review-active";

  var state = { threads: [], active: false, adding: false, openId: null };

  /* ---------- storage ---------- */

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_THREADS) || "[]"); }
    catch (e) { return []; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_THREADS, JSON.stringify(state.threads)); }
    catch (e) {}
  }

  async function api(method, body) {
    var res = await fetch(API + "?path=" + encodeURIComponent(PATH), {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("api " + res.status);
    return res.json();
  }

  // Load threads (server first, local fallback). Always render after.
  async function refresh() {
    try {
      var data = await api("GET");
      state.threads = (data && data.threads) || [];
      saveLocal(); // keep a local mirror
    } catch (e) {
      state.threads = loadLocal();
    }
    render();
  }

  // Apply an op server-side; fall back to mutating + saving locally.
  async function mutate(op) {
    try {
      var data = await api("POST", op);
      state.threads = (data && data.threads) || [];
      saveLocal();
    } catch (e) {
      applyLocal(op);
      saveLocal();
    }
    render();
  }

  function applyLocal(op) {
    var t;
    if (op.op === "add") {
      state.threads.push(op.thread);
    } else if (op.op === "reply") {
      t = find(op.id);
      if (t) t.messages.push(op.message);
    } else if (op.op === "resolve") {
      t = find(op.id);
      if (t) t.resolved = op.resolved;
    } else if (op.op === "delete") {
      state.threads = state.threads.filter(function (x) { return x.id !== op.id; });
    }
  }
  function find(id) {
    return state.threads.filter(function (t) { return t.id === id; })[0];
  }

  /* ---------- anchoring ---------- */

  // A reasonably-stable CSS selector for an element.
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 12) {
      var sel = el.nodeName.toLowerCase();
      var p = el.parentNode;
      if (p && p.children) {
        var same = [];
        for (var i = 0; i < p.children.length; i++) {
          if (p.children[i].nodeName === el.nodeName) same.push(p.children[i]);
        }
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(">");
  }

  // Where on screen a pin should sit, from its anchor (fallback: page coords).
  function pinXY(t) {
    var el = t.sel ? safeQuery(t.sel) : null;
    if (el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + t.fx * r.width, y: r.top + t.fy * r.height, lost: false };
    }
    return { x: t.px - window.scrollX, y: t.py - window.scrollY, lost: true };
  }
  function safeQuery(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  function uid() {
    return Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
  }
  function now() { return new Date().toISOString(); }
  function getName() {
    try { return localStorage.getItem(LS_NAME) || ""; } catch (e) { return ""; }
  }
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
    /* add-mode catcher */
    '.catcher{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;background:rgba(37,99,235,0.04);}' +
    /* pins */
    '.pin{position:fixed;pointer-events:auto;transform:translate(-50%,-100%);cursor:pointer;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50% 50% 50% 2px;background:#2563eb;color:#fff;font-weight:600;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid #fff;}' +
    '.pin.resolved{background:#16a34a;}' +
    '.pin.lost{opacity:0.5;}' +
    '.pin.active{outline:3px solid rgba(37,99,235,0.4);}' +
    /* toolbar */
    '.bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:7px 8px 7px 16px;box-shadow:0 6px 24px rgba(0,0,0,0.18);}' +
    '.bar .dot{width:8px;height:8px;border-radius:50%;background:#2563eb;}' +
    '.bar .lbl{font-weight:600;}' +
    '.bar .cnt{color:#6b7280;}' +
    '.bar button{font:inherit;cursor:pointer;border:1px solid #e5e7eb;background:#fff;color:#1a1a1a;border-radius:999px;padding:6px 12px;font-weight:500;}' +
    '.bar button:hover{background:#f3f4f6;}' +
    '.bar button.on{background:#2563eb;color:#fff;border-color:transparent;}' +
    '.bar .x{border:0;padding:6px 9px;color:#6b7280;font-size:16px;line-height:1;}' +
    /* cards */
    '.card{position:fixed;pointer-events:auto;width:300px;max-width:calc(100vw - 24px);background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.22);padding:14px;}' +
    '.card h4{margin:0 0 8px;font-size:13px;color:#6b7280;font-weight:600;}' +
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
    /* toast */
    '.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);pointer-events:none;background:#1a1a1a;color:#fff;padding:8px 14px;border-radius:999px;font-size:13px;opacity:0;transition:opacity .2s;}' +
    '.toast.show{opacity:0.95;}' +
    '@media (prefers-color-scheme: dark){' +
    '.bar,.card{background:#161619;border-color:#26262b;color:#f3f4f6;}' +
    '.bar button,.card button{background:#161619;color:#f3f4f6;border-color:#26262b;}' +
    '.bar button:hover{background:#26262b;}' +
    '.bar button.on,.card button.primary{background:#60a5fa;color:#0d0d0f;}' +
    '.card input,.card textarea{background:#0d0d0f;color:#f3f4f6;border-color:#26262b;}' +
    '.msg{border-color:#26262b;}.msg:first-of-type{border-top:0;}' +
    '}' +
    '</style>' +
    '<div class="layer hidden">' +
    '  <div class="catcher hidden"></div>' +
    '  <div class="pins"></div>' +
    '  <div class="bar">' +
    '    <span class="dot"></span><span class="lbl">Review</span><span class="cnt"></span>' +
    '    <button class="add">+ Add comment</button>' +
    '    <button class="exp">Export</button>' +
    '    <button class="x" title="Hide (Shift+C)">&times;</button>' +
    '  </div>' +
    '  <div class="cardholder"></div>' +
    '  <div class="toast"></div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var layer = $(".layer"), catcher = $(".catcher"), pinsEl = $(".pins"),
      bar = $(".bar"), cntEl = $(".cnt"), addBtn = $(".add"), expBtn = $(".exp"),
      cardholder = $(".cardholder"), toastEl = $(".toast");

  /* ---------- rendering ---------- */

  function render() {
    layer.classList.toggle("hidden", !state.active);
    if (!state.active) { closeCard(); return; }
    catcher.classList.toggle("hidden", !state.adding);
    addBtn.classList.toggle("on", state.adding);
    var open = state.threads.filter(function (t) { return !t.resolved; }).length;
    cntEl.textContent = state.threads.length
      ? open + " open" + (state.threads.length - open ? " · " + (state.threads.length - open) + " resolved" : "")
      : "no comments yet";
    renderPins();
  }

  function renderPins() {
    pinsEl.textContent = "";
    state.threads.forEach(function (t, i) {
      var p = pinXY(t);
      var b = document.createElement("button");
      b.className = "pin" + (t.resolved ? " resolved" : "") + (p.lost ? " lost" : "") +
        (state.openId === t.id ? " active" : "");
      b.style.left = p.x + "px";
      b.style.top = p.y + "px";
      b.textContent = String(i + 1);
      b.title = (t.messages[0] && t.messages[0].body) || "";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        openThread(t.id);
      });
      pinsEl.appendChild(b);
    });
  }

  function reposition() {
    if (!state.active) return;
    var pins = pinsEl.children;
    for (var i = 0; i < pins.length; i++) {
      var p = pinXY(state.threads[i]);
      pins[i].style.left = p.x + "px";
      pins[i].style.top = p.y + "px";
      pins[i].classList.toggle("lost", p.lost);
    }
    if (openCardAnchor) positionCard(openCardAnchor);
  }

  /* ---------- cards (compose + thread) ---------- */

  var openCardAnchor = null;

  function closeCard() {
    cardholder.textContent = "";
    state.openId = null;
    openCardAnchor = null;
    renderPins();
  }

  function positionCard(at) {
    var card = cardholder.firstElementChild;
    if (!card) return;
    var w = card.offsetWidth, h = card.offsetHeight;
    var x = Math.min(Math.max(12, at.x + 16), window.innerWidth - w - 12);
    var y = Math.min(Math.max(12, at.y), window.innerHeight - h - 12);
    card.style.left = x + "px";
    card.style.top = y + "px";
  }

  function makeCard(at) {
    cardholder.textContent = "";
    var card = document.createElement("div");
    card.className = "card";
    cardholder.appendChild(card);
    openCardAnchor = at;
    return card;
  }

  function composeNew(loc) {
    state.openId = null;
    renderPins();
    var card = makeCard({ x: loc.x, y: loc.y });
    var needName = !getName();
    card.innerHTML =
      '<h4>New comment</h4>' +
      (needName ? '<input class="nm" placeholder="Your name" />' : '') +
      '<textarea class="tx" placeholder="What\'s your feedback?"></textarea>' +
      '<div class="row"><button class="cancel link">Cancel</button>' +
      '<button class="save primary">Comment</button></div>';
    positionCard({ x: loc.x, y: loc.y });
    var tx = card.querySelector(".tx");
    var nm = card.querySelector(".nm");
    (nm || tx).focus();
    card.querySelector(".cancel").addEventListener("click", closeCard);
    card.querySelector(".save").addEventListener("click", function () {
      var name = (nm ? nm.value.trim() : getName()) || "Anonymous";
      var text = tx.value.trim();
      if (!text) { tx.focus(); return; }
      if (nm) setName(name);
      var thread = {
        id: uid(), sel: loc.sel, fx: loc.fx, fy: loc.fy, px: loc.px, py: loc.py,
        resolved: false, messages: [{ author: name, body: text, at: now() }],
      };
      closeCard();
      setAdding(false);
      mutate({ op: "add", thread: thread });
      toast("Comment added");
    });
  }

  function openThread(id) {
    var t = find(id);
    if (!t) return;
    state.openId = id;
    renderPins();
    var at = pinXY(t);
    var card = makeCard(at);
    var msgs = t.messages.map(function (m) {
      return '<div class="msg"><span class="who"></span><span class="when"></span>' +
        '<div class="body"></div></div>';
    }).join("");
    card.innerHTML =
      '<h4>Comment ' + (state.threads.indexOf(t) + 1) + (t.resolved ? ' · resolved' : '') + '</h4>' +
      '<div class="msgs">' + msgs + '</div>' +
      '<textarea class="tx" placeholder="Reply…"></textarea>' +
      '<div class="row">' +
      '<button class="del danger">Delete</button>' +
      '<button class="res link">' + (t.resolved ? 'Reopen' : 'Resolve') + '</button>' +
      '<span class="spacer"></span>' +
      '<button class="reply primary">Reply</button></div>';
    // fill messages safely (textContent, no HTML injection)
    var rows = card.querySelectorAll(".msg");
    t.messages.forEach(function (m, i) {
      rows[i].querySelector(".who").textContent = m.author;
      rows[i].querySelector(".when").textContent = fmt(m.at);
      rows[i].querySelector(".body").textContent = m.body;
    });
    positionCard(at);
    card.querySelector(".reply").addEventListener("click", function () {
      var tx = card.querySelector(".tx");
      var text = tx.value.trim();
      if (!text) { tx.focus(); return; }
      var name = getName() || "Anonymous";
      mutate({ op: "reply", id: id, message: { author: name, body: text, at: now() } })
        .then(function () { openThread(id); });
    });
    card.querySelector(".res").addEventListener("click", function () {
      mutate({ op: "resolve", id: id, resolved: !t.resolved }).then(closeCard);
    });
    card.querySelector(".del").addEventListener("click", function () {
      if (!confirm("Delete this comment thread?")) return;
      mutate({ op: "delete", id: id }).then(closeCard);
    });
  }

  function fmt(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  /* ---------- add mode ---------- */

  function setActive(on) {
    state.active = on;
    try { sessionStorage.setItem(LS_ACTIVE, on ? "1" : "0"); } catch (e) {}
    if (!on) { setAdding(false); closeCard(); }
    render();
    if (on) toast("Review mode · Shift+C to hide");
  }
  function setAdding(on) {
    state.adding = on;
    if (on) closeCard();
    render();
  }

  catcher.addEventListener("click", function (e) {
    var x = e.clientX, y = e.clientY;
    // peek under the catcher to find the real anchor element
    catcher.style.display = "none";
    var el = document.elementFromPoint(x, y);
    catcher.style.display = "";
    if (!el || host.contains(el)) el = document.body;
    var r = el.getBoundingClientRect();
    var fx = r.width ? (x - r.left) / r.width : 0.5;
    var fy = r.height ? (y - r.top) / r.height : 0.5;
    composeNew({
      x: x, y: y, sel: cssPath(el),
      fx: fx, fy: fy, px: x + window.scrollX, py: y + window.scrollY,
    });
  });

  addBtn.addEventListener("click", function () { setAdding(!state.adding); });
  $(".x").addEventListener("click", function () { setActive(false); });
  expBtn.addEventListener("click", exportThreads);

  /* ---------- export (client-side convenience) ---------- */

  function exportThreads() {
    var lines = ["# Review comments — " + PATH, ""];
    state.threads.forEach(function (t, i) {
      lines.push("## " + (i + 1) + (t.resolved ? " (resolved)" : "") +
        (t.sel ? " — `" + t.sel + "`" : ""));
      t.messages.forEach(function (m) {
        lines.push("- **" + m.author + "** (" + fmt(m.at) + "): " + m.body);
      });
      lines.push("");
    });
    var blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "comments" + PATH.replace(/\//g, "-") + "md";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- misc ---------- */

  var toastT;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  }

  window.addEventListener("keydown", function (e) {
    if (e.shiftKey && (e.code === "KeyC" || e.key === "C" || e.key === "c") && !isTyping(e.target)) {
      e.preventDefault();
      setActive(!state.active);
    } else if (e.key === "Escape" && state.active) {
      if (state.adding) setAdding(false);
      else if (state.openId) closeCard();
    }
  }, true);

  function isTyping(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition, { passive: true });

  // Restore active state within the session, then load comments.
  try { state.active = sessionStorage.getItem(LS_ACTIVE) === "1"; } catch (e) {}
  refresh();
})();
