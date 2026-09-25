// `augur revert`: put a prototype back to an earlier landing, as a new landing.
// Against the real worker + unit object (test/fixtures/unit-server.mjs): land twice, revert,
// and main serves the first landing's bytes again while the history keeps all three.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, doSave, doLand } from "../scripts/lib/draft.mjs";
import { doRevert, pickRevertTarget, historyLines } from "../scripts/lib/revert.mjs";

const U = "/checkout/flow/";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-revert-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");

async function landText(srv, client, text, note) {
  const dir = path.join(tmp(), "d");
  const o = await doOpen({ client, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
  assert.equal(o.ok, true, JSON.stringify(o));
  fs.writeFileSync(path.join(dir, "index.html"), text);
  await doSave({ client, dir });
  const l = await doLand({ client, dir, note });
  assert.equal(l.ok, true, JSON.stringify(l));
  return l;
}

test("revert with no --to puts back the landing before the newest, as a new landing", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": remember("<h1>zero</h1>\n") } }), tenantId: "revert-1" });
  try {
    const client = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    await landText(srv, client, "<h1>good</h1>\n", "good");
    await landText(srv, client, "<h1>broken</h1>\n", "the bad one");
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /broken/);

    const r = await doRevert({ client, unit: U, note: "incident: broken heading" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>good<\/h1>/, "main serves the good landing again");

    const h = await client.history(U);
    assert.equal(h.landings[0].restoredFrom, r.to, "the newest landing says what it put back");
    assert.equal(h.landings[0].note, "incident: broken heading");
    assert.ok(h.landings.some((l) => l.note === "the bad one"), "the bad landing stays in the history");
    assert.match(historyLines(h)[0], /revert to/);
  } finally { await srv.close(); }
});

test("revert --to a named revision, and refusals that change nothing", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": remember("<h1>zero</h1>\n") } }), tenantId: "revert-2" });
  try {
    const client = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const first = await landText(srv, client, "<h1>one</h1>\n", "one");
    await landText(srv, client, "<h1>two</h1>\n", "two");
    await landText(srv, client, "<h1>three</h1>\n", "three");
    assert.equal((await doRevert({ client, unit: U, to: 99 })).error, "unknown-revision");
    const h = await client.history(U);
    assert.equal((await doRevert({ client, unit: U, to: h.landings[0].revision })).error, "already-live");
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /three/, "a refused revert changed nothing");
    const r = await doRevert({ client, unit: U, to: first.revision });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>one<\/h1>/);
  } finally { await srv.close(); }
});

test("pickRevertTarget: undo-last needs two landings", () => {
  assert.equal(pickRevertTarget({ landings: [] }).error, "no-landings");
  assert.equal(pickRevertTarget({ landings: [{ revision: 3 }] }).error, "nothing-before");
  assert.deepEqual(pickRevertTarget({ landings: [{ revision: 3 }, { revision: 2 }] }), { ok: true, revision: 2, current: 3 });
  assert.equal(pickRevertTarget({ landings: [{ revision: 3 }] }, "x").error, "bad-revision");
});

test("the CLI routes `augur revert`", () => {
  const cli = fs.readFileSync(new URL("../scripts/cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /revert: "revert\.mjs"/);
});
