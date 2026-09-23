import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  mimeOf, hashBytes, scanFolder, readState, writeState, relOf, urlOf, changesBetween,
  doOpen, doSave, doLand, doSync, doClose, doAdopt, openOverlaps, STATE_FILE, THEIRS_DIR,
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
  const revisions = new Map(); // revision -> main's table then, for `draft(…, tables)`
  const snap = () => revisions.set(1, { ...main });
  const inst = {
    blobs, drafts, get mainRevision() { return mainRevision; }, main,
    landMain(table) {
      for (const k of Object.keys(main)) if (!(k in table)) removedEver.add(k);
      Object.keys(main).forEach((k) => delete main[k]);
      Object.assign(main, table);
      mainRevision++;
      revisions.set(mainRevision, { ...main });
    },
    client: {
      async open() { const id = `d${drafts.size + 1}xxxx`.slice(0, 6); drafts.set(id, { table: { ...main }, revision: 0, base: mainRevision }); return { draftId: id, baseRevision: mainRevision, table: { ...main }, address: `${U.replace(/\/$/, "")}@${id}/`, presence: [] }; },
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
      async draft(unit, id) {
        const d = drafts.get(id);
        if (!d) return { status: 404, error: "unknown-draft" };
        return { draftId: id, table: { ...d.table }, baseTable: { ...(revisions.get(d.base) || {}) }, baseRevision: d.base, revision: d.revision, owner: "p1", name: "Ada", closedAt: d.closedAt || null };
      },
      async blobPut(h, body) { blobs.set(h, Buffer.from(body).toString()); },
      async blobGet(h) { return Buffer.from(blobs.get(h)); },
    },
  };
  snap();
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
  assert.equal(opened.address, `https://x.test${U.replace(/\/$/, "")}@${opened.draftId}/`);
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

test("a landing the server could not record still lands, and says the history entry is missing", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>" });
  const root = tmp();
  const dir = path.join(root, "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s1", now: "2026-09-04T12:00:00.000Z" });
  const client = {
    ...inst.client,
    async land(args) {
      const r = await inst.client.land(args);
      return r.status ? r : { ...r, recorded: false, revision: null, warning: "landed-unrecorded" };
    },
  };
  const landed = await doLand({ client, dir, note: "" });
  assert.equal(landed.ok, true);
  assert.equal(landed.recorded, false, "the caller can tell the record is missing");
  assert.equal(landed.warning, "landed-unrecorded");
  assert.equal(landed.url, `https://x.test${U}`);
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

test("open refuses a unit that does not exist unless told it is new, and refuses --new on one that does", async () => {
  const empty = fakeInstance({});
  const dir1 = path.join(tmp(), "new");
  const guessed = await doOpen({ client: empty.client, unit: U, dir: dir1, origin: "https://x.test", space: "alpha", session: "s", now: "2026-09-06T10:00:00.000Z" });
  assert.equal(guessed.ok, false);
  assert.equal(guessed.error, "unknown-unit");
  assert.equal(empty.drafts.size, 0, "the draft it opened to find out was handed back");
  assert.equal(fs.existsSync(dir1), false, "no folder was left behind");
  const created = await doOpen({ client: empty.client, unit: U, dir: dir1, origin: "https://x.test", space: "alpha", session: "s", now: "2026-09-06T10:00:00.000Z", isNew: true });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.isNew, true);
  assert.equal(created.files, 0);
  assert.ok(fs.existsSync(path.join(dir1, ".augur", "draft.json")), "an empty folder with its state file");
  const full = fakeInstance({ "index.html": "<h1>x</h1>" });
  const dir2 = path.join(tmp(), "existing");
  const twice = await doOpen({ client: full.client, unit: U, dir: dir2, origin: "https://x.test", space: "alpha", session: "s", now: "", isNew: true });
  assert.equal(twice.ok, false);
  assert.equal(twice.error, "unit-exists");
  assert.equal(full.drafts.size, 0);
});

test("scanFolder leaves out what a working folder carries and never publishes", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), "<h1/>");
  // A file of credentials, copied in with everything else when the draft was seeded.
  fs.writeFileSync(path.join(dir, ".env.local.json"), '{"password":"x"}');
  // The one shape of dotted env file that IS content: the example beside it.
  fs.writeFileSync(path.join(dir, ".env.example"), "PASSWORD=");
  // A build cache and an editor's dropping.
  fs.mkdirSync(path.join(dir, "__pycache__"));
  fs.writeFileSync(path.join(dir, "__pycache__", "a.cpython-314.pyc"), "x");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
  const skipped = [];
  assert.deepEqual(scanFolder(dir, skipped), {
    "index.html": { h: sha("<h1/>"), ct: "text/html; charset=utf-8", s: 5 },
    ".env.example": { h: sha("PASSWORD="), ct: "application/octet-stream", s: 9 },
  });
  assert.deepEqual(skipped.map((s) => s.path).sort(),
    [".DS_Store", ".env.local.json", "__pycache__"]);
  assert.equal(skipped.find((s) => s.path === ".env.local.json").why, "looks like a secret");
});

test("scanFolder honours .augurignore for what only this folder knows is local", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), "<h1/>");
  fs.writeFileSync(path.join(dir, ".augurignore"), "# the working data, real names in it\ndata/\n*.sqlite\n");
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "data", "people.sqlite"), "x");
  fs.writeFileSync(path.join(dir, "scratch.sqlite"), "x");
  const skipped = [];
  const out = scanFolder(dir, skipped);
  assert.deepEqual(Object.keys(out).sort(), [".augurignore", "index.html"]);
  assert.deepEqual(skipped.map((s) => s.path).sort(), ["data", "scratch.sqlite"]);
});

test("a save reports what it left out, and unpublishes a local file that had travelled", async () => {
  const inst = fakeInstance({ "index.html": "<h1/>", "lab/.env.json": '{"password":"x"}' });
  const dir = tmp();
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x", now: "t" });
  assert.ok(fs.existsSync(path.join(dir, "lab", ".env.json")), "open writes what main holds");
  const r = await doSave({ client: inst.client, dir });
  assert.ok(r.ok);
  assert.deepEqual(r.skipped.map((s) => s.path), ["lab/.env.json"]);
  assert.deepEqual(r.changed, ["lab/.env.json"]);
  const st = readState(dir);
  assert.ok(!(`${U}lab/.env.json` in st.table), "the draft no longer publishes it");
});

// ── an overlap left by sync is not a landing's to decide ─────────────────────
// Measured on a live workspace (23 Sep 2026): sync met an overlap and exited 2, but it had
// already moved the draft onto main, so a plain `land` next published "mine" and dropped the
// other person's line in that file — no warning, nothing in the history.
async function overlapPair() {
  const inst = fakeInstance({ "app.js": "a\nb\nc\n", "other.js": "x\n" });
  const root = tmp();
  const ada = path.join(root, "ada"), bea = path.join(root, "bea");
  await doOpen({ client: inst.client, unit: U, dir: ada, origin: "https://x.test", space: "s", session: "i", now: "2026-09-23T00:00:00.000Z" });
  await doOpen({ client: inst.client, unit: U, dir: bea, origin: "https://x.test", space: "s", session: "w", now: "2026-09-23T00:00:00.000Z" });
  fs.writeFileSync(path.join(bea, "app.js"), "a\nBEA\nc\n");
  fs.writeFileSync(path.join(bea, "other.js"), "x\ny\n");
  await doSave({ client: inst.client, dir: bea });
  fs.writeFileSync(path.join(ada, "app.js"), "a\nADA\nc\n");
  await doSave({ client: inst.client, dir: ada });
  assert.equal((await doLand({ client: inst.client, dir: bea })).ok, true);
  assert.equal((await doLand({ client: inst.client, dir: ada })).error, "main-moved");
  const s = await doSync({ client: inst.client, dir: ada });
  assert.equal(s.ok, true);
  assert.deepEqual(s.conflicts.map((c) => c.rel), ["app.js"]);
  assert.equal(s.pending, true);
  const live = () => inst.blobs.get(inst.main[`${U}app.js`].h);
  return { inst, ada, live };
}

test("land refuses while a sync's overlap is still open, and names it", async () => {
  const { inst, ada, live } = await overlapPair();
  const before = inst.mainRevision;
  const l = await doLand({ client: inst.client, dir: ada });
  assert.equal(l.ok, false);
  assert.equal(l.error, "overlaps-open");
  assert.deepEqual(l.overlaps, ["app.js"]);
  assert.equal(inst.mainRevision, before, "nothing landed");
  assert.match(live(), /BEA/, "the other side's line is still live");
});

test("an open overlap keeps the draft on its old base, so the site's Land button is refused too", async () => {
  const { inst, ada } = await overlapPair();
  const st = readState(ada);
  const d = inst.drafts.get(st.draftId);
  assert.equal(d.base, 1, "the server-side base did not move");
  assert.equal(st.baseRevision, 1);
  // what was taken cleanly IS saved into the draft
  assert.equal(fs.readFileSync(path.join(ada, "other.js"), "utf8"), "x\ny\n");
  assert.equal(d.table[`${U}other.js`].h, sha("x\ny\n"));
  // a member pressing Land lands at the draft's own base: refused
  const bar = await inst.client.land({ draftId: st.draftId, baseRevision: d.base });
  assert.equal(bar.error, "main-moved");
  // an edit saved meanwhile (the hook) keeps it pending
  fs.writeFileSync(path.join(ada, "note.txt"), "n");
  await doSave({ client: inst.client, dir: ada });
  assert.equal(readState(ada).pending.mainRevision, 2);
  assert.equal(inst.drafts.get(st.draftId).base, 1);
});

test("folding an overlap and deleting its theirs copy lets land move the base and land both sides", async () => {
  const { inst, ada, live } = await overlapPair();
  fs.writeFileSync(path.join(ada, "app.js"), "a\nADA\nBEA\nc\n");
  fs.rmSync(path.join(ada, THEIRS_DIR, "app.js"));
  assert.deepEqual(openOverlaps(ada), []);
  const l = await doLand({ client: inst.client, dir: ada });
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.equal(live(), "a\nADA\nBEA\nc\n");
  assert.equal(inst.blobs.get(inst.main[`${U}other.js`].h), "x\ny\n", "the one-sided change from the sync is kept");
  assert.equal(readState(ada).pending, undefined);
});

test("a sync run again does not flag an overlap that was folded, and merges a newer landing from the folded version", async () => {
  const { inst, ada } = await overlapPair();
  fs.writeFileSync(path.join(ada, "app.js"), "a\nADA\nBEA\nc\n");
  fs.rmSync(path.join(ada, THEIRS_DIR, "app.js"));
  const again = await doSync({ client: inst.client, dir: ada });
  assert.deepEqual(again.conflicts, [], "the folded file is not an overlap any more");
  assert.equal(again.pending, undefined);
  assert.equal(readState(ada).baseRevision, inst.mainRevision, "a clean sync moves the base");

  // same shape, but main moves the folded file again before the second sync
  const p = await overlapPair();
  fs.writeFileSync(path.join(p.ada, "app.js"), "a\nADA\nBEA\nc\n");
  fs.rmSync(path.join(p.ada, THEIRS_DIR, "app.js"));
  const newer = "a\nBEA\nc\nd\n";
  p.inst.blobs.set(sha(newer), newer);
  p.inst.landMain({ ...p.inst.main, [`${U}app.js`]: { h: sha(newer), ct: mimeOf("app.js"), s: newer.length } });
  const s2 = await doSync({ client: p.inst.client, dir: p.ada });
  assert.deepEqual(s2.conflicts, []);
  assert.equal(fs.readFileSync(path.join(p.ada, "app.js"), "utf8"), "a\nADA\nBEA\nc\nd\n");
});

test("a theirs file with no pending sync (an older CLI's) still blocks the landing", async () => {
  const inst = fakeInstance({ "index.html": "<h1>flow</h1>" });
  const dir = path.join(tmp(), "flow");
  await doOpen({ client: inst.client, unit: U, dir, origin: "https://x.test", space: "s", session: "s1", now: "2026-09-23T00:00:00.000Z" });
  fs.mkdirSync(path.join(dir, THEIRS_DIR, "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, THEIRS_DIR, "js", "a.js"), "theirs");
  const l = await doLand({ client: inst.client, dir });
  assert.equal(l.error, "overlaps-open");
  assert.deepEqual(l.overlaps, ["js/a.js"]);
});

// ── picking an open draft up into a fresh folder ─────────────────────────────
test("open --draft puts the draft's saved files in a new folder on its own base, and a later landing is synced, not overwritten", async () => {
  const inst = fakeInstance({ "app.js": "a\nb\nc\n", "i18n.js": "k\n" });
  const root = tmp();
  const old = path.join(root, "old");
  await doOpen({ client: inst.client, unit: U, dir: old, origin: "https://x.test", space: "s", session: "i1", now: "2026-09-22T00:00:00.000Z" });
  fs.writeFileSync(path.join(old, "app.js"), "a\nNEW WORK\nb\nc\n");
  await doSave({ client: inst.client, dir: old });
  const draftId = readState(old).draftId;
  fs.rmSync(old, { recursive: true, force: true });          // the session's folder is gone

  // somebody lands on both files meanwhile
  const w = "a\nb\nc\nSHARED\n", k = "k\nl\n";
  inst.blobs.set(sha(w), w); inst.blobs.set(sha(k), k);
  inst.landMain({ ...inst.main, [`${U}app.js`]: { h: sha(w), ct: mimeOf("app.js"), s: w.length }, [`${U}i18n.js`]: { h: sha(k), ct: mimeOf("i18n.js"), s: k.length } });

  const dir = path.join(root, "new");
  const r = await doAdopt({ client: inst.client, unit: U, draftId, dir, origin: "https://x.test", space: "s", session: "i2", now: "2026-09-23T00:00:00.000Z" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.address, `https://x.test${U.replace(/\/$/, "")}@${draftId}/`);
  assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "a\nNEW WORK\nb\nc\n");
  assert.equal(fs.readFileSync(path.join(dir, "i18n.js"), "utf8"), "k\n");
  const st = readState(dir);
  assert.equal(st.draftId, draftId);
  assert.equal(st.baseRevision, 1);
  assert.equal(st.draftRevision, 1);

  // an edit here saves into the same draft
  fs.writeFileSync(path.join(dir, "extra.css"), "x{}");
  assert.equal((await doSave({ client: inst.client, dir })).ok, true);

  assert.equal((await doLand({ client: inst.client, dir })).error, "main-moved");
  const s = await doSync({ client: inst.client, dir });
  assert.deepEqual(s.conflicts, []);
  assert.equal((await doLand({ client: inst.client, dir })).ok, true);
  assert.equal(inst.blobs.get(inst.main[`${U}app.js`].h), "a\nNEW WORK\nb\nc\nSHARED\n", "both the draft's work and the landing since are live");
  assert.equal(inst.blobs.get(inst.main[`${U}i18n.js`].h), "k\nl\n");
});

test("open --draft refuses a non-empty folder, an unknown draft and a landed one", async () => {
  const inst = fakeInstance({ "app.js": "a\n" });
  const root = tmp();
  const busy = path.join(root, "busy");
  fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, "x"), "x");
  assert.equal((await doAdopt({ client: inst.client, unit: U, draftId: "abcdef", dir: busy, origin: "o", space: "s", session: "s", now: "n" })).error, "folder-not-empty");
  assert.equal((await doAdopt({ client: inst.client, unit: U, draftId: "zzzzzz", dir: path.join(root, "a"), origin: "o", space: "s", session: "s", now: "n" })).error, "unknown-draft");
  const d1 = path.join(root, "d1");
  await doOpen({ client: inst.client, unit: U, dir: d1, origin: "o", space: "s", session: "s", now: "n" });
  inst.drafts.get(readState(d1).draftId).closedAt = "2026-09-23T00:00:00.000Z";
  const r = await doAdopt({ client: inst.client, unit: U, draftId: readState(d1).draftId, dir: path.join(root, "b"), origin: "o", space: "s", session: "s", now: "n" });
  assert.equal(r.error, "draft-closed");
  assert.equal(fs.existsSync(path.join(root, "b")), false);
});

test("open --draft against an engine that cannot hand the tables over says so and writes nothing", async () => {
  const inst = fakeInstance({ "app.js": "a\n" });
  const root = tmp();
  const d1 = path.join(root, "d1");
  await doOpen({ client: inst.client, unit: U, dir: d1, origin: "o", space: "s", session: "s", now: "n" });
  const client = { ...inst.client, async draft() { return { draftId: "x", files: 1, baseRevision: 1, revision: 0 }; } };
  const dir = path.join(root, "b");
  const r = await doAdopt({ client, unit: U, draftId: readState(d1).draftId, dir, origin: "o", space: "s", session: "s", now: "n" });
  assert.equal(r.error, "adopt-unsupported");
  assert.equal(fs.existsSync(dir), false);
});
