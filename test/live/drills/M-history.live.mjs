// Drill M — a landing from the draft bar and a landing from the terminal are the same
// kind of row: same person id when it is the same person, session label kept, note kept,
// faces resolved for members of the roster.
import { test } from "node:test";
import { UNITS, RUN } from "../env.mjs";
import { human } from "../persona.mjs";
import { assert, open, writeFile, readFile, stamp, save, land, draftIdOf, stateOf, close, resetUnit } from "./lib.mjs";

const U = UNITS()[6];

test("M: bar and terminal write one shape of history", async () => {
  const e = await human("editor");
  const a = await open("editor", "m-terminal", U);
  const b = await open("editor", "m-bar", U);
  try {
    writeFile(a, "index.html", readFile(a, "index.html") + "\n" + stamp(a));
    assert.ok((await save(a)).ok);
    const la = await land(a, `${RUN} from the terminal`);
    assert.ok(la.ok, JSON.stringify(la));
    // b is now behind; sync it, then land from the bar as the same person.
    writeFile(b, "notes-m.txt", stamp(b));
    assert.ok((await save(b)).ok);
    const { doSync } = await import("../../../scripts/lib/draft.mjs");
    const s = await doSync({ client: b.client, dir: b.dir });
    assert.ok(s.ok, JSON.stringify(s));
    const lb = await e.landFromBar(U, draftIdOf(b), stateOf(b).baseRevision, `${RUN} from the bar`);
    assert.equal(lb.status, 200, JSON.stringify(lb));
    const h = await e.history(U);
    const [bar, term] = h.landings;
    console.log("M rows:\n" + JSON.stringify([bar, term], null, 2));
    assert.equal(bar.note, `${RUN} from the bar`); assert.equal(term.note, `${RUN} from the terminal`);
    assert.equal(bar.by, term.by, "same person id from the bar and from the terminal");
    assert.equal(term.session, "m-terminal", "the terminal's session label is on its row");
    assert.equal(bar.session, "browser", "the bar's row says browser");
    assert.equal(bar.name, term.name, "same face");
    assert.ok(bar.name, "the face resolves to a roster name");
  } finally {
    await close(a, true).catch(() => {}); await close(b, true).catch(() => {});
    await resetUnit(U);
  }
});
