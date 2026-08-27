/* A board client that sends what the real one sends, at the cadence the real one sends it.
 *
 * Every constant and every gate below is lifted from src/canvas/canvas.js and cited, so a
 * drift between this replay and the shipped client is findable rather than invisible. What
 * it deliberately does NOT do is render anything: the room's cost is a function of the
 * message stream reaching it, and nothing else, so a faithful message stream is the whole
 * of the fidelity that matters on this side of the socket.
 *
 * The one thing this cannot replay is a human. That is why the session profile lives in
 * measure.mjs as a stated shape (gesture lengths, think pauses) rather than being buried
 * here: the profile is an assumption and has to be reported as one.
 */

// canvas.js:5705 — `setInterval(… mp.send("ping") …, 25000)`. The room registers
// ("ping" → "pong") as a WebSocket auto-response pair (board-room.mjs:133), so in
// production this frame is answered by the runtime without waking the object. Whether
// that is true is exactly what the idle scenario measures.
export const PING_MS = 25000;
// canvas.js:5370 — mpTrackPointer throttles cursor frames to one per 50ms while the
// pointer is moving, i.e. ~20 frames/s.
export const CURSOR_MS = 50;
// canvas.js:5687 — `setInterval(mpTick, 120)`, the outbound diff tick.
export const TICK_MS = 120;
// canvas.js:4610 — the tick's idle gate: run the diff only on `force || drag ||
// Date.now() - mpPokeAt < 2000 || mpTickN % 8 === 0`.
export const POKE_MS = 2000;
export const IDLE_TICK_EVERY = 8;

const enc = encodeURIComponent;

export class BoardClient {
  constructor(origin, path, name) {
    this.origin = origin;
    this.path = path;
    this.name = name;
    this.ws = null;
    this.sent = { cursor: 0, ops: 0, ping: 0, doc: 0, other: 0 };
    this.bytes = 0;
    this.nodes = new Map();   // id → node (this client's copy)
    this.shadow = new Map();  // id → signature as last sent (canvas.js mpShadow)
    this.pokeAt = 0;
    this.dragging = false;
    this.tickN = 0;
    this.timers = [];
  }

  open() {
    const url = `${this.origin}/room?path=${enc(this.path)}&name=${enc(this.name)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = (e) => reject(new Error(`socket failed: ${(e && e.message) || e}`));
      ws.addEventListener("error", fail);
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        if (ev.data === "pong") return;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === "welcome") {
          this.sid = m.sid;
          // ⚠️ THE SEED IS NOT OPTIONAL, AND LEAVING IT OUT MEASURES THE WRONG ROOM.
          // A board nobody has saved yet leaves `doc` null in the room (board-room.mjs
          // migrate(): "brand-new board — stays null until a client seeds"), and the ops
          // branch then RELAYS without applying — no storage write, no dirty flag, no
          // 45s mirror alarm. A client that skips this handshake therefore records a room
          // doing a fraction of the work a real one does, and every number taken off it
          // is low. canvas.js:5598 sends this on `needDoc`; canvas.js:5624 sends it again
          // on `docreq`. Both, here.
          if (m.needDoc) this.seed();
          resolve(this);
        } else if (m.t === "docreq") this.seed();
      });
      ws.addEventListener("close", () => { this.stop(); });
      setTimeout(() => reject(new Error("welcome timed out")), 15000);
    });
  }

  // The keepalive and the diff tick are the two things a real tab runs forever, whether or
  // not anybody is touching it. Starting them is what makes an "idle tab" an idle TAB
  // rather than an idle socket.
  start() {
    this.timers.push(setInterval(() => this.raw("ping"), PING_MS));
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    return this;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  close() {
    this.stop();
    try { this.ws.close(); } catch (e) {}
  }

  raw(s) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(s);
    this.bytes += s.length;
    if (s === "ping") this.sent.ping++;
  }

  send(msg) {
    const s = JSON.stringify(msg);
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(s);
    this.bytes += s.length;
    const k = msg.t === "cursor" ? "cursor" : msg.t === "ops" ? "ops" : msg.t === "doc" ? "doc" : "other";
    this.sent[k]++;
  }

  seed() {
    this.send({ t: "doc", doc: { name: "Cost board", nameV: 1, nodes: [...this.nodes.values()], tombs: {}, clock: 1 } });
  }

  poke() { this.pokeAt = Date.now(); }

  sig(n) { return JSON.stringify(n); }

  // canvas.js:4614 — the diff: bump v/vn on anything whose signature moved, send upserts.
  tick(force) {
    this.tickN++;
    if (!(force || this.dragging || Date.now() - this.pokeAt < POKE_MS || this.tickN % IDLE_TICK_EVERY === 0)) return;
    const ops = [];
    for (const n of this.nodes.values()) {
      const s = this.sig(n);
      if (this.shadow.get(n.id) !== s) {
        n.v = (n.v || 0) + 1;
        n.vn = Math.floor(Math.random() * 0x7fffffff);
        this.shadow.set(n.id, this.sig(n));
        ops.push({ op: "upsert", node: { ...n } });
      }
    }
    if (ops.length) this.send({ t: "ops", ops });
  }

  addNode(id, extra) {
    const n = { id, type: "text", x: 100, y: 100, w: 220, h: 90, text: "note", color: "#ffd43b", ...extra };
    this.nodes.set(id, n);
    this.poke();
    return n;
  }

  // A DRAG: pointer frames at 20Hz carrying the node's live geometry (canvas.js:5341 —
  // the drag fast-path), while the 120ms tick keeps shipping the durable upsert. This is
  // the most expensive thing a person does to a room per unit of time, so a session
  // profile built out of it is an upper-ish bound on ordinary editing.
  async drag(id, ms) {
    const n = this.nodes.get(id) || this.addNode(id);
    this.dragging = true;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      n.x += 3; n.y += 2;
      this.poke();
      this.send({ t: "cursor", x: n.x, y: n.y, drag: [{ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }] });
      await sleep(CURSOR_MS);
    }
    this.dragging = false;
    this.poke();
  }

  // TYPING: no cursor frames at all (the pointer is still), but every keystroke changes a
  // node's signature, so the 120ms tick ships an upsert ~8 times a second.
  async type(id, ms) {
    const n = this.nodes.get(id) || this.addNode(id);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      n.text += "x";
      this.poke();
      await sleep(60); // ~16 chars/s, a brisk typist
    }
    this.poke();
  }

  // PANNING / ZOOMING: view frames only, change-gated and throttled client-side
  // (canvas.js:5571). Cheap, and included because a real session is not only edits.
  async pan(ms) {
    const until = Date.now() + ms;
    let x = 0;
    while (Date.now() < until) {
      x += 40;
      this.send({ t: "view", v: { x, y: 0, s: 1, w: 1440, h: 900 } });
      await sleep(100);
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
