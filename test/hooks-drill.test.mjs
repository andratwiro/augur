// test/hooks-drill.test.mjs — the hook end to end: a refused write in a shared checkout, a
// refused write into a read-only copy, and an edit inside a draft folder that is live at
// the draft address before the hook returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, readState } from "../scripts/lib/draft.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, "scripts", "hook.mjs");
const U = "/checkout/flow/";
const INDEX = remember("<h1>flow</h1>\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-hooks-"));
const REGISTRY = path.join(tmp(), "drafts.json");
process.env.AUGUR_DRAFTS_REGISTRY = REGISTRY;

// Async on purpose: the post hook calls the fixture server that lives in THIS process, so a
// blocking spawn would wait on an answer the event loop cannot give.
function hook(event, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, event], {
      env: { ...process.env, AUGUR_DRAFTS_REGISTRY: REGISTRY, AUGUR_NO_ADAPTERS: "1", ...env },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("pre: a prototype in a shared checkout is refused with the open command; the rest of the space is not", async () => {
  const space = tmp();
  fs.writeFileSync(path.join(space, "space.json"), JSON.stringify({ id: "alpha" }));
  const proto = await hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(space, "checkout", "prototypes", "flow", "index.html") }, cwd: space });
  assert.equal(proto.code, 2);
  assert.match(proto.err, /augur open checkout\/flow/);
  const tokens = await hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(space, "tokens", "tokens.css") }, cwd: space });
  assert.equal(tokens.code, 0);
  assert.equal(tokens.err, "");
  const off = await hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(space, "checkout", "prototypes", "flow", "index.html") }, cwd: space }, { AUGUR_HOOKS_OFF: "1" });
  assert.equal(off.code, 0, "AUGUR_HOOKS_OFF makes the hook inert");
  const garbage = spawnSync(process.execPath, [HOOK, "pre"], { input: "not json", encoding: "utf8", env: { ...process.env, AUGUR_DRAFTS_REGISTRY: REGISTRY } });
  assert.equal(garbage.status, 0, "an unreadable payload never blocks an editor");
});

test("post: an edit inside a draft folder is live at the draft address when the hook returns", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "hooks-1" });
  let closed = false;
  try {
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const dir = path.join(tmp(), "flow");
    const o = await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
    assert.equal(o.ok, true, JSON.stringify(o));
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "<h1>Flow, from the hook</h1>\n");
    const r = await hook("post", { tool_name: "Write", tool_input: { file_path: file }, cwd: dir }, { AUGUR_TOKEN: "tok" });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "", "a successful save is silent");
    const live = await (await fetch(`${srv.origin}${readState(dir).address}`)).text();
    assert.equal(live, "<h1>Flow, from the hook</h1>\n");
    // A write INSIDE the draft folder passes the pre hook too.
    assert.equal((await hook("pre", { tool_input: { file_path: file }, cwd: dir })).code, 0);
    // Without a token the hook says so, and says how, rather than pretending it saved.
    fs.writeFileSync(file, "<h1>again</h1>\n");
    const noToken = await hook("post", { tool_input: { file_path: file }, cwd: dir }, { AUGUR_TOKEN: "" });
    assert.equal(noToken.code, 2);
    assert.match(noToken.err, /augur connect/);
    // Off the instance: refused with the reason, and the draft is not lost — the next save carries it.
    await srv.close(); closed = true;
    const offline = await hook("post", { tool_input: { file_path: file }, cwd: dir }, { AUGUR_TOKEN: "tok" });
    assert.equal(offline.code, 2);
    assert.match(offline.err, /not saved/);
    assert.match(offline.err, /Nothing is lost/);
  } finally { if (!closed) await srv.close(); }
});

test("post: an edit outside every draft is nobody's business", async () => {
  const r = await hook("post", { tool_input: { file_path: path.join(tmp(), "notes.md") }, cwd: "/" });
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
});
