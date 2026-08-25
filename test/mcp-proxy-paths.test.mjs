// The /__mcp/ proxy's PATH allowlist: what the engine ships, and what a workspace adds.
//
// The proxy forwards a browser call on this origin to https://<host><path>, so its
// allowlist is a security control with two halves. The host half was already declared by
// the workspace (space.json "mcpAllowlists"); the path half was a module constant that
// carried one company's API endpoint next to the three the MCP/OAuth protocol speaks.
// These tests pin the split that replaced it: the engine's floor is the protocol and
// nothing else, and everything past it rides in on the workspace's own declaration.
//
// ⏳ And the migration window that split opened. A declaration is written into a manifest
// AT PUBLISH TIME, so an instance whose live manifests predate declarations carries none
// and cannot grow one by taking this engine. Those manifests keep the old floor, keyed on
// the one thing the serving side can see — whether the fragment has an `mcpPaths` key at
// all. ABSENT means older than declarations; an EMPTY ARRAY means a workspace declared
// none and means it. The ⏳ cases below go when LEGACY_MCP_PATH_FLOOR goes.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { __testables as W } from "../src/_worker.js";
import { routingFields, LEGACY_MCP_PATH_FLOOR } from "../src/tenant-context.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HOST = "platform.example.invalid";

// Seed the routing the proxy reads, the way a live isolate does: from the manifest
// fragments the workspaces published. The seeded CONTEXT is kept in CTX because the
// proxy takes the workspace it is proxying for as an argument now.
let CTX = W.applyDerivedRouting({});
function routeWith({ hosts = [HOST], paths = [] } = {}) {
  CTX = W.applyDerivedRouting({
    w1: { space: { id: "w1", default: true }, routing: { mcpAllowlist: hosts, mcpPaths: paths } },
  });
}

// ⏳ The same, from a manifest published before declarations existed: the fragment has
// hosts and no `mcpPaths` key whatsoever. Spelled with a deliberate absence rather than
// `paths: undefined` so the shape is the one a vintage manifest actually has.
function routeVintage(hosts = [HOST]) {
  CTX = W.applyDerivedRouting({
    w1: { space: { id: "w1", default: true }, routing: { mcpAllowlist: hosts } },
  });
}

// A recording stand-in for the upstream call, so nothing here touches the network.
function withStubbedFetch(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || "GET" });
    return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}

const proxy = (path, method = "GET") => {
  const url = new URL(`https://site.example.invalid/__mcp/${HOST}${path}`);
  return W.mcpProxy(CTX, new Request(url, { method }), url);
};

test("the engine's own path floor is the protocol, and nothing else", () => {
  assert.deepEqual([...W.MCP_PROXY_PATHS].sort(), ["/mcp", "/oauth/registrations", "/oauth/token"]);
});

test("a platform's own API path is refused unless the workspace declared it", async () => {
  routeWith(); // hosts declared, no paths
  const res = await proxy("/web_api/v1/app_configuration");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "path not allowed");
});

test("the protocol paths pass with no declaration at all", async () => {
  routeWith();
  await withStubbedFetch(async (calls) => {
    const res = await proxy("/mcp", "POST");
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.url), [`https://${HOST}/mcp`]);
  });
});

test("a workspace-declared path passes, and reaches exactly the URL it names", async () => {
  routeWith({ paths: ["/api/v1/configuration"] });
  await withStubbedFetch(async (calls) => {
    const res = await proxy("/api/v1/configuration");
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.url), [`https://${HOST}/api/v1/configuration`]);
  });
});

test("a declared path is a whole endpoint, never a prefix", async () => {
  routeWith({ paths: ["/api/v1/configuration"] });
  for (const path of ["/api/v1/configuration/secrets", "/api/v1", "/api/v1/configurationx"]) {
    const res = await proxy(path);
    assert.equal(res.status, 403, `${path} should not ride in on the declared prefix`);
  }
});

test("declaring a path opens nothing on a host that was never declared", async () => {
  routeWith({ hosts: [], paths: ["/api/v1/configuration"] });
  const res = await proxy("/api/v1/configuration");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "host not allowed");
});

test("the declarations are the union of what the workspaces published", () => {
  const f = W.applyDerivedRouting({
    a: { space: { id: "a" }, routing: { mcpAllowlist: ["a.example.invalid"], mcpPaths: ["/b", "/a"] } },
    b: { space: { id: "b" }, routing: { mcpAllowlist: ["b.example.invalid"], mcpPaths: ["/a", "/c"] } },
  });
  assert.deepEqual(f.MCP_PATH_ALLOWLIST, ["/a", "/b", "/c"]);
});

test("a workspace that declares no paths contributes none, rather than all", () => {
  const f = W.applyDerivedRouting({ a: { space: { id: "a" }, routing: { mcpPaths: [] } } });
  assert.deepEqual(f.MCP_PATH_ALLOWLIST, []);
});

test("assets mode reads the same declaration out of routing.json", () => {
  assert.deepEqual(routingFields({ mcpPaths: ["/api/v1/configuration"] }).MCP_PATH_ALLOWLIST,
    ["/api/v1/configuration"]);
  assert.deepEqual(routingFields({ mcpPaths: [] }).MCP_PATH_ALLOWLIST, []);
});

// ---- ⏳ the migration window: manifests published before declarations existed -----------

test("⏳ a fragment with no mcpPaths key at all keeps the floor that engine had", () => {
  const f = W.applyDerivedRouting({ a: { space: { id: "a" }, routing: { mcpAllowlist: [HOST] } } });
  assert.deepEqual(f.MCP_PATH_ALLOWLIST, [...LEGACY_MCP_PATH_FLOOR].sort());
});

test("⏳ an EMPTY array is a declaration meaning none, and gets no floor", () => {
  const f = W.applyDerivedRouting({ a: { space: { id: "a" }, routing: { mcpPaths: [] } } });
  assert.deepEqual(f.MCP_PATH_ALLOWLIST, []);
  assert.deepEqual(routingFields({ mcpPaths: [] }).MCP_PATH_ALLOWLIST, []);
});

test("⏳ absent and empty are told apart per workspace, not for the deployment", () => {
  // One vintage fragment does not silence a current one's declaration, and one current
  // fragment does not take the floor away from the vintage one beside it.
  const f = W.applyDerivedRouting({
    old: { space: { id: "old" }, routing: { mcpAllowlist: ["a.example.invalid"] } },
    now: { space: { id: "now" }, routing: { mcpAllowlist: ["b.example.invalid"], mcpPaths: ["/api/v1/configuration"] } },
  });
  assert.deepEqual(f.MCP_PATH_ALLOWLIST, ["/api/v1/configuration", ...LEGACY_MCP_PATH_FLOOR].sort());
});

test("⏳ a vintage manifest's endpoint still answers, so moving its pin takes nothing away", async () => {
  routeVintage();
  await withStubbedFetch(async (calls) => {
    const res = await proxy(LEGACY_MCP_PATH_FLOOR[0]);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.url), [`https://${HOST}${LEGACY_MCP_PATH_FLOOR[0]}`]);
  });
});

test("⏳ the same endpoint is refused once the workspace has published a declaration", async () => {
  routeWith({ paths: ["/api/v1/configuration"] });
  const res = await proxy(LEGACY_MCP_PATH_FLOOR[0]);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "path not allowed");
});

test("⏳ the floor is a floor, not a ceiling: the protocol three still pass a vintage fragment", async () => {
  routeVintage();
  await withStubbedFetch(async (calls) => {
    for (const p of W.MCP_PROXY_PATHS) assert.equal((await proxy(p, "POST")).status, 200);
    assert.equal(calls.length, 3);
  });
});

test("⏳ the shim widens no host: a vintage fragment that declared none reaches nothing", async () => {
  routeVintage([]);
  const res = await proxy(LEGACY_MCP_PATH_FLOOR[0]);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "host not allowed");
});

test("⏳ assets mode dates routing.json the same way", () => {
  assert.deepEqual(routingFields({}).MCP_PATH_ALLOWLIST, [...LEGACY_MCP_PATH_FLOOR]);
  // A fresh array per read: two tenants must never share one mutable allowlist.
  const a = routingFields({}).MCP_PATH_ALLOWLIST, b = routingFields({}).MCP_PATH_ALLOWLIST;
  assert.notEqual(a, b);
});

test("⏳ a build by THIS engine always writes the key, so the shim retires itself", () => {
  const dir = makeSpace({ hosts: ["platform.example.invalid"] });
  const res = build(dir);
  assert.equal(res.ok, true);
  const routing = JSON.parse(readFileSync(path.join(res.out, "__config", "routing.json"), "utf8"));
  assert.equal(Array.isArray(routing.mcpPaths), true, "routing.json declares, even when empty");
  assert.deepEqual(routing.mcpPaths, []);
  const manifest = JSON.parse(readFileSync(path.join(res.out, "__manifests", "acme.json"), "utf8"));
  assert.equal(Array.isArray(manifest.routing.mcpPaths), true, "the fragment declares, even when empty");
  assert.deepEqual(manifest.routing.mcpPaths, []);
  // Which is the whole exit condition: fed back through the serving side, that fragment
  // takes the floor away by itself.
  assert.deepEqual(
    W.applyDerivedRouting({ acme: { space: { id: "acme" }, routing: manifest.routing } }).MCP_PATH_ALLOWLIST,
    [],
  );
});

// ---- the build half: what a workspace writes, and what it may not ---------------------

// A minimal space that declares one allowlist document. `demo/prototypes/<name>/` is the
// nesting discoverSpaces() looks in.
function makeSpace(allowlist) {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-paths-"));
  const proto = path.join(dir, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  writeFileSync(path.join(dir, "mcp-allowlist.json"), JSON.stringify(allowlist));
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({
    id: "acme", name: "Acme", default: true, mcpAllowlists: ["mcp-allowlist.json"],
  }));
  return dir;
}

// Each build writes into its OWN output tree: node --test runs test files in parallel and
// the repo's shared dist/ is read by other tests.
function build(spacesRoot) {
  const out = path.join(spacesRoot, "__dist");
  try {
    execFileSync(process.execPath, ["build.js"], {
      cwd: ROOT,
      env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

test("a declared path ships in routing.json and in the space's own manifest fragment", () => {
  const dir = makeSpace({ hosts: ["platform.example.invalid"], paths: ["/api/v1/configuration"] });
  const res = build(dir);
  assert.equal(res.ok, true);
  const routing = JSON.parse(readFileSync(path.join(res.out, "__config", "routing.json"), "utf8"));
  assert.deepEqual(routing.mcpPaths, ["/api/v1/configuration"]);
  const manifest = JSON.parse(readFileSync(path.join(res.out, "__manifests", "acme.json"), "utf8"));
  assert.deepEqual(manifest.routing.mcpPaths, ["/api/v1/configuration"]);
});

test("a path that could never match the pathname it is compared against fails the build", () => {
  for (const bad of ["api/v1/config", "/api?x=1", "/api/../admin", "//evil.example.invalid/"]) {
    const res = build(makeSpace({ hosts: [], paths: [bad] }));
    assert.equal(res.ok, false, `${bad} should not build`);
    assert.match(res.err, /carries an invalid path/);
  }
});

test("a document with neither key is a broken declaration, not an empty one", () => {
  const res = build(makeSpace({ hostz: ["typo.example.invalid"] }));
  assert.equal(res.ok, false);
  assert.match(res.err, /must be shaped/);
});
