/* Signed short-lived room tickets for /__rt (A-room-tickets).
 *
 * WHY A TICKET AND NOT THE COOKIE. A canvas board is joined over a WebSocket, and the room
 * it joins is a Durable Object reached only through the worker that holds the ROOMS
 * binding. The DO cannot see the session cookie or the roster — those live in the worker —
 * so "may this caller join this room" has to be decided in the worker and CARRIED to the
 * DO. The ticket is that carriage: the worker mints it AFTER the same authorization gate
 * the page-serving path applies (admin for a restricted space; open for a public /
 * share-link board — today's "the board is the credential" model), and the DO refuses the
 * Upgrade without a valid one.
 *
 * WHAT IT BINDS. `HMAC(secret, workspace:path:who:expiresAt)`. The workspace and path are
 * the isolation boundary the fold relies on — a ticket minted for one workspace's board
 * cannot open another's, because the DO recomputes the MAC from the workspace IT was handed
 * (the RT_WORKSPACE_HEADER the worker set, which a client cannot forge) and the path on the
 * socket URL. `who` rides inside the signed message so the DO can attribute the join, and
 * because it is signed a client cannot rewrite it. `expiresAt` keeps a leaked ticket useful
 * for seconds, not forever.
 *
 * The secret lives ONLY on deployments that fold the rooms into the engine worker (an
 * `env.ROOM_TICKET_SECRET`). A legacy instance whose rooms are still the standalone
 * `augur-realtime-*` worker sets none, mints none, and enforces none — its DO never sees
 * this module's verify. That is why the worker degrades an unconfigured mint to 501 and the
 * client falls back to opening the socket directly, exactly as it did before tickets.
 */

// TextEncoder/TextDecoder are constructed at each use rather than held module-scope: they
// are stateless, a ticket op is not a hot loop, and a module-scope `new X()` is exactly the
// shared-isolate slot scripts/no-tenant-globals.mjs refuses.
const utf8 = (str) => new TextEncoder().encode(str);

const toHex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

// base64url WITHOUT escape/unescape (deprecated) — `who` is an email and may carry a `.`,
// which is the ticket's field delimiter, so it cannot travel raw.
function b64urlEncode(str) {
  let bin = "";
  for (const b of utf8(str)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function mac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, utf8(message)));
}

// The signed message. `who` defaults to "anon" so a public-board join by a signed-out
// visitor still produces a stable, verifiable ticket.
const message = (workspace, path, who, expiresAt) =>
  `${workspace}:${path}:${who || "anon"}:${expiresAt}`;

// Length-independent-once-equal compare, so a MAC mismatch does not leak position by timing.
function macEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// How long a minted ticket stays good. The WS open follows the mint by one round trip, so
// this only has to cover that hop plus a slow client — kept short so a leaked ticket dies
// fast. It is NOT the board session: once the socket is open the ticket is spent.
export const ROOM_TICKET_TTL_MS = 120000;

/** Mint a ticket for {workspace, path, who}. Returns { ticket, expiresAt }. */
export async function signRoomTicket(secret, { workspace, path, who }, now = Date.now()) {
  const expiresAt = now + ROOM_TICKET_TTL_MS;
  const sig = await mac(secret, message(workspace, path, who, expiresAt));
  return { ticket: `${expiresAt}.${b64urlEncode(who || "anon")}.${sig}`, expiresAt };
}

/**
 * Verify a ticket against {workspace, path}. `who` and `expiresAt` come from the ticket
 * itself and are re-bound through the MAC, so tampering with either fails the compare.
 * Returns true only for a live ticket whose signature matches the resolved workspace+path.
 */
export async function verifyRoomTicket(secret, ticket, { workspace, path }, now = Date.now()) {
  if (!secret || typeof ticket !== "string") return false;
  const parts = ticket.split(".");
  if (parts.length !== 3) return false;
  const [expStr, whoB64, sig] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  let who;
  try { who = b64urlDecode(whoB64); } catch { return false; }
  const want = await mac(secret, message(workspace, path, who, expiresAt));
  return macEqual(want, sig);
}
