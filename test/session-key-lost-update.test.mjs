// Rotating one person's session key must not resurrect another's.
//
// `B-sessionkeys-lost-update`. `users:sessionkeys` was ONE document holding every person's
// key, and rotate/clear rebuilt it read-modify-write. A KV read serves a cache that can be
// a minute stale, so rotating person A could read a map that predates person B's fresh key
// and write B's OLD key back — killing B's live session (their cookie is bound to the new
// key) and un-doing the invalidation the verb exists to guarantee (a key cleared to end
// sessions comes back, and the old cookie verifies again). Two key writes inside one cache
// window is exactly what an invite flow does.
//
// The fix is a record PER PERSON — `users:sessionkeys:<digest of the address>` — written
// blind, so there is no shared document and nothing to lose. The old document is read only
// when a person has no record yet, and never written again: that read-through is the
// migration, and a tombstone record is what shadows it.
//
// Every test here drives the store through a STALE-READ double: writes land in `store`
// at once, reads answer from `view`, and `view` catches up only when `sync()` is called.
// Shortening the window or retrying is not a fix, so the tests never sync inside one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const ORIGIN = "https://x.test";
const ENV_SECRET = { SESSION_SECRET: "s3cret" };
const A = { email: "a@x.test", name: "A", role: "editor" };
const B = { email: "b@x.test", name: "B", role: "editor" };
const ROSTER = [A, B];

/** A KV whose reads lag its writes until `sync()`. `list` answers from the truth, like a REST listing. */
function staleKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  let view = new Map(store);
  const kv = {
    store,
    get view() { return view; },
    sync() { view = new Map(store); },
    async get(k) { return view.has(k) ? view.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
  return kv;
}

const envWith = (kv, extra = {}) => ({ ...ENV_SECRET, COMMENTS: kv, ...extra });
const CTX_ON = { ...W.applyDerivedRouting({}), SESSION_KEYS: true };

/** A session cookie bound to `key`, exactly as an issuer would mint it. */
async function cookieBoundTo(env, u, key) {
  return `${W.USER_COOKIE}=${u.email}.${await W.userToken(env, u, key, true)}`;
}
const verifies = async (env, cookie) => {
  const who = await W.identify(new Request(`${ORIGIN}/`, { headers: { Cookie: cookie } }), env, ROSTER, { sessionKeys: true, tctx: CTX_ON });
  return !!who;
};
/** The key the store holds for this person now, read from the TRUTH rather than the view. */
async function storedKey(kv, email) {
  const raw = kv.store.get(await W.sessionKeyName(email));
  return raw ? JSON.parse(raw).key : undefined;
}

// ── VERIFY clause 1: two rotates inside one stale window ─────────────────────

test("TWO ROTATES INSIDE A STALE-READ WINDOW: each person's newest key is the stored one, and neither old key verifies", async () => {
  const kv = staleKv();
  const env = envWith(kv);

  // Both people hold a live session.
  const a1 = (await W.rotateSessionKey(env, A.email)).key;
  const b1 = (await W.rotateSessionKey(env, B.email)).key;
  kv.sync();
  const cookieA1 = await cookieBoundTo(env, A, a1);
  const cookieB1 = await cookieBoundTo(env, B, b1);
  assert.equal(await verifies(env, cookieA1), true);
  assert.equal(await verifies(env, cookieB1), true);

  // Now two rotates, back to back, with every read answering from before either of them.
  const a2 = (await W.rotateSessionKey(env, A.email)).key;
  const b2 = (await W.rotateSessionKey(env, B.email)).key;
  assert.notEqual(a2, a1); assert.notEqual(b2, b1);

  // The store — the truth, not the cache — holds each person's NEWEST key.
  assert.equal(await storedKey(kv, A.email), a2, "A's rotate was lost: B's write carried A's old key back");
  assert.equal(await storedKey(kv, B.email), b2);

  // And once the cache catches up, the old cookies are dead and the new ones live.
  kv.sync();
  assert.equal(await verifies(env, cookieA1), false, "A's PRE-rotate cookie verifies — the invalidation was undone");
  assert.equal(await verifies(env, cookieB1), false);
  assert.equal(await verifies(env, await cookieBoundTo(env, A, a2)), true, "A's fresh session died");
  assert.equal(await verifies(env, await cookieBoundTo(env, B, b2)), true, "B's fresh session died");
});

test("a ROTATE and a CLEAR inside one window: the clear holds, and the rotate holds", async () => {
  // The other pairing an admin produces: A redeems (rotate) while B's password is being
  // reset (clear). A clear that lost to a stale rotate would leave B's old cookie working
  // after a reset — the opposite of what a reset is for.
  const kv = staleKv({ "users:secrets": JSON.stringify({ [B.email]: "pbkdf2$b" }) });
  const env = envWith(kv);
  const a1 = (await W.rotateSessionKey(env, A.email)).key;
  const b1 = (await W.rotateSessionKey(env, B.email)).key;
  kv.sync();
  const cookieB1 = await cookieBoundTo(env, B, b1);
  assert.equal(await verifies(env, cookieB1), true);

  const a2 = (await W.rotateSessionKey(env, A.email)).key;
  await W.clearSessionKey(env, B.email);
  kv.sync();

  assert.equal(await storedKey(kv, A.email), a2);
  assert.equal(await verifies(env, cookieB1), false, "B's pre-reset cookie verifies — the clear was lost");
  assert.equal(await W.sessionBinding(env, B, "pbkdf2$b", true), "pbkdf2$b", "a cleared key falls back to the credential");
  assert.equal(await verifies(env, await cookieBoundTo(env, A, a1)), false);
  assert.equal(await verifies(env, await cookieBoundTo(env, A, a2)), true);
});

// ── VERIFY clause 3: the invite flow, twice in quick succession ──────────────

test("TWO INVITES REDEEMED IN QUICK SUCCESSION leave both people able to sign in", async () => {
  const kv = staleKv();
  const env = envWith(kv);
  // Minted minutes apart, as invitations are — the cache has seen both links. (The
  // invites document is read-modify-write too; two mints inside one window is a
  // different defect and not the one under test.)
  const tA = await W.mintInvite(CTX_ON, env, A.email);
  kv.sync();
  const tB = await W.mintInvite(CTX_ON, env, B.email);
  kv.sync();

  const redeem = (t) => W.invitePost(CTX_ON, new Request(`${ORIGIN}/__invite`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: t }).toString(),
  }), new URL(`${ORIGIN}/__invite`), env, ROSTER);

  // Both click within the window. No read between the two sees the first one's write.
  const resA = await redeem(tA);
  assert.equal(resA.status, 303);
  const resB = await redeem(tB);
  assert.equal(resB.status, 303);
  const cookieA = resA.headers.get("Set-Cookie").split(";")[0];
  const cookieB = resB.headers.get("Set-Cookie").split(";")[0];

  kv.sync();
  assert.equal(await verifies(env, cookieA), true, "the first redemption's session died on the second's write");
  assert.equal(await verifies(env, cookieB), true);
});

// ── The migration: sessions on a live instance survive the deploy ────────────

test("A COOKIE MINTED UNDER THE OLD DOCUMENT SHAPE STILL VERIFIES, with no record of its own and no write", async () => {
  // What the first request after the deploy does with an existing cookie: no per-person
  // record exists yet, so the binding reads the person's entry out of the old document
  // and the cookie verifies exactly as before. Nothing is written — a write on the read
  // path would be the same stale-copy race in a new place.
  const kv = staleKv({ [W.SESSION_KEYS_KEY]: JSON.stringify({ [A.email]: "a".repeat(64), [B.email]: "b".repeat(64) }) });
  const env = envWith(kv);
  const before = new Map(kv.store);
  assert.equal(await verifies(env, await cookieBoundTo(env, A, "a".repeat(64))), true);
  assert.equal(await verifies(env, await cookieBoundTo(env, B, "b".repeat(64))), true);
  assert.deepEqual([...kv.store], [...before], "a read wrote something");
});

test("the old document is NEVER WRITTEN AGAIN: a rotate shadows this person's entry and leaves the document byte-identical", async () => {
  const legacy = JSON.stringify({ [A.email]: "a".repeat(64), [B.email]: "b".repeat(64) });
  const kv = staleKv({ [W.SESSION_KEYS_KEY]: legacy });
  const env = envWith(kv);
  const a2 = (await W.rotateSessionKey(env, A.email)).key;
  kv.sync();
  assert.equal(kv.store.get(W.SESSION_KEYS_KEY), legacy, "the old document was rewritten");
  assert.equal(await verifies(env, await cookieBoundTo(env, A, "a".repeat(64))), false, "the old entry still verifies after a rotate");
  assert.equal(await verifies(env, await cookieBoundTo(env, A, a2)), true);
  // B, untouched, is still on the old document and still signed in.
  assert.equal(await verifies(env, await cookieBoundTo(env, B, "b".repeat(64))), true);
});

test("a CLEAR for somebody still on the old document shadows their entry rather than falling through to it", async () => {
  // This is why a clear writes a tombstone instead of deleting: absent means "ask the old
  // document", and the old document holds the key the clear exists to end.
  const kv = staleKv({
    [W.SESSION_KEYS_KEY]: JSON.stringify({ [A.email]: "a".repeat(64) }),
    "users:secrets": JSON.stringify({ [A.email]: "pbkdf2$new" }),
  });
  const env = envWith(kv);
  await W.clearSessionKey(env, A.email);
  kv.sync();
  assert.equal(await verifies(env, await cookieBoundTo(env, A, "a".repeat(64))), false, "the cleared key came back from the old document");
  assert.equal(await W.sessionBinding(env, A, "pbkdf2$new", true), "pbkdf2$new");
});

test("a present-and-falsy entry in the OLD document is still a revocation", async () => {
  // The document's own semantics travel with it: it is read as it always was.
  const kv = staleKv({ [W.SESSION_KEYS_KEY]: JSON.stringify({ [A.email]: null }) });
  assert.equal(await W.sessionBinding(envWith(kv), A, "pbkdf2$a", true), "");
});

// ── The record ───────────────────────────────────────────────────────────────

test("the record is keyed by a digest of the lowercased address — no address in a key name, and case does not make two people", async () => {
  const name = await W.sessionKeyName("Ada@X.test");
  assert.equal(name, await W.sessionKeyName("ada@x.test"));
  assert.ok(name.startsWith(W.SESSION_KEY_PREFIX));
  assert.equal(name.includes("@"), false);
  assert.match(name.slice(W.SESSION_KEY_PREFIX.length), /^[0-9a-f]{64}$/);
});

test("an unreadable or malformed record is a refusal, never a fallback", async () => {
  const throwing = { async get() { throw new Error("kv down"); }, async put() {} };
  assert.equal(await W.sessionBinding(envWith(throwing), A, "pbkdf2$a", true), "");
  const kv = staleKv({ [await W.sessionKeyName(A.email)]: "[]" });
  assert.equal(await W.sessionBinding(envWith(kv), A, "pbkdf2$a", true), "");
  const kv2 = staleKv({ [await W.sessionKeyName(A.email)]: JSON.stringify({ key: 42 }) });
  assert.equal(await W.sessionBinding(envWith(kv2), A, "pbkdf2$a", true), "");
});

test("on a host-resolved deployment the record lands under the workspace segment and nowhere else", async () => {
  const kv = staleKv();
  const env = envWith(kv, { TENANT_HOST_SUFFIX: ".example.com" });
  const tctx = { ...CTX_ON, tenantId: "acme" };
  const r = await W.rotateSessionKey(env, A.email, tctx);
  assert.equal(r.ok, true);
  const name = await W.sessionKeyName(A.email);
  assert.equal(kv.store.has(`t/acme/${name}`), true, "the segmented record was not written");
  assert.equal(kv.store.has(name), false, "the unsegmented key was written on a shared namespace");
  kv.sync();
  assert.equal(await W.sessionBinding(env, A, "pbkdf2$a", true, tctx), r.key);
});
