// Runtime chrome composition — the shared rail renderer + the worker's serve-time
// composer. See src/chrome/appchrome.mjs and composeChrome in src/_worker.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAppChrome, renderSpaceContextScript } from "../src/chrome/appchrome.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Build a one-space site into a temp dist, optionally with GV_RUNTIME_CHROME set.
function buildSite(extraEnv = {}) {
  const spacesRoot = mkdtempSync(path.join(tmpdir(), "rc-space-"));
  writeFileSync(path.join(spacesRoot, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true }));
  const proto = path.join(spacesRoot, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const out = mkdtempSync(path.join(tmpdir(), "rc-dist-"));
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out, ...extraEnv }, stdio: "pipe",
  });
  const routing = JSON.parse(readFileSync(path.join(out, "__config", "routing.json"), "utf8"));
  return { out, routing, cleanup: () => { rmSync(spacesRoot, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

const STATE = {
  spaces: [{ id: "demo", name: "Demo", default: true, base: "" }],
  activeSpace: "demo", opportunities: [], hasPlayground: true,
};

test("renderAppChrome yields a rail with the projects item and version foot", () => {
  const html = renderAppChrome("prototypes", STATE, {});
  assert.match(html, /class="gvtop"/);
  assert.match(html, /gvside__ver">v[\d.]+/);
  assert.match(html, /data-pinned-list/);
});

test("admin active renders the admin rail", () => {
  const html = renderAppChrome("admin", STATE, {});
  assert.match(html, /aria-label="Workspace settings"/);
  assert.match(html, /data-admin-back/);
});

test("renderSpaceContextScript emits the space base for the pins filter", () => {
  assert.match(renderSpaceContextScript(STATE), /window\.__GV_SPACE=/);
});

test("routing.runtimeChrome is false by default and reflects GV_RUNTIME_CHROME", () => {
  const off = buildSite();
  try { assert.equal(off.routing.runtimeChrome, false, "off by default"); } finally { off.cleanup(); }
  const on = buildSite({ GV_RUNTIME_CHROME: "1" });
  try { assert.equal(on.routing.runtimeChrome, true, "on when the flag is set"); } finally { on.cleanup(); }
});

test("non-default active space scopes rail links to its base", () => {
  const state = {
    spaces: [
      { id: "demo", name: "Demo", default: true, base: "" },
      { id: "beta", name: "Beta", default: false, base: "/beta" },
    ],
    activeSpace: "beta", opportunities: [], hasPlayground: false,
  };
  const html = renderAppChrome("prototypes", state, {});
  assert.match(html, /data-search-base="\/beta\/"/);
  assert.match(html, /href="\/beta\/"/); // the Projects rail item is base-scoped
});
