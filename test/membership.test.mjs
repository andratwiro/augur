// Per-space membership. The whole design rests on one asymmetry that is easy to get
// wrong and expensive to get wrong: an ABSENT membership entry means "every space",
// and an EMPTY one means "no space". If those two ever share a spelling, either every
// existing instance locks its whole team out on the first deploy, or a deliberate
// removal silently grants everything. Most of these tests exist to hold that line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const SPACES = [
  { id: "alpha", name: "Alpha", default: true, base: "" },
  { id: "beta", name: "Beta", base: "/beta" },
  { id: "gamma", name: "Gamma", base: "/gamma" },
];
const ADMIN = { email: "a@example.test", name: "A", role: "admin" };
const EDITOR = { email: "e@example.test", name: "E", role: "editor" };

test("no membership recorded means every space, at the global role", () => {
  assert.equal(W.membershipOf(EDITOR), null);
  assert.equal(W.isMemberOf(EDITOR, "beta"), true);
  assert.equal(W.roleIn(EDITOR, "beta"), "editor");
  assert.deepEqual(W.spacesFor(EDITOR, SPACES).map((s) => s.id), ["alpha", "beta", "gamma"]);
});

test("a recorded membership narrows the space list and carries a per-space role", () => {
  const [u] = W.applySpaces([EDITOR], { "e@example.test": { alpha: "admin", gamma: "viewer" } });
  assert.deepEqual(W.spacesFor(u, SPACES).map((s) => s.id), ["alpha", "gamma"]);
  assert.equal(W.isMemberOf(u, "beta"), false);
  assert.equal(W.roleIn(u, "alpha"), "admin", "admin here");
  assert.equal(W.roleIn(u, "gamma"), "viewer", "viewer there");
  assert.equal(W.roleIn(u, "beta"), "editor", "a non-member has no elevated role anywhere");
});

test("an empty membership map is member of nothing — it is not read as 'all'", () => {
  const [u] = W.applySpaces([EDITOR], { "e@example.test": {} });
  assert.deepEqual(W.spacesFor(u, SPACES), []);
  assert.equal(W.isMemberOf(u, "alpha"), false);
});

test("a corrupt overlay cannot invent a role or a membership", () => {
  const [u] = W.applySpaces([EDITOR], { "e@example.test": { alpha: "superuser", beta: null } });
  assert.equal(W.roleIn(u, "alpha"), "editor", "an unrecognised role coerces, it does not elevate");
  assert.equal(W.isMemberOf(u, "alpha"), true);
  assert.equal(W.isMemberOf(u, "beta"), true, "a junk value is still an entry — presence is membership");
  assert.equal(W.roleIn(u, "beta"), "editor");
  const [v] = W.applySpaces([EDITOR], { "e@example.test": "everything" });
  assert.equal(W.membershipOf(v), null, "a non-object entry is ignored entirely, not treated as empty");
  const [w] = W.applySpaces([EDITOR], { "e@example.test": ["alpha"] });
  assert.equal(W.membershipOf(w), null, "an array is not a membership map either");
});

test("applySpaces copies and matches addresses case-insensitively", () => {
  const users = [{ ...EDITOR, email: "E@Example.Test" }];
  const [u] = W.applySpaces(users, { "e@example.test": { alpha: "admin" } });
  assert.equal(W.isMemberOf(u, "alpha"), true);
  assert.equal(users[0].spaces, undefined, "the input roster is not mutated");
});

test("a global admin does not carry admin into a space they were kept out of", () => {
  const [u] = W.applySpaces([ADMIN], { "a@example.test": { alpha: "editor" } });
  assert.equal(W.roleIn(u, "alpha"), "editor");
  assert.equal(W.roleIn(u, "beta"), "editor", "not a member of beta at all");
  assert.equal(W.roleOf(u), "admin", "the global role is untouched — only the per-space one differs");
});
