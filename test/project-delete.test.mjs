// test/project-delete.test.mjs — "Delete forever" where drafts land: the store is the record,
// so a prototype or a whole project comes off the live site in one new version of the space.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { makeEnv, ctxFor, manifestOf, remember, liveNow, ADA } from "./fixtures/unit-env.mjs";

let n = 0;
const A = "/checkout/flow/", B = "/checkout/other/", C = "/onboarding/tour/", P = "/playground/scratch/", L = "/base/button/";
const HELLO = "/checkout/hello-ada/";
const PAGE = remember("<h1>page</h1>");
const ADMIN = { email: "root@example.test", role: "admin" };

async function setup() {
  const t = `project-delete-${++n}`, ctx = ctxFor(t);
  const units = { [A]: { "index.html": PAGE }, [B]: { "index.html": PAGE }, [C]: { "index.html": PAGE }, [P]: { "index.html": PAGE }, [L]: { "index.html": PAGE }, [HELLO]: { "index.html": PAGE } };
  const live = manifestOf(7, units);
  live.files["/checkout/index.html"] = live.files[`${A}index.html`];
  live.routing.unitSources = { [HELLO]: { kind: "welcome" } };
  live.routing.unitOwners = { [A]: "p1", [C]: "p2" };
  const env = await makeEnv({ live });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  W.__setConfigTestState({ manifests: null });
  return { ctx, env };
}
const del = (ctx, env, body, me = ADMIN, method = "POST", headers = { "content-type": "application/json", origin: "https://x.test" }) => W.deleteApi(ctx, new Request("https://x.test/__delete", {
  method, ...(method === "POST" ? { headers, body: JSON.stringify(body) } : {}),
}), env, me);
const paths = (env) => Object.keys(liveNow(env).files);

test("a project: every listed prototype goes in one version, and nothing outside the folder", async () => {
  const { ctx, env } = await setup();
  const r = await del(ctx, env, { space: "alpha", path: "checkout" });
  assert.equal(r.status, 202);
  const d = await r.json();
  assert.equal(d.prototypes, 2);
  assert.equal(d.store.removed, 3, "two units and the folder's stored index");
  const live = liveNow(env);
  assert.equal(live.version, 8);
  assert.equal(live.publishedBy, `delete by ${ADMIN.email}`);
  assert.deepEqual(paths(env).sort(), [`${L}index.html`, `${HELLO}index.html`, `${C}index.html`, `${P}index.html`].sort());
  assert.deepEqual(live.routing.publicPrefixes.sort(), [L, HELLO, C, P].sort());
  assert.deepEqual(live.routing.unitOwners, { [C]: "p2" }, "no owner left behind for a unit that is gone");
  assert.ok(env.BUNDLES.store.has("spaces/alpha/versions/8.json"), "a version a rollback can step back over");
  W.__setConfigTestState({ manifests: null });
  const root = await (await W.derivedPage(ctx, env, new URL("https://x.test/"))).text();
  assert.doesNotMatch(root, /data-del-path="checkout"/, "off the gallery on the next request");
  assert.match(root, /data-del-path="onboarding"/);
});

test("a project that is not one is refused, and nothing is written", async () => {
  const { ctx, env } = await setup();
  for (const path of ["playground", "base", "components", "skills", "nowhere"]) {
    const r = await del(ctx, env, { space: "alpha", path });
    assert.equal(r.status, 404, path);
  }
  for (const path of ["_engine", "Checkout", "checkout/", "../checkout", "checkout/flow", ""]) {
    const r = await del(ctx, env, { space: "alpha", path });
    assert.equal(r.status, 400, path);
  }
  assert.equal((await del(ctx, env, { space: "beta", path: "checkout" })).status, 400, "an unknown space is never aimed at the default one");
  assert.equal((await del(ctx, env, { space: "alpha", path: "checkout" }, ADMIN, "GET")).status, 405);
  assert.equal(liveNow(env).version, 7);
  assert.equal(paths(env).length, 7);
});

test("a workspace that declares its spaces: same answer, and a second space is not the root", async () => {
  const { ctx, env } = await setup();
  const declared = { ...ctx, SPACES: [{ id: "alpha", default: true }, { id: "gamma" }] };
  assert.equal((await del(declared, env, { space: "gamma", path: "checkout" })).status, 404, "gamma publishes no such project");
  assert.equal(liveNow(env).version, 7);
  assert.equal((await del(declared, env, { space: "alpha", path: "checkout" })).status, 202);
  assert.ok(!paths(env).some((p) => p.startsWith("/checkout/f")));
});

test("one prototype, with no repo channel: it comes off the store", async () => {
  const { ctx, env } = await setup();
  const r = await del(ctx, env, { space: "alpha", path: "checkout/prototypes/flow" });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).store.removed, 1);
  assert.ok(!paths(env).includes(`${A}index.html`));
  assert.ok(paths(env).includes(`${B}index.html`), "its neighbour stays");
  assert.equal((await del(ctx, env, { space: "alpha", path: "checkout/prototypes/flow" })).status, 404, "a second delete finds nothing");
  assert.equal(liveNow(env).version, 8);
});

test("where drafts are not served, the store is not the record: 501 as before", async () => {
  const { ctx, env } = await setup();
  const plain = { ...env, UNITS: undefined };
  assert.equal((await del(ctx, plain, { space: "alpha", path: "checkout" })).status, 501);
  assert.equal((await del(ctx, plain, { space: "alpha", path: "checkout/prototypes/flow" })).status, 501);
  // A repo channel does not make a project deletable there: the repo workflow removes one prototype.
  const wired = { ...plain, DELETE_DISPATCH_URL: "https://dispatch.test/x", DELETE_DISPATCH_TOKEN: "t" };
  assert.equal((await del(ctx, wired, { space: "alpha", path: "checkout" })).status, 501);
  assert.equal(liveNow(env).version, 7);
});

test("only this site's own page may ask: another origin, no origin and a form body are refused before anything is read", async () => {
  const { ctx, env } = await setup();
  const body = { space: "alpha", path: "checkout" };
  const json = "application/json";
  for (const [headers, status] of [
    [{ "content-type": json, origin: "https://demo.x.test" }, 403],
    [{ "content-type": json, origin: "https://x.test.evil.example" }, 403],
    [{ "content-type": json, origin: "http://x.test" }, 403],
    [{ "content-type": json, origin: "null" }, 403],
    [{ "content-type": json }, 403],
    [{ "content-type": "text/plain", origin: "https://x.test" }, 415],
    [{ "content-type": "application/x-www-form-urlencoded", origin: "https://x.test" }, 415],
    [{ "content-type": "application/jsonp", origin: "https://x.test" }, 415],
    [{ origin: "https://x.test" }, 415],
  ]) {
    const r = await del(ctx, env, body, ADMIN, "POST", headers);
    assert.equal(r.status, status, JSON.stringify(headers));
  }
  assert.equal(liveNow(env).version, 7, "nothing was deleted");
  assert.equal((await del(ctx, env, body, ADMIN, "POST", { "content-type": "application/json; charset=utf-8", origin: "https://x.test" })).status, 202);
});

test("one prototype: a library page, a skill and a welcome page are not prototypes, whatever the path says", async () => {
  const { ctx, env } = await setup();
  for (const path of ["base/prototypes/button", "components/prototypes/x", "skills/prototypes/x"]) {
    assert.equal((await del(ctx, env, { space: "alpha", path })).status, 400, path);
  }
  assert.equal((await del(ctx, env, { space: "alpha", path: "checkout/prototypes/hello-ada" })).status, 404, "a welcome page is not listed, so not deletable");
  assert.equal((await del(ctx, env, { space: "alpha", path: "checkout/prototypes/nowhere" })).status, 404);
  assert.equal(liveNow(env).version, 7);
  assert.equal(paths(env).length, 7);
  assert.equal((await del(ctx, env, { space: "alpha", path: "playground/scratch" })).status, 202, "the playground still is");
  // With a repo channel the shape check runs before the dispatch.
  const wired = { ...env, DELETE_DISPATCH_URL: "https://dispatch.test/x", DELETE_DISPATCH_TOKEN: "t" };
  assert.equal((await del(ctx, wired, { space: "alpha", path: "base/prototypes/button" })).status, 400);
});

test("one prototype in a space that is not the default: its own unit goes, by the path the space serves it under", async () => {
  const t = `project-delete-${++n}`, ctx = { ...ctxFor(t), SPACES: [{ id: "main", default: true }, { id: "alpha" }] };
  const SA = "/alpha/checkout/flow/", SB = "/alpha/checkout/other/", SH = "/alpha/checkout/hello-ada/";
  const live = manifestOf(7, { [SA]: { "index.html": PAGE }, [SB]: { "index.html": PAGE }, [SH]: { "index.html": PAGE } });
  live.space.default = false;
  live.routing.unitSources = { [SH]: { kind: "welcome" } };
  const env = await makeEnv({ live });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  W.__setConfigTestState({ manifests: null });
  assert.equal((await del(ctx, env, { space: "alpha", path: "checkout/prototypes/nowhere" })).status, 404);
  assert.equal((await del(ctx, env, { space: "alpha", path: "checkout/prototypes/hello-ada" })).status, 404, "a welcome page stays");
  assert.equal(liveNow(env).version, 7);
  const r = await del(ctx, env, { space: "alpha", path: "checkout/prototypes/flow" });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).store.removed, 1);
  assert.deepEqual(paths(env).sort(), [`${SB}index.html`, `${SH}index.html`].sort());
  assert.equal((await del(ctx, env, { space: "beta", path: "checkout/prototypes/other" })).status, 400, "a space nobody declared");
});
