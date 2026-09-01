// The verify step of `augur migrate` compares what the source exported to what the target
// reads back — and the two answer the same documents in DIFFERENT KEY ORDERS. A KV-backed
// export hands a family back in insertion order; the workspace object hands it back sorted.
// A byte comparison of the two therefore reports "differ" on a correct copy, and a correct
// migration fails its own verification. The comparison has to be structural: canonical
// (recursively key-sorted) JSON on both sides, arrays kept in order because order in an
// array IS content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, compareFamily } from "../scripts/lib/state-compare.mjs";

test("canonicalJson sorts object keys at every depth and leaves arrays in order", () => {
  assert.equal(
    canonicalJson({ b: { d: 1, c: [3, { z: 1, y: 2 }, 1] }, a: "x" }),
    '{"a":"x","b":{"c":[3,{"y":2,"z":1},1],"d":1}}',
  );
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson([2, 1]), "[2,1]");
});

test("the same family in two key orders is a MATCH", () => {
  const kvOrder = { "/p/two/": "reviewed", "/p/one/": "dev-ready" };
  const objectOrder = { "/p/one/": "dev-ready", "/p/two/": "reviewed" };
  assert.equal(compareFamily("statuses", kvOrder, objectOrder), "match");
  // Nested too — a roster entry whose fields the object stored in column order.
  const a = { add: { "a@x.test": { email: "a@x.test", role: "editor" } }, remove: [] };
  const b = { remove: [], add: { "a@x.test": { role: "editor", email: "a@x.test" } } };
  assert.equal(compareFamily("users:roster", a, b), "match");
});

test("array order is content, so a reordered array still DIFFERS", () => {
  assert.equal(compareFamily("c:/p/one/", [{ id: "t1" }, { id: "t2" }], [{ id: "t2" }, { id: "t1" }]), "differ");
});

test("nothing with content in it is ever flattened", () => {
  // Both sides have to hold nothing before the kind is even consulted.
  assert.equal(compareFamily("statuses", { "/p/": "x" }, {}), "differ");
  assert.equal(compareFamily("statuses", {}, { "/p/": "x" }), "differ");
  assert.equal(compareFamily("pins:", { a: {} }, undefined), "differ");
});

test("absent and empty are the same answer for a `key` family and a BLIND copy for a `prefix` one", () => {
  assert.equal(compareFamily("statuses", undefined, {}), "match");
  assert.equal(compareFamily("statuses", {}, undefined), "match");
  assert.equal(compareFamily("pins:", undefined, {}), "blind");
  assert.equal(compareFamily("pins:", {}, {}), "match");
});
