// The mapping from KV's identity documents to the workspace object's rows.
//
// `B-kv-to-do-migration-tool`. This is where a copy silently loses somebody, so it is
// tested against fixtures rather than run against an instance and eyeballed. The property
// that matters most is the first test: the roster has TWO layers and only one is in KV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFromKv } from "../src/kv-identity.mjs";

const NOW = "2026-08-26T12:00:00.000Z";
// A stand-in digest that does NOT contain its input — the point of hashing an invite is
// that the stored value cannot be replayed, and a fixture echoing the token back would let
// that test pass on a function that did nothing.
const hashInvite = async (t) => "d" + [...String(t)].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(16);
const HASH_OF_RAW = "d" + [...("raw-token-abc")].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(16);
const byEmail = (rows, e) => rows.find((r) => r.email === e);

test("the config roster is carried, not just the KV overlay", async () => {
  // An instance nobody has invited anyone to has an EMPTY users:roster and a full
  // identity.json. Reading KV alone would copy a workspace with no members in it.
  const { identity } = await identityFromKv({}, {
    configUsers: [
      { email: "Owner@Example.com", name: "Owner", role: "admin", addedAt: "2026-01-01T00:00:00.000Z" },
      { email: "second@example.com", name: "Second", role: "editor" },
    ],
    hashInvite, now: NOW,
  });

  assert.equal(identity.members.length, 2);
  assert.equal(byEmail(identity.members, "owner@example.com").role, "admin", "addresses are lowercased into one identity");
  assert.equal(byEmail(identity.members, "second@example.com").addedAt, NOW, "a config user with no addedAt gets the run's stamp");
});

test("config wins over an overlay add of the same address, and the role overlay wins over both", async () => {
  const { identity } = await identityFromKv({
    "users:roster": { add: { "owner@example.com": { email: "owner@example.com", name: "Impostor", role: "viewer" } } },
    "users:roles": { "owner@example.com": "editor" },
    "users:names": { "owner@example.com": { name: "Chosen", at: NOW } },
  }, {
    configUsers: [{ email: "owner@example.com", name: "Owner", role: "admin" }],
    hashInvite, now: NOW,
  });

  assert.equal(identity.members.length, 1, "one address is one member however many documents mention it");
  const m = identity.members[0];
  assert.equal(m.name, "Chosen", "a self-set name beats the config's");
  assert.equal(m.role, "editor", "the role overlay beats the config, the way applyRoles does");
});

test("a removal is a tombstone carrying the role it had", async () => {
  const { identity } = await identityFromKv({
    "users:roster": { add: {}, remove: ["gone@example.com"] },
  }, {
    configUsers: [
      { email: "gone@example.com", name: "Gone", role: "editor" },
      { email: "stays@example.com", name: "Stays", role: "viewer" },
    ],
    hashInvite, now: NOW,
  });

  const gone = byEmail(identity.members, "gone@example.com");
  assert.ok(gone, "a removed person is a row, not an absence — a re-invite must not inherit their role");
  assert.equal(gone.removedAt, NOW);
  assert.equal(gone.role, "editor");
  assert.equal(byEmail(identity.members, "stays@example.com").removedAt, null);
});

test("an invite is re-keyed by hash, and the raw token never reaches the object", async () => {
  const { identity } = await identityFromKv({
    "users:invites": { "raw-token-abc": { email: "New@example.com", expires: "2026-09-01T00:00:00.000Z" } },
  }, { hashInvite, now: NOW });

  assert.deepEqual(identity.invites, [{
    tokenHash: HASH_OF_RAW, email: "new@example.com",
    createdAt: NOW, expiresAt: "2026-09-01T00:00:00.000Z", createdBy: null,
  }]);
  assert.ok(!JSON.stringify(identity).includes("raw-token-abc"), "the raw token is nowhere in what is handed over");
});

test("invites without a hash function is refused rather than copied in the clear", async () => {
  await assert.rejects(
    () => identityFromKv({ "users:invites": { t: { email: "a@example.com" } } }, { now: NOW }),
    /hashInvite/,
  );
});

test("publish tokens are already hashed and pass through", async () => {
  const { identity } = await identityFromKv({
    "publish:tokens": { "already-a-hash": { space: "delta", label: "owner@example.com", createdAt: "2026-08-05T00:00:00.000Z" } },
  }, { hashInvite, now: NOW });

  assert.equal(identity.publishTokens[0].tokenHash, "already-a-hash");
  assert.equal(identity.publishTokens[0].expiresAt, null, "a token minted before expiry existed has none, and null is the honest answer");
});

test("prefixed families become rows, and the two blob prefixes keep their names", async () => {
  const { identity } = await identityFromKv({
    "users:lastseen:": { "Owner@example.com": "2026-08-26T09:00:00.000Z" },
    "avatar:": { abc123: "data:image/png;base64,AAA" },
    "spaceicon:": { def456: "data:image/png;base64,BBB" },
  }, { hashInvite, now: NOW });

  assert.deepEqual(identity.lastseen, [{ email: "owner@example.com", at: "2026-08-26T09:00:00.000Z" }]);
  assert.deepEqual(identity.blobs.map((b) => b.key).sort(), ["avatar:abc123", "spaceicon:def456"]);
});

test("a family with nowhere to land is NAMED, never dropped quietly", async () => {
  // A copy that silently skips a family is indistinguishable from a complete one. The
  // suppression list is the one that matters: dropping it resumes mailing people a
  // provider already said to stop mailing.
  const { skipped, consumed } = await identityFromKv({
    "mail:suppressed": { "bounced@example.com": true },
    "spaces:icons": { delta: "def456" },
    "users:roles": {},
  }, { hashInvite, now: NOW });

  assert.deepEqual(skipped.map((s) => s.id).sort(), ["mail:suppressed", "spaces:icons"]);
  assert.ok(/breaks a promise/.test(skipped.find((s) => s.id === "mail:suppressed").why));
  assert.ok(!consumed.includes("mail:suppressed"), "a skipped family is not reported as copied");
  assert.ok(consumed.includes("users:roles"), "a family that WAS read is reported as consumed");
});
