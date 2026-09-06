// Drill L — what another member's browser sees while an agent works.
//   the drafts index (what gallery chips read) lists the open draft with a face;
//   the unit's socket announces open, save, land as they happen;
//   the prototype page carries the draft bar script for a member.
import { test } from "node:test";
import { UNITS, ORIGIN } from "../env.mjs";
import { human, token } from "../persona.mjs";
import { assert, open, writeFile, readFile, stamp, save, land, draftIdOf, close, resetUnit, until } from "./lib.mjs";

const U = UNITS()[9];

function subscribe(unit, bearer) {
  const url = `${ORIGIN().replace(/^http/, "ws")}/__unit/socket?unit=${encodeURIComponent(unit)}`;
  const events = [];
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}`, "X-Augur-Session": "browser-tab" } });
  ws.addEventListener("message", (m) => { try { events.push(JSON.parse(m.data)); } catch (e) { events.push({ raw: String(m.data) }); } });
  const opened = new Promise((res, rej) => { ws.addEventListener("open", () => res(true)); ws.addEventListener("error", (e) => rej(new Error(`socket: ${e.message || e}`))); });
  return { ws, events, opened, close: () => ws.close() };
}

test("L: chips, the socket and the draft bar", async () => {
  const owner = await human("owner");
  const t = await token("owner");
  const sub = subscribe(U, t.token);
  await sub.opened;
  const d = await open("editor", "l-agent", U);
  try {
    await until(() => sub.events.some((e) => e.t === "open" && e.draftId === draftIdOf(d)), { what: "socket announces open", timeoutMs: 10000 });
    const idx = await owner.drafts();
    const rows = idx.units && idx.units[U];
    assert.ok(Array.isArray(rows) && rows.some((r) => (r.id || r.draftId) === draftIdOf(d)), `the drafts index lists the draft under ${U}: ${JSON.stringify(idx).slice(0, 300)}`);
    const row = rows.find((r) => (r.id || r.draftId) === draftIdOf(d));
    assert.equal(row.session, "l-agent");
    assert.ok(row.name && row.initials, `the chip has a face: ${JSON.stringify(row)}`);
    writeFile(d, "index.html", readFile(d, "index.html") + "\n" + stamp(d));
    assert.ok((await save(d)).ok);
    await until(() => sub.events.some((e) => e.t === "save" && e.draftId === draftIdOf(d)), { what: "socket announces save", timeoutMs: 10000 });
    // A member's prototype page carries the draft bar's script; a draft address names whose draft it is.
    const page = await owner.get(`${U}`);
    const html = await page.text();
    assert.ok(/__unit\/|draft/i.test(html), "the member's page carries the draft chrome");
    const l = await land(d);
    assert.ok(l.ok, JSON.stringify(l));
    await until(() => sub.events.some((e) => e.t === "land"), { what: "socket announces land", timeoutMs: 10000 });
    const after = await owner.drafts();
    assert.ok(!((after.units || {})[U] || []).some((r) => (r.id || r.draftId) === draftIdOf(d)), "the chip is gone after landing");
    console.log("L socket events:", JSON.stringify(sub.events));
  } finally {
    sub.close();
    await close(d, true).catch(() => {});
    await resetUnit(U);
  }
});
