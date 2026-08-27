/* The one spelling of a board document's KV key, and the one header that carries a
 * workspace into a room.
 *
 * WHY THIS FILE EXISTS. A board document has two writers — the `/__board` rail in
 * `src/_worker.js` and the room's write-through mirror in `src/board-room.mjs` — and they
 * have to agree on the key to the character or they are two documents wearing one name.
 * The two used to spell it separately (`OVERLAY_KV_KEYS.boards` on one side, a
 * `BOARD_PREFIX` constant on the other, plus a third copy in `_worker.js` that was
 * exported for tests and read by nothing), which is exactly the shape a drift takes: three
 * declarations, one of them dead, and nothing that would notice if a fourth disagreed.
 * Now there is one, both readers import it, and `test/board-key.test.mjs` asserts the
 * overlay accessor's key and the room's key are the same string.
 *
 * THE WORKSPACE SEGMENT. `board:<path>` says which board and not whose. One deployment,
 * one workspace, and the path was enough; several workspaces behind one deployment and it
 * is a collision waiting for two of them to publish a prototype at the same URL. So the
 * key gains a segment naming the workspace it belongs to.
 *
 * IT IS OPTIONAL, AND THAT IS THE STRADDLE, NOT AN OVERSIGHT. `workspace` empty gives back
 * the legacy key, byte for byte. A deployment that serves its rooms from somewhere else —
 * every one of them today — passes nothing here and writes exactly the keys it has always
 * written; the segment arrives with the deploy that moves the rooms into this worker, and
 * `scripts/migrate-board-keys.mjs` plus a read-through on miss carry the existing
 * documents across it. See `boardKvKey`'s callers for where that decision is made; it is
 * NOT made here, because a key builder that decided policy would be a second place to
 * look for the answer.
 */

/** The prefix every board document key starts with. */
export const BOARD_PREFIX = "board:";

/**
 * The KV key a board document lives under.
 *
 * `workspace` is the resolved workspace id or the empty string. Empty means the legacy,
 * unscoped spelling — which is what every deployment writes until it serves its own rooms.
 * Nothing here validates the workspace: it comes from `resolveTenant`, never from a
 * request, and the callers are where that is guaranteed.
 */
export function boardKvKey(workspace, path) {
  return workspace ? `${BOARD_PREFIX}${workspace}:${path}` : `${BOARD_PREFIX}${path}`;
}

/**
 * The header the engine worker stamps on a room request so the room knows whose board it
 * is holding.
 *
 * SET, never merged, and the room may not take it from anywhere else. A client talks to
 * `/__rt` on the site's own origin, so its headers ride along into the re-wrapped request;
 * `headers.set` overwrites whatever it sent. The value the room sees is therefore always
 * the one `resolveTenant()` produced for that request.
 *
 * A room reached WITHOUT it — the standalone realtime worker, which proxies straight
 * through and has no workspace to name — falls back to the legacy unscoped key, which is
 * the same straddle `boardKvKey` carries.
 */
export const RT_WORKSPACE_HEADER = "x-augur-workspace";
