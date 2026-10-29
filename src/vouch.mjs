/* Vouch tickets: the workspace says "this is our signed-in member" to another origin.
 *
 * WHY. A framed app (a lab, a workbench) runs on its own origin and cannot see the
 * workspace's __Host- session cookie, so it cannot tell a member from a stranger. The
 * workspace's own page asks POST /__vouch for a ticket naming the app's origin (`aud`),
 * hands it to the frame, and the app checks it with a key only it and the workspace hold.
 *
 * WHAT IS SIGNED. ticket = `<payload>.<sig>`, payload = base64url(JSON {v:1, iss, aud, sub,
 * role, iat, exp, jti, cip}), sig = base64url(Ed25519 signature over the payload as ASCII). iss is
 * the workspace origin that minted it, sub the member's email, iat/exp seconds, exp = iat +
 * 60, jti 128 random bits so a receiver can refuse a replay, cip = base64url(SHA-256(
 * "augur-vouch-ip:" + the minting browser's IP)) so a ticket carried off the member's network
 * is refused: prototypes share the workspace origin, so a prototype's script can mint one. A signature rather than an HMAC
 * so the receiver holds only a public key: nothing secret ever leaves the worker.
 *
 * WHO DECLARES AN AUDIENCE. Only the deployment, per workspace: `env.VOUCH_KEYS` is a
 * runtime secret holding JSON {"<workspace origin>": {"<aud origin>": <Ed25519 private JWK
 * {kty:"OKP", crv:"Ed25519", d, x}>}}. A key present for (this origin, aud) IS the
 * declaration; nothing in the engine names an audience, so a raw build vouches to nobody.
 * One key per (workspace, aud): a receiver pinning one public key accepts neither another
 * workspace's tickets nor tickets meant for another app. GET /__vouch/key?aud= serves the
 * public half (x) so a receiver can check what it pinned.
 */

export const VOUCH_TTL_S = 60;

const b64url = (bytes) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
function unb64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}
const utf8 = (s) => new TextEncoder().encode(s);

// An audience is an origin and nothing else: scheme + host (+ port), no path, no slash.
// Compared as a string, so the declared spelling and the asked spelling must agree exactly.
export function isOrigin(s) {
  if (typeof s !== "string" || s.length > 200) return false;
  try { return new URL(s).origin === s && s.startsWith("https://"); } catch { return false; }
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** The private JWK the deployment declared for (iss, aud), or null when it declared none. */
export function vouchKey(env, iss, aud) {
  const raw = env && env.VOUCH_KEYS;
  if (!raw || !isOrigin(aud)) return null;
  let table;
  try { table = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  const forIss = table && Object.prototype.hasOwnProperty.call(table, iss) ? table[iss] : null;
  const jwk = forIss && Object.prototype.hasOwnProperty.call(forIss, aud) ? forIss[aud] : null;
  // A malformed entry is not a declaration: refusing beats signing with something odd.
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !B64URL_32.test(jwk.d || "") || !B64URL_32.test(jwk.x || "")) return null;
  return { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x };
}

/** The claim binding a ticket to the IP that minted it (the receiver hashes its own view). */
export async function clientIpClaim(ip) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("augur-vouch-ip:" + ip))));
}

/** Mint a ticket with a key from vouchKey. `ip` is required. `now` in ms. Returns { ticket, claims }. */
export async function signVouch(jwk, { iss, aud, sub, role, ip }, now = Date.now()) {
  if (typeof ip !== "string" || !ip) throw new Error("vouch: no client ip");
  const iat = Math.floor(now / 1000);
  const claims = { v: 1, iss, aud, sub, role, iat, exp: iat + VOUCH_TTL_S,
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))), cip: await clientIpClaim(ip) };
  const payload = b64url(utf8(JSON.stringify(claims)));
  const k = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", k, utf8(payload)));
  return { ticket: `${payload}.${b64url(sig)}`, claims };
}

/**
 * Check a ticket the way a receiver must: signature first, then v, iss, aud, the clock and the
 * redeemer's IP. `x` is the pinned public key (base64url), `ip` the redeeming request's IP. Returns the claims or null. The engine never
 * calls this; it is the reference a receiver's port is tested against, and the tests' proof
 * that what is minted verifies.
 */
export async function verifyVouch(x, ticket, { iss, aud, ip }, now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > 2048) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const sig = unb64url(parts[1]);
  const pub = unb64url(x);
  if (!sig || sig.length !== 64 || !pub || pub.length !== 32) return null;
  const k = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("Ed25519", k, sig, utf8(parts[0])))) return null;
  let c;
  try { c = JSON.parse(new TextDecoder().decode(unb64url(parts[0]))); } catch { return null; }
  const t = Math.floor(now / 1000);
  if (!c || c.v !== 1 || c.iss !== iss || c.aud !== aud || typeof c.sub !== "string") return null;
  if (!Number.isInteger(c.exp) || !Number.isInteger(c.iat) || c.exp <= t || c.iat > t + 5) return null;
  if (typeof ip !== "string" || !ip || c.cip !== await clientIpClaim(ip)) return null;
  return c;
}
