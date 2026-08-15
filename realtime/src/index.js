/* augur-realtime — one BoardRoom Durable Object per canvas board.
 *
 * The worker upgrades /room?path=<boardPath>&name=<who> to a WebSocket and hands it to
 * the room named by the board path (the same key the KV doc uses). The room is a relay
 * plus THE document authority: it fans cursor moves / node ops / editing focus out to
 * the other sockets, applies every op to its own copy of the doc, and persists.
 *
 * THE ROOM OWNS THE DOC (2026-08-07 — was "room persists while live" since 2026-07-27).
 * The document's source of truth is the DO's OWN SQLite-backed storage: one row per node
 * (`n:<id>`), one meta row (`m` — name, tombstones, clock). DO storage is strongly
 * consistent and survives hibernation, so the old stash/docreq/cold-alarm dances are
 * gone with the failure modes they papered over. Workers KV keeps the SAME doc under the
 * SAME key (`board:<path>`) but demoted to a WRITE-THROUGH MIRROR: it serves the public
 * GET /__board and the solo fallback, and the room writes it on the old cadence (45s
 * dirty-alarm + flush on empty) — never reads it back except once, to migrate a
 * pre-existing board into storage (lazy, first touch, per board).
 *
 * VERSIONED NODES (the Figma/Excalidraw model, not a CRDT). Every node carries
 * `v` (int, bumped by whoever mutates it) and `vn` (random tiebreak). The room applies
 * an op only if it's NEWER than what it holds (v, then vn); losers get a corrective op
 * back so every client converges on the same winner. Deletes leave a tombstone
 * (id → {v,t}) so a stale upsert can't resurrect a deleted node; tombs prune after
 * TOMB_TTL. A client "seed" ({t:"doc"}) is RECONCILED per-node under the same rules —
 * never adopted wholesale — so a stale tab (slept laptop, frozen tab, eventual-consistent
 * KV read) can no longer revert a board, while its genuinely-new offline edits merge in.
 * Legacy compat: v-less ops from old clients are accepted and stamped (live edits keep
 * working); v-less nodes inside a SEED count as v0 (stale-tab protection is the point).
 *
 * Rooms under /__test/ never touch storage OR KV — pure RAM relay (Playwright isolation);
 * they keep the old docreq dance since RAM is all they have.
 *
 * Uses the WebSocket Hibernation API, so an idle board with open tabs costs ~nothing.
 * `doc` in memory is a cache rebuilt from storage on demand; `dirty` (KV mirror pending)
 * is durable because the alarm outlives the instance that armed it.
 *
 * Protocol (JSON, one object per message):
 *   client→room: {t:"cursor",x,y,drag?}|{t:"cursor",gone:true} · {t:"ops",ops:[...]} ·
 *                {t:"focus",id|null} · {t:"sel",ids:[...]} (live selection) ·
 *                {t:"status",text,state} (persistent work state under an agent cursor:
 *                state working|idle|attention; kept on the attachment for late joiners) ·
 *                {t:"chat",text} (cursor chat — pure ephemeral relay) ·
 *                {t:"view",v:{x,y,s,w,h}} (live viewport — pan/zoom/window; kept on the
 *                attachment so follow mode mirrors a peer the instant it starts) ·
 *                {t:"proto",id,ev} (demo sync in a live tile iframe) ·
 *                {t:"timer",do:"start"|"add"|"pause"|"resume"|"stop",ms?} ·
 *                {t:"music",do:"play"|"stop",track?,at?} (shared session — see below) ·
 *                {t:"doc",doc} (seed/merge offer — reconciled, see above)
 *   room→client: {t:"welcome",sid,color,peers,doc?,needDoc?,session?} · {t:"join"|"leave",peer} ·
 *                relayed cursor/ops/focus/sel/status/chat stamped with the sender's info ·
 *                {t:"session",timer,music} · {t:"doc",doc} · {t:"docreq"} (test rooms only)
 * cursor.drag is the drag fast-path: [{id,x,y,w,h},…] geometry for nodes mid-drag,
 * relayed verbatim on the cursor cadence (~20Hz) so remote drags glide instead of
 * stepping at the 120ms ops tick. Ephemeral — the durable version rides the ops tick.
 * Ops: {op:"upsert",node} · {op:"del",id,v?} · {op:"name",name,v?}. Accepted ops are
 * broadcast (with room-stamped versions where the sender sent none); rejected ops earn
 * the SENDER a corrective ops message carrying the winning state. The doc's `view` is
 * per-user viewport — never synced (a fossil in old mirrors; clients use localStorage).
 */

const MAX_MSG = 8 * 1024 * 1024; // a node op can carry an inlined image; KV caps the doc at 20MB
const COLORS = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#e64980", "#f08c00", "#0c8599", "#6741d9"];

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json" } });
}

// Shared secret with the Pages worker. The rooms below hold the authoritative board
// documents, and the admin-only-space seal is enforced in the PAGES worker, which checks
// the requested board path before proxying to /__rt. This worker is reachable on its own
// public URL, so without this guard anyone who learns that hostname joins any room
// directly and the seal means nothing. The secret is REQUIRED: unset means no room
// request is served at all (501), so an instance cannot quietly launch open. Provision
// it on both sides — the realtime worker and the site — before pointing traffic here.
const RT_SECRET_HEADER = "x-augur-rt";
function rtSecretOk(given, want) {
  given = String(given == null ? "" : given);
  if (given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true, service: "augur-realtime" });
    if (url.pathname !== "/room") return json({ error: "not-found" }, 404);
    // Fail CLOSED. An unset secret used to skip the guard entirely, which meant every
    // new instance launched wide open and showed no symptom for it — rooms simply
    // worked, for anyone who learned the hostname. Refusing outright makes the
    // unconfigured state loud instead of silent, and 501 is the same answer the site
    // worker's rtProxy already gives when realtime is unconfigured on its side.
    const want = env && env.RT_SHARED_SECRET;
    if (!want) return json({ error: "realtime-not-configured" }, 501);
    if (!rtSecretOk(request.headers.get(RT_SECRET_HEADER), want)) {
      return json({ error: "forbidden" }, 403);
    }
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected-websocket" }, 426);
    const path = (url.searchParams.get("path") || "").slice(0, 600);
    if (!path) return json({ error: "bad-input" }, 400);
    const id = env.ROOMS.idFromName(path);
    return env.ROOMS.get(id).fetch(request);
  },
};

const BOARD_PREFIX = "board:";   // same key scheme as the Pages worker's /__board rail
const PERSIST_MS = 45000;        // dirty → alarm → KV mirror write; ≤ ~80 writes/hour per hot board
const RETRY_MS = 5000;           // re-arm delay after a FAILED mirror write (KV hiccup — retry soon)
const MAX_TIMER_MS = 99 * 60000 + 59000; // 99:59 — a session timer, not a scheduler
const STALE_TIMER_MS = 3600000;  // an expired timer older than this is forgotten, not shown at 00:00
const TOMB_TTL = 45 * 86400000;  // tombstones outlive any realistic stale tab, then prune
const TOMB_MAX = 5000;           // hard cap — a board that deleted 5k nodes can afford resurrection risk
const NODE_CHUNK = 1800000;      // storage rows cap at 2MB; larger node JSON splits into N:<id>:<i>
const PUT_BATCH = 100;           // storage.put(object) accepts ≤128 keys per call

const vOf = (x) => (x && typeof x.v === "number" ? x.v : 0);
const vnOf = (x) => (x && typeof x.vn === "number" ? x.vn : 0);
// deterministic total order: version, then nonce. Equal v+vn = the same write (idempotent).
const beats = (a, b) => vOf(a) > vOf(b) || (vOf(a) === vOf(b) && vnOf(a) > vnOf(b));
const sameV = (a, b) => vOf(a) === vOf(b) && vnOf(a) === vnOf(b);
const rnd = () => Math.floor(Math.random() * 0x7fffffff);
// tombs is a plain object keyed by CLIENT-CHOSEN node ids — reads must not hit inherited
// members (an id like "constructor" made every create bounce as tombed) and writes must
// not follow the "__proto__" setter. Same rule client-side.
const tombAt = (t, id) => (t && Object.prototype.hasOwnProperty.call(t, id) ? t[id] : null);
const setTomb = (t, id, val) => Object.defineProperty(t, id, { value: val, writable: true, enumerable: true, configurable: true });
// cheap content hash (FNV-1a) — used only to detect "did KV move under us since our last
// mirror write", never for integrity
const hashStr = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ":" + s.length; };

export class BoardRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.doc = null;      // {name,nameV,nodes:[…],tombs:{id:{v,t}},clock} — cache over storage
    this.byId = null;     // Map id → node, rebuilt with doc
    this.chunked = new Set(); // node ids stored as N:<id>:<i> overflow chunks (JSON > 1.8MB)
    this.loadP = null;    // in-flight load, so concurrent messages share one storage read
    this.path = null;     // board path cache (durable under "path")
    this.ephemeral = false; // /__test/ room: RAM only, never storage, never KV
    this.wantDoc = false; // test rooms only: a docreq is in flight, don't spam
    this.dirty = false;   // KV mirror is behind storage (mirrored durably — see markDirty)
    this.alarmSet = false;
    this.sweptAt = 0;
    this.sess = null;     // shared timer/music state (cache — reloaded from storage on demand)
    this.sessQ = null;    // serializes session mutations (read-modify-write over storage)
    // clients ping every 25s; the runtime pongs WITHOUT waking the DO and stamps the
    // socket, so sweep() can spot zombies (dropped transports whose close never fired —
    // sends to them "succeed" into the void, so send-failure reaping can't catch them)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  sweep() {
    const now = Date.now();
    if (now - this.sweptAt < 10000) return;
    this.sweptAt = now;
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.isLive(ws)) this.reap(ws); // no ping in ~3 intervals = dead
    }
  }

  peers(excludeWs) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const a = ws.deserializeAttachment();
      if (a) out.push({ sid: a.sid, name: a.name, color: a.color, avatar: a.avatar || null, kind: a.kind || null, pose: a.pose || null, focus: a.focus || null, sel: a.sel || null, status: a.status || null, view: a.view || null });
    }
    return out;
  }

  broadcast(msg, exceptWs) {
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    const dead = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(raw); } catch (e) { dead.push(ws); }
    }
    // a failed send = a zombie (an aborted handshake or vanished client whose close event
    // never fired) — reap NOW or it haunts the peers list as a phantom presence chip
    for (const ws of dead) this.reap(ws);
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }

  async fetch(request) {
    const url = new URL(request.url);
    const path = (url.searchParams.get("path") || "").slice(0, 600);
    if (path) { this.path = path; this.ephemeral = path.indexOf("/__test/") === 0; this.ctx.storage.put("path", path); }
    const name = (url.searchParams.get("name") || "Guest").slice(0, 60);
    const sid = "p" + Math.random().toString(36).slice(2, 10);
    // `kind=agent` marks a Claude collaboration client — clients render it as Clawd, not the
    // arrow. Only an agent may PIN its color (so Clawd stays its brand hue instead of a
    // palette slot); humans always take the next palette color (no color hijacking).
    const kind = (url.searchParams.get("kind") || "").slice(0, 16) || null;
    const reqColor = url.searchParams.get("color");
    const pinned = kind === "agent" && reqColor && /^#[0-9a-fA-F]{6}$/.test(reqColor) ? reqColor : null;
    const color = pinned || COLORS[this.ctx.getWebSockets().length % COLORS.length];
    // an account avatar rides the join and is relayed to peers — same-origin PATHS only,
    // so the room never becomes a vehicle for arbitrary external images
    const reqAvatar = (url.searchParams.get("avatar") || "").slice(0, 300);
    const avatar = reqAvatar.startsWith("/") ? reqAvatar : null;

    // the doc comes up BEFORE the welcome goes out, so every joiner starts from the
    // room's authoritative state — never from a possibly-stale KV read of their own
    await this.load();

    this.sweep();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sid, name, color, avatar, kind, pose: null, focus: null, joined: Date.now() });

    const welcome = { t: "welcome", sid, color, peers: this.peers(server) };
    if (this.doc) welcome.doc = this.wireDoc();
    else welcome.needDoc = true; // brand-new board (or a cold test room): the client seeds
    // a joiner walks into a running timer mid-countdown — hand them the live values
    const sess = await this.sessionState();
    if (sess.timer || sess.music) welcome.session = this.sessionWire(sess);
    this.send(server, welcome);
    this.broadcast({ t: "join", peer: { sid, name, color, avatar, kind, pose: null, focus: null } }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    this.sweep();
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const a = ws.deserializeAttachment();
    if (!a || !msg || !msg.t) return;

    if (msg.t === "cursor") {
      const out = { t: "cursor", sid: a.sid, name: a.name, color: a.color, kind: a.kind || null, x: msg.x, y: msg.y, gone: !!msg.gone };
      // drag fast-path: mid-drag geometry rides the cursor cadence (relay only — never
      // applied to the room doc; the durable upserts follow on the sender's ops tick)
      if (Array.isArray(msg.drag) && msg.drag.length && msg.drag.length <= 64) out.drag = msg.drag;
      this.broadcast(out, ws);
      return;
    }
    if (msg.t === "sel") {
      // live selection (colored outlines on what each person has selected) — kept on the
      // attachment so late joiners see it via peers()
      a.sel = Array.isArray(msg.ids) ? msg.ids.slice(0, 200).filter((x) => typeof x === "string") : null;
      if (a.sel && !a.sel.length) a.sel = null;
      ws.serializeAttachment(a);
      this.broadcast({ t: "sel", sid: a.sid, color: a.color, ids: a.sel }, ws);
      return;
    }
    if (msg.t === "view") {
      // live viewport (pan/zoom + window size) — follow mode mirrors it. Kept on the
      // attachment so clicking Follow (or joining late) syncs before the peer next moves
      const v = msg.v;
      a.view = v && [v.x, v.y, v.s, v.w, v.h].every((n) => typeof n === "number" && isFinite(n)) && v.s > 0
        ? { x: v.x, y: v.y, s: v.s, w: Math.max(1, v.w), h: Math.max(1, v.h) } : null;
      ws.serializeAttachment(a);
      this.broadcast({ t: "view", sid: a.sid, view: a.view }, ws);
      return;
    }
    if (msg.t === "proto") {
      // demo sync inside live prototype tiles — pure ephemeral relay, nothing stored
      this.broadcast({ t: "proto", sid: a.sid, id: msg.id, ev: msg.ev }, ws);
      return;
    }
    if (msg.t === "ops" && Array.isArray(msg.ops)) {
      await this.load();
      if (!this.doc) {
        // only reachable in a test room (real rooms always load or start a doc): relay for
        // liveness and ask the sender — who by definition has the state — for a snapshot
        this.broadcast({ t: "ops", sid: a.sid, ops: msg.ops }, ws);
        if (!this.wantDoc) { this.wantDoc = true; this.send(ws, { t: "docreq" }); }
        return;
      }
      const r = this.applyOps(msg.ops, /*seedMode*/ false);
      if (r.accepted.length) this.broadcast({ t: "ops", sid: a.sid, ops: r.accepted }, ws);
      // the sender lost one or more races — hand them the winning state so they converge
      // (everyone else already holds it or is about to via the accepted broadcast)
      if (r.corrections.length) this.send(ws, { t: "ops", sid: "room", ops: r.corrections });
      return;
    }
    if (msg.t === "focus") {
      a.focus = msg.id || null;
      ws.serializeAttachment(a);
      this.broadcast({ t: "focus", sid: a.sid, name: a.name, color: a.color, id: a.focus }, ws);
      return;
    }
    if (msg.t === "status") {
      // persistent "what am I working on" line under a cursor — survives on the attachment
      // so late joiners see it (unlike chat, which is a moment, not a state)
      const text = (typeof msg.text === "string" ? msg.text : "").slice(0, 120);
      const state = ["working", "idle", "attention", "done"].indexOf(msg.state) >= 0 ? msg.state : "working";
      a.status = text || state !== "working" ? { text, state } : null;
      ws.serializeAttachment(a);
      this.broadcast({ t: "status", sid: a.sid, status: a.status }, ws);
      return;
    }
    if (msg.t === "chat") {
      // cursor chat: ephemeral, relayed and forgotten (no storage, no replay)
      const text = (typeof msg.text === "string" ? msg.text : "").slice(0, 200);
      if (text) this.broadcast({ t: "chat", sid: a.sid, name: a.name, color: a.color, kind: a.kind || null, text }, ws);
      return;
    }
    if (msg.t === "timer" || msg.t === "music") {
      // Serialized, not fire-and-forget: two people hitting "+1 min" in the same tick would
      // otherwise both read the pre-write state and the second would overwrite the first's
      // minute instead of stacking on it.
      this.sessQ = (this.sessQ || Promise.resolve()).then(() => this.applySession(msg)).catch(() => {});
      return;
    }
    if (msg.t === "kick") {
      // Remove an AGENT from the board. Delivered only to the target, whose client ends its
      // own process on receipt — a real eviction, not a UI one, which is the only kind worth
      // having (hiding the avatar would leave the thing still editing the board).
      // AGENTS ONLY: a human's tab belongs to that human, not to whoever else is in the room.
      // Pure relay, nothing stored — a room that remembered its evictions would need an
      // un-ban path and a policy about who may set one. The record that it happened belongs
      // with the agent instead, in its own event log, where its next turn will read it.
      const target = typeof msg.sid === "string" ? msg.sid : "";
      if (!target) return;
      for (const peer of this.ctx.getWebSockets()) {
        const p = peer.deserializeAttachment();
        if (!p || p.sid !== target || p.kind !== "agent") continue;
        this.send(peer, { t: "kick", sid: target, by: a.name || "" });
      }
      return;
    }
    if (msg.t === "pose") {
      // an agent's Clawd expression (idle/coding/sleeping/…) — stored per-session so late
      // joiners see the right face, and relayed so everyone updates it live.
      a.pose = (typeof msg.pose === "string" ? msg.pose : "").slice(0, 24) || null;
      ws.serializeAttachment(a);
      this.broadcast({ t: "pose", sid: a.sid, pose: a.pose }, ws);
      return;
    }
    if (msg.t === "doc" && msg.doc && Array.isArray(msg.doc.nodes)) {
      await this.load();
      this.wantDoc = false;
      if (!this.doc) {
        // brand-new board (or a test room rebuilding after hibernation): adopt wholesale —
        // there is nothing to reconcile against. Nodes keep the versions they came with
        // (v-less stays v-less = v0), so the seeder's own later bumps still win cleanly.
        this.adoptDoc(msg.doc);
        return;
      }
      // A board exists → the seed is an OFFER, reconciled per-node under the version rules
      // (v-less seed nodes count as v0). A slept-laptop tab reconnecting with last week's
      // RAM merges its genuinely-new nodes and LOSES everything the board has since
      // out-versioned — the exact opposite of the old wholesale adopt, which let the
      // stalest client in the world overwrite everyone (the #1 loss bug of the audit).
      const r = this.reconcileSeed(msg.doc);
      if (r.accepted.length) this.broadcast({ t: "ops", sid: "room", ops: r.accepted }, ws);
      // where the room won, the seeder is the one holding stale state — correct them
      if (r.corrections.length) this.send(ws, { t: "ops", sid: "room", ops: r.corrections });
      return;
    }
  }

  // ---- session: the shared timer + music ------------------------------------
  // Room-level state, unlike status/pose which hang off one socket: a room has ONE timer and
  // ONE track, the same for everyone. Held in ctx.storage (not the doc) because a countdown
  // is a moment, not board content — it must not land in the KV document, ride the ops tick,
  // or turn up in undo.
  //
  // NO ALARM, deliberately. Expiry is computed by each client from the remaining ms below.
  // This DO has a single alarm slot and it belongs to the KV persist rail; a timer that
  // borrowed it would silently cancel a pending document write — losing board edits to
  // show a countdown would be a terrible trade.
  //
  // Time goes on the wire as REMAINING MILLISECONDS AT SEND, never as an absolute deadline.
  // A client stamps arrival with its own monotonic clock and counts down from there, so a
  // laptop whose wall clock is ten minutes off still shows the same 04:56 as everyone else.
  // The stored `at` is only ever differenced against this DO's own clock, so it stays exact
  // across hibernation.
  async sessionState() {
    if (!this.sess) {
      const s = (await this.ctx.storage.get("sess")) || {};
      this.sess = { timer: s.timer || null, music: s.music || null };
      // don't greet a joiner with last month's meeting frozen at 00:00
      const t = this.sess.timer;
      if (t && !t.running && t.remain <= 0 && Date.now() - t.at > STALE_TIMER_MS) this.sess.timer = null;
    }
    return this.sess;
  }
  // stored values rolled forward to this instant
  sessionWire(s) {
    const now = Date.now();
    const out = { timer: null, music: null };
    if (s.timer) {
      const remain = s.timer.running ? Math.max(0, s.timer.remain - (now - s.timer.at)) : s.timer.remain;
      // An EXPIRED countdown is not state: clients revert to idle the moment they hit 00:00
      // (they announce it locally — the room broadcasts nothing at that instant), so a joiner
      // must not be handed a frozen 00:00 the room they're joining stopped showing.
      if (remain > 0) out.timer = { running: !!s.timer.running, remain, total: s.timer.total };
    }
    if (s.music) {
      out.music = {
        track: s.music.track,
        playing: !!s.music.playing,
        elapsed: s.music.playing ? s.music.elapsed + (now - s.music.at) : s.music.elapsed,
      };
    }
    return out;
  }
  saveSession(s) {
    this.sess = s;
    this.ctx.storage.put("sess", s);
    // to EVERYONE including the sender: the room's value is the authoritative one, so the
    // person who clicked snaps to it too rather than trusting their own optimistic guess
    this.broadcast({ t: "session", ...this.sessionWire(s) });
  }
  async applySession(msg) {
    const s = await this.sessionState();
    const now = Date.now();
    if (msg.t === "timer") {
      const cur = s.timer;
      const remain = cur ? (cur.running ? Math.max(0, cur.remain - (now - cur.at)) : cur.remain) : 0;
      const arg = Math.min(Math.max(Math.round(Number(msg.ms)) || 0, 0), MAX_TIMER_MS);
      if (msg.do === "start") {
        if (arg < 1000) return;
        s.timer = { running: true, remain: arg, total: arg, at: now };
      } else if (msg.do === "add") {
        if (!cur || !arg) return;
        const next = Math.min(remain + arg, MAX_TIMER_MS);
        // adding time to a timer that already rang restarts it — that IS the point of
        // "+1 min" at 00:00, and it's the only way back without re-entering the duration
        s.timer = { running: cur.running || remain <= 0, remain: next, total: Math.max(cur.total, next), at: now };
      } else if (msg.do === "pause") {
        if (!cur || !cur.running || remain <= 0) return;
        s.timer = { running: false, remain, total: cur.total, at: now };
      } else if (msg.do === "resume") {
        if (!cur || cur.running || remain <= 0) return;
        s.timer = { running: true, remain, total: cur.total, at: now };
      } else if (msg.do === "stop") {
        if (!cur) return;
        s.timer = null;
      } else return;
    } else {
      const cur = s.music;
      if (msg.do === "play") {
        const track = (typeof msg.track === "string" ? msg.track : "").slice(0, 64);
        if (!track) return;
        // Resuming the same track picks up where it stopped; a NEW track takes the offset the
        // caller chose. That offset is a random entry point, which is why it's the client's to
        // pick and the room's to make authoritative — everyone must land on the same bar.
        const same = cur && cur.track === track;
        const elapsed = same
          ? (cur.playing ? cur.elapsed + (now - cur.at) : cur.elapsed)
          : Math.max(0, Math.round(Number(msg.at)) || 0);
        s.music = { track, playing: true, elapsed, at: now };
      } else if (msg.do === "stop") {
        if (!cur || !cur.playing) return;
        s.music = { track: cur.track, playing: false, elapsed: cur.elapsed + (now - cur.at), at: now };
      } else return;
    }
    this.saveSession(s);
  }

  // ---- the document (storage-backed, version-ruled) --------------------------
  wireDoc() {
    // tombs ride along so a reconnecting client can apply deletions it slept through
    return { name: this.doc.name, nameV: this.doc.nameV, nodes: this.doc.nodes, tombs: this.doc.tombs, clock: this.doc.clock };
  }
  indexDoc() {
    this.byId = new Map();
    for (const n of this.doc.nodes) this.byId.set(n.id, n);
  }
  async load() {
    if (this.doc || this.ephemeral) return;
    if (!this.loadP) this.loadP = this._load().finally(() => { this.loadP = null; });
    return this.loadP;
  }
  async _load() {
    if (!this.path) {
      this.path = await this.ctx.storage.get("path");
      this.ephemeral = !!this.path && this.path.indexOf("/__test/") === 0;
      if (this.ephemeral) return;
    }
    const m = await this.ctx.storage.get("m");
    if (m) {
      const rows = await this.ctx.storage.list({ prefix: "n:" });
      const nodes = [];
      this.chunked = new Set();
      for (const [key, val] of rows) {
        let node = typeof val === "string" ? JSON.parse(val) : val;
        if (node && node.__c) { // oversize node, stored chunked
          const parts = [];
          for (let i = 0; i < node.__c; i++) parts.push(await this.ctx.storage.get("N:" + key.slice(2) + ":" + i));
          node = JSON.parse(parts.join(""));
          if (node) this.chunked.add(node.id);
        }
        if (node && node.id) nodes.push(node);
      }
      // restore the persisted z-order (rows come back key-sorted); ids the order row
      // doesn't know (mid-flight writes) sink to the end, stably
      if (Array.isArray(m.order)) {
        const pos = new Map(m.order.map((id, i) => [id, i]));
        nodes.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : Infinity) - (pos.has(b.id) ? pos.get(b.id) : Infinity));
      }
      this.doc = { name: m.name || "Untitled canvas", nameV: m.nameV || 0, nodes, tombs: m.tombs || {}, clock: m.clock || 0 };
      this.indexDoc();
      // Fold the KV mirror back in (version-ruled, so a lagging mirror merges to nothing):
      // solo clients and terminal scripts legitimately write /__board while the room is
      // empty, and waking up storage-only would erase their work at the next mirror write.
      try {
        const raw = this.env.BOARD_KV && this.path ? await this.env.BOARD_KV.get(BOARD_PREFIX + this.path) : null;
        const kv = raw ? JSON.parse(raw) : null;
        if (kv && Array.isArray(kv.nodes)) this.reconcileSeed(kv); // no sender — corrections go nowhere, accepted ops are already durable
      } catch (e) {}
      return;
    }
    await this.migrate();
  }
  // One-time, per board: bring a pre-storage board into the DO. Sources, in trust order:
  // the legacy in-storage stash IF it was dirty (a write the old code owed KV and may never
  // have delivered), else the KV doc. When both exist they reconcile per-node — everything
  // is v-less here, so ties go to whichever source the dirty flag says was newer.
  async migrate() {
    const stash = await this.ctx.storage.get("doc");
    const wasDirty = !!(await this.ctx.storage.get("dirty"));
    let kvDoc = null;
    try {
      const raw = this.env.BOARD_KV && this.path ? await this.env.BOARD_KV.get(BOARD_PREFIX + this.path) : null;
      kvDoc = raw ? JSON.parse(raw) : null;
    } catch (e) {}
    let src = null;
    if (kvDoc && stash && Array.isArray(kvDoc.nodes) && Array.isArray(stash.nodes)) {
      const base = wasDirty ? stash : kvDoc, over = wasDirty ? kvDoc : stash;
      const ids = new Map(base.nodes.map((n) => [n.id, n]));
      for (const n of over.nodes) if (n && n.id && !ids.has(n.id)) ids.set(n.id, n); // union — deletions can't be told apart here, keep both
      src = { name: base.name, nodes: [...ids.values()] };
    } else src = kvDoc || stash || null;
    if (!src || !Array.isArray(src.nodes)) return; // brand-new board — stays null until a client seeds
    this.doc = {
      name: src.name || "Untitled canvas",
      nameV: src.nameV || 0,
      nodes: src.nodes.filter((n) => n && n.id),
      tombs: src.tombs || {},
      clock: src.clock || 0,
    };
    this.indexDoc();
    this.writeAll();
    this.ctx.storage.delete("doc"); // the legacy stash's job is done
    if (wasDirty) this.markDirty(); // the old code owed KV a write — we inherit the debt
  }
  putNode(puts, dels, n) {
    const s = JSON.stringify(n);
    if (s.length <= NODE_CHUNK) {
      puts["n:" + n.id] = s;
      if (this.chunked.delete(n.id)) dels.push(...this.chunkKeys(n.id)); // shrank back under the limit
      return;
    }
    const k = Math.ceil(s.length / NODE_CHUNK);
    for (let i = 0; i < k; i++) puts["N:" + n.id + ":" + i] = s.slice(i * NODE_CHUNK, (i + 1) * NODE_CHUNK);
    puts["n:" + n.id] = JSON.stringify({ __c: k });
    this.chunked.add(n.id);
  }
  chunkKeys(id) {
    // over-delete up to the practical ceiling (16 × 1.8MB ≫ the 20MB doc cap); deleting a
    // missing key is a no-op, and this only runs when a node crosses the chunk boundary
    const out = [];
    for (let i = 0; i < 16; i++) out.push("N:" + id + ":" + i);
    return out;
  }
  metaRow() {
    // `order` pins node z-order across cold loads — storage.list returns rows in KEY
    // order, which silently re-stacked overlapping nodes after every hibernation
    return { name: this.doc.name, nameV: this.doc.nameV, tombs: this.doc.tombs, clock: this.doc.clock, order: this.doc.nodes.map((n) => n.id) };
  }
  writeAll() {
    const puts = { m: this.metaRow() }, dels = [];
    for (const n of this.doc.nodes) this.putNode(puts, dels, n);
    this.flushRows(puts, dels);
  }
  flushRows(puts, dels) {
    if (this.ephemeral) return;
    // no awaits between these — the runtime coalesces them into one atomic write batch
    const keys = Object.keys(puts);
    for (let i = 0; i < keys.length; i += PUT_BATCH) {
      const slice = {};
      for (const k of keys.slice(i, i + PUT_BATCH)) slice[k] = puts[k];
      this.ctx.storage.put(slice).catch((e) => console.error("storage put failed", e));
    }
    for (let i = 0; i < dels.length; i += PUT_BATCH)
      this.ctx.storage.delete(dels.slice(i, i + PUT_BATCH)).catch(() => {});
  }
  adoptDoc(d) {
    this.doc = {
      name: typeof d.name === "string" ? d.name.slice(0, 200) : "Untitled canvas",
      nameV: vOf({ v: d.nameV }),
      nodes: d.nodes.filter((n) => n && n.id),
      tombs: d.tombs && typeof d.tombs === "object" ? d.tombs : {},
      clock: 0,
    };
    this.indexDoc();
    this.writeAll();
    this.markDirty();
  }
  pruneTombs() {
    const t = this.doc.tombs, now = Date.now(), ids = Object.keys(t);
    if (ids.length <= TOMB_MAX && !ids.some((id) => now - (t[id].t || 0) > TOMB_TTL)) return;
    const keep = ids.filter((id) => now - (t[id].t || 0) <= TOMB_TTL)
      .sort((a, b) => (t[b].t || 0) - (t[a].t || 0)).slice(0, TOMB_MAX);
    this.doc.tombs = {};
    for (const id of keep) this.doc.tombs[id] = t[id];
  }
  // Apply a batch under the version rules. Returns what to broadcast (accepted, with
  // room-stamped versions where the sender had none) and what to bounce back to the
  // sender (corrections — the winning state for every op that lost).
  // seedMode: nodes from a {t:"doc"} offer — v-less means v0 (stale until proven fresh),
  // whereas a v-less LIVE op is a legacy client's real edit and is accepted + stamped.
  applyOps(ops, seedMode) {
    const accepted = [], corrections = [];
    let metaDirty = false;
    const puts = {}, dels = [];
    for (const op of ops) {
      if (!op) continue;
      if (op.op === "upsert" && op.node && op.node.id) {
        const n = op.node, id = n.id, cur = this.byId.get(id), tomb = tombAt(this.doc.tombs, id);
        const versioned = typeof n.v === "number";
        if (tomb && !(vOf(n) > tomb.v)) {
          // deleted, and this write predates the delete — a stale resurrection attempt
          if (!seedMode && !versioned) { /* legacy live edit of a deleted node: let the delete win */ }
          // CORRECTIONS MUST STRICTLY OUT-VERSION THE LOSER (audit v2): on a tie the
          // sender's own copy sits at the tomb's v, and its resurrection guard drops a
          // del that doesn't exceed it — raise the tomb so the correction wins there too
          if (versioned && vOf(n) === tomb.v) { tomb.v = vOf(n) + 1; setTomb(this.doc.tombs, id, tomb); metaDirty = true; }
          corrections.push({ op: "del", id, v: tomb.v });
          continue;
        }
        if (cur) {
          if (!versioned && !seedMode) {
            // legacy client's live edit: accept and stamp, so versioned clients converge
            n.v = vOf(cur) + 1; n.vn = rnd();
          } else if (sameV(n, cur)) {
            // same version twice is an idempotent echo — UNLESS the content drifted, which
            // only unversioned (legacy/migrated) writes can produce. The room's copy wins,
            // but a correction at the SAME v/vn would be dropped by the sender's own LWW
            // gate — bump the winner so the correction strictly wins everywhere.
            if (JSON.stringify(n) !== JSON.stringify(cur)) {
              cur.v = vOf(cur) + 1; cur.vn = rnd();
              this.putNode(puts, dels, cur);
              accepted.push({ op: "upsert", node: cur });
              corrections.push({ op: "upsert", node: cur });
            }
            continue;
          } else if (!beats(n, cur)) {
            // a v tie with a lower vn still loses cleanly (the correction's higher vn
            // beats the sender's copy) — only exact sameV needed the bump above
            corrections.push({ op: "upsert", node: cur });
            continue;
          }
        } else if (!versioned && !seedMode) {
          n.v = tomb ? tomb.v + 1 : 1; n.vn = rnd();
        }
        if (tomb) { delete this.doc.tombs[id]; metaDirty = true; }
        if (cur) this.doc.nodes[this.doc.nodes.indexOf(cur)] = n;
        else this.doc.nodes.push(n);
        this.byId.set(id, n);
        this.putNode(puts, dels, n);
        accepted.push({ op: "upsert", node: n });
      } else if (op.op === "del" && op.id) {
        const id = op.id, cur = this.byId.get(id), tomb = tombAt(this.doc.tombs, id);
        const versioned = typeof op.v === "number";
        let tombV;
        if (cur) {
          if (versioned && !(op.v > vOf(cur))) {
            // the delete lost. On a TIE (concurrent delete + edit landing on the same v)
            // the deleter's tomb sits at op.v == cur.v and its resurrection guard drops a
            // corrective upsert that doesn't strictly exceed it — bump the survivor so the
            // correction wins at the deleter too (audit v2: the deleter went blind forever)
            if (op.v === vOf(cur)) {
              cur.v = vOf(cur) + 1; cur.vn = rnd();
              this.putNode(puts, dels, cur);
              accepted.push({ op: "upsert", node: cur });
            }
            corrections.push({ op: "upsert", node: cur });
            continue;
          }
          tombV = versioned ? op.v : vOf(cur) + 1;
          this.doc.nodes.splice(this.doc.nodes.indexOf(cur), 1);
          this.byId.delete(id);
          dels.push("n:" + id);
          if (this.chunked.delete(id)) dels.push(...this.chunkKeys(id));
        } else {
          // nothing to delete, but record/raise the tombstone anyway: it's what stops the
          // node coming back when a slower peer's upsert for it arrives after this del
          tombV = Math.max(versioned ? op.v : 1, tomb ? tomb.v + (versioned ? 0 : 1) : 0);
          if (tomb && tombV <= tomb.v) continue;
        }
        setTomb(this.doc.tombs, id, { v: tombV, t: Date.now() });
        metaDirty = true;
        accepted.push({ op: "del", id, v: tombV });
      } else if (op.op === "name" && typeof op.name === "string") {
        const versioned = typeof op.v === "number";
        const curV = this.doc.nameV;
        if (versioned && op.v <= curV) {
          // name has no vn tiebreak, so a TIE (both renamed offline to the same nameV) is
          // unresolvable by the correction alone — the loser's client drops v <= its own.
          // Bump the winning name past the tie so everyone, loser included, converges.
          if (op.v === curV && op.name !== this.doc.name) {
            this.doc.nameV = curV + 1;
            metaDirty = true;
            accepted.push({ op: "name", name: this.doc.name, v: this.doc.nameV });
          }
          corrections.push({ op: "name", name: this.doc.name, v: this.doc.nameV });
          continue;
        }
        this.doc.name = op.name.slice(0, 200);
        this.doc.nameV = versioned ? op.v : curV + 1;
        metaDirty = true;
        accepted.push({ op: "name", name: this.doc.name, v: this.doc.nameV });
      }
    }
    if (accepted.length || metaDirty) {
      this.doc.clock++;
      this.pruneTombs();
      puts.m = this.metaRow();
      this.flushRows(puts, dels);
      this.markDirty();
    }
    return { accepted, corrections };
  }
  // A {t:"doc"} offer against an existing board: every node becomes a seed-mode upsert,
  // every tomb a del; nodes the room has that the offer lacks are LEFT ALONE (an absence
  // in a stale snapshot is not a deletion — real deletions travel as tombs/ops).
  reconcileSeed(d) {
    const ops = [];
    for (const n of d.nodes) if (n && n.id) ops.push({ op: "upsert", node: n });
    if (d.tombs && typeof d.tombs === "object")
      for (const id of Object.keys(d.tombs)) ops.push({ op: "del", id, v: vOf({ v: d.tombs[id] && d.tombs[id].v }) });
    if (typeof d.name === "string" && typeof d.nameV === "number") ops.push({ op: "name", name: d.name, v: d.nameV });
    const r = this.applyOps(ops, /*seedMode*/ true);
    // corrections the seeder needs beyond op losses: the nodes it doesn't know exist
    const known = new Set(d.nodes.map((n) => n && n.id));
    for (const n of this.doc.nodes) if (!known.has(n.id)) r.corrections.push({ op: "upsert", node: n });
    return r;
  }

  // ---- KV mirror (public GET + solo fallback read from it) -------------------
  // Storage is the source of truth; KV gets a write-through copy on the old cadence: a
  // dirty flag arms a 45s alarm, the last socket leaving flushes immediately. `dirty` is
  // durable because the alarm outlives the instance that armed it (hibernation).
  markDirty() {
    if (this.ephemeral) return;
    if (!this.dirty) { this.dirty = true; this.ctx.storage.put("dirty", 1); }
    if (this.alarmSet) return;
    this.alarmSet = true;
    this.ctx.storage.setAlarm(Date.now() + PERSIST_MS);
  }
  async isDirty() {
    if (this.dirty) return true;
    this.dirty = !!(await this.ctx.storage.get("dirty"));
    return this.dirty;
  }
  clearDirty() {
    this.dirty = false;
    return this.ctx.storage.delete("dirty");
  }
  async alarm() {
    this.alarmSet = false;
    if (this.ephemeral) return;
    if (!(await this.isDirty())) return;
    await this.load(); // hibernation wake: the doc is in storage, no client required
    await this.mirror();
    // still dirty = the write failed, or ops landed while it ran — either way, retry
    if (this.dirty && !this.alarmSet) { this.alarmSet = true; this.ctx.storage.setAlarm(Date.now() + RETRY_MS); }
  }
  async mirror() {
    if (!this.doc || !this.env.BOARD_KV || this.ephemeral) return;
    if (!(await this.isDirty())) return;
    await this.clearDirty(); // before the await: ops during the write re-set it
    try {
      // FOLD BEFORE OVERWRITE (audit v2): a solo client or terminal script may have
      // written /__board while this room was HOT — the old blind put steamrolled that
      // write and, since the room only reads KV on a COLD load, the edit was lost
      // permanently (close-the-laptop-after-a-blip). If KV moved since OUR last mirror,
      // reconcile it in (version-ruled, so a lagging copy merges to nothing) and let the
      // live clients hear whatever was genuinely new.
      const kvRaw = await this.env.BOARD_KV.get(BOARD_PREFIX + this.path);
      if (kvRaw && hashStr(kvRaw) !== (await this.ctx.storage.get("mhash"))) {
        try {
          const kv = JSON.parse(kvRaw);
          if (kv && Array.isArray(kv.nodes)) {
            const r = this.reconcileSeed(kv);
            if (r.accepted.length) this.broadcast({ t: "ops", sid: "room", ops: r.accepted });
          }
        } catch (e2) {}
      }
      const out = JSON.stringify(this.wireDoc());
      await this.env.BOARD_KV.put(BOARD_PREFIX + this.path, out);
      this.ctx.storage.put("mhash", hashStr(out));
    } catch (e) {
      console.error("KV mirror write failed", e);
      this.dirty = true; this.ctx.storage.put("dirty", 1);
      // a failed write deserves the FAST retry — the pending 45s cadence alarm would
      // otherwise swallow the RETRY_MS re-arm (alarmSet is still true from markDirty)
      this.alarmSet = true;
      this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    }
  }

  webSocketClose(ws) { this.reap(ws); }
  webSocketError(ws) { this.reap(ws); }
  // A socket counts as LIVE if it pinged inside ~3 keepalive intervals (sweep's rule). A
  // zombie (dead transport whose close never fired) must not block the last-one-out flush.
  isLive(ws) {
    const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    const a = ws.deserializeAttachment();
    const seen = ts ? ts.getTime() : (a && a.joined) || 0;
    return !seen || Date.now() - seen <= 75000;
  }
  reap(ws) {
    const a = ws.deserializeAttachment();
    try { ws.close(); } catch (e) {}
    if (a) this.broadcast({ t: "leave", peer: { sid: a.sid, name: a.name, color: a.color } }, ws);
    if (!this.ctx.getWebSockets().some((s) => s !== ws && this.isLive(s))) {
      // last one out: mirror to KV NOW (don't wait for the alarm), then drop the RAM cache
      // — storage keeps the doc, so an empty room costs nothing and forgets nothing. A
      // failed mirror stays dirty and the alarm retry path picks it up (the DO wakes on
      // alarms with zero sockets — that's what alarms are for).
      this.load()
        .then(() => this.mirror())
        .catch(() => {})
        .then(() => {
          if (this.dirty && !this.alarmSet) { this.alarmSet = true; this.ctx.storage.setAlarm(Date.now() + RETRY_MS); }
          this.doc = null; this.byId = null;
        });
    }
  }
}
