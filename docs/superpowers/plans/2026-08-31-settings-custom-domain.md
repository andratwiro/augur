# Settings Shows the Claimed Platform Subdomain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Admin → Settings "Custom URL" field shows a workspace's real claimed
platform subdomain (e.g. `demo.augur.page`) when one exists, instead of always
rendering the static "Not available yet" copy.

**Architecture:** One new admin-only JSON route, `GET /__admin/custom-domain`, that
reuses the engine's existing `readSuspension()` call (already run on every request for
the generated-address redirect) to read the workspace's `canonicalHost` — zero new
store shape, zero new KV reads. A small client-side fetch in the existing Settings
script block fills the field if a hostname comes back.

**Tech Stack:** Cloudflare Worker (`src/_worker.js`), `node:test` for the worker suite,
plain template-literal HTML/JS in `build.js` (no framework, matches every other
Settings field on this page).

## Global Constraints

- Admin-only: the route must 403 for anyone whose `me.role !== "admin"`, matching
  every other `/__admin/*` route (`adminStorageApi`, `adminVersionApi`).
- No new store reads beyond `readSuspension()` — do not add a KV `list()` scan or any
  new persisted shape. (Spec: `docs/superpowers/specs/2026-08-31-settings-custom-domain-design.md`)
- Unclaimed state renders byte-identically to today. No copy change, no layout change,
  for a workspace with no `canonical_host`.
- Scope is platform subdomains only (`B-claim-platform-subdomain`). Do not add any
  field, copy, or code path implying real custom domains (`B-custom-hostname-alias`) —
  that item isn't built.
- No self-service claim affordance — the field stays read-only.

---

### Task 1: `GET /__admin/custom-domain` backend route

**Files:**
- Modify: `src/_worker.js` — add `adminCustomDomainApi` near `adminStorageApi`
  (currently defined at `src/_worker.js:5786`), wire it into the admin dispatch table
  beside the `/__admin/storage` and `/__admin/version` lines
  (`src/_worker.js:10720-10726`), and add it to the `__testables` export
  (`src/_worker.js:11011`, alongside `adminStorageApi` at line 11075).
- Test: `test/admin-custom-domain.test.mjs` (new file)

**Interfaces:**
- Consumes: `readSuspension(tenantId, env, now)` — already exported via
  `__testables` (`src/_worker.js:11011` block, `readSuspension` entry) and already
  used by the front-door redirect. Returns `null` (single-workspace instance) or a doc
  shaped `{suspended, moved, canonicalHost}` (or `undefined` meaning "not yet known" —
  `readSuspension` normalizes that internally, callers never see `undefined`).
  `jsonResponse(obj, status = 200)` — the existing helper every other admin route uses.
- Produces: `adminCustomDomainApi(tenantId, env, me)` → `Promise<Response>`, JSON body
  `{claimed: boolean, hostname: string|null}`. Exported via `__testables` as
  `adminCustomDomainApi` for Task 1's own test and any later caller.

- [ ] **Step 1: Write the failing test**

Create `test/admin-custom-domain.test.mjs`:

```js
// The Settings panel's "Custom URL" field reads this — a claimed workspace shows its
// real hostname, an unclaimed one shows nothing, and only an admin may ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed" };

const SUFFIX = ".example.com";

/** Same shape as test/tenant-claim.test.mjs's suspensionNamespace — a TENANTS
 * namespace whose objects answer /suspension with a fixed doc. */
function suspensionNamespace(docs) {
  return {
    idFromName(name) { return { name, toString: () => `id:${name}` }; },
    get(id) {
      return {
        id,
        async fetch(url) {
          const doc = docs[id.name] || { suspended: false, moved: false, canonicalHost: null };
          if (String(url).endsWith("/suspension")) return Response.json(doc);
          return Response.json({});
        },
      };
    },
  };
}

test("only an admin may ask", async () => {
  const env = { TENANT_HOST_SUFFIX: SUFFIX, TENANTS: suspensionNamespace({}) };
  for (const who of [null, EDITOR]) {
    const res = await W.adminCustomDomainApi("some-workspace", env, who);
    assert.equal(res.status, 403, `${who ? who.email : "anonymous"} must not read this`);
  }
});

test("a claimed workspace reports its canonical hostname", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "claimed-ws": { suspended: false, moved: false, canonicalHost: `demo${SUFFIX}` },
    }),
  };
  const res = await W.adminCustomDomainApi("claimed-ws", env, ADMIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: true, hostname: `demo${SUFFIX}` });
});

test("an unclaimed workspace reports claimed:false, hostname:null", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: suspensionNamespace({
      "plain-ws": { suspended: false, moved: false, canonicalHost: null },
    }),
  };
  const res = await W.adminCustomDomainApi("plain-ws", env, ADMIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: false, hostname: null });
});

test("a single-workspace instance (no TENANTS binding) reports claimed:false", async () => {
  const res = await W.adminCustomDomainApi("whatever", {}, ADMIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { claimed: false, hostname: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --test test/admin-custom-domain.test.mjs`
Expected: FAIL — `W.adminCustomDomainApi is not a function` (it doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `src/_worker.js`, add this function immediately after `adminStorageApi` (which ends
around `src/_worker.js:5820` — place it directly below that function's closing brace,
before the next unrelated function):

```js
/**
 * The Settings panel's "Custom URL" field — a workspace's claimed platform subdomain,
 * if any (`B-claim-platform-subdomain`). Reads `readSuspension`'s existing per-isolate
 * cache, the same call the front-door redirect already makes every request: no new
 * store shape, no new KV read.
 */
async function adminCustomDomainApi(tenantId, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const doc = await readSuspension(tenantId, env);
  const hostname = (doc && doc.canonicalHost) || null;
  return jsonResponse({ claimed: !!hostname, hostname });
}
```

Wire it into the admin dispatch table. Find these two lines (`src/_worker.js:10720`
and `src/_worker.js:10726`):

```js
    if (url.pathname === "/__admin/storage") return adminStorageApi(tctx.tenantId, env, me);
```
```js
    if (url.pathname === "/__admin/version") return adminVersionApi(tctx, env, me);
```

Add a new line directly after the `/__admin/storage` line:

```js
    if (url.pathname === "/__admin/custom-domain") return adminCustomDomainApi(tctx.tenantId, env, me);
```

Add it to `__testables` (`src/_worker.js:11011` block) directly after the
`adminStorageApi,` line (`src/_worker.js:11075`):

```js
  adminStorageApi,
  adminCustomDomainApi,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --test test/admin-custom-domain.test.mjs`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Run the full worker suite to confirm no regressions**

Run: `npm test`
Expected: PASS — same pass count as before this change, plus the 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/_worker.js test/admin-custom-domain.test.mjs
git commit -m "Add GET /__admin/custom-domain — Settings' claimed-subdomain read"
```

---

### Task 2: Settings panel renders the claimed hostname

**Files:**
- Modify: `build.js:5826-5827` (HTML — add a data hook to the existing note
  paragraph) and `build.js:5521-5522` (JS — add the fetch block beside the
  `data-set-origin` fill).

**Interfaces:**
- Consumes: `GET /__admin/custom-domain` from Task 1 → `{claimed: boolean, hostname:
  string|null}`.
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Add the data hook to the HTML**

In `build.js`, find (`build.js:5822-5827`):

```html
  <div class="auset__row" data-custom-url>
    <label class="auset__label" for="auset-url">Custom URL</label>
    <input type="text" id="auset-url" data-set-url value="" placeholder="prototypes.yourdomain.com"
           disabled aria-describedby="auset-url-note" />
    <p class="auset__note" id="auset-url-note">Not available yet. This workspace is
      served at <b data-set-origin>its built-in address</b>.</p>
  </div>
```

Replace the `<p>` line with (adds `data-set-url-note`, nothing else changes):

```html
    <p class="auset__note" id="auset-url-note" data-set-url-note>Not available yet. This workspace is
      served at <b data-set-origin>its built-in address</b>.</p>
```

- [ ] **Step 2: Add the fetch block to the settings script**

In `build.js`, find (`build.js:5519-5522`):

```js
  // The address this workspace is actually served at, so the disabled Custom URL field
  // says something true rather than sitting empty next to a promise.
  var oEl = document.querySelector('[data-set-origin]');
  if(oEl) oEl.textContent = location.host;
```

Add directly after it:

```js

  // The claimed platform subdomain, if any (B-claim-platform-subdomain) — leaves the
  // field exactly as it is today when there isn't one.
  var uEl = document.querySelector('[data-set-url]');
  var uNote = document.querySelector('[data-set-url-note]');
  fetch('/__admin/custom-domain', {headers:{'Accept':'application/json'}}).then(function(r){
    return r.ok ? r.json() : null;
  }).then(function(d){
    if(d && d.claimed && d.hostname && uEl){
      uEl.value = d.hostname;
      if(uNote) uNote.textContent = "This workspace's custom address.";
    }
  }).catch(function(){});
```

- [ ] **Step 3: Build and drive it locally**

Run: `npm run offline` (or `OFFLINE_PORT=8791 npm --prefix augur run offline` from the
workspace root if the default port is taken by another local server).

In a browser, signed in as an admin:
1. Go to `/__admin#settings` (or the Settings tab in the admin panel) on a workspace
   with no `TENANTS` binding / no claim. Confirm the Custom URL row is unchanged: empty
   disabled input, "Not available yet. This workspace is served at
   `<host>`." note.
2. There's no local way to fabricate a `canonical_host` without a real `TENANTS`
   binding, so the claimed-state visual is confirmed in Task 3 against real production
   data (demo/Fulla, already claimed) rather than here.

- [ ] **Step 4: Commit**

```bash
git add build.js
git commit -m "Settings: render the claimed platform subdomain when one exists"
```

- [ ] **Step 5: Push**

Engine convention is small units pushed often, and a push here auto-deploys via the
shell's engine-pin bump — this ships to every live instance (Delta, demo/Fulla)
within ~1 minute.

```bash
git push
```

---

### Task 3: Verify against real production data (Delta + demo/Fulla)

**Files:** none — verification only, no code changes.

**Interfaces:** none.

- [ ] **Step 1: Confirm demo/Fulla (already claimed) renders correctly**

`demo.augur.page` has carried `canonical_host = demo.augur.page` since 28 Aug
(`B-claim-platform-subdomain`'s own status note). Sign in as an admin at
`https://demo.augur.page/__admin#settings` (or `https://flint-birch-702.augur.page`,
which 302s there) and confirm:
- The Custom URL input shows `demo.augur.page`.
- The note reads "This workspace's custom address."

- [ ] **Step 2: Confirm Delta (not yet claimed) still renders the unclaimed copy**

Sign in as an admin at `https://stoic-canyon-873.augur.page/__admin#settings` and
confirm the row is untouched: empty input, "Not available yet. This workspace is
served at `stoic-canyon-873.augur.page`." This is the expected state until this
workspace's own subdomain claim runs — a separate ops action, not part of this plan.

- [ ] **Step 3: Report back**

Confirm both to the user, and that this plan's work is done — the claim itself is the
next, separate step.

## Self-Review Notes

- **Spec coverage:** every Goal in the design spec maps to a task — the backend route
  (Task 1), the frontend fill + unclaimed-state preservation (Task 2), and real-data
  verification (Task 3). Non-goals (real custom domains, self-service, showing the
  generated address) have no task and are called out explicitly in Global Constraints
  so no later task drifts into them.
- **Placeholder scan:** no TBD/TODO; every step shows real, complete code copied from
  or matching the actual current file contents (verified by reading the live line
  ranges cited above before writing this plan).
- **Type consistency:** `adminCustomDomainApi(tenantId, env, me)` — same three-arg
  shape as `adminStorageApi`, same `{claimed, hostname}` shape used consistently in the
  test, the implementation, and the frontend fetch handler.
