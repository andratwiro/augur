// The whole loop for a pasted board image: upload → backup → restore → serve. Nothing
// here is a double for the code under test — the real `assetApi` writes the value, the
// real `adminBackupApi` copies it, and the real `assetApi` serves it back. Only KV itself
// is stood in for, and that double stores BYTES, because that is what KV stores.
//
// This exists because the byte-level response snapshot cannot cover it: its corpus pins
// no canvas board, and it runs in ASSETS mode. The failure it would have missed is not a
// changed byte in a response — it is a value that leaves the namespace correct and comes
// back as something else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { decodeKvValue, isBinaryKvValue, sha256Hex } from "../src/kv-codec.mjs";

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };

// A real PNG, and a real JPEG header. Both are what a canvas paste actually stores.
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

// A KV double with real KV's actual contract: values are bytes; `get(key, "text")`
// decodes them (lossily, exactly as the binding does), `get(key, "arrayBuffer")` does not.
function memKv() {
  const store = new Map();
  const bytesOf = (v) => (typeof v === "string" ? new TextEncoder().encode(v)
    : v instanceof Uint8Array ? v : new Uint8Array(v));
  return {
    _store: store,
    async put(key, value, opts) { store.set(key, { bytes: bytesOf(value), metadata: opts && opts.metadata }); },
    async get(key, type) {
      const e = store.get(key);
      if (!e) return null;
      const t = typeof type === "string" ? type : (type && type.type) || "text";
      if (t === "arrayBuffer") return e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength);
      if (t === "json") return JSON.parse(new TextDecoder().decode(e.bytes));
      return new TextDecoder().decode(e.bytes); // lossy on non-UTF-8, like the real thing
    },
    async getWithMetadata(key, type) {
      const e = store.get(key);
      if (!e) return { value: null, metadata: null };
      return { value: await this.get(key, type), metadata: e.metadata || null };
    },
    async list({ cursor, limit = 1000 } = {}) {
      const names = [...store.keys()];
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      return { keys: page.map((name) => ({ name })), list_complete: start + limit >= names.length, cursor: String(start + limit) };
    },
  };
}

const readStream = async (res) => {
  const chunks = [];
  for await (const c of res.body) chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
};

// The KV path: no BUNDLES binding, which is a raw or offline build. That is deliberately
// what this file exercises — it is about the KV BACKUP loop, and an instance whose images
// are in R2 backs them up with the store rather than with the KV document.
const CTX = Object.freeze({ tenantId: "acme" });
const upload = (env, bytes, ct = "image/png") => W.assetApi(
  CTX,
  new Request("https://x.test/__asset", { method: "POST", headers: { "content-type": ct }, body: bytes }),
  new URL("https://x.test/__asset"), env,
);

test("a pasted image survives upload → backup → restore → serve, byte for byte", async () => {
  const env = { COMMENTS: memKv() };

  // 1. the canvas uploads it. The key it lands under is its own checksum.
  const { url } = await (await upload(env, PNG)).json();
  const hash = url.slice("/__asset/".length);
  const key = W.ASSET_PREFIX + hash;
  assert.deepEqual(env.COMMENTS._store.get(key).bytes, PNG, "KV holds the image, raw");

  // 2. an admin takes a backup.
  const doc = JSON.parse(await readStream(await W.adminBackupApi(env, ADMIN)));
  assert.equal(doc.binary, 1);
  assert.ok(isBinaryKvValue(doc.data[key]));

  // 3. a restore replays the document into a fresh namespace. This is the step the bug
  //    made destructive: it wrote a ruin under a key whose name says what belongs there.
  const fresh = { COMMENTS: memKv() };
  for (const [k, v] of Object.entries(doc.data)) {
    const bytes = decodeKvValue(v);
    assert.equal((await sha256Hex(bytes)).slice(0, 40), k.slice(W.ASSET_PREFIX.length),
      "a restore must be able to check the value against the checksum in its key");
    await fresh.COMMENTS.put(k, bytes, { metadata: { ct: "image/png" } });
  }

  // 4. the restored instance serves it.
  const served = await W.assetApi(
    CTX, new Request(`https://x.test/__asset/${hash}`), new URL(`https://x.test/__asset/${hash}`), fresh,
  );
  assert.equal(served.status, 200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);
  assert.equal(served.headers.get("content-type"), "image/png");
});

test("the same loop through a text-mode read is where the image was lost", async () => {
  // The old export, reproduced exactly: read the value as text, put it in the document,
  // write it back. The point is not that it differs — it is that nothing in the loop
  // says so until the key is asked, which is why the copy looked fine for months.
  const env = { COMMENTS: memKv() };
  const { url } = await (await upload(env, PNG)).json();
  const hash = url.slice("/__asset/".length);
  const key = W.ASSET_PREFIX + hash;

  const asText = await env.COMMENTS.get(key, "text"); // what `kv.get(name, "text")` gives
  const restored = new TextEncoder().encode(JSON.parse(JSON.stringify(asText)));
  assert.notDeepEqual(restored, PNG);
  assert.notEqual((await sha256Hex(restored)).slice(0, 40), hash,
    "and the value no longer matches the content-addressed key it would be written under");

  // And the second loss: with the key present, the canvas skips re-uploading the real
  // image, so the ruin is what a re-paste leaves in place.
  const wrecked = { COMMENTS: memKv() };
  await wrecked.COMMENTS.put(key, restored);
  const before = wrecked.COMMENTS._store.get(key).bytes;
  await upload(wrecked, PNG); // the same image, pasted again
  assert.deepEqual(wrecked.COMMENTS._store.get(key).bytes, before,
    "content-addressed means a re-paste is a no-op — the repair is what has to be right");
});
