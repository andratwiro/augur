// The realtime worker owns the authoritative board documents and sits on a public
// workers.dev URL. The admin-only-space seal lives in the PAGES worker, so a direct
// connection here would bypass it — hence the shared secret. These tests never open a
// WebSocket: a request that gets past the guard reaches the Upgrade check and answers
// 426, and a request that reaches the room throws through the stub binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { BoardRoom } from "../realtime/src/index.js";

const roomReq = (headers = {}) => new Request("https://rt.example/room?path=/x/", { headers });
// Reaching ROOMS means the guard let the request through — the stub makes that loud.
const envWith = (secret) => ({
  RT_SHARED_SECRET: secret,
  ROOMS: { idFromName() { throw new Error("reached the room"); } },
});

test("a room request without the shared secret is refused", async () => {
  const res = await worker.fetch(roomReq(), envWith("s3cret"));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("a wrong shared secret is refused", async () => {
  const res = await worker.fetch(roomReq({ "x-augur-rt": "nope-wrong-length" }), envWith("s3cret"));
  assert.equal(res.status, 403);
});

test("a wrong secret of the SAME LENGTH is refused (no length-only check)", async () => {
  const res = await worker.fetch(roomReq({ "x-augur-rt": "s3creT" }), envWith("s3cret"));
  assert.equal(res.status, 403);
});

test("the right secret gets past the guard to the upgrade check", async () => {
  const res = await worker.fetch(roomReq({ "x-augur-rt": "s3cret" }), envWith("s3cret"));
  assert.equal(res.status, 426, "guard passed; no Upgrade header, so it stops here");
});

// Fail CLOSED when unprovisioned. The old behaviour — skip the guard entirely when
// RT_SHARED_SECRET is unset — meant a new instance launched wide open by default and
// nothing ever said so: rooms answered normally, so there was no symptom to notice.
// 501 matches what the Pages-side rtProxy already answers when realtime is
// unconfigured, so "not set up" reads the same from both ends.
test("with no secret configured the worker refuses every room request", async () => {
  const res = await worker.fetch(roomReq(), envWith(undefined));
  assert.equal(res.status, 501, "an unprovisioned instance must not serve rooms");
  assert.deepEqual(await res.json(), { error: "realtime-not-configured" });
});

test("an unprovisioned worker refuses even a caller that sends a header", async () => {
  const res = await worker.fetch(roomReq({ "x-augur-rt": "anything" }), envWith(undefined));
  assert.equal(res.status, 501, "there is nothing to compare against — no header can pass");
});

test("an empty-string secret counts as unprovisioned, not as a secret to match", async () => {
  const res = await worker.fetch(roomReq({ "x-augur-rt": "" }), envWith(""));
  assert.equal(res.status, 501, "a blank secret must never be a satisfiable one");
});

test("the service banner stays open (health checks, no secret needed)", async () => {
  const res = await worker.fetch(new Request("https://rt.example/"), envWith("s3cret"));
  assert.equal(res.status, 200);
});

// ---- the session wire: an expired countdown is not state --------------------
// Clients announce 00:00 locally (the room broadcasts nothing at that instant) and revert
// to idle, holding the duration that ran. A joiner handed a frozen 00:00 would therefore
// see an alarm the room it is joining stopped showing — and would sit on it forever.
const wire = (timer) => BoardRoom.prototype.sessionWire.call(null, { timer, music: null }).timer;

test("a running countdown wires with the time left", () => {
  const t = wire({ running: true, remain: 60000, total: 300000, at: Date.now() - 1000 });
  assert.equal(t.running, true);
  assert.equal(t.total, 300000);
  assert.ok(t.remain > 58000 && t.remain <= 59000, `~59s left, got ${t.remain}`);
});

test("a paused countdown keeps its remaining time and stays paused", () => {
  const t = wire({ running: false, remain: 42000, total: 300000, at: Date.now() - 10000 });
  assert.deepEqual({ running: t.running, remain: t.remain }, { running: false, remain: 42000 });
});

test("an EXPIRED countdown wires as no timer at all, never as a frozen 00:00", () => {
  assert.equal(wire({ running: true, remain: 5000, total: 300000, at: Date.now() - 60000 }), null);
  assert.equal(wire({ running: false, remain: 0, total: 300000, at: Date.now() }), null);
});
