// test/ship-drafts-refusal.test.mjs — where the instance serves drafts, `augur ship` refuses
// before touching anything and says what to do instead; everywhere else it is unchanged.
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
const SHIP = path.join(ROOT, "scripts", "ship.mjs");

async function door(drafts) {
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/augur.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "augur", drafts: drafts ? { enabled: true, open: "augur open <opportunity>/<prototype>", land: "augur land", docs: "/llms.txt" } : { enabled: false } }));
      return;
    }
    res.writeHead(404); res.end("nf");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
function spaceFolder(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-ship-"));
  fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "alpha", siteOrigin: origin }));
  fs.mkdirSync(path.join(dir, "demo", "prototypes", "hello"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "prototypes", "hello", "index.html"), "<p>hi</p>");
  return dir;
}
// Async on purpose: the door server lives in this process.
const ship = (cwd, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SHIP, ...args], { cwd, env: { ...process.env, AUGUR_ORIGIN: "", AUGUR_TOKEN: "" } });
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

test("ship refuses on a drafts instance with the open/land instructions, and touches nothing", async () => {
  const d = await door(true);
  try {
    const dir = spaceFolder(d.origin);
    const r = await ship(dir, ["--dry-run"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /augur open <opportunity>\/<prototype>/);
    assert.match(r.err, /augur land/);
    assert.match(r.err, /--legacy/);
    assert.doesNotMatch(r.err, /commit|publish\]/i, "nothing further ran");
    assert.equal(fs.existsSync(path.join(dir, ".git")), false, "no repository was created");
    const legacy = await ship(dir, ["--dry-run", "--legacy"]);
    assert.doesNotMatch(legacy.err, /augur open <opportunity>/, "the old path runs");
    assert.match(legacy.err, /legacy path/);
  } finally { await d.close(); }
});

test("ship on an instance without drafts says nothing about them", async () => {
  const d = await door(false);
  try {
    const r = await ship(spaceFolder(d.origin), ["--dry-run"]);
    assert.doesNotMatch(r.err, /augur open|augur land|legacy/);
  } finally { await d.close(); }
});
