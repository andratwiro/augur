# Chrome-refresh-fanout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a hosted deployment's shared page chrome (`spaces/_engine/…`) exactly one way to be updated again — a short-lived, capability-restricted publish token that only the operator can mint, through the existing grant regime, and that cannot touch any workspace's content or `config/instance.json`.

**Architecture:** A new `chrome` capability in the engine's deny-by-default `CAP_ROUTES` is the enforcement substrate; `sharedChromeRefusal` gains one narrow exception that admits a write only when the credential *explicitly* carries that capability (a plain star token, having no caps, stays refused). The only way to mint a token carrying it is a new `chrome` control verb on the workspace object, reachable only by the control plane, gated by the same named-and-logged operator grant regime as `suspend`/`delete`.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Node's built-in `node:test` + `node:sqlite`, `wrangler dev --local` (workerd) for the rehearsal. Two repos: `augur/` (engine) and `augur-control-plane/`.

## Global Constraints

- **Never touch `config/instance.json`.** The `chrome` capability must not grant `["_instance","config"]`; a chrome token must get `403 capability-not-granted` on any config push. This is the hard, non-negotiable constraint. Verified structurally (the `_instance/config` route sits downstream of the `capabilityRefusal` chokepoint at `src/_worker.js:4783`).
- **Do not weaken or remove any existing case in `test/chrome-write-gate.test.mjs`.** A plain star token must still get `403 chrome-not-writable-here` on every `_engine` write, including `rollback`.
- **Stage only the paths you changed — never `git add -A`.** Both repos are shared checkouts with concurrent agents; `src/_worker.js` has already been swept into another session's commit once (see `.superpowers/sdd/chrome-purge-fix-report.md`). Commit path-by-path.
- **`rollback` stays refused for every credential.** It is deliberately absent from `CAP_ROUTES.chrome`.
- **Both verb lists are written twice, on purpose.** Engine `CONTROL_VERBS` (`src/tenant-do.js:501`) and control-plane `TENANT_RPC` (`src/provisioning.js:48`) must stay identical; each repo's suite reads the other's source and fails on drift. When adding `chrome`, update **both** in the same work session, plus every hardcoded verb-list assertion (`augur-control-plane/test/isolation.test.mjs:449`, and any list in `operator.test.mjs`/`live-operator.mjs`).
- **Operator path verbs are `[a-z]{1,16}`** (`operator-route.js:99`) — the verb is `chrome`, no hyphen.
- Commit messages end with the two trailers this session uses (Co-Authored-By + Claude-Session).

## File Structure

**Engine (`augur/`)**
- `src/_worker.js` — `CAP_ROUTES.chrome`, new `capabilityGrantsRoute()`, `sharedChromeRefusal()` signature + exception, the chokepoint call, two exports. *(The lock.)*
- `src/tenant-do.js` — `"chrome"` in `CONTROL_VERBS`, a `sha256Hex` helper, `CHROME_TOKEN_TTL_MS`, the `chrome` dispatch case that mints the token. *(The key-cutter.)*
- `scripts/publish.mjs` — `--no-config` flag gating the config job. *(Operator convenience.)*
- `test/chrome-write-gate.test.mjs` — extended (chrome token allowed; star still refused; chrome token walled off everything else).
- `test/tenant-verbs.test.mjs` — the `chrome` control verb mints the right shape and refuses not-provisioned.
- `scripts/tenant-do-rehearsal.mjs` — a real-workerd clause pinning the exact `CAP_ROUTES.chrome` op set via a real `--engine` publish.
- `CLAUDE.md` — the "there is no capability that satisfies it" paragraph rewritten.

**Control plane (`augur-control-plane/`)**
- `src/operator.js` — `"chrome"` in `OPERATOR_VERBS`.
- `src/provisioning.js` — `"chrome"` in `TENANT_RPC`.
- `src/operator-route.js` — a `chrome` branch that surfaces the minted bearer once.
- `runbooks/chrome-refresh.md` — the operator procedure (new); `runbooks/operator-credential.md` `--verbs` table gains `chrome`.
- `test/operator.test.mjs` / `test/isolation.test.mjs` — verb-list assertions updated.
- a route test (extend `test/operator-claim.test.mjs` or a new `test/operator-chrome.test.mjs`) — the branch returns the bearer once; expired/scope refusals logged.
- `test/live-operator.mjs` — a `chrome` leg.

---

## Task 1: The lock — `CAP_ROUTES.chrome` + `sharedChromeRefusal` exception (engine)

**Files:**
- Modify: `src/_worker.js` (`CAP_ROUTES` at `:4570`, `sharedChromeRefusal` at `:4642`, the chokepoint at `:4791`, exports at `:11179`)
- Test: `test/chrome-write-gate.test.mjs`

**Interfaces:**
- Consumes: existing `capabilityRefusal(entry, spaceId, op)`, `PUBLISH_READ_OPS`, `bundleWorkspaceSegment`, `ENGINE_SPACE_ID`.
- Produces: `CAP_ROUTES.chrome`; `capabilityGrantsRoute(entry, spaceId, op) → boolean`; new signature `sharedChromeRefusal(env, tctx, who, spaceId, op, method)`.

- [ ] **Step 1: Extend the test fixture to mint a caps-carrying token.**

In `test/chrome-write-gate.test.mjs`, change `deployment()` to accept a `caps` option and add a second bearer whose stored record carries it. Replace the token-doc construction (currently `const hash = await W.tokenFor("pub:" + TOKEN); const doc = JSON.stringify({ [hash]: { space: "*", label: "ci", createdAt: … } });`) with:

```js
const CHROME_TOKEN = "a-chrome-cap-token";
async function deployment({ suffix = null, tenants = false, tenantId = "acme" } = {}) {
  const r2 = memR2({
    "spaces/_engine/manifest.json": JSON.stringify(LIVE_ENGINE),
    "spaces/_engine/versions/8.json": JSON.stringify({ ...LIVE_ENGINE, version: 8 }),
    ["blobs/" + H]: "hello",
  });
  const starHash = await W.tokenFor("pub:" + TOKEN);
  const chromeHash = await W.tokenFor("pub:" + CHROME_TOKEN);
  const doc = JSON.stringify({
    [starHash]: { space: "*", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" },
    [chromeHash]: { space: "*", label: "chrome-refresh", caps: ["chrome"], createdAt: "2026-01-01T00:00:00.000Z" },
  });
  const kv = memKV({ "publish:tokens": doc, [`t/${tenantId}/publish:tokens`]: doc });
  // …rest of deployment() unchanged…
```

Then add a `fireAs(bearer, path, init)` helper beside `fire` so a test can pick the token:

```js
  const fireAs = (bearer, path, init = {}) => {
    W.__setConfigTestState({ cfgAt: 0, cfgGoodAt: 0, roster: null, manifests: null, storage: null });
    const url = new URL("https://x.test" + path);
    return W.publishApi(tctx, new Request(url, {
      ...init, headers: { Authorization: "Bearer " + bearer, ...(init.headers || {}) },
    }), url, env);
  };
  return { env, r2, kv, fire, fireAs };
```

- [ ] **Step 2: Write the failing tests.**

Append to `test/chrome-write-gate.test.mjs`:

```js
// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ONE KEY — a chrome-capability token, and nothing else, may write the chrome
// ─────────────────────────────────────────────────────────────────────────────

test("a CHROME-CAPABILITY token passes the gate on _engine writes the star token could not", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  // `check` is the publish preflight — a clean pass answers 200 with the missing set.
  const res = await d.fireAs(CHROME_TOKEN, "/__publish/_engine/check", {
    method: "POST", body: JSON.stringify({ files: {} }),
  });
  assert.equal(res.status, 200, "chrome token was refused on _engine/check");
});

test("a chrome-capability token may READ the manifest and versions the CAS needs", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  for (const path of ["/__publish/_engine/manifest", "/__publish/_engine/versions", "/__publish/_engine/version/8"]) {
    const res = await d.fireAs(CHROME_TOKEN, path);
    assert.equal(res.status, 200, `${path} answered ${res.status} for the chrome token`);
  }
});

test("the chrome capability is walled off EVERYTHING but the chrome — content, config, rollback", async () => {
  const d = await deployment({ suffix: ".example.test", tenants: true });
  // A real space: refused as capability-not-granted, never granted by the chrome cap.
  const space = await d.fireAs(CHROME_TOKEN, "/__publish/one/check", { method: "POST", body: JSON.stringify({ files: {} }) });
  assert.equal(space.status, 403);
  assert.equal((await space.json()).reason, "capability-not-granted");
  // The roster document — the hard constraint. Structurally refused before it is reached.
  const cfg = await d.fireAs(CHROME_TOKEN, "/__publish/_instance/config", { method: "POST", body: JSON.stringify({ users: [] }) });
  assert.equal(cfg.status, 403);
  assert.equal((await cfg.json()).reason, "capability-not-granted");
  // rollback is not in CAP_ROUTES.chrome, so capabilityRefusal catches it first.
  const rb = await d.fireAs(CHROME_TOKEN, "/__publish/_engine/rollback", { method: "POST", body: JSON.stringify({ version: 8 }) });
  assert.equal(rb.status, 403);
  assert.equal((await rb.json()).reason, "capability-not-granted");
});

test("the star token is STILL refused where the chrome token is admitted", async () => {
  // The regression that clause 2 of the VERIFY names. Same deployment, same route, no caps.
  const d = await deployment({ suffix: ".example.test", tenants: true });
  const res = await d.fireAs(TOKEN, "/__publish/_engine/check", { method: "POST", body: JSON.stringify({ files: {} }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, "chrome-not-writable-here");
});
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `cd ~/Documents/augur-workspace/augur && node --test test/chrome-write-gate.test.mjs`
Expected: the four new tests FAIL (chrome token gets `chrome-not-writable-here` today — there is no capability yet). The existing cases still PASS.

- [ ] **Step 4: Add `chrome` to `CAP_ROUTES`.**

In `src/_worker.js`, inside `CAP_ROUTES` (`:4570`), after the `purge` entry:

```js
  // Update the ONE shared chrome bundle (`spaces/_engine/…`) — the rail, the switcher, the
  // admin screens, `/sw.js`, `404.html` — that one worker build serves to every workspace.
  // The ops an `--engine` publish performs: the write/preflight trio, plus the manifest and
  // version reads its base-version CAS needs. NOT `rollback` (it bypasses the downgrade guard
  // — nobody re-arms a superseded chrome for the whole deployment), NOT any real space, NOT
  // `_state`, and NOT `_instance/config` — which is what keeps this credential off the roster.
  // A token carrying this capability is minted ONLY by the control plane's `chrome` operator
  // verb; see `sharedChromeRefusal`.
  chrome: Object.freeze([
    ["_engine", "check"], ["_engine", "blob"], ["_engine", "commit"],
    ["_engine", "manifest"], ["_engine", "versions"], ["_engine", "version"],
  ]),
```

- [ ] **Step 5: Add `capabilityGrantsRoute` and the `sharedChromeRefusal` exception.**

In `src/_worker.js`, immediately before `sharedChromeRefusal` (`:4642`), add:

```js
/**
 * Does this credential's capability list EXPLICITLY name this route? A positive check, and
 * the exact inverse of `capabilityRefusal`'s "absent caps ⇒ unrestricted": here absence is
 * NOT a grant. Only a credential whose `caps` name this (space, op) may pass the shared-chrome
 * gate — for `_engine` writes that is the `chrome` capability and nothing else, so a plain star
 * token (no `caps`) is not admitted, which is the whole of VERIFY clause 2.
 */
function capabilityGrantsRoute(entry, spaceId, op) {
  const caps = entry && entry.caps;
  if (!Array.isArray(caps)) return false;
  return caps.some((c) => (CAP_ROUTES[c] || []).some(([s, o]) => s === spaceId && o === op));
}
```

Then rewrite `sharedChromeRefusal` (replace the whole function and update its header's "THERE IS NO CAPABILITY THAT SATISFIES IT" paragraph to say there is now exactly one, minted only by the operator `chrome` verb):

```js
function sharedChromeRefusal(env, tctx, who, spaceId, op, method) {
  if (spaceId !== ENGINE_SPACE_ID) return null;
  if (!bundleWorkspaceSegment(env, tctx && tctx.tenantId).workspace) return null;
  if (PUBLISH_READ_OPS[op] === method) return null;
  // The one narrow key: a credential explicitly granted this route by a capability may write
  // the shared chrome. The `chrome` capability is minted only by the operator verb; a star
  // token carries no capability and is still refused here.
  if (capabilityGrantsRoute(who, spaceId, op)) return null;
  return "chrome-not-writable-here";
}
```

- [ ] **Step 6: Pass `who` at the chokepoint and export the new helper.**

In `src/_worker.js:4791`, change the call from `sharedChromeRefusal(env, tctx, spaceId, op, request.method)` to `sharedChromeRefusal(env, tctx, who, spaceId, op, request.method)`.

In the `__testables` export block (`:11179-11180`), add `capabilityGrantsRoute` beside `sharedChromeRefusal, PUBLISH_READ_OPS`.

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `cd ~/Documents/augur-workspace/augur && node --test test/chrome-write-gate.test.mjs`
Expected: all cases PASS (new four + every original).

- [ ] **Step 8: Run the no-globals lint (it inspects module-scope declarations).**

Run: `cd ~/Documents/augur-workspace/augur && node scripts/no-tenant-globals.mjs`
Expected: OK. If it flags `capabilityGrantsRoute`, it is a function declaration (not state) — mirror how `capabilityRefusal` is already accounted for.

- [ ] **Step 9: Commit.**

```bash
cd ~/Documents/augur-workspace/augur
git add src/_worker.js test/chrome-write-gate.test.mjs
git commit -m "The shared chrome has one key: a chrome-capability publish token

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

---

## Task 2: `publish.mjs --no-config` (engine)

**Files:**
- Modify: `scripts/publish.mjs` (flag block near `:77`; config job at `:892-897`)

**Interfaces:**
- Consumes: existing `flag()`, `ENGINE_ONLY`, `DRY`.
- Produces: a `--no-config` flag that removes the `_instance/config` push job.

- [ ] **Step 1: Add the flag.**

In `scripts/publish.mjs`, beside `const ENGINE_ONLY = flag("--engine");` (`:77`):

```js
// --no-config: do NOT push dist/__config/instance.json. For a chrome-only refresh on a
// hosted deployment, where the credential (a `chrome`-capability token) is refused on the
// config route anyway — this skips the job so the one command exits clean instead of failing
// it. There is no single "the instance" whose roster an engine publish speaks for on a
// multi-tenant worker; see augur-deploy-hosted/CHROME-PUBLISH-GAP.md.
const NO_CONFIG = flag("--no-config");
```

- [ ] **Step 2: Gate the config job.**

In `scripts/publish.mjs`, change the config push condition at `:892` from `if (!DRY) {` to:

```js
  if (!DRY && !NO_CONFIG) {
```

- [ ] **Step 3: Verify by inspection (no unit harness for the CLI arg here).**

Run: `cd ~/Documents/augur-workspace/augur && node -e "const s=require('fs').readFileSync('scripts/publish.mjs','utf8'); if(!/NO_CONFIG\s*=\s*flag\(.--no-config.\)/.test(s)||!/!DRY\s*&&\s*!NO_CONFIG/.test(s)) throw new Error('flag not wired'); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: Confirm `--no-config` reaches the help/usage if the file lists flags.**

Run: `cd ~/Documents/augur-workspace/augur && grep -n "allow-unpublish\|--engine" scripts/publish.mjs | head`
If a usage/`die` string enumerates flags, add `--no-config` to it in the same style. If not, skip.

- [ ] **Step 5: Commit.**

```bash
cd ~/Documents/augur-workspace/augur
git add scripts/publish.mjs
git commit -m "publish --no-config: skip the instance-config push for a chrome-only refresh

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

---

## Task 3: The `chrome` control verb — mint the token in-object (engine)

**Files:**
- Modify: `src/tenant-do.js` (`CONTROL_VERBS` at `:501`; add `CHROME_TOKEN_TTL_MS` + a `sha256Hex` helper; the `/__control/` switch at `:2404`)
- Test: `test/tenant-verbs.test.mjs`

**Interfaces:**
- Consumes: `newSigningKey()` (`:565`), `this.publishTokenMint({tokenHash, space, caps, label, expiresAt}, nowMs)` (`:1956`), `this.status()`.
- Produces: `"chrome"` in `CONTROL_VERBS`; `POST /__control/chrome` → `{ok:true, token, expiresAt}` (or `404 not-provisioned`); exported `CHROME_TOKEN_TTL_MS`.

- [ ] **Step 1: Write the failing tests.**

Append to `test/tenant-verbs.test.mjs` (uses the file's existing `workspace()`, `provisioned()`, `control()` helpers, and imports `CONTROL_VERBS`):

```js
test("chrome mints a short-lived, capability-restricted publish token", async () => {
  const w = await provisioned();
  const res = await control(w.store, "chrome");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.token, /^[0-9a-f]{64}$/, "a 32-byte hex bearer, returned exactly once");
  assert.equal(typeof body.expiresAt, "number");
  assert.ok(body.expiresAt > Date.now(), "and it is in the future");
  // The stored row is star-scope but chrome-capped — reach plus restraint.
  const rows = w.db.prepare("SELECT scope, caps, label FROM publish_tokens").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, "*");
  assert.equal(rows[0].label, "chrome-refresh");
  assert.deepEqual(JSON.parse(rows[0].caps), ["chrome"]);
});

test("chrome refuses a workspace nobody provisioned, and creates nothing", async () => {
  const { db, store } = workspace();
  const res = await control(store, "chrome");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, error: "not-provisioned" });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  assert.deepEqual(tables, [], "a chrome call on a typo brought a workspace into being");
});

test("chrome is on CONTROL_VERBS", () => {
  assert.ok(CONTROL_VERBS.includes("chrome"));
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `cd ~/Documents/augur-workspace/augur && node --test test/tenant-verbs.test.mjs`
Expected: the three new tests FAIL (`tenant-verb-not-allowed` today), plus the existing cross-repo "SAME LIST" test now FAILS because the engine list will be behind — that one is fixed in Task 5 (note it, do not "fix" it by reverting).

- [ ] **Step 3: Add the verb, the TTL, and a `sha256Hex` helper.**

In `src/tenant-do.js`, add `"chrome"` to `CONTROL_VERBS` (`:501-503`):

```js
export const CONTROL_VERBS = Object.freeze([
  "provision", "status", "suspend", "resume", "rotate", "delete", "purge", "rename", "claim", "chrome",
]);
```

Near `newSigningKey` (`:565`), add:

```js
/**
 * How long a chrome-refresh token lives. Long enough to build the engine and publish
 * `--engine`, short enough that a forgotten one is dead soon. The credential is minted by the
 * operator `chrome` verb and used once from a laptop; it is not a machine token.
 */
export const CHROME_TOKEN_TTL_MS = 60 * 60 * 1000;

const _enc = new TextEncoder();
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", _enc.encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

*(If a `sha256Hex`/hex helper already exists in this file, reuse it and skip re-declaring.)*

- [ ] **Step 4: Add the dispatch case.**

In the `/__control/` `switch (verb)` (`:2404`), after the `purge` case (before the closing `}` at `:2434`):

```js
        // Mint the ONE credential that may write the shared page chrome: a star-scope token
        // (for reach) capped to `chrome` (for restraint), short-lived, returned exactly once.
        // Reachable only here — i.e. only by the control plane holding the namespace binding —
        // which is what keeps it out of every workspace's own Settings panel. See
        // `sharedChromeRefusal` and `CAP_ROUTES.chrome` in src/_worker.js.
        case "chrome": {
          const s = this.status();
          if (!s.provisioned) return Response.json({ ok: false, error: "not-provisioned" }, { status: 404 });
          const bearer = newSigningKey();
          const tokenHash = await sha256Hex("pub:" + bearer);
          const expiresAt = Date.now() + CHROME_TOKEN_TTL_MS;
          this.publishTokenMint(
            { tokenHash, space: "*", caps: ["chrome"], label: "chrome-refresh", expiresAt },
            Date.now(),
          );
          return Response.json({ ok: true, token: bearer, expiresAt });
        }
```

> ⚠️ The bearer is hashed as `sha256Hex("pub:" + bearer)` because that is exactly what the worker's `publishAuthDetailed`/`tokenFor("pub:" + token)` compares against on the read path (see `test/chrome-write-gate.test.mjs`, which stores under `W.tokenFor("pub:" + TOKEN)`). Confirm the prefix by reading `mintPublishToken` in `src/_worker.js` — if it hashes a bare token, drop the `"pub:"`. **This must match or the token authenticates against nothing.**

- [ ] **Step 5: Run the new tests to verify they pass.**

Run: `cd ~/Documents/augur-workspace/augur && node --test test/tenant-verbs.test.mjs`
Expected: the three new tests PASS. The cross-repo "SAME LIST" test still FAILS (fixed in Task 5).

- [ ] **Step 6: Commit.**

```bash
cd ~/Documents/augur-workspace/augur
git add src/tenant-do.js test/tenant-verbs.test.mjs
git commit -m "chrome control verb: mint the one credential that may refresh shared chrome

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

---

## Task 4: Pin the exact op set on real workerd + document it (engine)

**Files:**
- Modify: `scripts/tenant-do-rehearsal.mjs` (add a clause), `CLAUDE.md` (the shared-chrome paragraph)
- Read for reference: the rehearsal's existing clauses (it runs `wrangler dev --local` with a real R2 + KV + `TENANTS`)

**Interfaces:**
- Consumes: the rehearsal's existing bound worker + publish routes.
- Produces: a clause proving a `chrome`-cap token completes a real `_engine` publish end to end, and a plain star token still 403s — the authoritative pin of the `CAP_ROUTES.chrome` op list.

- [ ] **Step 1: Read the rehearsal to find its publish-through-HTTP clause and its KV/token seams.**

Run: `cd ~/Documents/augur-workspace/augur && grep -n "publish\|_engine\|token\|caps\|clause\|PASS" scripts/tenant-do-rehearsal.mjs | head -40`
Note how it seeds a publish token and how it POSTs `/__publish/…` against the running worker.

- [ ] **Step 2: Add a clause that mints (or seeds) a `caps:["chrome"]` star token and runs the real chrome publish.**

Add, in the file's existing clause style (adapt seam names to what Step 1 found — this is the shape, not verbatim identifiers):

```js
// ── N · the chrome key on real workerd ─────────────────────────────────────────
// Seed a star-scope token capped to `chrome`, and a plain star token beside it. The chrome
// one completes check → blob → commit against the SHARED _engine bundle; the plain one is
// refused chrome-not-writable-here at the same door. If a read op the CAS needs is missing
// from CAP_ROUTES.chrome, the publish 403s here — which is how this clause PINS the op list.
await seedPublishToken(WS, { hash: chromeHash, scope: "*", caps: ["chrome"], label: "chrome-refresh" });
await seedPublishToken(WS, { hash: starHash, scope: "*", label: "ci" });

const okCheck = await pub("/__publish/_engine/check", chromeBearer, { files: engineFiles });
check("a chrome token clears the _engine preflight on the real runtime", okCheck.status === 200);

// …PUT each missing blob with chromeBearer, then commit…
const committed = await pub("/__publish/_engine/commit", chromeBearer, engineManifest);
check("and its commit STICKS — a new _engine version is live", committed.status === 200);

const refused = await pub("/__publish/_engine/check", starBearer, { files: {} });
const refusedBody = await refused.json();
check("a plain star token is STILL refused chrome-not-writable-here", refusedBody.reason === "chrome-not-writable-here");
```

- [ ] **Step 3: Run the rehearsal (needs a local workerd; no account).**

Run: `cd ~/Documents/augur-workspace/augur && node scripts/tenant-do-rehearsal.mjs`
Expected: all checks pass, including the new three. **If the commit 403s** with `capability-not-granted` on a read op (e.g. `currency`), add that `["_engine", "<op>"]` pair to `CAP_ROUTES.chrome` in `src/_worker.js`, re-run Task 1's unit tests, and re-run the rehearsal. This is the intended way the op list is finalized.

- [ ] **Step 4: Update `CLAUDE.md`.**

In `augur/CLAUDE.md`, find the paragraph beginning "⏳ **A shared deployment therefore has NO way to update its chrome until a narrow credential exists**". Rewrite it to state the credential now exists: a `chrome`-capability publish token, minted only by the control plane's `chrome` operator verb, admitted by `sharedChromeRefusal` via `capabilityGrantsRoute`; a plain star token is still refused; the token cannot write `config/instance.json` because `CAP_ROUTES.chrome` grants no `_instance` op. Keep it a snapshot (no dated amendment).

- [ ] **Step 5: Run the doc-drift and vocabulary gates.**

Run: `cd ~/Documents/augur-workspace/augur && npm run check`
Expected: every gate green (Doc drift, no-globals, one-resolver, vocabulary gates).

- [ ] **Step 6: Commit.**

```bash
cd ~/Documents/augur-workspace/augur
git add scripts/tenant-do-rehearsal.mjs CLAUDE.md src/_worker.js
git commit -m "Pin CAP_ROUTES.chrome on real workerd; CLAUDE.md: the chrome key exists now

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

- [ ] **Step 7: Full engine suite.**

Run: `cd ~/Documents/augur-workspace/augur && npm test`
Expected: all pass **except** the cross-repo "SAME LIST" tenant-verbs test, which stays red until Task 5 lands the control-plane list. Do not revert to make it green — Task 5 closes it.

---

## Task 5: Register `chrome` across the control plane's verb lists (control plane)

**Files:**
- Modify: `src/operator.js` (`OPERATOR_VERBS` at `:143`), `src/provisioning.js` (`TENANT_RPC` at `:48`)
- Modify tests: `test/isolation.test.mjs:449` (hardcoded `TENANT_RPC` list), any hardcoded list in `test/operator.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `"chrome"` in both `OPERATOR_VERBS` and `TENANT_RPC`; the subset relation `OPERATOR_VERBS ⊆ TENANT_RPC` still holds.

- [ ] **Step 1: Find every hardcoded verb-list assertion.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && grep -rn "\"suspend\"\|'suspend'\|claim.*delete.*provision\|OPERATOR_VERBS\|TENANT_RPC" test/ | grep -i "deepEqual\|assert\|\[" | head -30`
List each file:line that pins a literal verb array.

- [ ] **Step 2: Write/adjust the failing assertions first.**

Update `test/isolation.test.mjs:449` (the `TENANT_RPC` `deepEqual`) to include `"chrome"`:

```js
  assert.deepEqual([...TENANT_RPC].sort(),
    ["chrome", "claim", "delete", "provision", "purge", "rename", "resume", "rotate", "status", "suspend"]);
```

If `test/operator.test.mjs` asserts the `OPERATOR_VERBS` contents, add `"chrome"` there in sorted position. Add a focused assertion (in `operator.test.mjs`) that the subset relation holds, if one is not already present:

```js
test("chrome is grantable, and every operator verb is a tenant verb", () => {
  assert.ok(OPERATOR_VERBS.includes("chrome"));
  for (const v of OPERATOR_VERBS) assert.ok(TENANT_RPC.includes(v), `${v} is not a tenant verb`);
});
```

- [ ] **Step 3: Run to verify they fail.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && node --test test/isolation.test.mjs test/operator.test.mjs`
Expected: FAIL (lists don't yet include `chrome`).

- [ ] **Step 4: Add `chrome` to both constants.**

`src/provisioning.js:48` — add `"chrome"` to `TENANT_RPC` (keep it beside the others; order need not be sorted in source, the tests sort).

`src/operator.js:143` — add `"chrome"` to `OPERATOR_VERBS`. Update that constant's doc comment to note `chrome` is an existing-workspace verb (like `suspend`), not a create, and that it mints a short-lived chrome-refresh token via the tenant.

- [ ] **Step 5: Run to verify they pass, and confirm cross-repo consistency.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && node --test test/isolation.test.mjs test/operator.test.mjs`
Expected: PASS, including the "THE VERB LIST AND THE ENGINE'S ARE THE SAME LIST" test (it reads `../augur/src/tenant-do.js`, which now has `chrome`).

- [ ] **Step 6: Re-run the engine's mirror test — now green.**

Run: `cd ~/Documents/augur-workspace/augur && node --test test/tenant-verbs.test.mjs`
Expected: PASS in full — the cross-repo "SAME LIST" test now agrees.

- [ ] **Step 7: Commit.**

```bash
cd ~/Documents/augur-workspace/augur-control-plane
git add src/operator.js src/provisioning.js test/isolation.test.mjs test/operator.test.mjs
git commit -m "Register the chrome verb: OPERATOR_VERBS + TENANT_RPC, subset held

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

---

## Task 6: The `chrome` operator route — surface the bearer once, logged (control plane)

**Files:**
- Modify: `src/operator-route.js` (a branch beside `claim`, around `:199`)
- Test: `test/operator-chrome.test.mjs` (new; model on `test/operator-claim.test.mjs`)

**Interfaces:**
- Consumes: `callTenant(env, workspace, "chrome")` (returns the tenant `Response`), `grantAllows`, `auditAppend`, `mintCallId` — all already imported in `operator-route.js`.
- Produces: `POST /tenants/<ws>/chrome` → `200 {ok:true, workspace, verb:"chrome", token, expiresAt, call}` on success; refusals/audit identical to other verbs.

- [ ] **Step 1: Write the failing route tests.**

Create `test/operator-chrome.test.mjs`, modelled on `operator-claim.test.mjs` (reuse its env/D1 harness and grant-minting helper). Cases:

```js
// 1. A live chrome grant returns the bearer once, between two audit lines.
test("a live chrome grant mints a token and returns it once", async () => {
  const { env } = await harnessWithTenant({
    // the fake tenant answers /__control/chrome with a minted token
    chrome: () => ({ ok: true, token: "f".repeat(64), expiresAt: Date.now() + 3600_000 }),
  });
  const bearer = await grant(env, { actor: "operator@example.test", workspace: "acme", verbs: ["chrome"], hours: 1 });
  const res = await operatorCall(req(`/tenants/acme/chrome`, bearer), env);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.token, "f".repeat(64));
  assert.equal(typeof res.body.expiresAt, "number");
  const log = auditRows(env, "acme");
  assert.deepEqual(log.map((r) => r.verdict), ["attempted", "ok"]);
  // The bearer is NEVER in the audit log.
  assert.ok(!JSON.stringify(log).includes("f".repeat(64)));
});

// 2. Wrong workspace → refused-scope, logged, no tenant call.
test("a chrome grant for another workspace is refused-scope and logged", async () => {
  const { env, tenantCalls } = await harnessWithTenant({ chrome: () => ({ ok: true }) });
  const bearer = await grant(env, { actor: "operator@example.test", workspace: "acme", verbs: ["chrome"], hours: 1 });
  const res = await operatorCall(req(`/tenants/other/chrome`, bearer), env);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "refused-scope");
  assert.equal(tenantCalls.length, 0);
  assert.ok(auditRows(env, "other").some((r) => r.verdict === "refused-scope"));
});

// 3. Expired grant → the stranger's answer (null → router 405), still written down.
test("an expired chrome grant is told nothing and still logged", async () => {
  const { env } = await harnessWithTenant({ chrome: () => ({ ok: true }) });
  const bearer = await grant(env, { actor: "operator@example.test", workspace: "acme", verbs: ["chrome"], hours: 1, ageMs: 2 * 3600_000 });
  const res = await operatorCall(req(`/tenants/acme/chrome`, bearer), env);
  assert.equal(res, null); // router turns this into the ordinary 405
  assert.ok(auditRows(env, "acme").some((r) => r.verdict === "refused-expired"));
});
```

*(Adapt `harnessWithTenant`/`grant`/`auditRows`/`req` to the exact helpers `operator-claim.test.mjs` uses; the point is the four assertions, not these names.)*

- [ ] **Step 2: Run to verify they fail.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && node --test test/operator-chrome.test.mjs`
Expected: FAIL — the generic path returns `{ok:true, workspace, verb, call}` with no `token`, so case 1's `token` assertion fails.

- [ ] **Step 3: Add the `chrome` branch.**

In `src/operator-route.js`, after the `claim` branch (`:219`) and before the generic `callTenant` block (`:221`):

```js
  // ⚠️ THE VERB THAT RETURNS A SECRET. `chrome` mints a short-lived, capability-restricted
  // publish token on the workspace object and hands it back ONCE — the operator uses it to
  // publish `--engine --no-config` and refresh the shared page chrome for the whole
  // deployment. No request body: the grant names the workspace, and there is nothing else to
  // say. The bearer is returned to the admitted operator and is NEVER written to the audit
  // log — the log records `attempted`/`ok`, like every other verb.
  if (parsed.verb === "chrome") {
    let res;
    try {
      res = await callTenant(env, workspace, "chrome");
    } catch (e) {
      try { await line("failed"); } catch (e2) { /* the attempt line is written */ }
      return refuse(503, "tenant-unreachable", { call: callId });
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* handled as failed below */ }
    const ok = res && res.ok && body && body.ok && typeof body.token === "string";
    try { await line(ok ? "ok" : "failed"); } catch (e) { /* the attempt line is written */ }
    return ok
      ? { status: 200, body: { ok: true, workspace, verb: "chrome", token: body.token, expiresAt: body.expiresAt, call: callId } }
      : refuse(502, "tenant-refused", { call: callId });
  }
```

- [ ] **Step 4: Run to verify they pass.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && node --test test/operator-chrome.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full control-plane suite.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && npm test`
Expected: all pass. (`test/isolation.test.mjs`'s "reads no env but the binding" test still holds — the branch reads only `callTenant`, no new env.)

- [ ] **Step 6: Commit.**

```bash
cd ~/Documents/augur-workspace/augur-control-plane
git add src/operator-route.js test/operator-chrome.test.mjs
git commit -m "chrome operator route: mint and return the refresh token once, logged

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

---

## Task 7: The runbook + the live-operator leg (control plane)

**Files:**
- Create: `runbooks/chrome-refresh.md`
- Modify: `runbooks/operator-credential.md` (the `--verbs` table row at `:49`), `test/live-operator.mjs` (a `chrome` leg)

**Interfaces:**
- Consumes: everything above.
- Produces: the operator procedure and a live-path assertion.

- [ ] **Step 1: Add `chrome` to the operator-credential verbs table.**

In `runbooks/operator-credential.md:49`, change the `--verbs` row to list `chrome` among the allowed verbs, with a one-clause note: "`chrome` mints a short-lived token that refreshes the shared page chrome — see [Refresh the shared chrome](chrome-refresh.md)".

- [ ] **Step 2: Write `runbooks/chrome-refresh.md`.**

Write the full procedure (in `operator-credential.md`'s voice — snapshot, not diary):

1. **Why one publish is enough** — `spaces/_engine/` is one shared bundle; publishing through any one live workspace refreshes chrome for every tenant.
2. **Mint the grant** — `npm run grant -- --actor <operator-email> --workspace stoic-canyon-873 --verbs chrome --hours 1 --by "chrome refresh, <reason>"`, then run the printed INSERT with `.secrets/hosted.env` creds (the `wrangler d1 execute augur-operator-eu` one-liner).
3. **Get the token** — `curl -sS -X POST https://augur.works/tenants/stoic-canyon-873/chrome -H "authorization: Bearer $OPERATOR_BEARER"` → `{ ok, token, expiresAt }`. Note it once.
4. **Build the engine at the DEPLOYED pin** — from a clean checkout of `augur/` at the sha the worker currently runs (`GET https://stoic-canyon-873.augur.page/_build.json` → `engine.sha` after the worker deploy; or the shell submodule sha).
5. **Publish** — `AUGUR_ORIGIN=https://stoic-canyon-873.augur.page AUGUR_TOKEN=<token> node scripts/publish.mjs --engine --no-config` (with `GV_IDENTITY_PATH`/`GV_DEPLOY_CONFIG_PATH` pointing at the hosted shell, exactly as the shell's deploy does).
6. **Verify** — `GET /_build.json` on `demo.augur.page` AND `stoic-canyon-873.augur.page`: both `engine.sha` now equal the deployed pin (were `52c0108a` before). This is the plan item's VERIFY.
7. **Revoke** — `DELETE FROM operator_grants WHERE actor='<operator-email>';` The audit lines stay.

Include the ⚠️ that a `chrome` token gets `403 capability-not-granted` if pointed at any space or `_instance/config` — that is the guardrail working, not a failure.

- [ ] **Step 3: Add a `chrome` leg to `test/live-operator.mjs`.**

`test/live-operator.mjs` already loops `for (const verb of OPERATOR_VERBS)`. Ensure the `chrome` verb is exercised against the deployed worker + real store like the others (mint grant → call → assert a token comes back or `tenant-unreachable` in the pre-deploy state → read its own audit lines → revoke). Keep everything named `aqa-<runid>`. This file is `npm run live:operator`, not part of `npm test`.

- [ ] **Step 4: Verify the docs and the offline suite.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && npm test`
Expected: all pass (the runbook/live file are not unit-run, but confirm nothing else broke).

- [ ] **Step 5: Commit.**

```bash
cd ~/Documents/augur-workspace/augur-control-plane
git add runbooks/chrome-refresh.md runbooks/operator-credential.md test/live-operator.mjs
git commit -m "Runbook: refresh the shared chrome via the chrome operator verb

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015au95v6Pfh2AxwrZhfhLAS"
```

---

## Task 8: Full green in both repos, then the plan-item close-out

**Files:** none (verification + plan status)

- [ ] **Step 1: Engine suite + gates.**

Run: `cd ~/Documents/augur-workspace/augur && npm test && npm run check`
Expected: `pass N / fail 0`, every gate green.

- [ ] **Step 2: Control-plane suite.**

Run: `cd ~/Documents/augur-workspace/augur-control-plane && npm test`
Expected: all pass.

- [ ] **Step 3: Rehearsal, once more, clean.**

Run: `cd ~/Documents/augur-workspace/augur && node scripts/tenant-do-rehearsal.mjs`
Expected: all checks pass, including the chrome clause.

- [ ] **Step 4: STOP — the live fan-out is a separate, deploy-gated step.** Do not deploy or publish here. The live VERIFY (both `/_build.json` shas match) requires: (a) both workers deployed with this code, (b) an explicit go from the human operator with `.secrets/hosted.env` confirmed, (c) the runbook run once. Surface this as the remaining step; do not perform it inside plan execution.

- [ ] **Step 5: Mark the plan item done and ship the plan page.**

```bash
cd ~/Documents/augur-workspace/augur-space-delta/hosted
node plan-status.mjs done D-chrome-refresh-fanout "Built the chrome-refresh credential: CAP_ROUTES.chrome + a sharedChromeRefusal exception (star tokens still 403 chrome-not-writable-here), a chrome control verb minting a short-lived caps:[\"chrome\"] star token, and a 7th operator verb (grant-gated, expiring, audit-logged) as its only mint. Cannot touch config/instance.json by construction. Mechanism + tests + rehearsal green in both repos; runbook at augur-control-plane/runbooks/chrome-refresh.md. Live fan-out (deploy + one --engine --no-config publish → both tenants off 52c0108a) is the remaining deploy-gated step."
cd ~/Documents/augur-workspace/augur-space-delta && node ../augur/scripts/ship.mjs
```

Expected: the plan page updates and ships to the hosted workspace.

---

## Self-Review

**Spec coverage:**
- Credential shape (`scope:"*"` + `caps:["chrome"]` + TTL) → Task 3. ✓
- `CAP_ROUTES.chrome` → Task 1 (op list finalized in Task 4). ✓
- `sharedChromeRefusal` exception, star still refused → Task 1. ✓
- Hard constraint (no `config/instance.json`) → Task 1 test (`capability-not-granted` on `_instance/config`) + structural note. ✓
- `chrome` control verb, control-plane-only → Task 3. ✓
- `publish.mjs --no-config` → Task 2. ✓
- Operator verb (OPERATOR_VERBS + TENANT_RPC + route, grant-gated/expiring/logged) → Tasks 5, 6. ✓
- Runbook + verbs table + live leg → Task 7. ✓
- CLAUDE.md → Task 4. ✓
- Live fan-out deferred, deploy-gated → Task 8. ✓
- Every existing chrome-write-gate case preserved → Task 1 (Global Constraint + explicit "the star token is STILL refused" case). ✓

**Placeholder scan:** The one deliberate open point — the exact read-op tail of `CAP_ROUTES.chrome` — is resolved by Task 4's rehearsal (a 403 names the missing op), with a starting list given in Task 1. Not a placeholder: a named finalization step with a failure signal. Test-harness helper names in Tasks 6–7 are marked "adapt to the file's existing helpers" because those files' fixtures are the source of truth; the assertions are concrete.

**Type consistency:** `capabilityGrantsRoute(entry, spaceId, op)` and `sharedChromeRefusal(env, tctx, who, spaceId, op, method)` are used with those signatures at the Task 1 chokepoint. `publishTokenMint({tokenHash, space, caps, label, expiresAt}, nowMs)` matches `tenant-do.js:1956`. `CONTROL_VERBS`/`TENANT_RPC`/`OPERATOR_VERBS` all gain the same string `"chrome"`. The token hash prefix (`"pub:" + bearer`) is flagged in Task 3 Step 4 as must-match-the-worker, with a verification instruction.
