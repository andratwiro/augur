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

test("the file and the overlay land in DIFFERENT columns and are not folded together", async () => {
  // ⚠️ THIS IS THE PROPERTY `B-kv-read-cutover` COULD NOT MOVE THE ROSTER WITHOUT.
  // The copy used to write the MERGED answer — the overlay's role and name if there was
  // one, the file's otherwise — and a merged column cannot be un-merged: `applyNames` DROPS
  // a config-set `initials` when a name override exists and KEEPS it when one does not, so
  // the serving path needs to know which of the two said what. It records both.
  const { identity } = await identityFromKv({
    "users:roster": { add: { "owner@example.com": { email: "owner@example.com", name: "Impostor", role: "viewer" } } },
    "users:roles": { "owner@example.com": "editor" },
    "users:names": { "owner@example.com": { name: "Chosen", at: NOW } },
  }, {
    configUsers: [{ email: "owner@example.com", name: "Owner", role: "admin", initials: "OW", color: "#123456" }],
    hashInvite, now: NOW,
  });

  assert.equal(identity.members.length, 1, "one address is one member however many documents mention it");
  const m = identity.members[0];
  assert.equal(m.name, "Owner", "the durable column holds the FILE's name");
  assert.equal(m.role, "admin", "and the file's role");
  assert.equal(m.initials, "OW", "initials come across — the roster serves them on every chip");
  assert.equal(m.colour, "#123456", "and so does the colour");
  assert.deepEqual(m.nameOverlay, { name: "Chosen", at: NOW }, "the overlay's name is its own column");
  assert.equal(m.roleOverlay, "editor", "and so is the overlay's role");
  assert.equal(m.source, "config", "provenance is recorded, never inferred from the row afterwards");
});

test("the overlay name travels VERBATIM, both live shapes", async () => {
  // `users:names` holds `{name, at}` today and a bare string on instances that have not
  // written a name since the shape changed — and `applyNames` reads `rec.name`, so it
  // honours the first and IGNORES the second. Normalising the bare string into an object
  // here would start applying a display name the KV path does not, on exactly the oldest
  // instances, which is a divergence rather than a cut.
  const { identity } = await identityFromKv({
    "users:names": { "old@example.com": "Legacy", "new@example.com": { name: "Current", at: NOW } },
  }, {
    configUsers: [
      { email: "old@example.com", name: "Old", role: "editor" },
      { email: "new@example.com", name: "New", role: "editor" },
    ],
    hashInvite, now: NOW,
  });
  assert.equal(byEmail(identity.members, "old@example.com").nameOverlay, "Legacy", "a bare string stays a bare string");
  assert.deepEqual(byEmail(identity.members, "new@example.com").nameOverlay, { name: "Current", at: NOW });
});

test("an overlay-added address is marked as such, so it can be told from one the file names", async () => {
  const { identity } = await identityFromKv({
    "users:roster": { add: { "invited@example.com": {
      email: "invited@example.com", name: "Invited", role: "editor",
      initials: "IN", color: "#abcdef", addedAt: "2026-08-01T00:00:00.000Z", addedBy: "owner@example.com",
    } } },
  }, {
    configUsers: [{ email: "owner@example.com", name: "Owner", role: "admin" }],
    hashInvite, now: NOW,
  });
  const m = byEmail(identity.members, "invited@example.com");
  assert.equal(m.source, "overlay");
  assert.equal(m.addedBy, "owner@example.com", "who let them in is part of the record");
  assert.equal(byEmail(identity.members, "owner@example.com").source, "config");
});

test("a role the file holds and the schema does not is RESCUED by a legal overlay, never invented", async () => {
  // `members.role` has a CHECK and `identity.json` does not, so a legacy spelling would be
  // refused by the object and the person would be lost — along with the overlay that was
  // already correcting them. A LEGAL overlay role is taken; nothing else is.
  const { identity } = await identityFromKv({
    "users:roles": { "legacy@example.com": "viewer" },
  }, {
    configUsers: [
      { email: "legacy@example.com", name: "Legacy", role: "user" },
      { email: "stuck@example.com", name: "Stuck", role: "user" },
    ],
    hashInvite, now: NOW,
  });
  assert.equal(byEmail(identity.members, "legacy@example.com").role, "viewer");
  assert.equal(byEmail(identity.members, "stuck@example.com").role, "user",
    "with no legal overlay the odd value is passed through, for the object to refuse BY NAME");
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

test("publish tokens are already hashed and pass through, carrying their SCOPE verbatim", async () => {
  // ⚠️ `space` IS THE AUTHORIZATION AND NOT A LABEL. `publishAuthDetailed` refuses
  // `wrong-space` on it, and `*` is admin-equivalent because a star token pushes the
  // instance config — the user list. Mapping either onto the other would widen every
  // space-scoped token or refuse every star one, and nothing says so until a publish fails.
  const { identity } = await identityFromKv({
    "publish:tokens": {
      "already-a-hash": { space: "gallery", label: "owner@example.com", createdAt: "2026-08-05T00:00:00.000Z" },
      "star-hash": { space: "*", label: "ci", createdAt: "2026-08-06T00:00:00.000Z" },
      "no-scope-hash": { label: "odd", createdAt: "2026-08-07T00:00:00.000Z" },
    },
  }, { hashInvite, now: NOW });

  const by = (h) => identity.publishTokens.find((t) => t.tokenHash === h);
  assert.equal(by("already-a-hash").expiresAt, null, "a token minted before expiry existed has none, and null is the honest answer");
  assert.equal(by("already-a-hash").scope, "gallery", "a space id stays that space id");
  assert.equal(by("star-hash").scope, "*", "and a star stays a star — never narrowed to the default space");
  assert.equal(by("no-scope-hash").scope, null,
    "a record with no scope copies as null, which the read treats as 'cannot answer' rather than as any scope");
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
