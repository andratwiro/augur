// Offline parity: the worker's serve-time chrome (composeChrome) must reproduce EXACTLY
// what the current engine bakes. This is the invariant that makes runtime-chrome safe —
// if the re-render ever drifted from the bake, an enabled instance would serve a rail
// subtly different from a freshly-published page. Both halves run against a REAL build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAppChrome } from "../src/chrome/appchrome.mjs";
import { __testables as W } from "../src/_worker.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// One default space WITH a playground, so the baker's hasPlayground matches the value
// composeChrome uses (true) — i.e. the realistic instance shape. It also declares
// space.json "help": anything the BAKE reads from a build global the worker cannot see
// is exactly the drift this file exists to catch, so the workspace's own Help sections
// are part of the fixture rather than a separate case.
function buildFixture() {
  const spacesRoot = mkdtempSync(path.join(tmpdir(), "rcp-space-"));
  writeFileSync(path.join(spacesRoot, "space.json"), JSON.stringify({
    id: "acme", name: "Acme", default: true,
    help: [{ title: "House rules", items: ["Ask before renaming a token."] }],
  }));
  mkdirSync(path.join(spacesRoot, "demo", "prototypes", "hello"), { recursive: true });
  writeFileSync(path.join(spacesRoot, "demo", "prototypes", "hello", "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  mkdirSync(path.join(spacesRoot, "playground", "pg"), { recursive: true });
  writeFileSync(path.join(spacesRoot, "playground", "pg", "index.html"), "<!doctype html><title>PG</title><p>pg</p>\n");
  const out = mkdtempSync(path.join(tmpdir(), "rcp-dist-"));
  execFileSync(process.execPath, ["build.js"], { cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out }, stdio: "pipe" });
  const routing = JSON.parse(readFileSync(path.join(out, "__config", "routing.json"), "utf8"));
  const html = readFileSync(path.join(out, "index.html"), "utf8");
  return { out, routing, html, cleanup: () => { rmSync(spacesRoot, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

const MARK = /<!--gv-chrome-start ([^>]*)-->([\s\S]*?)<!--gv-chrome-end-->/;
const attr = (attrs, name) => (attrs.match(new RegExp(name + '="([^"]*)"')) || [, ""])[1];

test("compose == bake: the worker re-render equals the baked marked region", () => {
  const fx = buildFixture();
  try {
    const m = fx.html.match(MARK);
    assert.ok(m, "index.html carries the chrome markers");
    const active = attr(m[1], "data-active");
    const spaceId = attr(m[1], "data-space");
    // The EXACT state composeChrome builds for this page.
    const state = { spaces: fx.routing.spaces, activeSpace: spaceId, opportunities: [], hasPlayground: true };
    const rerendered = renderAppChrome(active, state, {});
    assert.equal(rerendered, m[2], "compose-of-current must byte-match the bake");
    // Not silent coverage: the space's Help section really is in the region compared.
    assert.match(m[2], /<h4>House rules<\/h4>/);
  } finally { fx.cleanup(); }
});

test("stale page → current: composeChrome restores the current rail + bundle refs", async () => {
  const fx = buildFixture();
  try {
    const m = fx.html.match(MARK);
    const bakedInner = m[2];
    // Forge a page an OLD engine baked: same markers, but a stale rail body and stale
    // _chrome.* refs (a different version+hash than the current bundle).
    let stale = fx.html
      .replace(MARK, `<!--gv-chrome-start ${m[1]}-->STALE_OLD_RAIL<!--gv-chrome-end-->`)
      .replace(/\/_chrome\.[\d.]+\.[0-9a-f]{8}\.css/g, "/_chrome.1.09.00000000.css")
      .replace(/\/_chrome\.[\d.]+\.[0-9a-f]{8}\.js/g, "/_chrome.1.09.00000000.js");
    assert.match(stale, /STALE_OLD_RAIL/);
    assert.match(stale, /1\.09\.00000000/);

    // Serve it through composeChrome with the CURRENT engine's pointer + spaces (flag on).
    W.__setChromeTestState(fx.routing.chrome, fx.routing.spaces, true);
    const res = new Response(stale, { headers: { "Content-Type": "text/html", "ETag": '"old"' } });
    const outHtml = await (await W.composeChrome(res, new URL("https://x/"))).text();

    // The stale rail is gone, replaced by exactly the current baked rail.
    const om = outHtml.match(MARK);
    assert.equal(om[2], bakedInner, "composed rail must equal the current bake");
    assert.doesNotMatch(outHtml, /STALE_OLD_RAIL/);
    // The stale bundle refs now point at the current bundle.
    assert.doesNotMatch(outHtml, /1\.09\.00000000/);
    assert.ok(outHtml.includes("/" + fx.routing.chrome.css));
    assert.ok(outHtml.includes("/" + fx.routing.chrome.js));
    // And the whole recomposed page equals the freshly-baked page (a true no-op-to-current).
    assert.equal(outHtml, fx.html, "composed stale page is byte-identical to the current bake");
  } finally { fx.cleanup(); }
});
