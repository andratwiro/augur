// Drill C — who may do what on /__unit, by cookie and by token.
//   viewer: every GET answers, every POST is refused as viewer-role.
//   editor and admin: identical on drafts (open, save, land, discard, restore).
//   a token from another workspace: refused, and refused without naming anything.
//   a signed-out request: 401.
import { test } from "node:test";
import { ORIGIN, UNITS, RUN } from "../env.mjs";
import { human, token } from "../persona.mjs";
import { assert, open, writeFile, readFile, stamp, save, land, close, resetUnit } from "./lib.mjs";

const U = UNITS()[3];
const origin = ORIGIN();

test("C1: a viewer reads everything and writes nothing", async () => {
  const v = await human("viewer");
  for (const verb of ["presence", "history"]) {
    const r = await v.json(`/__unit/${verb}?unit=${encodeURIComponent(U)}`, null, "GET");
    assert.equal(r.status, 200, `viewer GET ${verb}: ${JSON.stringify(r)}`);
  }
  assert.equal((await v.drafts()).status, 200, "viewer reads the drafts index");
  const o = await v.json("/__unit/open", { unit: U });
  assert.equal(o.status, 403); assert.equal(o.error, "viewer-role");
  assert.match(o.message || "", /look around/, "the refusal is a sentence a person can read");
  const d = await v.json("/__unit/discard", { unit: U, draftId: "nothing" });
  assert.equal(d.status, 403, "discard is refused before the draft id is even looked at");
  const l = await v.json("/__unit/land", { unit: U, draftId: "nothing", baseRevision: 1 });
  assert.equal(l.status, 403);
  const rs = await v.json("/__unit/restore", { unit: U, revision: 1 });
  assert.equal(rs.status, 403, "restore is a write");
});

test("C2: editor and admin are the same person on a draft", async () => {
  for (const who of ["editor", "owner"]) {
    const d = await open(who, `c2-${who}`, U);
    try {
      writeFile(d, "index.html", readFile(d, "index.html") + "\n" + stamp(d));
      assert.ok((await save(d)).ok);
      const l = await land(d);
      assert.ok(l.ok, `${who} lands: ${JSON.stringify(l)}`);
    } finally { await close(d, true).catch(() => {}); }
  }
  // Restore by the editor, from the browser: allowed for any non-viewer.
  const e = await human("editor");
  const h = await e.history(U);
  assert.ok(h.revision >= 3, `three landings recorded: ${JSON.stringify(h).slice(0, 200)}`);
  const r = await e.restore(U, 1, `${RUN} editor restores`);
  assert.equal(r.status, 200, `editor restore: ${JSON.stringify(r)}`);
  const h2 = await e.history(U);
  assert.equal(h2.landings[0].restoredFrom, 1, "history says where the restore came from");
  await resetUnit(U);
});

test("C3: another workspace's token is refused, and the refusal names nothing", async () => {
  const foreign = process.env.LIVE_FOREIGN_TOKEN;
  assert.ok(foreign, "LIVE_FOREIGN_TOKEN set");
  const r = await fetch(`${origin}/__unit/presence?unit=${encodeURIComponent(U)}`, { headers: { Authorization: `Bearer ${foreign}` } });
  const body = await r.json().catch(() => ({}));
  assert.ok([401, 403, 404].includes(r.status), `foreign token: ${r.status} ${JSON.stringify(body)}`);
  assert.ok(!JSON.stringify(body).includes(process.env.LIVE_SPACE), "the refusal does not name the workspace it protects");
  const o = await fetch(`${origin}/__unit/open`, { method: "POST", headers: { Authorization: `Bearer ${foreign}`, "content-type": "application/json", "X-Augur-Session": "foreign" }, body: JSON.stringify({ unit: U }) });
  assert.ok([401, 403, 404].includes(o.status), `foreign open: ${o.status}`);
});

test("C4: signed out is 401 with the door, not a page", async () => {
  const r = await fetch(`${origin}/__unit/presence?unit=${encodeURIComponent(U)}`);
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.ok(body.connect || body.docs || body.error, `the 401 carries the door: ${JSON.stringify(body).slice(0, 200)}`);
});

test("C5: a space-scoped token from pairing as an editor cannot reach admin routes", async () => {
  const t = await token("editor");
  assert.equal(t.space, process.env.LIVE_SPACE, "an editor's pairing mints a space-scoped token");
  const r = await fetch(`${origin}/__admin/users`, { headers: { Authorization: `Bearer ${t.token}` } });
  assert.ok([401, 403, 404].includes(r.status), `token on admin route: ${r.status}`);
  const s = await fetch(`${origin}/__publish/_state/export`, { headers: { Authorization: `Bearer ${t.token}` } });
  assert.ok([401, 403].includes(s.status), `space token on the state export: ${s.status}`);
});
