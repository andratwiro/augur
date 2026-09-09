/* Augur — the draft bar (drafts that land, docs/drafts-that-land.md §5).
 *
 * Served at /__drafts/drafts.js and appended by the worker to a unit's HTML for signed-in
 * members (withDraftUi in src/_worker.js), which also leaves the boot data in
 * window.__augurDraft = { unit, draft, me: { id, role } }.
 *
 * On MAIN the bar lists the unit's open drafts (or shows nothing) and reloads the tab when
 * a landing happens. On a DRAFT ADDRESS it names whose draft this is and when it last
 * saved, offers Land and Discard to editors, and reloads on every save. History opens a
 * panel of landings with Restore. Everything shown comes from /__unit/*, never from the
 * page; the socket at /__unit/socket says WHEN to ask again. No chrome dependency, no
 * external request, and nothing here is a lock: the bar refuses nobody.
 */
(function () {
  if (window.top !== window.self) return; // gallery previews and embeds carry no bar
  var boot = window.__augurDraft;
  if (!boot || !boot.unit) return;
  var UNIT = boot.unit, DRAFT = boot.draft || null, ME = boot.me || {};
  var canWrite = ME.role !== "viewer";
  var unitQ = "unit=" + encodeURIComponent(UNIT);
  var state = { card: null, drafts: [] };

  // ── talking to the unit ──────────────────────────────────────────────────────
  function api(verb, body, extraQuery) {
    var opts = { credentials: "same-origin", headers: { Accept: "application/json" } };
    var url = "/__unit/" + verb;
    if (body) {
      opts.method = "POST";
      opts.headers["Content-Type"] = "application/json";
      body.unit = UNIT;
      opts.body = JSON.stringify(body);
    } else {
      url += "?" + unitQ + (extraQuery || "");
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; });
    });
  }

  // ── small helpers ────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ago(iso, verb) {
    var ms = Date.now() - Date.parse(iso || "");
    if (!(ms >= 0)) return "";
    var m = Math.round(ms / 60000);
    if (m < 1) return verb + " just now";
    if (m < 60) return verb + " " + m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return verb + " " + h + " h ago";
    return verb + " " + new Date(iso).toLocaleDateString();
  }
  function face(p) {
    var f = el("span", "augur-draft__face", (p.initials || "?").slice(0, 2));
    if (p.color) f.style.backgroundColor = p.color;
    var id = p.owner || p.by;
    if (id) f.setAttribute("data-person", id);
    return f;
  }
  function label(p) { return (p.name || "Someone") + (p.session ? " · " + p.session : ""); }
  function go(href) { location.href = href; }

  // Photos, laid over the initials once /__people answers. Initials stand if it does not.
  function faces(root) {
    var els = root.querySelectorAll("[data-person]"), ids = [], byId = {};
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute("data-person");
      if (!id) continue;
      (byId[id] = byId[id] || []).push(els[i]);
      if (ids.indexOf(id) < 0) ids.push(id);
    }
    if (!ids.length) return;
    fetch("/__people?ids=" + encodeURIComponent(ids.slice(0, 50).join(",")), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.people) return;
        d.people.forEach(function (p) {
          if (!p.avatar) return;
          (byId[p.id] || []).forEach(function (e) {
            e.style.backgroundImage = "url('" + p.avatar + "')";
            e.style.backgroundSize = "cover";
            e.textContent = "";
          });
        });
      })
      .catch(function () { /* initials stand */ });
  }

  // ── styles, once ─────────────────────────────────────────────────────────────
  var CSS = [
    ".augur-draftbar{position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:8px;",
    "padding:6px 10px 6px 6px;border-radius:999px;background:#101828;color:#fff;box-shadow:0 8px 24px -8px rgba(16,24,40,.6);",
    "font:600 12.5px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:-.005em;max-width:min(92vw,560px)}",
    ".augur-draftbar[hidden],.augur-draft__list[hidden],.augur-draft__panel[hidden],.augur-draft__note[hidden]{display:none}",
    ".augur-draftbar a{color:inherit;text-decoration:none}",
    ".augur-draft__face{flex:none;width:22px;height:22px;border-radius:50%;display:inline-grid;place-items:center;",
    "font-size:9px;font-weight:700;color:#fff;background:#4f46e5;background-position:center}",
    ".augur-draft__text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".augur-draft__dim{opacity:.7;font-weight:500}",
    ".augur-draftbar button{font:inherit;border:0;border-radius:999px;padding:5px 10px;cursor:pointer;color:#101828;background:#fff}",
    ".augur-draftbar button.is-quiet{background:transparent;color:#fff;opacity:.85}",
    ".augur-draftbar button:disabled{opacity:.5;cursor:default}",
    ".augur-draft__list{position:fixed;left:12px;bottom:56px;z-index:2147483000;display:flex;flex-direction:column;gap:6px}",
    ".augur-draft__row{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;border-radius:999px;background:#101828;color:#fff;text-decoration:none;",
    "font:600 12.5px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 8px 24px -8px rgba(16,24,40,.6)}",
    ".augur-draft__row.is-idle{opacity:.75}",
    ".augur-draft__panel{position:fixed;left:12px;bottom:56px;z-index:2147483001;width:min(92vw,420px);max-height:60vh;overflow:auto;",
    "background:#fff;color:#101828;border-radius:14px;box-shadow:0 20px 48px -16px rgba(16,24,40,.55),0 2px 8px rgba(16,24,40,.12);",
    "font:500 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;padding:8px}",
    ".augur-draft__panel h2{margin:4px 8px 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#667085}",
    ".augur-draft__landing{display:grid;grid-template-columns:22px 1fr auto;gap:8px;align-items:center;padding:8px;border-radius:10px}",
    ".augur-draft__landing:hover{background:#f2f4f7}",
    ".augur-draft__landing small{display:block;color:#667085;font-weight:500}",
    ".augur-draft__landing button{font:inherit;font-size:12px;border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:4px 10px;cursor:pointer}",
    ".augur-draft__note{position:fixed;left:12px;bottom:56px;z-index:2147483001;max-width:min(92vw,420px);padding:10px 12px;border-radius:12px;",
    "background:#fff;color:#101828;box-shadow:0 12px 32px -12px rgba(16,24,40,.5);font:500 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif}",
  ].join("");
  var style = el("style"); style.textContent = CSS; document.head.appendChild(style);

  // ── the bar itself ───────────────────────────────────────────────────────────
  var bar = el("div", "augur-draftbar"); bar.hidden = true;
  var list = el("div", "augur-draft__list"); list.hidden = true;
  var panel = el("div", "augur-draft__panel"); panel.hidden = true;
  var noteBox = el("div", "augur-draft__note"); noteBox.hidden = true;
  document.body.appendChild(bar); document.body.appendChild(list);
  document.body.appendChild(panel); document.body.appendChild(noteBox);

  var noteTimer = null;
  function note(text) {
    noteBox.textContent = text; noteBox.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { noteBox.hidden = true; }, 6000);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(text, cls, onClick) {
    var b = el("button", cls, text); b.type = "button"; b.addEventListener("click", onClick); return b;
  }

  function renderMain(drafts) {
    clear(bar); clear(list);
    state.drafts = drafts || [];
    if (!state.drafts.length) { bar.hidden = true; list.hidden = true; return; }
    var n = state.drafts.length;
    bar.appendChild(el("span", "augur-draft__text", n === 1 ? "1 draft open" : n + " drafts open"));
    bar.appendChild(button(list.hidden ? "Show" : "Hide", "is-quiet", function () {
      list.hidden = !list.hidden; this.textContent = list.hidden ? "Show" : "Hide";
    }));
    bar.appendChild(button("History", "is-quiet", history));
    state.drafts.forEach(function (d) {
      var row = el("a", "augur-draft__row" + (d.active ? "" : " is-idle"));
      row.href = UNIT.replace(/\/$/, "") + "@" + d.id + "/";
      row.appendChild(face(d));
      row.appendChild(el("span", "augur-draft__text", label(d)));
      row.appendChild(el("span", "augur-draft__dim", ago(d.lastSaveAt || d.openedAt, d.lastSaveAt ? "saved" : "opened")));
      list.appendChild(row);
    });
    bar.hidden = false;
    faces(list);
  }

  function renderDraft(card) {
    clear(bar); list.hidden = true;
    state.card = card;
    bar.appendChild(face(card));
    bar.appendChild(el("span", "augur-draft__text", label(card)));
    bar.appendChild(el("span", "augur-draft__dim", card.closedAt
      ? "landed"
      : ago(card.lastSaveAt || card.openedAt, card.lastSaveAt ? "saved" : "opened")));
    if (canWrite && !card.closedAt) {
      bar.appendChild(button("Land", "", land));
      bar.appendChild(button("Discard", "is-quiet", discard));
    }
    bar.appendChild(button("History", "is-quiet", history));
    var main = el("a", "augur-draft__dim", "Main"); main.href = UNIT; bar.appendChild(main);
    bar.hidden = false;
    faces(bar);
  }

  // ── the verbs ────────────────────────────────────────────────────────────────
  var busy = false;
  function land() {
    if (busy || !state.card) return;
    busy = true;
    api("land", { draftId: DRAFT, baseRevision: state.card.baseRevision, note: "" }).then(function (r) {
      busy = false;
      if (r.ok) { go(UNIT); return; }
      if (r.__status === 409 && r.error === "main-moved") {
        var n = (r.changed || []).length + (r.removed || []).length;
        note("Main has moved since this draft began (" + n + (n === 1 ? " file" : " files") + "). Sync the draft and land again.");
      } else if (r.__status === 409 && r.error === "landing-in-progress") {
        note("Another landing is in progress on this prototype. Try again in a moment.");
      } else if (r.__status === 409 && r.error === "would-unpublish") {
        note("This draft has no files, so landing it would take the prototype down. Nothing was changed.");
      } else if (r.__status === 403) {
        note(r.message || "This account cannot land drafts.");
      } else {
        note("The landing was refused: " + (r.error || r.__status) + ".");
      }
    }).catch(function () { busy = false; note("The landing could not be sent. Check the connection and try again."); });
  }
  function discard() {
    if (busy) return;
    if (!confirm("Discard this draft? Every save it holds is gone for good; the prototype's real URL is untouched.")) return;
    busy = true;
    api("discard", { draftId: DRAFT }).then(function (r) {
      busy = false;
      if (r.closed) { go(UNIT); return; }
      note(r.message || "The draft could not be discarded: " + (r.error || r.__status) + ".");
    }).catch(function () { busy = false; note("The discard could not be sent."); });
  }
  function history() {
    if (!panel.hidden) { panel.hidden = true; return; }
    api("history").then(function (h) {
      clear(panel);
      if (h.__status !== 200) { note("History is not available right now."); return; }
      panel.appendChild(el("h2", null, "Landings"));
      (h.landings || []).forEach(function (l) {
        var row = el("div", "augur-draft__landing");
        row.appendChild(face(l));
        var text = el("div");
        var who = l.by === "live" ? "Adopted from the live site" : label(l);
        if (l.draft && l.draft.owner) who += " · draft by " + label(l.draft);
        text.appendChild(el("div", null, "#" + l.revision + " · " + who));
        var meta = (l.note ? l.note + " · " : "") + ago(l.at, "landed")
          + (l.restoredFrom ? " · restored from #" + l.restoredFrom : "")
          + " · " + l.files + (l.files === 1 ? " file" : " files");
        text.appendChild(el("small", null, meta));
        row.appendChild(text);
        if (canWrite && l.revision !== h.revision) {
          row.appendChild(button("Restore", "", function () { restore(l.revision); }));
        } else {
          row.appendChild(el("span", "augur-draft__dim", l.revision === h.revision ? "current" : ""));
        }
        panel.appendChild(row);
      });
      panel.hidden = false;
      faces(panel);
    }).catch(function () { note("History could not be loaded."); });
  }
  function restore(revision) {
    if (busy) return;
    if (!confirm("Land revision #" + revision + " as a new landing? Nothing is rewritten; history keeps every step.")) return;
    busy = true;
    api("restore", { revision: revision, note: "restored revision " + revision }).then(function (r) {
      busy = false;
      if (r.ok) { panel.hidden = true; reloadMain(); return; }
      note("The restore was refused: " + (r.error || r.__status) + ".");
    }).catch(function () { busy = false; note("The restore could not be sent."); });
  }

  // ── reloading, past the service worker ───────────────────────────────────────
  // Main pages are served stale-while-revalidate by the service worker, so a plain reload
  // after a landing would paint the previous landing first. Ask the worker to drop this
  // URL, wait for its answer (or half a second), then reload — after the moment the
  // engine's own manifest cache needs to notice the landing on every isolate.
  function evict(url) {
    return new Promise(function (resolve) {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) { resolve(); return; }
      var done = false, finish = function () { if (!done) { done = true; resolve(); } };
      try {
        var ch = new MessageChannel();
        ch.port1.onmessage = finish;
        sw.postMessage({ t: "evict", url: url }, [ch.port2]);
      } catch (e) { finish(); }
      setTimeout(finish, 500);
    });
  }
  function reloadMain() {
    evict(location.href).then(function () { setTimeout(function () { location.reload(); }, 1500); });
  }

  // ── the socket ───────────────────────────────────────────────────────────────
  var tries = 0, pingTimer = null;
  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var ws;
    try { ws = new WebSocket(proto + location.host + "/__unit/socket?" + unitQ + (DRAFT ? "&draft=" + DRAFT : "")); }
    catch (e) { return; }
    ws.onopen = function () {
      tries = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { try { ws.send("ping"); } catch (e) { /* closing */ } }, 25000);
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.t) return;
      if (DRAFT) {
        if (m.draftId !== DRAFT) { refresh(); return; }
        if (m.t === "save") location.reload();
        else if (m.t === "land" || m.t === "discard") go(UNIT);
      } else {
        if (m.t === "land") reloadMain();
        else refresh();
      }
    };
    ws.onclose = function () {
      clearInterval(pingTimer);
      if (tries >= 6) return; // a minute of trying is enough; the next visit connects again
      var wait = Math.min(30000, 1000 * Math.pow(2, tries++));
      setTimeout(connect, wait);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* already closed */ } };
  }

  // ── first paint ──────────────────────────────────────────────────────────────
  function refresh() {
    if (DRAFT) {
      api("draft", null, "&draft=" + DRAFT).then(function (card) {
        if (card.__status !== 200) { bar.hidden = true; return; }
        renderDraft(card);
      }).catch(function () { /* the bar simply does not appear */ });
    } else {
      api("presence").then(function (p) {
        if (p.__status !== 200) { bar.hidden = true; return; }
        renderMain(p.drafts);
      }).catch(function () { /* same */ });
    }
  }
  refresh();
  connect();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
