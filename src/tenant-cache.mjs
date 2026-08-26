// tenantCache — the one way this engine is allowed to keep a cache that outlives a
// request.
//
// WHY IT EXISTS. Module scope is per ISOLATE, and an isolate serves whatever workspaces
// Cloudflare routes through it. Every cross-tenant leak this repo has closed had the same
// shape: a module-scope slot holding one workspace's answer, read by the next workspace's
// request. The avatar index, the board registry, the remark queue, the roster overlay —
// each was a bare `let`, or a Map that one access reached without naming a workspace.
//
// The guard that watched for that shape kept being answered by a new shape. So the shape
// is no longer what is watched: the SAFE thing is now the only thing that is expressible.
// This constructor hands back a frozen handle over a Map it keeps in a closure. The Map
// itself is unreachable — there is no `entries()`, no `values()`, no `forEach()`, no
// iterator, no way to get the container out — so "read every workspace's entry at once"
// is not something a caller can write, whether or not a lint is looking. And every method
// that reaches a value takes the workspace id as its FIRST argument and REFUSES a call
// without one, so a cache with no key is not something a caller can build either.
//
// WHAT IT DOES NOT DO, so nobody mistakes it for more than it is:
//
//   · It checks that a key was supplied, never that it is the RIGHT workspace. Which
//     workspace a request is for is decided in exactly one place — `resolveTenant()` in
//     src/_worker.js, guarded by scripts/one-tenant-resolver.mjs — and a caller that
//     resolves the wrong id gets a consistent, wrong answer out of every cache at once.
//     This module cannot see that and does not claim to.
//   · It bounds the cache, so an isolate serving many workspaces cannot grow one entry per
//     workspace forever. Eviction costs a re-read and can never hand back a neighbour's
//     value, which is the only direction that matters.
//   · The VALUES are not copied or frozen. A caller that stores a mutable entry and hands
//     it to two workspaces has shared it; the handle only guarantees that the two got it
//     out from under the same key.
//
// Entries are stored in insertion order and re-inserted on every touch, so the first key
// is always the least recently used one — the eviction victim.

export const DEFAULT_TENANT_CACHE_MAX = 256;

// The key a not-yet-resolved workspace gets. A module-private symbol, so no caller can
// name it and no two caches can agree on it: every operation under it is a miss and every
// write under it is dropped, which is "an unresolved request participates in no cache"
// rather than "unresolved requests share one slot".
const UNRESOLVED = Symbol("tenant-unresolved");

// `label` names the cache in the TypeError a keyless call raises; it is for the person
// reading the stack, and nothing reads it back.
export function tenantCache(label, options = {}) {
  const max = options.max ?? DEFAULT_TENANT_CACHE_MAX;
  const store = new Map();

  // The refusal, and the one state that is not a refusal.
  //
  // `null` is a WORKSPACE THAT IS NOT RESOLVED YET — the cold-isolate context, before
  // resolveTenant() has answered. It is a real state, so it must not throw; what it must
  // not do is get an entry. It gets `UNRESOLVED` instead: reads miss, writes are dropped,
  // and the caller runs uncached. That is the property this module is for — an
  // unresolved request shares nothing with anyone — bought at the price of a re-read
  // rather than a 500.
  //
  // Anything else that is not a non-empty string — `undefined`, `""`, a number, an object
  // — is a caller that forgot the argument, which is precisely how a keyed cache becomes
  // a single slot. That throws, in the isolate that did it.
  const keyed = (tenantId) => {
    if (tenantId === null) return UNRESOLVED;
    if (typeof tenantId !== "string" || tenantId === "") {
      throw new TypeError(
        `tenantCache(${label}): every access must name a workspace — got ${
          tenantId === undefined ? "undefined" : JSON.stringify(tenantId)
        }. A cache reached without a workspace id is a slot the whole isolate shares.`,
      );
    }
    return tenantId;
  };

  // Nothing is ever stored under UNRESOLVED, so every read of it misses for free.
  const touch = (key, value) => {
    if (key === UNRESOLVED) return value;
    store.delete(key);
    store.set(key, value);
    while (store.size > max) store.delete(store.keys().next().value);
    return value;
  };

  return Object.freeze({
    // This workspace's entry, or undefined. Never another workspace's, and never a
    // default: a caller with nothing cached has to decide what "nothing" means.
    get(tenantId) {
      return store.get(keyed(tenantId));
    },

    // Store this workspace's entry and mark it most-recently-used.
    put(tenantId, value) {
      return touch(keyed(tenantId), value);
    },

    // Get-or-create, touched either way. `make` runs only on a miss, so the caller's
    // starting value is built per workspace rather than shared between them — the
    // per-workspace factory rule the tenant context is built on, applied to caches.
    //
    // Insert BEFORE any await at the call site: two concurrent requests for one workspace
    // then fill one entry instead of racing two into the store.
    entry(tenantId, make) {
      const key = keyed(tenantId);
      const hit = store.get(key);
      return touch(key, hit === undefined ? make() : hit);
    },

    // Forget this workspace's entry. With `expect`, only if the stored value is still
    // that exact one — a failed fill dropping its own attempt must not drop whatever a
    // later load, or another request, has already put in its place.
    drop(tenantId, expect) {
      const key = keyed(tenantId);
      if (arguments.length > 1 && store.get(key) !== expect) return false;
      return store.delete(key);
    },

    // Ask this workspace's entry to be re-read on the next request, KEEPING what it holds
    // in the meantime. Entries that want this carry an `at` stamp; zeroing it is "stale",
    // never "gone", so a write handler making its own change visible does not blank what
    // the workspace is being served while the re-read happens.
    bust(tenantId) {
      const e = store.get(keyed(tenantId));
      if (e && typeof e === "object") e.at = 0;
    },

    // Whole-cache operations. Neither can hand one workspace another's value: `clear`
    // takes every entry away, and `size` is a count. They need no key for the same reason.
    clear() {
      store.clear();
    },
    get size() {
      return store.size;
    },
  });
}

// The method names a tenantCache handle answers to, split by whether they reach a value.
// scripts/no-tenant-globals.mjs reads these rather than carrying its own copy, so adding a
// method here without deciding which list it belongs on turns the lint red instead of
// silently widening what a cache may be touched with.
export const TENANT_CACHE_KEYED_METHODS = Object.freeze(["get", "put", "entry", "drop", "bust"]);
export const TENANT_CACHE_WHOLE_METHODS = Object.freeze(["clear", "size"]);
