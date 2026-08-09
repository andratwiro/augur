// The realtime worker owns the authoritative board documents and sits on a public
// workers.dev URL. The admin-only-space seal lives in the PAGES worker, so a direct
// connection here would bypass it — hence the shared secret. These tests never open a
// WebSocket: a request that gets past the guard reaches the Upgrade check and answers
// 426, and a request that reaches the room throws through the stub binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../realtime/src/index.js";

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

test("with no secret configured the worker behaves exactly as before", async () => {
  const res = await worker.fetch(roomReq(), envWith(undefined));
  assert.equal(res.status, 426, "an instance that has not provisioned the secret keeps working");
});

test("the service banner stays open (health checks, no secret needed)", async () => {
  const res = await worker.fetch(new Request("https://rt.example/"), envWith("s3cret"));
  assert.equal(res.status, 200);
});
