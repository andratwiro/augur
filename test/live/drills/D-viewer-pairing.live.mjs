// Drill D — a viewer runs `augur connect` and approves the code in their own browser.
// The approval is refused as viewer-role, so no token exists for that person's terminal,
// and the terminal's claim keeps answering "pending" until the code dies.
import { test } from "node:test";
import { ORIGIN } from "../env.mjs";
import { human } from "../persona.mjs";
import { pairFor } from "../human.mjs";
import { assert } from "./lib.mjs";

test("D: a viewer's approval mints nothing", async () => {
  const v = await human("viewer");
  const r = await pairFor(v);
  assert.ok(r.refused, `expected a refusal, got ${JSON.stringify(r)}`);
  assert.equal(r.refused.status, 403);
  assert.equal(r.refused.error, "viewer-role");
  // And the terminal side is still pending, not errored: it would keep waiting.
  const start = await (await fetch(`${ORIGIN()}/__publish/_pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const claim = await fetch(`${ORIGIN()}/__publish/_pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: start.code, deviceSecret: start.deviceSecret }) });
  assert.equal(claim.status, 202, "an unapproved code is pending");
});
