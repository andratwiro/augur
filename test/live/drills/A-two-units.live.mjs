// Drill A — one identity, two sessions, two different prototypes, edits and landings
// interleaved. Neither draft ever carries the other's files; each main is exactly its
// own draft; the draft addresses serve the edit before the landing does.
import { test } from "node:test";
import { UNITS } from "../env.mjs";
import { assert, open, writeFile, readFile, stamp, save, land, served, draftAddress, mainAddress, mainTable, until, listFiles, close, resetUnit } from "./lib.mjs";

const [U1, U2] = UNITS();

test("A: two sessions of one editor on two units do not touch each other", async () => {
  const a = await open("editor", "session a", U1, "A-unit1");
  const b = await open("editor", "session b", U2, "A-unit2");
  try {
    assert.notEqual(a.r.draftId, b.r.draftId);
    assert.deepEqual(a.r.others, [], "unit 1 had nobody else in it");

    // Interleave: a edits, b edits, a saves, b saves.
    const ia = readFile(a, "index.html"), ib = readFile(b, "index.html");
    writeFile(a, "index.html", ia + "\n" + stamp(a, "edit-1"));
    writeFile(b, "index.html", ib + "\n" + stamp(b, "edit-1"));
    writeFile(b, `b-only-${a.r.draftId}.txt`, "a file only b has");
    const sa = await save(a), sb = await save(b);
    assert.ok(sa.ok && sb.ok, `saves: ${JSON.stringify([sa, sb])}`);
    assert.deepEqual(sa.changed, ["index.html"]);
    assert.deepEqual(sb.changed.sort(), [`b-only-${a.r.draftId}.txt`, "index.html"]);

    // Each draft address serves its own edit, at once, and not the other's.
    const da = await until(async () => { const s = await served(draftAddress(a)); return s.text.includes(stamp(a, "edit-1")) ? s : null; }, { what: "a's draft address" });
    assert.ok(!da.text.includes(stamp(b, "edit-1")), "a's draft never shows b's stamp");
    const db = await served(draftAddress(b));
    assert.ok(db.text.includes(stamp(b, "edit-1")));
    assert.ok(!db.text.includes(stamp(a, "edit-1")));
    // Main still serves what it served.
    const m1 = await served(mainAddress(U1));
    assert.ok(!m1.text.includes(stamp(a, "edit-1")), "main of unit 1 unchanged before landing");

    // Land b first, then a; check each main is exactly its own draft.
    const lb = await land(b);
    assert.ok(lb.ok, JSON.stringify(lb));
    assert.match(lb.url, new RegExp(U2.replace(/\//g, "\\/")));
    const la = await land(a);
    assert.ok(la.ok, JSON.stringify(la));
    const tb = await mainTable(b), ta = await mainTable(a);
    assert.ok(Object.keys(tb).some((p) => p.endsWith(`b-only-${a.r.draftId}.txt`)), "unit 2's main has b's new file");
    assert.ok(!Object.keys(ta).some((p) => p.includes("b-only-")), "unit 1's main has none of b's files");
    assert.ok(Object.keys(ta).every((p) => p.startsWith(U1)), "unit 1's table only names unit 1 paths");
    await until(async () => (await served(mainAddress(U1))).text.includes(stamp(a, "edit-1")), { what: "unit 1 main serving a's landing" });
    await until(async () => (await served(mainAddress(U2))).text.includes(stamp(b, "edit-1")), { what: "unit 2 main serving b's landing" });
    assert.ok(!(await served(mainAddress(U1))).text.includes(stamp(b, "edit-1")));
    assert.deepEqual(listFiles(a).filter((f) => f.includes("b-only")), [], "a's folder never received b's file");
  } finally {
    await close(a, true).catch(() => {}); await close(b, true).catch(() => {});
    await resetUnit(U1); await resetUnit(U2);
  }
});
