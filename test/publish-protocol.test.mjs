// The protocol floor exists because an old client does not merely miss features — it
// silently skips guards it has never heard of. A pre-3 client sends no `baseVersion`,
// so the revert guard has nothing to compare and degrades to "allowed". These tests
// pin the two halves that make that safe: the floor is OFF unless someone sets it, and
// when it is set it refuses BEFORE the write rather than after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { CLIENT_PROTOCOL } from "../scripts/lib/store.mjs";
import { readFileSync } from "node:fs";

// applyInstance is how a deploy.config.json value reaches the worker's module scope.
const withFloor = (n) => W.applyInstance({ users: [], minClientProtocol: n });

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })), truncated: false };
    },
  };
}

const LIVE = {
  id: "alpha", version: 4, format: 1,
  space: { id: "alpha", default: true },
  source: { sha: "abc123", dirty: false, actor: "someone" },
  files: { "/toolkit/w/index.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  routing: { publicPrefixes: ["/toolkit/w/"], versionMap: {} },
};
const NEXT = {
  id: "alpha", format: 1, files: LIVE.files,
  space: { id: "alpha", default: true },
  routing: { publicPrefixes: ["/toolkit/w/"], versionMap: {} },
};
const envWithLive = () => ({
  BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(LIVE) }),
  PUBLISH_BOOTSTRAP_TOKEN: "tok",
});
const commit = (env, manifest) => W.publishApi(
  new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/alpha/commit"),
  env);

test("with no floor set, a client that declares nothing still publishes", async () => {
  W.applyInstance({ users: [] });
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, baseVersion: 4 });
  assert.equal(res.status, 200, "a knob nobody set must never be why a publish fails");
  assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 5);
});

test("with a floor set, a client below it is refused 426 and NOTHING is written", async () => {
  withFloor(3);
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, baseVersion: 4, clientProtocol: 2 });
  assert.equal(res.status, 426);
  const body = await res.json();
  assert.equal(body.error, "cli-outdated");
  assert.equal(body.minProtocol, 3);
  assert.equal(body.clientProtocol, 2);
  assert.match(body.upgrade, /augur@latest/);
  assert.equal(JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json")).version, 4,
    "live must be untouched — the refusal happens before any write");
  W.applyInstance({ users: [] });
});

test("a client that omits clientProtocol predates the field, so it is below any floor", async () => {
  withFloor(3);
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, baseVersion: 4 });
  assert.equal(res.status, 426);
  assert.equal((await res.json()).clientProtocol, 0);
  W.applyInstance({ users: [] });
});

test("a client at or above the floor publishes, and clientProtocol is never persisted", async () => {
  withFloor(3);
  const env = envWithLive();
  const res = await commit(env, { ...NEXT, baseVersion: 4, clientProtocol: 3 });
  assert.equal(res.status, 200);
  const after = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
  assert.equal(after.version, 5);
  assert.equal(after.clientProtocol, undefined, "transport-only, like allowUnpublish and baseVersion");
  W.applyInstance({ users: [] });
});

test("a non-integer or non-positive floor is ignored rather than half-applied", () => {
  for (const bad of ["3", 3.5, 0, -1, null, undefined, true]) {
    assert.doesNotThrow(() => withFloor(bad), `minClientProtocol: ${JSON.stringify(bad)}`);
  }
});

test("the CLI declares a protocol, and it is the one the store lib owns", () => {
  assert.equal(typeof CLIENT_PROTOCOL, "number");
  assert.ok(Number.isInteger(CLIENT_PROTOCOL) && CLIENT_PROTOCOL >= 3,
    "the CLI must speak at least protocol 3 — the version that carries baseVersion");
});

// The publish clients are the other half: a floor is useless if nothing declares a
// version, and worse than useless if a client declares one it does not honour.
test("every client that commits declares clientProtocol from the shared constant", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["scripts/publish.mjs", "scripts/restore.mjs"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(src, /CLIENT_PROTOCOL.*from ".\/lib\/store\.mjs"/,
      `${f} must import the shared constant, not define its own`);
    assert.match(src, /clientProtocol: CLIENT_PROTOCOL/,
      `${f} must declare clientProtocol on its commit`);
    assert.doesNotMatch(src, /^const CLIENT_PROTOCOL\s*=/m,
      `${f} must not keep a second copy of the version — two copies drift`);
  }
});

test("publish stops at check when it is below the floor, before uploading anything", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/publish.mjs", import.meta.url), "utf8");
  const checkAt = src.indexOf("check.minProtocol");
  const uploadAt = src.indexOf("blob uploads failed");
  assert.ok(checkAt > -1, "publish must read the advertised floor");
  assert.ok(uploadAt > -1);
  assert.ok(checkAt < uploadAt,
    "the floor check must come BEFORE the blob upload — finding out after is the whole thing it avoids");
  // And the refusal has to say nothing shipped, or it reads as a transport hiccup.
  const die = src.slice(src.indexOf("function dieOutdated"), src.indexOf("async function publishOne"));
  assert.match(die, /Nothing was shipped/);
  assert.match(die, /npx augur@latest/);
});

test("the skew warning names the lost GUARD, not a lost optimisation", () => {
  // This wording matters more than it looks. It used to say the newer engine was "for
  // the faster path", which files a correctness problem as a performance tip — and a
  // performance tip is exactly what an agent or a busy human skips. A client below
  // protocol 3 sends no baseVersion, so the store cannot tell whether its tree was
  // built on what is live: a stale checkout can revert whoever published last,
  // silently. The message has to say that.
  const src = readFileSync(new URL("../scripts/publish.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("warnedSkew = true"), src.indexOf("warnedSkew = true") + 1200);

  assert.doesNotMatch(block, /faster path/i, "must not read as a performance tip");
  assert.match(block, /revert guard/i, "must name what protection is missing");
  assert.match(block, /roll back|revert/i, "must say what can actually happen");
  assert.match(block, /git pull/, "must still say how to fix it");
});
