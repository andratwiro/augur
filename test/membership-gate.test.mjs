// The server-side half of membership. The client filters the switcher, but that is
// cosmetics — this is the gate. Two rules it must never lose:
//
//   1. A space you are not in answers 404, not 403. "You may not see this" confirms the
//      space exists; the design says a non-member cannot learn that. Same reasoning
//      /__people already carries about refusing to enumerate the roster.
//   2. Public prototypes stay public. Share links are the point of the open door, and a
//      signed-in non-member must not fare WORSE than a signed-out stranger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const SPACES = [
  { id: "alpha", name: "Alpha", default: true, base: "" },
  { id: "beta", name: "Beta", base: "/beta" },
];
const member = (map) =>
  W.applySpaces([{ email: "e@example.test", role: "editor" }], { "e@example.test": map })[0];

test("spaceIdForPath maps a path to the space that owns it", () => {
  assert.equal(W.spaceIdForPath("/beta/", SPACES), "beta");
  assert.equal(W.spaceIdForPath("/beta", SPACES), "beta");
  assert.equal(W.spaceIdForPath("/beta/proj/proto/", SPACES), "beta");
  assert.equal(W.spaceIdForPath("/", SPACES), "alpha", "the default space owns the root");
  assert.equal(W.spaceIdForPath("/anything/else/", SPACES), "alpha");
});

test("a prefix match respects the path boundary", () => {
  assert.equal(W.spaceIdForPath("/betamax/", SPACES), "alpha",
    "'/betamax' must not read as the 'beta' space");
  assert.equal(W.spaceIdForPath("/beta-two/", SPACES), "alpha");
});

test("with no default space, an unowned path belongs to nobody rather than to anyone", () => {
  const noDefault = [{ id: "beta", name: "Beta", base: "/beta" }];
  assert.equal(W.spaceIdForPath("/beta/", noDefault), "beta");
  assert.equal(W.spaceIdForPath("/loose/", noDefault), null);
});

test("a member passes the gate; a non-member does not", () => {
  const u = member({ alpha: "editor" });
  assert.equal(W.isMemberOf(u, "alpha"), true);
  assert.equal(W.isMemberOf(u, "beta"), false);
});

test("someone with no membership recorded passes every gate, exactly as today", () => {
  const u = { email: "e@example.test", role: "editor" };
  assert.equal(W.isMemberOf(u, "alpha"), true);
  assert.equal(W.isMemberOf(u, "beta"), true);
});

test("administersAny decides whether /admin is reachable at all", () => {
  assert.equal(W.administersAny(member({ alpha: "admin", beta: "editor" }), SPACES), true);
  assert.equal(W.administersAny(member({ alpha: "editor" }), SPACES), false);
  assert.equal(W.administersAny({ email: "g@example.test", role: "admin" }, SPACES), true,
    "a global admin with no membership recorded still administers everything");
  assert.equal(W.administersAny({ email: "n@example.test", role: "editor" }, SPACES), false);
});

test("a member of a space they do not administer cannot reach that space's admin", () => {
  const u = member({ alpha: "admin", beta: "editor" });
  assert.equal(W.roleIn(u, "beta"), "editor");
  assert.equal(W.administersAny(u, [{ id: "beta", name: "Beta", base: "/beta" }]), false);
});
