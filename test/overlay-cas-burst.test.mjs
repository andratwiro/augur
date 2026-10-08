// A burst of edits to ONE comments key all land.
//
// `doOverlay.mutate` is read-rev → change → compare-and-swap, retried when somebody else
// wrote in between. N writers on one key need up to N rounds, because exactly one wins each
// round and every loser re-reads and tries again. With five bare retries and no wait, a burst
// of more than five ops on one page failed deterministically: govocal, 5 Oct 2026 13:59:01Z,
// seven comment moves in 0.9 s (a drag re-anchoring pins), two answered 500
// "overlay: comments// kept changing under 5 attempts", and the reviewer saw
// "couldn't move comment". This pins that a burst of eight lands in full, through the
// real route and the real store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore } from "../src/tenant-do.js";

/** A TENANTS namespace whose objects are real TenantStores over real SQLite. */
function namespace() {
  const objects = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
            db.exec(stmt);
            return [];
          },
        };
        objects.set(id.name, new TenantStore({
          storage: {
            sql,
            transactionSync(cb) {
              db.exec("BEGIN");
              try { const o = cb(); db.exec("COMMIT"); return o; }
              catch (e) { db.exec("ROLLBACK"); throw e; }
            },
          },
          blockConcurrencyWhile: async (f) => f(),
        }, {}));
      }
      const store = objects.get(id.name);
      return { id, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

const CTX = Object.freeze({ tenantId: "acme", USERS: [] });
const PATH = "/prototypes/thing/";
const url = new URL(`https://x.test/__review/api?path=${encodeURIComponent(PATH)}`);
const add = (i) => new Request(url, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ op: "add", thread: { id: `t${i}`, x: i, y: i, messages: [{ author: "Anonymous", body: `m${i}`, at: "now" }] } }),
});

test("eight comment ops on one page at once: every one lands, none answers 500", async () => {
  const env = { TENANTS: namespace() };
  const N = 8;
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    W.reviewApi(CTX, add(i), url, env, undefined).then((r) => r.status, (e) => `threw: ${e.message}`)));
  assert.deepEqual(results, Array(N).fill(200), `a burst of ${N} lost some: ${JSON.stringify(results)}`);
  const final = await (await W.reviewApi(CTX, new Request(url), url, env, undefined)).json();
  assert.deepEqual(final.threads.map((t) => t.id).sort(), Array.from({ length: N }, (_, i) => `t${i}`).sort());
});

test("the same burst straight on the store accessor", async () => {
  // Without the route: the accessor alone, so a future route change cannot hide a regression.
  const env = { TENANTS: namespace() };
  const store = W.overlayFor(env, CTX);
  const N = 12;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    store.mutate("comments", "", "/p/", (cur) => [...(Array.isArray(cur) ? cur : []), i])));
  const v = await store.readKey("comments", "", "/p/");
  assert.deepEqual([...v].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
});
