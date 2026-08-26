// Telling a platform write from a person's, without guessing.
//
// `F-seed-vs-real-provenance-marker`. A provisioned workspace arrives carrying seed
// prototypes, written on somebody's behalf before they have done anything. The onboarding
// floor-check ("has this workspace published anything REAL yet") and the future "Edited
// by" line both have to tell those versions from a person's.
//
// The whole thing turns on ONE property: the sentinel must not be forgeable. `publish.mjs`
// stamps `source.actor` from `process.env.USER`, an environment variable — so a sentinel
// nobody enforces is a string anybody can set, and a floor-check reading it can be walked
// straight past.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SEED_ACTOR, RESERVED_ACTOR_PREFIX, sanitizeActor, isSeedSource, seedSource } from "../src/provenance.mjs";

test("a platform write is recognised, by either the actor or the flag", () => {
  assert.equal(isSeedSource(seedSource()), true);
  assert.equal(isSeedSource({ actor: SEED_ACTOR }), true);
  assert.equal(isSeedSource({ seed: true }), true, "a reader that only knows the flag must still work");
  assert.equal(isSeedSource({ actor: "augur:migration" }), true, "a second platform actor is in the namespace, not a special case");
});

test("a person's publish is never mistaken for one", () => {
  for (const actor of ["lovelace", "hopper", "", "seed", "augursomething", "AUGUR", "not-augur:seed"]) {
    assert.equal(isSeedSource({ actor }), false, `${JSON.stringify(actor)} was read as a platform write`);
  }
  assert.equal(isSeedSource(null), false);
  assert.equal(isSeedSource({}), false);
  assert.equal(isSeedSource({ seed: "true" }), false, "a truthy string is not the flag");
});

// ── the property the whole marker rests on ───────────────────────────────────

test("THE SENTINEL CANNOT BE CLAIMED BY A REAL PUBLISH", () => {
  // $USER is whatever the shell says it is. Without this, "was this seeded?" is answered
  // by a string anybody can set.
  assert.equal(sanitizeActor("augur:seed"), "seed");
  assert.equal(sanitizeActor("AUGUR:SEED"), "SEED", "the check must not be case-sensitive");
  assert.equal(sanitizeActor("augur:anything-at-all"), "anything-at-all");
  assert.equal(isSeedSource({ actor: sanitizeActor("augur:seed") }), false);
});

test("sanitizing does not refuse the publish, it just declines the claim", () => {
  // A person whose $USER genuinely starts with the prefix should still be able to publish.
  // Throwing would turn a naming collision into an outage.
  assert.equal(sanitizeActor("augur:hopper"), "hopper");
  assert.equal(sanitizeActor("augur:"), "", "a bare prefix leaves no actor, which is the same as none");
});

test("ordinary actors pass through untouched", () => {
  for (const a of ["hopper", "ada.lovelace", "runner", "user with spaces"]) {
    assert.equal(sanitizeActor(a), a);
  }
  assert.equal(sanitizeActor(undefined), "");
  assert.equal(sanitizeActor(null), "");
  assert.equal(sanitizeActor(42), "42");
});

test("the reserved prefix contains a colon, which no POSIX username may", () => {
  // That is why an ordinary $USER cannot collide by accident: landing in the namespace
  // takes deliberate effort, so stripping it can never surprise a real person.
  assert.ok(RESERVED_ACTOR_PREFIX.includes(":"));
  assert.ok(SEED_ACTOR.startsWith(RESERVED_ACTOR_PREFIX));
});

// ── enforced at the write, not checked at the read ───────────────────────────

test("publish.mjs stamps a SANITIZED actor", () => {
  // A read-side check has to be remembered by every future consumer of provenance, and
  // this one cannot be. If this assertion ever fails, the sentinel is forgeable again and
  // every floor-check built on it is decoration.
  const src = fs.readFileSync(fileURLToPath(new URL("../scripts/publish.mjs", import.meta.url)), "utf8");
  assert.match(src, /import \{ sanitizeActor \} from "\.\.\/src\/provenance\.mjs"/);
  assert.match(src, /actor: sanitizeActor\(process\.env\.USER\)/);
  assert.ok(!/actor: process\.env\.USER/.test(src), "an unsanitized actor stamp survives somewhere");
});
