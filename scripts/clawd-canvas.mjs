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
// The co-working PROTOCOL (Rob's rule, 2026-07-23): show activity on the canvas FIRST,
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
//
//   node clawd-canvas.mjs daemon <boardPath> <cmdFile> # persistent puppet: tail a JSONL
//     command file and execute in order — one connection an agent can command across turns.
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
//         reconnect; color re-derives from the name unless "color" is given). Send this
//         when the terminal session gets renamed — identity should track the session.
//     It also mirrors the live doc to <cmdFile dir>/clawd-board.json on every op, so the
//     agent always reads the human's latest state without reconnecting. While connected and
//     idle (no commands ~12s, pose plain idle) Clawd CHILLS instead of freezing: fidgets,
//     strolls near the human's cursor or around the content, the odd happy blip.

const RT_ORIGIN = 'wss://augur-realtime.rob-3d3.workers.dev';
const SITE = 'https://govocal-prototypes.pages.dev';
const CLAWD_ORANGE = '#d97757'; // Claude clay — the primary agent's Clawd hue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

// identity color derives from the name (stable hash → curated palette), so a terminal's
// Clawd keeps its color across restarts with no coordination. Plain "Clawd" = the orange.
const PALETTE = ['#4e8fd9', '#8a63c9', '#2e9e6b', '#d9569b', '#c8912e', '#3aa6b9', '#6a7dd9', '#b5533c'];
export const colorFor = (name) => {
  if (!name || slug(name) === 'clawd') return CLAWD_ORANGE;
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export class ClawdCanvas {
  constructor({ boardPath, name = 'Clawd', color, site = SITE, rtOrigin = RT_ORIGIN } = {}) {
    if (!boardPath) throw new Error('boardPath required');
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
    if (this._bubbleText) this._placeBubble(); // the speech bubble follows Clawd
  }

  focus(id) { this._send({ t: 'focus', id: id || null }); }

  // set Clawd's expression: idle · thinking · sparkles · happy · sleeping · love · sunglasses
  pose(name) { this._pose = name; this._send({ t: 'pose', pose: name }); }

  // ---- ephemeral layer: visible live, NEVER saved to KV ---------------------
  streamUpsert(node) {
    const i = this.doc.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) this.doc.nodes[i] = node; else this.doc.nodes.push(node);
    this._send({ t: 'ops', ops: [{ op: 'upsert', node }] });
  }
  streamDel(id) {
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id);
    this._send({ t: 'ops', ops: [{ op: 'del', id }] });
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
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  const name = flag('name'), color = flag('color'); // identity: one per agent, so several Clawds can co-work
  const [mode, boardPath] = argv;
  if (!mode || !boardPath) { console.error("usage: node clawd-canvas.mjs <probe|demo|chill|daemon> <boardPath> [args] [--name N --color '#hex']"); process.exit(1); }
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
    const { readFileSync, writeFileSync, existsSync, watchFile } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const cmdFile = argv[2];
    if (!cmdFile) { console.error('daemon needs a command file path'); process.exit(1); }
    const dumpFile = join(dirname(cmdFile), 'clawd-board.json');
    if (!existsSync(cmdFile)) writeFileSync(cmdFile, '');
    const dump = () => { try { writeFileSync(dumpFile, JSON.stringify(c.doc, null, 2)); } catch {} };
    dump();
    c._ws.addEventListener('message', dump); // human ops keep the mirror fresh
    let offset = readFileSync(cmdFile, 'utf8').length; // ignore stale commands from a past run
    let queue = Promise.resolve();
    let pending = 0, lastCmdAt = Date.now(), explicitPose = 'idle', chillOn = true;
    const enqueue = (fn, label) => {
      pending++;
      queue = queue.then(fn).catch((e) => console.log((label || 'step') + ' failed:', e.message)).finally(() => { pending--; });
    };
    const run = async (m) => {
      if (m.cmd === 'goto') await c.moveCursorTo(m.x, m.y, { steps: m.steps || 18, stepMs: m.stepMs || 40 });
      else if (m.cmd === 'pose') { explicitPose = m.v; c.pose(m.v); }
      else if (m.cmd === 'chill') chillOn = m.v !== false;
      else if (m.cmd === 'say') c.say(m.text);
      else if (m.cmd === 'unsay') c.unsay();
      else if (m.cmd === 'focus') c.focus(m.id ?? null);
      else if (m.cmd === 'stub') console.log('stub:', c.stub(m));
      else if (m.cmd === 'upsert') (m.ephemeral ? c.streamUpsert(m.node) : c.upsert(m.node));
      else if (m.cmd === 'del') (m.ephemeral ? c.streamDel(m.id) : c.del(m.id));
      else if (m.cmd === 'rename') c.rename(m.name); // renames the BOARD, not the agent!
      else if (m.cmd === 'identity') { // rename the AGENT (e.g. the session was renamed):
        // the room stamps name/color at connect, so identity changes ride a quick reconnect
        const bubble = c._bubbleText, pose = c._pose, cur = { ...c._cur };
        c.unsay(); c.close();
        c.name = m.name || c.name;
        c.color = m.color || colorFor(c.name);
        await sleep(400);
        await c.connect();
        c._ws.addEventListener('message', dump);
        c.cursor(cur.x, cur.y); c.pose(pose);
        if (bubble) c.say(bubble);
        console.log(`identity → ${c.name} (${c.color})`);
      }
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

    console.log(`daemon: pid=${process.pid} · commands → ${cmdFile} · doc mirror → ${dumpFile}`);
    setInterval(() => {}, 1 << 30);
  } else {
    c.close(); await sleep(200); process.exit(0); // probe: info already printed
  }
}
