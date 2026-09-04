// test/drafts-drill.test.mjs — the VERIFY from docs/drafts-that-land.md §11, automated:
// two sessions on one prototype; both see each other at open; both land; the second is
// refused, syncs, lands. Then a killed session resumes from its folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember, sha, liveNow } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, doSave, doLand, doSync, readState } from "../scripts/lib/draft.mjs";

const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>\n<p>one</p>\n<p>two</p>\n");
const CSS = remember("h1{color:red}\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-drill-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");

test("two sessions, one prototype: see each other, land, refuse, sync, land", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX, "a.css": CSS } }), tenantId: "drill-1" });
  try {
    const mk = (session) => unitClient({ origin: srv.origin, token: "tok", space: "alpha", session });
    const a = mk("session a"), b = mk("session b");
    const root = tmp();
    const dirA = path.join(root, "a"), dirB = path.join(root, "b");
    const oa = await doOpen({ client: a, unit: U, dir: dirA, origin: srv.origin, space: "alpha", session: "session a", now: new Date().toISOString() });
    const ob = await doOpen({ client: b, unit: U, dir: dirB, origin: srv.origin, space: "alpha", session: "session b", now: new Date().toISOString() });
    assert.equal(oa.ok, true, JSON.stringify(oa));
    assert.deepEqual(ob.others.map((o) => o.session), ["session a"], "the second opener is told about the first");

    // A edits the heading and lands. B edits the stylesheet.
    fs.writeFileSync(path.join(dirA, "index.html"), INDEX.replace("<h1>flow</h1>", "<h1>Flow</h1>"));
    await doSave({ client: a, dir: dirA });
    const draftA = await fetch(`${srv.origin}${readState(dirA).address}`);
    assert.match(await draftA.text(), /<h1>Flow<\/h1>/, "A's draft address serves A's bytes at once");
    const mainBefore = await (await fetch(`${srv.origin}${U}`)).text();
    assert.match(mainBefore, /<h1>flow<\/h1>/, "main has not moved");
    const la = await doLand({ client: a, dir: dirA, note: "heading" });
    assert.equal(la.ok, true, JSON.stringify(la));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>Flow<\/h1>/, "main moved on land");

    fs.writeFileSync(path.join(dirB, "a.css"), "h1{color:blue}\n");
    await doSave({ client: b, dir: dirB });
    const refused = await doLand({ client: b, dir: dirB, note: "colour" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "main-moved");

    const synced = await doSync({ client: b, dir: dirB });
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.deepEqual(synced.taken, ["index.html"]);
    assert.deepEqual(synced.conflicts, []);
    assert.match(fs.readFileSync(path.join(dirB, "index.html"), "utf8"), /<h1>Flow<\/h1>/);
    const lb = await doLand({ client: b, dir: dirB, note: "colour" });
    assert.equal(lb.ok, true, JSON.stringify(lb));
    const live = liveNow(srv.env);
    assert.equal(live.files[`${U}a.css`].h, sha("h1{color:blue}\n"));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>Flow<\/h1>/, "B's landing kept A's heading");
    assert.equal(live.version, 7, "two landings, two publish versions");
  } finally { await srv.close(); }
});

test("a killed session resumes from its folder: the draft is on the server with every save", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "drill-2" });
  try {
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const dir = path.join(tmp(), "flow");
    await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>half done</h1>\n");
    await doSave({ client: c, dir });
    // "killed": a fresh client with no memory but the folder
    const again = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const st = readState(dir);
    const r = await fetch(`${srv.origin}${st.address}`);
    assert.equal(await r.text(), "<h1>half done</h1>\n");
    const landed = await doLand({ client: again, dir, note: "" });
    assert.equal(landed.ok, true, JSON.stringify(landed));
  } finally { await srv.close(); }
});
