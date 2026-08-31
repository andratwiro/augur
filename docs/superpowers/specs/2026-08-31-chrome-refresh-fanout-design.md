# A maintenance-only key for the shared page chrome

**Status:** design, approved 2026-08-31
**Plan item:** `D-chrome-refresh-fanout` (ops / L / GATE, `--ready`)
**Touches (engine `augur/`):** `src/_worker.js` (`CAP_ROUTES`, `sharedChromeRefusal`, one
chokepoint call), `src/tenant-do.js` (a `chrome` control verb), `scripts/publish.mjs`
(`--no-config`), `CLAUDE.md`, several tests.
**Touches (control plane `augur-control-plane/`):** `src/operator.js` (`OPERATOR_VERBS`),
`src/provisioning.js` (`TENANT_RPC`), `src/operator-route.js` (a `chrome` branch),
`runbooks/chrome-refresh.md`, tests.

## The one sentence

The shared page chrome — the rail, the switcher, the admin screens, `/sw.js`, `404.html`:
one build served to every workspace on a hosted deployment — becomes updatable again by
exactly one credential, a short-lived, capability-restricted publish token that **only the
operator can mint**, through the same named-and-logged grant regime that already gates
`suspend`/`delete`, and that **cannot** touch any workspace's content or its
`config/instance.json`.

## Problem

Since the 28 Aug migration the shared `_engine` chrome bundle has been pinned at `52c0108a`
on every live tenant (`demo.augur.page`, `stoic-canyon-873.augur.page`) while the deployed
worker has moved on repeatedly. Nothing has moved it because, correctly, **nothing can**:
the only credential that could write `spaces/_engine/` was a per-workspace star-scope publish
token, minted from any workspace's own Settings panel against its own roster — so any hosted
workspace's admin could rewrite `/admin/index.html` and `/sw.js` for every *other* customer on
the deployment. The just-shipped `sharedChromeRefusal` (engine `63bbc604`..`8e8cacf4`) closes
that hole by refusing `_engine` **writes** to **every** credential where the chrome is shared.

That is the honest, safer end state — but it means the chrome is now totally unpublishable.
This item builds the missing narrow credential. The same pass that shipped the gate also
added the substrate for it: `publish_tokens.caps` (schema v3) and the deny-by-default
`capabilityRefusal`, built precisely so a credential can be restricted to one route without
holding star scope (that is how the control plane's `purge` credential already works).

## Goals

- One credential can commit to `_engine` and have it stick. A plain star token still gets
  `403 chrome-not-writable-here` on the same deployment (VERIFY clause 2, regression-pinned by
  `test/chrome-write-gate.test.mjs` — those cases are not weakened or removed).
- The credential's mint path **never touches `config/instance.json`** — enforced by the
  credential's own capability, not by anyone remembering a flag (the hard constraint).
- The credential is minted only through the operator grant regime: a named actor, a ≤12h
  expiry, two audit lines — an expired or wrongly-scoped attempt is refused and logged the
  same way `suspend`/`resume`/`delete` already are (VERIFY clause 5).
- After one real publish with it, `/_build.json`'s `engine.sha` matches the deployed worker's
  pin on every live tenant (VERIFY clause 4 — the live fan-out, a deploy-gated step).

## Non-goals

- **No self-service, and no workspace-admin mint path.** A workspace admin minting a
  deployment-global credential is the exact hole the gate just closed. The mint is
  operator-only, and nothing in a customer's Settings panel changes.
- **No config/roster push, ever.** This is not "teach the existing `--engine` publish to be
  safe" — the credential structurally cannot write `config/instance.json`. `--no-config` is
  added only so the operator's one command exits clean; it is not the guarantee.
- **No rollback of `_engine`.** `rollback` stays refused for every credential (it bypasses the
  engine-downgrade guard and could re-arm a superseded chrome for everyone). It is deliberately
  absent from `CAP_ROUTES.chrome`.
- **No change to how customers publish their own content.** Per-space publishes are unaffected,
  and per-space content already composes current chrome at serve time (`runtimeChrome: true`).
- **No control-plane-held bytes.** The control plane cannot build the engine; it mints a
  credential and the operator runs the build+publish. The verb does not carry chrome bytes.

## Design

### 1. The credential — a capability-restricted publish token

`space: "*"`, `caps: ["chrome"]`, a short TTL (`CHROME_TOKEN_TTL_MS`, ~1h — long enough to
build and publish, short enough that a forgotten one is dead soon), label `chrome-refresh`.

- **Scope `*`** gives it the reach `_engine` writes require (`publishAuthDetailed` admits `*`
  for any space id; the untrusted-token guard at `_worker.js:5187` exempts `*`). A narrower
  scope (`_engine`) dies at that guard as `path-not-owned`, which is why star scope is the
  only workable reach — see `CHROME-PUBLISH-GAP.md`.
- **`caps: ["chrome"]`** then narrows that reach to nothing but the chrome bundle:
  `capabilityRefusal` is deny-by-default, so this token is refused on **every** route
  `CAP_ROUTES.chrome` does not name — every real space, `_state`, and crucially
  `_instance/config`. Scope `*` for reach, capability for restraint.

### 2. `CAP_ROUTES.chrome` — engine `src/_worker.js`

```js
chrome: Object.freeze([
  ["_engine", "check"], ["_engine", "blob"], ["_engine", "commit"],
  ["_engine", "manifest"], ["_engine", "versions"], ["_engine", "version"],
]),
```

The write/preflight trio an `--engine` publish performs, plus the manifest/version reads its
base-version CAS needs. **The exact read set is pinned by the workerd rehearsal** — a
`publish.mjs --engine` run against a real object 403s on the first op the list omits, so TDD
names the set rather than this document guessing it. Not `rollback`, not `_state`, not
`_instance/config`, not any other space.

### 3. `sharedChromeRefusal` gains the credential and one exception — engine `src/_worker.js`

Today (`:4642`):

```js
function sharedChromeRefusal(env, tctx, spaceId, op, method) {
  if (spaceId !== ENGINE_SPACE_ID) return null;
  if (!bundleWorkspaceSegment(env, tctx && tctx.tenantId).workspace) return null;
  if (PUBLISH_READ_OPS[op] === method) return null;
  return "chrome-not-writable-here";
}
```

The one addition: permit a write when the credential is **explicitly** granted this route by a
capability. A plain star token has no `caps` array, so it is not explicitly granted and stays
refused — which is exactly what preserves VERIFY clause 2.

```js
// A positive check, distinct from capabilityRefusal's "absent caps ⇒ unrestricted": here
// absence is NOT a grant. Only a credential whose caps name this route may write the shared
// chrome. For _engine ops that is the `chrome` capability and nothing else.
function capabilityGrantsRoute(entry, spaceId, op) {
  const caps = entry && entry.caps;
  if (!Array.isArray(caps)) return false;
  return caps.some((c) => (CAP_ROUTES[c] || []).some(([s, o]) => s === spaceId && o === op));
}

function sharedChromeRefusal(env, tctx, who, spaceId, op, method) {
  if (spaceId !== ENGINE_SPACE_ID) return null;
  if (!bundleWorkspaceSegment(env, tctx && tctx.tenantId).workspace) return null;
  if (PUBLISH_READ_OPS[op] === method) return null;
  if (capabilityGrantsRoute(who, spaceId, op)) return null;   // ← the one narrow key
  return "chrome-not-writable-here";
}
```

The chokepoint call at `:4791` passes the already-resolved `who`. The function's header comment
and `CLAUDE.md`'s "there is no capability that satisfies it" paragraph are rewritten: there is
now exactly one, minted only by the operator `chrome` verb — a lock with one key, not a comment.

**Ordering at the chokepoint is unchanged and load-bearing.** `capabilityRefusal(who, …)` runs
first (a `chrome` token passes only for its granted `_engine` ops; a star token passes
everything; a `purge` token fails on `_engine`). `sharedChromeRefusal(env, tctx, who, …)` runs
one line later (permits the `chrome` token's writes, still refuses the star token's). Two
refusals, two reasons, so a holder can tell "your credential can't" from "nobody's can."

### 4. The `chrome` control verb — engine `src/tenant-do.js`

`"chrome"` joins `CONTROL_VERBS`. Reachable only via `/__control/chrome` — i.e. only by code
holding the namespace binding (the control plane). Like every non-`provision` verb it refuses
`not-provisioned` before doing anything. It mints in-object:

```js
case "chrome": {
  const s = this.status();
  if (!s.provisioned) return Response.json({ error: "not-provisioned" }, { status: 404 });
  const bearer = newSigningKey();                 // 32 bytes, the object's existing random primitive
  const tokenHash = await sha256Hex(bearer);      // sha-256 hex helper — reuse the object's, or add one
  const expiresAt = now + CHROME_TOKEN_TTL_MS;
  this.publishTokenMint({ tokenHash, space: "*", caps: ["chrome"],
                          label: "chrome-refresh", expiresAt }, now);
  return Response.json({ ok: true, token: bearer, expiresAt });
}
```

This is the one place the object mints a token *itself* (the worker's `mintPublishToken`
hashes the bearer externally and posts only the hash to `/identity/token/mint`); here the
object generates the bearer, hashes it, and returns it once — so it needs a sha-256-hex helper
in `tenant-do.js` (reuse an existing one if present, else add a small one). `publishTokenMint`
already accepts `caps` (`tenant-do.js:1956`) and writes the object's
`publish_tokens` row, which is the record `publishAuthDetailed` reads first on a
`TENANTS`-bound deployment. KV is only the read-fallback and holds nothing here — correct,
because a bound deployment is the only shape where `_engine` is shared and this verb exists.

### 5. `publish.mjs --no-config` — engine `scripts/publish.mjs`

The config job at `:892-897` becomes conditional on a new `--no-config` flag. The runbook's
publish is `publish.mjs --engine --no-config`. This is convenience only: a `chrome` token
already gets `403 capability-not-granted` on `_instance/config` (the route sits downstream of
the `:4783` chokepoint), so without the flag the config job would simply fail and make the
command exit non-zero — the chrome commit would still be safe. The flag makes the one command
succeed cleanly.

### 6. The operator verb — control plane

- `src/operator.js`: `"chrome"` added to `OPERATOR_VERBS` (keeps the asserted `OPERATOR_VERBS ⊆
  TENANT_RPC` relation once `TENANT_RPC` gains it too). `grantAllows` needs no change: `chrome`
  is an ordinary existing-workspace verb (equality on workspace + verb membership), not a
  create, so no generated-shape check applies.
- `src/provisioning.js`: `"chrome"` added to `TENANT_RPC` so `callTenant` will carry it.
- `src/operator-route.js`: a `chrome` branch alongside `claim`/`provision`, because it surfaces
  a value the generic path drops. It runs inside the two audit lines, calls
  `callTenant(env, workspace, "chrome")`, and returns the tenant's `token`/`expiresAt` **once**
  in the response body. No request body is read (the grant names the workspace; there is no
  hostname or admin to carry). The bearer is never written to the audit log — the log records
  `attempted`/`ok` exactly as for every other verb.

### 7. Runbook — `augur-control-plane/runbooks/chrome-refresh.md`

The full sequence, in the shape of `operator-credential.md`: mint a `chrome` grant for **one**
live workspace → run the printed INSERT with `hosted.env` creds → `curl` the verb to get the
bearer once → build the engine at the **deployed pin** → `publish.mjs --engine --no-config`
against that workspace's origin → confirm `GET /_build.json` shows the new `engine.sha` on
**every** tenant (the chrome is one shared bundle, so one publish moves all of them) → revoke
the grant. The `--verbs` table in `operator-credential.md` gains `chrome`.

## Data flow

```
operator (chrome grant for W)
  → POST augur.works/tenants/W/chrome        [gate admits; writes "attempted"]
    → callTenant(W, "chrome")
      → W's object /__control/chrome          [mints caps:["chrome"], space:"*", ~1h token]
    ← { token, expiresAt }                    [writes "ok"]
  ← { token, expiresAt }                      [returned once]
operator: build engine @ deployed pin, then
  publish.mjs --engine --no-config  (AUGUR_TOKEN=<token>, AUGUR_ORIGIN=https://W.origin)
    → PUT spaces/_engine/…  (shared global bundle)
  ⇒ every tenant on the deployment now serves the new chrome
```

## Why the hard constraint holds, structurally

`_instance/config` (`_worker.js:4945`) is downstream of the shared `capabilityRefusal`
chokepoint (`:4783`). `CAP_ROUTES.chrome` grants only `_engine` ops, so a `caps:["chrome"]`
token is refused `capability-not-granted` on any config push regardless of its `*` scope. The
roster document cannot be written by this credential. This is the guarantee; `--no-config` is
cosmetic.

## Error handling / refusals

| Caller | Result |
|---|---|
| plain star token, `_engine` write | `403 chrome-not-writable-here` (unchanged, pinned) |
| `chrome` token, `_engine` check/blob/commit | allowed — the credential's whole job |
| `chrome` token, any real space / `_state` / `_instance/config` | `403 capability-not-granted` |
| `chrome` token, `_engine` rollback | `403 capability-not-granted` (rollback is not in `CAP_ROUTES.chrome`, so `capabilityRefusal` catches it first — refused either way) |
| operator grant expired / wrong workspace / missing verb | refused + audit-logged like `suspend` |
| `chrome` verb on a not-provisioned workspace | `404 not-provisioned`, nothing minted |

## Testing

- `test/chrome-write-gate.test.mjs` — **extended, not weakened**: a `chrome`-cap token can
  check/blob/commit `_engine`; cannot write a real space, `_instance/config`, or `rollback`; a
  plain star token still 403s on every `_engine` write. The existing "nothing changed" and
  star-token cases stay exactly as they are.
- `test/token-caps-column.test.mjs` + `scripts/tenant-do-rehearsal.mjs` — the `chrome` cap
  round-trips through the object on real workerd; the rehearsal's `--engine` publish run is what
  pins the exact `CAP_ROUTES.chrome` op list (403 on a missing op).
- Engine tenant-verb test — the `chrome` control verb mints the right shape and refuses
  not-provisioned.
- Control plane — the `OPERATOR_VERBS ⊆ TENANT_RPC` subset test still passes; a route test
  asserts the bearer is surfaced once and that expired/scope refusals are logged; `chrome`
  never appears in an audit row's payload. `test/live-operator.mjs` gains a `chrome` leg.
- `npm run check` + `npm test` green in both repos.

## Live fan-out (final phase, deploy-gated)

Deploy both workers, then — with an explicit go and the `hosted.env` creds confirmed in place —
run the runbook against one live workspace and verify `engine.sha` matches the deployed pin on
`demo.augur.page` and `stoic-canyon-873.augur.page` (both `52c0108a` today). This is the one
step that touches production; it happens only after the mechanism is built, tested and reviewed,
and is flagged before it runs.
