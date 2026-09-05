// test/chrome-drafts.test.mjs — what the build ships for drafts that land: the bar script
// at /__drafts/drafts.js, the chips in the chrome bundle, the evict handler in sw.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function buildMinimalSite() {
  const spacesRoot = mkdtempSync(path.join(tmpdir(), "drafts-space-"));
  writeFileSync(path.join(spacesRoot, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true }));
  const proto = path.join(spacesRoot, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const out = mkdtempSync(path.join(tmpdir(), "drafts-dist-"));
  execFileSync(process.execPath, ["build.js"], { cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out }, stdio: "pipe" });
  return { out, cleanup: () => { rmSync(spacesRoot, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}
const built = buildMinimalSite();
process.on("exit", built.cleanup);
const dist = built.out;
const chromeJs = () => readFileSync(path.join(dist, readdirSync(dist).find((f) => /^_chrome\..*\.js$/.test(f))), "utf8");
const chromeCss = () => readFileSync(path.join(dist, readdirSync(dist).find((f) => /^_chrome\..*\.css$/.test(f))), "utf8");

test("the bar script ships at /__drafts/drafts.js, byte-identical to its source, and parses", () => {
  const shipped = path.join(dist, "__drafts", "drafts.js");
  assert.equal(existsSync(shipped), true);
  const src = readFileSync(path.join(ROOT, "src", "drafts", "drafts.js"), "utf8");
  assert.equal(readFileSync(shipped, "utf8"), src);
  execFileSync(process.execPath, ["--check", shipped], { stdio: "pipe" });
  for (const must of ["/__unit/", "\"presence\"", "\"draft\"", "\"history\"", "\"land\"", "\"discard\"", "\"restore\"", "/__unit/socket?", "window.top !== window.self", "\"evict\""]) {
    assert.ok(src.includes(must), `drafts.js speaks ${must}`);
  }
});

test("the chrome bundle carries the chips: one fetch of /__unit/drafts, a link per draft, a count per folder", () => {
  const js = chromeJs();
  assert.ok(js.includes("fetch('/__unit/drafts'"), "the chips ask the workspace-wide index");
  assert.ok(js.includes("window.__gvDraftsWire = wire"), "re-wirable like marks and faces");
  assert.ok(js.includes("'draft-chip'"), "the chip class");
  assert.ok(js.includes("draft-chip--count"), "the folder count");
  assert.ok(js.includes("window.__gvFacesWire()"), "chips get faces through the shared resolver");
  assert.ok(js.indexOf("fetch('/__unit/drafts'") > js.indexOf("window.__gvFacesWire = wire"), "faces are defined before the chips call them");
  const css = chromeCss();
  for (const sel of [".draft-chips {", ".draft-chip {", ".draft-chip.is-idle", ".draft-chip__who", ".draft-chip__text", ".draft-chip--count"]) {
    assert.ok(css.includes(sel), `chrome css has ${sel}`);
  }
});

test("sw.js forgets a URL when a page asks, and never caches a draft address", () => {
  const sw = readFileSync(path.join(dist, "sw.js"), "utf8");
  assert.ok(sw.includes('addEventListener("message"'), "the evict handler is wired");
  assert.ok(sw.includes('d.t !== "evict"'), "it answers only evict");
  assert.ok(sw.includes("ignoreSearch: true"), "a URL is forgotten whatever its query");
  assert.ok(sw.includes("DRAFT_SEGMENT_RE"), "the tested decision logic rides along (Task 1)");
});
