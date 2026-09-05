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
