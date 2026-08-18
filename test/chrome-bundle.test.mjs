// The shared chrome bundle (P1) + service worker (P0).
//
// shell() used to inline ~187 KB of byte-identical script+style into EVERY page,
// re-transmitted on essentially every navigation. This guards the extraction:
//   • exactly one content-hashed /_chrome.*.css and /_chrome.*.js are emitted,
//   • every shell() page references both (and NOT via inlined copies),
//   • the per-page data script (__GV_SPACE) stays inline,
//   • the concatenated bundle preserves the original IIFE order,
//   • sw.js is emitted and carries the tested decision logic.
// If any of these regress, pages silently bloat back to the old size or the
// chrome fails to load — invisible until someone opens a page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function buildMinimalSite() {
  const spacesRoot = mkdtempSync(path.join(tmpdir(), "chrome-space-"));
  // A one-space site (space.json at the root → builds as the default space).
  writeFileSync(path.join(spacesRoot, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true }));
  const proto = path.join(spacesRoot, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const out = mkdtempSync(path.join(tmpdir(), "chrome-dist-"));
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out },
    stdio: "pipe",
  });
  return { out, cleanup: () => { rmSync(spacesRoot, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

test("exactly one content-hashed chrome CSS and JS are emitted, plus sw.js", () => {
  const { out, cleanup } = buildMinimalSite();
  try {
    const files = readdirSync(out);
    const css = files.filter((f) => /^_chrome\.[\w.]+\.css$/.test(f));
    const js = files.filter((f) => /^_chrome\.[\w.]+\.js$/.test(f));
    assert.equal(css.length, 1, "one _chrome.*.css: " + css.join(","));
    assert.equal(js.length, 1, "one _chrome.*.js: " + js.join(","));
    assert.ok(files.includes("sw.js"), "sw.js emitted");
  } finally { cleanup(); }
});

test("the shell page references the bundle and no longer inlines the chrome", () => {
  const { out, cleanup } = buildMinimalSite();
  try {
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    const jsName = readdirSync(out).find((f) => /^_chrome\.[\w.]+\.js$/.test(f));
    const cssName = readdirSync(out).find((f) => /^_chrome\.[\w.]+\.css$/.test(f));

    assert.match(html, new RegExp(`<link rel="stylesheet" href="/${cssName.replace(/\./g, "\\.")}"`), "links the chrome CSS");
    assert.match(html, new RegExp(`<script defer src="/${jsName.replace(/\./g, "\\.")}"`), "defers the chrome JS");

    // The extracted behaviour must NOT still be inline (sentinels unique to the
    // constants that moved into the bundle).
    for (const sentinel of ["In-page real-time filter", "var RESOLVED = {}", "wireSheet", "@font-face"]) {
      assert.ok(!html.includes(sentinel), `inline chrome leaked: «${sentinel}»`);
    }
    // Per-page data must stay inline (it varies per page; cannot be in a shared bundle).
    assert.ok(html.includes("__GV_SPACE"), "per-page __GV_SPACE stays inline");

    // The whole point: the page got small. Was ~218 KB; assert a hard ceiling.
    assert.ok(Buffer.byteLength(html) < 60_000, `shell page should be lean, got ${Buffer.byteLength(html)} B`);
  } finally { cleanup(); }
});

test("the bundle preserves the original IIFE order and parses as one script", () => {
  const { out, cleanup } = buildMinimalSite();
  try {
    const jsName = readdirSync(out).find((f) => /^_chrome\.[\w.]+\.js$/.test(f));
    const js = readFileSync(path.join(out, jsName), "utf8");
    // CAROUSEL_JS is first, FACE_JS (its unique `RESOLVED` cache) is last, the SW
    // registration is appended after everything.
    const carousel = js.indexOf("(function");
    const face = js.indexOf("RESOLVED");
    const swReg = js.indexOf("serviceWorker");
    assert.ok(carousel >= 0 && face > carousel, "FACE_JS after the first IIFE");
    assert.ok(swReg > face, "SW registration appended last");
    // Concatenating IIFEs is the ASI hazard this guards; node --check equivalent:
    assert.doesNotThrow(() => new Function(js), "bundle parses as a single script");
  } finally { cleanup(); }
});

test("the shipped sw.js carries the tested decision logic", () => {
  const { out, cleanup } = buildMinimalSite();
  try {
    const sw = readFileSync(path.join(out, "sw.js"), "utf8");
    assert.ok(sw.includes("function swDecision"), "swDecision inlined");
    assert.ok(sw.includes("function cacheEligible"), "cacheEligible inlined");
    assert.ok(!sw.includes("export "), "exports stripped for classic worker scope");
    assert.match(sw, /const CACHE = "augur-v"/, "cache namespace present");
    assert.ok(sw.includes("skipWaiting") && sw.includes("clients.claim"), "fast-activation wiring present");
    assert.doesNotThrow(() => new Function(sw), "sw.js parses");
  } finally { cleanup(); }
});
