// A person is one face, whichever of their addresses wrote.
//
// Drafts, landings and file stamps record `personId(<the token's label>)`, and a token's
// label is the address it was minted under. A person's primary address can change, and a
// git alias can mint too — the roster keeps those in `emails` precisely so attribution
// survives. Both face lookups matched the PRIMARY only, so a landing stamped under an
// alias rendered as "?" with no name beside work the same person did under their primary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const { personId, peopleApi, personFace, userByPersonId, personIdsOf } = W;

const ANA = {
  email: "ana@example.test", emails: ["ana@old.example.test", "ana@git.example.test"],
  name: "Ana", initials: "AN", color: "#123456",
};
const BO = { email: "bo@example.test", name: "Bo" };
const USERS = [ANA, BO];

test("every address a member is known by resolves to them", () => {
  assert.deepEqual(personIdsOf(ANA), [personId("ana@example.test"), personId("ana@old.example.test"), personId("ana@git.example.test")]);
  assert.equal(userByPersonId(USERS, personId("ana@old.example.test")), ANA);
  assert.equal(userByPersonId(USERS, personId("ANA@GIT.EXAMPLE.TEST")), ANA, "ids are case-blind, as the stamp was");
  assert.equal(userByPersonId(USERS, personId("bo@example.test")), BO);
  assert.equal(userByPersonId(USERS, personId("nobody@example.test")), null);
  assert.equal(userByPersonId(USERS, ""), null);
});

test("a draft owned under an alias carries the person's face", () => {
  const primary = personFace(USERS, personId("ana@example.test"));
  const alias = personFace(USERS, personId("ana@old.example.test"));
  assert.deepEqual(alias, primary);
  assert.equal(alias.name, "Ana");
  assert.equal(alias.initials, "AN");
  assert.deepEqual(personFace(USERS, personId("stranger@example.test")), { name: null, initials: null, color: null });
});

async function people(query) {
  const r = peopleApi(new URL("https://ws.example.test/__people?" + query), USERS);
  return (await r.json()).people;
}

test("/__people answers an alias id AS that id, so the chip that asked resolves", async () => {
  const aliasId = personId("ana@git.example.test");
  const got = await people(`ids=${aliasId}`);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, aliasId, "the id the caller carries, not the primary's");
  assert.equal(got[0].name, "Ana");
});

test("asked by primary AND alias, both ids come back on one person; by name, the primary id", async () => {
  const p = personId("ana@example.test"), a = personId("ana@old.example.test");
  const got = await people(`ids=${p},${a},${personId("bo@example.test")}`);
  assert.deepEqual(got.map((x) => x.id).sort(), [p, a, personId("bo@example.test")].sort());
  assert.ok(got.filter((x) => x.name === "Ana").length === 2);
  const byName = await people("names=Ana");
  assert.deepEqual(byName.map((x) => x.id), [p]);
});

test("a roster row with no aliases behaves exactly as before", async () => {
  const got = await people(`ids=${personId("bo@example.test")}`);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, personId("bo@example.test"));
  assert.equal(got[0].name, "Bo");
  assert.equal((await people("ids=zzz")).length, 0);
});
