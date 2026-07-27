/* augur-realtime — one BoardRoom Durable Object per canvas board.
 *
 * The worker upgrades /room?path=<boardPath>&name=<who> to a WebSocket and hands it to
 * the room named by the board path (the same key the KV doc uses). The room is a relay
 * plus soft state: it fans cursor moves / node ops / editing focus out to the other
 * sockets and keeps the latest doc in memory so a joiner starts from the live state
 * rather than a possibly-stale KV read.
 *
 * THE ROOM IS ALSO THE PERSISTER (2026-07-27). While a room is live, the room — not the
 * clients — writes the doc to KV: a dirty flag set by ops arms a single alarm (45s), and
 * the last socket leaving flushes immediately. That collapses N clients × edit-bursts of
 * whole-document client writes into ≤ ~80 writes/hour per hot board, and ends the
 * last-writer-wins stomps between two saving browsers. Clients still write /__board
 * themselves ONLY as the solo fallback (socket down). Rooms under /__test/ never persist
 * — that's the Playwright isolation convention (see augur/CANVAS.md).
 *
 * Uses the WebSocket Hibernation API, so an idle board with open tabs costs ~nothing.
 * In-memory fields (doc, colors) are caches: after a hibernation wake they rebuild
 * from socket attachments and the docreq dance below. Anything the ALARM depends on must
 * therefore be durable, because the alarm outlives the instance that armed it and fires
 * into a fresh one: ctx.storage holds "path" (the KV key), "dirty" (a write is pending)
 * and "doc" (a stash, refreshed once per alarm window, for flushing an empty room).
 *
 * Protocol (JSON, one object per message):
 *   client→room: {t:"cursor",x,y,drag?}|{t:"cursor",gone:true} · {t:"ops",ops:[...]} ·
 *                {t:"focus",id|null} · {t:"sel",ids:[...]} (live selection) ·
 *                {t:"status",text,state} (persistent work state under an agent cursor:
 *                state working|idle|attention; kept on the attachment for late joiners) ·
 *                {t:"chat",text} (FigJam-style cursor chat — pure ephemeral relay) ·
 *                {t:"proto",id,ev} (demo sync in a live tile iframe) ·
 *                {t:"doc",doc} (reply to needDoc/docreq)
 *   room→client: {t:"welcome",sid,color,peers,doc?,needDoc?} · {t:"join"|"leave",peer} ·
 *                relayed cursor/ops/focus/sel/status/chat stamped with the sender's info ·
 *                {t:"doc",doc} · {t:"docreq"}
 * cursor.drag is the drag fast-path: [{id,x,y,w,h},…] geometry for nodes mid-drag,
 * relayed verbatim on the cursor cadence (~20Hz) so remote drags glide instead of
 * stepping at the 120ms ops tick. Ephemeral — the durable version rides the ops tick.
 * Ops (applied to the room doc AND relayed): {op:"upsert",node} · {op:"del",id} ·
 * {op:"name",name}. The doc's `view` is per-user viewport — never synced (the copy
 * inside the persisted doc is a harmless fossil; clients read their camera from
 * localStorage).
 */

const MAX_MSG = 8 * 1024 * 1024; // a node op can carry an inlined image; KV caps the doc at 20MB
const COLORS = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#e64980", "#f08c00", "#0c8599", "#6741d9"];

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true, service: "augur-realtime" });
    if (url.pathname !== "/room") return json({ error: "not-found" }, 404);
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected-websocket" }, 426);
    const path = (url.searchParams.get("path") || "").slice(0, 600);
    if (!path) return json({ error: "bad-input" }, 400);
    const id = env.ROOMS.idFromName(path);
    return env.ROOMS.get(id).fetch(request);
  },
};

const BOARD_PREFIX = "board:";   // same key scheme as the Pages worker's /__board rail
const PERSIST_MS = 45000;        // dirty → alarm → KV write; ≤ ~80 writes/hour per hot board

export class BoardRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.doc = null;      // latest board doc (cache — null after hibernation wake)
    this.wantDoc = false; // a docreq is in flight, don't spam
    this.dirty = false;   // doc changed since the last KV write (mirrored durably — see markDirty)
    this.coldWrite = false; // an alarm woke without a doc and asked a client for one
    this.alarmSet = false;
    this.sweptAt = 0;
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
      const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const a = ws.deserializeAttachment();
      const seen = ts ? ts.getTime() : (a && a.joined) || 0;
      if (seen && now - seen > 75000) this.reap(ws); // no ping in ~3 intervals = dead
    }
  }

  peers(excludeWs) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const a = ws.deserializeAttachment();
      if (a) out.push({ sid: a.sid, name: a.name, color: a.color, kind: a.kind || null, pose: a.pose || null, focus: a.focus || null, sel: a.sel || null, status: a.status || null });
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

  async fetch(request) {
    const url = new URL(request.url);
    const path = (url.searchParams.get("path") || "").slice(0, 600);
    if (path) this.ctx.storage.put("path", path); // the alarm needs it after a hibernation wake
    const name = (url.searchParams.get("name") || "Guest").slice(0, 60);
    const sid = "p" + Math.random().toString(36).slice(2, 10);
    // `kind=agent` marks a Claude collaboration client — clients render it as Clawd, not the
    // arrow. Only an agent may PIN its color (so Clawd stays its brand hue instead of a
    // palette slot); humans always take the next palette color (no color hijacking).
    const kind = (url.searchParams.get("kind") || "").slice(0, 16) || null;
    const reqColor = url.searchParams.get("color");
    const pinned = kind === "agent" && reqColor && /^#[0-9a-fA-F]{6}$/.test(reqColor) ? reqColor : null;
    const color = pinned || COLORS[this.ctx.getWebSockets().length % COLORS.length];

    this.sweep();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sid, name, color, kind, pose: null, focus: null, joined: Date.now() });

    const welcome = { t: "welcome", sid, color, peers: this.peers(server) };
    if (this.doc) welcome.doc = this.doc;
    else if (welcome.peers.length) welcome.needDoc = true; // room woke from hibernation mid-session
    server.send(JSON.stringify(welcome));
    this.broadcast({ t: "join", peer: { sid, name, color, kind, pose: null, focus: null } }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
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
    if (msg.t === "proto") {
      // demo sync inside live prototype tiles — pure ephemeral relay, nothing stored
      this.broadcast({ t: "proto", sid: a.sid, id: msg.id, ev: msg.ev }, ws);
      return;
    }
    if (msg.t === "ops" && Array.isArray(msg.ops)) {
      this.applyOps(msg.ops);
      if (this.doc) this.markDirty();
      this.broadcast({ t: "ops", sid: a.sid, ops: msg.ops }, ws);
      // room lost its doc (hibernation) and can't rebuild from deltas — ask the sender,
      // who by definition has the current state, for a full snapshot
      if (!this.doc && !this.wantDoc) {
        this.wantDoc = true;
        try { ws.send(JSON.stringify({ t: "docreq" })); } catch (e) {}
      }
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
      // FigJam cursor chat: ephemeral, relayed and forgotten (no storage, no replay)
      const text = (typeof msg.text === "string" ? msg.text : "").slice(0, 200);
      if (text) this.broadcast({ t: "chat", sid: a.sid, name: a.name, color: a.color, kind: a.kind || null, text }, ws);
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
      const had = !!this.doc;
      this.doc = msg.doc;
      this.wantDoc = false;
      // A fresh seed marks dirty on purpose: the seeder might carry an edit made in the
      // ~1s between its last KV load and the socket coming up — its own save() skips the
      // POST once the room is live, so if the room didn't persist the seed, that edit
      // would only ever exist in RAM. One extra write per room session buys the guarantee.
      this.markDirty();
      // A cold alarm asked for this doc because it woke without one. Write NOW: arming
      // another 45s alarm risks landing cold again, which is how a room stalls forever.
      if (this.coldWrite) { this.coldWrite = false; this.persist(); }
      // first seed of a live room: peers loaded from KV themselves, no need to rebroadcast;
      // only a post-hibernation reseed stays silent too — ops already kept everyone level.
      if (!had) return;
    }
  }

  // ---- persistence (the room owns the KV write while it's alive) ------------
  // HIBERNATION-SAFE. The alarm is DURABLE, `dirty` and `doc` are in-memory caches, so an
  // alarm armed before a hibernation wake fires into a FRESH instance where dirty=false and
  // doc=null — the write was silently skipped and, because the re-arm is also guarded by
  // dirty, never retried. `path` was already made durable for exactly this reason; the
  // pending-write flag now lives beside it, and a cold alarm rebuilds the doc from a live
  // client (docreq — they hold the truth) or, in an empty room, from the durable stash.
  markDirty() {
    this.dirty = true;
    this.ctx.storage.put("dirty", 1);
    if (this.alarmSet) return;
    this.alarmSet = true;
    // Stash the doc when ARMING (≤ once per window, not per ops tick) so a cold alarm with
    // no one left to ask still has something to write. Best effort: a doc over the DO value
    // limit just doesn't stash, and the docreq path covers it.
    if (this.doc) { try { this.ctx.storage.put("doc", this.doc).catch(() => {}); } catch (e) {} }
    this.ctx.storage.setAlarm(Date.now() + PERSIST_MS);
  }
  // Write whatever is pending, from a cold instance if need be (no client left to ask).
  async flush() {
    if (!(await this.isDirty())) return;
    if (!this.doc) {
      const stashed = await this.ctx.storage.get("doc");
      if (stashed) this.doc = stashed;
    }
    await this.persist();
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
    if (!(await this.isDirty())) return;
    if (!this.doc) {
      // Cold wake. A connected client has the current state — ask, and write when it answers
      // (see the `doc` handler). Re-arm as the safety net in case nobody replies.
      const ws = this.ctx.getWebSockets()[0];
      if (ws) {
        this.coldWrite = true;
        if (!this.wantDoc) {
          this.wantDoc = true;
          try { ws.send(JSON.stringify({ t: "docreq" })); } catch (e) {}
        }
        this.alarmSet = true;
        this.ctx.storage.setAlarm(Date.now() + PERSIST_MS);
        return;
      }
      const stashed = await this.ctx.storage.get("doc"); // empty room: the stash is all we have
      if (stashed) this.doc = stashed;
    }
    await this.persist();
    // still dirty means ops landed while the write was in flight — re-arm
    if (this.dirty) this.markDirty();
  }
  async persist() {
    if (!this.doc || !this.env.BOARD_KV) return;
    if (!(await this.isDirty())) return;
    const path = await this.ctx.storage.get("path");
    if (!path || path.indexOf("/__test/") === 0) { await this.clearDirty(); return; } // test rooms never persist (Playwright isolation)
    await this.clearDirty(); // before the await: ops during the write re-set it
    try { await this.env.BOARD_KV.put(BOARD_PREFIX + path, JSON.stringify(this.doc)); }
    catch (e) { this.dirty = true; this.ctx.storage.put("dirty", 1); } // failed write: the next alarm retries
  }

  applyOps(ops) {
    if (!this.doc) return;
    for (const op of ops) {
      if (!op) continue;
      if (op.op === "upsert" && op.node && op.node.id) {
        const i = this.doc.nodes.findIndex((n) => n.id === op.node.id);
        if (i >= 0) this.doc.nodes[i] = op.node;
        else this.doc.nodes.push(op.node);
      } else if (op.op === "del" && op.id) {
        this.doc.nodes = this.doc.nodes.filter((n) => n.id !== op.id);
      } else if (op.op === "name" && typeof op.name === "string") {
        this.doc.name = op.name.slice(0, 200);
      }
    }
  }

  webSocketClose(ws) { this.reap(ws); }
  webSocketError(ws) { this.reap(ws); }
  reap(ws) {
    const a = ws.deserializeAttachment();
    try { ws.close(); } catch (e) {}
    if (a) this.broadcast({ t: "leave", peer: { sid: a.sid, name: a.name, color: a.color } }, ws);
    if (!this.ctx.getWebSockets().some((s) => s !== ws)) {
      // last one out: flush the doc to KV NOW (don't wait for the alarm), then drop the
      // cache. No waitUntil — the runtime keeps a DO alive while async work is in flight.
      // dirty/doc can both be cold here (hibernation wake), so flush() re-reads them.
      const d = this.doc;
      this.flush().then(() => { if (this.doc === d) this.doc = null; });
    }
  }
}
