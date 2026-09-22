// `augur land` asks a prototype's criteria runner first, and only a clear "refused" (2)
// stops a landing: no criteria, no runner, or a runner that breaks all land as before.
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
test("no runner, a broken runner, or the escape hatch never block", () => {
  assert.equal(criteriaGate(folder(true), { run: runner(null, Object.assign(new Error("x"), { code: "ENOENT" })).run }).ok, true);
  assert.equal(criteriaGate(folder(true), { run: runner(1).run }).ok, true);
  const { run, calls } = runner(2);
  assert.equal(criteriaGate(folder(true), { run, env: { AUGUR_SKIP_CRITERIA: "1" } }).ok, true);
  assert.equal(calls.length, 0);
});
