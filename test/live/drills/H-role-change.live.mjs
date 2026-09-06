// Drill H — the roster changes under an open draft.
//   editor2 is demoted to viewer while drafting: the next save is refused as viewer-role;
//   the draft stays visible and another editor can land it. Then editor2 is put back.
//   Then editor2 is removed from the workspace mid-draft: their token stops working; the
//   draft still shows in presence; the owner can discard it. Then editor2 is put back.
import { test } from "node:test";
import { UNITS, RUN, addressOf } from "../env.mjs";
import { human, token } from "../persona.mjs";
import { assert, open, writeFile, readFile, stamp, save, draftIdOf, stateOf, close, resetUnit } from "./lib.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const U = UNITS()[5];
const ROSTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "roster.mjs");
const space = process.env.LIVE_SPACE;

test("H1: demoted to viewer mid-draft", async () => {
  const owner = await human("owner");
  const b = await open("editor2", "h1-b", U);
  const findings = [];
  try {
    writeFile(b, "index.html", readFile(b, "index.html") + "\n" + stamp(b, "before-demotion"));
    assert.ok((await save(b)).ok);
    const demote = await owner.admin({ op: "role", email: addressOf("editor2"), role: "viewer", space });
    findings.push({ what: "owner demotes editor2 to viewer", result: demote });
    assert.equal(demote.status, 200, JSON.stringify(demote));
    writeFile(b, "index.html", readFile(b, "index.html") + "\n" + stamp(b, "after-demotion"));
    const s = await save(b);
    findings.push({ what: "editor2's save after demotion (token minted as editor)", result: s });
    const p = await owner.presence(U);
    findings.push({ what: "presence still lists the draft", drafts: (p.drafts || []).map((d) => ({ id: d.id || d.draftId, session: d.session })) });
    const e1 = await human("editor");
    const landed = await e1.landFromBar(U, draftIdOf(b), stateOf(b).baseRevision, `${RUN} landed for the demoted`);
    findings.push({ what: "another editor lands the demoted person's draft", status: landed.status });
  } finally {
    const back = await owner.admin({ op: "role", email: addressOf("editor2"), role: "editor", space });
    findings.push({ what: "editor2 restored to editor", status: back.status });
    const again = await token("editor2", { fresh: true });
    findings.push({ what: "editor2's OLD token after demotion and re-promotion", answer: await probeToken(), rePaired: !again.refused });
    console.log("H1 findings:\n" + JSON.stringify(findings, null, 2));
    await close(b, true).catch(() => {});
  }
});

async function probeToken() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const f = path.join(process.env.LIVE_WORK || "", "tokens", "editor2.json");
  try {
    const t = JSON.parse(fs.readFileSync(f, "utf8"));
    const r = await fetch(`${process.env.LIVE_ORIGIN}/__unit/presence?unit=${encodeURIComponent(U)}`, { headers: { Authorization: `Bearer ${t.token}` } });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { error: String(e) }; }
}

test("H2: removed from the workspace mid-draft", async () => {
  const owner = await human("owner");
  const b = await open("editor2", "h2-b", U);
  const findings = [];
  try {
    writeFile(b, "index.html", readFile(b, "index.html") + "\n" + stamp(b, "before-removal"));
    assert.ok((await save(b)).ok);
    const rm = await owner.admin({ op: "remove", email: addressOf("editor2") });
    findings.push({ what: "owner removes editor2", result: rm });
    writeFile(b, "index.html", readFile(b, "index.html") + "\n" + stamp(b, "after-removal"));
    const s = await save(b);
    findings.push({ what: "removed person's terminal saves", result: s });
    const p = await owner.presence(U);
    findings.push({ what: "presence after removal", drafts: (p.drafts || []).map((d) => ({ id: d.id || d.draftId, session: d.session, name: d.name })) });
    const disc = await owner.discardFromBar(U, draftIdOf(b));
    findings.push({ what: "owner discards the removed person's draft", status: disc.status });
    // Their browser: the old cookie is dead, and a fresh sign-in ends at the workspace's
    // hand-off as a stranger would — a 404 with no session (no membership oracle).
    let signin;
    try { await human("editor2", { fresh: true }); signin = "signed in (unexpected)"; }
    catch (e) { signin = String(e.message); }
    findings.push({ what: "removed person tries to sign in again", result: signin });
  } finally {
    // Put editor2 back exactly as the roster tool wrote them (the remove wrote a tombstone),
    // and pair them afresh: a removal revokes every token they held.
    execFileSync(process.execPath, [ROSTER, "add"], { env: process.env, stdio: "pipe" });
    const again = await token("editor2", { fresh: true });
    findings.push({ what: "editor2 re-added and re-paired", rePaired: !again.refused });
    console.log("H2 findings:\n" + JSON.stringify(findings, null, 2));
    await close(b, true).catch(() => {});
    await resetUnit(U);
  }
});
