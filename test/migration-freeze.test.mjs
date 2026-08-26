// Read-only while a workspace is being moved.
//
// `MIG-cutover-freeze`. Moving a workspace is export → verify → cut the hostname over, and
// anything written to the OLD instance inside that window goes to a copy nobody will ever
// read again. Not lost noisily — lost the way a comment is lost when somebody posts it,
// watches it appear, and comes back tomorrow to a page that never had it.
//
// ONLY WRITES STOP, which is the whole reason this exists rather than pulling the route.
// Pulling is simpler and takes READS down too: on a real workspace the copy and the
// verification are minutes, and minutes of dark site looks like an outage to everybody who
// is not migrating. Here the site stays up, a reader sees what was there, and somebody who
// tries to change something is TOLD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import worker from "../src/_worker.js";

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
const CTX = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "freezing" });
const req = (method, path) => new Request(`https://x.test${path}`, {
  method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }),
});

// ── what a freeze closes, and what it must not ───────────────────────────────

test("EVERY WRITE PATH IS CLOSED, and every read is untouched", async () => {
  // The table is what makes "what does a freeze stop" answerable by reading one list, so
  // the test walks the same list rather than restating it.
  for (const p of W.FROZEN_WRITES) {
    const path = p.endsWith("/") ? `${p}something` : p;
    assert.equal(W.isFrozenWrite(req("POST", path), new URL(`https://x.test${path}`)), true, `POST ${path}`);
    assert.equal(W.isFrozenWrite(req("PUT", path), new URL(`https://x.test${path}`)), true, `PUT ${path}`);
    assert.equal(W.isFrozenWrite(req("GET", path), new URL(`https://x.test${path}`)), false,
      `GET ${path} would be frozen — a freeze that blocks reads is a DNS pull with extra steps`);
  }
});

test("SIGNING IN IS NOT FROZEN, because somebody has to watch the migration", async () => {
  for (const path of ["/__auth", "/__logout", "/", "/prototypes/thing/"]) {
    assert.equal(W.isFrozenWrite(req("POST", path), new URL(`https://x.test${path}`)), false, path);
  }
});

test("and the routes that LIFT a freeze can never be frozen by one", async () => {
  // The deadlock this avoids is small and total: freeze the instance, then find that the
  // only way to unfreeze it is a request the freeze refuses.
  for (const path of ["/__publish/_state/freeze", "/__publish/_state/export", "/__publish/_state/status"]) {
    assert.equal(W.isFrozenWrite(req("POST", path), new URL(`https://x.test${path}`)), false, path);
  }
  // While the ordinary publish routes ARE frozen — that is the point.
  assert.equal(W.isFrozenWrite(req("POST", "/__publish/alpha/commit"), new URL("https://x.test/__publish/alpha/commit")), true);
});

// ── through the real router ──────────────────────────────────────────────────

const run = async (env, method, path) => {
  const quiet = console.log; console.log = () => {};
  try {
    return await worker.fetch(new Request(`https://x.test${path}`, {
      method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }),
    }), env, {});
  } finally { console.log = quiet; }
};

function instance(frozen) {
  const kv = memKv(frozen ? { [W.FREEZE_KEY]: JSON.stringify({ at: "2026-08-26T10:00:00.000Z", reason: "being moved" }) } : {});
  return {
    COMMENTS: kv,
    BUNDLES: { async get() { return null; }, async put() {}, async head() { return null; },
      async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; } },
    ASSETS: {
      fetch: async (r) => {
        const p = new URL(typeof r === "string" ? r : r.url).pathname;
        if (p === "/__config/instance.json") {
          return new Response(JSON.stringify({ users: [], tenantId: "freezing" }), { headers: { "content-type": "application/json" } });
        }
        if (p === "/__config/routing.json") {
          return new Response(JSON.stringify({ spaces: [{ id: "alpha", default: true }], publicPrefixes: [] }), { headers: { "content-type": "application/json" } });
        }
        return new Response("nf", { status: 404 });
      },
    },
  };
}

test("A WRITE DURING A FREEZE IS VISIBLY REFUSED, not accepted and dropped", async () => {
  // The item's VERIFY. "Visibly" is the word that matters: a 200 that goes nowhere is the
  // failure mode, not a 503.
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const env = instance(true);
  const res = await run(env, "POST", "/__board?path=/b/one/");
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "frozen");
  assert.equal(body.reason, "being moved");
  assert.equal(body.since, "2026-08-26T10:00:00.000Z");
  assert.match(body.message, /Nothing you send now would arrive/);
  assert.equal(res.headers.get("retry-after"), "60");
  W.__setTenantTestState({ memo: null });
});

test("and a READ during the same freeze is served normally", async () => {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const env = instance(true);
  const res = await run(env, "GET", "/__board?path=/b/one/");
  assert.notEqual(res.status, 503, "a read was frozen");
  W.__setTenantTestState({ memo: null });
});

test("an unfrozen instance pays nothing for the mechanism on a read", async () => {
  W.__setTenantTestState({ memo: null });
  W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0 });
  const env = instance(false);
  let reads = 0;
  const real = env.COMMENTS.get.bind(env.COMMENTS);
  env.COMMENTS.get = (k) => { if (k === W.FREEZE_KEY) reads++; return real(k); };
  await run(env, "GET", "/__board?path=/b/one/");
  assert.equal(reads, 0, "a read consulted the freeze key");
  W.__setTenantTestState({ memo: null });
});

// ── freezing and thawing ─────────────────────────────────────────────────────

test("FREEZING IS IDEMPOTENT, and thawing reports how long it lasted", async () => {
  // The duration is the number a migration publishes. Somebody planned around it, and
  // "about ten minutes" from memory is not a number.
  const env = { COMMENTS: memKv() };
  const on = await W.setFreeze(CTX, env, { on: true, reason: "moving", by: "ci" });
  assert.equal(on.frozen, true);
  assert.equal(on.reason, "moving");

  // Freezing again keeps the ORIGINAL timestamp — otherwise every retry of a migration
  // script would reset the clock the duration is measured from.
  await new Promise((r) => setTimeout(r, 5));
  const again = await W.setFreeze(CTX, env, { on: true, reason: "moving again" });
  assert.equal(again.since, on.since, "re-freezing restarted the clock");
  assert.equal(again.reason, "moving");

  const off = await W.setFreeze(CTX, env, { on: false });
  assert.equal(off.frozen, false);
  assert.ok(off.durationMs >= 0 && off.durationMs < 60_000);
  assert.equal(env.COMMENTS.store.has(W.FREEZE_KEY), false);
});

test("thawing something that was not frozen is not an error", async () => {
  // A migration script that dies after the cutover is re-run from the top, and the thaw at
  // the end must not be the thing that fails.
  const env = { COMMENTS: memKv() };
  const off = await W.setFreeze(CTX, env, { on: false });
  assert.equal(off.ok, true);
  assert.equal(off.frozen, false);
  assert.equal(off.durationMs, null);
});

test("with no store it says so rather than reporting a freeze it did not set", async () => {
  assert.deepEqual(await W.setFreeze(CTX, {}, { on: true }), { ok: false, reason: "no-store" });
  assert.equal(await W.readFreeze(CTX, {}), null);
});

test("A FAILING READ KEEPS THE LAST ANSWER, so a freeze does not fail open on a blip", async () => {
  // The direction this is allowed to be wrong in. A thaw arriving one tick late costs
  // nothing; a freeze evaporating for a tick is a write into a copy nobody will read.
  const ctx = Object.freeze({ ...CTX, tenantId: "blip" });
  const env = { COMMENTS: memKv({ [W.FREEZE_KEY]: JSON.stringify({ at: "2026-08-26T10:00:00.000Z", reason: "moving" }) }) };
  assert.ok(await W.readFreeze(ctx, env), "the fixture is not frozen");
  env.COMMENTS.get = async () => { throw new Error("kv is having a moment"); };
  // Force the cached entry past its tick.
  await new Promise((r) => setTimeout(r, 0));
  const still = await W.readFreeze(ctx, env);
  assert.ok(still, "a KV blip thawed the workspace");
});
