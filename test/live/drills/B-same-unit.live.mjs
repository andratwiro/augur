// Drill B — two people on one prototype. Both see each other at open. The second to land
// is refused with the list of what changed; sync writes one-sided changes outright, merges
// a file both touched when the edits do not overlap, and parks an overlap under
// .augur/theirs with the hunks named. Then it lands.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { UNITS } from "../env.mjs";
import { assert, open, writeFile, readFile, stamp, save, land, sync, served, mainAddress, until, close, resetUnit } from "./lib.mjs";

const U = UNITS()[2];

test("B1: one-sided — a new file on one side, an index change on the other", async () => {
  const a = await open("editor", "b1-a", U);
  const b = await open("editor2", "b1-b", U);
  try {
    assert.equal(b.r.others.length, 1, "b was told about a at open");
    assert.equal(b.r.others[0].session, "b1-a");
    writeFile(a, "index.html", readFile(a, "index.html") + "\n" + stamp(a));
    writeFile(b, "notes-b.txt", `only b wrote this ${stamp(b)}`);
    assert.ok((await save(a)).ok); assert.ok((await save(b)).ok);
    const la = await land(a); assert.ok(la.ok, JSON.stringify(la));
    const lb = await land(b);
    assert.equal(lb.ok, false); assert.equal(lb.status, 409);
    assert.ok(Array.isArray(lb.changed) && lb.changed.some((c) => c.path.endsWith("index.html")), `refusal names index.html: ${JSON.stringify(lb)}`);
    const s = await sync(b);
    assert.ok(s.ok, JSON.stringify(s));
    assert.deepEqual(s.taken, ["index.html"]); assert.deepEqual(s.conflicts, []);
    assert.ok(readFile(b, "index.html").includes(stamp(a)), "b's folder now carries a's index");
    const lb2 = await land(b); assert.ok(lb2.ok, JSON.stringify(lb2));
    await until(async () => (await served(mainAddress(U))).text.includes(stamp(a)), { what: "main carries a's edit after b landed" });
    assert.equal((await served(mainAddress(U, "notes-b.txt"))).status, 200, "main carries b's new file");
  } finally { await close(a, true).catch(() => {}); await close(b, true).catch(() => {}); }
});

test("B2: same file, different regions — merged without a word from anyone", async () => {
  const a = await open("editor", "b2-a", U);
  const b = await open("editor2", "b2-b", U);
  try {
    const orig = readFile(a, "index.html");
    writeFile(a, "index.html", stamp(a, "top") + "\n" + orig);
    writeFile(b, "index.html", orig + "\n" + stamp(b, "bottom"));
    assert.ok((await save(a)).ok); assert.ok((await save(b)).ok);
    assert.ok((await land(a)).ok);
    const lb = await land(b); assert.equal(lb.status, 409);
    const s = await sync(b);
    assert.ok(s.ok, JSON.stringify(s));
    assert.deepEqual(s.merged, ["index.html"], `merged cleanly: ${JSON.stringify(s)}`);
    const text = readFile(b, "index.html");
    assert.ok(text.startsWith(stamp(a, "top")) && text.trimEnd().endsWith(stamp(b, "bottom")), "both edits present in order");
    assert.ok((await land(b)).ok);
  } finally { await close(a, true).catch(() => {}); await close(b, true).catch(() => {}); }
});

test("B3: same line — theirs parked beside mine, hunks named, nothing guessed", async () => {
  const a = await open("editor", "b3-a", U);
  const b = await open("editor2", "b3-b", U);
  try {
    const orig = readFile(a, "index.html");
    const lines = orig.split("\n");
    const i = Math.max(0, Math.floor(lines.length / 2));
    const la = [...lines]; la[i] = la[i] + " " + stamp(a, "same-line");
    const lb = [...lines]; lb[i] = lb[i] + " " + stamp(b, "same-line");
    writeFile(a, "index.html", la.join("\n")); writeFile(b, "index.html", lb.join("\n"));
    assert.ok((await save(a)).ok); assert.ok((await save(b)).ok);
    assert.ok((await land(a)).ok);
    assert.equal((await land(b)).status, 409);
    const s = await sync(b);
    assert.ok(s.ok, JSON.stringify(s));
    assert.equal(s.conflicts.length, 1);
    assert.equal(s.conflicts[0].rel, "index.html");
    assert.ok(s.conflicts[0].hunks.length >= 1, "the overlapping hunk is named");
    assert.ok(readFile(b, "index.html").includes(stamp(b, "same-line")), "mine stays in place");
    const theirs = fs.readFileSync(path.join(b.dir, ".augur", "theirs", "index.html"), "utf8");
    assert.ok(theirs.includes(stamp(a, "same-line")), "theirs is beside it");
    // Fold by hand: take theirs, then land.
    writeFile(b, "index.html", theirs);
    assert.ok((await land(b)).ok, "lands after the fold");
  } finally {
    await close(a, true).catch(() => {}); await close(b, true).catch(() => {});
    await resetUnit(U);
  }
});
