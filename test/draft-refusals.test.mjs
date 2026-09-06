// test/draft-refusals.test.mjs — a refusal the server gives on a blob route reaches the
// agent as that refusal, with the server's words, and never as "the network is down".
//
// Found live: a member demoted to viewer while drafting saved again and was told
// `network — blob upload failed: 403`, which the hook turns into "unreachable, nothing is
// lost, the next save carries every change". Nothing was unreachable and no next save was
// going to carry anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unitClient, doOpen, doSave, writeState, readState } from "../scripts/lib/draft.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-refusal-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");
const U = "/checkout/flow/";

/** A fetch that answers every blob PUT with a 403 the way the worker's gate does. */
function withFetch(answer, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => answer(String(url), init || {});
  return fn().finally(() => { globalThis.fetch = real; });
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a 403 on the blob upload is a refusal with the server's sentence, not a network failure", async () => {
  const dir = path.join(tmp(), "flow");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>edited</h1>");
  writeState(dir, { origin: "https://x.test", space: "alpha", unit: U, draftId: "d1", session: "s", baseRevision: 1, draftRevision: 0, table: {}, baseTable: {} });
  const client = unitClient({ origin: "https://x.test", token: "tok", space: "alpha", session: "s" });
  const r = await withFetch((url) => {
    if (/\/blob\//.test(url)) return json(403, { error: "viewer-role", message: "This account can look around but not publish." });
    return json(200, {});
  }, () => doSave({ client, dir }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error, "viewer-role");
  assert.match(r.message, /look around/);
  assert.equal(readState(dir).draftRevision, 0, "nothing on disk moved");
});

test("a refused blob fetch at open is the refusal, and the folder is still cleaned up", async () => {
  const dir = path.join(tmp(), "flow");
  const client = unitClient({ origin: "https://x.test", token: "tok", space: "alpha", session: "s" });
  const r = await withFetch((url, init) => {
    if (/__unit\/open$/.test(url)) return json(200, { draftId: "d2", baseRevision: 1, address: `${U}@d2/`, table: { [`${U}index.html`]: { h: "a".repeat(64), ct: "text/html", s: 3 } }, presence: [] });
    if (/\/blob\//.test(url)) return json(403, { error: "forbidden", message: "This publish token is not recognised here — it may have been revoked. Run `augur connect` again." });
    return json(200, { closed: true });
  }, () => doOpen({ client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s", now: "2026-09-06T12:00:00.000Z" }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.message, /augur connect/);
  assert.equal(fs.existsSync(dir), false, "the half-made folder is gone");
});

test("a fetch that throws is still the network", async () => {
  const dir = path.join(tmp(), "flow");
  const client = unitClient({ origin: "https://x.test", token: "tok", space: "alpha", session: "s" });
  const r = await withFetch(() => { throw new Error("getaddrinfo ENOTFOUND x.test"); },
    () => doOpen({ client, unit: U, dir, origin: "https://x.test", space: "alpha", session: "s", now: "2026-09-06T12:00:00.000Z" }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
  assert.match(r.message, /ENOTFOUND/);
});

test("a contended manifest is landed again, a few times, before anyone is told", async () => {
  const dir = path.join(tmp(), "flow");
  fs.mkdirSync(dir, { recursive: true });
  writeState(dir, { origin: "https://x.test", space: "alpha", unit: U, draftId: "d3", session: "s", baseRevision: 1, draftRevision: 0, table: {}, baseTable: {} });
  const { doLand, LAND_RETRIES } = await import("../scripts/lib/draft.mjs");
  let lands = 0;
  const client = {
    save: async () => ({ draftRevision: 0, table: {} }),
    land: async () => { lands++; return lands < 3 ? { status: 503, error: "manifest-contended" } : { revision: 2, url: "https://x.test/checkout/flow/" }; },
  };
  const r = await doLand({ client, dir, note: "n" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lands, 3, "landed on the third try");
  // And a manifest that stays contended is reported, after the retries.
  lands = 0;
  const stuck = { ...client, land: async () => { lands++; return { status: 503, error: "manifest-contended" }; } };
  const r2 = await doLand({ client: stuck, dir, note: "n" });
  assert.equal(r2.ok, false); assert.equal(r2.error, "manifest-contended");
  assert.equal(lands, LAND_RETRIES + 1);
});
