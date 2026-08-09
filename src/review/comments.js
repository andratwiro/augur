/*
 * Prototype review overlay.
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
 * The avatar ships as a sibling file (aslam.png), copied to /__review/ by build.js.
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
  // show as this avatar instead of a numbered pin. Served as a real same-origin
  // file (next to this script) rather than a data: URI — some privacy blockers
  // refuse to paint inline images, and a plain <img src> is bulletproof.
  var CAT = "/__review/aslam.png?v=1";

  var state = { threads: [], active: false, mode: "add", openId: null, drill: 0 };
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
    loadPeople();
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
    loadPeople();
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
    else if (op.op === "delmsg") {
      t = find(op.id);
      if (t) {
        if (op.index === 0) state.threads = state.threads.filter(function (x) { return x.id !== op.id; });
        else if (t.messages) t.messages = t.messages.filter(function (_, i) { return i !== op.index; });
      }
    }
    else if (op.op === "delete") state.threads = state.threads.filter(function (x) { return x.id !== op.id; });
  }
  function find(id) { return state.threads.filter(function (t) { return t.id === id; })[0]; }
  function isAnno(t) { return !!t.annotation; }
  // Deterministic per-pin tilt (-12°..+12°) hashed from the id, so a stamp keeps
  // the same angle across re-renders instead of jittering.
  function annoRot(id) {
    var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return (Math.abs(h) % 25) - 12;
  }

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

  // Screen contract: SPA prototypes change "screens" without changing the URL, so
  // the prototype publishes its current screen on <body data-gv-screen="…"> (see
  // CLAUDE.md). A comment captures that string at creation; it then only belongs
  // on the matching screen. Empty string => prototype isn't screen-aware (normal
  // multi-page), so scoping falls back to the URL exactly as before.
  function curScreen() {
    try { return (document.body && document.body.getAttribute("data-gv-screen")) || ""; }
    catch (e) { return ""; }
  }
  function onThisScreen(t) {
    if (!t.screen) return true;        // comment isn't screen-scoped → URL rules apply
    if (!onThisView(t)) return true;   // on another URL → defer the check until we arrive
    return t.screen === curScreen();
  }

  // Belongs on the current canvas/sidebar: its anchor is here, or it lives on
  // another URL (kept for navigation). A screen-scoped comment on the wrong screen
  // is fully hidden — not a pin, not in the list.
  function isListed(t) { return onThisScreen(t) && (resolvesHere(t) || !onThisView(t)); }

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
    // Canvas threads are anchored in world (board) coordinates: when this page mounts the
    // infinite-canvas engine, map the stored world point through the live pan/zoom transform
    // so the pin stays glued to the board as it moves. (Normal pages have no GVCanvas → skip.)
    if (t.cwx != null && window.GVCanvas) return window.GVCanvas.worldToScreen(t.cwx, t.cwy);
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
    var loc = {
      sel: cssPath(el),
      fx: r.width ? (x - r.left) / r.width : 0.5,
      fy: r.height ? (y - r.top) / r.height : 0.5,
      px: x + window.scrollX, py: y + window.scrollY,
      view: curView(),
      screen: curScreen(),
    };
    // On an infinite canvas, also record the point in world (board) coordinates so the pin
    // tracks pan/zoom instead of sticking to the screen. pinXY() prefers these when present;
    // the engine dispatches a window "scroll" on every transform, which re-runs reposition().
    if (window.GVCanvas) { var w = window.GVCanvas.screenToWorld(x, y); loc.cwx = w.x; loc.cwy = w.y; }
    return loc;
  }

  function uid() { return Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36); }
  function nowIso() { return new Date().toISOString(); }
  function getName() { try { return localStorage.getItem(LS_NAME) || ""; } catch (e) { return ""; } }
  function setName(n) { try { localStorage.setItem(LS_NAME, n); } catch (e) {} }

  // Who we are, if signed in. Used for the author name (as before), for the reply
  // bar's own avatar, and to attribute a comment written while the API is unreachable
  // — the localStorage path has no server to stamp `by` for it. The server rebuilds
  // every message from the session regardless, so this can't forge anything.
  var ME = null;
  var PEOPLE = {};   // id -> person
  var BYNAME = {};   // name -> person (back-compat for messages with no `by`)

  function loadMe() {
    return fetch("/__me", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.user) return;
        ME = { id: d.user.id, name: d.user.name, initials: d.user.initials,
               color: d.user.color, avatar: d.user.avatar };
        if (ME.name) setName(ME.name);
        if (ME.id) { PEOPLE[ME.id] = ME; BYNAME[ME.name] = ME; }
      })
      .catch(function () {});
  }

  // One request for every author on this page we don't already hold. Ids come from
  // the threads themselves, so we never ask for — and can never receive — the roster.
  var peoplePending = false;
  function loadPeople() {
    var ids = {}, names = {};
    state.threads.forEach(function (t) {
      (t.messages || []).forEach(function (m) {
        if (m.by && !PEOPLE[m.by]) ids[m.by] = 1;
        // Pre-`by` comments: a verified name is guaranteed by the server to belong to
        // a real account, so it is safe to resolve. An unverified name is just a
        // string someone typed — never look it up.
        else if (!m.by && m.verified && m.author && !BYNAME[m.author]) names[m.author] = 1;
      });
    });
    var idList = Object.keys(ids), nameList = Object.keys(names);
    if (peoplePending || (!idList.length && !nameList.length)) return;
    var q = [];
    // /__people caps ids.length + names.length COMBINED at PEOPLE_LOOKUP_MAX (50, see
    // peopleApi in _worker.js) — it is not 50 of each. Ids win the budget first since an
    // id is an exact, current identity, while a name lookup is only a back-compat path
    // for pre-`by` comments; whatever's left after ids goes to names. Anything that
    // doesn't fit is simply dropped, not retried — those authors still get initials via
    // fromName(), so this degrades gracefully on its own.
    var idPart = idList.slice(0, 50);
    var namePart = nameList.slice(0, Math.max(0, 50 - idPart.length));
    if (idPart.length) q.push("ids=" + encodeURIComponent(idPart.join(",")));
    if (namePart.length) q.push("names=" + encodeURIComponent(namePart.join(",")));
    peoplePending = true;
    fetch("/__people?" + q.join("&"), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        peoplePending = false;
        if (!d || !d.people) return;
        d.people.forEach(function (p) { PEOPLE[p.id] = p; BYNAME[p.name] = p; });
        render();
      })
      .catch(function () { peoplePending = false; });
  }

  // If signed in to Augur, adopt the profile name as the comment author (so the name
  // prompt is skipped and comments are attributed to the real person). On public
  // prototypes there's no login → /__me returns { user: null } and this is a no-op.
  loadMe();

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
    /* a pin that knows who wrote it: the face fills the teardrop, keeping the notch */
    '.pin.who{width:28px;height:28px;background:#fff;padding:0;overflow:hidden;}' +
    /* width/height come from avatarEl's inline style; only the teardrop notch is ours */
    '.pin.who .av{border-radius:50% 50% 50% 2px;}' +
    /* resolved keeps its green as a ring, not a fill — a filled disc would hide the face */
    '.pin.who.resolved{background:#fff;border-color:#16a34a;}' +
    /* hidden while the hover preview is up — its avatar column takes the pin's place */
    '.pin.under{visibility:hidden;}' +
    '.pin.active{outline:3px solid rgba(37,99,235,0.4);}' +
    '.pin.dragging{cursor:grabbing;opacity:0.85;}' +
    /* annotation pin: cat avatar, centred on its anchor, always-on. --rot is a
       per-pin random tilt (set in JS) so they read like hand-pressed stamps. */
    '.pin.anno{width:38px;height:38px;border-radius:50%;background:#fff;border:2px solid #fff;padding:0;overflow:hidden;transform:translate(-50%,-50%) rotate(var(--rot,0deg));box-shadow:0 2px 9px rgba(0,0,0,0.34);cursor:pointer;transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .18s ease;}' +
    '.pin.anno img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%;pointer-events:none;}' +
    '.pin.anno:hover{transform:translate(-50%,-50%) rotate(0deg) scale(1.16);box-shadow:0 7px 20px rgba(0,0,0,0.42);z-index:2;}' +
    '.pin.anno.active{outline:3px solid rgba(61,116,244,0.45);}' +
    '.av{flex:0 0 auto;border-radius:50%;object-fit:cover;display:block;}' +
    '.av.ini{display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;line-height:1;letter-spacing:.02em;}' +
    /* note bubble (delivery mode), styled like a cursor-chat bubble: blue pill + tail */
    '.atip{position:fixed;pointer-events:none;max-width:340px;background:#5672da;color:#fff;padding:11px 16px;border-radius:18px;font:400 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.22),0 1px 3px rgba(0,0,0,0.12);transform:translate(-50%,var(--ty,-100%)) scale(.9);transform-origin:50% 110%;opacity:0;transition:opacity .14s ease,transform .2s cubic-bezier(.34,1.56,.64,1);white-space:pre-wrap;word-wrap:break-word;}' +
    '.atip::after{content:"";position:absolute;left:var(--tail-x,50%);bottom:-4px;width:9px;height:9px;background:#5672da;transform:translateX(-50%) rotate(45deg);border-radius:0 0 3px 0;}' +
    '.atip.below{--ty:0;transform-origin:50% -10%;}' +
    '.atip.below::after{bottom:auto;top:-4px;border-radius:3px 0 0 0;}' +
    '.atip.show{opacity:1;transform:translate(-50%,var(--ty,-100%)) scale(1);}' +
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
    '.sb .it .num.face{background:0;padding:0;overflow:hidden;}' +
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
    /* scoped under .card so these beat the generic ".card button" (0,1,1) rule —
       otherwise its padding/border-radius crushes the avatar to a 0-width box */
    '.card .anno-toggle{flex:0 0 auto;width:26px;height:26px;min-width:0;border-radius:50%;border:2px solid #e5e7eb;background:#fff;padding:0;overflow:hidden;cursor:pointer;opacity:.4;filter:grayscale(1);transition:opacity .12s,filter .12s,border-color .12s;}' +
    '.card .anno-toggle img{width:100%;height:100%;object-fit:cover;display:block;}' +
    '.card .anno-toggle.on{opacity:1;filter:none;border-color:#f59e0b;}' +
    '.msg{padding:8px 0;border-top:1px solid #f0f0f0;display:flex;gap:10px;align-items:flex-start;}' +
    '.msg:first-of-type{border-top:0;}' +
    '.msg .mav{flex:0 0 auto;width:28px;}' +
    '.msg .mbody{min-width:0;flex:1;}' +
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
    /* ===== compose + thread (see src/review/COMMENTING-UX.md) ===== */
    /* progressive compose: a pin glyph + a field that reads as a grey pill when
       idle and a white box once focused/typed-in. one textarea throughout so the
       caret never jumps; auto-grown in JS. */
    '.compose{position:fixed;pointer-events:auto;display:flex;align-items:flex-start;gap:9px;width:332px;max-width:calc(100vw - 24px);}' +
    '.compose .cpin{flex:0 0 auto;width:26px;height:26px;border-radius:50% 50% 50% 2px;background:#2563eb;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);margin-top:2px;}' +
    '.cfield{position:relative;flex:1;min-width:0;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.22);padding:6px;transition:border-radius .14s ease;}' +
    '.cfield .nm{display:block;width:100%;font:inherit;font-size:13px;padding:7px 10px;border:0;border-bottom:1px solid #f0f0f0;border-radius:0;background:0;color:#1a1a1a;margin:0 0 2px;}' +
    '.cfield .nm:focus{outline:0;}' +
    '.cfield textarea{display:block;width:100%;border:0;outline:0;resize:none;font:inherit;color:#1a1a1a;background:0;margin:0;padding:8px 44px 8px 10px;min-height:0;max-height:180px;overflow-y:auto;line-height:1.45;}' +
    '.cfield textarea::placeholder{color:#9ca3af;}' +
    /* send arrow — disabled grey, enabled blue; pinned bottom-right of the field */
    /* .send/.ico are scoped to win over the legacy ".card button" rule (0,1,1) */
    '.compose .send,.card .send{position:absolute;right:8px;bottom:8px;width:30px;height:30px;border-radius:50%;border:0;padding:0;display:flex;align-items:center;justify-content:center;background:#e5e7eb;color:#fff;cursor:default;transition:background .12s ease;}' +
    '.send svg{width:16px;height:16px;display:block;}' +
    '.send.on{background:#2563eb;cursor:pointer;}' +
    /* collapsed pill look: no shadow/border box, grey rounded bar */
    '.cfield.idle{box-shadow:none;border-color:transparent;background:#f0f1f3;border-radius:999px;}' +
    '.cfield.idle textarea{padding-top:7px;padding-bottom:7px;}' +
    '.cfield.idle .send{background:transparent;color:#9ca3af;}' +
    '.cfield.idle .send svg{stroke:#9ca3af;}' +
    /* thread card header: title + right-aligned icon cluster */
    '.thead{display:flex;align-items:center;gap:2px;margin:-2px 0 10px;}' +
    '.thead strong{font-size:15px;font-weight:600;flex:1;}' +
    '.card .ico{flex:0 0 auto;width:30px;height:30px;border-radius:50%;border:0;background:0;padding:0;display:flex;align-items:center;justify-content:center;color:#5b626e;cursor:pointer;}' +
    '.ico:hover{background:#f0f1f3;}' +
    '.ico svg{width:18px;height:18px;display:block;}' +
    '.ico.res.done{color:#16a34a;}' +
    /* the cat annotation toggle in the header */
    '.ico.cat{overflow:hidden;opacity:.4;filter:grayscale(1);}' +
    '.ico.cat img{width:22px;height:22px;border-radius:50%;object-fit:cover;display:block;}' +
    '.ico.cat:hover{background:#f0f1f3;}' +
    '.ico.cat.on{opacity:1;filter:none;}' +
    /* messages */
    '.msg .mhead{display:flex;align-items:baseline;gap:7px;}' +
    '.msg .mhead .who{font-weight:600;font-size:14px;}' +
    '.msg .mhead .when{color:#9ca3af;font-size:13px;flex:1;}' +
    '.msg .mhead .mdel{flex:0 0 auto;width:24px;height:24px;border-radius:50%;border:0;background:0;color:#9ca3af;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .12s;}' +
    '.msg:hover .mhead .mdel{opacity:1;}' +
    '.msg .mhead .mdel:hover{background:#f0f1f3;color:#1a1a1a;}' +
    '.msg .mhead .mdel svg{width:16px;height:16px;}' +
    '.msg .body .mention{color:#2563eb;}' +
    /* override the legacy separators — stack messages cleanly, no rules */
    '.msgs .msg{border-top:0;padding:7px 0;}' +
    '.msgs .msg:first-of-type{padding-top:0;}' +
    '.msgs .msg .body{margin-top:3px;font-size:14px;line-height:1.5;}' +
    /* reply bar: same pill→box behaviour as compose */
    '.replybar{margin-top:6px;display:flex;gap:10px;align-items:center;}' +
    '.replybar .rav{flex:0 0 auto;}' +
    '.replybar .cfield{flex:1;min-width:0;}' +
    /* hover preview card — unfurls out of the pin, left edge → right */
    '.preview{position:fixed;pointer-events:none;width:280px;max-width:calc(100vw - 24px);background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.22);padding:13px 15px;opacity:0;display:flex;gap:10px;align-items:flex-start;transform:scaleX(.2);transform-origin:left center;transition:opacity .12s ease,transform .18s cubic-bezier(.34,1.56,.64,1);}' +
    '.preview .pav{flex:0 0 auto;}' +
    '.preview .pbody{min-width:0;flex:1;}' +
    '.preview.left{transform-origin:right center;flex-direction:row-reverse;}' +
    '.preview.show{opacity:1;transform:scaleX(1);}' +
    '.preview .phead{display:flex;align-items:baseline;gap:7px;margin-bottom:3px;}' +
    '.preview .who{font-weight:600;font-size:14px;}' +
    '.preview .when{color:#9ca3af;font-size:13px;}' +
    '.preview .body{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}' +
    '.preview .body .mention{color:#2563eb;}' +
    /* ===== Layer overlays — the "honesty" view. Each on-page canonical element is
       classified by the composition graph (window.__GV_GRAPH, derived from the real
       CSS) and boxed + badged by its LAYER. The badge carries a TEXT label (the layer
       word + component name), so colour is never the only cue (WCAG 1.4.1). The box is
       pointer-events:none so commenting passes through; only the badge is clickable,
       opening the recursive import-chain panel down to live token values. ===== */
    '.links{position:fixed;inset:0;pointer-events:none;}' +
    '.linkbox{position:fixed;pointer-events:none;border:1.5px dashed rgba(94,106,210,0.5);background:rgba(94,106,210,0.07);border-radius:6px;}' +
    '.linkbox.l-pattern{border-color:rgba(124,58,237,0.55);background:rgba(139,92,246,0.09);}' +
    '.linkbox.l-component{border-color:rgba(86,114,218,0.6);background:rgba(86,114,218,0.07);}' +
    '.linkbox.l-base{border-color:rgba(15,100,112,0.55);background:rgba(20,121,133,0.07);}' +
    /* health overlay — overrides the layer tint when a box is off-grid or detached */
    '.linkbox.h-offgrid{border-style:solid;border-color:rgba(229,72,77,0.85);background:rgba(229,72,77,0.08);}' +
    '.linkbox.h-detached{border-style:dashed;border-color:rgba(240,180,41,0.9);background:rgba(240,180,41,0.10);}' +
    '.linkbox.h-bespoke{border-style:solid;border-color:rgba(214,64,159,0.85);background:rgba(214,64,159,0.09);}' +
    '.linkbox.h-modified{border-style:solid;border-color:rgba(232,89,12,0.85);background:rgba(232,89,12,0.09);}' +
    '.linkbadge{position:absolute;top:0;left:8px;transform:translateY(-50%);pointer-events:auto;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px;background:#5672da;color:#fff;font:600 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.02em;padding:3px 7px 3px 7px;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,0.28);white-space:nowrap;transition:background .12s ease,transform .12s ease;}' +
    '.linkbadge .lyr{opacity:.72;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}' +
    '.linkbadge.l-pattern{background:#7c3aed;}.linkbadge.l-component{background:#5672da;}.linkbadge.l-base{background:#147985;}' +
    /* health chip on the badge: linked (good) · detached (forked) · off-grid (violation) */
    '.linkbadge .hb{margin-left:5px;padding:1px 5px 1px 5px;border-radius:999px;font:700 9px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-transform:uppercase;letter-spacing:.03em;}' +
    '.linkbadge .hb.linked{background:rgba(255,255,255,0.22);color:#fff;}' +
    '.linkbadge .hb.detached{background:#f0b429;color:#3a2c00;}' +
    '.linkbadge .hb.offgrid{background:#e5484d;color:#fff;}' +
    '.linkbadge .hb.bespoke{background:#d6409f;color:#fff;}' +
    '.linkbadge .hb.modified{background:#e8590c;color:#fff;}' +
    '.linkbadge.h-offgrid{box-shadow:0 0 0 2px rgba(229,72,77,0.85),0 1px 3px rgba(0,0,0,0.28);}' +
    '.linkbadge.h-detached{box-shadow:0 0 0 2px rgba(240,180,41,0.9),0 1px 3px rgba(0,0,0,0.28);}' +
    '.linkbadge.h-bespoke{box-shadow:0 0 0 2px rgba(214,64,159,0.85),0 1px 3px rgba(0,0,0,0.28);}' +
    '.linkbadge.h-modified{box-shadow:0 0 0 2px rgba(232,89,12,0.85),0 1px 3px rgba(0,0,0,0.28);}' +
    '.linkbadge:hover{transform:translateY(-50%) scale(1.06);filter:brightness(1.08);}' +
    '.linkbadge svg{width:10px;height:10px;display:block;flex:0 0 auto;}' +
    /* spacing shading (devtools-style) — drawn inside each box at the "+ Tokens" drill
       level: padding ring (teal), gaps between flex/grid children (purple), top/bottom
       margin (amber, outside the box). Each strip carries a px label so the actual
       resolved spacing is readable without opening the chain panel. */
    '.spc{position:absolute;pointer-events:none;display:flex;align-items:center;justify-content:center;overflow:visible;box-sizing:border-box;z-index:1;}' +
    '.spcpad{background:rgba(20,121,133,0.24);}' +
    '.spcgap{background:rgba(124,58,237,0.24);outline:1px dashed rgba(124,58,237,0.55);outline-offset:-1px;}' +
    '.spcmar{background:rgba(240,150,40,0.22);}' +
    '.spclbl{font:700 9px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;background:rgba(0,0,0,0.62);padding:1px 3px;border-radius:3px;white-space:nowrap;letter-spacing:.02em;}' +
    /* drill control — bottom-left pill cycling Components → +Base → +Tokens */
    '.drillctl{position:fixed;left:16px;bottom:16px;pointer-events:auto;display:inline-flex;align-items:center;gap:7px;background:#16171a;color:#fff;border:0;border-radius:999px;padding:8px 14px;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.28);}' +
    '.drillctl .dot{width:7px;height:7px;border-radius:50%;background:#7c3aed;box-shadow:0 0 0 2px rgba(255,255,255,.25);}' +
    '.drillctl b{font-weight:700;}' +
    /* import-chain panel — the recursive layer inspector */
    '.chainp{position:fixed;left:16px;bottom:60px;width:330px;max-width:calc(100vw - 32px);max-height:72vh;overflow:auto;pointer-events:auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 16px 50px rgba(0,0,0,0.26);padding:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;}' +
    '.chainp__h{position:sticky;top:0;background:#fff;border-bottom:1px solid #f0f0f0;border-radius:14px 14px 0 0;padding:13px 14px 11px;display:flex;align-items:flex-start;gap:8px;}' +
    '.chainp__h .ttl{flex:1;min-width:0;}' +
    '.chainp__h .nm{font-weight:700;font-size:14px;display:block;}' +
    '.chip{display:inline-flex;align-items:center;gap:4px;font:700 9.5px/1 -apple-system,BlinkMacSystemFont,sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff;padding:3px 7px;border-radius:999px;margin-top:4px;}' +
    '.chip.l-pattern{background:#7c3aed;}.chip.l-component{background:#5672da;}.chip.l-base{background:#147985;}.chip.l-token{background:#0e0f12;}' +
    '.chainp__x{flex:0 0 auto;width:26px;height:26px;border:0;background:0;color:#9ca3af;cursor:pointer;border-radius:50%;font-size:17px;line-height:1;}' +
    '.chainp__x:hover{background:#f0f1f3;color:#1a1a1a;}' +
    '.chainp__jump{display:block;margin:0 14px 10px;text-align:center;text-decoration:none;background:#f3f4f7;color:#16171a;font-weight:600;font-size:12px;padding:8px;border-radius:9px;}' +
    '.chainp__jump:hover{background:#e9ebf0;}' +
    '.chainp__sec{padding:10px 14px;border-top:1px solid #f4f4f6;}' +
    '.chainp__sec h5{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af;font-weight:700;}' +
    '.chainrow{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:0;padding:6px 7px;border-radius:8px;cursor:pointer;font:inherit;color:#1a1a1a;}' +
    '.chainrow:hover{background:#f5f6f8;}' +
    '.chainrow .cn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.chainrow .cn code{font-size:11.5px;color:#4650b8;}' +
    '.chainrow .arr{color:#c2c6cf;flex:0 0 auto;}' +
    '.tokrow{display:flex;align-items:center;gap:8px;padding:5px 7px;}' +
    '.tokrow .sw{flex:0 0 auto;width:18px;height:18px;border-radius:5px;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.14);}' +
    '.tokrow .tk{min-width:0;flex:1;}' +
    '.tokrow .tk code{font-size:11px;color:#1a1a1a;word-break:break-all;}' +
    '.tokrow .tk .res{display:block;color:#6b7280;font-size:10.5px;margin-top:1px;}' +
    '.tokrow .tk .res b{color:#4650b8;font-weight:600;}' +
    '.chainp__empty{padding:8px 14px 14px;color:#9ca3af;font-size:12px;}' +
    '</style>' +
    '<div class="layer hidden">' +
    '  <div class="catcher hidden"></div>' +
    '  <div class="links"></div>' +
    '  <button class="drillctl hidden" type="button" title="Layers — click or press ↑/↓ to change depth (Components → + Base → + Tokens shows spacing)"><span class="dot"></span>Layers: <b></b></button>' +
    '  <div class="chainp hidden"></div>' +
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
    '  <div class="preview"></div>' +
    '  <div class="toast"></div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var layer = $(".layer"), catcher = $(".catcher"), pinsEl = $(".pins"), linksEl = $(".links"),
      sb = $(".sb"), listEl = $(".list"), cntEl = $(".cnt"), cnt2El = $(".cnt2"),
      hintEl = $(".hint"), tabEl = $(".tab"), cardholder = $(".cardholder"),
      tipEl = $(".atip"), previewEl = $(".preview"), toastEl = $(".toast"),
      drillEl = $(".drillctl"), chainEl = $(".chainp");

  // Shared SVG glyphs for the overlay chrome.
  var SVG = {
    send: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M8.5 12.2l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

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
    renderLinks();
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
        var lp = authorOf(t);
        if (lp) {
          var n2 = li.querySelector(".num");
          n2.textContent = ""; n2.className = "num face";
          n2.appendChild(avatarEl(lp, 20));
        } else {
          li.querySelector(".num").textContent = String(i + 1);
        }
      }
      li.querySelector(".body").textContent = (t.messages[0] && t.messages[0].body) || "(empty)";
      li.querySelector(".meta").textContent = (anno ? "Annotation · " : "") + (t.messages[0] ? t.messages[0].author : "") +
        (away ? " · ↗ on another screen" : "") + (t.resolved ? " · resolved" : "");
      if (away) li.querySelector(".meta").className = "meta away";
      li.addEventListener("click", function () { openOrNavigate(t.id); });
      listEl.appendChild(li);
    });
  }

  // Initials + a stable colour from a name alone, for a verified author we could not
  // resolve — /__people unreachable, or the localStorage fallback path with no server
  // at all. A known person must never collapse back to an anonymous number.
  var AV_COLORS = ["#4f46e5", "#0e7490", "#b45309", "#be123c", "#15803d", "#7c3aed", "#0369a1", "#a21caf"];
  function fromName(name) {
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    var ini = !parts.length ? "?"
      : (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    var h = 0, s = String(name).trim().toLowerCase();
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return { id: null, name: name, initials: ini, color: AV_COLORS[h % AV_COLORS.length], avatar: null };
  }

  // null → this comment gets today's numbered blue pin. Order matters: an id beats a
  // name, and an UNVERIFIED name resolves to nothing at all — an anonymous commenter
  // never earns a face, however they signed themselves.
  function personFor(m) {
    if (!m) return null;
    if (m.by && PEOPLE[m.by]) return PEOPLE[m.by];
    if (!m.verified || !m.author) return null;
    if (BYNAME[m.author]) return BYNAME[m.author];
    // Verified, but the roster is unavailable or hasn't answered yet.
    return fromName(m.author);
  }
  function authorOf(t) { return personFor(t && t.messages && t.messages[0]); }

  // The one avatar implementation every surface uses: photo when there is one,
  // initials on the person's colour when there isn't. Never a silhouette.
  function avatarEl(p, size) {
    var e;
    if (p && p.avatar) {
      e = document.createElement("img");
      e.src = p.avatar;
      e.alt = "";
      // A dead photo URL must degrade to initials, not a broken-image glyph.
      e.addEventListener("error", function () {
        var f = initialsEl(p, size);
        if (e.parentNode) e.parentNode.replaceChild(f, e);
      });
    } else {
      e = initialsEl(p, size);
    }
    e.className = "av";
    e.style.width = size + "px";
    e.style.height = size + "px";
    return e;
  }
  function initialsEl(p, size) {
    var s = document.createElement("span");
    s.className = "av ini";
    s.textContent = (p && p.initials) || "?";
    s.style.background = (p && p.color) || "#6b7280";
    s.style.fontSize = Math.max(9, Math.round(size * 0.4)) + "px";
    s.style.width = size + "px";
    s.style.height = size + "px";
    return s;
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
        b.style.setProperty("--rot", annoRot(t.id) + "deg");
        b.addEventListener("mouseenter", function () { showTip(b, t.id); });
        b.addEventListener("mouseleave", hideTip);
      } else {
        var who = authorOf(t);
        if (who) {
          b.classList.add("who");
          // 24, not 28: .pin.who is a 28px border-box with a 2px border, so its
          // padding box — what overflow:hidden clips to — is 24px square.
          b.appendChild(avatarEl(who, 24));
          b.title = who.name;
        } else {
          b.textContent = String(nums[t.id] || "");
        }
        // Hover preview card that unfurls out of the pin (review mode only).
        (function (btn, tid) {
          btn.addEventListener("mouseenter", function () {
            if (state.openId === tid) return;
            clearTimeout(previewTimer);
            previewTimer = setTimeout(function () { showPreview(btn, tid); }, 150);
          });
          btn.addEventListener("mouseleave", hidePreview);
        })(b, t.id);
      }
      attachPinDrag(b, t.id);
      pinsEl.appendChild(b);
    });
  }

  /* ---------- Recursive layer overlay (the honesty view) ----------
   * Driven by window.__GV_GRAPH (graph.js, DERIVED from the canonical CSS at build) +
   * window.__GV_LINKED (which canonical assets this page is in sync with). Every
   * on-page canonical element is classified by the graph into a LAYER (base/component/
   * pattern); the badge proves the import chain by recursing into the panel:
   *   pattern → its components → their base atoms → the tokens each one drinks (with
   *   LIVE resolved values from getComputedStyle, so tenant theming shows through).
   * A drilldown control reveals deeper layers; a forked/drifted dependency drops out
   * because its deps aren't in __GV_LINKED. This is the inverse of asserting links: it
   * recomputes them from the real CSS graph every render. */
  var GRAPH = window.__GV_GRAPH || { classes: {}, tokens: {} };
  var LAYER_RANK = { base: 1, component: 2, components: 2, pattern: 3 };
  var DRILL = ["Components", "+ Base", "+ Tokens"]; // 0,1,2
  function normLayer(l) { return l === "components" ? "component" : l; }
  function famRoot(cls) { return cls.replace(/__.*/, "").replace(/--.*/, ""); }
  function depsMet(deps) {
    var L = window.__GV_LINKED;
    if (!L || !L.length || !deps) return false;
    for (var i = 0; i < deps.length; i++) if (L.indexOf(deps[i]) < 0) return false;
    return true;
  }
  // Best (highest-layer, deps-met) graph classification for one element, or null.
  function classifyEl(el) {
    if (!el.classList || !el.classList.length) return null;
    var best = null;
    for (var i = 0; i < el.classList.length; i++) {
      var c = el.classList[i];
      if (c.indexOf("gv-") !== 0 && c.indexOf("sv-") !== 0) continue;
      // Only the family ROOT (or a --modifier of it) marks a component root; a BEM
      // __part (e.g. .gv-feed__head) is internal scaffolding, not its own root, so it
      // must not badge as the whole component or it spawns phantom duplicate roots.
      if (c.indexOf("__") >= 0) continue;
      var fam = famRoot(c), info = GRAPH.classes[fam];
      if (!info || !info.layer || !info.label) continue; // only labelled families badge
      if (!depsMet(info.deps)) continue;                 // honesty: drifted → no badge
      var rank = LAYER_RANK[info.layer] || 0;
      if (!best || rank > best.rank) best = { family: fam, info: info, layer: normLayer(info.layer), rank: rank };
    }
    return best;
  }
  // The elements to box at the current drill level: outermost composites always,
  // plus outermost base atoms once drilled in.
  function collectLayered() {
    var all = [], els = document.querySelectorAll("[class]");
    for (var i = 0; i < els.length; i++) {
      if (host.contains(els[i])) continue;
      var c = classifyEl(els[i]); if (!c) continue;
      c.el = els[i]; all.push(c);
    }
    var outermost = function (list) {
      return list.filter(function (a) {
        return !list.some(function (b) { return b.el !== a.el && b.el.contains(a.el); });
      });
    };
    var composites = outermost(all.filter(function (a) { return a.rank >= 2; }));
    var show = composites.slice();
    if (state.drill >= 1) {
      var bases = outermost(all.filter(function (a) { return a.rank === 1; }));
      show = show.concat(bases);
    }
    return show;
  }
  var LINKICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 12h6M9.5 8H7a4 4 0 0 0 0 8h2.5M14.5 8H17a4 4 0 0 1 0 8h-2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  /* ---------- health: linked / detached / bespoke / modified / off-grid ----------
   * The badge already proves LINKAGE (it only renders for a deps-met canonical family).
   * Health adds the second axis (right vs off-grid), shown at the same time as the layer:
   *   • off-grid — the box's own computed SPACING sits off the space scale. The scale is
   *     the 8-point grid with a 4-point half-step, so on-grid = any MULTIPLE OF 4. We read
   *     getComputedStyle and check padding (all sides), row/column gap, and TOP/BOTTOM
   *     margin only — left/right margins are skipped because `margin:auto` centering
   *     resolves to arbitrary px and would false-positive. Scope matches lint INV-9:
   *     positive integer px ≥4 not divisible by 4.
   *   • detached — a deliberately forked instance, flagged by data-gv-detached on the
   *     element (or window.__GV_DETACHED listing the family). Detach lands in Phase 4;
   *     this lights up automatically once it does.
   *   • linked — neither of the above (the good default). */
  function pxOffGrid(v) {
    var m = /^(-?\d*\.?\d+)px$/.exec(v); if (!m) return false;
    var n = parseFloat(m[1]);
    return Number.isInteger(n) && n >= 4 && n % 4 !== 0;
  }
  function spacingHealth(el) {
    var cs; try { cs = getComputedStyle(el); } catch (e) { return null; }
    var props = ["paddingTop","paddingRight","paddingBottom","paddingLeft","rowGap","columnGap","marginTop","marginBottom"];
    var hits = [];
    for (var i = 0; i < props.length; i++) { if (pxOffGrid(cs[props[i]])) hits.push(props[i].replace(/([A-Z])/g, "-$1").toLowerCase() + ":" + cs[props[i]]); }
    return hits.length ? hits : null;
  }
  function isDetached(el, fam) {
    if (el.hasAttribute && el.hasAttribute("data-gv-detached")) return true;
    var D = window.__GV_DETACHED;
    return !!(D && D.length && D.indexOf(fam) >= 0);
  }
  /* Provenance — the honesty signal class-lineage alone can't give. The runtime stamps
   * data-gv-rendered (+ data-gv-hash) on a host it actually rendered (GV.mountAll/mount).
   * A composite (component/pattern, rank≥2) NOT inside such a host wears the .gv-* class
   * but was hand-authored → "bespoke". One that IS inside a rendered host but whose live
   * markup no longer hashes to the stamp was edited after mount → "modified". Base atoms
   * (rank 1) are meant to be hand-written, so they're exempt. */
  function provenanceOf(el, rank) {
    if (!(rank >= 2) || !el.closest) return null;
    var host = el.closest("[data-gv-rendered]");
    if (!host) return { state: "bespoke", detail: "bespoke — hand-authored markup wearing the class, not a canonical instance" };
    var stored = host.getAttribute("data-gv-hash"), fn = (window.GV && GV.hash);
    if (stored && fn && fn(host.innerHTML) !== stored) return { state: "modified", detail: "modified — a canonical instance edited after it was rendered" };
    return null;
  }
  function healthOf(el, fam, rank) {
    if (isDetached(el, fam)) return { state: "detached", detail: "detached — forked from canonical" };
    var prov = provenanceOf(el, rank);
    if (prov) return prov;
    var off = spacingHealth(el);
    if (off) return { state: "offgrid", detail: "off-grid spacing: " + off.join(", ") };
    return { state: "linked", detail: "linked — tracks canonical, on-grid" };
  }

  var linkBoxes = []; // {box, el}
  function renderLinks() {
    linksEl.textContent = ""; linkBoxes = [];
    drillEl.classList.toggle("hidden", !state.active);
    if (!state.active) { closeChain(); return; } // overlays only while review mode is on
    drillEl.querySelector("b").textContent = DRILL[state.drill] || DRILL[0];
    collectLayered().forEach(function (it) {
      var r = it.el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return; // hidden / collapsed
      var h = healthOf(it.el, it.family, it.rank);
      var box = document.createElement("div");
      box.className = "linkbox l-" + slugClass(it.layer) + " h-" + slugClass(h.state);
      if (state.drill >= 2) drawSpacing(box, it.el); // append shades first → badge stays on top
      var badge = document.createElement("button");
      badge.type = "button";
      badge.className = "linkbadge l-" + slugClass(it.layer) + " h-" + slugClass(h.state);
      badge.title = it.layer + " · " + it.info.label + " · " + h.detail + " — open the import chain";
      badge.innerHTML = LINKICON + '<span class="lyr">' + escHtml(it.layer) + '</span> ' + escHtml(it.info.label) +
        '<span class="hb ' + slugClass(h.state) + '">' + escHtml(h.state) + '</span>';
      (function (fam, el) {
        badge.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openChain(fam, el); });
      })(it.family, it.el);
      box.appendChild(badge);
      linksEl.appendChild(box);
      linkBoxes.push({ box: box, el: it.el });
    });
    positionLinks();
  }
  function positionLinks() {
    for (var i = 0; i < linkBoxes.length; i++) {
      var lb = linkBoxes[i], r = lb.el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) { lb.box.style.display = "none"; continue; }
      lb.box.style.display = "";
      lb.box.style.left = r.left + "px"; lb.box.style.top = r.top + "px";
      lb.box.style.width = r.width + "px"; lb.box.style.height = r.height + "px";
    }
  }

  /* ---------- spacing shading (the "+ Tokens" devtools view) ----------
   * At drill ≥ 2 each rendered box gets its real resolved spacing painted ON the box:
   * the padding ring, the gaps between flex/grid children, and top/bottom margin. All
   * offsets are RELATIVE to the box's border-box origin (its left/top), so the shading
   * tracks the box for free on scroll — no per-frame recompute. Resize rebuilds (layout
   * may reflow). Reads getComputedStyle so tenant theming / responsive values show real. */
  function spx(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function shade(box, cls, l, t, w, h, label) {
    if (w <= 0 || h <= 0) return;
    var d = document.createElement("div");
    d.className = "spc " + cls;
    d.style.left = l + "px"; d.style.top = t + "px"; d.style.width = w + "px"; d.style.height = h + "px";
    if (label != null) { var s = document.createElement("span"); s.className = "spclbl"; s.textContent = label; d.appendChild(s); }
    box.appendChild(d);
  }
  function drawGaps(box, el, cs, rect) {
    var disp = cs.display || "";
    if (disp.indexOf("flex") < 0 && disp.indexOf("grid") < 0) return;
    var kids = [], ch = el.children;
    for (var i = 0; i < ch.length; i++) {
      if (host.contains(ch[i])) continue;
      var cr = ch[i].getBoundingClientRect();
      if (cr.width >= 1 && cr.height >= 1) kids.push(cr);
    }
    for (var j = 0; j < kids.length - 1; j++) {
      var a = kids[j], b = kids[j + 1];
      var hg = b.left - a.right, vg = b.top - a.bottom;
      if (hg > 0 && hg < 200 && (vg <= 0 || hg >= vg)) {        // column gap (row layout)
        var top = Math.max(a.top, b.top), bot = Math.min(a.bottom, b.bottom);
        shade(box, "spcgap", a.right - rect.left, top - rect.top, hg, Math.max(bot - top, 1), Math.round(hg));
      } else if (vg > 0 && vg < 200) {                           // row gap (column layout)
        var lft = Math.max(a.left, b.left), rgt = Math.min(a.right, b.right);
        shade(box, "spcgap", lft - rect.left, a.bottom - rect.top, Math.max(rgt - lft, 1), vg, Math.round(vg));
      }
    }
  }
  function drawSpacing(box, el) {
    var cs; try { cs = getComputedStyle(el); } catch (e) { return; }
    var rect = el.getBoundingClientRect();
    var W = rect.width, H = rect.height;
    var bt = spx(cs.borderTopWidth), br = spx(cs.borderRightWidth), bb = spx(cs.borderBottomWidth), bl = spx(cs.borderLeftWidth);
    var pt = spx(cs.paddingTop), pr = spx(cs.paddingRight), pb = spx(cs.paddingBottom), pl = spx(cs.paddingLeft);
    var iw = W - bl - br, ih = H - bt - bb; // padding-box (border-box minus borders)
    // padding ring
    if (pt > 0) shade(box, "spcpad", bl, bt, iw, pt, Math.round(pt));
    if (pb > 0) shade(box, "spcpad", bl, bt + ih - pb, iw, pb, Math.round(pb));
    if (pl > 0) shade(box, "spcpad", bl, bt + pt, pl, ih - pt - pb, Math.round(pl));
    if (pr > 0) shade(box, "spcpad", bl + iw - pr, bt + pt, pr, ih - pt - pb, Math.round(pr));
    // top/bottom margin (outside the box). Left/right skipped — margin:auto centering
    // resolves to arbitrary px and would shade huge misleading bands (same as INV-9).
    var mt = spx(cs.marginTop), mb = spx(cs.marginBottom);
    if (mt > 0 && mt < 400) shade(box, "spcmar", 0, -mt, W, mt, "m " + Math.round(mt));
    if (mb > 0 && mb < 400) shade(box, "spcmar", 0, H, W, mb, "m " + Math.round(mb));
    // gaps between flex/grid children
    drawGaps(box, el, cs, rect);
  }

  // Escapes for BOTH text and attribute positions. Quotes matter: several templates below
  // drop these values inside class="…" / title="…" / style="…", where a bare " breaks out
  // and adds attributes. In a text position &quot; renders as " so nothing changes visually.
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // A CSS class fragment is a controlled vocabulary (base / component / pattern), and it
  // is built from graph.js, which is space-published content. Anything else is dropped
  // rather than escaped: a class name is not a place to render arbitrary text.
  function slugClass(s) { return /^[a-z0-9-]+$/.test(String(s)) ? String(s) : ""; }
  // Library page URL for a family/layer (base/, components/, patterns/).
  function libUrl(info) { return info.url || null; }

  /* ---------- the recursive import-chain panel ---------- */
  // Render one token row with its LIVE resolved value (getComputedStyle from the
  // element, so tenant-themed vars show their real value here) + the static raw +
  // the alias chain from the graph.
  function tokenRow(name, scopeEl) {
    var t = GRAPH.tokens[name] || {};
    var live = "";
    try { live = getComputedStyle(scopeEl).getPropertyValue(name).trim(); } catch (e) {}
    var raw = t.raw || t.value || "";
    var col = /^(#|rgb|hsl)/i.test(live) ? live : (/^(#|rgb|hsl|color-mix)/i.test(raw) ? raw : "");
    var chain = (t.chain && t.chain.length > 1) ? t.chain.join(" → ") + " → " + raw : "";
    var row = document.createElement("div");
    row.className = "tokrow";
    row.innerHTML =
      (col ? '<span class="sw" style="background:' + escHtml(col) + '"></span>' : '<span class="sw" style="background:#f3f4f7"></span>') +
      '<span class="tk"><code></code><span class="res"></span></span>';
    row.querySelector("code").textContent = name;
    var res = row.querySelector(".res");
    res.innerHTML = (live ? 'live <b>' + escHtml(live) + '</b>' : (raw ? '<b>' + escHtml(raw) + '</b>' : "")) +
      (chain ? '<br>' + escHtml(chain) : "");
    return row;
  }
  function chainRow(label, sublabel, onClick) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "chainrow";
    b.innerHTML = '<span class="cn"></span><span class="arr">›</span>';
    b.querySelector(".cn").innerHTML = '<strong>' + escHtml(label) + '</strong>' + (sublabel ? ' <code>' + escHtml(sublabel) + '</code>' : "");
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  }
  // Descendant elements of `el` classified at a given rank (deduped to outermost).
  function descendantsOfRank(el, rank) {
    var found = [], all = el.querySelectorAll("[class]");
    for (var i = 0; i < all.length; i++) {
      if (host.contains(all[i])) continue;
      var c = classifyEl(all[i]);
      if (c && c.rank === rank && all[i] !== el) { c.el = all[i]; found.push(c); }
    }
    return found.filter(function (a) {
      return !found.some(function (b) { return b.el !== a.el && b.el.contains(a.el); });
    });
  }
  function openChain(family, el) {
    var info = GRAPH.classes[family]; if (!info) return;
    var layer = normLayer(info.layer);
    chainEl.classList.remove("hidden");
    chainEl.textContent = "";
    // header
    var h = document.createElement("div"); h.className = "chainp__h";
    h.innerHTML = '<span class="ttl"><span class="nm"></span><span class="chip l-' + slugClass(layer) + '">' + escHtml(layer) + '</span></span>' +
      '<button class="chainp__x" title="Close">&times;</button>';
    h.querySelector(".nm").textContent = info.label || family;
    h.querySelector(".chainp__x").addEventListener("click", closeChain);
    chainEl.appendChild(h);
    // jump to library
    var url = libUrl(info);
    if (url) {
      var jump = document.createElement("a");
      jump.className = "chainp__jump"; jump.href = url; jump.target = "_blank"; jump.rel = "noopener";
      jump.textContent = "Open " + layer + " in library ↗";
      chainEl.appendChild(jump);
    }
    var addSec = function (title) {
      var s = document.createElement("div"); s.className = "chainp__sec";
      s.innerHTML = '<h5>' + escHtml(title) + '</h5>';
      chainEl.appendChild(s); return s;
    };
    // pattern → the components inside it
    if (layer === "pattern") {
      var comps = descendantsOfRank(el, 2);
      var cs = addSec("Composes " + comps.length + " component" + (comps.length === 1 ? "" : "s"));
      if (!comps.length) cs.innerHTML += '<div class="chainp__empty">No nested canonical components detected here.</div>';
      comps.forEach(function (c) {
        cs.appendChild(chainRow(c.info.label, c.family, function () { openChain(c.family, c.el); }));
      });
    }
    // component/pattern → base atoms inside it
    if (layer !== "base") {
      var bases = descendantsOfRank(el, 1);
      var bs = addSec("Built from " + bases.length + " base atom" + (bases.length === 1 ? "" : "s"));
      if (!bases.length) bs.innerHTML += '<div class="chainp__empty">No nested base atoms detected (it may draw straight from tokens).</div>';
      bases.forEach(function (b) {
        bs.appendChild(chainRow(b.info.label, b.family, function () { openChain(b.family, b.el); }));
      });
    }
    // tokens this family drinks (always shown for base; for composites shown when
    // drilled to "+ Tokens", else summarised with a reveal).
    var toks = info.tokens || [];
    var ts = addSec("Drinks from " + toks.length + " token" + (toks.length === 1 ? "" : "s"));
    var showTokens = layer === "base" || state.drill >= 2;
    if (!toks.length) {
      ts.innerHTML += '<div class="chainp__empty">No direct tokens — it inherits from its base atoms.</div>';
    } else if (showTokens) {
      toks.forEach(function (name) { ts.appendChild(tokenRow(name, el)); });
    } else {
      var reveal = document.createElement("button");
      reveal.type = "button"; reveal.className = "chainrow";
      reveal.innerHTML = '<span class="cn">Show ' + toks.length + ' token value' + (toks.length === 1 ? "" : "s") + ' (live)</span><span class="arr">+</span>';
      reveal.addEventListener("click", function (e) {
        e.stopPropagation(); reveal.remove();
        toks.forEach(function (name) { ts.appendChild(tokenRow(name, el)); });
      });
      ts.appendChild(reveal);
    }
    chainOpenFor = { family: family, el: el };
  }
  var chainOpenFor = null;
  function closeChain() { chainEl.classList.add("hidden"); chainEl.textContent = ""; chainOpenFor = null; }

  function reposition() {
    var pins = pinsEl.children, items = pinThreads().filter(function (t) { return pinXY(t); });
    for (var i = 0; i < pins.length && i < items.length; i++) {
      var xy = pinXY(items[i]);
      if (xy) { pins[i].style.left = xy.x + "px"; pins[i].style.top = xy.y + "px"; }
    }
    if (openCardAnchor) positionCard(openCardAnchor);
    if (tipEl.classList.contains("show")) hideTip(true); // anchor moved → drop bubble
    if (previewEl.classList.contains("show")) hidePreview();
    positionLinks();
  }

  /* ---------- pin dragging ---------- */

  function attachPinDrag(btn, id) {
    var sx, sy, moved, dragging, canDrag;
    btn.addEventListener("pointerdown", function (e) {
      // Draggable only in review mode — pins paint above the add-mode catcher.
      // With review off (delivery mode) a pin is read-only: tap toggles its note.
      e.preventDefault();
      e.stopPropagation();
      hidePreview();
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
    tipEl.classList.add("show"); // show first so offsetWidth/Height are measurable
    var r = btn.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight, m = 8;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var pinCx = r.left + r.width / 2, half = w / 2;
    // Clamp the (centre-anchored) bubble so neither edge leaves the viewport.
    var cx = pinCx;
    if (w + 2 * m <= vw) cx = Math.max(m + half, Math.min(pinCx, vw - m - half));
    // Sit above the pin, but flip below if that would clip the top edge.
    var below = (r.top - 10 - h) < m && (r.bottom + 10 + h) <= vh - m;
    tipEl.classList.toggle("below", below);
    tipEl.style.left = cx + "px";
    tipEl.style.top = (below ? r.bottom + 10 : r.top - 10) + "px";
    // Keep the tail pointing at the pin even after the body was nudged inward.
    var tailX = Math.max(12, Math.min(w - 12, pinCx - (cx - half)));
    tipEl.style.setProperty("--tail-x", tailX + "px");
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

  // Render a message body, highlighting @mentions as accent tokens. Builds nodes
  // from split text (never innerHTML of user input) so it's injection-safe.
  function renderBody(el, text) {
    el.textContent = "";
    String(text == null ? "" : text).split(/(@[\w-]+)/g).forEach(function (p) {
      if (!p) return;
      if (/^@[\w-]+$/.test(p)) {
        var s = document.createElement("span"); s.className = "mention"; s.textContent = p; el.appendChild(s);
      } else el.appendChild(document.createTextNode(p));
    });
  }

  // Wire one `.cfield` (a textarea + send button, optional name input) with the
  // shared compose behaviour: grey pill when idle, white box when focused/typed-in,
  // auto-grow, ⏎ to send / Shift+⏎ newline, send enabled only with text.
  function wireField(cfield, onSubmit) {
    var tx = cfield.querySelector(".tx"), send = cfield.querySelector(".send"), nm = cfield.querySelector(".nm");
    var focused = false;
    function grow() { tx.style.height = "auto"; tx.style.height = Math.min(tx.scrollHeight, 180) + "px"; }
    function look() {
      cfield.classList.toggle("idle", !focused && !tx.value.trim() && !(nm && nm.value.trim()));
      send.classList.toggle("on", !!tx.value.trim());
    }
    function fire() {
      var text = tx.value.trim(); if (!text) { tx.focus(); return; }
      onSubmit(text, nm ? nm.value.trim() : "");
    }
    tx.addEventListener("input", function () { grow(); look(); });
    tx.addEventListener("focus", function () { focused = true; look(); });
    tx.addEventListener("blur", function () { focused = false; look(); });
    if (nm) {
      nm.addEventListener("focus", function () { focused = true; look(); });
      nm.addEventListener("blur", function () { focused = false; look(); });
    }
    tx.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); fire(); }
    });
    send.addEventListener("click", fire);
    grow(); look();
    return { focus: function () { (nm || tx).focus(); } };
  }

  function composeNew(loc) {
    hidePreview();
    state.openId = null; renderPins(); renderList();
    cardholder.textContent = "";
    var wrap = document.createElement("div");
    wrap.className = "compose";
    var needName = !getName();
    wrap.innerHTML = '<span class="cpin"></span>' +
      '<div class="cfield idle">' +
      (needName ? '<input class="nm" placeholder="Your name" />' : '') +
      '<textarea class="tx" rows="1" placeholder="Add a comment"></textarea>' +
      '<button class="send" title="Send">' + SVG.send + '</button>' +
      '</div>';
    cardholder.appendChild(wrap);
    openCardAnchor = { x: loc.px - window.scrollX, y: loc.py - window.scrollY };
    positionCard(openCardAnchor);
    var api = wireField(wrap.querySelector(".cfield"), function (text, name) {
      name = name || getName() || "Anonymous";
      if (wrap.querySelector(".nm")) setName(name);
      var thread = { id: uid(), sel: loc.sel, fx: loc.fx, fy: loc.fy, px: loc.px, py: loc.py,
        view: loc.view, screen: loc.screen, resolved: false, annotation: false,
        messages: [{ author: name, by: ME && ME.id, verified: !!ME, body: text, at: nowIso() }] };
      closeCard();
      mutate({ op: "add", thread: thread });
      toast("Comment added");
    });
    api.focus();
  }

  function delThread(id) {
    if (!confirm("Delete this comment thread?")) return;
    deleted[id] = 1;
    mutate({ op: "delete", id: id }).then(closeCard);
  }
  function delMsg(id, index) {
    if (index === 0) { delThread(id); return; }   // root message = whole thread
    if (!confirm("Delete this reply?")) return;
    mutate({ op: "delmsg", id: id, index: index }).then(function () { openThread(id); });
  }

  function openThread(id) {
    var t = find(id); if (!t) return;
    hidePreview();
    state.mode = "browse"; state.openId = id;
    var xy = pinXY(t) || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    render();
    var card = makeCard(xy);
    // Header: title + icon cluster — ⋯ delete · cat annotate · ✓ resolve · ✕ close.
    card.innerHTML = '<div class="thead"><strong>' + (t.annotation ? 'Annotation' : 'Comment') + '</strong>' +
      '<button class="ico del" title="Delete">' + SVG.dots + '</button>' +
      '<button class="ico cat' + (t.annotation ? ' on' : '') + '" title="' +
      (t.annotation ? 'Annotation — always-on, skipped on resolve. Click to make it a normal comment.' : 'Make this an annotation — always-on dev note, skipped when resolving comments.') +
      '"><img src="' + CAT + '" alt=""></button>' +
      '<button class="ico res' + (t.resolved ? ' done' : '') + '" title="' + (t.resolved ? 'Reopen' : 'Resolve') + '">' + SVG.check + '</button>' +
      '<button class="ico close" title="Close">' + SVG.close + '</button></div>' +
      '<div class="msgs"></div>' +
      '<div class="replybar"><div class="rav"></div><div class="cfield idle">' +
      '<textarea class="tx" rows="1" placeholder="Reply"></textarea>' +
      '<button class="send" title="Send">' + SVG.send + '</button></div></div>';
    var msgs = card.querySelector(".msgs");
    var rav = card.querySelector(".replybar .rav");
    if (ME) rav.appendChild(avatarEl(ME, 28)); else rav.remove();
    t.messages.forEach(function (m, i) {
      var d = document.createElement("div"); d.className = "msg";
      d.innerHTML = '<div class="mav"></div><div class="mbody">' +
        '<div class="mhead"><span class="who"></span><span class="when" data-iso=""></span>' +
        '<button class="mdel" title="Delete">' + SVG.dots + '</button></div>' +
        '<div class="body"></div></div>';
      var mp = personFor(m);
      var mav = d.querySelector(".mav");
      // Unlike .rav/.pav (a single, non-stacked instance), .mav sits in a column of
      // sibling messages — removing it on an anonymous row would collapse its flex
      // gap and shift that row's body to a different left edge than faced rows
      // above/below. Leave the (empty) wrapper in place; ".msg .mav{width:28px}"
      // reserves the same column width whether or not it holds a face.
      if (mp) mav.appendChild(avatarEl(mp, 28));
      d.querySelector(".who").textContent = m.author;
      var w = d.querySelector(".when"); w.textContent = fmt(m.at); w.setAttribute("data-iso", m.at || "");
      renderBody(d.querySelector(".body"), m.body);
      d.querySelector(".mdel").addEventListener("click", function () { delMsg(id, i); });
      msgs.appendChild(d);
    });
    positionCard(xy);
    wireField(card.querySelector(".replybar .cfield"), function (text) {
      mutate({ op: "reply", id: id, message: { author: getName() || "Anonymous",
        by: ME && ME.id, verified: !!ME, body: text, at: nowIso() } })
        .then(function () { openThread(id); });
    });
    card.querySelector(".res").addEventListener("click", function () {
      mutate({ op: "resolve", id: id, resolved: !t.resolved }).then(closeCard);
    });
    card.querySelector(".close").addEventListener("click", closeCard);
    card.querySelector(".cat").addEventListener("click", function () {
      var willBe = !t.annotation;
      mutate({ op: "annotate", id: id, annotation: willBe }).then(function () {
        toast(willBe ? "Now an annotation · always-on for devs" : "Back to a comment");
        openThread(id);
      });
    });
    card.querySelector(".del").addEventListener("click", function () { delThread(id); });
  }

  /* ---------- hover preview (grows out of the pin, left → right) ---------- */

  var previewTimer = null;
  function showPreview(btn, id) {
    var t = find(id); if (!t) return;
    var m = t.messages[0] || {};
    var who = personFor(m);
    previewEl.innerHTML = '<div class="pav"></div><div class="pbody">' +
      '<div class="phead"><span class="who"></span><span class="when" data-iso=""></span></div>' +
      '<div class="body"></div></div>';
    var pav = previewEl.querySelector(".pav");
    if (who) pav.appendChild(avatarEl(who, 28)); else pav.remove();
    previewEl.querySelector(".who").textContent = m.author || "";
    var w = previewEl.querySelector(".when"); w.textContent = fmt(m.at); w.setAttribute("data-iso", m.at || "");
    renderBody(previewEl.querySelector(".body"), m.body);
    previewEl.classList.add("show"); // show first so width/height are measurable
    var r = btn.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, gap = 10, m2 = 8;
    var pw = previewEl.offsetWidth, ph = previewEl.offsetHeight;
    var left = r.right + gap, useLeft = false;
    if (left + pw > vw - m2) { left = r.left - pw - gap; useLeft = true; } // flip to the left edge
    previewEl.classList.toggle("left", useLeft);
    var finalLeft = Math.max(m2, left);
    var finalTop = Math.max(m2, Math.min(r.top - 6, vh - ph - m2));

    // The pin "becomes" the card's avatar, so no jump: land the avatar's centre
    // exactly on the pin's centre (r.left/r.top already include the pin's CSS
    // transform, so its centre is r.left + r.width/2, r.top + r.height/2).
    // Only meaningful when there IS an avatar (`who`) — an anonymous pin has no
    // disc to become, so it keeps its own base-computed position and stays visible.
    if (who) {
      // .preview's padding is "13px 15px" (padding:13px 15px above). padLead=15 is
      // that left/right padding — the avatar column sits padLead in from the card's
      // edge. Because a .pin.who box is 28px border-box (same as the 28px preview
      // avatar drawn here), half the pin's width and half the avatar's width cancel,
      // so the card's edge simply needs to sit padLead away from the pin's edge:
      //   avatarCentreX = cardLeft + padLead + 14; set equal to r.left + r.width/2 (=
      //   r.left + 14 for a 28px pin) and the 14s cancel, leaving cardLeft = r.left - padLead.
      // The flipped card mirrors this from its right edge (row-reverse puts the
      // avatar column last-in-DOM-first-visually, i.e. at the trailing/right side):
      //   cardLeft = r.left - (pw - padLead - 28).
      // Vertically the same cancellation gives topPadding(13) + half the 28px avatar
      // (14) = 27, landing the avatar's centre on the pin's centre regardless of flip
      // (top padding is symmetric, there's no left/right split for it).
      var padLead = 15;
      var cardLeft = useLeft ? r.left - (pw - padLead - 28) : r.left - padLead;
      var cardTop = r.top + r.height / 2 - 27;
      var clampedLeft = Math.max(m2, Math.min(cardLeft, vw - pw - m2));
      var clampedTop = Math.max(m2, Math.min(cardTop, vh - ph - m2));
      finalLeft = clampedLeft;
      finalTop = clampedTop;
      // A viewport-clamped card can't land its avatar exactly on the pin's centre,
      // so hiding the pin here would fake the morph and produce the very jump this
      // feature exists to prevent. Only hand off to the card (hide the pin) when
      // clamping left both axes within a 1px rounding tolerance of the desired
      // avatar-aligned position; otherwise the pin stays visible beside the card,
      // same as for an anonymous comment with no avatar.
      var tol = 1;
      if (Math.abs(clampedLeft - cardLeft) <= tol && Math.abs(clampedTop - cardTop) <= tol) {
        btn.classList.add("under");
      }
    }
    previewEl.style.left = finalLeft + "px";
    previewEl.style.top = finalTop + "px";
  }
  function hidePreview() {
    clearTimeout(previewTimer);
    previewEl.classList.remove("show");
    var u = pinsEl.querySelector(".pin.under");
    if (u) u.classList.remove("under");
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

  // Relative time: "Just now" → "1 minute ago" → "N min. ago" → hours
  // → date. Open cards carry data-iso on each .when so the ticker can re-age them.
  function fmt(iso) {
    try {
      var s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (isNaN(s)) return "";
      if (s < 45) return "Just now";
      if (s < 90) return "1 minute ago";
      if (s < 3600) return Math.round(s / 60) + " min. ago";
      if (s < 5400) return "1 hour ago";
      if (s < 86400) return Math.round(s / 3600) + " hours ago";
      if (s < 172800) return "Yesterday";
      return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) { return ""; }
  }
  // Re-age every visible relative timestamp (open card + preview) so "Just now"
  // becomes "1 minute ago" without needing a re-render.
  setInterval(function () {
    var els = root.querySelectorAll(".when[data-iso]");
    for (var i = 0; i < els.length; i++) {
      var iso = els[i].getAttribute("data-iso");
      if (iso) els[i].textContent = fmt(iso);
    }
  }, 30000);

  /* ---------- modes ---------- */

  function setActive(on) {
    state.active = on;
    try { sessionStorage.setItem(LS_ACTIVE, on ? "1" : "0"); } catch (e) {}
    hideTip(true);
    if (on) { state.mode = "add"; } else { closeCard(); closeChain(); }
    render();
    if (on) toast("Review on · click to comment · Esc to exit · ↑/↓ for layers (+ Tokens shows spacing)");
  }
  // Set the layer drilldown (Components → +Base → +Tokens) and re-detect. Wraps, so it
  // works the same from the click (cycle forward) and the ↑/↓ keys (step either way).
  function setDrill(n) {
    var len = DRILL.length;
    state.drill = ((n % len) + len) % len;
    if (chainOpenFor) openChain(chainOpenFor.family, chainOpenFor.el); // refresh open panel
    renderLinks();
    toast("Layers: " + DRILL[state.drill]);
  }
  drillEl.addEventListener("click", function () { setDrill(state.drill + 1); });
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
    // The shortcut is plain Shift+C. Any OTHER modifier makes it a different chord that
    // belongs to someone else — ⌘⇧C / Ctrl+⇧C is a copy-as-image chord in canvases and in
    // most host apps — and this listener is on window in the CAPTURE phase with a
    // preventDefault(), so without these guards it swallowed those chords everywhere the
    // overlay is injected (every prototype page, including ones framed inside a canvas tile).
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.code === "KeyC" || e.key === "C" || e.key === "c") && !isTyping(src)) {
      e.preventDefault(); setActive(!state.active);
    } else if (e.key === "Escape" && state.active) {
      e.preventDefault(); setActive(false); // Esc exits comment mode outright
    } else if (state.active && !isTyping(src) && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      // ↑/↓ steps the bottom-left Layers depth (down = deeper toward + Tokens).
      e.preventDefault(); setDrill(state.drill + (e.key === "ArrowDown" ? 1 : -1));
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
      if (state.active) renderLinks(); // re-detect linked components after DOM/screen change
      orphanSweep();
    }, 200);
  }
  if (window.MutationObserver) {
    new MutationObserver(scheduleRerender).observe(document.documentElement, { childList: true, subtree: true });
    // Re-scope pins the instant the prototype switches screens (data-gv-screen).
    if (document.body) new MutationObserver(scheduleRerender)
      .observe(document.body, { attributes: true, attributeFilter: ["data-gv-screen"] });
  }
  window.addEventListener("scroll", reposition, { passive: true });
  // Resize can reflow layout (padding/gap/margin change), so rebuild the spacing shades;
  // scroll only translates the boxes, which the relative shading already tracks.
  window.addEventListener("resize", function () {
    reposition();
    if (state.active && state.drill >= 2) renderLinks();
  }, { passive: true });
  window.addEventListener("hashchange", function () { if (state.active) { render(); } tryOpenPending(); setTimeout(orphanSweep, 1200); });
  window.addEventListener("popstate", function () { if (state.active) { render(); } tryOpenPending(); setTimeout(orphanSweep, 1200); });

  // Boot. Review mode always starts OFF — press Shift+C to turn it on. We do
  // NOT restore the last active state: sessionStorage survives reloads and
  // same-tab navigation, so restoring meant every prototype you opened in a tab
  // booted into comment mode once you'd toggled it on anywhere. (Deep-linking to
  // a specific comment still re-activates via tryOpenPending/SS_PENDING.)
  refresh().then(function () {
    var grace = function () { settled = true; orphanSweep(); };
    if (document.readyState === "complete") setTimeout(grace, 1500);
    else window.addEventListener("load", function () { setTimeout(grace, 1500); });
  });
})();
