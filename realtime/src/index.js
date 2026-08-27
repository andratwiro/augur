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
 * VERSIONED NODES (per-node last-writer-wins on a version int, not a CRDT). Every node carries
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

// The document authority itself lives in the ENGINE, so the engine worker and this
// standalone worker deploy the same class rather than two copies that drift. See the
// header of src/board-room.mjs for why this worker still exists.
export { BoardRoom } from "../../src/board-room.mjs";

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

// EXPORTED so nothing spells it twice. `scripts/board-snapshot.mjs` has to send this header
// when it reads a room through this worker's own URL instead of through a site's `/__rt`,
// and a second declaration of a header name is the shape every drift in this pair has taken.
export const RT_SECRET_HEADER = "x-augur-rt";
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
    // ⚠️ THE ROOM NAME STAYS THE BARE PATH HERE, and that is not an oversight this file is
    // waiting to have corrected. A different name is a different Durable Object, and a
    // Durable Object's storage belongs to the script that created it — so renaming the
    // rooms of a LIVE standalone worker orphans every board it holds, for no gain: this
    // worker serves exactly one instance, so a workspace segment would distinguish nothing.
    // The engine worker's /__rt names its rooms `<workspace>:<path>` because there the
    // rooms are new and empty anyway, which is what makes the segment free exactly once.
    // Nothing forwards a workspace to this worker either, so the mirror keys it writes stay
    // unscoped to match — one cutover, both halves, and this worker is on neither side of it.
    const id = env.ROOMS.idFromName(path);
    return env.ROOMS.get(id).fetch(request);
  },
};
