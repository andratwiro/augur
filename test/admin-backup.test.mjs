// The KV export is a backup, so the failure that matters is not "it errored" — it is
// "it returned a shorter file that looked whole". These tests pin that: a read failure
// must destroy the document rather than truncate it, and a key that vanishes mid-walk
// must be named rather than dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed" };

// A KV double with the shape adminBackupApi uses: cursor-paginated list + text get.
function fakeKv(entries, { throwOn = null, vanish = [] } = {}) {
  const keys = Object.keys(entries);
  return {
    async list({ cursor, limit = 1000 }) {
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const next = start + limit;
      return {
        keys: page.map((name) => (entries[name].expiration
          ? { name, expiration: entries[name].expiration }
          : { name })),
        list_complete: next >= keys.length,
        cursor: String(next),
      };
    },
    async get(name) {
      if (name === throwOn) throw new Error("KV read failed");
      if (vanish.includes(name)) return null;
      return entries[name].value;
    },
  };
}

const read = async (res) => {
  const chunks = [];
  for await (const c of res.body) chunks.push(typeof c === "string" ? c : Buffer.from(c));
  return chunks.map((c) => c.toString()).join("");
};

test("only an admin may take a backup", async () => {
  for (const who of [null, EDITOR]) {
    const res = await W.adminBackupApi({ COMMENTS: fakeKv({}) }, who);
    assert.equal(res.status, 403, `${who ? who.email : "anonymous"} must not export KV`);
  }
});

test("no KV binding is a clean 501, not an empty backup", async () => {
  const res = await W.adminBackupApi({}, ADMIN);
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, "no-kv-binding");
});

test("the export carries every key as a raw string, with a complete flag", async () => {
  const kv = fakeKv({
    "users:secrets": { value: '{"a@b.test":"pbkdf2$..."}' },
    "c:/proto/": { value: '[{"id":"t1"}]' },
    "statuses": { value: '{"x":"dev-ready"}' },
    "rl:login:ip:1.2.3.4": { value: "3", expiration: 1800000000 },
  });
  const doc = JSON.parse(await read(await W.adminBackupApi({ COMMENTS: kv }, ADMIN)));

  assert.equal(doc.complete, true);
  assert.equal(doc.count, 4);
  assert.deepEqual(Object.keys(doc.data).sort(), ["c:/proto/", "rl:login:ip:1.2.3.4", "statuses", "users:secrets"]);
  // Raw strings, never re-parsed — a restore must be able to PUT these back verbatim.
  assert.equal(typeof doc.data["c:/proto/"], "string");
  assert.equal(doc.data["c:/proto/"], '[{"id":"t1"}]');
  // TTLs are carried so a restore does not resurrect an expiring key as permanent.
  assert.deepEqual(doc.expirations, { "rl:login:ip:1.2.3.4": 1800000000 });
  assert.deepEqual(doc.vanished, []);
});

test("a key that vanishes between list and get is NAMED, not silently dropped", async () => {
  const kv = fakeKv(
    { keep: { value: "1" }, "rl:expiring": { value: "2" } },
    { vanish: ["rl:expiring"] },
  );
  const doc = JSON.parse(await read(await W.adminBackupApi({ COMMENTS: kv }, ADMIN)));
  assert.equal(doc.complete, true, "a TTL race is expected, not a failure");
  assert.deepEqual(doc.vanished, ["rl:expiring"]);
  assert.equal(doc.count, 1);
  assert.equal(doc.data["rl:expiring"], undefined);
});

test("an unreadable key destroys the document rather than shortening it", async () => {
  const kv = fakeKv(
    { a: { value: "1" }, bad: { value: "2" }, c: { value: "3" } },
    { throwOn: "bad" },
  );
  const res = await W.adminBackupApi({ COMMENTS: kv }, ADMIN);
  let body = null, threw = false;
  try { body = await read(res); } catch { threw = true; }
  // Either the stream errors outright, or we get the bytes written before the failure.
  // What must NEVER happen is valid JSON, because that is a backup someone would keep.
  if (!threw) {
    assert.throws(() => JSON.parse(body), "a failed export must not parse as JSON");
    assert.ok(!body.includes('"complete":true'), "and must never claim completeness");
  }
});

test("pagination does not lose keys across pages", async () => {
  const entries = {};
  for (let i = 0; i < 2500; i++) entries[`k${i}`] = { value: String(i) };
  const doc = JSON.parse(await read(await W.adminBackupApi({ COMMENTS: fakeKv(entries) }, ADMIN)));
  assert.equal(doc.count, 2500);
  assert.equal(doc.complete, true);
  assert.equal(doc.data.k0, "0");
  assert.equal(doc.data.k2499, "2499");
});
