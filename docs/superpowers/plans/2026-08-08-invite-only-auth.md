# Invite-only Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Augur's plaintext password store with PBKDF2 hashes, HMAC sessions and single-use invite links, so no plaintext credential exists anywhere and the operator never knows a user's password.

**Architecture:** All changes land in `src/_worker.js` (a single Cloudflare Pages worker) plus the admin UI string in `build.js`. Passwords become `pbkdf2$…` hashes stored in the `users:secrets` KV key; invite tokens live in a new `users:invites` KV key. Two temporary compatibility paths (legacy plaintext verify, legacy session derivation) keep the deploy invisible to existing users and are deleted in a defined finish step.

**Tech Stack:** Cloudflare Workers runtime, Web Crypto (`crypto.subtle`), Cloudflare KV, `node --test` (zero dependencies), vanilla JS for the admin UI.

## Global Constraints

- Node ≥18. **Zero new runtime or dev dependencies** — Web Crypto is available in both Workers and Node ≥18.
- `src/_worker.js`'s top level must stay side-effect free so `test/worker.test.mjs` can import it. Build-injected placeholders (`USERS`, `BUILD_ID`, …) stay inert empty values at import time.
- Password hash format is exactly `pbkdf2$<iterations>$<saltB64>$<hashB64>`, PBKDF2-SHA-256, 100000 iterations, 16-byte random salt.
- KV keys: `users:secrets` (existing), `users:invites` (new), `users:lastseen:<email>` (existing).
- Cookie name is `gv_user`, value `<email>.<token>`.
- Every temporary compatibility path MUST carry the exact comment marker `// TEMPORARY (migration) — remove in the finish step` so the finish step can find them.
- **Do not push to engine `main` without explicit confirmation.** A push to `main` fires `deploy-trigger.yml` → `repository_dispatch` at `SHELL_REPO` (`andratwiro/augur-deploy`, the Go Vocal instance) and deploys within ~1 minute. Work on a branch.
- Run `npm test` before every commit.

---

### Task 1: Test harness, crypto helpers, password hashing

**Files:**
- Modify: `package.json` (add `test` script)
- Create: `.github/workflows/test.yml`
- Create: `test/worker.test.mjs`
- Modify: `src/_worker.js` (add crypto helpers, hashing, `__testables` export)

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `encodeUtf8(s) -> Uint8Array`
  - `toHex(buf) -> string`
  - `toB64(buf) -> string`, `fromB64(s) -> Uint8Array`
  - `safeEqual(a, b) -> boolean`
  - `isPassHash(s) -> boolean`
  - `hashPassword(password, iterations?, salt?) -> Promise<string>` returning `pbkdf2$…`
  - `verifyPassword(password, stored) -> Promise<boolean>` (accepts hash **or** legacy plaintext)
  - `PBKDF2_ITERATIONS = 100000`
  - `export const __testables = { … }` from `src/_worker.js`

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"` immediately after `"build"`:

```json
    "test": "node --test \"test/*.test.mjs\"",
```

- [ ] **Step 2: Write the failing test**

Create `test/worker.test.mjs`:

```javascript
// Unit tests for the pure helpers in src/_worker.js (imported directly — the file's
// top level is all const/function definitions, so importing is side-effect free and
// the build-injected placeholders stay inert empty values). Zero dependencies:
// node --test + node:assert + the global Web Crypto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

test("placeholders are inert at import time (raw copy gates nothing)", () => {
  assert.equal(W.userByEmail("nobody@example.test"), null); // USERS = []
});

test("hash/verify roundtrip (PBKDF2, random salt)", async () => {
  const h = await W.hashPassword("correct horse battery");
  assert.ok(W.isPassHash(h), "produces a pbkdf2$… string");
  assert.match(h, new RegExp(`^pbkdf2\\$${W.PBKDF2_ITERATIONS}\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$`));
  assert.equal(await W.verifyPassword("correct horse battery", h), true);
  assert.equal(await W.verifyPassword("wrong horse", h), false);
  assert.equal(await W.verifyPassword("", h), false);
});

test("each hash uses a fresh salt", async () => {
  const a = await W.hashPassword("same password");
  const b = await W.hashPassword("same password");
  assert.notEqual(a, b, "same password hashes differently");
  assert.equal(await W.verifyPassword("same password", a), true);
  assert.equal(await W.verifyPassword("same password", b), true);
});

test("verifyPassword accepts a legacy plaintext value", async () => {
  // TEMPORARY (migration) — this test is removed in the finish step.
  assert.equal(await W.verifyPassword("augur-legacy-2026", "augur-legacy-2026"), true);
  assert.equal(await W.verifyPassword("nope", "augur-legacy-2026"), false);
});

test("verifyPassword rejects malformed hashes without throwing", async () => {
  assert.equal(await W.verifyPassword("x", "pbkdf2$100000$notbase64!!$also!!"), false);
  assert.equal(await W.verifyPassword("x", "pbkdf2$onlythree$parts"), false);
  assert.equal(await W.verifyPassword("x", null), false);
});

test("safeEqual compares without short-circuiting on content", () => {
  assert.equal(W.safeEqual("abc", "abc"), true);
  assert.equal(W.safeEqual("abc", "abd"), false);
  assert.equal(W.safeEqual("abc", "abcd"), false);
  assert.equal(W.safeEqual(null, ""), true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `SyntaxError` or `The requested module '../src/_worker.js' does not provide an export named '__testables'`

- [ ] **Step 4: Add the crypto helpers**

In `src/_worker.js`, immediately after the `isRestrictedPath` function, insert:

```javascript
// ---- Crypto helpers (Web Crypto — available in workers AND node ≥18) ---------
const encodeUtf8 = (s) => new TextEncoder().encode(s);
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
function toB64(buf) { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); }
function fromB64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

// Constant-time-ish string compare — never short-circuits on content (length leak
// is fine; both operands here are fixed-length digests or clamped inputs).
function safeEqual(a, b) {
  a = String(a == null ? "" : a); b = String(b == null ? "" : b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Password hashing (PBKDF2-SHA-256) ---------------------------------------
// Stored format — ONE string: "pbkdf2$<iterations>$<saltB64>$<hashB64>".
const PBKDF2_ITERATIONS = 100000;
const PASS_HASH_PREFIX = "pbkdf2$";

async function pbkdf2Bits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encodeUtf8(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, keyMaterial, 256);
}

function isPassHash(s) { return typeof s === "string" && s.startsWith(PASS_HASH_PREFIX); }

async function hashPassword(password, iterations = PBKDF2_ITERATIONS, salt) {
  if (!salt) salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(password, salt, iterations);
  return `${PASS_HASH_PREFIX}${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

// Verify a candidate password against a stored secret.
async function verifyPassword(password, stored) {
  if (typeof password !== "string" || !password) return false;
  if (typeof stored !== "string" || !stored) return false;
  if (isPassHash(stored)) {
    const parts = stored.split("$"); // ["pbkdf2", iterations, saltB64, hashB64]
    if (parts.length !== 4) return false;
    const iterations = Math.max(1, Math.min(1 << 22, Number(parts[1]) || 0));
    let salt;
    try { salt = fromB64(parts[2]); } catch (e) { return false; }
    let bits;
    try { bits = await pbkdf2Bits(password, salt, iterations); } catch (e) { return false; }
    return safeEqual(toB64(bits), parts[3]);
  }
  // TEMPORARY (migration) — remove in the finish step
  return safeEqual(password, stored); // legacy plaintext override
}
```

- [ ] **Step 5: Export the testables**

At the very end of `src/_worker.js`, after the default export, append:

```javascript
// Pure helpers exposed for unit tests. Nothing in the request path references
// __testables — it exists only so test/worker.test.mjs can import them.
export const __testables = {
  hashPassword, verifyPassword, isPassHash, safeEqual, userByEmail,
  PBKDF2_ITERATIONS,
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 tests passing, 0 failing

- [ ] **Step 7: Add CI so a red suite is visible before merge**

Create `.github/workflows/test.yml`:

```yaml
# Unit tests for the worker's pure helpers (node --test, zero dependencies — no
# npm install, no submodule checkout needed). Runs on every branch so a red suite
# is visible BEFORE anything merges to main (main auto-deploys).
name: test

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
```

- [ ] **Step 8: Commit**

```bash
git add package.json .github/workflows/test.yml test/worker.test.mjs src/_worker.js
git commit -m "Auth: PBKDF2 password hashing + a unit suite to hold it"
```

---

### Task 2: HMAC sessions, accepting the legacy derivation

**Files:**
- Modify: `src/_worker.js` (add `hmacToken`, rewrite `userToken`, rewrite `identify`)
- Modify: `test/worker.test.mjs` (append tests)

**Interfaces:**
- Consumes: `safeEqual`, `toHex`, `encodeUtf8` (Task 1)
- Produces:
  - `effectiveSecret(env, u) -> Promise<string>` — renamed from `effectivePass`; KV override ?? `u.passHash` ?? `u.pass` ?? `""`
  - `hmacToken(secret, message) -> Promise<string>` (hex)
  - `tokenFor(secret) -> Promise<string>` (legacy SHA-256 derivation, hex)
  - `userToken(env, u) -> Promise<string>` — the **new** HMAC token
  - `legacyUserToken(env, u) -> Promise<string>` — the **old** derivation, accepted but never issued
  - `identify(request, env, users?) -> Promise<user|null>`

`SESSION_SECRET` is read from `env`. When unset, `userToken` falls back to the legacy derivation so a mis-ordered deploy degrades instead of locking everyone out.

**The rename lands here, not in Task 3**, because `userToken` depends on it. `effectivePass` has **five** references in `src/_worker.js` — the definition plus four call sites. All of them move in Step 3 below; leaving any behind is a build break.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```javascript
// Minimal in-memory KV mirroring the subset the worker uses.
function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}
const envWith = (kv, extra = {}) => ({ COMMENTS: kv, ...extra });
const USER = { email: "a@example.test", name: "A", role: "admin" };

function cookieRequest(value) {
  return new Request("https://example.test/", { headers: { Cookie: `gv_user=${value}` } });
}

test("session token is an HMAC when SESSION_SECRET is set", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.userToken(env, USER);
  assert.match(t, /^[0-9a-f]{64}$/, "hex HMAC-SHA-256");
  const same = await W.userToken(env, USER);
  assert.equal(t, same, "deterministic for the same secret");
  const other = await W.userToken(envWith(kv, { SESSION_SECRET: "different" }), USER);
  assert.notEqual(t, other, "keyed by SESSION_SECRET");
});

test("identify accepts a new-derivation cookie", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.userToken(env, USER);
  const got = await W.identify(cookieRequest(`a@example.test.${t}`), env, [USER]);
  assert.equal(got && got.email, "a@example.test");
});

test("identify also accepts a legacy-derivation cookie", async () => {
  // TEMPORARY (migration) — this test is removed in the finish step.
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const legacy = await W.legacyUserToken(env, USER);
  const got = await W.identify(cookieRequest(`a@example.test.${legacy}`), env, [USER]);
  assert.equal(got && got.email, "a@example.test", "existing sessions survive the deploy");
});

test("identify rejects a forged or stale token", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  assert.equal(await W.identify(cookieRequest("a@example.test.deadbeef"), env, [USER]), null);
  assert.equal(await W.identify(cookieRequest("nosuchdot"), env, [USER]), null);
  assert.equal(await W.identify(new Request("https://example.test/"), env, [USER]), null);
});

test("changing the stored secret invalidates existing cookies", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "pbkdf2$1$AAAA$BBBB" }) });
  const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.userToken(env, USER);
  await kv.put("users:secrets", JSON.stringify({ "a@example.test": "pbkdf2$1$CCCC$DDDD" }));
  assert.equal(await W.identify(cookieRequest(`a@example.test.${t}`), env, [USER]), null);
});

test("effectiveSecret prefers the KV override over the roster value", async () => {
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "override" }) });
  const env = envWith(kv);
  assert.equal(await W.effectiveSecret(env, { email: "a@example.test", pass: "roster" }), "override");
  assert.equal(await W.effectiveSecret(env, { email: "b@example.test", pass: "roster" }), "roster");
  assert.equal(await W.effectiveSecret(env, { email: "b@example.test", passHash: "pbkdf2$x", pass: "roster" }), "pbkdf2$x");
  assert.equal(await W.effectiveSecret(env, { email: "c@example.test" }), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `W.userToken is not a function`

- [ ] **Step 3a: Rename `effectivePass` to `effectiveSecret` at all five references**

Run this to see every reference before changing anything:

```bash
grep -n 'effectivePass' src/_worker.js
```

Expected: 5 lines — the definition, `userToken`, the `/__publish/_login/token` check, the
`adminUsersApi` GET branch, and the `/__auth` handler.

Replace the definition with the renamed version (the body also learns `passHash`):

```javascript
// Effective secret = admin-set KV override ?? the roster value. One kv.get.
// The value is a pbkdf2 hash string, or — during migration only — a legacy plaintext.
async function effectiveSecret(env, u) {
  if (!u) return "";
  try {
    const k = kvFor(env);
    const raw = k ? await k.get(USER_SECRETS_KEY) : null;
    const ov = raw ? JSON.parse(raw) : {};
    if (ov && typeof ov[u.email] === "string" && ov[u.email]) return ov[u.email];
  } catch (e) {}
  return u.passHash || u.pass || "";
}
```

Then update the four call sites to `effectiveSecret`. Three are mechanical; the fourth —
the `pass:` line in `adminUsersApi`'s GET branch — should be **deleted outright** rather
than renamed, so the admin API stops returning secrets immediately rather than one task
later. Task 6 rebuilds that response properly.

Verify nothing was missed:

```bash
grep -c 'effectivePass' src/_worker.js
```

Expected: `0`

- [ ] **Step 3b: Implement the session functions**

In `src/_worker.js`, replace the existing `tokenFor` and `userToken` definitions and the `identify` function with:

```javascript
// Legacy token derivation — SHA-256("gv:" + secret). Still ACCEPTED during migration
// (see identify) and used as the fallback when SESSION_SECRET is unset, but new
// tokens are always issued by hmacToken().
async function tokenFor(secret) {
  return toHex(await crypto.subtle.digest("SHA-256", encodeUtf8("gv:" + secret)));
}

async function hmacToken(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encodeUtf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encodeUtf8(message)));
}

// Session cookie token: HMAC-SHA-256(SESSION_SECRET, "email:effectiveSecret").
// SESSION_SECRET is a runtime env var — NEVER baked into the bundle — so a cookie
// cannot be forged from repo-visible data. Binding to the effective secret means
// changing or clearing a password invalidates that user's cookies for free.
async function userToken(env, u) {
  const secret = await effectiveSecret(env, u);
  const sessionSecret = env && env.SESSION_SECRET;
  if (sessionSecret) return hmacToken(sessionSecret, u.email + ":" + secret);
  return tokenFor(u.email + ":" + secret);
}

// TEMPORARY (migration) — remove in the finish step
// The pre-HMAC derivation. Accepted by identify() so sessions created before the
// hashed worker deployed keep working; never issued.
async function legacyUserToken(env, u) {
  return tokenFor(u.email + ":" + (await effectiveSecret(env, u)));
}

// Resolve the signed-in user from the gv_user cookie ("<email>.<token>"). Stateless —
// no session store. `users` defaults to the injected USERS; tests pass their own list.
async function identify(request, env, users = USERS) {
  if (!users.length) return null;
  const cookies = request.headers.get("Cookie") || "";
  const c = cookies.split(/;\s*/).find((x) => x.startsWith(USER_COOKIE + "="));
  if (!c) return null;
  const val = c.slice(USER_COOKIE.length + 1);
  const dot = val.lastIndexOf(".");
  if (dot < 1) return null;
  const u = userByEmail(val.slice(0, dot), users);
  if (!u) return null;
  const token = val.slice(dot + 1);
  if (safeEqual(token, await userToken(env, u))) return u;
  // TEMPORARY (migration) — remove in the finish step
  if (safeEqual(token, await legacyUserToken(env, u))) return u;
  return null;
}
```

- [ ] **Step 4: Export the new functions**

In the `__testables` object, replace its contents with:

```javascript
export const __testables = {
  hashPassword, verifyPassword, isPassHash, safeEqual, userByEmail,
  tokenFor, hmacToken, userToken, legacyUserToken, identify, effectiveSecret,
  PBKDF2_ITERATIONS,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 12 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Auth: HMAC session tokens, still accepting the old derivation"
```

---

### Task 3: Verify on login, upgrade plaintext transparently

**Files:**
- Modify: `src/_worker.js` (rename `effectivePass` → `effectiveSecret`, rewrite the `/__auth` handler)
- Modify: `test/worker.test.mjs` (append tests)

**Files (revised):**
- Modify: `src/_worker.js` (add `upgradeSecretIfLegacy`, rewrite **both** credential checks)
- Modify: `test/worker.test.mjs` (append tests)

**Interfaces:**
- Consumes: `verifyPassword`, `hashPassword`, `isPassHash` (Task 1); `effectiveSecret` (Task 2)
- Produces:
  - `upgradeSecretIfLegacy(env, u, password) -> Promise<void>` — rewrites a verified plaintext as a hash

**There are TWO credential checks in this file, not one.** Both compare plaintext today and
both break against hashes:

1. `/__auth` — the browser login form.
2. `/__publish/_login/token` — the `augur login` CLI exchanging email+password for a
   publish token. Miss this one and the CLI stops working the moment anyone is migrated.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```javascript
test("a verified legacy plaintext is upgraded to a hash in place", async () => {
  // TEMPORARY (migration) — this test is removed in the finish step.
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": "augur-legacy-2026" }) });
  const env = envWith(kv);
  const u = { email: "a@example.test" };
  await W.upgradeSecretIfLegacy(env, u, "augur-legacy-2026");
  const stored = JSON.parse(await kv.get("users:secrets"))["a@example.test"];
  assert.ok(W.isPassHash(stored), "rewritten as pbkdf2$…");
  assert.equal(await W.verifyPassword("augur-legacy-2026", stored), true);
});

test("upgrade is a no-op when the stored value is already a hash", async () => {
  const h = await W.hashPassword("pw");
  const kv = memKV({ "users:secrets": JSON.stringify({ "a@example.test": h }) });
  const env = envWith(kv);
  await W.upgradeSecretIfLegacy(env, { email: "a@example.test" }, "pw");
  assert.equal(JSON.parse(await kv.get("users:secrets"))["a@example.test"], h, "untouched");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `W.upgradeSecretIfLegacy is not a function`

- [ ] **Step 3: Add the upgrade helper**

In `src/_worker.js`, immediately after `effectiveSecret`, add:

```javascript
// TEMPORARY (migration) — remove in the finish step
// After a successful login against a legacy plaintext secret, rewrite it as a hash so
// the plaintext stops existing. Fire-and-forget: never break a login.
async function upgradeSecretIfLegacy(env, u, password) {
  try {
    const kv = kvFor(env);
    if (!kv || !u) return;
    const raw = await kv.get(USER_SECRETS_KEY);
    const ov = raw ? JSON.parse(raw) : {};
    const stored = ov[u.email];
    if (!stored || isPassHash(stored)) return;
    ov[u.email] = await hashPassword(password);
    await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
  } catch (e) {}
}
```

- [ ] **Step 4: Rewrite the browser login check (`/__auth`)**

In the `/__auth` POST handler, replace this line:

```javascript
        if (u && real && pass.length === real.length && pass === real) {
```

with:

```javascript
        if (u && real && (await verifyPassword(pass, real))) {
```

and, immediately after the existing `if (ctx && ctx.waitUntil) ctx.waitUntil(touchLastSeen(env, u));`
line inside that branch, add:

```javascript
          // TEMPORARY (migration) — remove in the finish step
          if (ctx && ctx.waitUntil) ctx.waitUntil(upgradeSecretIfLegacy(env, u, pass));
```

- [ ] **Step 5: Rewrite the CLI login check (`/__publish/_login/token`)**

In the `spaceId === "_login"` branch, replace:

```javascript
    if (!u || !real || pass.length !== real.length || pass !== real) {
      return jsonResponse({ error: "bad-credentials" }, 403);
    }
```

with:

```javascript
    if (!u || !real || !(await verifyPassword(pass, real))) {
      return jsonResponse({ error: "bad-credentials" }, 403);
    }
    // TEMPORARY (migration) — remove in the finish step
    await upgradeSecretIfLegacy(env, u, pass);
```

Verify both checks are converted:

```bash
grep -c 'pass !== real\|pass === real' src/_worker.js
```

Expected: `0`

- [ ] **Step 6: Export the new function**

In `__testables`, add `upgradeSecretIfLegacy` to the list (keep everything already there).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 14 tests passing

The CLI path has no unit test — exercising `/__publish/_login/token` needs `SPACES` and the
publish-token store, which is disproportionate scaffolding. The Step 5 grep is its guard,
and `augur login` should be run by hand against Delta during the canary.

- [ ] **Step 8: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Auth: verify on login, upgrading legacy plaintext in place"
```

---

### Task 4: Invite token store

**Files:**
- Modify: `src/_worker.js` (add the invite constants and functions)
- Modify: `test/worker.test.mjs` (append tests)

**Interfaces:**
- Consumes: `kvFor`, `toB64` (Task 1)
- Produces:
  - `USER_INVITES_KEY = "users:invites"`
  - `INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000`
  - `mintInvite(env, email, nowMs?) -> Promise<string>` — returns the token; invalidates that email's prior tokens
  - `readInvite(env, token, nowMs?) -> Promise<string|null>` — returns the email, or null if unknown/expired
  - `consumeInvite(env, token, nowMs?) -> Promise<string|null>` — as `readInvite`, then deletes it

Stored shape: `{ "<token>": { "email": "…", "expires": <epoch ms> } }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```javascript
test("mintInvite issues a token that reads back to its email", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t = await W.mintInvite(env, "a@example.test");
  assert.match(t, /^[A-Za-z0-9_-]{20,}$/, "url-safe, high entropy");
  assert.equal(await W.readInvite(env, t), "a@example.test");
});

test("an invite is single-use", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t = await W.mintInvite(env, "a@example.test");
  assert.equal(await W.consumeInvite(env, t), "a@example.test");
  assert.equal(await W.consumeInvite(env, t), null, "second use fails");
  assert.equal(await W.readInvite(env, t), null);
});

test("an invite expires after the TTL", async () => {
  const kv = memKV(); const env = envWith(kv);
  const t0 = 1_000_000_000_000;
  const t = await W.mintInvite(env, "a@example.test", t0);
  assert.equal(await W.readInvite(env, t, t0 + W.INVITE_TTL_MS - 1), "a@example.test");
  assert.equal(await W.readInvite(env, t, t0 + W.INVITE_TTL_MS + 1), null, "expired");
  assert.equal(await W.consumeInvite(env, t, t0 + W.INVITE_TTL_MS + 1), null);
});

test("minting a new invite invalidates that user's outstanding ones", async () => {
  const kv = memKV(); const env = envWith(kv);
  const first = await W.mintInvite(env, "a@example.test");
  const second = await W.mintInvite(env, "a@example.test");
  assert.equal(await W.readInvite(env, first), null, "old link is dead");
  assert.equal(await W.readInvite(env, second), "a@example.test");
});

test("minting for one user leaves another user's invite alone", async () => {
  const kv = memKV(); const env = envWith(kv);
  const a = await W.mintInvite(env, "a@example.test");
  await W.mintInvite(env, "b@example.test");
  assert.equal(await W.readInvite(env, a), "a@example.test");
});

test("unknown tokens read as null", async () => {
  const kv = memKV(); const env = envWith(kv);
  assert.equal(await W.readInvite(env, "nope"), null);
  assert.equal(await W.readInvite(env, ""), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `W.mintInvite is not a function`

- [ ] **Step 3: Implement the invite store**

In `src/_worker.js`, immediately after the `USER_SECRETS_KEY` / `LASTSEEN_PREFIX` constants, add:

```javascript
const USER_INVITES_KEY = "users:invites";   // KV {token: {email, expires}}
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // links get pasted into chat — expire them
```

Then, after `upgradeSecretIfLegacy`, add:

```javascript
// ---- Invite / reset tokens ---------------------------------------------------
// One mechanism serves account setup and password recovery — they differ only in
// wording. A token is single-use (consumed when a password is set), expires on its
// own, and minting a new one for a user drops any outstanding token for that user.

async function readInvites(kv) {
  const raw = kv ? await kv.get(USER_INVITES_KEY) : null;
  const map = raw ? JSON.parse(raw) : {};
  return map && typeof map === "object" ? map : {};
}

// Drop expired entries on every write — the map stays small without a sweeper.
function pruneInvites(map, nowMs) {
  const out = {};
  for (const [tok, rec] of Object.entries(map)) {
    if (rec && typeof rec.expires === "number" && rec.expires > nowMs) out[tok] = rec;
  }
  return out;
}

async function mintInvite(env, email, nowMs = Date.now()) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const token = toB64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const map = pruneInvites(await readInvites(kv), nowMs);
  // Issuing invalidates this user's outstanding links, so there is never more than one.
  for (const [tok, rec] of Object.entries(map)) if (rec.email === email) delete map[tok];
  map[token] = { email, expires: nowMs + INVITE_TTL_MS };
  await kv.put(USER_INVITES_KEY, JSON.stringify(map));
  return token;
}

async function readInvite(env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const kv = kvFor(env);
  if (!kv) return null;
  const rec = (await readInvites(kv))[token];
  if (!rec || typeof rec.expires !== "number" || rec.expires <= nowMs) return null;
  return rec.email;
}

async function consumeInvite(env, token, nowMs = Date.now()) {
  const email = await readInvite(env, token, nowMs);
  if (!email) return null;
  const kv = kvFor(env);
  const map = pruneInvites(await readInvites(kv), nowMs);
  delete map[token];
  await kv.put(USER_INVITES_KEY, JSON.stringify(map));
  return email;
}
```

- [ ] **Step 4: Export the invite functions**

In `__testables`, add `mintInvite, readInvite, consumeInvite, INVITE_TTL_MS`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 20 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Auth: single-use, expiring invite tokens"
```

---

### Task 5: Redemption page and endpoint

**Files:**
- Modify: `src/_worker.js` (add `invitePage`, `inviteGet`, `invitePost`, route them)
- Modify: `test/worker.test.mjs` (append tests)

**Interfaces:**
- Consumes: `consumeInvite`, `readInvite` (Task 4); `hashPassword` (Task 1); `userToken` (Task 2)
- Produces:
  - `setUserSecret(env, email, hash) -> Promise<void>`
  - `invitePost(request, url, env) -> Promise<Response>` — 303 + session cookie on success
  - Route: `GET /__invite?t=<token>` renders the set-password form; `POST /__invite` redeems

Minimum password length is **10** characters.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```javascript
const ROSTER = [{ email: "a@example.test", name: "A" }];

function invitePostRequest(token, password) {
  const body = new URLSearchParams({ token, password });
  return new Request("https://example.test/__invite", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

test("redeeming an invite stores a hash and signs the user in", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  const res = await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 303);
  const cookie = res.headers.get("Set-Cookie") || "";
  assert.match(cookie, /^gv_user=a%40example\.test\.|^gv_user=a@example\.test\./, "session cookie issued");
  const stored = JSON.parse(await kv.get("users:secrets"))["a@example.test"];
  assert.ok(W.isPassHash(stored), "stored as a hash, never plaintext");
  assert.equal(await W.verifyPassword("a good long password", stored), true);
});

test("an invite cannot be redeemed twice", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  const again = await W.invitePost(invitePostRequest(t, "another long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(again.status, 400);
  assert.equal(await W.verifyPassword("a good long password", JSON.parse(await kv.get("users:secrets"))["a@example.test"]), true, "first password still stands");
});

test("a short password is rejected and nothing is stored", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "a@example.test");
  const res = await W.invitePost(invitePostRequest(t, "short"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 400);
  assert.equal(await kv.get("users:secrets"), null, "no secret written");
  assert.equal(await W.readInvite(env, t), "a@example.test", "token survives a failed attempt");
});

test("a token for an unknown roster entry is refused", async () => {
  const kv = memKV(); const env = envWith(kv, { SESSION_SECRET: "s3cret" });
  const t = await W.mintInvite(env, "ghost@example.test");
  const res = await W.invitePost(invitePostRequest(t, "a good long password"), new URL("https://example.test/__invite"), env, ROSTER);
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `W.invitePost is not a function`

- [ ] **Step 3: Implement the redemption flow**

In `src/_worker.js`, after the invite-token functions, add:

```javascript
const MIN_PASSWORD_LENGTH = 10;

async function setUserSecret(env, email, hash) {
  const kv = kvFor(env);
  if (!kv) throw new Error("no-kv-binding");
  const raw = await kv.get(USER_SECRETS_KEY);
  const ov = raw ? JSON.parse(raw) : {};
  ov[email] = hash;
  await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));
}

// GET /__invite?t=… — the set-password form. Deliberately says nothing about whether
// the token is valid beyond "this link is no longer valid": no user enumeration.
function invitePage(token, error) {
  const t = escapeHtml(token || "");
  const msg = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Set your password — Augur</title>
<style>
  body { font: 16px/1.5 Inter, system-ui, sans-serif; background: #fafafa; color: #18181b;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08);
         width: min(24rem, 90vw); }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p  { margin: 0 0 1.25rem; color: #52525b; font-size: .9rem; }
  label { display: block; font-size: .85rem; margin-bottom: .35rem; }
  input { width: 100%; padding: .6rem .7rem; border: 1px solid #d4d4d8; border-radius: 8px;
          font: inherit; box-sizing: border-box; }
  button { margin-top: 1rem; width: 100%; padding: .6rem; border: 0; border-radius: 8px;
           background: #4f46e5; color: #fff; font: inherit; cursor: pointer; }
  .err { color: #b91c1c; }
</style></head>
<body>
  <form method="POST" action="/__invite">
    <h1>Set your password</h1>
    <p>Choose a password of at least ${MIN_PASSWORD_LENGTH} characters. Nobody else will know it.</p>
    ${msg}
    <input type="hidden" name="token" value="${t}" />
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password"
           minlength="${MIN_PASSWORD_LENGTH}" required autofocus />
    <button type="submit">Set password</button>
  </form>
</body></html>`;
}

async function inviteGet(url, env) {
  const token = url.searchParams.get("t") || "";
  const email = await readInvite(env, token);
  if (!email) return htmlResponse(invitePage("", "This link is no longer valid. Ask for a new one."), 400);
  return htmlResponse(invitePage(token, ""), 200);
}

async function invitePost(request, url, env, users = USERS) {
  const form = await request.formData();
  const token = (form.get("token") || "").toString();
  const password = (form.get("password") || "").toString();

  // Validate the password BEFORE consuming the token, so a typo doesn't burn the link.
  const email = await readInvite(env, token);
  if (!email) return htmlResponse(invitePage("", "This link is no longer valid. Ask for a new one."), 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return htmlResponse(invitePage(token, `Use at least ${MIN_PASSWORD_LENGTH} characters.`), 400);
  }
  const u = userByEmail(email, users);
  if (!u) return htmlResponse(invitePage("", "This link is no longer valid. Ask for a new one."), 400);

  const consumed = await consumeInvite(env, token);
  if (!consumed) return htmlResponse(invitePage("", "This link is no longer valid. Ask for a new one."), 400);

  await setUserSecret(env, email, await hashPassword(password));
  const token2 = await userToken(env, u);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${USER_COOKIE}=${u.email}.${token2}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
      "Cache-Control": "no-store",
    },
  });
}
```

If `escapeHtml` does not already exist in `src/_worker.js`, add it beside `clamp`:

```javascript
const escapeHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
```

- [ ] **Step 4: Route the endpoint**

In the main `fetch` handler, immediately **before** the `if (request.method === "POST" && url.pathname === "/__auth")` block, add:

```javascript
    // Invite redemption is reachable WITHOUT a session — that is the whole point.
    if (url.pathname === "/__invite") {
      if (request.method === "GET") return inviteGet(url, env);
      if (request.method === "POST") return invitePost(request, url, env);
      return new Response("Method Not Allowed", { status: 405 });
    }
```

Then make `/__invite` reachable when signed out — it is redeemed by people who by
definition have no session. In `isPublicPath`, immediately after the `/_build.json` door,
add:

```javascript
  // Invite redemption — reached by users who have no session yet (that is the point).
  // The token in the query string is the credential; the path itself reveals nothing.
  if (pathname === "/__invite") return true;
```

Verify the door exists:

```bash
grep -n '"/__invite"' src/_worker.js
```

Expected: two lines — the `isPublicPath` door and the route in the `fetch` handler.

- [ ] **Step 5: Export the handlers**

In `__testables`, add `invitePost, inviteGet, setUserSecret, MIN_PASSWORD_LENGTH`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 24 tests passing

- [ ] **Step 7: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Auth: invite redemption page and endpoint"
```

---

### Task 6: Admin API — state, not secrets

**Files:**
- Modify: `src/_worker.js` (rewrite `adminUsersApi`)
- Modify: `test/worker.test.mjs` (append tests)

**Interfaces:**
- Consumes: `mintInvite` (Task 4); `effectiveSecret` (Task 3); `isPassHash` (Task 1)
- Produces: `adminUsersApi(request, url, env, me, users?) -> Promise<Response>`
  - `GET` → `{ users: [{ email, name, role, initials, color, avatar, state, lastSeen }] }` where `state` is `"pending" | "accepted"`. **Never returns a secret.**
  - `POST {op:"reset", email}` → `{ ok: true, email, url }` where `url` is the absolute invite link.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```javascript
const ADMIN = { email: "admin@example.test", name: "Admin", role: "admin" };
const PLAIN = { email: "u@example.test", name: "U" };

function adminGet() { return new Request("https://example.test/__admin/users"); }
function adminPost(body) {
  return new Request("https://example.test/__admin/users", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

test("admin GET never returns a password or hash", async () => {
  const h = await W.hashPassword("a good long password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "u@example.test": h }) });
  const env = envWith(kv);
  const res = await W.adminUsersApi(adminGet(), new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("pbkdf2$"), "no hash in the response");
  assert.ok(!/"pass"/.test(serialized), "no pass field at all");
  const u = body.users.find((x) => x.email === "u@example.test");
  assert.equal(u.state, "accepted");
  assert.equal(body.users.find((x) => x.email === "admin@example.test").state, "pending");
});

test("admin GET is forbidden to non-admins", async () => {
  const env = envWith(memKV());
  const res = await W.adminUsersApi(adminGet(), new URL("https://example.test/__admin/users"), env, PLAIN, [ADMIN, PLAIN]);
  assert.equal(res.status, 403);
});

test("reset clears the secret and returns a fresh invite link", async () => {
  const h = await W.hashPassword("a good long password");
  const kv = memKV({ "users:secrets": JSON.stringify({ "u@example.test": h }) });
  const env = envWith(kv);
  const res = await W.adminUsersApi(adminPost({ op: "reset", email: "u@example.test" }),
    new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.url, /^https:\/\/example\.test\/__invite\?t=/);
  const secrets = JSON.parse(await kv.get("users:secrets"));
  assert.ok(!secrets["u@example.test"], "old secret cleared — the password dies now");
  const token = new URL(body.url).searchParams.get("t");
  assert.equal(await W.readInvite(env, token), "u@example.test");
});

test("the password-setting endpoint is gone", async () => {
  const env = envWith(memKV());
  const res = await W.adminUsersApi(adminPost({ email: "u@example.test", pass: "hunter2hunter2" }),
    new URL("https://example.test/__admin/users"), env, ADMIN, [ADMIN, PLAIN]);
  assert.equal(res.status, 400, "no op:reset → rejected; admins cannot set passwords");
  assert.equal(await env.COMMENTS.get("users:secrets"), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — assertion errors on `state` / `body.url`, or `adminUsersApi` arity

- [ ] **Step 3: Rewrite the admin API**

Replace the entire `adminUsersApi` function in `src/_worker.js` with:

```javascript
// Admin surface: manage PEOPLE, not credentials. There is deliberately no path here
// that sets, reads or recovers a password — reset re-issues an invite instead.
async function adminUsersApi(request, url, env, me, users = USERS) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const kv = kvFor(env);

  if (request.method === "GET") {
    const out = [];
    for (const u of users) {
      let lastSeen = null;
      try { lastSeen = kv ? await kv.get(LASTSEEN_PREFIX + u.email) : null; } catch (e) {}
      const secret = await effectiveSecret(env, u);
      out.push({
        email: u.email, name: u.name, role: u.role || "user",
        initials: u.initials || "", color: u.color || "#4f46e5",
        avatar: avatarUrl(u),
        state: secret ? "accepted" : "pending",
        lastSeen,
      });
    }
    return jsonResponse({ users: out });
  }

  if (request.method === "POST") {
    let op;
    try { op = await request.json(); } catch (e) { return jsonResponse({ error: "bad-json" }, 400); }
    if (!op || op.op !== "reset") return jsonResponse({ error: "unknown-op" }, 400);
    const u = userByEmail(op.email, users);
    if (!u) return jsonResponse({ error: "unknown-user" }, 400);
    if (!kv) return jsonResponse({ error: "no-kv-binding" }, 500);

    // Clearing the secret and minting the link are ONE action: there is never a state
    // where a known password is still live alongside a pending invite.
    const raw = await kv.get(USER_SECRETS_KEY);
    const ov = raw ? JSON.parse(raw) : {};
    delete ov[u.email];
    await kv.put(USER_SECRETS_KEY, JSON.stringify(ov));

    const token = await mintInvite(env, u.email);
    return jsonResponse({ ok: true, email: u.email, url: `${url.origin}/__invite?t=${encodeURIComponent(token)}` });
  }

  return jsonResponse({ error: "method-not-allowed" }, 405);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 28 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Admin: manage people, not passwords"
```

---

### Task 7: Admin UI — state pill and reset-with-link

**Files:**
- Modify: `build.js` (`ADMIN_JS` around line 3884, and the admin page CSS)

**Interfaces:**
- Consumes: the Task 6 API shape (`state`, no `pass`; `POST {op:"reset"}` → `{url}`)
- Produces: no JS interface — this is the rendered admin page

There is no unit test for this string (it is browser JS injected at build time); it is
covered by the Task 8 smoke test and by manual verification on Delta.

- [ ] **Step 1: Replace the row renderer and wiring**

In `build.js`, replace the whole `const ADMIN_JS = \`…\`;` block with:

```javascript
// Admin page behaviour: load every user from /__admin/users (admin-only — 403s for
// anyone else, though the worker also gates the /admin/ route) and render one row per
// person: lifecycle state, last connection, and a Reset button. Reset kills that
// user's password immediately and returns a single-use invite link to copy — the
// admin never sees or sets a password.
const ADMIN_JS = `(function(){
  var host = document.querySelector('[data-admin-users]');
  if(!host) return;
  function esc(s){ return (s||'').replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function ago(iso){
    if(!iso) return 'never';
    var t = Date.parse(iso); if(isNaN(t)) return 'never';
    var s = (Date.now() - t) / 1000;
    if(s < 90) return 'just now';
    if(s < 3600) return Math.floor(s/60) + ' min ago';
    if(s < 86400) return Math.floor(s/3600) + ' h ago';
    var d = Math.floor(s/86400);
    if(d === 1) return 'yesterday';
    if(d < 30) return d + ' days ago';
    return new Date(t).toLocaleDateString();
  }
  function row(u){
    var ini = (u.initials || (u.name||'?').slice(0,2)).toUpperCase();
    var badge = u.role === 'admin' ? ' <span class="au__badge">admin</span>' : '';
    var av = u.avatar
      ? '<span class="au__av" style="background:url(&quot;'+esc(u.avatar)+'&quot;) center/cover, '+esc(u.color||'#4f46e5')+'"></span>'
      : '<span class="au__av" style="background:'+esc(u.color||'#4f46e5')+'">'+esc(ini)+'</span>';
    var state = u.state === 'accepted'
      ? '<span class="au__state au__state--ok">active</span>'
      : '<span class="au__state au__state--pending">pending invite</span>';
    return '<div class="au" data-email="'+esc(u.email)+'">'
      + av
      + '<span class="au__id"><span class="au__name">'+esc(u.name)+badge+'</span><span class="au__email">'+esc(u.email)+'</span></span>'
      + state
      + '<span class="au__seen'+(u.lastSeen ? '' : ' au__seen--never')+'" title="'+(u.lastSeen ? 'Last connection: '+esc(u.lastSeen) : 'Never signed in')+'">'+esc(ago(u.lastSeen))+'</span>'
      + '<span class="au__act"><button type="button" class="au__reset">Reset</button>'
      + '<input type="text" class="au__link" readonly hidden aria-label="Invite link for '+esc(u.email)+'" />'
      + '<button type="button" class="au__copy" hidden>Copy</button>'
      + '<span class="au__msg" aria-live="polite"></span></span>'
      + '</div>';
  }
  function wire(){
    var rows = host.querySelectorAll('.au');
    for(var i=0;i<rows.length;i++){ (function(el){
      var btn = el.querySelector('.au__reset'), link = el.querySelector('.au__link'),
          copy = el.querySelector('.au__copy'), msg = el.querySelector('.au__msg');
      btn.addEventListener('click', function(){
        var who = el.getAttribute('data-email');
        if(!window.confirm('Reset ' + who + '?\\n\\nTheir password stops working immediately. Send them the link that appears.')) return;
        btn.disabled = true; msg.textContent = '…';
        fetch('/__admin/users',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ op:'reset', email: who }) })
          .then(function(r){ return r.json(); })
          .then(function(d){
            btn.disabled = false;
            if(d && d.ok && d.url){
              link.value = d.url; link.hidden = false; copy.hidden = false;
              link.focus(); link.select();
              msg.textContent = 'send this link';
            } else { msg.textContent = (d && d.error) || 'error'; }
          })
          .catch(function(){ btn.disabled = false; msg.textContent = 'error'; });
      });
      copy.addEventListener('click', function(){
        link.select();
        try { document.execCommand('copy'); msg.textContent = 'copied ✓'; }
        catch(e){ msg.textContent = 'copy manually'; }
      });
    })(rows[i]); }
  }
  fetch('/__admin/users',{headers:{'Accept':'application/json'}}).then(function(r){
    if(r.status === 403){ host.innerHTML = '<p class="empty">Admins only.</p>'; return null; }
    return r.json();
  }).then(function(d){
    if(!d) return;
    if(!d.users){ host.innerHTML = '<p class="empty">Could not load users.</p>'; return; }
    d.users.sort(function(a,b){
      var ta = a.lastSeen ? Date.parse(a.lastSeen) : 0, tb = b.lastSeen ? Date.parse(b.lastSeen) : 0;
      return (tb - ta) || (a.name || '').localeCompare(b.name || '');
    });
    host.innerHTML = d.users.map(row).join('');
    wire();
  }).catch(function(){ host.innerHTML = '<p class="empty">Could not load users.</p>'; });
})();
`;
```

- [ ] **Step 2: Add the new styles**

Find the admin page CSS in `build.js` (search for `.au__pw`) and replace the `.au__pw`
rule with:

```css
    .au__state { font-size: .75rem; padding: .15rem .5rem; border-radius: 999px; white-space: nowrap; }
    .au__state--ok { background: #dcfce7; color: #166534; }
    .au__state--pending { background: #fef3c7; color: #92400e; }
    .au__act { display: flex; gap: .4rem; align-items: center; }
    .au__link { font: 12px/1.3 ui-monospace, monospace; width: 16rem; padding: .3rem .4rem;
                border: 1px solid #d4d4d8; border-radius: 6px; }
```

- [ ] **Step 3: Build and verify no stale references remain**

Run: `npm run build && grep -c "au__pw\|au__save\|au__input" dist/*.html dist/**/*.js 2>/dev/null | grep -v ':0' || echo "clean"`
Expected: `clean` — no references to the removed password-editing UI

- [ ] **Step 4: Commit**

```bash
git add build.js
git commit -m "Admin UI: lifecycle state and reset-with-link, no password field"
```

---

### Task 8: Offline smoke test

**Files:**
- Create: `scripts/smoke-invite.mjs`
- Modify: `package.json` (add `smoke` script)

**Interfaces:**
- Consumes: everything above, via direct import of `__testables`
- Produces: `npm run smoke` — exits non-zero on failure

This exercises the whole lifecycle in one pass against an in-memory KV, which is what the
unit tests do individually. Its value is that it fails loudly if the *sequence* breaks.

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-invite.mjs`:

```javascript
#!/usr/bin/env node
/*
 * smoke-invite.mjs — the whole invite lifecycle in one pass, against an in-memory KV.
 * The unit tests check each piece; this checks the SEQUENCE, which is what an operator
 * actually walks through: pending → invite → accepted → login → reset → locked out.
 *
 * Usage: npm run smoke
 */
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const kv = memKV();
const env = { COMMENTS: kv, SESSION_SECRET: "smoke-secret" };
const ADMIN = { email: "admin@smoke.test", name: "Admin", role: "admin" };
const USER = { email: "user@smoke.test", name: "User" };
const ROSTER = [ADMIN, USER];
const ORIGIN = "https://smoke.test";

const post = (body) => new Request(`${ORIGIN}/__admin/users`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const redeem = (token, password) => new Request(`${ORIGIN}/__invite`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token, password }).toString(),
});

let step = 0;
const ok = (m) => console.log(`  ${++step}. ${m}`);

console.log("invite lifecycle:");

// 1. A roster entry with no secret is pending.
let res = await W.adminUsersApi(new Request(`${ORIGIN}/__admin/users`), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
let body = await res.json();
assert.equal(body.users.find((u) => u.email === USER.email).state, "pending");
ok("new roster entry reads as pending");

// 2. Reset mints a link.
res = await W.adminUsersApi(post({ op: "reset", email: USER.email }), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
body = await res.json();
assert.equal(body.ok, true);
const token = new URL(body.url).searchParams.get("t");
ok("reset returns a single-use invite link");

// 3. Redeeming sets a hash and signs in.
res = await W.invitePost(redeem(token, "a properly long password"), new URL(`${ORIGIN}/__invite`), env, ROSTER);
assert.equal(res.status, 303);
assert.match(res.headers.get("Set-Cookie") || "", /gv_user=/);
const stored = JSON.parse(await kv.get("users:secrets"))[USER.email];
assert.ok(W.isPassHash(stored), "stored as a hash");
ok("redemption stores a hash and issues a session");

// 4. The link is dead.
res = await W.invitePost(redeem(token, "another long password"), new URL(`${ORIGIN}/__invite`), env, ROSTER);
assert.equal(res.status, 400);
ok("the link cannot be reused");

// 5. The user now reads as accepted.
res = await W.adminUsersApi(new Request(`${ORIGIN}/__admin/users`), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
body = await res.json();
assert.equal(body.users.find((u) => u.email === USER.email).state, "accepted");
assert.ok(!JSON.stringify(body).includes("pbkdf2$"), "no secret leaks through the admin API");
ok("state flips to accepted, no secret in the API response");

// 6. The chosen password verifies; the session cookie identifies.
assert.equal(await W.verifyPassword("a properly long password", stored), true);
const sessionToken = await W.userToken(env, USER);
const identified = await W.identify(
  new Request(ORIGIN, { headers: { Cookie: `gv_user=${USER.email}.${sessionToken}` } }), env, ROSTER);
assert.equal(identified && identified.email, USER.email);
ok("password verifies and the session identifies the user");

// 7. Reset again: password dies immediately, session stops verifying.
await W.adminUsersApi(post({ op: "reset", email: USER.email }), new URL(`${ORIGIN}/__admin/users`), env, ADMIN, ROSTER);
assert.equal(await W.identify(
  new Request(ORIGIN, { headers: { Cookie: `gv_user=${USER.email}.${sessionToken}` } }), env, ROSTER), null);
ok("reset revokes the password AND the live session");

console.log("\nall good.");
```

- [ ] **Step 2: Add the script**

In `package.json`, after the `test` line, add:

```json
    "smoke": "node scripts/smoke-invite.mjs",
```

- [ ] **Step 3: Run it**

Run: `npm run smoke`
Expected: seven numbered lines then `all good.`, exit code 0

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-invite.mjs package.json
git commit -m "Test: smoke the whole invite lifecycle in sequence"
```

---

### Task 9: Document the temporary paths and their removal

**Files:**
- Modify: `CLAUDE.md`
- Modify: `changelog.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing — documentation only

- [ ] **Step 1: Add the auth section to CLAUDE.md**

Append to `CLAUDE.md`:

```markdown
## Authentication

Invite-only. `identity.json` is a roster with **no credentials** — it carries email, name,
initials, colour and role only. Passwords live in KV as PBKDF2 hashes under
`users:secrets`; invite tokens under `users:invites`.

- Admins **cannot set or read passwords.** Reset clears a user's hash and mints a
  single-use invite link, in one action — there is never a live password alongside a
  pending invite.
- Sessions are HMACs keyed on the runtime `SESSION_SECRET`, bound to the user's effective
  secret, so changing or clearing a password invalidates that user's cookies for free.
- Adding or removing a person is still a commit to `identity.json` — the roster is
  injected at build time.

**Two migration paths are temporary.** Both are marked
`// TEMPORARY (migration) — remove in the finish step`:

1. `verifyPassword` accepts a legacy plaintext value and `upgradeSecretIfLegacy` rewrites
   it as a hash on next login.
2. `identify` accepts the pre-HMAC session derivation via `legacyUserToken`.

They exist only so migration can proceed user-by-user without a mass lockout. **Leaving
them in place preserves the ability to authenticate against a plaintext value, which is
the defect this design removes.** Delete both — and their tests — once every user has
redeemed an invite. See `docs/superpowers/specs/2026-08-08-invite-only-auth-design.md`.
```

- [ ] **Step 2: Add a changelog entry**

Prepend to the top entry list in `changelog.md`:

```markdown
- **Invite-only auth.** Passwords are PBKDF2 hashes, sessions are HMACs, and the admin
  panel issues single-use invite links instead of setting passwords. Operators no longer
  know anyone's password. Two temporary compatibility paths remain until every user has
  migrated — see CLAUDE.md.
```

- [ ] **Step 3: Verify the markers are all findable**

Run: `grep -rn "TEMPORARY (migration)" src/ test/ | wc -l`
Expected: `6` — two in `verifyPassword`/`upgradeSecretIfLegacy`, two in the session path, two in tests

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md changelog.md
git commit -m "Docs: how auth works, and what has to be deleted after migration"
```

---

## After the plan

**Do not merge to `main` yet.** Deploy this branch to the Delta instance first
(`augur-deploy-delta`, one user), set `SESSION_SECRET` there, and walk the full lifecycle
manually — including a deliberate self-reset, which is where a sole-admin lockout is cheap
to discover. Only then set `SESSION_SECRET` on the Go Vocal Pages project and merge.

The per-user migration and the finish step are in the private runbook:
`augur-deploy/docs/2026-08-08-auth-cutover-runbook.md`.
