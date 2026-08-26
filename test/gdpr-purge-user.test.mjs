// Erasing one person from a workspace's stored comments.
//
// `E-gdpr-purge-user`. The existing `remove` op revokes the credential, the invites, the
// avatar, the name, the role and the lastseen stamp — and never touches comment
// AUTHORSHIP anywhere. So a person removed from a roster is still named on every message
// they wrote, which is exactly the state an erasure request is about.
//
// The two things this has to get right are opposite failures: erasing too little (the
// name survives somewhere) and erasing too much (somebody else's conversation becomes
// unreadable, or an innocent third party is redacted by a hash collision).
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const { purgeThreads, purgeUser, personId, PURGED_AUTHOR } = W;

// purgeUser sweeps through the overlay accessor now, not through a KV binding directly:
// the workspace store answers the same question with a SELECT where KV needs a listing.
// These fixtures are all KV, which is what every live instance is.
const CTX = Object.freeze({ tenantId: "acme" });
const purgeVia = (kv, users, email) => purgeUser(W.overlayFor({ COMMENTS: kv }, CTX), kv, users, email);

const ME = "ada@example.test";
const OTHER = "grace@example.test";

const msg = (email, body, at) => ({
  author: email.split("@")[0], verified: true, by: email ? personId(email) : null, body, at,
});
const thread = (id, msgs) => ({ id, sel: "h1", fx: 1, fy: 2, resolved: false, annotation: false, messages: msgs });

function memKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    store: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "", cursor } = {}) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true, cursor: null,
    }),
  };
}

// ── the pure redaction ───────────────────────────────────────────────────────

test("the person's messages stop identifying them, and keep their body and timestamp", () => {
  const t = [thread("t1", [msg(ME, "the question", "2026-01-01T00:00:00Z"), msg(OTHER, "the answer", "2026-01-02T00:00:00Z")])];
  const { threads, redacted } = purgeThreads(t, personId(ME));
  assert.equal(redacted, 1);
  const [mine, theirs] = threads[0].messages;
  assert.equal(mine.author, PURGED_AUTHOR);
  assert.equal(mine.by, null);
  assert.equal(mine.verified, false);
  assert.equal(mine.body, "the question", "the body was erased — the request is to stop identifying somebody, not to rewrite the record");
  assert.equal(mine.at, "2026-01-01T00:00:00Z");
  assert.deepEqual(theirs, msg(OTHER, "the answer", "2026-01-02T00:00:00Z"), "a bystander's message was touched");
});

test("THREAD STRUCTURE SURVIVES — deleting the messages would erase other people's conversation", () => {
  // A reply that answers a question is unreadable once the question is gone, and those
  // other people did not ask to have their record rewritten.
  const t = [thread("t1", [msg(ME, "q"), msg(OTHER, "a"), msg(ME, "thanks")])];
  const { threads } = purgeThreads(t, personId(ME));
  assert.equal(threads.length, 1);
  assert.equal(threads[0].messages.length, 3, "a message was removed rather than redacted");
  assert.equal(threads[0].id, "t1");
  assert.equal(threads[0].sel, "h1", "thread geometry was lost");
});

test("a field a future version adds survives an erasure written before it existed", () => {
  const t = [thread("t1", [{ ...msg(ME, "q"), reactions: ["👍"], edited: true }])];
  const { threads } = purgeThreads(t, personId(ME));
  assert.deepEqual(threads[0].messages[0].reactions, ["👍"]);
  assert.equal(threads[0].messages[0].edited, true);
});

test("threads with nothing to redact are left alone entirely", () => {
  const t = [thread("t1", [msg(OTHER, "a")])];
  const { threads, redacted } = purgeThreads(t, personId(ME));
  assert.equal(redacted, 0);
  assert.equal(threads[0], t[0], "an untouched thread was rewritten anyway");
});

test("malformed stored data does not throw", () => {
  assert.equal(purgeThreads(null, "x").redacted, 0);
  assert.equal(purgeThreads([null, {}, { messages: null }], "x").redacted, 0);
});

// ── the sweep ────────────────────────────────────────────────────────────────

test("every comment path in the workspace is swept, and lastseen is deleted", async () => {
  const kv = memKV({
    "c:/a/": JSON.stringify([thread("t1", [msg(ME, "one")])]),
    "c:/b/": JSON.stringify([thread("t2", [msg(OTHER, "x"), msg(ME, "two")])]),
    "c:/c/": JSON.stringify([thread("t3", [msg(OTHER, "y")])]),
    ["users:lastseen:" + ME]: "2026-01-01T00:00:00Z",
    ["users:lastseen:" + OTHER]: "2026-01-01T00:00:00Z",
  });
  const r = await purgeVia(kv, [{ email: ME }, { email: OTHER }], ME);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.redacted, 2);
  assert.deepEqual(r.pathsTouched.sort(), ["/a/", "/b/"]);
  assert.equal(r.scanned, 3);

  for (const k of ["c:/a/", "c:/b/", "c:/c/"]) {
    const raw = await kv.get(k);
    assert.ok(!raw.includes(personId(ME)), `${k} still carries the person's id`);
    assert.ok(!raw.includes("ada"), `${k} still carries the person's name`);
  }
  assert.equal(await kv.get("users:lastseen:" + ME), null, "the lastseen stamp survived");
  assert.ok(await kv.get("users:lastseen:" + OTHER), "a bystander's lastseen was deleted");
});

test("the address is case-folded, so a differently-spelled request still erases", async () => {
  const kv = memKV({ "c:/a/": JSON.stringify([thread("t1", [msg(ME, "one")])]), ["users:lastseen:" + ME]: "x" });
  const r = await purgeVia(kv, [{ email: ME }], "  Ada@Example.TEST  ");
  assert.equal(r.ok, true);
  assert.equal(r.redacted, 1);
  assert.equal(await kv.get("users:lastseen:" + ME), null);
});

// ── the sharp edge: identification is a 32-bit hash ──────────────────────────

test("A HASH COLLISION REFUSES rather than redacting an innocent third party", async () => {
  // Messages store personId(email), a one-way djb2 hash, deliberately — an address in
  // every stored message would be reversible PII, and /__people is ungated on public
  // prototypes precisely because ids cannot be reversed. So two addresses CAN share an
  // id, and a purge keyed on it would take a bystander's messages with it. A machine
  // cannot choose between them, so it does not try.
  //
  // THE COLLISION IS REAL, and these two addresses are a measured pair rather than a
  // stub: both hash to "1h8k5uy". They were found by walking ~200k varied addresses.
  //
  // Note what did NOT work, because it says something about the risk. Walking a
  // STRUCTURED family — u0@…, u1@…, u2@… — produced 500,000 distinct ids and zero
  // collisions: djb2 is close to linear, so a regular family maps injectively and the
  // birthday estimate does not apply to it. Collisions are between DISSIMILAR addresses,
  // which is exactly the case a real roster contains.
  //
  // Both ids are asserted below, so if personId ever changes this test fails loudly
  // instead of quietly testing nothing.
  const a = "2a6aeqm662@example.test";
  const b = "qmu6um@example.test";
  assert.notEqual(a, b);
  assert.equal(personId(a), personId(b), "these addresses no longer collide — find a new pair rather than deleting the test");

  const kv = memKV({ "c:/a/": JSON.stringify([thread("t1", [msg(a, "one")])]) });
  const r = await purgeVia(kv, [{ email: a }, { email: b }], a);
  assert.equal(r.ok, false, "the sweep proceeded despite a colliding roster member");
  assert.equal(r.reason, "id-collision");
  assert.equal(r.collidesWith, 1);
  // And nothing was written: a refusal that half-redacts is worse than either answer.
  assert.ok((await kv.get("c:/a/")).includes(personId(a)), "a refused purge still redacted");
});

test("a roster with no collision proceeds normally", async () => {
  // The guard must not refuse every purge — that would be a denial of erasure wearing a
  // safety check's clothes.
  const kv = memKV({ "c:/a/": JSON.stringify([thread("t1", [msg(ME, "one")])]) });
  const r = await purgeVia(kv, [{ email: ME }, { email: OTHER }], ME);
  assert.equal(r.ok, true);
  assert.equal(r.redacted, 1);
});

test("a store with no list support refuses instead of reporting success", async () => {
  const r = await purgeVia({ get: async () => null, put: async () => {}, delete: async () => {} }, [], ME);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "kv-list-unsupported");
});

test("an empty address is refused", async () => {
  assert.equal((await purgeVia(memKV(), [], "")).reason, "bad-address");
});

// ── the wiring: removal is not erasure ───────────────────────────────────────

test("the admin remove op only purges when asked explicitly", async () => {
  // Conflating them would be wrong in both directions. A removed colleague normally
  // SHOULD stay named on the comments they wrote, because the thread is a record other
  // people are part of.
  const src = (await import("node:fs")).readFileSync(
    (await import("node:url")).fileURLToPath(new URL("../src/_worker.js", import.meta.url)), "utf8");
  const at = src.indexOf('shellDispatch(env, "roster-update", { action: "remove"');
  const block = src.slice(at, at + 1400);
  assert.match(block, /op\.purge === true/, "purge is not opt-in on the remove op");
  assert.match(block, /purgeUser\(overlayFor\(env, tctx\), kv, users, email\)/);
  assert.match(block, /catch/, "a failing erasure would throw away a removal that already succeeded");
});
