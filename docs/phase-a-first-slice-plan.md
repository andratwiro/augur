# Phase A, first slice — implementation plan

**Status:** the first slice (`A-retire-space-tier`, S0–S7 below) is BUILT and landed, and
the tenant-context sweep described in §2 is under way: the context's shape and its
per-tenant cache exist (`src/tenant-context.mjs`), the lint that stops a new global is in
`check`, the tenant resolver seam is in `fetch()`, the config load BUILDS AND RETURNS a
context for that tenant instead of assigning module globals, and **`fetch()` now binds
that returned context as `tctx` and hands it down** — the ~700-line router body reads no
module config binding at all, and the functions it calls take the workspace as an
argument. The globals survive as a mirror of the context until the read sites deeper in
take it too; the remaining `A-thread-*` items delete them. This document is the map for
the rest. Line-number citations below were accurate when written
(worker 4611 lines, build.js 7755 lines) and have since drifted; treat them as
pointers to the right function, not as coordinates. `build.js` line numbers are given
only for its role as the SOURCE that emits `routing.json` / `instance.json`; the
generated `dist/_worker.js` is never a plan target — only `src/_worker.js` is.

> A note the engine's CI enforces on this very file: `check.yml` greps the whole repo
> (this file included) for instance/product/personal words. This plan therefore names
> no instance, no company and no person — "the reference instance" and "the public
> demo instance" throughout. Keep it that way when editing.

---

## 0. Framing — what "Phase A, first slice" is

Phase A turns a single-tenant-*shaped* worker into a tenant-*aware* one while it still
resolves exactly ONE workspace, statically, end to end. The mechanism is:

- ~25 module-scope config globals are filled once per isolate by `loadConfig()` and read
  implicitly at ~110 sites. The end state threads a per-request context object instead.
- Every step must be an **observable no-op** on real responses, proven by byte-level
  snapshots before Phase B's Host resolver ever supplies a second workspace.

The first slice **opens with a deletion — `A-retire-space-tier`** — because no live
instance path-mounts a second space, and threading a doomed axis (the "multiple spaces
mounted under `/<id>/` in one instance" concept) through 110 read sites is wasted work.
Delete it first, then the sweep threads a smaller, single-workspace surface.

The load-bearing distinction, stated once and used throughout:

- **KEEP — "space = the single mounted workspace."** The *unit* that becomes a tenant.
  One `space.json`, one design system, one prototype bundle, one manifest, one icon,
  one roster scope. `id`, `name`, `badge`, `adminOnly`, the KV keys, the whole
  publish/serve pipeline for that one workspace: all retained.
- **DELETE — "multiple spaces path-mounted in one instance."** The idea that ONE running
  worker enumerates a *list* of spaces, mounts the `default` one at `/` and every other
  under `/<id>/`, and resolves an incoming path to one of several spaces. Nothing live
  uses the plural; it is the axis Phase B replaces with Host-based tenant resolution.

Getting that boundary wrong is the stated risk. Section 1 draws it at file:line.

---

## 1. `A-retire-space-tier` — exact scope

### 1a. The concept, and where it lives

`SPACES` is a module-scope **array** (`src/_worker.js:337`, `let SPACES = [];`) that in
principle holds many spaces. It is populated two ways:

- **Assets mode** — `loadConfig()` reads `routing.json`:
  `SPACES = Array.isArray(routing.spaces) ? routing.spaces : []` (`_worker.js:422`).
- **Bundle mode** — `applyDerivedRouting(manifests)` builds it from the live per-space
  manifests: `spacesList.push(sp)` in the loop and the final sort at
  `_worker.js:1718` (`(b.default === true) - (a.default === true) || id.localeCompare`).

`build.js` is the source of the multiplicity: `discoverSpaces()` (`build.js:6793`)
enumerates every sibling dir carrying a `space.json`, forces exactly one `default`
(`build.js:6858–6865`), and sorts default-first (`6865`). `NAV_STATE.spaces`
(`build.js:7211`) then stamps each space's `base` = `s.default ? "" : "/"+s.id`
(`build.js:7213`), and `routing.json` ships `spaces` + `defaultSpace`
(`build.js:7408–7409`).

### 1b. DELETE list (the multi-space-path-mount axis)

Each item is where the *plural* leaks into behaviour. The retirement collapses "a list
with a distinguished default and `/<id>/` others" to "the one workspace."

| # | Site | What it does today | Retirement |
|---|------|--------------------|-----------|
| D1 | `spaceIdForPath(pathname, spaces)` — `_worker.js:721–730` | Loops non-default spaces, returns one whose id prefixes the path (`p === "/"+s.id \|\| p.startsWith("/"+s.id+"/")`), else the default's id. THE path→space resolver. | With one workspace, every owned path resolves to the single space. Function collapses to "return the one space's id (or null if none)." Keep the null-when-no-space contract (callers branch on it). |
| D2 | `pathOwnedBySpace(key, spaceId, spaces)` — `_worker.js:1803–1819` | Non-default branch (`if (!isDefault) return key === "/"+spaceId ...`, `1814`) and the default branch's "exclude every other space's `/<id>/`" loop (`1815–1818`). | The `/<id>/` sub-cases disappear; ownership becomes "engine chrome → no; `/__` (except `/__search.json`) → no; else → the one workspace." |
| D3 | `isPublishablePublicPrefix(p, spaceId, spaces)` — `_worker.js:1743–1746` | Thin wrapper on `pathOwnedBySpace`. | Follows D2; simplifies with it. |
| D4 | `RESTRICTED_BASES` derivation — bundle: `applyDerivedRouting` `_worker.js:1701` (`spRestricted = sp.adminOnly && !sp.default; if (spRestricted) restricted.push("/"+id)`); assets: emitted by `build.js:7332–7334` (`.filter(s => s.adminOnly && !s.default).map(s => s.base)`). | The `!default` clause is the multi-space seal: a *non-default* space sealed under its `/<id>/`. With one workspace, a `default` space is "never restricted" (`build.js` comment `7330`), so `RESTRICTED_BASES` is always empty in the single-space world. **See open question Q1 — do we keep `adminOnly` as a whole-instance seal, or retire it with the tier?** |
| D5 | `isRestrictedPath` / `isTrackPath` base-prefix logic — `_worker.js:260–266`, `251–258` | `isRestrictedPath` matches `RESTRICTED_BASES` (`/<id>` + subtree). `TRACK_PATH` regex `^(\/[a-z0-9-]+)?\/tracks\/…` (`_worker.js:252`) — the optional `(\/[a-z0-9-]+)` is the `/<space>/` mount prefix. | `isRestrictedPath` follows D4. `TRACK_PATH`'s leading optional group collapses to root-only `/tracks/…` once no space mounts under `/<id>/`. |
| D6 | Membership gate in `fetch()` — `_worker.js:4547–4549` (`const sid = spaceIdForPath(url.pathname, SPACES); if (sid && !isMemberOf(me, sid)) return notFoundResponse();`) | Narrows access to spaces you're a member of — meaningful only when several spaces coexist. | With one workspace, membership is "in / not in the one workspace." See Q2 — this whole per-space-membership cluster is the delicate part of the boundary. |
| D7 | `build.js` space-switcher + `__GV_SPACE` | `spaceSwitcher()` (`build.js:2989–3004`) renders a dropdown of the spaces (already `Hidden when only one space`, `2992`); `window.__GV_SPACE` (`build.js:4402–4407`) carries `{base, others:[…other space bases]}`; the rail's board filter keys off `sp.base`/`sp.others` (`build.js:4423–4429`). | `others` is always `[]` and `base` always `""` in single-space; the switcher already no-ops. Remove the plural plumbing so nothing re-grows it. |
| D8 | `BASE` / `SPACE_KEY` / `DIST_SPACE` in `build.js` — `setSpaceContext()` `build.js:6906–6908` (`BASE = space.default ? "" : "/"+space.id`, etc.) and the whole "loop over spaces, build each into `/<id>/`" driver (`build.js` main, the `spaces` loop feeding `NAV_STATE`). | The per-non-default `/<id>/` output tree (`build.js:20–22` header contract) is what the tier produces. Single-space builds only the root; the `/<id>/` branch is dead. |
| D9 | `routing.json` `spaces` / `defaultSpace` fields — `build.js:7408–7409`; consumed at `_worker.js:422`. | The array shape assumes many. | Reduce to the single workspace's descriptor (still a record, not a list — keep the fields the rail/switcher/icon need: `id`, `name`, `badge`, `adminOnly?`, `icon`). |

### 1c. KEEP list (space = the one workspace = future tenant)

Everything below stays; it describes the *unit*, not the multiplicity. Flag anything a
naïve "delete all `SPACES` references" sweep would wrongly take:

- **The single space descriptor** and its identity: `id`, `name`, `badge`. Still needed
  for the rail, the switcher header, `/_build.json` (`build.js:7447`), manifests.
- **Workspace icon cluster** — `SPACE_ICONS_KEY`/`SPACE_ICON_BLOB_PREFIX` (`_worker.js:122–123`),
  `readSpaceIcons`/`applySpaceIcons`/`serveSpaceIcon`/`spaceIconApi` (`_worker.js:634–712`),
  and the `SPACE_ICON_KEYS`/`SPACE_ICONS` pair, now context fields rather than globals.
  This is per-workspace state, KEEP. It is keyed by `spaceId` in KV
  (`{spaceId: {k,mime,at}}`) — that key **is the tenant axis**, which Phase A/B keeps and
  later scopes; it is NOT the path-mount tier.
- **Per-space membership cluster** — `USER_SPACES_KEY` (`_worker.js:114`), `readSpaces`,
  `applySpaces`, `membershipOf`, `isMemberOf`, `roleIn`, `spacesFor`, `clearSpaces`,
  `meSpaces`, `administersAny`, `lastAdminOf`, `mayResetPassword`, `viewerWriteRefusal`
  (`_worker.js:564–790`, `617`). **This is the boundary's sharpest edge — see Q2.** These
  functions are *written to survive multiple spaces per person*, but their KV shape
  (`{email: {spaceId: role}}`) is the tenant/role axis, not the path-mount tier. The safe
  reading: retire the *path-mounted plurality* (D1–D9); do NOT gut the membership/role
  model in this slice. Its `spaceId`-keyed maps degenerate cleanly to one entry and stay
  correct (an ABSENT membership already means "the whole instance", `_worker.js:104–106`).
- **The single manifest / publish pipeline** for that workspace: `pathOwnedBySpace`'s
  chrome + `/__` rules (`_worker.js:1805–1812`) are workspace-agnostic and KEEP; only its
  `/<id>/` sub-cases (D2) go.
- **`/space-icon.png`, `brandMark()`** (`_worker.js:201–204`, `1306–1310`): the default
  workspace's front-door brand. The `SPACES.some(s => s.default)` test at `1309`
  simplifies to "is a workspace mounted", but the behaviour KEEPS.

### 1d. The comment the tier retirement can finally delete

`isPublicPath()` carries an explicit "revisit when the first public second space mounts"
note (`_worker.js:234–238`): `/skills` and `/pages` public doors are default-space-only
root paths, deferred pending a base-aware `/<id>/skills/…`. Retiring the tier **resolves
that TODO by deletion** — there is no second space, so root-only is correct forever.
The comment should go with the tier (call it out in the commit so a reviewer sees the
deferred risk being closed, not ignored).

---

## 2. The ~25 module-scope config globals

All are declared `let` at column 0. They are no longer *filled* by the load — the load
builds a context and `applyTenantContext()` mirrors it onto them — so each one now has
exactly one writer, and threading a cluster means deleting its line from that mirror and
taking `ctx.<NAME>` at the read sites instead. **Every seam that writes a binding writes
the context in the same statement** (`applyInstance`, `applyDerivedRouting`,
`__setChromeTestState`), so a threaded read site and a not-yet-threaded one can never
answer differently from the same fixture — which is the half-done-sweep failure no
single-workspace test can observe. A cluster with no binding left writes the context
alone: the two in-isolate roster writes in `adminUsersApi` are the worked example. "Reads" = occurrences minus the declaration
and assignment sites (measured by `grep -ow` count, then discounting decl + assigns).

| Global | Decl | ~reads | Notes for threading |
|--------|------|-------:|---------------------|
| `MIN_CLIENT_PROTOCOL` | `343` | ~5 | publish protocol floor |
| `LOGIN_HINT` | `346` | ~2 | login page |
| `LOGIN_PREFILL_EMAIL` | `351` | ~2 | login page |
| `LOGIN_PREFILL_PASSWORD` | `352` | ~2 | login page |

The sweep opened on **28 config-shaped globals** (the plan's "~25"). Five clusters have
since been threaded and their `let`s deleted, so the rows above are what is left.

The identity cluster — `CONFIG_USERS`, `USERS` and the `CONFIG_LOADED` flag that rides
with them. The gate cluster — `PUBLIC_PREFIXES`, `PUBLIC_SKILL_PREFIXES`, `VERSION_MAP`,
`BUILD_ID` and `VANITY_REDIRECTS`, whose read sites are `isPublicPath`, `versionFor` and
the vanity lookup in `fetch()`, each taking the context as a required first argument.
`RESTRICTED_BASES` went with them as a DELETION rather than a threading: the path-mount
tier left it permanently empty, so its global was a write-only copy of an empty list.
`isRestrictedPath` and the context field stay — an empty seal is still a seal, and assets
mode still reads a `routing.restrictedBases` the build no longer emits.

And the workspace cluster — `SPACES`, the icon pair `SPACE_ICONS`/`SPACE_ICON_KEYS`,
`INSTANCE_SENTINELS`, and the update-nudge pair `INSTANCE_ENGINE_VERSION`/`UPDATE_FEED`.
`SPACES` had already lost every read site to the router's threading, so what was left of
it, of the sentinels and of the nudge pair was a write-only mirror: deleting the `let`
deleted the whole binding. Two things were real work. `applySpaceIcons` now RETURNS
`{SPACES, SPACE_ICON_KEYS}` as a context patch instead of stamping the list and leaving
the hash allowlist in module scope, so `serveSpaceIcon` asks the calling workspace's
context and a hash one workspace vouches for cannot be fetched through another's icon
route. And `viewerWriteRefusal`, `spaceIconApi` and `mayResetPassword` lost their
`spaces = SPACES` default: every caller already passed the list, and the default was the
only thing keeping the global alive.

And the MCP-proxy allowlist cluster — `MCP_HOST_SUFFIXES`, `MCP_HOST_ALLOWLIST`,
`MCP_HOST_ALLOWLIST_URL`, `MCP_PATH_ALLOWLIST` and the `mcpStaticHosts` Set derived from
the host union. The config fields were the easy half: `mcpProxy` already took the
workspace it is proxying for, so deleting the `let`s deleted five write-only mirrors. The
POINT of the cluster is the sixth binding, which is not a config field at all.
`mcpHostAllowlist` memoises the exact-host list a workspace publishes at its own
`MCP_HOST_ALLOWLIST_URL` — a value DERIVED from one workspace's config — and it was a
single promise keyed on nothing, so the first workspace to warm it handed its resolved
list to every workspace behind it. That widens which third-party hosts this origin will
forward a browser's `Authorization` header to, and an era with one workspace cannot
observe it, because the resolved list is simply correct. It is now a `Map` keyed by
tenant, each entry carrying the URL it was fetched from (so a workspace that moves its
document is not answered out of the old one) and bounded like the context cache (eviction
costs a re-fetch and can only narrow what is allowed). The evidence is three cases in
`test/tenant-isolation.test.mjs`: a host only one workspace's document names is refused to
the other, the memo is still one fetch per workspace rather than one per request, and a
failed read retries instead of poisoning that workspace — or reaching its neighbour.

And the canvas cluster — `CANVAS_LOADER_EXTRAS`, `CANVAS_CATALOG`, `CANVAS_TRACKS` and
`RT_ORIGIN`. `canvasLoaderPage`, `canvasAggregate` and `rtProxy` were already taking the
workspace they answer for, so all four `let`s were write-only mirrors and deleting them
deleted the bindings. The work was the EVIDENCE, because this is the one cluster the
byte-level snapshot cannot see: its corpus pins no registered canvas path, no insert
picker and no realtime upgrade, so the ratchet stays green whatever those three routes
answer. Three cases in `test/tenant-isolation.test.mjs` drive the surfaces themselves with
two contexts over ONE shared KV and registry — the loader page carries the calling
workspace's script tags and none of its neighbour's, the two aggregates answer that
workspace's catalogue and tracks (and still answer a signed-out viewer with neither), and
the multiplayer proxy dials that workspace's realtime worker rather than a neighbour's
room. Checked by sabotage, not by the pass: memoising the first context inside those three
functions turns all three red and leaves the snapshot green.

The two aggregate globals also stated the multi-space era in their own comment — "every
embeddable thing across all spaces". The merge is unchanged (each workspace still
contributes its slice through its routing fragment), but the value it produces belongs to
the workspace that asked for it, not to the isolate.

And the bundle-store caches — `MANIFESTS` and `STORAGE_CACHE`. Neither is a config field,
so neither appears in the table; both hold a value DERIVED from one workspace's store,
which is the MCP memo's shape and the MCP memo's trap. `MANIFESTS` is the sharper of the
two, because what it holds is the parsed file table every served byte is resolved through
and the routing fragment the gate is derived from — behind a single 1.5-second stamp, so
the first workspace to warm it answered every workspace behind it for the rest of the
tick: a neighbour's pages at this workspace's URLs, and a neighbour's public prefixes
deciding this workspace's gate. The etag shortcut inside the value repeated the shape one
level down, keyed by SPACE id, and two workspaces may each publish a space under the same
id. `STORAGE_CACHE` measures how full one workspace's store is and showed that number to
whoever asked next for five minutes. Both are now `Map`s keyed by tenant and bounded like
the context cache, and the functions that read them take the workspace they answer for:
`loadManifests`, `assetFetch`, `assetPathExists`, `canvasesApi` (whose shadow check asks
whether a real file already serves a board's URL) and `adminStorageApi`. Eviction costs a
list and a parse and can never answer with another workspace's content. The evidence is
five cases in `test/tenant-isolation.test.mjs`, and it has to be, because the byte-level
snapshot runs in ASSETS mode where neither cache is reached at all — it stays green
whatever these two answer. Checked by sabotage: keying both on a constant turns three of
the five red and leaves the snapshot green.

And the two KV-document caches the UNGATED routes poll — `CANVAS_REGISTRY` (the
created-board registry, read on every asset 404 by `readCanvasRegistry`, which takes the
workspace and not only the binding) and `PITI_REMARKS` (the companion's remark queue, read
on every poll of `/__piti`). Same shape as the bundle-store pair, and sharper in one
respect: both are read at EARLY EXITS in `fetch()`, ahead of the login page, because a
board is a share link and the companion lives on public prototypes that carry no cookie.
A single slot therefore served the second workspace to ask, inside a 15-second tick, the
first one's boards at the first one's URLs — to a signed-out stranger, while that
workspace's own boards answered the login page — and read the first one's queued remarks
aloud to everyone behind it. Both are `Map`s keyed by tenant and bounded now, and both
busts (`bustCanvasRegistry`, `bustPitiRemarks`) take the workspace, so a write makes
itself visible on its own workspace's next request without sending every neighbour back to
KV. The evidence is four cases in `test/tenant-isolation.test.mjs`, and two of them drive
the real default export end to end, because "which workspace was answered" and "was
anybody signed in" are the same question at an early exit. The byte snapshot pins no
canvas board and no `/__piti` poll, so it is green either way.

And the roster overlay — `rosterCache` / `rosterReadAt`, now the one `ROSTER_OVERLAY` map.
This is the same shape a third time and the worst of the three, because what it holds is
not content but AUTHORIZATION. The six KV documents behind it are a workspace's invites and
removals, its display names, its ROLE overlay, its per-workspace memberships, the photo
hashes `/__avatar/` will serve and the icon hashes `/__space-icon/` will; one slot behind
one 60-second clock handed all six to the second workspace to load. Reproduced through the
real `fetch()`, with the two workspaces holding SEPARATE per-workspace KV so module scope
was the only channel: beta's UNGATED `/__people` naming an alpha person to a signed-out
stranger; `/__avatar/u/<hash>` answering 200 `image/png` from beta for a hash only alpha's
index vouches for; and a person who is a VIEWER in beta's own config, with no
`users:roles` document in beta's KV at all, coming back ADMIN out of alpha's role overlay —
which is `/__admin/users` opening, not a rendering going wrong. It is a `Map` keyed by
tenant and bounded now, `rosterFields` reads it through `ctx.tenantId`, and every handler
that writes one of the six calls `bustRosterOverlay(tenantId)`: `spaceIconApi`, `meNameApi`
and `meAvatarApi` take the workspace for that reason alone, and `adminUsersApi` and the
instance-config push already had it. The blanket `cfgAt = 0` no longer reaches this clock,
so a rename in one workspace does not send every neighbour back to KV for six documents.

Two things about how that one got past everything, because they are the transferable part.
It was PINNED, as a "KNOWN GAP" — and the pin asserted it through `loadTenantContext`,
while `request()`, the only helper in `test/tenant-isolation.test.mjs` that drives the real
router, reset the roster clock on every call. So no case in the file could observe the
cache through `fetch()`, and the pin recorded the gap while hiding its blast radius:
nothing in it said "ungated" and nothing in it said "admin". A helper that resets a memo is
a helper that hides it; `request()` now clears the resolver memo and nothing else, and a
case that wants a cold isolate says so in its own body. And the lint's allowlist entry
called the cache "overlay only, never the auth boundary", which is true of *sign-in* — the
`users:secrets` tombstone fails closed and `identify()` resolves it per request — and false
of *what you may do once signed in*. That entry is why the lint no longer reads reasons.
The evidence is five cases in `test/tenant-isolation.test.mjs`, four of them through the
default export; checked by sabotage, keying the cache on a constant turns all five red and
leaves the byte snapshot green (it pins no `/__people`, no `/__avatar/` and no board, and
runs in ASSETS mode).

**⚠️ NOT CLOSED, AND A DIFFERENT AXIS: the KV KEYS are not namespaced by workspace.**
Recorded here so it is not rediscovered a fourth time. Everything above is about per-isolate
CACHES — state that outlives a request. Underneath them, the KV document names are flat and
instance-wide: `canvases`, `pt:remarks`, `board:<path>`, and the six roster documents. With
one KV binding shared by two workspaces — which is what an isolate serving both by Host
would have unless something changes — `beta GET /boards/alpha-secret/` answers 200 with
alpha's board even after every memo is cold, because both workspaces read the same
`canvases` document. No cache is involved and no amount of keying the caches touches it.
**Do not rename the keys as a side quest**: the settled architecture moves mutable state
into a per-workspace Durable Object, which resolves this by giving each workspace its own
storage rather than by prefixing strings in a shared one, and a half-done rename would
leave live instances reading keys nothing writes. The caches being keyed is what makes this
the only remaining path — that is the value of writing it down.

Excluded as per-isolate runtime caches, not config: `cfgAt`, `MANIFESTS`, `STORAGE_CACHE` —
the latter two keyed by tenant rather than shared, per the paragraph above. `AVATAR_KEYS`
was excluded here too and should not have been: it is the list of photo hashes the UNGATED
`/__avatar/` route will serve, derived from one workspace's roster, which makes it an
authorization set and not a memo. It is a `derived` context field now, beside the
`SPACE_ICON_KEYS` it is a copy of. Total config-global occurrences ≈ 200,
i.e. ~110–120 read sites once decls/assigns are removed — matching the plan's "~110".

**The enumeration of record is `scripts/no-tenant-globals.mjs`, not this table.** Line
numbers here drift; the lint walks the module graph the worker pulls into the isolate —
every module it reaches by a relative import, because module scope is per ISOLATE and a
`let` one import away is shared exactly as widely — and counts what is actually declared —
today 29 module-scope bindings across five modules: NO config global at all, 6 caches
built by `tenantCache()`, 19 frozen tables, and 4 slots the whole isolate still shares. It
fails CI, and therefore the deploy, on a binding it has never been told about, on an
allowlist entry whose binding is gone, and on an allowlist entry that names a field of the
tenant context — so the list shrank as the threading landed rather than turning into
standing permission, and a threaded field cannot be re-admitted to it under a
plausible-sounding reason. A config global is now simply an unlisted binding, which is a
failed build.

**And it names the SAFE thing, because enumerating unsafe ones lost three times.** Every
older direction asks whether the list AGREES WITH THE CODE, and none asked whether an entry
was TRUE — which is how all of them stayed green through the cross-tenant leaks above,
since none was an unlisted binding: each was ON the list under a written reason asserting
the safety it did not have ("a hash is content-addressed, so it means the same thing
everywhere"). Two rebuilds then each caught the shape in front of them and were answered by
the next one: a factory call (`const SLOT = makeSlot()`) the binding scanner did not count
as a binding at all; a literal key (`const key = "everyone"`) inside a cache the list
called keyed, accepted because any local ever assigned from a tenant id made that NAME
trusted module-wide; and `TABLE[url.pathname] ??= …`, a per-request write into a table the
list called invariant, past a write scan that knew `=` and not `??=`. Three rounds of
enumerating unsafe shapes lost three times, because there is always another shape and the
person adding it is the one choosing it.

So the unsafe shapes are no longer what is enumerated. Two inversions, then three kinds:

- **A CONSTRUCTOR, NOT A PATTERN.** There is exactly one way to keep a cache across
  requests: `tenantCache()` in `src/tenant-cache.mjs`. It returns a frozen handle over a
  Map held in a closure — no iterator, no `values()`, no `entries()`, no way to pass the
  container anywhere, so "hand me every workspace's entry" is not expressible whether or
  not a lint is looking; and every method that reaches a value takes the workspace id
  first and throws without one. The same move for fixed tables: `Object.freeze` at the
  declaration hands enforcement to the engine, which refuses every write form at every
  site, including the ones a regex scanner cannot parse.
- **WHAT COUNTS AS STATE IS AN ALLOWLIST.** The old scanner asked "is this initializer one
  of the mutable shapes I know?" — array, object, `new Map` — so a call was invisible, and
  a factory is what every state-hiding trick has in common. It now asks the opposite: is
  this initializer PROVABLY not state? A number, a string or template, a regex, a symbol,
  a function, or a call to a same-module arrow that returns a string. Everything else is
  state and must be accounted for. The failure mode is a false ALARM rather than a silent
  pass.

- **`cache`** — required to be declared `const X = tenantCache(…)` in a module that really
  imports it, and required to be touched only through the handle's own methods, each with
  a `tenantId` expression as its first argument. There are deliberately NO aliases: a
  local name claiming to be the workspace is a sentence in identifier form, and that is
  precisely the bypass that worked.
- **`frozen`** — required to be `const` and wrapped in `Object.freeze(…)`, and not a Map or
  a Set, since freezing one leaves `.set()` and `.add()` working. "Tenant-invariant by
  construction" is no longer checked by scanning for writes; the write throws.
- **`unkeyed`** — the bare per-isolate slot, which is the shape every leak had. There is
  deliberately no "it is only a clock" kind: `canvasRegAt` was only a clock, and it is what
  made the stale document answer. An entry must name a `proof` test file that exists and
  speaks the binding's name, and the TOTAL count must equal `UNKEYED_BUDGET` exactly —
  exact, not a ceiling, so closing one forces the number down in the same commit and
  opening one forces a diff line that says the isolate now shares one more slot.

**And the reasons are gone.** The failure that outlived every rebuild is that an entry's
stated reason is prose, and no checker can tell whether prose is true. The answer is not a
better sentence or a scan for weasel words: `cache` and `frozen` are ARRAYS OF NAMES, so
the field a false claim would live in does not exist. What a human needs to know sits in a
`//` comment beside the name, which is visibly commentary rather than data. Prose survives
in exactly one place — `unkeyed`, where a slot's danger genuinely cannot be checked — and
that place is capped by a number.

Today's four are `cfgAt`, `cfgGoodAt`, `TENANT_CTX` and `tenantMemo` — the config slot
with its two clocks, and the resolver's memo. That is this phase's remaining debt, counted
rather than described, and the budget is what makes it a debt rather than a category.

What it still does not cover is stated in its own header, and the header is the list to
read before trusting a green: state with no binding name (`this` on the default export, a
module-scope IIFE); `Object.freeze` being shallow, so `TABLE.sub[k] = v` still runs; the
key having to SAY `tenantId`, which is a name and not a proof, so an object carrying a
`tenantId` field of the wrong value passes; and whether the key names the right workspace
at all, which is `resolveTenant`'s job and `scripts/one-tenant-resolver.mjs`'s guard. The
budget line can be raised by the commit that needs it — the point is not that it is
impossible but that it is loud, and that the way every leak actually shipped, by adding a
sentence to a list of sentences, no longer works.

### 2a. The config cache — stale within a floor — `loadTenantContext()` / `loadConfig()`

```
async function loadTenantContext(tenantId, env, { prev, forced }) {
  let next = prev;                                  // start from the last good context
  ... ABSENT (404 / no store key / a 200 that is not JSON) -> contributes nothing
  ... FAILED (a throw, or a non-404 the host could not serve) -> propagates
  return withTenantFields(next, await rosterFields(next, env, forced));
}
async function loadConfig(tenantId, env) {          // the transitional caller
  const mine = TENANT_CTX.tenantId === tenantId;    // is the slot this workspace's?
  if (!env) return mine ? TENANT_CTX : empty(…);    // no config source: open BY DESIGN
  if (mine && Date.now() - cfgAt < 1500) return TENANT_CTX;   // per-isolate 1.5s TTL
  cfgAt = Date.now();                               // stamp FIRST (no stampede)
  try { next = await loadTenantContext(…); }
  catch { return (mine && fresh(cfgGoodAt)) ? TENANT_CTX : null; }  // stale, then closed
  cfgGoodAt = Date.now();
  if (next === TENANT_CTX) return TENANT_CTX;       // nothing parsed — keep last good
  TENANT_CTX = next; applyTenantContext(next);      // mirror onto the globals, for now
  return TENANT_CTX;
}
```

**A read that FAILED is not a document that is ABSENT**, and telling the two apart is what
the load's classification is for. They used to collapse into the same swallowed `null`,
which is what made a broken read indistinguishable from a raw build: both produced the
empty-array/empty-string defaults, and the empty defaults are the open gate.

Three properties, and all three must be preserved as the sweep replaces the mirror with a
threaded context:

1. **Stamp-first**: a failed load does not retry until the next tick, so a broken config
   read cannot stampede KV/ASSETS on the hot path. The stamp lands before the failure is
   classified, so a store refusing every read still gets one attempt per tick.
2. **Keep-last-good**: the previous values stay in service. Every field starts at the
   previous context's and is replaced only by a document that actually parsed, so an
   ABSENT document contributes nothing; when nothing came back the load hands back the
   very object it was given and the mirror does not run. A FAILED read keeps them too —
   for `CONFIG_STALE_CEILING_MS` (60s). A transient read failure never wipes a working
   gate.
3. **Fail-closed floor**: past that ceiling, and on a cold isolate that has no last-good
   for this workspace at all, `loadConfig` returns **`null`** and `fetch()` answers
   `configUnavailableResponse()` — a 503 — before a single route runs. It does not serve a
   context built from the empty defaults, because the empty defaults ARE a raw build and a
   raw build's gate is open. `cfgGoodAt` is the clock that separates the two, and it is
   read only when `TENANT_CTX.tenantId` is the workspace being asked about: a second
   workspace finds no last-good and is refused rather than handed the neighbour's.

The trade in (3) is deliberate and it is availability for correctness: a store outage
longer than a minute takes the site down rather than letting a photograph of the workspace
decide who may sign in and which paths are public.

(1) and (2) are pinned in `test/config-keep-last-good.test.mjs`, (3) and the ABSENT/FAILED
distinction in `test/config-fail-closed.test.mjs`, both in **both serving modes** — the
response snapshot corpus runs in assets mode, so the bundle branch every deployed instance
actually runs has no byte-level baseline watching it.

The **fail-CLOSED counterweight for the ABSENT case** lives beside them: `CONFIG_LOADED`
lets the gate distinguish "genuinely no identity" (raw build → open) from "no config
document loaded yet in this cold isolate" (deployment → must fail closed), consumed in
`fetch()` as `authed = expectsConfig ? tctx.CONFIG_LOADED : true`. It starts FALSE and only
an instance document that actually parsed sets it true — that default comes from the
context factory (`emptyTenantContext`), and `instanceFields` is the only thing that flips
it. It lives nowhere else: there is no module binding mirroring it, so a second workspace
starts un-loaded rather than inheriting the first one's verdict.
**This cold-isolate fail-closed semantics is the single most dangerous thing in the sweep
to regress** — a context that defaults to "loaded/empty" instead of "not yet loaded"
reopens the gate on a cold isolate whose config documents are missing. The baseline
snapshot carries a cold-isolate request for exactly this (`cold-isolate-config-absent`,
where the reads succeed and 404) alongside the one for the refusal
(`cold-isolate-fail-closed`, where they throw), and the guard is checked by flipping the
factory's default to `true` and watching that test go red — never by trusting the pass.

### 2b. The tenant resolver seam — `resolveTenant(request, env)`

Everything in §2 is "config for WHICH workspace". One function answers that, and
`fetch()` calls it once, at the top, before any config is read — the call site is the
first thing after the unconditional `/__config/*` refusal, and `scripts/one-tenant-resolver.mjs`
fails the deploy if a second one appears or if one drifts below the config load.

The body is static today: a deployment serves one workspace, so the answer is the
`tenantId` its build stamped into `instance.json` (`build.js`, next to `users` — an
explicit `tenantId` in the deploy config, else the id of the workspace mounted at the
root). Serving several workspaces from one deployment replaces that body with a Host
lookup and touches nothing else, which is the entire reason the seam exists as its own
commit rather than arriving with the first threading change.

Two properties are load-bearing, and both mirror §2a rather than inventing anything:

- **A missing `tenantId` is not an error.** Every instance built before the field existed
  carries none, and those instances take this engine by pin bump before any rebuild — so
  an absent, blank or non-string value answers `DEFAULT_TENANT_ID` (`"default"`), which is
  exactly what the one-workspace world has been doing all along under another name. A raw
  or offline build with no config document at all lands in the same place, without a read.
- **The static answer is memoised per isolate, and only when it is real.** A resolved id
  is kept — a deployment's identity does not change without a redeploy, and re-reading it
  would put a second config read on every request. A FAILED read is stamped instead
  (`tenantMemo = {at, tenantId: null}`, TTL 1.5s), so a broken config document costs one
  retry per tick rather than one per request. `tenantMemo` is the last entry in the lint's
  unkeyed quarantine whose VALUE would be a *wrong* answer if an isolate served two
  workspaces, and the Host resolver that makes that possible is what deletes it. The roster
  overlay used to be the other, under an entry claiming "overlay only, never the auth
  boundary"; it is keyed by workspace now — see the roster paragraph in §2a for what that
  entry was wrong about, and for how the pin on it hid the blast radius rather than
  showing it.

---

## 3. No-op verification strategy

### 3a. What exists

- **Unit baselines already landed:** `test/worker-gate.test.mjs` (23 tests) and
  `test/worker-board.test.mjs` (28 tests). They import `__testables` (`_worker.js:4580`)
  and drive `applyDerivedRouting()` with real-shaped fixtures (gate test `space()` helper
  + `seedRouting()`, lines 19–44). They already assert the exact behaviours the sweep
  touches: `isPublicPath`, `isRestrictedPath`, `isTrackPath`, `versionFor` (gate) and
  `boardApi`, `canvasesApi`, `virtualCanvas`, the `board:<path>` KV key shape (board).
  The board test's header explicitly says `board:<path>` becoming `board:<tenant>:<path>`
  "must be a visible, deliberate diff here, not a silent one."
- **`npm test`** = `node --test "test/*.test.mjs"` (`package.json:12`), run by
  `test.yml` on every push + PR. Zero deps, no submodules.
- **`GV_ENGINE_ONLY=1 node build.js`** chrome-purity check in `test.yml` — proves the
  build still emits only `_engine.json`.

### 3b. What must be BUILT — a byte-level response snapshot harness

**There is no response-level snapshot harness today** (grep for snapshot/golden across
`test/` + `scripts/` returns nothing). The unit tests assert *function returns*, not
*HTTP responses*. A mechanical no-op claim over ~110 read sites needs the actual bytes
of real responses, not helper returns. Build a small harness:

- **Driver:** import the worker's `default.fetch` (already the export at `_worker.js:4146`)
  and call it with a fixed `env` (a `memKV()` like the board test's, plus an `ASSETS`
  stub that serves a frozen fixture tree) across a **fixed request corpus**:
  - `/` (gated index), a public prototype path, a gated internal path, `/_build.json`,
    `/robots.txt`, the login page (signed-out), a signed-in index (cookie set),
    `/space-icon.png`, a `/__review/comments.js` asset, a canvas board loader,
    a `/pages/…` door, and **a cold-isolate first request** (fresh module state, config
    read forced to fail) to lock the `CONFIG_LOADED` fail-closed path (§2a).
- **Snapshot:** for each request record status + a *normalised* header set + body bytes
  (hash the body; keep the hash, not the HTML, so the fixture file stays small and
  reviewable). Normalise away only genuinely volatile fields (the live-reload
  `versionFor` token, `Date`), the same spirit as `stripVolatileHead` in publish.
- **Gate the refactor on it:** capture the snapshot on the pre-refactor commit; each
  no-op commit must reproduce it byte-for-byte. A deliberate behaviour change (e.g. the
  tier deletion actually removing a `/<id>/` response) updates the snapshot in *its own*
  commit with the diff visible — never mixed with a mechanical move (the gate test's
  own rule, lines 8–11).

Snapshot the **retirement** the same way, but expect *targeted* diffs only where a second
space would have mounted (a `/<id>/` request that used to resolve now 404s; the live
corpus has none because no live instance mounts one — so on the real corpus the tier
deletion is *also* a byte no-op, which is the whole reason it goes first).

### 3c. The CI gotcha to design around

`pull_request` runs build a **detached merge commit**: `git rev-parse --abbrev-ref HEAD`
returns the literal string `"HEAD"`, not a branch name. A fixture that assumes a branch
name passes on `main` and on a laptop but **fails only on PRs**. This is already
documented and worked around in `test/publish-self-update.test.mjs:197–205` (detects
`branch === "HEAD"` and checks out a real `seed-main`). The live risk sites are
`scripts/ship.mjs:81` (`const BRANCH = git("rev-parse","--abbrev-ref","HEAD")`) and any
new harness fixture that shells to git. **Rule for the new snapshot harness: never derive
identity/branch from `--abbrev-ref HEAD`; seed a real branch (or avoid git entirely — the
harness should be pure `fetch()` over a fixed env, no repo introspection).** Also note
`deploy-trigger.yml:35–41` already guards on `head_branch == 'main'` for the same reason.

---

## 4. Recommended TDD-friendly commit sequence

Each commit is an observable no-op (or a *targeted, snapshotted* diff for the deletion),
guarded by a named test. Stage only changed paths (never `git add -A`). Small units,
push often — CLAUDE.md conventions.

**S0 — Snapshot harness (test infra only).**
Add `test/response-snapshot.test.mjs` (§3b) + a checked-in baseline over the fixed
corpus, including the cold-isolate request. No `src/` change. *Guard:* the harness passes
against unmodified `src/_worker.js`. This is the ratchet everything after leans on.

**S1 — Widen the baselines to pin the tier's current answers.**
Before deleting anything, add assertions to `worker-gate.test.mjs` that lock today's
multi-space answers: a non-default `/<id>/` path is owned by that space
(`spaceIdForPath`), an `adminOnly` non-default base is in `RESTRICTED_BASES`
(`isRestrictedPath`), `TRACK_PATH` matches `/<id>/tracks/x.mp3`. *Guard:* these pass now;
they are the diff surface the deletion will deliberately flip.

**S2 — `spaceIdForPath` → single-workspace form (D1).**
Collapse the loop to return the one workspace's id (or null). *Guard:* gate test — the
single-space fixtures return unchanged answers; the S1 `/<id>/` assertions are updated in
THIS commit with the diff visible (the deletion is deliberate here).

**S3 — `pathOwnedBySpace` / `isPublishablePublicPrefix` (D2, D3).**
Remove the `/<id>/` sub-cases; keep chrome + `/__` rules. *Guard:* the publish-ownership
tests (`pathOwnedBySpace`, `isPublishablePublicPrefix`, `removedPublicPrefixes` are in
`__testables`, `_worker.js:4602`) — assert single-workspace ownership unchanged.

**S4 — `RESTRICTED_BASES` + `isRestrictedPath` + `TRACK_PATH` (D4, D5).**
Retire the `!default` seal path; simplify the track regex's optional mount group.
*Guard:* gate test — `isRestrictedPath` empty in single-space; `isTrackPath` still
matches root `/tracks/…`. **Blocked on Q1** (does `adminOnly` survive as a
whole-instance seal?).

**S5 — Membership gate call site (D6) — SCOPED, pending Q2.**
Only the `fetch()` call site `_worker.js:4547–4549` if Q2 says the per-space membership
model is out of scope for this slice; leave the cluster (`564–790`) intact. *Guard:*
membership tests (`membership*.test.mjs`) unchanged; snapshot unchanged on the live
corpus.

**S6 — `build.js` producers (D7, D8, D9).**
Remove `/<id>/` output driver, `BASE`/`SPACE_KEY`/`DIST_SPACE` non-default branches,
`__GV_SPACE.others`, the switcher's plural plumbing, and reduce `routing.json`
`spaces`/`defaultSpace` to the single descriptor. *Guard:* `GV_ENGINE_ONLY=1` build stays
chrome-only; the response snapshot over the live corpus is byte-identical; the
`worker-gate` fixtures (which feed `applyDerivedRouting` directly) still parse.

**S7 — Delete the resolved TODO (§1d).**
Remove the "revisit when the first public second space mounts" comment
(`_worker.js:234–238`) as part of S2/S4, called out in the commit message so the reviewer
sees a deferred risk *closed*, not dropped.

After S7 the tier is gone and the surface is single-workspace — the sweep that threads
the 28 globals into a per-request context (a later slice) now has ~20 fewer `SPACES`
read sites and an empty `RESTRICTED_BASES` to thread.

---

## 5. Questions the first slice answered, and what is still open

**Q1 — Does `adminOnly` survive the tier? RESOLVED: no, it goes with the tier.**
`adminOnly` only ever sealed a *non-default* space (both the build and the worker gated
on `!s.default`), and "the default space is never restricted." With the path-mount tier
retired there is no non-default space left to seal, so S4 deletes the derivation and
`RESTRICTED_BASES` is permanently empty. The rejected alternative was to reinterpret it
as a whole-instance admin seal — a private workspace behind admin login. That is not a
loss: under the settled membership model a workspace is *already* private by membership,
so a seal keyed on the path mount would be a second, weaker answer to a question
membership answers properly. If a whole-instance seal is ever wanted, it belongs in the
membership model, not resurrected here.

This was verified against reality before landing, not just argued: every live instance
serves exactly one space, each `default: true`, none carrying `adminOnly` — so
`RESTRICTED_BASES` was already empty everywhere at runtime, and S4 makes structurally
permanent what was already dynamically true. Re-probe that before relying on it.

**Q2 — Is the per-space membership/role model in scope? RESOLVED: no, it stays intact.**
The membership cluster is keyed `{email: {spaceId: role}}`, and that `spaceId` axis is
the *tenant/role* axis (settled model: space = workspace, email = identity across
workspaces), NOT the path-mount tier. The first slice retires only the path-mount
plurality (D1–D9); the membership maps degenerate cleanly to one workspace
(absent-means-all), and gutting a security model inside the opening deletion is exactly
the "behaviour change riding a mechanical refactor" the baselines forbid. S5 therefore
resolves the gate to the one workspace and stops there.

**Q3 — What shape is the per-request tenant context? RESOLVED: a frozen plain object
whose field names are the current global names, with free functions taking it as a
parameter.** It lives in `src/tenant-context.mjs`. Three properties carry the decision,
and each was chosen against a specific failure:

- **Names match the globals exactly** (`USERS`, not `users`). Every one of the ~110 read
  sites then becomes `ctx.USERS` — a rename, not a rewrite — which is what keeps the
  byte-level snapshots meaningful. Tidier names would hide real changes inside cosmetic
  ones, and the whole method here depends on the diff being boring.
- **Defaults are factories, never values.** A shared `new Set()` in a defaults object
  would be handed to every tenant, so one workspace's icon hash would become everyone's —
  reintroducing the exact leak inside the fix for it. Tested by asserting two contexts
  share no reference.
- **No methods.** `isPublicPath(ctx, path)` stays a free function rather than
  `ctx.isPublicPath(path)`, because moving behaviour onto the container would make the
  sweep a behaviour change as well as a mechanical one — precisely what the baselines
  forbid.

The object is frozen, so a stray `ctx.USERS = …` throws rather than rewriting one
tenant's identity from another's request. Values are not deep-frozen: code still rebuilds
these arrays in place, and the guarantee actually needed is against reassignment, which
is what module-scope `let` was violating.

A rejected alternative worth recording: a class with a `load()` method. It reads better in
isolation but makes the context responsible for fetching, which is what the fail-open-stale
cache needs to keep separate — the caller must be able to decide that a failed read is not
worth swapping the cached context for. `buildTenantContext` therefore takes documents that
already parsed and never performs I/O.

The completeness guard lives in `test/tenant-context.test.mjs`: it walks the module graph
the worker pulls into the isolate, and any module-scope binding in any of those files that
is not a `tenantCache()` handle, a frozen table, or a budgeted per-isolate slot fails the
suite. That is the check for the one failure mode the snapshots cannot see — threading 27 of 28 globals
and leaving the 28th shared, with everything green because a single-tenant era cannot
observe the difference. Reading only the entry file would have made "move it one import
away" the way past it.

**Q4 — Snapshot corpus authority. PARTLY SETTLED.** The harness ships a fixed 14-request
corpus (§3b): the signed-out and signed-in index, a public prototype, a gated internal
path, a sealed path, a `/pages` door, `/_build.json`, `/robots.txt`, the login page, the
space icon, a public overlay asset, `/__version`, `/__me`, and the cold isolate whose
first config read fails. That is enough to have caught real drift. Two known blind spots
remain, and both are worth closing before the threading sweep leans on this harness
harder than the deletion did:

- **It runs in ASSETS mode; live instances serve in BUNDLE mode.** The derivation the
  harness never exercises is precisely where D4 changed behaviour, which is why the first
  slice needed the separate live probe recorded under Q1. A bundle-mode corpus would make
  that probe unnecessary. Partly covered since: `test/config-keep-last-good.test.mjs`
  drives the bundle branch at the value level, which catches a load that reloads from
  empty — but not the bytes of a bundle-mode response.
- **No canvas board and no OG card** are in the corpus, so the ratchet pins neither. The
  canvas surfaces are covered instead by the three response-level cases in
  `test/tenant-isolation.test.mjs` (loader page, the two aggregates, the multiplayer
  proxy), which drive the routes directly with two workspaces. The OG card is still
  unpinned by anything.

**Q5 — KV key tenant-scoping was explicitly NOT this slice, and is not. CONFIRMED.**
The single-tenant KV shapes
— `c:<path>` (`_worker.js:3261`), `statuses` (`3308`), `pins` (`3338`), `names` (`3389`),
`canvases` (`3493`), `board:<path>` (`3645`), `basset:<hash>` (`3678`), and the `users:*`
/ `spaces:*` family — are the tenant axis Phase B scopes, and the board baseline is
already written to make that diff loud. The first slice left every one of them
untouched, as it should have. Retiring the *path-mount* tier must not be conflated with
*tenant-scoping the KV*; they are different axes and doing both here would violate the
one-change-per-commit rule.

**Risk — the realtime DO room key.** `rtProxy` forwards to
`tctx.RT_ORIGIN + "/room" + url.search`; the realtime worker keys rooms by board path only
(`realtime/src/index.js:101`, `idFromName(path)`) with no tenant segment. This is
single-tenant-shaped but is isolated per-instance by a separate worker deployment +
shared secret (the closed realtime hole). It is **out of scope for the tier retirement**
(it is the tenant axis, per Q5), but note it now so Phase B's multi-tenant realtime
doesn't collide rooms across tenants — flagged, not touched.
