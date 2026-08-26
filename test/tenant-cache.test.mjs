// tenantCache — the one constructor this engine may keep a cross-request cache with.
//
// WHY THESE CASES EXIST. Three cross-tenant leaks were closed here, and each time the
// guard that was supposed to catch the next one was answered by a shape it had not
// enumerated: a bare `let`, then a Map whose accesses did not carry a key, then a factory
// call the scanner did not count as a binding at all. This module is the answer to that
// pattern — not a better list of unsafe shapes, but a safe one that is the only thing
// expressible. The cases below are what "the only thing expressible" has to mean:
//
//   1. There is NO WAY to read the container. No iterator, no `values()`, no `entries()`,
//      no `forEach()`, no way to get the Map out. "Hand me every workspace's entry" is not
//      a question the handle can be asked, so a lint being asleep costs nothing here.
//   2. There is NO WAY to reach a value without naming a workspace. Every method that
//      touches an entry takes the id first and refuses a call without one.
//   3. Two workspaces share nothing — not a value, not a stamp, not an eviction.
//
// The lint (scripts/no-tenant-globals.mjs) reads the method lists off this module rather
// than carrying its own copy, so a method added here without being declared turns it red.
import test from "node:test";
import assert from "node:assert/strict";

import {
  tenantCache,
  TENANT_CACHE_KEYED_METHODS,
  TENANT_CACHE_WHOLE_METHODS,
} from "../src/tenant-cache.mjs";

test("the handle exposes nothing that could hand back every workspace's entry", () => {
  const c = tenantCache("t");
  const keys = Object.keys(c).sort();
  assert.deepEqual(keys, [...TENANT_CACHE_KEYED_METHODS, ...TENANT_CACHE_WHOLE_METHODS].sort());
  // The shapes that read the whole container. None of them exists, and the handle is
  // frozen, so none of them can be added either.
  for (const name of ["entries", "values", "keys", "forEach", "map", "store", "toJSON"]) {
    assert.equal(c[name], undefined, `the handle answers to ${name}`);
  }
  assert.equal(typeof c[Symbol.iterator], "undefined", "the handle is iterable");
  assert.throws(() => [...c], TypeError);
  assert.ok(Object.isFrozen(c));
  assert.throws(() => { c.values = () => []; }, TypeError);
  // And spreading it copies methods, never entries — there is no entry to reach.
  c.put("alpha", { v: 1 });
  assert.deepEqual(Object.values({ ...c }).filter((v) => typeof v !== "function"), [1]); // only `size`
});

test("every method that reaches a value refuses a call that does not name a workspace", () => {
  const c = tenantCache("t");
  // `undefined` is the shape of a caller who forgot the argument — which is exactly how a
  // keyed cache becomes one slot.
  for (const m of TENANT_CACHE_KEYED_METHODS) {
    assert.throws(() => c[m](), { name: "TypeError", message: /must name a workspace/ }, `${m}() was allowed`);
    assert.throws(() => c[m](""), { name: "TypeError" }, `${m}("") was allowed`);
    assert.throws(() => c[m](7), { name: "TypeError" }, `${m}(7) was allowed`);
    assert.throws(() => c[m]({ tenantId: "alpha" }), { name: "TypeError" }, `${m}(object) was allowed`);
  }
  // The two that cannot hand one workspace another's value need no key, for that reason.
  for (const m of TENANT_CACHE_WHOLE_METHODS) assert.doesNotThrow(() => c[m]);
});

test("a workspace that is not resolved yet participates in no cache at all", () => {
  // `null` is the cold-isolate context, before resolveTenant() has answered. It is a real
  // state, so it must not throw — and it must not get an entry either, because "every
  // unresolved request shares one slot" is the bug wearing a different hat. It runs
  // uncached: writes are dropped, reads miss.
  const c = tenantCache("t");
  c.put(null, { v: "unresolved" });
  assert.equal(c.get(null), undefined);
  assert.equal(c.size, 0);
  const a = c.entry(null, () => ({ n: 1 }));
  const b = c.entry(null, () => ({ n: 1 }));
  assert.notEqual(a, b, "two unresolved requests were handed the same object");
  assert.equal(c.size, 0);
  // And it cannot see, or be seen by, a resolved workspace.
  c.put("alpha", { v: "alpha" });
  assert.equal(c.get(null), undefined);
  assert.deepEqual(c.get("alpha"), { v: "alpha" });
});

test("two workspaces share no value, no stamp and no factory result", () => {
  const c = tenantCache("t");
  const a = c.entry("alpha", () => ({ at: 0, docs: null }));
  const b = c.entry("beta", () => ({ at: 0, docs: null }));
  assert.notEqual(a, b, "the factory ran once and both workspaces got the same object");
  a.at = 100;
  a.docs = ["alpha's roster"];
  assert.equal(c.get("beta").at, 0, "beta was told alpha's read was fresh");
  assert.equal(c.get("beta").docs, null, "beta was served alpha's documents");
  // Busting one workspace asks IT to re-read and leaves the other alone.
  c.bust("alpha");
  assert.equal(c.get("alpha").at, 0);
  assert.deepEqual(c.get("alpha").docs, ["alpha's roster"], "the bust blanked what alpha is serving");
  c.put("beta", { at: 500, docs: ["beta's roster"] });
  c.bust("alpha");
  assert.equal(c.get("beta").at, 500, "busting alpha reached beta's clock");
});

test("entry() is get-or-create, and put() replaces", () => {
  const c = tenantCache("t");
  const first = c.entry("alpha", () => ({ n: 1 }));
  const again = c.entry("alpha", () => { throw new Error("the factory ran on a hit"); });
  assert.equal(again, first);
  const replaced = c.put("alpha", { n: 2 });
  assert.equal(c.get("alpha"), replaced);
  assert.equal(c.size, 1);
});

test("drop takes one workspace's entry, and with `expect` only its own attempt", () => {
  const c = tenantCache("t");
  const mine = { attempt: 1 };
  c.put("alpha", mine);
  c.put("beta", { attempt: 1 });
  // A failed fill dropping its own attempt must not drop whatever a later load, or
  // another request, has already put in its place.
  const theirs = { attempt: 2 };
  c.put("alpha", theirs);
  assert.equal(c.drop("alpha", mine), false, "a stale attempt dropped the live entry");
  assert.equal(c.get("alpha"), theirs);
  assert.equal(c.drop("alpha", theirs), true);
  assert.equal(c.get("alpha"), undefined);
  assert.deepEqual(c.get("beta"), { attempt: 1 }, "dropping alpha reached beta");
  // No `expect` means unconditional.
  c.put("alpha", { attempt: 3 });
  assert.equal(c.drop("alpha"), true);
  assert.equal(c.get("alpha"), undefined);
});

test("the cache is bounded, and eviction is a re-read rather than a wrong answer", () => {
  // An isolate serving many workspaces would otherwise hold every entry it ever built.
  // Eviction takes the least recently touched workspace: it can cost a read, and it can
  // never hand back somebody else's value.
  const c = tenantCache("t", { max: 3 });
  for (const id of ["a", "b", "c"]) c.put(id, { id });
  assert.equal(c.size, 3);
  c.get("a"); // a read is not a touch — only put/entry re-insert
  c.entry("a", () => ({ id: "a" })); // ...this is
  c.put("d", { id: "d" });
  assert.equal(c.size, 3);
  assert.equal(c.get("b"), undefined, "the least recently touched workspace survived");
  assert.deepEqual(c.get("a"), { id: "a" }, "the touched workspace was evicted");
  assert.deepEqual(c.get("d"), { id: "d" });
  // Whatever gets evicted, nobody is answered with anyone else's entry.
  for (const id of ["a", "c", "d"]) {
    const e = c.get(id);
    if (e) assert.equal(e.id, id);
  }
});

test("clear takes everything and answers for nobody afterwards", () => {
  const c = tenantCache("t");
  c.put("alpha", { v: 1 });
  c.put("beta", { v: 2 });
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get("alpha"), undefined);
  assert.equal(c.get("beta"), undefined);
});

test("two caches are two containers — one workspace's key means nothing in the other", () => {
  const a = tenantCache("a");
  const b = tenantCache("b");
  a.put("alpha", { from: "a" });
  assert.equal(b.get("alpha"), undefined);
  assert.equal(a.size, 1);
  assert.equal(b.size, 0);
});
