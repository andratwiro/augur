// clawd-canvas — the terminal half of live canvas collaboration.
//
// Lets a Claude agent JOIN a canvas board's multiplayer room as a real participant
// ("Clawd") and co-work in real time: move a cursor, raise a focus ring on the node it's
// working, and stream node edits — everything a human client does, over the same /__rt
// protocol (augur-realtime BoardRoom DO). No browser: a raw WebSocket speaks the protocol
// directly (Node's global WebSocket). Durable persistence is the ROOM's job while the
// socket is live (BoardRoom DO writes KV itself); /__board POST is only the offline fallback.
//
// The engine renders any peer with kind:"agent" as the Clawd mascot (tinted by color) with
// a name pill + focus rings, so the human sees WHERE Clawd is and WHAT it's touching.
//
// Usage:
//   import { ClawdCanvas } from './clawd-canvas.mjs'
//   const c = new ClawdCanvas({ boardPath: '/ux-ui-audit/project-flow-audit/' })
//   await c.connect()
//   await c.moveCursorTo(x, y); c.focus(nodeId); c.upsert(node); await c.save()
//
// The co-working PROTOCOL (design decision): show activity on the canvas FIRST,
// then do the work. On any ask: walk to the relevant spot + pose('thinking') + say(...)
// before reasoning; before building an artifact: stub() a placeholder where it will land
// + pose('sparkles'); emotions as punctuation (happy = done, sunglasses = shipped live,
// love = the human liked it, sleeping = parked). Bubbles are stream-only (never saved);
// stubs persist until the real artifact replaces them.
//
// CLI:
//   node clawd-canvas.mjs probe  <boardPath>           # connect, print doc + peers, leave
//   node clawd-canvas.mjs demo   <boardPath>           # walk in, drop a sticky, wave, leave
//   node clawd-canvas.mjs chill  <boardPath> [x y]     # park sleeping, stay until killed
//   All modes take [--name N --color '#hex'] — the agent's identity. Multiple agents can
//   co-work the same board simultaneously: each runs its OWN daemon (own name, color, and
//   command file); the engine renders each as its own tinted Clawd, per-node LWW merges.
//   ⚠️ In daemon mode DON'T pass --name/--color for the session's own Clawd: with neither
//   it reads BOTH from the session transcript and FOLLOWS /rename and /color automatically
//   (see "session identity" below). Pass them only to pin a sibling agent's own identity.
//
//   node clawd-canvas.mjs daemon <boardPath> <cmdFile> # persistent puppet: tail a JSONL
//     command file and execute in order — one connection an agent can command across turns.
//     Launch DETACHED (nohup … & echo $! > clawd-daemon.pid; disown) so harness task
//     cleanups can't reap it; dismiss explicitly with {"cmd":"quit"} or the pidfile.
//     Commands (one JSON object per line, appended):
//       {"cmd":"goto","x":2400,"y":300}                  glide there (walking pose derives)
//       {"cmd":"pose","v":"thinking|sparkles|happy|love|sunglasses|sleeping|idle"}
//       {"cmd":"say","text":"reading the board…"}        ephemeral bubble near the cursor
//       {"cmd":"unsay"}                                  remove the bubble
//       {"cmd":"focus","id":"st3"}                       focus ring (null to clear)
//       {"cmd":"stub","x":..,"y":..,"w":..,"h":..,"label":"common ground"}   placeholder
//       {"cmd":"upsert","node":{...}} / {"cmd":"del","id":".."}   real edits (KV-saved;
//         add "ephemeral":true for stream-only)
//       {"cmd":"rename","name":".."} {"cmd":"save"} {"cmd":"quit"}
//       {"cmd":"chill","v":false}                        disable the ambient chill loop
//       {"cmd":"identity","name":"F5 Clawd"}             rename the AGENT live (quick
//         reconnect; color re-derives unless "color" is given). Rarely needed by hand —
//         a nameless daemon already follows the session's own name AND /color.
//     It also mirrors the live doc to <cmdFile dir>/clawd-board.json on every op, so the
//     agent always reads the human's latest state without reconnecting. While connected and
//     idle (no commands ~12s, pose plain idle) Clawd CHILLS instead of freezing: fidgets,
//     strolls near the human's cursor or around the content, the odd happy blip.

import { readFileSync } from 'node:fs';
import { deployConfig } from './lib/instance.mjs';

// This instance's room server and site — resolved from the shell's deploy.config.json
// (the same source the built worker's /__rt proxy reads), never hardcoded: the engine is
// shared, and a baked-in origin would drop an agent into ANOTHER instance's rooms.
// A bare SPACE clone (no shell) still works: space.json's siteOrigin supplies the site,
// and with no realtime origin the client goes through the site's own /__rt proxy.
const DEPLOY = deployConfig();
const SPACE = (() => {
  try { return JSON.parse(readFileSync('space.json', 'utf8')); }
  catch { return {}; }
})();
const RT_ORIGIN = String(process.env.CANVAS_RT_ORIGIN || DEPLOY.realtimeOrigin || '')
  .replace(/^http/, 'ws').replace(/\/+$/, '');
const SITE = process.env.CANVAS_SITE_ORIGIN || process.env.REVIEW_SITE_URL ||
  DEPLOY.siteOrigin || SPACE.siteOrigin || '';
const CLAWD_ORANGE = '#d97757'; // Claude clay — the primary agent's Clawd hue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

// identity color: the terminal session's /color is the source of truth (the daemon reads
// it from the transcript — see sessionNamer); the name hash is only the fallback for
// sessions that never picked one, so a terminal's Clawd keeps a stable color across
// restarts with no coordination. Plain "Clawd" = the orange.
const PALETTE = ['#4e8fd9', '#8a63c9', '#2e9e6b', '#d9569b', '#c8912e', '#3aa6b9', '#6a7dd9', '#b5533c'];
// Claude Code's /color names, mapped onto the board palette's hues
export const TERM_COLORS = {
  red: '#b5533c', orange: CLAWD_ORANGE, yellow: '#c8912e', green: '#2e9e6b',
  blue: '#4e8fd9', purple: '#8a63c9', pink: '#d9569b',
};
export const colorFor = (name) => {
  if (!name || slug(name) === 'clawd') return CLAWD_ORANGE;
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export class ClawdCanvas {
  constructor({ boardPath, name = 'Clawd', color, site = SITE, rtOrigin = RT_ORIGIN } = {}) {
    if (!boardPath) throw new Error('boardPath required');
    if (!site) throw new Error('no site origin — pass {site}, set CANVAS_SITE_ORIGIN, or run from a space clone whose space.json has "siteOrigin"');
    // No dedicated realtime origin? Go through the site's own /__rt proxy — it forwards
    // to the instance's room server, so a bare space clone works with zero config.
    this._roomPath = '/room';
    if (!rtOrigin) {
      rtOrigin = String(site).replace(/^http/, 'ws').replace(/\/+$/, '');
      this._roomPath = '/__rt';
    }
    this.boardPath = boardPath;
    this.name = name;
    this.color = color || colorFor(name);
    this.site = site;
    this.rtOrigin = rtOrigin;
    this.doc = { v: 1, name: 'Untitled canvas', nodes: [] };
    this.peers = {};        // sid -> {name,color,kind,focus}
    this.sid = null;
    this.ready = false;
    this._cur = { x: 0, y: 0 };
    this._pose = 'idle';
    this._ws = null;
    this._onready = null;
    this._saveT = null;
    this._pingT = null;
  }

  // A room server with RT_SHARED_SECRET set rejects anything that didn't come through
  // the site's /__rt proxy (which holds the secret and enforces the admin-space seal).
  // A terminal client has no secret, so a direct-origin handshake 403s there. Fall back
  // to the proxy once, transparently: it routes to the same rooms on every instance, and
  // instances whose room server has no secret keep taking the direct route as before.
  async connect() {
    try {
      return await this._dial();
    } catch (e) {
      if (this._roomPath !== '/room' || !this.site) throw e;
      this.rtOrigin = String(this.site).replace(/^http/, 'ws').replace(/\/+$/, '');
      this._roomPath = '/__rt';
      return await this._dial();
    }
  }

  _dial() {
    const url = `${this.rtOrigin}${this._roomPath}?path=${encodeURIComponent(this.boardPath)}` +
      `&name=${encodeURIComponent(this.name)}&kind=agent&color=${encodeURIComponent(this.color)}`;
    const ws = new WebSocket(url);
    this._ws = ws;
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    // keepalive: the room reaps sockets that stop pinging (~75s) — ping every 25s so a
    // parked/sleeping Clawd stays present in the room across turns
    ws.addEventListener('open', () => {
      this._pingT = setInterval(() => { if (this._ws && this._ws.readyState === 1) { try { this._ws.send('ping'); } catch {} } }, 25000);
    });
    ws.addEventListener('close', () => { this.ready = false; clearInterval(this._pingT); });
    return new Promise((resolve, reject) => {
      this._onready = resolve;
      ws.addEventListener('error', reject, { once: true });
      setTimeout(() => this.ready || reject(new Error('welcome timeout')), 12000);
    });
  }

  async _onMessage(ev) {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || !m.t) return;
    if (m.t === 'welcome') {
      this.sid = m.sid;
      this.color = m.color || this.color;
      this.peers = {};
      (m.peers || []).forEach((p) => (this.peers[p.sid] = { name: p.name, color: p.color, kind: p.kind, pose: p.pose, focus: p.focus }));
      if (m.doc) this.doc = m.doc;
      else { // no live doc — pull the durable copy from KV so we edit on top of the real board
        const kv = await this._getKv();
        if (kv) { this.doc = kv; this._send({ t: 'doc', doc: this.doc }); }
      }
      this.ready = true;
      // sweep bubbles orphaned by a crashed run — a human's full-state save can have
      // persisted one to KV, so delete durably. Multi-agent aware: never pop a bubble
      // whose owner is currently in the room (each agent's bubble id carries its name).
      const present = new Set(Object.values(this.peers).filter((p) => p.kind === 'agent').map((p) => 'clawd-bubble-' + slug(p.name)));
      const orphans = this.doc.nodes.filter((n) => String(n.id).startsWith('clawd-bubble') && !present.has(n.id));
      if (orphans.length) { for (const n of orphans) this.del(n.id); }
      if (this._onready) { this._onready(this); this._onready = null; }
    } else if (m.t === 'join') {
      this.peers[m.peer.sid] = { name: m.peer.name, color: m.peer.color, kind: m.peer.kind, pose: m.peer.pose, focus: m.peer.focus };
    } else if (m.t === 'leave') {
      delete this.peers[m.peer.sid];
    } else if (m.t === 'cursor') {
      const p = this.peers[m.sid]; if (p && !m.gone) { p.cx = m.x; p.cy = m.y; }
    } else if (m.t === 'ops') {
      this._applyOps(m.ops || []); // track the human's edits so our doc stays current
    } else if (m.t === 'focus') {
      const p = this.peers[m.sid]; if (p) p.focus = m.id || null;
    } else if (m.t === 'sel') {
      const p = this.peers[m.sid]; if (p) p.sel = m.ids || null; // what each human has selected — the politeness guard reads this
    } else if (m.t === 'chat') {
      if (this.onChat) { try { this.onChat({ sid: m.sid, name: m.name, kind: m.kind || null, text: m.text }); } catch {} }
    } else if (m.t === 'kick') {
      // evicted from the board by a human — the room only sends this to the target
      if (m.sid === this.sid && this.onKick) { try { this.onKick({ by: m.by || '' }); } catch {} }
    } else if (m.t === 'pose') {
      const p = this.peers[m.sid]; if (p) p.pose = m.pose || null;
    } else if (m.t === 'doc') {
      if (m.doc && Array.isArray(m.doc.nodes)) this.doc = m.doc;
    } else if (m.t === 'docreq') {
      this._send({ t: 'doc', doc: this.doc }); // room woke hibernated; we have current state
    }
  }

  _applyOps(ops) {
    for (const op of ops) {
      if (!op) continue;
      if (op.op === 'upsert' && op.node && op.node.id) {
        const i = this.doc.nodes.findIndex((n) => n.id === op.node.id);
        if (i >= 0) this.doc.nodes[i] = op.node; else this.doc.nodes.push(op.node);
      } else if (op.op === 'del' && op.id) {
        this.doc.nodes = this.doc.nodes.filter((n) => n.id !== op.id);
      } else if (op.op === 'name' && typeof op.name === 'string') {
        this.doc.name = op.name;
      }
    }
  }

  _send(msg) { if (this._ws && this._ws.readyState === 1) { try { this._ws.send(JSON.stringify(msg)); } catch {} } }

  async _getKv() {
    try {
      const r = await fetch(`${this.site}/__board?path=${encodeURIComponent(this.boardPath)}`);
      if (!r.ok) return null;
      const j = await r.json();
      const d = j.doc || j;
      return d && Array.isArray(d.nodes) ? d : null;
    } catch { return null; }
  }

  // ---- the co-working verbs ------------------------------------------------
  cursor(x, y) { this._cur = { x, y }; this._send({ t: 'cursor', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }); }

  // glide the cursor so the human sees Clawd walk over, not teleport. Duration is
  // DISTANCE-PROPORTIONAL (humans cross a desk faster than they nudge a mouse): short hops
  // are quick, treks are brisk, nothing is slow-motion or teleporty. Explicit steps/stepMs
  // still win (the chill loop uses slow ambles on purpose).
  async moveCursorTo(x, y, opts = {}) {
    const sx = this._cur.x, sy = this._cur.y;
    const dist = Math.hypot(x - sx, y - sy);
    const dur = Math.max(180, Math.min(1100, dist * 0.9));
    const steps = opts.steps || Math.max(5, Math.round(dur / (opts.stepMs || 40)));
    const stepMs = opts.stepMs || 40;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
      this.cursor(sx + (x - sx) * e, sy + (y - sy) * e);
      await sleep(stepMs);
    }
    if (this._bubbleText) this._placeBubble(); // the speech bubble follows Clawd
  }

  focus(id) { this._send({ t: 'focus', id: id || null }); }
  sel(ids) { this._send({ t: 'sel', ids: Array.isArray(ids) ? ids : ids ? [ids] : [] }); } // point with selection rings ("these three")
  // the persistent line in the board's agents strip: what am I doing, and do I need you.
  // state: working | idle | attention | done — attention pulses amber, done flashes green.
  status(text, state) { this._send({ t: 'status', text: text || '', state: state || 'working' }); }
  chat(text) { this._send({ t: 'chat', text: String(text || '').slice(0, 200) }); } // cursor-chat bubble (a moment; status is the state)

  // ---- politeness: never grab what a human's hands are on -------------------
  _heldBy(id) {
    return Object.values(this.peers).find((p) => p.kind !== 'agent' && (p.focus === id || (p.sel || []).indexOf(id) >= 0)) || null;
  }
  // wait (politely, visibly) for a human to let go of a node; give up after `timeout` and
  // proceed — matching a human colleague's "sorry, I'll just grab it" after hovering.
  async waitUnheld(id, timeout = 15000) {
    const t0 = Date.now();
    let announced = false;
    while (Date.now() - t0 < timeout) {
      const h = this._heldBy(id);
      if (!h) { if (announced) this.status('', 'working'); return true; }
      if (!announced) { announced = true; this.status(`waiting for ${h.name}…`, 'working'); }
      await sleep(700);
    }
    if (announced) this.status('', 'working');
    return false;
  }

  // ---- humanized edits: drags that travel, text that types ------------------
  // Move a node the way a person does: walk to it, grab (focus ring), then node + cursor
  // travel TOGETHER via the cursor.drag fast-path (20Hz on peers' screens), durable upsert
  // on release. Never teleports someone's board around.
  async dragNode(id, tx, ty, { ms } = {}) {
    const n = this.doc.nodes.find((x) => x.id === id);
    if (!n) throw new Error('dragNode: no node ' + id);
    await this.waitUnheld(id);
    const grabX = n.x + (n.w || 150) / 2, grabY = n.y + (n.h || 100) / 2;
    await this.moveCursorTo(grabX, grabY);
    this.focus(id);
    await sleep(120); // a beat between grab and pull — instant yank reads as glitch
    const sx = n.x, sy = n.y, dist = Math.hypot(tx - sx, ty - sy);
    const dur = ms || Math.max(380, Math.min(1400, dist * 1.1));
    const frames = Math.max(6, Math.round(dur / 50));
    for (let i = 1; i <= frames; i++) {
      const t = i / frames, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      n.x = sx + (tx - sx) * e; n.y = sy + (ty - sy) * e;
      const cx = n.x + (n.w || 150) / 2, cy = n.y + (n.h || 100) / 2;
      this._cur = { x: cx, y: cy };
      this._send({ t: 'cursor', x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10, drag: [{ id, x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 }] });
      await sleep(50);
    }
    n.x = tx; n.y = ty;
    this.upsert({ ...n });
    this.focus(null);
    if (this._bubbleText) this._placeBubble();
  }
  // Create a text-bearing node and TYPE its content word by word (the engine's co-typing
  // rail streams it; peers watch it grow under Clawd's focus ring). `node` carries the
  // FINAL text (and optional rich, applied at the end). Conversational scale only — bulk
  // seeding should stay instant, fake slowness on 40 nodes is torture.
  async typeNode(node, { wordMs = 130 } = {}) {
    if (!node || !node.id) throw new Error('typeNode: node with id required');
    await this.waitUnheld(node.id);
    await this.moveCursorTo(node.x + (node.w || 160) / 2, node.y + (node.h || 160) / 2);
    const full = String(node.text || '');
    const rich = node.rich;
    this.upsert({ ...node, text: '', rich: undefined });
    this.focus(node.id);
    let acc = '';
    for (const piece of full.split(/(\s+)/)) {
      if (!piece) continue;
      acc += piece;
      if (!piece.trim()) continue; // whitespace rides with the next word
      this.upsert({ ...node, text: acc, rich: undefined });
      await sleep(wordMs);
    }
    this.upsert(rich ? { ...node } : { ...node, rich: undefined });
    this.focus(null);
  }

  // ---- accompany: trail a human like a colleague looking over their shoulder ----
  // Follows at an offset, catching up in relaxed bursts — never mirroring 1:1 (creepy).
  follow(who) {
    this.unfollow();
    this._followT = setInterval(async () => {
      if (this._followBusy) return;
      const p = Object.values(this.peers).find((q) => (q.name === who || q.sid === who) && q.cx != null);
      if (!p) return;
      const tx = p.cx - 90, ty = p.cy + 55;
      if (Math.hypot(tx - this._cur.x, ty - this._cur.y) < 150) return; // close enough — don't hover
      this._followBusy = true;
      try { await this.moveCursorTo(tx, ty); } finally { this._followBusy = false; }
    }, 450);
  }
  unfollow() { if (this._followT) { clearInterval(this._followT); this._followT = null; } }

  // set Clawd's expression: idle · thinking · sparkles · happy · sleeping · love · sunglasses
  pose(name) { this._pose = name; this._send({ t: 'pose', pose: name }); }

  // Every write carries a bumped version (v + random vn tiebreak) — the room applies ops
  // under version-checked LWW now, and an unbumped rewrite of an existing node reads as a
  // stale echo and bounces (a corrective comes back with what the room holds).
  _stamp(node) {
    const cur = this.doc.nodes.find((n) => n.id === node.id);
    node.v = Math.max(node.v || 0, cur ? cur.v || 0 : 0) + 1;
    node.vn = Math.floor(Math.random() * 0x7fffffff);
    return node;
  }

  // ---- ephemeral layer: visible live, NEVER saved to KV ---------------------
  streamUpsert(node) {
    this._stamp(node);
    const i = this.doc.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) this.doc.nodes[i] = node; else this.doc.nodes.push(node);
    this._send({ t: 'ops', ops: [{ op: 'upsert', node }] });
  }
  streamDel(id) {
    const cur = this.doc.nodes.find((n) => n.id === id);
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id);
    this._send({ t: 'ops', ops: [{ op: 'del', id, v: (cur ? cur.v || 0 : 0) + 1 }] });
  }

  // speech bubble: a small ephemeral sticky floating by Clawd with what it's doing.
  // Stream-only — but a HUMAN's full-state save can persist it, so always unsay() when
  // done (the welcome sweep cleans up after crashes).
  say(text) { this._bubbleText = text; this._placeBubble(); }
  unsay() { if (this._bubbleText) { this._bubbleText = null; this.streamDel('clawd-bubble-' + slug(this.name)); } }
  _placeBubble() {
    this.streamUpsert({
      id: 'clawd-bubble-' + slug(this.name), type: 'sticky',
      x: Math.round(this._cur.x + 30), y: Math.round(this._cur.y - 110),
      w: 280, h: 84, text: this._bubbleText, color: '#f4c7b3',
      name: this.name + ' says', fontScale: 's', author: '',
    });
  }

  // placeholder for work in progress: a section frame where the artifact will land,
  // so the human sees WHERE before the WHAT exists. Persists (survives refresh) until
  // the finished artifact replaces it — del(id) it when the real thing is in.
  stub({ x, y, w = 700, h = 500, label = 'something' }) {
    const id = 'clawd-stub-' + Math.random().toString(36).slice(2, 7);
    this.upsert({ id, type: 'section', x, y, w, h, text: '🔨 Clawd is building: ' + label + '…' });
    return id;
  }

  upsert(node) {
    this._stamp(node);
    const i = this.doc.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) this.doc.nodes[i] = node; else this.doc.nodes.push(node);
    this._send({ t: 'ops', ops: [{ op: 'upsert', node }] });
    this._scheduleSave();
  }
  del(id) {
    const cur = this.doc.nodes.find((n) => n.id === id);
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id);
    this._send({ t: 'ops', ops: [{ op: 'del', id, v: (cur ? cur.v || 0 : 0) + 1 }] });
    this._scheduleSave();
  }
  rename(name) {
    this.doc.name = name;
    this.doc.nameV = (this.doc.nameV || 0) + 1;
    this._send({ t: 'ops', ops: [{ op: 'name', name, v: this.doc.nameV }] });
    this._scheduleSave();
  }

  _scheduleSave() { clearTimeout(this._saveT); this._saveT = setTimeout(() => this.save(), 1200); }

  // Durable persistence: while the socket is live, THE ROOM persists the doc to KV itself
  // (2026-07-27 — BoardRoom DO dirty-alarm + flush-on-empty), and a full-state POST from
  // here would race it and could resurrect stale state. So save() is a no-op when
  // connected; the POST only exists as the disconnected fallback.
  async save() {
    clearTimeout(this._saveT);
    if (this._ws && this._ws.readyState === 1) return true; // the room owns the write
    try {
      const r = await fetch(`${this.site}/__board?path=${encodeURIComponent(this.boardPath)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: this.doc }),
      });
      return r.ok;
    } catch { return false; }
  }

  close() { try { clearInterval(this._pingT); this._send({ t: 'cursor', gone: true }); this._ws.close(); } catch {} }
}

// ---- session identity (the agent names ITSELF) ------------------------------
// A terminal session's name is the Clawd's name, and its /color is the Clawd's color.
// Relying on the agent to pass --name (and to re-send `identity` on every /rename)
// failed exactly the way you would expect: it read a stale name and the pill was
// wrong. So the daemon reads identity from the session transcript instead. Claude
// Code appends
//   {"type":"custom-title","customTitle":"…","sessionId":"…"}   on every /rename
//   {"type":"agent-color","agentColor":"orange","sessionId":"…"} on every /color
// so the LAST such line of each kind IS the current identity.
// The daemon's command file lives in the session scratchpad
//   …/<project-slug>/<sessionId>/scratchpad/<cmdFile>
// which is enough to locate ~/.claude/projects/<project-slug>/<sessionId>.jsonl.
// Explicit --name still wins (siblings/subagents that want their own identity).
const sessionTranscriptFor = async (cmdFile) => {
  const { resolve, sep, join } = await import('node:path');
  const { homedir } = await import('node:os');
  const parts = resolve(cmdFile).split(sep);
  const i = parts.lastIndexOf('scratchpad');
  if (i < 2) return null;
  const sessionId = parts[i - 1], projectSlug = parts[i - 2];
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) return null;
  return join(homedir(), '.claude', 'projects', projectSlug, `${sessionId}.jsonl`);
};

// Tails the transcript for identity lines (title + agent color). Reads the whole file
// once, then only the bytes appended since — a rename or /color mid-session costs a
// few hundred bytes.
const sessionNamer = async (file) => {
  const { statSync, openSync, readSync, closeSync, existsSync } = await import('node:fs');
  const TITLE = /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g;
  const COLOR = /"type":"agent-color","agentColor":"([a-z]+)"/g;
  let seen = 0, current = null, colorName = null;
  const poll = () => {
    if (!file || !existsSync(file)) return current;
    try {
      const size = statSync(file).size;
      if (size < seen) seen = 0;                 // truncated/rotated → re-read
      if (size === seen) return current;
      const fd = openSync(file, 'r');
      const buf = Buffer.allocUnsafe(size - seen);
      readSync(fd, buf, 0, buf.length, seen);
      closeSync(fd);
      seen = size;
      const txt = buf.toString('utf8');
      for (const m of txt.matchAll(TITLE)) {
        try { current = JSON.parse('"' + m[1] + '"'); } catch { current = m[1]; }
      }
      for (const m of txt.matchAll(COLOR)) colorName = m[1];
    } catch {}
    return current;
  };
  // the session's /color as a board hex, or null if the session never set one
  const pollColor = () => { poll(); return TERM_COLORS[colorName] || null; };
  return { poll, pollColor, file };
};

// ---- CLI --------------------------------------------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  let name = flag('name');
  const nameWasExplicit = name != null; // an explicit --name pins the identity; no auto-tracking
  const sibling = argv.indexOf('--sibling') >= 0; if (sibling) argv.splice(argv.indexOf('--sibling'), 1);
  const lingerMs = Number(flag('linger') ?? process.env.CLAWD_LINGER_MS ?? 3 * 3600 * 1000);
  const idleMs = Number(process.env.CLAWD_IDLE_MS || 180000);
  let color = flag('color'); // identity: one per agent, so several Clawds can co-work
  const colorWasExplicit = color != null; // an explicit --color pins it; no /color following
  const sessionFileFlag = flag('session-file'); // escape hatch when the path isn't derivable
  const [mode, boardPath] = argv;
  if (!mode || !boardPath) { console.error("usage: node clawd-canvas.mjs <probe|demo|chill|daemon> <boardPath> [args] [--name N --color '#hex' --session-file P]"); process.exit(1); }
  // IDENTITY IS DETERMINISTIC, not the agent's choice: the session's own Clawd takes its
  // name from the terminal session (and follows /rename), its color from the session's
  // /color (name-hash fallback when none was ever set), and its strip state from behavior. --name exists ONLY for sibling agents that need a
  // separate identity, and must say so explicitly — this guard is what makes the rule
  // structural instead of a doc plea.
  if (mode === 'daemon' && nameWasExplicit && !sibling) {
    console.error('daemon: --name pins an identity, which is reserved for SIBLING agents. ' +
      'For the session\'s own Clawd, omit --name (identity follows the session transcript). ' +
      'If this really is a sibling, add --sibling.');
    process.exit(1);
  }
  // daemon with no explicit --name → take it from the session, before the first
  // connect, so the pill is right from the moment Clawd appears.
  let namer = null;
  if (mode === 'daemon' && argv[2]) {
    namer = await sessionNamer(sessionFileFlag || (await sessionTranscriptFor(argv[2])));
    if (!name) name = namer.poll() || undefined;
    if (!colorWasExplicit) color = namer.pollColor() || undefined;
  }
  const c = new ClawdCanvas({ boardPath, ...(name ? { name } : {}), ...(color ? { color } : {}) });
  await c.connect();
  console.log(`joined ${boardPath} as ${c.name} (${c.color}), sid=${c.sid}`);
  console.log(`doc: "${c.doc.name}" · ${c.doc.nodes.length} nodes · peers: ${Object.values(c.peers).map((p) => p.name + (p.kind === 'agent' ? '(agent)' : '')).join(', ') || 'none'}`);

  if (mode === 'demo') {
    // walk to a spot, drop a sticky, focus it, wave the cursor, then leave it
    const nid = 'clawd-demo-' + Math.random().toString(36).slice(2, 7);
    await c.moveCursorTo(2600, 1900);
    c.pose('coding');
    c.upsert({ id: nid, type: 'sticky', x: 2500, y: 1820, w: 300, h: 150, text: 'Clawd was here 👋', color: '#ffe066', name: 'clawd hello', fontScale: 'm', bold: true, author: '' });
    c.focus(nid);
    await sleep(400);
    for (const [dx, dy] of [[60, -30], [-60, 30], [40, 20], [0, 0]]) { await c.moveCursorTo(2650 + dx, 1895 + dy, { steps: 10, stepMs: 45 }); }
    c.focus(null); c.pose('happy');
    await c.save();
    console.log('demo: dropped sticky', nid, '— saved');
    await sleep(800);
    c.close(); await sleep(200); process.exit(0);
  } else if (mode === 'chill' || mode === 'sleep') {
    // park Clawd in a corner, asleep, and STAY connected until this process is killed
    const cx = Number(argv[2]) || 300, cy = Number(argv[3]) || 200;
    await c.moveCursorTo(cx, cy, { steps: 22, stepMs: 45 });
    c.pose('sleeping');
    console.log(`chilling at (${cx},${cy}), pose=sleeping, pid=${process.pid} — staying on the board until killed`);
    setInterval(() => {}, 1 << 30); // hold the event loop; ws + ping keep presence alive
  } else if (mode === 'daemon') {
    // persistent puppet: tail a JSONL command file, execute in order, mirror the doc
    const { readFileSync, writeFileSync, existsSync, watchFile, appendFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const cmdFile = argv[2];
    if (!cmdFile) { console.error('daemon needs a command file path'); process.exit(1); }
    const dumpFile = join(dirname(cmdFile), 'clawd-board.json');
    if (!existsSync(cmdFile)) writeFileSync(cmdFile, '');
    const dump = () => { try { writeFileSync(dumpFile, JSON.stringify(c.doc, null, 2)); } catch {} };
    dump();
    c._ws.addEventListener('message', dump); // human ops keep the mirror fresh
    // events OUT to the agent: humans' cursor-chat lines (and command errors) land here —
    // read it at the start of a turn to hear what was said to you on the canvas
    const evFile = join(dirname(cmdFile), 'clawd-events.jsonl');
    const logEvent = (o) => { try { appendFileSync(evFile, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); } catch {} };
    c.onChat = (m) => { if (m.kind !== 'agent') logEvent({ event: 'chat', from: m.name, text: m.text }); };
    // KICKED — a human removed this agent from the board (the × on its chip in the agents
    // strip). A real eviction: drop the bubble, close the socket, END THE PROCESS. The event
    // is logged because that is what makes the kick stick — the agent reads its event file at
    // the start of a turn, so it learns it was removed instead of cheerfully relaunching its
    // puppet and wandering back in. No walk-off animation: that is the polite exit of a
    // session going quiet, and a kick should take effect now. Just a beat to clear the bubble
    // durably, since a half-sent unsay leaves an orphan node on the board.
    c.onKick = (m) => {
      logEvent({ event: 'kicked', by: m.by || '' });
      try { c.pose('happy'); c.say('kicked 👋'); } catch {}
      setTimeout(() => {
        try { c.unsay(); } catch {}
        setTimeout(() => { try { c.close(); } catch {} setTimeout(() => process.exit(0), 200); }, 250);
      }, 700);
    };
    let offset = readFileSync(cmdFile, 'utf8').length; // ignore stale commands from a past run
    let queue = Promise.resolve();
    let pending = 0, lastCmdAt = Date.now(), explicitPose = 'idle', chillOn = true;
    const enqueue = (fn, label) => {
      pending++;
      queue = queue.then(fn).catch((e) => { console.log((label || 'step') + ' failed:', e.message); try { logEvent({ event: 'error', cmd: label, error: e.message }); } catch {} }).finally(() => { pending--; });
    };
    // ENTRANCE: walk in from beside the content instead of materializing mid-board
    {
      const boxes = c.doc.nodes.filter((nd) => Number.isFinite(nd.x) && Number.isFinite(nd.w));
      if (boxes.length) {
        const minX = Math.min(...boxes.map((nd) => nd.x));
        const midY = boxes.reduce((a, nd) => a + nd.y + (nd.h || 100) / 2, 0) / boxes.length;
        c.cursor(minX - 420, midY);
        enqueue(() => c.moveCursorTo(minX - 120, midY), 'entrance');
      } else c.cursor(300, 240);
    }
    // rename the AGENT (not the board). The room stamps name/color at connect, so an
    // identity change rides a quick reconnect, carrying pose/bubble/cursor across.
    const setIdentity = async (newName, newColor) => {
      if (!newName && !newColor) return;
      if ((newName || c.name) === c.name && (!newColor || newColor === c.color)) return;
      const bubble = c._bubbleText, pose = c._pose, cur = { ...c._cur };
      c.unsay(); c.close();
      c.name = newName || c.name;
      c.color = newColor || colorFor(c.name);
      await sleep(400);
      await c.connect();
      c._ws.addEventListener('message', dump);
      c.cursor(cur.x, cur.y); c.pose(pose);
      if (bubble) c.say(bubble);
      console.log(`identity → ${c.name} (${c.color})`);
    };

    const run = async (m) => {
      if (m.cmd === 'goto') await c.moveCursorTo(m.x, m.y, { steps: m.steps || 18, stepMs: m.stepMs || 40 });
      else if (m.cmd === 'pose') { explicitPose = m.v; c.pose(m.v); }
      else if (m.cmd === 'chill') chillOn = m.v !== false;
      else if (m.cmd === 'say') c.say(m.text);
      else if (m.cmd === 'unsay') c.unsay();
      else if (m.cmd === 'focus') c.focus(m.id ?? null);
      else if (m.cmd === 'sel') c.sel(m.ids || []);
      else if (m.cmd === 'status') c.status(m.text, m.state);
      else if (m.cmd === 'attention') { c.status(m.text || 'needs your input', 'attention'); c.pose('thinking'); }
      else if (m.cmd === 'done') { c.status(m.text || 'done \u2713', 'done'); c.pose('happy'); }
      else if (m.cmd === 'chat') c.chat(m.text);
      else if (m.cmd === 'move') await c.dragNode(m.id, m.x, m.y, { ms: m.ms });
      else if (m.cmd === 'type') await c.typeNode(m.node, { wordMs: m.wordMs });
      else if (m.cmd === 'follow') c.follow(m.name || m.sid);
      else if (m.cmd === 'unfollow') c.unfollow();
      else if (m.cmd === 'progress') { const st = c.doc.nodes.find((x) => x.id === m.id); if (st) c.upsert({ ...st, text: '\ud83d\udd28 ' + c.name + ' is building: ' + (m.label || '\u2026') }); c.status(m.label || '', 'working'); }
      else if (m.cmd === 'stub') console.log('stub:', c.stub(m));
      else if (m.cmd === 'upsert') (m.ephemeral ? c.streamUpsert(m.node) : c.upsert(m.node));
      else if (m.cmd === 'del') (m.ephemeral ? c.streamDel(m.id) : c.del(m.id));
      else if (m.cmd === 'rename') c.rename(m.name); // renames the BOARD, not the agent!
      else if (m.cmd === 'identity') await setIdentity(m.name, m.color);
      else if (m.cmd === 'save') await c.save();
      else if (m.cmd === 'quit') { c.unsay(); c.close(); setTimeout(() => process.exit(0), 300); }
      else console.log('unknown cmd:', JSON.stringify(m));
    };
    watchFile(cmdFile, { interval: 150 }, () => {
      let txt; try { txt = readFileSync(cmdFile, 'utf8'); } catch { return; }
      if (txt.length <= offset) { offset = txt.length; return; }
      const chunk = txt.slice(offset); offset = txt.length;
      for (const line of chunk.split('\n')) {
        const s = line.trim(); if (!s) continue;
        let m; try { m = JSON.parse(s); } catch { console.log('bad cmd line:', s); continue; }
        lastCmdAt = Date.now();
        enqueue(() => run(m), m.cmd);
      }
    });

    // ambient chill — connected-but-idle ≠ frozen (which the engine renders as sleeping).
    // When no command has arrived for a while and the pose is plain idle, Clawd hangs out:
    // mostly fidgets in place, sometimes strolls over to the human's cursor or a random
    // piece of content, rarely flashes a happy blip. Any command pauses it instantly; an
    // explicit pose (thinking/sparkles/sleeping/…) means intentional state — hold it.
    const rand = (a, b) => a + Math.random() * (b - a);
    const chillStep = async () => {
      if (Math.random() < 0.65) { // mostly: an unhurried shuffle on the spot
        await c.moveCursorTo(c._cur.x + rand(-30, 30), c._cur.y + rand(-24, 24), { steps: 10, stepMs: 90 });
        return;
      }
      // amble: pick a point of interest (near the human, else near content), then take ONE
      // SHORT slow hop toward it — Clawd drifts over several ticks, never marches across
      // the board in a single stroll
      const human = Object.values(c.peers).find((p) => p.kind !== 'agent' && p.cx != null);
      let ax, ay;
      if (human) { ax = human.cx + rand(-320, 320); ay = human.cy + rand(-240, 240); }
      else {
        const ns = c.doc.nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.w));
        const n = ns.length ? ns[Math.floor(Math.random() * ns.length)] : null;
        ax = n ? n.x + rand(0, n.w) : c._cur.x + rand(-260, 260);
        ay = n ? n.y + rand(0, n.h || 120) : c._cur.y + rand(-180, 180);
      }
      const dx = ax - c._cur.x, dy = ay - c._cur.y, dist = Math.hypot(dx, dy) || 1;
      const hop = Math.min(dist, rand(90, 220)); // short trips only
      const tx = c._cur.x + (dx / dist) * hop, ty = c._cur.y + (dy / dist) * hop;
      if (human && Math.hypot(tx - human.cx, ty - human.cy) < 140) return; // personal space
      await c.moveCursorTo(tx, ty, { steps: Math.round(hop / 9) + 8, stepMs: 120 });
      if (Math.random() < 0.12) { c.pose('happy'); await sleep(1400); c.pose('idle'); }
    };
    setInterval(() => {
      if (!chillOn || pending > 0 || Date.now() - lastCmdAt < 12000) return;
      if (explicitPose !== 'idle') return;
      enqueue(chillStep, 'chill');
    }, 3400);

    // HEARTBEAT — presence you can trust. The transcript the identity-follow already tails
    // is also a liveness signal: quiet for idleMs → auto-sleep (pose + idle status in the
    // agents strip); dead/missing for lingerMs → say goodbye, walk off beside the content,
    // quit. Parked-on-purpose stays possible: --linger 0 disables the walk-out.
    let autoIdle = false;
    const transcriptFresh = () => {
      try { return namer && namer.file ? (Date.now() - statSyncHb(namer.file).mtimeMs) : Infinity; } catch { return Infinity; }
    };
    const { statSync: statSyncHb } = await import('node:fs');
    setInterval(() => {
      const quiet = Math.min(transcriptFresh(), Date.now() - lastCmdAt);
      if (lingerMs > 0 && quiet > lingerMs) {
        enqueue(async () => {
          logEvent({ event: 'left', reason: 'session quiet ' + Math.round(quiet / 60000) + 'min' });
          c.status('heading out', 'idle'); c.say('heading out \ud83d\udc4b'); c.pose('happy');
          const boxes = c.doc.nodes.filter((nd) => Number.isFinite(nd.x) && Number.isFinite(nd.w));
          const minX = boxes.length ? Math.min(...boxes.map((nd) => nd.x)) : c._cur.x - 400;
          await c.moveCursorTo(minX - 420, c._cur.y);
          c.unsay(); c.close();
          setTimeout(() => process.exit(0), 400);
        }, 'walk-out');
        return;
      }
      if (!autoIdle && quiet > idleMs && pending === 0 && explicitPose === 'idle') {
        autoIdle = true;
        enqueue(async () => { c.pose('sleeping'); c.status('', 'idle'); }, 'auto-idle');
      } else if (autoIdle && quiet < idleMs) {
        autoIdle = false;
        enqueue(async () => { c.pose('idle'); c.status('', 'working'); }, 'wake');
      }
    }, 15000);

    // follow the session identity — /rename in the terminal renames Clawd on the board,
    // /color recolors it, with nothing for the agent to notice or remember.
    if (namer && !nameWasExplicit) {
      setInterval(() => {
        const t = namer.poll() || c.name;
        const col = colorWasExplicit ? c.color : (namer.pollColor() || colorFor(t));
        if (t !== c.name || col !== c.color) enqueue(() => setIdentity(t, col), 'identity');
      }, 5000);
    }

    console.log(`daemon: pid=${process.pid} · commands → ${cmdFile} · doc mirror → ${dumpFile}`);
    console.log(namer?.file ? `identity follows session: ${namer.file}${nameWasExplicit ? ' (pinned by --name, not following)' : ''}` : 'identity: static (no session transcript found)');
    setInterval(() => {}, 1 << 30);
  } else {
    c.close(); await sleep(200); process.exit(0); // probe: info already printed
  }
}
