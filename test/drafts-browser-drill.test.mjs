// test/drafts-browser-drill.test.mjs — docs/drafts-that-land.md §5, automated: an agent
// opens and saves from the terminal; a member's browser sees the chip, opens the draft
// address with the bar on it, lands it from the bar; the chip is gone and history says who.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember, cookieFor, ADA_MEMBER, VERA } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, doSave, readState } from "../scripts/lib/draft.mjs";

const U = "/checkout/flow/";
const INDEX = remember("<!doctype html><html><body><h1>flow</h1>\n<p>one</p>\n</body></html>");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-bdrill-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");
const idOf = (address) => /@([a-z0-9]{6})\/$/.exec(address)[1];
const asJson = async (r) => ({ status: r.status, body: await r.json() });

test("a member's browser: chip, bar, land from the bar, history names them", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "bdrill-1", users: [ADA_MEMBER, VERA] });
  try {
    // An agent opens and saves from the terminal.
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "checkout pass" });
    const dir = tmp();
    const o = await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "checkout pass", now: new Date().toISOString() });
    assert.equal(o.ok, true, JSON.stringify(o));
    fs.writeFileSync(path.join(dir, "index.html"), INDEX.replace("<h1>flow</h1>", "<h1>Flow</h1>"));
    assert.equal((await doSave({ client: c, dir })).ok, true);
    const address = readState(dir).address, draftId = idOf(address);

    const ada = { Cookie: await cookieFor(srv.env, ADA_MEMBER) };
    const vera = { Cookie: await cookieFor(srv.env, VERA) };

    // The gallery's chip: one draft on this unit, with a face and a session label.
    const idx = await asJson(await fetch(`${srv.origin}/__unit/drafts`, { headers: ada }));
    assert.equal(idx.status, 200);
    assert.equal(idx.body.units[U].length, 1);
    assert.equal(idx.body.units[U][0].session, "checkout pass");
    assert.equal(idx.body.units[U][0].name, "Ada");
    assert.equal(idx.body.units[U][0].id, draftId);

    // A stranger at the draft address: the bytes as saved, no bar, nothing about people.
    const anon = await fetch(`${srv.origin}${address}`);
    const anonText = await anon.text();
    assert.match(anonText, /<h1>Flow<\/h1>/);
    assert.doesNotMatch(anonText, /__drafts\/drafts\.js/);

    // A member at the draft address: the same bytes, plus the bar's boot naming this draft.
    const page = await (await fetch(`${srv.origin}${address}`, { headers: ada })).text();
    assert.match(page, /<h1>Flow<\/h1>/);
    assert.match(page, /<script defer src="\/__drafts\/drafts\.js"><\/script><\/body>/);
    const boot = JSON.parse(/window\.__augurDraft=(\{.*?\})<\/script>/.exec(page)[1]);
    assert.equal(boot.unit, U);
    assert.equal(boot.draft, draftId);
    assert.equal(boot.me.id, idx.body.units[U][0].owner, "the bar knows the viewer is the draft's owner");
    assert.equal(boot.me.role, "editor");
    const main = await (await fetch(`${srv.origin}${U}`, { headers: ada })).text();
    assert.match(main, /<h1>flow<\/h1>/, "main has not moved");
    assert.match(main, /"draft":null/, "the bar on main names no draft");

    // What the bar reads: the draft's card.
    const card = await asJson(await fetch(`${srv.origin}/__unit/draft?unit=${encodeURIComponent(U)}&draft=${draftId}`, { headers: ada }));
    assert.equal(card.status, 200);
    assert.equal(card.body.baseRevision, 1);
    assert.equal(card.body.files, 1);
    assert.equal(card.body.name, "Ada");

    // A viewer may look at all of that and may not land.
    assert.equal((await fetch(`${srv.origin}/__unit/presence?unit=${encodeURIComponent(U)}`, { headers: vera })).status, 200);
    const veraLands = await asJson(await fetch(`${srv.origin}/__unit/land`, { method: "POST", headers: { ...vera, "content-type": "application/json" },
      body: JSON.stringify({ unit: U, draftId, baseRevision: card.body.baseRevision }) }));
    assert.equal(veraLands.status, 403);

    // Ada lands from the bar.
    const landed = await asJson(await fetch(`${srv.origin}/__unit/land`, { method: "POST", headers: { ...ada, "content-type": "application/json" },
      body: JSON.stringify({ unit: U, draftId, baseRevision: card.body.baseRevision, note: "looked good" }) }));
    assert.equal(landed.status, 200, JSON.stringify(landed.body));
    assert.equal(landed.body.ok, true);
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>Flow<\/h1>/, "the real URL moved");

    // The chip is gone; history says who, from where, and why.
    const after = await asJson(await fetch(`${srv.origin}/__unit/drafts`, { headers: ada }));
    assert.deepEqual(after.body.units, {});
    const h = await asJson(await fetch(`${srv.origin}/__unit/history?unit=${encodeURIComponent(U)}`, { headers: ada }));
    assert.equal(h.body.landings[0].note, "looked good");
    assert.equal(h.body.landings[0].name, "Ada");
    assert.equal(h.body.landings[0].session, "browser");
    assert.equal(h.body.landings[1].by, "live");
  } finally { await srv.close(); }
});

test("restore from the history panel lands an earlier revision as a new one", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "bdrill-2", users: [ADA_MEMBER] });
  try {
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const dir = tmp();
    await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, "index.html"), INDEX.replace("<p>one</p>", "<p>two</p>"));
    await doSave({ client: c, dir });
    const draftId = idOf(readState(dir).address);
    const ada = { Cookie: await cookieFor(srv.env, ADA_MEMBER), "content-type": "application/json" };
    const card = (await asJson(await fetch(`${srv.origin}/__unit/draft?unit=${encodeURIComponent(U)}&draft=${draftId}`, { headers: ada }))).body;
    assert.equal((await fetch(`${srv.origin}/__unit/land`, { method: "POST", headers: ada, body: JSON.stringify({ unit: U, draftId, baseRevision: card.baseRevision, note: "two" }) })).status, 200);
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<p>two<\/p>/);
    const restored = await asJson(await fetch(`${srv.origin}/__unit/restore`, { method: "POST", headers: ada, body: JSON.stringify({ unit: U, revision: 1, note: "restored revision 1" }) }));
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<p>one<\/p>/, "revision 1's bytes are live again");
    const h = (await asJson(await fetch(`${srv.origin}/__unit/history?unit=${encodeURIComponent(U)}`, { headers: ada }))).body;
    assert.equal(h.revision, 3, "history is never rewritten: the restore is a third landing");
    assert.equal(h.landings[0].restoredFrom, 1);
    assert.equal(h.landings[0].name, "Ada");
  } finally { await srv.close(); }
});
