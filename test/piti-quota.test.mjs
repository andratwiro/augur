// The pal's remark poll is a KV READ per hit against the instance's daily quota,
// and stale open tabs keep whatever cadence their loaded piti.js shipped with —
// a worker-side cache is the only lever that reaches them (2026-08-20 quota
// outage). These pin: repeat GETs inside the TTL cost one KV read; a remark
// write busts so delivery stays snappy; a throwing KV degrades to the last-read
// (or empty) list, never a 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    store,
    gets: 0,
    async get(k) { kv.gets += 1; return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
  return kv;
}
const throwingKV = () => ({
  async get() { throw new Error("KV get() limit exceeded for the day."); },
  async put() { throw new Error("KV put() limit exceeded for the day."); },
});
const KEY = "sekrit";
const envWith = (kv) => ({ COMMENTS: kv, REVIEW_EXPORT_KEY: KEY });
// The workspace whose queue these polls are about. The cache is keyed by workspace, so
// the poll and the write that busts it have to name the same one — which is what a real
// request does, both routes taking the id the resolver answered with.
const TENANT = "workspace-under-test";
// pitiApi takes the CONTEXT now: the overlay accessor it reads through decides between
// the workspace's own store and the instance's KV, and the context is where the
// workspace's identity lives.
const TENANT_CTX = Object.freeze({ tenantId: TENANT });
const getUrl = new URL("https://example.test/__piti?type=remarks&path=%2Fx%2Fp%2F&since=0");
const getReq = () => new Request(getUrl);
const poll = (kv) => W.pitiApi(TENANT_CTX, getReq(), getUrl, envWith(kv));
const postRemark = (kv, text) => W.pitiApi(TENANT_CTX, new Request("https://example.test/__piti", {
  method: "POST", headers: { "content-type": "application/json", "X-Review-Key": KEY },
  body: JSON.stringify({ type: "remark", path: "/x/p/", text }),
}), new URL("https://example.test/__piti"), envWith(kv));

// Order matters: the first test needs the cold-cache state of a fresh process.
test("a throwing KV with nothing cached answers an empty list, not a 500", async () => {
  const res = await poll(throwingKV());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { remarks: [] });
});

test("repeat polls inside the TTL cost one KV read; a remark write busts", async () => {
  const kv = memKV();
  await postRemark(kv, "first quip");
  const before = kv.gets;
  const r1 = await poll(kv);
  assert.equal((await r1.json()).remarks.length, 1);
  const r2 = await poll(kv);
  assert.equal((await r2.json()).remarks.length, 1);
  assert.equal(kv.gets, before + 1, "second poll rides the cache");
  await postRemark(kv, "second quip");
  const r3 = await poll(kv);
  assert.equal((await r3.json()).remarks.length, 2, "a fresh remark is visible at once");
});

test("a throwing KV serves the last-read list rather than erroring", async () => {
  const kv = memKV();
  await postRemark(kv, "survivor");
  await poll(kv); // cache filled
  await postRemark(kv, "buster"); // bust: the next poll must re-read...
  const res = await poll(throwingKV()); // ...and it throws
  assert.equal(res.status, 200);
  assert.ok((await res.json()).remarks.length >= 1, "stale list still serves");
});
