// Pure decision logic for the Augur service worker (sw.js).
//
// Factored out so the safety-critical routing — what the worker is allowed to
// touch and what it must NEVER touch — is unit-tested in isolation and shipped
// verbatim (build.js concatenates this file, minus `export`, into dist/sw.js).
// Keep it pure: no `self`, no `caches`, no `fetch`. Runtime wiring lives in the
// SW_WIRING template in build.js.

// A response may enter the cache only if it is a normal 200 whose Cache-Control
// does NOT say no-store. The login gate is served `no-store`; real content is
// `public, no-cache`. So this single predicate is what stops the worker from
// ever caching (and later re-serving) a logged-out gate page. See the spec.
export function cacheEligible(status, cacheControl) {
  if (status !== 200) return false;
  const cc = String(cacheControl == null ? "" : cacheControl).toLowerCase();
  if (cc.includes("no-store")) return false;
  return true;
}

// Classify a request into a handling strategy. Deliberately narrow: anything not
// explicitly claimed here is 'passthrough' (the browser's default), so the worker
// structurally cannot interfere with auth, publishing, data APIs, or realtime.
//
//   'passthrough'  — do not touch (non-GET, cross-origin, /__*, /sw.js, other)
//   'swr'          — same-origin GET navigation → stale-while-revalidate
//   'cache-first'  — immutable shared asset (/_chrome.*, /fonts/*)
//
// Inputs are primitives so this is trivially testable.
export function swDecision({ method, sameOrigin, mode, path }) {
  if (method !== "GET") return "passthrough";
  if (!sameOrigin) return "passthrough";
  // Collab / data / API / realtime / config / worker — never cached, always live.
  if (path.startsWith("/__")) return "passthrough";
  // The worker script itself must always come from the network (SW update check).
  if (path === "/sw.js") return "passthrough";
  // Top-level page navigations get the instant-paint treatment.
  if (mode === "navigate") return "swr";
  // The shared chrome bundle and self-hosted fonts are content-hashed + immutable.
  if (path.startsWith("/_chrome.") || path.startsWith("/fonts/")) return "cache-first";
  return "passthrough";
}
