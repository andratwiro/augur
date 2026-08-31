// The Settings panel's "Custom URL" field reads this — a claimed workspace shows its
// real hostname, an unclaimed one shows nothing, and only an admin may ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed" };

const SUFFIX = ".example.com";

/** Same shape as test/tenant-claim.test.mjs's suspensionNamespace — a TENANTS
 * namespace whose objects answer /suspension with a fixed doc. */
function suspensionNamespace(docs) {
  return {
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      return {
        id,
        async fetch(url) {
          const doc = docs[id.name] || { suspended: false, moved: false, canonicalHost: null };
          if (String(url).endsWith("/suspension")) return Response.json(doc);
          return Response.json({});
        },
      };
    },
  };
}

test("only an admin may ask", async () => {
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: suspensionNamespace({}) };
  for (const who of [null, EDITOR]) {
    const res = await W.adminCustomDomainApi("some-workspace", env, who);
    assert.equal(res.status, 403, `${who ? who.email : "anonymous"} must not read this`);
  }
});

test("a claimed workspace reports its canonical hostname", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "claimed-ws": { suspended: false, moved: false, canonicalHost: `demo${SUFFIX}` },
    }),
  };
  const res = await W.adminCustomDomainApi("claimed-ws", env, ADMIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: true, hostname: `demo${SUFFIX}` });
});

test("an unclaimed workspace reports claimed:false, hostname:null", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "plain-ws": { suspended: false, moved: false, canonicalHost: null },
    }),
  };
  const res = await W.adminCustomDomainApi("plain-ws", env, ADMIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: false, hostname: null });
});

test("a single-workspace instance (no TENANTS binding) reports claimed:false", async () => {
  const res = await W.adminCustomDomainApi("whatever", {}, ADMIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: false, hostname: null });
});
