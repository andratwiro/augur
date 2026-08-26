// A credential that can erase a dead workspace and cannot publish a single byte.
//
// `E-purge-job`, step 2. The purge job has to reach `/__publish/_state/delete`, which needs
// star scope — and star scope can publish over every workspace's content, which is the
// boundary `test/isolation.test.mjs` exists to keep. A control plane holding one would be a
// control plane that could overwrite every tenant's site, and "hold it carefully" is not an
// answer.
//
// So a token record may carry `caps`, deny-by-default. The tests that matter are the
// refusals: a capability that only ever grants is not a capability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const purge = { label: "purge-job", space: "*", caps: ["purge"] };
const star = { label: "ci", space: "*" };

// ── the grant ────────────────────────────────────────────────────────────────

test("a purge token reaches exactly the two routes the job needs", () => {
  assert.equal(W.capabilityRefusal(purge, "_state", "delete"), null);
  assert.equal(W.capabilityRefusal(purge, "_state", "blob-gc"), null);
});

// ── the refusals, which are the whole point ──────────────────────────────────

test("A PURGE TOKEN CANNOT PUBLISH — this is the reason the capability exists", () => {
  for (const [space, op] of [
    ["delta", "commit"], ["delta", "blob"], ["delta", "check"], ["delta", "rollback"],
    ["fulla", "commit"], ["_instance", "config"],
  ]) {
    assert.equal(W.capabilityRefusal(purge, space, op), "capability-not-granted",
      `a purge token reached ${space}/${op}`);
  }
});

test("A PURGE TOKEN CANNOT READ THE ROSTER", () => {
  // `_instance/profiles` answers with every member's address and aliases, and it resolves
  // auth on its own path ahead of the shared gate — so it needs its own check, and this is
  // the test that says so.
  assert.equal(W.capabilityRefusal(purge, "_instance", "profiles"), "capability-not-granted");
});

test("a purge token cannot reach the OTHER _state routes — export, import, freeze", () => {
  // Sharing a space id is not sharing a capability. `_state/export` answers with the full
  // roster, the invite hashes and the publish-token hashes; `_state/import` overwrites all
  // of them. Neither is anything a purge job needs.
  for (const op of ["export", "import", "freeze", "asset"]) {
    assert.equal(W.capabilityRefusal(purge, "_state", op), "capability-not-granted", `purge reached _state/${op}`);
  }
});

// ── deny by default ──────────────────────────────────────────────────────────

test("AN UNKNOWN CAPABILITY GRANTS NOTHING — a typo fails shut, not open", () => {
  const typo = { label: "x", space: "*", caps: ["purgee"] };
  assert.equal(W.capabilityRefusal(typo, "_state", "delete"), "capability-not-granted");
  assert.equal(W.capabilityRefusal(typo, "delta", "commit"), "capability-not-granted");
});

test("AN EMPTY LIST IS NOT 'NO RESTRICTION' — it grants nothing at all", () => {
  const empty = { label: "x", space: "*", caps: [] };
  assert.equal(W.capabilityRefusal(empty, "_state", "delete"), "capability-not-granted");
  assert.equal(W.capabilityRefusal(empty, "delta", "commit"), "capability-not-granted");
});

test("a capability added later is closed to existing restricted tokens by default", () => {
  // The property that makes this a whitelist rather than a blacklist: a route that does not
  // exist yet is already refused, so shipping one cannot quietly widen a credential.
  assert.equal(W.capabilityRefusal(purge, "_state", "some-future-op"), "capability-not-granted");
  assert.equal(W.capabilityRefusal(purge, "_future", "anything"), "capability-not-granted");
});

// ── and the backwards compatibility, which has to be exact ───────────────────

test("EVERY TOKEN THAT EXISTS TODAY IS UNRESTRICTED, unchanged", () => {
  // No token anywhere carries `caps`. If this check restricted them, every publish on every
  // instance would stop at once — so "absent means unrestricted" is not a convenience, it is
  // the thing that makes this landable.
  for (const [space, op] of [["delta", "commit"], ["_state", "delete"], ["_instance", "profiles"], ["_state", "export"]]) {
    assert.equal(W.capabilityRefusal(star, space, op), null, `a star token was refused ${space}/${op}`);
    assert.equal(W.capabilityRefusal({ label: "s", space: "delta" }, space, op), null);
  }
});

test("a MALFORMED caps value is treated as absent, not as empty", () => {
  // A corrupt record must not silently disable a working credential — that is an outage
  // nobody could diagnose. It cannot grant anything either: grants come only from names
  // that match the table, and a string, a number or an object matches nothing.
  for (const caps of ["purge", 1, {}, true, null]) {
    assert.equal(W.capabilityRefusal({ label: "x", space: "*", caps }, "delta", "commit"), null);
  }
});
