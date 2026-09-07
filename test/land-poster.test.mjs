// The card picture `augur land` takes on the way up — and every way it declines.
//
// A prototype landed from a draft folder had no poster and nothing rendered one, so its
// gallery card was a blank tile for good. `land` now shoots `preview.webp` before it saves.
// The shoot needs Playwright and cwebp, which the package does not carry and CI does not
// have, so the contract under test is the DECLINE PATH first: every skip is a named reason
// and never a throw, a folder is never touched when it should not be, and a folder that
// IS shot holds a real WebP. The last one runs only where the tools exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { posterFor, needsPoster, entryOf, posterTools, POSTER } from "../scripts/lib/poster.mjs";

const folder = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-poster-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
};
const listing = (dir) => fs.readdirSync(dir).filter((f) => f !== ".augur").sort();

test("AUGUR_NO_POSTER=1 and --no-poster both decline before looking at the folder", async () => {
  const dir = folder({ "index.html": "<h1>hi</h1>" });
  const prev = process.env.AUGUR_NO_POSTER;
  process.env.AUGUR_NO_POSTER = "1";
  try { assert.equal((await posterFor(dir)).skipped, "disabled"); }
  finally { if (prev === undefined) delete process.env.AUGUR_NO_POSTER; else process.env.AUGUR_NO_POSTER = prev; }
  assert.equal((await posterFor(dir, { enabled: false })).skipped, "disabled");
  assert.deepEqual(listing(dir), ["index.html"], "nothing was written");
});

test("a folder with nothing to shoot, and a board, are named as such", async () => {
  const empty = folder({ "notes.md": "x" });
  assert.equal((await posterFor(empty)).skipped, "no-html");
  assert.equal(await entryOf(empty), null);
  const board = folder({ "index.html": '<script src="/__canvas/canvas.js"></script>' });
  const r = await posterFor(board);
  assert.equal(r.skipped, "canvas");
  assert.match(r.why, /npm run shoot/);
  assert.deepEqual(listing(board), ["index.html"]);
});

test("a page that pulls its stylesheets or scripts from outside the folder is not shot from source", async () => {
  // A draft folder holds the unit and nothing else. Rendered over file://, a stylesheet at
  // `../../skills/ui.css` or `/skills/ui.css` resolves to nothing, and the shot is a white
  // page with a stray bar — a poster worse than none, since the folder card then wears it.
  for (const href of ["../../skills/ui/tokens.css", "/skills/ui/tokens.css"]) {
    const dir = folder({ "index.html": `<link rel="stylesheet" href="${href}"><h1>hi</h1>` });
    const r = await posterFor(dir);
    assert.equal(r.skipped, "outside-folder", href);
    assert.match(r.why, /npm run shoot/);
    assert.deepEqual(listing(dir), ["index.html"], "nothing was written");
  }
  const script = folder({ "index.html": '<script src="../shared/app.js"></script>' });
  assert.equal((await posterFor(script)).skipped, "outside-folder");
  // Assets the engine serves by absolute path are not "outside": every deployment has them.
  const engine = folder({ "index.html": '<link rel="stylesheet" href="/__canvas/canvas.css"><script src="/piti.js"></script><h1>x</h1>' });
  assert.notEqual((await posterFor(engine)).skipped, "outside-folder");
  // A relative path INSIDE the folder is fine.
  const inside = folder({ "index.html": '<link rel="stylesheet" href="./css/a.css"><script src="app.js"></script>' });
  assert.notEqual((await posterFor(inside)).skipped, "outside-folder");
});

test("a poster newer than every source file is current; an older one is not", async () => {
  const dir = folder({ "index.html": "<h1>hi</h1>" });
  assert.equal(await needsPoster(dir), true, "no poster yet");
  fs.writeFileSync(path.join(dir, POSTER), "RIFF....WEBP");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, POSTER), later, later);
  assert.equal(await needsPoster(dir), false);
  assert.equal((await posterFor(dir)).skipped, "current");
  const muchLater = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(dir, "index.html"), muchLater, muchLater);
  assert.equal(await needsPoster(dir), true, "the source moved past the poster");
  // `.augur/` (the draft's own state) never counts as source
  fs.mkdirSync(path.join(dir, ".augur"));
  fs.writeFileSync(path.join(dir, ".augur", "draft.json"), "{}");
  fs.utimesSync(path.join(dir, POSTER), new Date(Date.now() + 20000), new Date(Date.now() + 20000));
  assert.equal(await needsPoster(dir), false, "draft state is not source");
});

test("the entry is index.html, else the first top-level html", async () => {
  const dir = folder({ "b.html": "", "a.html": "" });
  assert.equal(path.basename(await entryOf(dir)), "a.html");
  fs.writeFileSync(path.join(dir, "index.html"), "");
  assert.equal(path.basename(await entryOf(dir)), "index.html");
});

// Where Playwright, its browser and cwebp are present (a maintainer's machine) the shot is
// real; anywhere else the decline names the missing tool. Both are the contract.
test("with the tools, a shot lands a real WebP; without them, the reason is named", async () => {
  const dir = folder({ "index.html": "<!doctype html><body style='background:#0ea5e9'><h1>poster</h1></body>" });
  const tools = await posterTools();
  const r = await posterFor(dir);
  if (!tools.ok) {
    assert.equal(r.skipped, "no-tools");
    assert.equal(typeof r.why, "string");
    assert.deepEqual(listing(dir), ["index.html"]);
    return;
  }
  if (r.skipped === "no-browser") {
    assert.match(r.why, /playwright install/);
    assert.deepEqual(listing(dir), ["index.html"]);
    return;
  }
  assert.equal(r.shot, true, JSON.stringify(r));
  const bytes = fs.readFileSync(path.join(dir, POSTER));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("latin1"), "WEBP");
  assert.equal((await posterFor(dir)).skipped, "current", "a second land does not reshoot an untouched folder");
  try { execFileSync("cwebp", ["-version"], { stdio: "ignore" }); } catch { assert.fail("cwebp was reported present"); }
});

// The whole way up, against the fixture instance: `augur land` from a draft folder whose
// source is newer than its (absent) poster. Where the tools exist the landing carries
// preview.webp as image/webp and says so; where they do not, the landing happens all the
// same and the reason is on stderr. Both are the contract; CI is the second case.
import { spawn } from "node:child_process";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember, liveNow } from "./fixtures/unit-env.mjs";

// Async on purpose: the CLI talks to the fixture server living in THIS process, and a
// synchronous spawn would block the loop that answers it.
const run = (args, cwd, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("a landing from a draft folder carries the poster where the tools exist, and lands anyway where they do not", async (t) => {
  const U = "/checkout/flow/";
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": remember("<h1>flow</h1>") } }), tenantId: "cli-land-poster" });
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "augur-work-"));
    fs.writeFileSync(path.join(work, "space.json"), JSON.stringify({ id: "alpha" }));
    // A private HOME keeps the run off this machine's settings; Playwright keeps its
    // browsers under the real one, so say where they are or the CLI sees no browser.
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
      || [path.join(os.homedir(), "Library", "Caches", "ms-playwright"), path.join(os.homedir(), ".cache", "ms-playwright")].find((d) => fs.existsSync(d));
    const env = { ...process.env, HOME: home, AUGUR_ORIGIN: srv.origin, AUGUR_TOKEN: "tok",
      AUGUR_DRAFTS_REGISTRY: path.join(home, "drafts.json"), AUGUR_NO_ADAPTERS: "1",
      ...(browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {}) };
    delete env.AUGUR_NO_POSTER;
    const opened = await run([path.resolve("scripts/open.mjs"), "checkout/flow", "--dir", "flow"], work, env);
    assert.equal(opened.status, 0, opened.stderr);
    const dir = path.join(work, "flow");
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><body style='background:#f59e0b'><h1>flow, edited</h1></body>");
    const landed = await run([path.resolve("scripts/land.mjs"), "-m", "edited"], dir, env);
    assert.equal(landed.status, 0, landed.stderr);
    assert.match(landed.stderr, /landed as revision/);
    t.diagnostic(landed.stderr.split("\n").filter((l) => /poster/.test(l)).join(" | ") || "no poster line");
    const files = liveNow(srv.env).files;
    assert.ok(files[U + "index.html"], "the edit landed");
    const tools = await posterTools();
    if (/no poster \((no-tools|no-browser)\)/.test(landed.stderr)) {
      assert.equal(tools.ok && !/no-browser/.test(landed.stderr), false, "a skip for tools is only right when a tool is missing");
      assert.equal(files[U + POSTER], undefined, "nothing was invented");
      return;
    }
    assert.match(landed.stderr, /poster shot/);
    assert.ok(files[U + POSTER], "the landing carries the poster");
    assert.equal(files[U + POSTER].ct, "image/webp");
    assert.ok(fs.existsSync(path.join(dir, POSTER)), "and the folder keeps it for the next land");
    // The next land, untouched, neither reshoots nor re-uploads — the poster is current.
    const again = await run([path.resolve("scripts/open.mjs"), "checkout/flow", "--dir", "flow2"], work, env);
    assert.equal(again.status, 0, again.stderr);
    const dir2 = path.join(work, "flow2");
    assert.ok(fs.existsSync(path.join(dir2, POSTER)), "open materialises the poster with the unit");
    const landed2 = await run([path.resolve("scripts/land.mjs"), "-m", "nothing"], dir2, env);
    assert.doesNotMatch(landed2.stderr, /poster shot/);
  } finally { await srv.close(); }
});
