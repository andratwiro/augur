# The service worker & shared chrome bundle (instant navigation)

Two changes make navigating Augur feel instant. Both are generic engine behaviour,
taken by every instance on a pin bump.

## What ships

- **`/_chrome.<UI_VERSION>.<hash>.css` + `.js`** — the script+style chrome that used to
  be inlined (byte-identical) into every `shell()` page, ~187 KB, is emitted ONCE as a
  content-hashed, `immutable`-cached asset. Pages now carry only their own markup + the
  per-page `window.__GV_SPACE` data script + a `<script defer>` to the bundle. A shell
  page dropped from ~55 KB gzip to ~6.5 KB gzip. Generated in `build.js`
  (`CHROME_CSS_BODY`/`CHROME_JS_BODY`); the immutable promotion is `withAssetCache` in
  `src/_worker.js` (`/_chrome.` alongside `?v=` and fonts).

- **`/sw.js`** — a service worker registered from the chrome bundle. Its decision logic
  lives in `src/sw-logic.mjs` (unit-tested; `test/sw-logic.test.mjs`) and is concatenated
  into the shipped worker by `build.js`, so tested and shipped code are one source.

## Behaviour (deliberately narrow)

The worker touches ONLY same-origin GET navigations (stale-while-revalidate) and the
immutable shared assets `/_chrome.*` + `/fonts/*` (cache-first). Everything else —
non-GET, cross-origin, `/__*` (all collab/data/API/realtime), `/sw.js` itself — is
**passthrough**, so it structurally cannot interfere with auth, publishing, or realtime.

- **SWR navigations:** the cached page paints instantly (zero network); a background fetch
  revalidates and updates the cache, so you see fresh content on the next visit. A page
  is cache-eligible only when it's a 200 whose `Cache-Control` lacks `no-store`. The login
  gate is `no-store`, real content is `public, no-cache` — so a logged-out gate page is
  never cached, and a session that expires mid-visit evicts the stale copy on revalidate.

- **Updates:** the cache is namespaced `augur-v<BUILD_STAMP>`; on activate every other
  namespace is deleted, and `skipWaiting()` + `clients.claim()` make a new worker take
  over within one reload.

## Kill-switch (tombstone)

If the worker ever misbehaves in production, replace the generated worker body with a
tombstone that unregisters and clears everything, then let the engine pin bump propagate
it — one visit removes the worker everywhere. Minimal tombstone `src/sw-logic.mjs` /
wiring equivalent:

```js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll()) c.navigate(c.url);
})()));
```

No dashboard or infra step is involved — shipping the tombstone through the normal engine
deploy is the entire recovery.
