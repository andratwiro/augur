// test/draft-tools.test.mjs — read-only copies, the watch loop, closing a copy, the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { doRead, doClose, watchFolder, draftsReport, readDirFor, registryList, mimeOf } from "../scripts/lib/draft.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-tools-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");
const U = "/checkout/flow/";

function fakeMain(files) {
  const blobs = new Map(), table = {};
  for (const [rel, body] of Object.entries(files)) { blobs.set(sha(body), body); table[U + rel] = { h: sha(body), ct: mimeOf(rel), s: body.length }; }
  return { async main() { return { revision: 3, table }; }, async blobGet(h) { return Buffer.from(blobs.get(h)); } };
}

test("read materialises the unit read-only and registers the copy; close removes both", async () => {
  const root = tmp();
  const dir = path.join(root, readDirFor(U));
  assert.equal(readDirFor(U), path.join("_read", "checkout", "flow"));
  const r = await doRead({ client: fakeMain({ "index.html": "<h1>flow</h1>", "css/a.css": "h1{}" }), unit: U, dir, origin: "https://x.test", now: "2026-09-06T10:00:00.000Z" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(dir, "css", "a.css"), "utf8"), "h1{}");
  assert.equal(fs.statSync(path.join(dir, "index.html")).mode & 0o222, 0, "no write bit for anybody");
  assert.equal(fs.existsSync(path.join(dir, ".augur")), false, "a copy is not a draft");
  const reg = registryList().find((e) => e.dir === dir);
  assert.equal(reg.readOnly, true);
  assert.equal(reg.unit, U);
  const again = await doRead({ client: fakeMain({ "index.html": "x" }), unit: U, dir, origin: "https://x.test", now: "" });
  assert.equal(again.error, "folder-not-empty");
  const c = await doClose({ client: {}, dir, discard: false });
  assert.deepEqual(c, { ok: true, readOnly: true });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(registryList().some((e) => e.dir === dir), false);
  assert.equal((await doClose({ client: {}, dir: tmp(), discard: false })).error, "not-a-draft", "a folder nobody registered is left alone");
});

test("watchFolder settles a burst of edits into one call, and ignores .augur", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".augur"));
  let calls = 0;
  const w = watchFolder(dir, () => { calls++; }, { debounceMs: 120 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(dir, "a.html"), "a");
    fs.writeFileSync(path.join(dir, "b.html"), "b");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls, 1, "two writes inside the window are one save");
    fs.writeFileSync(path.join(dir, ".augur", "draft.json"), "{}");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls, 1, "the state file is not an edit");
  } finally { w.close(); }
});

test("draftsReport says what is open here and who else is on it", () => {
  const lines = draftsReport(
    [{ dir: "/w/flow", unit: U, draftId: "k7f3q1", origin: "https://x.test", openedAt: "2026-09-06T10:00:00.000Z" }, { dir: "/w/_read/x", unit: "/x/y/", readOnly: true }],
    { [U]: [{ id: "k7f3q1", session: "mine", active: true }, { id: "zzzzzz", session: "pass two", name: "Ada", active: false }] },
  );
  assert.equal(lines.length, 2, "a read-only copy is not a draft");
  assert.match(lines[0], /checkout\/flow/);
  assert.match(lines[0], /k7f3q1/);
  assert.match(lines[0], /\/w\/flow/);
  assert.match(lines[1], /Ada · pass two \(idle\)/);
  assert.deepEqual(draftsReport([], {}), []);
});
