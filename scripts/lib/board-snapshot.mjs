/**
 * board-snapshot — read a board's AUTHORITATIVE document, which is not the one in KV.
 *
 * `MIG-board-snapshot-via-ws`. A board has two copies and only one of them is true. The
 * room (a `BoardRoom` Durable Object) owns the document in its own storage; Workers KV
 * holds a WRITE-THROUGH MIRROR, written on a dirty-alarm cadence — `PERSIST_MS`, 45
 * seconds, `src/board-room.mjs`. The public `GET /__board` serves the mirror, and so does
 * every state export, so a migration that copies boards from KV silently drops whatever was
 * drawn in the last cycle. Nothing fails; the board simply arrives at its new home missing
 * the end of the last session. `src/state-inventory.mjs` says as much about the `board:`
 * family, and this module is the answer to it.
 *
 * THERE IS NO HTTP READ OF THE TRUTH. `BoardRoom.fetch()` handles the WebSocket upgrade and
 * nothing else — no dump route, no `GET /doc`. The one moment the room hands out its whole
 * document is the `welcome` frame it sends on join (`wireDoc()`), AFTER `await this.load()`,
 * so joining as a real client is not a workaround: it is the only read there is.
 *
 * ⚠️ THE MIRROR IS STALER THAN THE 45-SECOND CADENCE SAYS, AND BY MORE THAN DOUBLE. The
 * cadence bounds when the room WRITES the mirror. It does not bound when a reader SEES that
 * write: the board rail's `kv.get` sets no `cacheTtl`, so it takes the Workers KV default
 * read cache, and a key that is being polled keeps its cached (pre-edit) value warm. Measured
 * on a live instance: an edit made at a moment when the mirror had just been written took
 * **87 seconds** to appear on `GET /__board`, against a 45-second cadence. So the window in
 * which a KV-sourced copy of a board is wrong is the write cadence PLUS the read cache, and a
 * cutover that allowed 45 seconds of quiet would have allowed less than half of what it needed.
 * `measureLag()` reports the gap in nodes rather than in seconds for exactly this reason: the
 * seconds have two terms and only one of them is a constant anybody can look up.
 *
 * ── WHAT MAKES A READ HERE TRUSTWORTHY ────────────────────────────────────────
 *
 * A socket that connects and receives frames has proven almost nothing. A measurement
 * harness in this repo once ran a client that skipped the seed handshake: the room relayed
 * its ops without ever applying them, every frame arrived, nothing failed, and every number
 * taken off it was wrong. So a read here is only reported when all of the following hold,
 * and each one is checked rather than assumed:
 *
 *   1. A `welcome` frame arrived carrying an `sid`. The room sends it after `load()`, so
 *      the frame IS the proof that the document was brought up — a 101 alone is not.
 *   2. It carried EXACTLY ONE of `doc` and `needDoc`. `needDoc` means the room genuinely
 *      holds no document (a board nobody has drawn on), which is an ANSWER — reported as
 *      `empty`, never as a failed read, and never as a null to be copied over a real board.
 *   3. The document survives a structural check: nodes are an array, every node has an id,
 *      no id appears twice.
 *   4. TWO INDEPENDENT SOCKETS, `settleMs` apart, returned the same document. A read taken
 *      while somebody is drawing is a read that will be missing the next stroke, and the
 *      cutover warning on the room-naming change is exactly this: move boards when they are
 *      quiet. A disagreement fails the read and is retried, rather than being sliced in half
 *      and reported as a snapshot.
 *
 * And a seed is verified the same way, from the other side: after the document is offered,
 * the seeding socket is CLOSED FIRST and the destination is read back over a FRESH one. The
 * close matters — the last socket out flushes and drops the room's RAM cache, so the
 * verification read comes back through the room's storage rather than out of the memory of
 * the object that was just handed it.
 *
 * ── THE TWO DEPLOYMENT SHAPES, AND WHY THIS ADDRESSES NEITHER ─────────────────
 *
 * A room is reached at `<origin>/__rt?path=…`, and that address is the same on both sides of
 * the migration:
 *
 *   BEFORE — no `ROOMS` binding. `rtProxy` forwards to a separate `augur-realtime-*` worker,
 *            which names the room after the bare path and whose mirror key is the legacy
 *            unscoped `board:<path>`.
 *   AFTER  — `ROOMS` bound. The room is in the worker's own module graph, named
 *            `<workspace>:<path>` by `roomName()`, mirror key `board:<workspace>:<path>`.
 *
 * Which one a deployment is does not appear anywhere below, and must not: the worker
 * resolves the room from the request it already has, the workspace segment is stamped by
 * `resolveTenant` and never by a caller, and a reader that computed a room name would be a
 * second place that decides the isolation boundary. Naming a path and letting the front door
 * answer is what makes one reader work on both shapes.
 *
 * `direct: true` is the exception and it exists for one case: the OLD room when the old front
 * door is no longer usable — a suspended workspace (`/__rt` is not on `SUSPENDED_ALLOWED`) or
 * a hostname already renamed away (every request to it gets the unknown-host refusal). It
 * speaks `/room?path=…` to a standalone realtime worker with its shared secret, and it can
 * only ever reach the legacy unscoped rooms, because a folded-in room has no second address.
 *
 * ── WHAT A READ COSTS THE BOARD ───────────────────────────────────────────────
 *
 * Honestly: a join is not free of side effects, and pretending otherwise would hide the one
 * that matters. Joining wakes the room, which loads its document (migrating a pre-existing
 * board into storage the first time, by design), and LEAVING as the last socket flushes the
 * KV mirror immediately. So a read of a quiet board leaves its mirror fresher than it found
 * it, and never staler. It writes no node, sends no op and changes no version.
 */
import { createHash } from "node:crypto";

/** Long enough for a cold room on a slow link; short enough that a wedged read is not a hang. */
export const DEFAULT_TIMEOUT_MS = 20000;
/** The gap between the two observer joins. Under it, a live edit could slip through unseen. */
export const DEFAULT_SETTLE_MS = 750;
/**
 * The room's WRITE cadence (`PERSIST_MS`). Not the age of what a reader sees — see the
 * header: the read cache on top of it has been measured at nearly twice this again.
 */
export const MIRROR_CADENCE_MS = 45000;

/** A failure with a name, so a caller can branch on the reason rather than on a message. */
export class SnapshotError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** The room's address. `origin` may be given as http(s) or ws(s); both mean the same room. */
export function roomUrl({ origin, path, name = "board-snapshot", direct = false } = {}) {
  if (!origin) throw new SnapshotError("bad-input", "an origin is required");
  if (!path) throw new SnapshotError("bad-input", "a board path is required");
  const base = String(origin).trim().replace(/\/+$/, "").replace(/^http/, "ws");
  if (!/^wss?:\/\//.test(base)) throw new SnapshotError("bad-input", `not an origin: ${origin}`);
  const route = direct ? "/room" : "/__rt";
  return `${base}${route}?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
}

/** The default socket opener. Injectable so the suite can drive a real room with no network. */
export const openWebSocket = (url, opts) => new WebSocket(url, opts);

/**
 * Connect, and hand back a handle that can wait for a specific frame.
 *
 * The `welcome` is awaited here rather than left to the caller: a connection that has not
 * produced one has not proven the room loaded, and no caller should be able to skip that.
 */
export async function connectRoom(open, { url, headers, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sock = open(url, headers && Object.keys(headers).length ? { headers } : undefined);
  const frames = { welcome: 0, ops: 0, join: 0, leave: 0, other: 0, nonJson: 0 };
  const queue = [];
  const waiters = [];
  let closed = false;
  let failure = null;

  const settle = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const idx = queue.findIndex(waiters[i].pred);
      if (idx < 0) continue;
      const [m] = queue.splice(idx, 1);
      waiters.splice(i, 1)[0].resolve(m);
    }
  };
  const abort = (err) => {
    failure = failure || err;
    for (const w of waiters.splice(0)) w.reject(err);
  };

  sock.addEventListener("message", (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : null;
    if (raw === null) { frames.nonJson++; return; }
    if (raw === "pong") return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { frames.nonJson++; return; }
    if (!m || typeof m.t !== "string") { frames.nonJson++; return; }
    if (Object.prototype.hasOwnProperty.call(frames, m.t)) frames[m.t]++;
    else frames.other++;
    queue.push(m);
    settle();
  });
  sock.addEventListener("close", (ev) => {
    closed = true;
    abort(new SnapshotError("closed", `the room closed the socket (${(ev && ev.code) || "?"})`));
  });
  sock.addEventListener("error", (ev) => {
    abort(new SnapshotError("socket-failed", `socket failed: ${(ev && (ev.message || (ev.error && ev.error.message))) || "no detail"}`));
  });

  const next = (pred, ms = timeoutMs) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      let timer = null;
      const w = {
        pred,
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      };
      waiters.push(w);
      settle();
      if (!waiters.includes(w)) return; // a queued frame already matched
      timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new SnapshotError("timeout", `waited ${ms}ms for a frame that never came`));
      }, ms);
    });

  const handle = {
    url,
    frames,
    next,
    send: (msg) => {
      if (closed) throw new SnapshotError("closed", "cannot send on a closed socket");
      sock.send(JSON.stringify(msg));
    },
    close: () => { try { sock.close(); } catch (e) { /* already gone */ } },
    get closed() { return closed; },
  };
  handle.welcome = await next((m) => m.t === "welcome");
  return handle;
}

/**
 * Read a `welcome` and refuse anything ambiguous.
 *
 * The two-branch check is the point. `doc` and `needDoc` are mutually exclusive in the room
 * (`board-room.mjs`: `if (this.doc) welcome.doc = …; else welcome.needDoc = true`), so
 * neither and both are protocol violations — and a reader that treated "no doc field" as
 * "empty board" would copy a null over a real board the day that changed.
 */
export function readWelcome(w) {
  if (!w || w.t !== "welcome") throw new SnapshotError("no-welcome", "no welcome frame");
  if (typeof w.sid !== "string" || !w.sid) throw new SnapshotError("welcome-without-sid", "the welcome carried no sid, so the join did not complete");
  const hasDoc = !!(w.doc && typeof w.doc === "object" && Array.isArray(w.doc.nodes));
  const needDoc = w.needDoc === true;
  if (hasDoc && needDoc) throw new SnapshotError("welcome-ambiguous", "the welcome carried both a doc and needDoc");
  if (!hasDoc && !needDoc) {
    if (w.doc !== undefined) throw new SnapshotError("welcome-malformed-doc", "the welcome carried a doc that is not a document");
    throw new SnapshotError("welcome-ambiguous", "the welcome carried neither a doc nor needDoc");
  }
  return { sid: w.sid, peers: Array.isArray(w.peers) ? w.peers.length : 0, empty: !hasDoc, doc: hasDoc ? w.doc : null };
}

/** Structural check. Cheap, and it is the difference between a snapshot and a blob. */
export function checkDoc(doc) {
  if (!doc || typeof doc !== "object") throw new SnapshotError("bad-doc", "not a document");
  if (!Array.isArray(doc.nodes)) throw new SnapshotError("bad-doc", "the document has no nodes array");
  const seen = new Set();
  for (const n of doc.nodes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id) {
      throw new SnapshotError("bad-doc", "a node has no id");
    }
    if (seen.has(n.id)) throw new SnapshotError("bad-doc", `two nodes share the id ${n.id}`);
    seen.add(n.id);
  }
  // ⚠️ `tombs` IS ALLOWED TO BE AN ARRAY, and refusing that refused a real board. The room
  // keeps whatever passes `typeof d.tombs === "object"` (`adoptDoc`), an empty array passes,
  // and boards seeded by older clients carry `tombs: []` — live, on a deployed instance,
  // today. Every read of the map goes through `hasOwnProperty`, so an array behaves as the
  // empty tombstone set it is. A stricter check here would reject the documents this exists
  // to move, which is the one failure a migration reader cannot afford.
  if (doc.tombs !== undefined && doc.tombs !== null && typeof doc.tombs !== "object") {
    throw new SnapshotError("bad-doc", "tombs is neither a map nor absent");
  }
  return doc;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const nodeSig = (n) => sha(JSON.stringify(n));

/**
 * Two digests, because two different questions get asked of one document.
 *
 * `content` ignores node order: it answers "are these the same nodes, at the same versions,
 * with the same bytes". `full` includes the order, which is the board's z-order and is
 * therefore real content — a board whose stacking changed is a board that changed.
 * `clock` is in NEITHER: it is the room's own local counter, reset to 0 by `adoptDoc` when a
 * fresh room takes a seed, so a destination that matches perfectly still reports a different
 * one and a comparison that folded it in would call every correct migration a failure.
 */
export function digestDoc(doc) {
  const ids = doc.nodes.map((n) => n.id);
  const perNode = new Map(doc.nodes.map((n) => [n.id, nodeSig(n)]));
  const sortedIds = [...ids].sort();
  const tombs = Object.keys(doc.tombs || {}).sort().map((k) => `${k}=${(doc.tombs[k] || {}).v}`);
  const head = `name=${JSON.stringify(doc.name || "")};nameV=${doc.nameV || 0};tombs=${tombs.join(",")}`;
  return {
    content: sha(`${head};nodes=${sortedIds.map((id) => `${id}:${perNode.get(id)}`).join(",")}`),
    full: sha(`${head};order=${ids.join(",")};nodes=${ids.map((id) => `${id}:${perNode.get(id)}`).join(",")}`),
  };
}

/** What a report says about a document without printing the whole of it. */
export function docSummary(doc) {
  if (!doc) return { empty: true, nodes: 0 };
  const d = digestDoc(doc);
  return {
    empty: false,
    name: typeof doc.name === "string" ? doc.name : null,
    nameV: doc.nameV || 0,
    nodes: doc.nodes.length,
    tombs: Object.keys(doc.tombs || {}).length,
    clock: doc.clock || 0,
    bytes: JSON.stringify(doc).length,
    digest: d.content,
    orderDigest: d.full,
  };
}

/**
 * Node-by-node, because "the bytes differ" is not an answer anybody can act on.
 *
 * `newerInA` is the one the migration exists for: nodes the room holds at a HIGHER version
 * than the mirror does. That count, against a mirror read seconds earlier, is the size of
 * what a KV-sourced migration would have dropped.
 */
export function compareDocs(a, b) {
  if (!a && !b) return { same: true, bothEmpty: true, onlyInA: [], onlyInB: [], differing: [], newerInA: [], newerInB: [], orderChanged: false };
  if (!a || !b) {
    return {
      same: false, bothEmpty: false, oneEmpty: !a ? "a" : "b",
      onlyInA: a ? a.nodes.map((n) => n.id) : [],
      onlyInB: b ? b.nodes.map((n) => n.id) : [],
      differing: [], newerInA: [], newerInB: [], orderChanged: false,
    };
  }
  const A = new Map(a.nodes.map((n) => [n.id, n]));
  const B = new Map(b.nodes.map((n) => [n.id, n]));
  const onlyInA = [...A.keys()].filter((id) => !B.has(id));
  const onlyInB = [...B.keys()].filter((id) => !A.has(id));
  const differing = [], newerInA = [], newerInB = [];
  for (const [id, na] of A) {
    const nb = B.get(id);
    if (!nb) continue;
    if (nodeSig(na) === nodeSig(nb)) continue;
    const va = { v: na.v || 0, vn: na.vn || 0 }, vb = { v: nb.v || 0, vn: nb.vn || 0 };
    differing.push({ id, a: va, b: vb });
    const aWins = va.v > vb.v || (va.v === vb.v && va.vn > vb.vn);
    (aWins ? newerInA : newerInB).push(id);
  }
  const da = digestDoc(a), db = digestDoc(b);
  return {
    same: da.full === db.full,
    bothEmpty: false,
    sameContent: da.content === db.content,
    orderChanged: da.content === db.content && da.full !== db.full,
    nameChanged: a.name !== b.name || (a.nameV || 0) !== (b.nameV || 0),
    onlyInA, onlyInB, differing, newerInA, newerInB,
    clock: { a: a.clock || 0, b: b.clock || 0 },
  };
}

/**
 * ONE join, read, leave. The primitive; `snapshotRoom` is what an operator should use.
 */
export async function joinAndRead(open, { url, headers, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const room = await connectRoom(open, { url, headers, timeoutMs });
  try {
    const w = readWelcome(room.welcome);
    if (w.doc) checkDoc(w.doc);
    return { ...w, frames: { ...room.frames } };
  } finally {
    room.close();
  }
}

/**
 * The authoritative document, read twice and only reported when the two reads agree.
 *
 * The first socket is HELD OPEN while the second joins, on purpose. It keeps the room from
 * seeing its last client leave between the two reads — which would flush the mirror and drop
 * the RAM cache, so the second read would answer a different question from the first.
 */
export async function snapshotRoom(open, {
  origin, path, name = "board-snapshot", direct = false, headers,
  settleMs = DEFAULT_SETTLE_MS, attempts = 3, timeoutMs = DEFAULT_TIMEOUT_MS,
  allowUnstable = false, sleep = sleepReal,
} = {}) {
  let last = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const a = await connectRoom(open, { url: roomUrl({ origin, path, name: `${name}-a`, direct }), headers, timeoutMs });
    let b = null;
    try {
      const first = readWelcome(a.welcome);
      if (first.doc) checkDoc(first.doc);
      await sleep(settleMs);
      b = await connectRoom(open, { url: roomUrl({ origin, path, name: `${name}-b`, direct }), headers, timeoutMs });
      const second = readWelcome(b.welcome);
      if (second.doc) checkDoc(second.doc);
      const agreement = compareDocs(first.doc, second.doc);
      last = {
        ok: agreement.same,
        stable: agreement.same,
        attempt,
        attempts: Math.max(1, attempts),
        settleMs,
        empty: second.empty,
        doc: second.doc,
        summary: docSummary(second.doc),
        observers: [{ sid: first.sid, peers: first.peers, summary: docSummary(first.doc) }, { sid: second.sid, peers: second.peers, summary: docSummary(second.doc) }],
        agreement,
      };
      if (agreement.same) return last;
    } finally {
      if (b) b.close();
      a.close();
    }
    if (attempt < attempts) await sleep(settleMs);
  }
  if (allowUnstable) return last;
  throw new SnapshotError(
    "unstable",
    `the board changed between two reads ${settleMs}ms apart, ${last.attempts} times over — it is being edited right now`,
    last && last.agreement,
  );
}

/**
 * Offer a document to a room and then PROVE it landed, by reading it back over a socket the
 * seeding one had already closed.
 *
 * A non-empty destination is refused by default. The room would reconcile the offer per node
 * rather than adopt it — safe, and almost never what a cutover meant: seeding a destination
 * that already holds a board means two boards are being merged, which is a decision, not a
 * step. `merge: true` says it out loud.
 */
export async function seedRoom(open, {
  origin, path, doc, name = "board-snapshot-seed", direct = false, headers,
  merge = false, settleMs = DEFAULT_SETTLE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, sleep = sleepReal,
} = {}) {
  checkDoc(doc);
  const url = roomUrl({ origin, path, name, direct });
  const seeder = await connectRoom(open, { url, headers, timeoutMs });
  let before;
  try {
    before = readWelcome(seeder.welcome);
    if (!before.empty && !merge) {
      throw new SnapshotError("destination-not-empty", `${path} already holds a board of ${before.doc.nodes.length} node(s) — pass merge to reconcile into it`, docSummary(before.doc));
    }
    seeder.send({ t: "doc", doc });
    await sleep(settleMs);
  } finally {
    seeder.close();
  }
  // The close above is the reason this read is worth anything: the last socket out flushes
  // and drops the room's RAM cache, so what comes back has been through storage.
  await sleep(settleMs);
  const back = await joinAndRead(open, { url: roomUrl({ origin, path, name: `${name}-verify`, direct }), headers, timeoutMs });
  const comparison = compareDocs(doc, back.doc);
  // TWO VERDICTS, because one would have to lie about a merge.
  //
  // `nodesLanded` is the question a seed is actually asking: is every node that was offered
  // now there, at the version it was offered at. `identical` is the stronger claim that the
  // destination document is the source document whole.
  //
  // On an EMPTY destination the two coincide — `adoptDoc` takes the offer wholesale, name
  // included — and `ok` is the strong one. On a MERGE they must not: the room keeps its own
  // name when the offer's `nameV` does not beat it, and keeps its own tombstones, both by the
  // version rules and both correctly. Reporting that as a failed seed printed "0 never
  // arrived, 0 differ" underneath the word FAILED, which is a report nobody can act on.
  const nodesLanded = comparison.onlyInA.length === 0 && comparison.differing.length === 0;
  const identical = comparison.sameContent === true;
  return {
    ok: before.empty ? identical : nodesLanded,
    nodesLanded,
    identical,
    destinationWasEmpty: before.empty,
    merged: !before.empty,
    // What the destination kept that the offer did not carry. Empty on a fresh destination.
    kept: { nodes: comparison.onlyInB, name: comparison.nameChanged ? back.doc.name : null, tombs: Object.keys((back.doc && back.doc.tombs) || {}).length },
    offered: docSummary(doc),
    landed: docSummary(back.doc),
    comparison,
  };
}

/**
 * The KV mirror, as the public rail serves it. Read over HTTP, never out of a namespace: the
 * key's spelling moves with the deployment shape (`board:<path>` before the rooms are folded
 * in, `board:<workspace>:<path>` after) and the rail is the one thing that answers the same
 * on both sides.
 */
export async function readMirror({ origin, path, fetchImpl = fetch } = {}) {
  const base = String(origin).trim().replace(/\/+$/, "").replace(/^ws/, "http");
  const url = `${base}/__board?path=${encodeURIComponent(path)}`;
  const at = Date.now();
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new SnapshotError("mirror-unreadable", `GET /__board → ${res.status}`);
  const body = await res.json();
  if (body && body.warning === "no-kv-binding") throw new SnapshotError("mirror-unreadable", "the deployment binds no KV, so it has no mirror");
  const doc = body && body.doc ? body.doc : null;
  if (doc) checkDoc(doc);
  return { at, doc, summary: docSummary(doc) };
}

/**
 * How far behind the mirror is, in the only units that mean anything: nodes.
 *
 * THE ORDER IS THE MEASUREMENT. The mirror is read FIRST, because reading the room can flush
 * it — a snapshot taken of a quiet board leaves as its parting act the very write that would
 * make the mirror look like it had been fresh all along. Reading it again afterwards is not
 * redundant: the difference between the two mirror reads is that flush, made visible.
 */
export async function measureLag(open, {
  origin, path, fetchImpl = fetch, sleep = sleepReal, ...opts
} = {}) {
  const before = await readMirror({ origin, path, fetchImpl });
  const room = await snapshotRoom(open, { origin, path, sleep, ...opts });
  const after = await readMirror({ origin, path, fetchImpl });
  const vsBefore = compareDocs(room.doc, before.doc);
  const vsAfter = compareDocs(room.doc, after.doc);
  const missed = vsBefore.onlyInA.length + vsBefore.newerInA.length;
  return {
    path,
    origin,
    cadenceMs: MIRROR_CADENCE_MS,
    room: room.summary,
    mirrorBefore: before.summary,
    mirrorAfter: after.summary,
    // What a KV-sourced migration started at this instant would have lost.
    wouldHaveLost: { nodes: missed, missing: vsBefore.onlyInA, stale: vsBefore.newerInA },
    mirrorWasBehind: !vsBefore.same,
    mirrorCaughtUp: !vsBefore.same && vsAfter.same,
    readFlushedTheMirror: before.summary.digest !== after.summary.digest,
    vsBefore,
    vsAfter,
    snapshot: room,
  };
}
