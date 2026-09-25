// `augur land` asks a prototype's criteria runner first. A clear "refused" (2) and a runner
// that breaks both stop a landing; no criteria lands as before; no runner lands, marked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { criteriaGate } from "../scripts/lib/criteria-gate.mjs";

function folder(withCriteria){
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  if(withCriteria){ fs.mkdirSync(path.join(d, "oracle")); fs.writeFileSync(path.join(d, "oracle", "oracle.json"), "{}"); }
  return d;
}
const runner = (status, error) => { const calls = []; const run = (cmd, args) => { calls.push([cmd, ...args]); return { status, error }; }; return { run, calls }; };

test("no criteria: the runner is never asked", () => {
  const { run, calls } = runner(2);
  assert.deepEqual(criteriaGate(folder(false), { run }), { ok: true, ran: false });
  assert.equal(calls.length, 0);
});
test("criteria held: land goes ahead, and the runner was asked about this folder", () => {
  const d = folder(true), { run, calls } = runner(0);
  assert.deepEqual(criteriaGate(d, { run }), { ok: true, ran: true });
  assert.deepEqual(calls[0], ["oracle", "land-check", d]);
});
test("refused (2) stops the landing", () => {
  assert.equal(criteriaGate(folder(true), { run: runner(2).run }).ok, false);
});
test("a runner that breaks refuses the landing — a crashed checker is not a pass", () => {
  for (const [status, error] of [[1, undefined], [null, Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })], [137, undefined]]) {
    const g = criteriaGate(folder(true), { run: runner(status, error).run });
    assert.equal(g.ok, false, `status ${status} ${error ? error.code : ""} must refuse`);
    assert.equal(g.why, "runner-failed");
  }
});
test("no runner on this machine still lands, but marked unchecked", () => {
  const g = criteriaGate(folder(true), { run: runner(null, Object.assign(new Error("x"), { code: "ENOENT" })).run });
  assert.equal(g.ok, true);
  assert.match(g.unchecked, /not checked/);
});
test("the escape hatch lands without asking the runner, and is marked", () => {
  const { run, calls } = runner(2);
  const g = criteriaGate(folder(true), { run, env: { AUGUR_SKIP_CRITERIA: "1" } });
  assert.equal(g.ok, true);
  assert.match(g.unchecked, /AUGUR_SKIP_CRITERIA/);
  assert.equal(calls.length, 0);
});
test("land writes an unchecked landing into its note, and refuses a broken runner in words a person can act on", () => {
  const src = fs.readFileSync(new URL("../scripts/land.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(gate\.unchecked\) note = /);
  assert.match(src, /runner-failed[\s\S]*AUGUR_SKIP_CRITERIA=1/);
});
