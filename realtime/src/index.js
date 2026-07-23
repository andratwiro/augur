/* augur-realtime — one BoardRoom Durable Object per canvas board.
 *
 * The worker upgrades /room?path=<boardPath>&name=<who> to a WebSocket and hands it to
 * the room named by the board path (the same key the KV doc uses). The room is a relay
 * plus soft state: it fans cursor moves / node ops / editing focus out to the other
 * sockets and keeps the latest doc in memory so a joiner starts from the live state
 * rather than a possibly-stale KV read. Durable persistence stays on the existing
 * /__board KV rail, written by clients exactly as before — a hibernated or evicted
 * room loses nothing that matters.
 *
 * Uses the WebSocket Hibernation API, so an idle board with open tabs costs ~nothing.
 * In-memory fields (doc, colors) are caches: after a hibernation wake they rebuild
 * from socket attachments and the docreq dance below.
 *
 * Protocol (JSON, one object per message):
 *   client→room: {t:"cursor",x,y}|{t:"cursor",gone:true} · {t:"ops",ops:[...]} ·
 *                {t:"focus",id|null} · {t:"doc",doc} (reply to needDoc/docreq)
 *   room→client: {t:"welcome",sid,color,peers,doc?,needDoc?} · {t:"join"|"leave",peer} ·
 *                relayed cursor/ops/focus stamped with the sender's peer info ·
 *                {t:"doc",doc} · {t:"docreq"}
 * Ops (applied to the room doc AND relayed): {op:"upsert",node} · {op:"del",id} ·
 * {op:"name",name}. The doc's `view` is per-user viewport — never synced.
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

export class BoardRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.doc = null;      // latest board doc (cache — null after hibernation wake)
    this.wantDoc = false; // a docreq is in flight, don't spam
  }

  peers(excludeWs) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const a = ws.deserializeAttachment();
      if (a) out.push({ sid: a.sid, name: a.name, color: a.color, focus: a.focus || null });
    }
    return out;
  }

  broadcast(msg, exceptWs) {
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(raw); } catch (e) { /* closing socket — the close handler reaps it */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "Guest").slice(0, 60);
    const sid = "p" + Math.random().toString(36).slice(2, 10);
    const color = COLORS[this.ctx.getWebSockets().length % COLORS.length];

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sid, name, color, focus: null });

    const welcome = { t: "welcome", sid, color, peers: this.peers(server) };
    if (this.doc) welcome.doc = this.doc;
    else if (welcome.peers.length) welcome.needDoc = true; // room woke from hibernation mid-session
    server.send(JSON.stringify(welcome));
    this.broadcast({ t: "join", peer: { sid, name, color, focus: null } }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const a = ws.deserializeAttachment();
    if (!a || !msg || !msg.t) return;

    if (msg.t === "cursor") {
      this.broadcast({ t: "cursor", sid: a.sid, name: a.name, color: a.color, x: msg.x, y: msg.y, gone: !!msg.gone }, ws);
      return;
    }
    if (msg.t === "ops" && Array.isArray(msg.ops)) {
      this.applyOps(msg.ops);
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
    if (msg.t === "doc" && msg.doc && Array.isArray(msg.doc.nodes)) {
      const had = !!this.doc;
      this.doc = msg.doc;
      this.wantDoc = false;
      // first seed of a live room: peers loaded from KV themselves, no need to rebroadcast;
      // only a post-hibernation reseed stays silent too — ops already kept everyone level.
      if (!had) return;
    }
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
    if (!this.ctx.getWebSockets().some((s) => s !== ws)) this.doc = null; // empty room → drop the cache
  }
}
