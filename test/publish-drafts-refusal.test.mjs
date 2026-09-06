// test/publish-drafts-refusal.test.mjs — where the instance serves drafts, `augur publish`
// refuses a content publish before building anything and says what to do instead;
// everywhere else it is unchanged. `augur ship` and `augur mark` are gone, and say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { draftsServed } from "../scripts/lib/draft.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLISH = path.join(ROOT, "scripts", "publish.mjs");
const CLI = path.join(ROOT, "scripts", "cli.mjs");

async function door(drafts) {
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/augur.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "augur", drafts: drafts ? { enabled: true } : { enabled: false } }));
      return;
    }
    res.writeHead(404); res.end("nf");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
function spaceFolder(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-pub-"));
  fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "alpha", siteOrigin: origin }));
  fs.mkdirSync(path.join(dir, "demo", "prototypes", "hello"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "prototypes", "hello", "index.html"), "<p>hi</p>");
  return dir;
}
// Async on purpose: the door server lives in this process. A bogus token keeps publish
// from starting a pairing that would wait for a browser.
const run = (script, cwd, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "not-a-token" } });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => resolve({ code, out, err }));
});

test("draftsServed reads the public fact, and answers false for anything it cannot read", async () => {
  const on = await door(true), off = await door(false);
  try {
    assert.equal(await draftsServed(on.origin), true);
    assert.equal(await draftsServed(off.origin), false);
    assert.equal(await draftsServed(""), false);
    assert.equal(await draftsServed("http://127.0.0.1:1", { timeoutMs: 500 }), false, "nothing listening");
  } finally { await on.close(); await off.close(); }
});

test("publish refuses on a drafts instance with the open/land instructions, before building anything", async () => {
  const d = await door(true);
  try {
    const dir = spaceFolder(d.origin);
    const r = await run(PUBLISH, dir, ["--dry-run"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /augur open <opportunity>\/<prototype>/);
    assert.match(r.err, /augur land/);
    assert.match(r.err, /augur open --new/);
    assert.doesNotMatch(r.err, /build|uploading|token/i, "nothing further ran");
    assert.equal(fs.existsSync(path.join(dir, "dist")), false, "no build output");
  } finally { await d.close(); }
});

test("publish on an instance without drafts says nothing about them", async () => {
  const d = await door(false);
  try {
    const r = await run(PUBLISH, spaceFolder(d.origin), ["--dry-run"]);
    assert.doesNotMatch(r.err, /augur open|augur land/);
  } finally { await d.close(); }
});

test("ship and mark are answered with one sentence each, and exit 1", async () => {
  const ship = await run(CLI, os.tmpdir(), ["ship"]);
  assert.equal(ship.code, 1);
  assert.match(ship.err, /retired/);
  assert.match(ship.err, /augur open <opportunity>\/<prototype>/);
  const mark = await run(CLI, os.tmpdir(), ["mark"]);
  assert.equal(mark.code, 1);
  assert.match(mark.err, /a draft IS the mark/);
});
