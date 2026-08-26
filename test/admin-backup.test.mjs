// The KV export is a backup, so the failure that matters is not "it errored" — it is
// "it returned a shorter file that looked whole". These tests pin that: a read failure
// must destroy the document rather than truncate it, a key that vanishes mid-walk must
// be named rather than dropped, and a value that is not text must come back as the bytes
// that were stored rather than as a plausible-looking ruin of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { decodeKvValue, isBinaryKvValue, sha256Hex } from "../src/kv-codec.mjs";

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed" };

// A real PNG. Not a string with odd characters in it — the bug is about byte sequences
// that no text decoding can represent, and only genuine binary exercises that.
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

// A KV double with the shape adminBackupApi uses: cursor-paginated list + a get that,
// like the real binding, hands back BYTES when asked for an arrayBuffer. Entry values are
// written as bytes, because that is what KV stores; a double that stored strings would
// have made the bug it is here to catch unreachable.
function fakeKv(entries, { throwOn = null, vanish = [] } = {}) {
  const keys = Object.keys(entries);
  const bytesOf = (name) => {
    const v = entries[name].value;
    return typeof v === "string" ? new TextEncoder().encode(v) : v;
  };
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
    async get(name, type) {
      if (name === throwOn) throw new Error("KV read failed");
      if (vanish.includes(name)) return null;
      assert.equal(type, "arrayBuffer", `the backup must read ${name} as bytes, never as text`);
      const b = bytesOf(name);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
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
  assert.equal(doc.binary, 0, "nothing in this namespace needed the base64 marker");
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

// ---- the bytes half ---------------------------------------------------------
// A canvas board image is stored raw under a key that is its own SHA-256 prefix. Reading
// it as text turned it into replacement characters that no restore could undo, and the
// only way to notice was to check the value against the key it was filed under. These
// tests do exactly that.

const BASSET = async () => "basset:" + (await sha256Hex(PNG)).slice(0, 40);

test("a value that is not UTF-8 survives the export byte for byte", async () => {
  const key = await BASSET();
  const kv = fakeKv({ [key]: { value: PNG }, statuses: { value: '{"x":"dev-ready"}' } });
  const doc = JSON.parse(await read(await W.adminBackupApi({ COMMENTS: kv }, ADMIN)));

  assert.equal(doc.format, 2, "the marker is a format bump, and the envelope says so");
  assert.equal(doc.binary, 1);
  assert.ok(isBinaryKvValue(doc.data[key]), "a JPEG/PNG cannot ride as a JSON string");
  assert.deepEqual(decodeKvValue(doc.data[key]), PNG);
  // The key is the checksum, so this is the assertion the live namespace itself makes.
  assert.equal("basset:" + (await sha256Hex(decodeKvValue(doc.data[key]))).slice(0, 40), key);
  // Text values are untouched by the change — still plain strings, still format-1 shaped.
  assert.equal(doc.data.statuses, '{"x":"dev-ready"}');
  assert.equal(doc.bytes, PNG.byteLength + '{"x":"dev-ready"}'.length);
});

test("reading the image as text is what used to destroy it", async () => {
  // The regression, stated as arithmetic rather than as a warning: this is what the old
  // `kv.get(name, "text")` produced, and why no restore could undo it.
  const asText = new TextDecoder("utf-8").decode(PNG);
  const roundTripped = new TextEncoder().encode(asText);
  assert.notEqual(roundTripped.byteLength, PNG.byteLength);
  assert.notEqual(await sha256Hex(roundTripped), await sha256Hex(PNG));
});

test("a value carrying a BOM comes back with its BOM", async () => {
  // Valid UTF-8, so it rides as a string — but a decoder left on its defaults EATS the
  // leading U+FEFF, and a backup one byte-order-mark short is still not the value.
  const withBom = "\uFEFF" + '{"a":1}';
  const kv = fakeKv({ "c:/proto/": { value: withBom } });
  const doc = JSON.parse(await read(await W.adminBackupApi({ COMMENTS: kv }, ADMIN)));
  assert.equal(doc.data["c:/proto/"], withBom);
  assert.deepEqual(decodeKvValue(doc.data["c:/proto/"]), new TextEncoder().encode(withBom));
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
