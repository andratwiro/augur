# Plan: runtime chrome composition (retire per-space re-bake)

**Status:** proposed
**Problem it solves:** an engine update refreshes the serving worker + the shared
engine-owned chrome bundle, but the **page-level chrome markup** (rail, tab bar, profile
menu) is baked into each space's published HTML at publish time (`/_build.json`
`builtWithEngine`). So an engine deploy leaves already-published pages on older chrome
until each space republishes. Today that gap is closed by **re-baking** — republishing
every space against the new engine. Re-bake works but it does not belong in the serving
model: it is O(spaces) work per engine deploy, it needs publish authority for every space,
and in a multi-tenant host it would mean re-publishing every tenant on every engine change.

**The end state:** the worker composes the **current** engine's page chrome onto stored
content **at serve time**. Then an engine deploy updates every page for every space/tenant
instantly, with no re-bake, no per-space publish, and no per-space token — O(1) in the
number of spaces.

## Why this is incremental, not a rewrite

The machinery is ~60% present:

- **Serve-time HTML rewriting already exists.** `withLiveReload` (`src/_worker.js`) runs
  an `HTMLRewriter` over served HTML to append the reload poller before `</body>`. A chrome
  composer is the same primitive, doing more.
- **Chrome CSS/JS is already engine-owned and ships with the engine.** `build.js`
  externalizes it into a content-hashed immutable bundle `_chrome.<UI_VERSION>.<hash>.{css,js}`
  (listed in `ENGINE_CHROME`), deployed on every engine deploy and reaching every space.
  Old bundles are never GC'd, so old pages keep working during the transition.
- **A chrome/content boundary already exists.** Injected overlays are marker-delimited
  (`<!--gv-<name>-start-->…-end-->`); `stripInjectedChrome` / `stripVolatileHead`
  (`scripts/lib/publish-*.mjs`) are the canonical "content minus injected chrome"
  comparators, and `publish-resolve.mjs` already peels injected chrome back off live bytes
  to recover authored source — the exact inverse of runtime composition.

## The work

1. **Give the baked rail a boundary.** Today `appChrome(...)` markup is inlined **without
   markers** on shell/gallery pages (`build.js` `shell()` and `injectNav`). Wrap that region
   in `<!--gv-appchrome-start-->…-end-->` (or stop baking it entirely). Prototype pages are
   already easy — they carry no baked rail, only marker-wrapped overlays.
2. **Move `appChrome`/rail rendering into the worker.** It is page/space-specific (active
   tab, nav sections, pinned rows, space context), so the worker must render current markup
   per request from routing + membership + KV pins. Port `appChrome` /
   `spaceContextScript` / rail logic out of `build.js` into a shared module both call.
3. **Rewrite chrome asset refs at serve time.** Stored pages reference a specific hashed
   `_chrome.<oldhash>` URL; the composer rewrites those `<link>/<script>` srcs to the
   current bundle (trivial in the `HTMLRewriter` pass).
4. **Add a chrome-version map.** `VERSION_MAP` today is live-reload-only. Add a real
   "which chrome version is current" signal so the composer knows when to strip+recompose
   vs pass through.
5. **Do it in the existing `withLiveReload` pass** so there is one HTMLRewriter over served
   HTML, not two.

## Migration & safety

- **Additive and reversible.** While composing at serve time, keep the baked markup behind
  its new markers; the composer strips-then-injects, so a page renders correctly whether or
  not it has been re-baked. Ship the composer dark, verify parity against baked output, then
  flip.
- **Caching.** Composed HTML is a pure function of (stored content, current chrome version,
  request-derived rail state). Cache on that key; bust on engine deploy (chrome version
  changes) — the same signal `_build.json engine.sha` already moves on.
- **Once live, re-bake becomes optional.** The shell `rebake` job and `health.yml` check (f)
  can be retired: no published page can be on stale chrome if chrome is composed fresh.

## Relationship to the current re-bake

Until this lands, chrome stays current via the **shell `rebake` job** (the shell re-bakes
its own spaces with its `*`-scoped token when the engine pin moves) and the `health.yml`
check (f) drift alarm. That interim needs no per-space token and works for repo-based
instances; runtime composition is what makes it unnecessary — and is the only form that
fits a multi-tenant host, where there are no per-space repos or CI at all.
