import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  mimeOf, hashBytes, scanFolder, readState, writeState, relOf, urlOf, changesBetween,
  doOpen, doSave, doLand, doSync, doClose, STATE_FILE, THEIRS_DIR,
} from "../scripts/lib/draft.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-draft-"));
const U = "/checkout/flow/";
// Never the developer's own registry.
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");

/** A fake instance: main table + blobs + drafts, answering the unit routes the CLI speaks. */
function fakeInstance(mainFiles) {
  const blobs = new Map();
  const put = (body) => { blobs.set(sha(body), body); return sha(body); };
  const main = {};
  for (const [rel, body] of Object.entries(mainFiles)) main[U + rel] = { h: put(body), ct: mimeOf(rel), s: body.length };
  const drafts = new Map();
  const removedEver = new Set(); // paths landMain has ever dropped from main, for sync's `removed`
  let mainRevision = 1;
  const inst = {
    blobs, drafts, get mainRevision() { return mainRevision; }, main,
    landMain(table) {
      for (const k of Object.keys(main)) if (!(k in table)) removedEver.add(k);
      Object.keys(main).forEach((k) => delete main[k]);
      Object.assign(main, table);
      mainRevision++;
    },
    client: {
      async open() { const id = `d${drafts.size + 1}xxxx`.slice(0, 6); drafts.set(id, { table: { ...main }, revision: 0, base: mainRevision }); return { draftId: id, baseRevision: mainRevision, table: { ...main }, address: `${U}@${id}/`, presence: [] }; },
      async save({ draftId, draftRevision, changes, baseRevision }) {
        const d = drafts.get(draftId);
        if (d.revision !== draftRevision) return { status: 409, error: "stale-draft-revision", draftRevision: d.revision };
        for (const c of changes) if (!c.delete && !blobs.has(c.h)) return { status: 409, error: "missing-blobs", missing: [c.h] };
        for (const c of changes) { if (c.delete) delete d.table[c.path]; else d.table[c.path] = { h: c.h, ct: c.ct, s: c.s }; }
        d.revision++; if (baseRevision !== undefined) d.base = baseRevision;
        return { draftRevision: d.revision, table: { ...d.table } };
      },
      async land({ draftId, baseRevision }) {
        const d = drafts.get(draftId);
        if (baseRevision !== mainRevision) return { status: 409, error: "main-moved", mainRevision, changed: Object.entries(main).map(([p, f]) => ({ path: p, ...f })), removed: [] };
        inst.landMain(d.table); return { ok: true, revision: mainRevision, version: 99, url: `https://x.test${U}` };
      },
      // Coarse on purpose: every main file is reported as changed, and the library must
      // skip the ones the draft's base already had. That is exactly what a real instance
      // returns for a file untouched on main since the base, so no shortcut can hide here.
      async sync({ draftId }) {
        const d = drafts.get(draftId);
        return { mainRevision, baseRevision: d.base, changed: Object.entries(main).map(([p, f]) => ({ path: p, ...f })), removed: [...removedEver] };
      },
      async discard({ draftId }) { drafts.delete(draftId); return { closed: true }; },
      async presence() { return { drafts: [] }; },
      async blobPut(h, body) { blobs.set(h, Buffer.from(body).toString()); },
      async blobGet(h) { return Buffer.from(blobs.get(h)); },
    },
  };
  return inst;
}

test("mime, hashing and path mapping", () => {
  assert.equal(mimeOf("index.html"), "text/html; charset=utf-8");
  assert.equal(mimeOf("a.css"), "text/css; charset=utf-8");
  assert.equal(mimeOf("x.webp"), "image/webp");
  assert.equal(mimeOf("blob.unknown"), "application/octet-stream");
  assert.equal(hashBytes(Buffer.from("abc")), sha("abc"));
  assert.equal(relOf(U, `${U}css/a.css`), "css/a.css");
  assert.equal(urlOf(U, "css/a.css"), `${U}css/a.css`);
});

test("scanFolder hashes every file except the state folder", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), "<h1/>");
  fs.mkdirSync(path.join(dir, "css"));
  fs.writeFileSync(path.join(dir, "css", "a.css"), "h1{}");
  fs.mkdirSync(path.join(dir, ".augur"));
  fs.writeFileSync(path.join(dir, ".augur", "draft.json"), "{}");
  assert.deepEqual(scanFolder(dir), {
    "index.html": { h: sha("<h1/>"), ct: "text/html; charset=utf-8", s: 5 },
    "css/a.css": { h: sha("h1{}"), ct: "text/css; charset=utf-8", s: 4 },
  });
});

test("changesBetween carries the saved hash as the base, and deletes what vanished", () => {
  const saved = { [`${U}index.html`]: { h: "old", ct: "text/html; charset=utf-8", s: 1 }, [`${U}gone.js`]: { h: "g", ct: "application/javascript; charset=utf-8", s: 1 } };
  const local = { "index.html": { h: "new", ct: "text/html; charset=utf-8", s: 2 }, "b.css": { h: "b", ct: "text/css; charset=utf-8", s: 1 } };
  assert.deepEqual(changesBetween(U, saved, local), [
    { path: `${U}b.css`, h: "b", ct: "text/css; charset=utf-8", s: 1, baseHash: null },
    { path: `${U}gone.js`, baseHash: "g", delete: true },
    { path: `${U}index.html`, h: "new", ct: "text/html; charset=utf-8", s: 2, baseHash: "old" },
  ]);
  assert.deepEqual(changesBetween(U, saved, { "index.html": { h: "old", ct: "x", s: 1 }, "gone.js": { h: "g", ct: "x", s: 1 } }), []);
});

test("open materialises the unit and writes state; save pushes only what changed; land moves main", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const root = tmp();
  const dir = path.join(root, "flow");
  const opened = await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  assert.equal(opened.address, `https://x.test${U}@${opened.draftId}/`);
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "<h1>flow</h1>");
  assert.equal(fs.readFileSync(path.join(dir, "a.css"), "utf8"), "h1{}");
  const st = readState(dir);
  assert.equal(st.unit, U);
  assert.equal(st.draftRevision, 0);

  fs.writeFileSync(path.join(dir, "index.html"), "<h1>flow v2</h1>");
  const saved = await doSave({ client: inst.client, dir });
  assert.deepEqual(saved.changed, ["index.html"]);
  assert.equal(inst.blobs.has(sha("<h1>flow v2</h1>")), true);
  assert.equal(readState(dir).draftRevision, 1);
  const nothing = await doSave({ client: inst.client, dir });
  assert.deepEqual(nothing.changed, []);

  const landed = await doLand({ client: inst.client, dir, note: "v2" });
  assert.equal(landed.ok, true);
  assert.equal(landed.url, `https://x.test${U}`);
  assert.equal(inst.main[`${U}index.html`].h, sha("<h1>flow v2</h1>"));
  assert.equal(readState(dir).landed, true);
});

test("a refused land is reported; sync merges a clean overlap and leaves a real one to the agent", async () => {
  const inst = fakeInstance({ "index.html": "a\nb\nc\nd", "a.css": "h1{}" });
  const root = tmp();
  const dir = path.join(root, "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  // main moves: somebody lands a change to the last line of index.html and a new file
  const theirIndex = "a\nb\nc\nD";
  inst.blobs.set(sha(theirIndex), theirIndex);
  inst.blobs.set(sha("new"), "new");
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirIndex), ct: mimeOf("index.html"), s: theirIndex.length }, [`${U}n.txt`]: { h: sha("new"), ct: mimeOf("n.txt"), s: 3 } });
  // my draft edits the first line of the same file
  fs.writeFileSync(path.join(dir, "index.html"), "A\nb\nc\nd");
  await doSave({ client: inst.client, dir });
  const refused = await doLand({ client: inst.client, dir, note: "" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "main-moved");

  const synced = await doSync({ client: inst.client, dir });
  assert.deepEqual(synced.merged, ["index.html"]);
  assert.deepEqual(synced.taken, ["n.txt"]);
  assert.deepEqual(synced.conflicts, []);
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "A\nb\nc\nD");
  assert.equal(fs.readFileSync(path.join(dir, "n.txt"), "utf8"), "new");
  assert.equal(readState(dir).baseRevision, inst.mainRevision);
  const landed = await doLand({ client: inst.client, dir, note: "" });
  assert.equal(landed.ok, true);

  // now a REAL overlap: both sides edit line one
  const dir2 = path.join(root, "flow2");
  await doOpen({ client: inst.client, unit: U, dir: dir2, origin: "https://x.test", space: "alpha", session: "s2", now: "2026-09-04T12:10:00.000Z" });
  const theirs2 = "THEIRS\nb\nc\nD";
  inst.blobs.set(sha(theirs2), theirs2);
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirs2), ct: mimeOf("index.html"), s: theirs2.length } });
  fs.writeFileSync(path.join(dir2, "index.html"), "MINE\nb\nc\nD");
  await doSave({ client: inst.client, dir: dir2 });
  const s2 = await doSync({ client: inst.client, dir: dir2 });
  assert.deepEqual(s2.conflicts.map((c) => c.rel), ["index.html"]);
  assert.equal(fs.readFileSync(path.join(dir2, "index.html"), "utf8"), "MINE\nb\nc\nD", "mine stays in place");
  assert.equal(fs.readFileSync(path.join(dir2, THEIRS_DIR, "index.html"), "utf8"), theirs2, "theirs is beside it, outside the unit tree");
});

test("a file the agent deleted is not resurrected by sync", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const dir = path.join(tmp(), "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });

  fs.rmSync(path.join(dir, "index.html"));
  await doSave({ client: inst.client, dir });
  assert.equal(fs.existsSync(path.join(dir, "index.html")), false);

  // main changes the same file the agent deleted
  const theirs = "<h1>changed on main</h1>";
  inst.blobs.set(sha(theirs), theirs);
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirs), ct: mimeOf("index.html"), s: theirs.length } });

  const synced = await doSync({ client: inst.client, dir });
  assert.equal(synced.ok, true);
  assert.deepEqual(synced.conflicts, [{ rel: "index.html", hunks: [], deleted: true }]);
  assert.equal(synced.taken.includes("index.html"), false);
  assert.equal(fs.existsSync(path.join(dir, "index.html")), false, "the deletion is not resurrected");
  assert.equal(fs.readFileSync(path.join(dir, THEIRS_DIR, "index.html"), "utf8"), theirs, "theirs is preserved beside it");
});

test("a file removed on main is removed locally only if untouched", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const root = tmp();
  const dir1 = path.join(root, "untouched");
  const dir2 = path.join(root, "edited");
  await doOpen({ client: inst.client, unit: U, dir: dir1, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  await doOpen({ client: inst.client, unit: U, dir: dir2, origin: "https://x.test", space: "alpha", session: "s2", now: "2026-09-04T12:00:00.000Z" });

  // the second draft edits a.css before main removes it
  fs.writeFileSync(path.join(dir2, "a.css"), "h1{color:red}");
  await doSave({ client: inst.client, dir: dir2 });

  const withoutACss = { ...inst.main };
  delete withoutACss[`${U}a.css`];
  inst.landMain(withoutACss);

  const s1 = await doSync({ client: inst.client, dir: dir1 });
  assert.deepEqual(s1.taken, ["a.css"]);
  assert.equal(fs.existsSync(path.join(dir1, "a.css")), false, "untouched: removed locally too");

  const s2 = await doSync({ client: inst.client, dir: dir2 });
  assert.deepEqual(s2.kept, ["a.css"]);
  assert.equal(fs.readFileSync(path.join(dir2, "a.css"), "utf8"), "h1{color:red}", "edited: survives the removal");
});

test("a network failure mid-sync returns a result and leaves state intact", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const dir = path.join(tmp(), "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  const before = readState(dir).baseRevision;

  const theirs = "<h1>changed on main</h1>";
  inst.blobs.set(sha(theirs), theirs);
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirs), ct: mimeOf("index.html"), s: theirs.length } });

  const flaky = { ...inst.client, blobGet: async () => { throw new Error("boom"); } };
  const result = await doSync({ client: flaky, dir });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network");
  assert.match(result.message, /boom/);
  assert.equal(readState(dir).baseRevision, before, "state on disk is untouched by the failed sync");
});

test("a failed trailing save leaves the state file untouched", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const dir = path.join(tmp(), "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  const before = readState(dir);

  const theirs = "<h1>changed on main</h1>";
  inst.blobs.set(sha(theirs), theirs);
  inst.landMain({ ...inst.main, [`${U}index.html`]: { h: sha(theirs), ct: mimeOf("index.html"), s: theirs.length } });

  const flaky = { ...inst.client, save: async (body) => { if (body.baseRevision !== undefined) throw new Error("boom"); return inst.client.save(body); } };
  const result = await doSync({ client: flaky, dir });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network");
  assert.deepEqual(readState(dir), before, "the trailing save's failure leaves the state file byte-identical, baseTable included");
});

test("a failed open leaves no folder and the retry succeeds", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "a.css": "h1{}" });
  const dir = path.join(tmp(), "flow");
  let calls = 0;
  const flaky = { ...inst.client, blobGet: async (h) => { calls++; if (calls === 2) throw new Error("boom"); return inst.client.blobGet(h); } };
  const result = await doOpen({ client: flaky, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network");
  assert.equal(fs.existsSync(dir), false, "the half-materialised folder is removed");
  assert.equal(inst.drafts.size, 0, "the server-side draft is discarded");

  const retried = await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:05.000Z" });
  assert.equal(retried.ok, true, "the retry succeeds against a clean folder");
});

test("a failed open into a pre-existing empty folder leaves it empty, and the retry succeeds", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>", "css/a.css": "h1{}" });
  const dir = path.join(tmp(), "flow");
  fs.mkdirSync(dir, { recursive: true }); // pre-existing, empty — doOpenImpl did not create it
  let calls = 0;
  const flaky = { ...inst.client, blobGet: async (h) => { calls++; if (calls === 2) throw new Error("boom"); return inst.client.blobGet(h); } };
  const result = await doOpen({ client: flaky, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network");
  assert.equal(fs.existsSync(dir), true, "the pre-existing folder itself is not removed");
  assert.deepEqual(fs.readdirSync(dir), [], "every entry it wrote is removed, including the nested css/ directory, leaving it empty");
  assert.equal(inst.drafts.size, 0, "the server-side draft is discarded");

  const retried = await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:05.000Z" });
  assert.equal(retried.ok, true, "the retry succeeds against the same folder");
});

test("close refuses an open draft unless discarding", async () => {
  const inst = fakeInstance({ "index.html": "x" });
  const dir = path.join(tmp(), "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  const kept = await doClose({ client: inst.client, dir, discard: false });
  assert.equal(kept.ok, false);
  assert.equal(fs.existsSync(dir), true);
  const gone = await doClose({ client: inst.client, dir, discard: true });
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(inst.drafts.size, 0);
});
