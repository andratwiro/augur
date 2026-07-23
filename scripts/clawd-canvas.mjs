// clawd-canvas — the terminal half of live canvas collaboration.
//
// Lets a Claude agent JOIN a canvas board's multiplayer room as a real participant
// ("Clawd") and co-work in real time: move a cursor, raise a focus ring on the node it's
// working, and stream node edits — everything a human client does, over the same /__rt
// protocol (augur-realtime BoardRoom DO). No browser: a raw WebSocket speaks the protocol
// directly (Node's global WebSocket). Durable saves ride the existing /__board KV rail.
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
// CLI:
//   node clawd-canvas.mjs probe <boardPath>            # connect, print doc + peers, leave
//   node clawd-canvas.mjs demo  <boardPath>            # walk in, drop a sticky, wave, leave

const RT_ORIGIN = 'wss://augur-realtime.rob-3d3.workers.dev';
const SITE = 'https://govocal-prototypes.pages.dev';
const CLAWD_ORANGE = '#d97757'; // Claude clay — the primary agent's Clawd hue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ClawdCanvas {
  constructor({ boardPath, name = 'Clawd', color = CLAWD_ORANGE, site = SITE, rtOrigin = RT_ORIGIN } = {}) {
    if (!boardPath) throw new Error('boardPath required');
    this.boardPath = boardPath;
    this.name = name;
    this.color = color;
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

  connect() {
    const url = `${this.rtOrigin}/room?path=${encodeURIComponent(this.boardPath)}` +
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

  // glide the cursor so the human sees Clawd walk over, not teleport
  async moveCursorTo(x, y, { steps = 24, stepMs = 40 } = {}) {
    const sx = this._cur.x, sy = this._cur.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
      this.cursor(sx + (x - sx) * e, sy + (y - sy) * e);
      await sleep(stepMs);
    }
  }

  focus(id) { this._send({ t: 'focus', id: id || null }); }

  // set Clawd's expression: idle · coding · thinking · happy · sleeping · love · sunglasses · handsUp
  pose(name) { this._pose = name; this._send({ t: 'pose', pose: name }); }

  upsert(node) {
    const i = this.doc.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) this.doc.nodes[i] = node; else this.doc.nodes.push(node);
    this._send({ t: 'ops', ops: [{ op: 'upsert', node }] });
    this._scheduleSave();
  }
  del(id) {
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id);
    this._send({ t: 'ops', ops: [{ op: 'del', id }] });
    this._scheduleSave();
  }
  rename(name) { this.doc.name = name; this._send({ t: 'ops', ops: [{ op: 'name', name }] }); this._scheduleSave(); }

  _scheduleSave() { clearTimeout(this._saveT); this._saveT = setTimeout(() => this.save(), 1200); }

  // durable save to KV (full-state, like every canvas client). Our doc includes the human's
  // ops we've been tracking, so this preserves their work as of our latest received op.
  async save() {
    clearTimeout(this._saveT);
    try {
      const r = await fetch(`${this.site}/__board?path=${encodeURIComponent(this.boardPath)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: this.doc }),
      });
      return r.ok;
    } catch { return false; }
  }

  close() { try { clearInterval(this._pingT); this._send({ t: 'cursor', gone: true }); this._ws.close(); } catch {} }
}

// ---- CLI --------------------------------------------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [mode, boardPath] = process.argv.slice(2);
  if (!mode || !boardPath) { console.error('usage: node clawd-canvas.mjs <probe|demo> <boardPath>'); process.exit(1); }
  const c = new ClawdCanvas({ boardPath });
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
    const cx = Number(process.argv[4]) || 300, cy = Number(process.argv[5]) || 200;
    await c.moveCursorTo(cx, cy, { steps: 22, stepMs: 45 });
    c.pose('sleeping');
    console.log(`chilling at (${cx},${cy}), pose=sleeping, pid=${process.pid} — staying on the board until killed`);
    setInterval(() => {}, 1 << 30); // hold the event loop; ws + ping keep presence alive
  } else {
    c.close(); await sleep(200); process.exit(0); // probe: info already printed
  }
}
