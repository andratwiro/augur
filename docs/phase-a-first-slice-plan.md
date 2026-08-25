# Phase A, first slice — implementation plan

**Status:** the first slice (`A-retire-space-tier`, S0–S7 below) is BUILT and landed.
The rest of Phase A — the tenant-context sweep described in §2 — is not started, and
this document is its map. Line-number citations below were accurate when written
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
  `SPACE_ICON_KEYS`/`SPACE_ICONS` (`124–125`). This is per-workspace state, KEEP. It is
  keyed by `spaceId` in KV (`{spaceId: {k,mime,at}}`) — that key **is the tenant axis**,
  which Phase A/B keeps and later scopes; it is NOT the path-mount tier.
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

All are declared `let` at column 0 and filled by `applyInstance()` (`_worker.js:359`) or
the `routing.json`/`applyDerivedRouting` paths. "Reads" = occurrences minus the
declaration and assignment sites (measured by `grep -ow` count, then discounting decl +
assigns). This scopes the later threading sweep; it is NOT this slice's work, but the
tier retirement should leave these *ready* to thread.

| Global | Decl | ~reads | Notes for threading |
|--------|------|-------:|---------------------|
| `CONFIG_USERS` | `42` | ~5 | roster base; paired with `USERS` |
| `USERS` | `43` | ~22 | the hottest identity global; `applyRoster` overlay target (`490`) |
| `PUBLIC_SKILL_PREFIXES` | `50` | ~2 | gate exemption; assets from `routing.json` (`409`) |
| `MCP_HOST_SUFFIXES` | `51` | ~3 | MCP proxy |
| `MCP_HOST_ALLOWLIST` | `52` | ~4 | union; also feeds `mcpStaticHosts` |
| `MCP_HOST_ALLOWLIST_URL` | `53` | ~4 | MCP proxy |
| `VANITY_REDIRECTS` | `54` | ~2 | read in `fetch()` `4172` |
| `SPACE_ICON_KEYS` | `124` | ~2 | icon serve allowlist (KEEP, per-workspace) |
| `SPACE_ICONS` | `125` | ~2 | re-applied on `SPACES` rebuild (`490`,`1719`) |
| `BUILD_ID` | `153` | ~6 | live-reload fallback version; hashed in `applyDerivedRouting` (`1707`) |
| `VERSION_MAP` | `159` | ~5 | `versionFor()` (`164`) |
| `PUBLIC_PREFIXES` | `177` | ~5 | `isPublicPath()` core (`242`) |
| `RESTRICTED_BASES` | `249` | ~5 | **shrinks to empty with the tier (D4)** |
| `SPACES` | `337` | ~21 | **the tier axis; D1–D9 shrink its read sites first** |
| `INSTANCE_SENTINELS` | `338` | ~3 | publish unpublish guard |
| `MIN_CLIENT_PROTOCOL` | `343` | ~5 | publish protocol floor |
| `LOGIN_HINT` | `346` | ~2 | login page |
| `LOGIN_PREFILL_EMAIL` | `351` | ~2 | login page |
| `LOGIN_PREFILL_PASSWORD` | `352` | ~2 | login page |
| `INSTANCE_ENGINE_VERSION` | `355` | ~4 | update nudge |
| `UPDATE_FEED` | `356` | ~2 | update nudge |
| `CONFIG_LOADED` | `381` | ~3 | **fail-closed gate flag — see below** |
| `CANVAS_LOADER_EXTRAS` | `3554` | ~3 | virtual canvas loader |
| `CANVAS_CATALOG` | `3564` | ~3 | insert picker aggregate |
| `CANVAS_TRACKS` | `3565` | ~3 | music aggregate |
| `RT_ORIGIN` | `3722` | ~3 | realtime proxy target |
| `mcpStaticHosts` | `3067` | ~4 | derived Set from `MCP_HOST_ALLOWLIST` |
| `mcpHostAllowlist` | `3051` | ~4 | fetched remote allowlist cache |

That is **28 config-shaped globals** (the plan's "~25"). Excluded as pure per-isolate
runtime caches, not config: `cfgAt` (`358`), `MANIFESTS` (`1654`), `STORAGE_CACHE`
(`2654`), `AVATAR_KEYS` (`837`). Total config-global occurrences ≈ 200, i.e. ~110–120
read sites once decls/assigns are removed — matching the plan's "~110".

**The enumeration of record is `scripts/no-tenant-globals.mjs`, not this table.** Line
numbers here drift; the lint reads the worker and counts what is actually declared —
today 47 module-scope bindings: 29 config globals still in flight (the 28 above plus
`CONFIG_LOADED`), 12 per-isolate caches, and 6 mutable-container constants that never
vary by workspace. It fails CI, and therefore the deploy, on a binding it has never been
told about, and equally on an allowlist entry whose binding is gone — so the list shrinks
as the threading lands rather than turning into standing permission. Each thread-\* commit
deletes a `let` from the worker and its line from the allowlist in the same change.

### 2a. The fail-open-stale config cache — `loadConfig()` `_worker.js:384–424`

```
async function loadConfig(env) {
  if (!env || Date.now() - cfgAt < 1500) return;   // 385 — per-isolate 1.5s TTL
  cfgAt = Date.now();                              // 386 — stamp FIRST (no stampede)
  ... bundle: try { applyInstance / applyDerivedRouting } catch (e) {}   // 391–398
  ... assets: grab() returns null on !ok/throw; only applies when truthy // 405–423
}
```

Two properties make it **fail-open-stale**, and both must be preserved when the sweep
replaces globals with a threaded context:

1. **Stamp-first** (`386`): a failed load does not retry until the next tick, so a broken
   config read cannot stampede KV/ASSETS on the hot path.
2. **Keep-last-good**: on any failure the previous global values stay in place — the
   `catch (e) {}` at `398`, and `if (inst) …`/`if (routing) …` guards at `409–422` only
   *overwrite* when a document actually parsed. A transient read failure never wipes a
   working gate (the design note at `329–336`).

The one **fail-CLOSED** counterweight lives beside it: `CONFIG_LOADED` (`381`, set true
only inside `applyInstance` at `375`) lets the gate distinguish "genuinely no identity"
(raw build → open) from "config not loaded yet in this cold isolate" (deployment → must
fail closed), consumed at `_worker.js:4228` (`authed = expectsConfig ? CONFIG_LOADED : true`).
**When threading replaces globals with a per-request context, this cold-isolate
fail-closed semantics is the single most dangerous thing to regress** — a context that
defaults to "loaded/empty" instead of "not yet loaded" reopens the gate on a cold
isolate whose first config read failed. The baseline snapshot MUST include a cold-isolate
request.

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
  retry per tick rather than one per request. `tenantMemo` is the one entry in the lint's
  cache allowlist that would be a *wrong* answer if an isolate served two workspaces, and
  the Host resolver that makes that possible is what deletes it.

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

The completeness guard lives in `test/tenant-context.test.mjs`: it reads the worker's own
source, and any module-scope `let` that is neither a declared context field nor a declared
per-isolate runtime cache fails the suite. That is the check for the one failure mode the
snapshots cannot see — threading 27 of 28 globals and leaving the 28th shared, with
everything green because a single-tenant era cannot observe the difference.

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
  that probe unnecessary.
- **No canvas board and no OG card** are in the corpus, so nothing pins them.

**Q5 — KV key tenant-scoping was explicitly NOT this slice, and is not. CONFIRMED.**
The single-tenant KV shapes
— `c:<path>` (`_worker.js:3261`), `statuses` (`3308`), `pins` (`3338`), `names` (`3389`),
`canvases` (`3493`), `board:<path>` (`3645`), `basset:<hash>` (`3678`), and the `users:*`
/ `spaces:*` family — are the tenant axis Phase B scopes, and the board baseline is
already written to make that diff loud. The first slice left every one of them
untouched, as it should have. Retiring the *path-mount* tier must not be conflated with
*tenant-scoping the KV*; they are different axes and doing both here would violate the
one-change-per-commit rule.

**Risk — the realtime DO room key.** `rtProxy` (`_worker.js:3724`) forwards to
`RT_ORIGIN + "/room" + url.search`; the realtime worker keys rooms by board path only
(`realtime/src/index.js:101`, `idFromName(path)`) with no tenant segment. This is
single-tenant-shaped but is isolated per-instance by a separate worker deployment +
shared secret (the closed realtime hole). It is **out of scope for the tier retirement**
(it is the tenant axis, per Q5), but note it now so Phase B's multi-tenant realtime
doesn't collide rooms across tenants — flagged, not touched.
