// Drill G — another editor lands, and then discards, a draft that is not theirs.
// The design has no ownership on drafts (any member may accept an agent's draft from the
// bar), so this drill RECORDS what happens rather than asserting a policy: what history
// says about who landed, and whether the owner's next save notices the draft is gone.
import { test } from "node:test";
import { UNITS, RUN } from "../env.mjs";
import { human } from "../persona.mjs";
import { assert, open, writeFile, readFile, stamp, save, draftIdOf, stateOf, close, resetUnit } from "./lib.mjs";

const U = UNITS()[4];

test("G: editor2 lands editor's draft from the bar; editor discards editor2's", async () => {
  const a = await open("editor", "g-a", U);
  const b = await open("editor2", "g-b", U);
  const findings = [];
  try {
    writeFile(a, "index.html", readFile(a, "index.html") + "\n" + stamp(a));
    assert.ok((await save(a)).ok);
    const e2 = await human("editor2");
    const landed = await e2.landFromBar(U, draftIdOf(a), stateOf(a).baseRevision, `${RUN} landed by editor2`);
    findings.push({ what: "editor2 lands editor's draft from the bar", status: landed.status, body: landed });
    const h = await e2.history(U);
    findings.push({ what: "history row for that landing", row: h.landings[0] });
    // Whose face is on the landing: the person who pressed Land, not the draft's owner.
    if (landed.status === 200) {
      assert.equal(h.landings[0].draftId, draftIdOf(a), "the row names a's draft");
      findings.push({ landedBy: h.landings[0].by, draftOwnerSession: "g-a" });
    }
    // a's terminal, unaware, saves again into a draft that has been landed and closed.
    writeFile(a, "index.html", readFile(a, "index.html") + "\n" + stamp(a, "after-land"));
    const s2 = await save(a);
    findings.push({ what: "owner's save after someone else landed the draft", result: s2 });

    // editor discards editor2's untouched draft from the bar.
    const e1 = await human("editor");
    const disc = await e1.discardFromBar(U, draftIdOf(b));
    findings.push({ what: "editor discards editor2's draft", status: disc.status, body: disc });
    writeFile(b, "index.html", readFile(b, "index.html") + "\n" + stamp(b, "after-discard"));
    const sb = await save(b);
    findings.push({ what: "editor2's save after their draft was discarded by someone else", result: sb });
  } finally {
    console.log("G findings:\n" + JSON.stringify(findings, null, 2));
    await close(a, true).catch(() => {}); await close(b, true).catch(() => {});
    await resetUnit(U);
  }
});
