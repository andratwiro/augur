// Drill I — everything at once.
//   eight sessions open eight units, save, and land in the same instant: no 5xx, every
//   main is exactly its draft, every history has one new row.
//   two processes save into ONE draft: the second is answered stale-draft, not merged.
import { test } from "node:test";
import { UNITS, RUN } from "../env.mjs";
import { human, client } from "../persona.mjs";
import { assert, open, writeFile, readFile, stamp, save, land, mainTable, close, resetUnit, stateOf } from "./lib.mjs";

const ALL = UNITS();
const EIGHT = ALL.slice(0, 8);

test("I1: eight units, eight sessions, one instant", async () => {
  const drafts = await Promise.all(EIGHT.map((u, i) => open("editor", `i1-${i}`, u)));
  try {
    for (const d of drafts) writeFile(d, "index.html", readFile(d, "index.html") + "\n" + stamp(d));
    const saves = await Promise.all(drafts.map((d) => save(d)));
    saves.forEach((s, i) => assert.ok(s.ok, `save ${i}: ${JSON.stringify(s)}`));
    const t0 = Date.now();
    const lands = await Promise.all(drafts.map((d) => land(d)));
    const ms = Date.now() - t0;
    lands.forEach((l, i) => assert.ok(l.ok, `land ${i}: ${JSON.stringify(l)}`));
    console.log(`I1: 8 parallel lands in ${ms} ms; recorded=${lands.map((l) => l.recorded).join(",")}`);
    const owner = await human("owner");
    for (const d of drafts) {
      const t = await mainTable(d);
      assert.ok(Object.keys(t).every((p) => p.startsWith(d.unit)), `main of ${d.unit} names only its own paths`);
      const h = await owner.history(d.unit);
      assert.equal(h.landings[0].note, `${RUN} ${d.session}`, `history of ${d.unit} has this landing on top`);
    }
  } finally {
    for (const d of drafts) await close(d, true).catch(() => {});
    for (const u of EIGHT) await resetUnit(u);
  }
});

test("I2: two processes saving one draft — the second is told stale-draft", async () => {
  const U = ALL[0];
  const a = await open("editor", "i2", U);
  try {
    // A second "process" on the same draft: same draft id, its own idea of the revision.
    const c2 = await client("editor", "i2-other-process");
    const st = stateOf(a);
    writeFile(a, "index.html", readFile(a, "index.html") + "\n" + stamp(a, "first"));
    const s1 = await save(a);
    assert.ok(s1.ok);
    // The other process still believes the draft is at the old revision and writes the same file.
    const bytes = Buffer.from(`<h1>other process</h1>\n${stamp(a, "other")}`);
    const { hashBytes } = await import("../../../scripts/lib/draft.mjs");
    const h = hashBytes(bytes);
    await c2.blobPut(h, bytes);
    const r = await c2.save({ unit: U, draftId: st.draftId, draftRevision: st.draftRevision, changes: [{ path: `${U}index.html`, h, ct: "text/html", s: bytes.length }] });
    console.log(`I2: stale process answered ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(r.status, 409, "a stale save is refused, not merged");
    assert.match(r.error, /stale-draft/, r.error);
  } finally { await close(a, true).catch(() => {}); }
});
