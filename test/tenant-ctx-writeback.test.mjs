// The module config slot belongs to the config loader, and to nothing else.
//
// `TENANT_CTX` is one slot holding one workspace's whole config. `loadConfig` owns it:
// it decides which workspace is in it, when the tick expires, and when a failed read is
// still worth serving from. Any OTHER writer has to be right about a question it cannot
// answer — "is the slot still the workspace I was handed?" — and it has to be right
// about it at a moment it does not control, because every such writer sits after awaits.
//
// `adminUsersApi` used to be that other writer. Twice (invite/remove via `commitRoster`,
// and the role change) it re-derived the roster and wrote it back to the slot, guarded by
// `users === tctx.USERS`. That guard compares the PARAMETER to the context the request
// was handed — it says "I am answering for the live list", which is a true and useful
// thing to know — but it says nothing about what is in the module slot NOW. Both writes
// sit after several awaits (`readRoster`, `kv.put`, `revokeSecret`, `mintInvite`,
// `readRoles`, …), and a request for another workspace that runs during any one of them
// leaves ITS context in the slot. The write-through then stamped one workspace's roster
// onto another workspace's context: not a stale list, the neighbour's list, including its
// roles — which is an authorization answer, not a display one.
//
// WHY THIS IS A TEST AND NOT A NOTE. `resolveTenant` is static today, so `worker.fetch`
// can only ever put one workspace in the slot and the sweep in tenant-route-sweep.test.mjs
// cannot produce the interleaving. That is a property of the resolver, not of this code:
// the two functions here (`loadConfig`, `adminUsersApi`) each already take their workspace
// as a parameter, so the interleaving is constructible at the seam where the defect lives,
// which is where it has to be pinned. Host-based resolution changes the resolver body and
// nothing else — the day it lands, this file is what says the admin path was already safe.
//
// The fix is not a better comparison. It is that the write-through was never observable:
// the two statements that follow it — `bustRosterOverlay(tctx.tenantId)` and `cfgAt = 0` —
// send the very next request for that workspace back to KV for the six overlay documents
// and rebuild `USERS` from what it finds, overwriting whatever was written through. So the
// slot write bought nothing and could cost a neighbour's roster. The last case below pins
// the property that made removing it safe, so nobody re-adds the write to restore an
// immediacy that was already coming from the bust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { __testables as W } from "../src/_worker.js";

function memKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
function memR2(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
    async head(k) { return store.has(k) ? {} : null; },
  };
}

// A workspace whose config names exactly one person, so "whose roster is this" is a
// one-glance question at every assertion below.
function workspace(email, name) {
  return {
    GV_ASSET_SOURCE: "r2",
    BUNDLES: memR2({
      "config/instance.json": JSON.stringify({ users: [{ email, name, role: "admin" }] }),
    }),
    COMMENTS: memKV(),
  };
}
const emails = () => W.__usersNow().map((u) => u.email).sort();

const usersUrl = new URL("https://x.test/__admin/users");
const adminReq = (body) => new Request("https://x.test/__admin/users", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Load a workspace's config into the slot, cold — a fresh tick and a fresh overlay cache,
// so the answer is that workspace's own documents and not the previous case's.
async function loadCold(tenantId, env) {
  W.__setConfigTestState({ cfgAt: 0, roster: null });
  const ctx = await W.loadConfig(tenantId, env);
  assert.ok(ctx, `${tenantId} has no context`);
  return ctx;
}

test("an admin write in one workspace cannot land on another workspace's context", async () => {
  const alpha = workspace("alpha-admin@x.test", "Alpha Admin");
  const beta = workspace("beta-admin@x.test", "Beta Admin");

  const alphaCtx = await loadCold("alpha", alpha);
  assert.deepEqual(alphaCtx.USERS.map((u) => u.email), ["alpha-admin@x.test"]);

  // The interleaving, at the one await we can hold open without touching the code under
  // test: alpha's invite is mid-flight, writing its roster document, when a request for
  // beta resolves and loads beta's config into the slot. Everything after that point in
  // alpha's handler runs with a neighbour's context in module scope.
  let swapped = false;
  const realPut = alpha.COMMENTS.put.bind(alpha.COMMENTS);
  alpha.COMMENTS.put = async (k, v) => {
    if (!swapped) {
      swapped = true;
      await loadCold("beta", beta);
    }
    return realPut(k, v);
  };

  const me = { email: "alpha-admin@x.test", name: "Alpha Admin", role: "admin" };
  const res = await W.adminUsersApi(
    alphaCtx, adminReq({ op: "invite", email: "invited@alpha.test", name: "Invited" }),
    usersUrl, alpha, me,
  );
  assert.equal(res.status, 200, "alpha's invite was refused");
  assert.ok(swapped, "the interleaving never happened — the test proves nothing");

  // The slot still holds BETA, untouched. Not "the two lists differ": beta's own list,
  // exactly as beta's own documents describe it.
  assert.deepEqual(emails(), ["beta-admin@x.test"], "alpha's roster landed on beta's context");

  // And the write really did happen — in alpha's KV, where it belongs.
  const roster = JSON.parse(alpha.COMMENTS.store.get("users:roster"));
  assert.ok(roster.add["invited@alpha.test"], "the invite did not reach alpha's store");
  assert.equal(beta.COMMENTS.store.has("users:roster"), false, "beta's store was written to");
});

test("a role change in one workspace cannot land on another workspace's context", async () => {
  // The second write site, which is the same shape spelled out inline rather than through
  // commitRoster: it re-derives USERS from the roles document it just wrote.
  const alpha = workspace("alpha-admin@x.test", "Alpha Admin");
  const beta = workspace("beta-admin@x.test", "Beta Admin");
  alpha.COMMENTS.store.set("users:roster", JSON.stringify({
    add: { "member@alpha.test": { email: "member@alpha.test", name: "Member", role: "editor" } },
    remove: [],
  }));

  const alphaCtx = await loadCold("alpha", alpha);
  assert.deepEqual(alphaCtx.USERS.map((u) => u.email).sort(),
    ["alpha-admin@x.test", "member@alpha.test"]);

  let swapped = false;
  const realPut = alpha.COMMENTS.put.bind(alpha.COMMENTS);
  alpha.COMMENTS.put = async (k, v) => {
    if (!swapped && k === "users:roles") {
      swapped = true;
      await loadCold("beta", beta);
    }
    return realPut(k, v);
  };

  const me = { email: "alpha-admin@x.test", name: "Alpha Admin", role: "admin" };
  const res = await W.adminUsersApi(
    alphaCtx, adminReq({ op: "role", email: "member@alpha.test", role: "viewer" }),
    usersUrl, alpha, me,
  );
  assert.equal(res.status, 200, "alpha's role change was refused");
  assert.ok(swapped, "the interleaving never happened — the test proves nothing");
  assert.deepEqual(emails(), ["beta-admin@x.test"], "alpha's roster landed on beta's context");
});

test("the roster bust, not a slot write, is what makes an admin write visible next request", async () => {
  // Why dropping the write-through costs nothing. With no interleaving at all, the
  // isolate's next request for this workspace sees the invite — because `cfgAt = 0` forces
  // a config tick and `bustRosterOverlay` sends that tick back to KV for the six overlay
  // documents. The slot write never survived this reload anyway; it was overwritten by it.
  const alpha = workspace("alpha-admin@x.test", "Alpha Admin");
  const alphaCtx = await loadCold("alpha", alpha);

  const me = { email: "alpha-admin@x.test", name: "Alpha Admin", role: "admin" };
  const res = await W.adminUsersApi(
    alphaCtx, adminReq({ op: "invite", email: "invited@alpha.test", name: "Invited" }),
    usersUrl, alpha, me,
  );
  assert.equal(res.status, 200);

  // No clock poking: whatever the handler left behind is what the next request rides.
  await W.loadConfig("alpha", alpha);
  assert.deepEqual(emails(), ["alpha-admin@x.test", "invited@alpha.test"],
    "the next request did not see the invite");
});

test("the module config slot has exactly one owner in the request path", () => {
  // The invariant the two cases above are instances of, stated once over the source so a
  // NEW writer is a red test rather than a review someone has to remember to do. Removing
  // the two admin write-throughs and un-branding the /__config refusal (which read the
  // slot to render a neighbour's 404) leaves `loadConfig` as the only function in the
  // request path that touches `TENANT_CTX` at all — every other name below is a test seam
  // that exists so a unit test can seed a workspace without a config load.
  //
  // Adding a name here is not forbidden; it is the point. It means someone deliberately
  // gave the slot a second owner, and had to say so in a file that explains why the last
  // second owner leaked a roster across workspaces.
  const OWNERS = new Set([
    "TENANT_CTX",           // the declaration itself
    "loadConfig",           // the owner: the tick, the swap, keep-last-good, fail-closed
    "applyInstance",        // test seam — seed a workspace from an instance document
    "applyDerivedRouting",  // test seam — seed routing from a set of manifests
    "__setChromeTestState", // test seam — seed the chrome pointer + workspace list
    "__usersNow",           // test hook — read back what the config tick settled on
  ]);
  const src = readFileSync(fileURLToPath(new URL("../src/_worker.js", import.meta.url)), "utf8");
  const found = new Map(); // owner -> first line number
  let owner = null;
  src.split("\n").forEach((line, i) => {
    // Top-level declarations only: this file indents everything nested, so a name at
    // column 0 is the enclosing function of every line until the next one.
    const decl = /^(?:export )?(?:async )?function (\w+)/.exec(line)
      || /^(?:export )?(?:const|let|var) (\w+)\s*=/.exec(line);
    if (decl) owner = decl[1];
    if (line.trim().startsWith("//")) return;   // prose about the slot is not a use of it
    if (!line.includes("TENANT_CTX")) return;
    if (!found.has(owner)) found.set(owner, i + 1);
  });
  const strangers = [...found].filter(([name]) => !OWNERS.has(name));
  assert.deepEqual(strangers, [],
    "a new function reaches for the module config slot — see this file's header before allowing it");
  // …and the owner is still there, so a rename cannot pass this by emptying it.
  assert.ok(found.has("loadConfig"), "loadConfig no longer touches the slot — did it move?");
});
