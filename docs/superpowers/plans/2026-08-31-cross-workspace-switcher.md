# Cross-workspace switcher + magic-link sign-in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Passwordless (magic-link) central sign-in at `augur.works` that reaches every hosted workspace, and a cross-workspace switcher — so `roberto` can sign in once and switch between `demo` (`flint-birch-702`) and `delta` (`stoic-canyon-873`).

**Architecture:** The control-plane spine (accounts v7, `/signin`/`/workspaces`/`/enter`, hand-offs, `mintWorkspaceKey`) is BUILT. This plan (a) makes central sign-in passwordless, (b) builds the ENGINE half — `/__enter` redeems a hand-off and mints a per-workspace session after checking the workspace's own roster — and (c) adds the in-chrome switcher. The control plane proves WHO (magic link → account session); the workspace decides WHAT (roster check → `__Host-augur_user` session via `SESSION_KEYS`/`rotateSessionKey`). Everything is flag-gated (`SIGNIN_OPEN`, `SESSION_KEYS`) so existing password login is untouched until enabled.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite) + D1 (account store), `node:test`, `wrangler dev --local`. Repos: `augur/` (engine), `augur-control-plane/`.

## Global Constraints

- **Flag-gated, backwards-compatible.** With `SIGNIN_OPEN` unset and `SESSION_KEYS` unset, EVERY path is byte-for-byte prior behavior. Password sign-in on every workspace keeps working. Pin this with regression tests.
- **The control plane proves WHO, never WHAT.** `/__enter` MUST re-check the workspace's own roster before minting a session; a hand-off is never sufficient. A non-member gets a 404 byte-identical to a stranger's — never a distinct error (no membership oracle).
- **No membership oracle anywhere.** `/signin` answers identically for known/unknown addresses; `/enter` mints a hand-off without a membership check; the workspace 404s inside.
- **`__Host-` cookie attributes are load-bearing** — never add `Domain`, never drop `Secure`, never narrow `Path`, for `__Host-augur_session` (control plane) or `__Host-augur_user` (workspace).
- **The account key is per-workspace and read from the key, never the payload** — a workspace cannot name another. It authorizes only `/__account/{handoff,index,workspaces}`.
- **Stage only the paths you changed — never `git add -A`.** Both repos are shared checkouts. Commit path-by-path.
- **Cross-repo constants written twice** (e.g. `WORKSPACE_ENTER_PATH`, any new `CONTROL_VERBS`/`TENANT_RPC` entry) must match, and each repo's suite asserts the other's copy.
- **No instance/personal words** in engine-repo files (docs/tests) — the word scan (`\brob\b`, `delta[ ._-]?studio`, …) gates the deploy. Use `operator@example.test`, `acme`, `<ws>` in engine tests/docs; real values (`roberto@…`, `stoic-canyon-873`) live only in the control-plane repo and the git-ignored ledger.
- Commit messages end with the two trailers (Co-Authored-By + Claude-Session).

## File Structure

**Control plane (`augur-control-plane/`)**
- `src/accounts.js` — `redeemProofPasswordless`, `openSessionFor` (extract from `signIn`), `mintWorkspaceKey` (exists). 
- `src/signup-route.js` — `signinOpen` export.
- `src/signin-route.js` — email-only `/signin`, new `GET /signin/verify`, `GET /enter`; gate on `signinOpen`.
- `src/account-route.js` — `POST /__account/workspaces` (bearer-scoped list).
- `src/provisioning.js` — mint + deliver `accountKey`; `ensureWorkspaceKey`.
- `src/email.js` / mail — `signin-link` template.
- `src/index.js` — route the new endpoints.
- `wrangler.toml` — doc the `SIGNIN_OPEN` var.
- tests + a script `scripts/ensure-account-key.mjs` for backfill.

**Engine (`augur/`)**
- `src/tenant-do.js` — store `accountKey` in `meta`; `account-key` control verb; provision accepts it.
- `src/_worker.js` — `GET /__enter`, `GET /__me/workspaces`, membership-notify on roster write, `ACCOUNT_ORIGIN` config, `WORKSPACE_ENTER_PATH` constant.
- `build.js` + chrome — the workspace switcher dropdown (Phase 2).
- `CLAUDE.md` — the sign-in straddle, the flags.
- tests + rehearsal clause.

---

# PHASE 1 — THE SPINE

## Task 1: `signinOpen` flag + passwordless account primitives (CP)

**Files:** `src/signup-route.js`, `src/accounts.js`; Test: `test/accounts.test.mjs`, `test/signup-route.test.mjs` (or a new `test/signin-passwordless.test.mjs`)

**Interfaces produced:**
- `signinOpen(env) → boolean` (`SIGNIN_OPEN === "true"`).
- `redeemProofPasswordless(env, token, now) → {email, sessionBinding}` (throws `bad-proof` on unknown/expired/CAS-miss).
- `openSessionFor(env, email, sessionBinding, now) → token` (the session-row open extracted from `signIn`).

- [ ] **Step 1: Write failing tests.** For `redeemProofPasswordless`: seed a `credential_proofs` row (via `requestCredentialProof` with an injected mail stub), redeem it, assert an `accounts` row exists with `credential IS NULL`, `verified_at` set, and a `{email, sessionBinding}` return; a second redemption of the same token throws `bad-proof` (single-use); an unknown token throws. For `signinOpen`: `env.SIGNIN_OPEN==="true"` → true, unset/other → false; assert it is INDEPENDENT of `SIGNUP_OPEN`. For `openSessionFor`: opening a session then `readSession` returns the email.

```js
test("redeemProofPasswordless creates a credential-NULL account and is single-use", async () => {
  const env = await freshAccountStore();               // adapt to the test harness in accounts.test.mjs
  const mail = stubMail();
  const token = await requestProofCapture(env, "a@example.test", mail); // returns the raw token the link carries
  const r = await redeemProofPasswordless(env, token, Date.now());
  assert.equal(r.email, "a@example.test");
  const row = await getAccount(env, "a@example.test");
  assert.equal(row.credential, null);
  assert.ok(row.verified_at);
  await assert.rejects(() => redeemProofPasswordless(env, token, Date.now()), /bad-proof/);
});
```

- [ ] **Step 2: Run → RED.** `cd ~/Documents/augur-workspace/augur-control-plane && node --test test/<file>.mjs`
- [ ] **Step 3: Implement.**
  - `signup-route.js`: `export const signinOpen = (env) => !!env && env.SIGNIN_OPEN === "true";` (beside `signupOpen`, line 26). Update the file header note: sign-in decouples from signup because magic-link has no password to guess.
  - `accounts.js`: `redeemProofPasswordless` — copy `redeemCredentialProof` (`:689`) but: no `password` param, drop the `MIN_PASSWORD_LENGTH` guard, and in the INSERT set `credential` to `NULL` instead of the hash (the `SELECT p.email, NULL, ?2(now), 0, ?3(incarnation)…`; `ON CONFLICT DO UPDATE SET credential = NULL, epoch = accounts.epoch + 1, updated_at = …` with the SAME epoch-CAS `WHERE`). Keep the `RETURNING email, incarnation, epoch` and the sibling-proof `DELETE`. Return `{email, sessionBinding: incarnation:epoch}`.
  - `accounts.js`: `openSessionFor(env, email, sessionBinding, now)` — extract the session INSERT from `signIn` (`:1229-1240`): `const token = mintToken(); INSERT INTO sessions (token_hash, email, session_binding, created_at, expires_at) VALUES (sha256Hex(token), email, sessionBinding, now, now+SESSION_TTL_MS); return token;`. Refactor `signIn` to call it (no behavior change — pin with an existing `signIn` test).
- [ ] **Step 4: Run → GREEN**, then `npm test` (full CP suite green). 
- [ ] **Step 5: Commit** `src/signup-route.js src/accounts.js test/<files>`.

## Task 2: The magic-link email template (CP)

**Files:** `src/email.js` (or the mail template module), Test: `test/email.test.mjs` (or mail test)

**Interfaces produced:** a `signin-link` template rendering text + HTML with a `{url}` var, wired so `requestCredentialProof`'s `mail` can send it. Confirm how `requestCredentialProof` currently names its template and mirror it.

- [ ] **Step 1:** Read `requestCredentialProof` (`accounts.js:538`) to see what template/vars it hands `mail`. If it already sends a generic proof mail, this task adds/《adjusts》the `signin-link` copy: subject "Your sign-in link", body with the verify URL, text + HTML, no other-product words.
- [ ] **Step 2:** Failing test: render the template with a sample URL, assert the URL appears in both parts and nothing throws; assert no password language.
- [ ] **Step 3:** Implement the template beside the existing ones (`signup-verify`/`credential-reset` pattern — read `src/mail`/`email.js`).
- [ ] **Step 4:** Run → GREEN; `npm test`.
- [ ] **Step 5:** Commit.

## Task 3: Passwordless `/signin` + `/signin/verify` routes (CP)

**Files:** `src/signin-route.js`, `src/index.js`; Test: `test/signin-route.test.mjs`

**Interfaces consumed:** `signinOpen`, `requestCredentialProof`, `redeemProofPasswordless`, `openSessionFor`, `mintHandoff`, `workspaceEnterUrl`, `SESSION_COOKIE`.
**Produced:** `GET /signin` (email-only form), `POST /signin {email,next}` (mails link, no session), `GET /signin/verify?token&next` (redeem→session→303), all gated on `signinOpen`.

- [ ] **Step 1: Failing tests** (adapt the existing `signin-route.test.mjs` harness):
  - With `SIGNIN_OPEN` unset, every route returns `null` (router → 404). With it set: `GET /signin` renders a form with NO password field.
  - `POST /signin {email}` → 200 "check your email", mail stub was called with a link containing a token; NO `Set-Cookie`; same response for an address with and without an account.
  - `GET /signin/verify?token=<valid>` → 303, `Set-Cookie: __Host-augur_session=…`, location `/workspaces`. With `&next=acme` (valid) → 303 to the workspace enter URL with a `handoff`. A second use of the token → the redeem throws → a friendly "link expired" 400/again-page, no session.
  - Regression: `signupOpen`-gated signup routes are unaffected by `SIGNIN_OPEN`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**
  - Replace `signinForm` with an email-only form (drop the password `<input>`). 
  - `signinPage`/`signinSubmit`/`workspacesPage`/`enterWorkspace`/`signout`: change the gate from `signupOpen(env)` to `signinOpen(env)` (import it).
  - `signinSubmit`: keep the rate-limit; then `requestCredentialProof(env, email, {mail: env.mail-or-injected, waitUntil})` and return the "check your email" page (200). Do NOT sign in here. Build the verify link as `${origin}/signin/verify?token=<t>&next=<ws>` — pass it into the mail vars (the template from Task 2). Same page whether or not the account exists.
  - New `signinVerify(request, env, {now})`: gate; read `token`,`next`; `const r = await redeemProofPasswordless(env, token, now)` (catch → "link no longer valid" page, 400, no cookie); `const sessionToken = await openSessionFor(env, r.email, r.sessionBinding, now)`; if `next` valid → `mintHandoff(env, sessionToken, next)` → 303 to the workspace enter URL with `setCookie`; else 303 `/workspaces` with `setCookie`.
  - `index.js`: route `GET /signin/verify` (before/near the `GET /signin` block ~:312) with the same verdict-shape handling.
- [ ] **Step 4: GREEN**, `npm test`.
- [ ] **Step 5: Commit.**

## Task 4: Deliver each workspace its account-store bearer (CP)

**Files:** `src/provisioning.js`, `src/account-route.js` (if a list route is added here later — Phase 2), `src/index.js`, `scripts/ensure-account-key.mjs` (new); Test: `test/provisioning.test.mjs`

**Interfaces consumed:** `mintWorkspaceKey` (`accounts.js:933`), `callTenant`.
**Produced:** `ensureWorkspaceKey(env, workspace, now) → {ok}` — mints a `workspace_keys` row and calls the workspace object's `account-key` control verb with the bearer; called from `provisionWorkspace`; runnable standalone for backfill.

- [ ] **Step 1: Failing test.** With a fake tenant capturing control calls: `ensureWorkspaceKey(env, "acme")` mints exactly one `workspace_keys` row for `acme` and calls `callTenant(env,"acme","account-key",{accountKey:<bearer>})` with the same bearer (only its hash is stored; the plaintext goes to the object). `provisionWorkspace` calls it as part of provisioning.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** `ensureWorkspaceKey`: `const bearer = await mintWorkspaceKey(env, workspace, now); await callTenant(env, workspace, "account-key", {accountKey: bearer});`. Add `"account-key"` to `TENANT_RPC` (`provisioning.js:48`) — mirrors the engine `CONTROL_VERBS` (Task 5). Call `ensureWorkspaceKey` inside `provisionWorkspace` AFTER the object is provisioned (a fresh workspace has no key yet). `scripts/ensure-account-key.mjs`: a CLI that calls `ensureWorkspaceKey` for a named workspace (for demo/delta backfill), printing the result.
- [ ] **Step 4: GREEN**, `npm test` (the `TENANT_RPC` mirror test will need the engine's `CONTROL_VERBS` to gain `account-key` in Task 5 — note this cross-repo pairing; run both suites after Task 5).
- [ ] **Step 5: Commit.**

## Task 5: The workspace stores its account key (Engine)

**Files:** `src/tenant-do.js`; Test: `test/tenant-verbs.test.mjs`

**Interfaces produced:** `"account-key"` in `CONTROL_VERBS`; `POST /__control/account-key {accountKey}` stores it in `meta` (key `account_key`); a reader `accountKey()` on the object; `GET`? no — internal. Provision payload MAY also carry `accountKey`.

- [ ] **Step 1: Failing tests.** `control(store,"account-key",{accountKey:"abc"})` on a provisioned workspace stores it (assert `SELECT v FROM meta WHERE k='account_key'` = "abc"); refuses `not-provisioned` (404) on an unprovisioned name, creating no tables. `"account-key"` is in `CONTROL_VERBS`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Add `"account-key"` to `CONTROL_VERBS` (`:501`). In the `/__control/` switch, `case "account-key":` — guard `not-provisioned`; `if (!body || typeof body.accountKey !== "string" || !body.accountKey) return 400 bad-input`; `this.sql.exec("INSERT INTO meta (k,v) VALUES ('account_key', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", body.accountKey); return controlResult({ok:true})`. Add a method `accountKey()` returning `SELECT v FROM meta WHERE k='account_key'` or null.
- [ ] **Step 4: GREEN.** Then run BOTH repos' suites so the cross-repo `CONTROL_VERBS`/`TENANT_RPC` mirror tests agree (they now both list `account-key`).
- [ ] **Step 5: Commit.**

## Task 6: `GET /__enter` — redeem the hand-off, mint a session (Engine)

**Files:** `src/_worker.js`; Test: `test/cross-workspace-enter.test.mjs` (new), driving the real worker like `test/tenant-route-sweep`.

**Interfaces consumed:** `resolveTenant`, the object's `accountKey()`, `rotateSessionKey` (`:2103`), the cookie-issue from `inviteRedeemSession` (`:2681`), roster membership (`tctx.USERS`/`userByEmail`), `readSuspension`/gate.
**Produced:** `WORKSPACE_ENTER_PATH = "/__enter"` (const, matches the control plane); `GET /__enter?handoff=<t>` intercepted BEFORE the login-HTML gate (like `/__invite`), behind `SESSION_KEYS`/`SIGNIN` wiring.

- [ ] **Step 1: Failing tests** (real worker, `TENANTS`-bound, a stubbed account-store fetch): a MEMBER's valid hand-off → 303 to `/` + `Set-Cookie: __Host-augur_user=<email>.<token>`; the same session validates on a follow-up `identify`. A NON-member (email not in roster) → 404 byte-identical to `unknownHostResponse` (assert status + body equal a stranger's). A bad/expired hand-off (account store returns no email) → the same 404. No `account_key` on the object → the ordinary gate/404 (the route is inert). A suspended workspace → the suspension response, no session.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** In `fetch()`, near the `/__invite` interception, add a `GET /__enter` branch that runs AFTER `resolveTenant` + suspension read, BEFORE the login-HTML gate:
  - `const key = await tenantAccountKey(env, tctx)` (reads the object's `accountKey()`); if none → fall through to the ordinary gate (inert).
  - `const handoff = url.searchParams.get("handoff")`; if empty → 404 `unknownHostResponse`.
  - `POST` `${ACCOUNT_ORIGIN}/__account/handoff` with `Authorization: Bearer ${key}` + `{token: handoff}`. Non-200 or no `email` → `unknownHostResponse()` (stranger's answer).
  - `const u = userByEmail(email, tctx.USERS)`; if `!u` → `unknownHostResponse()` (member check; no oracle).
  - Mint the session exactly as `inviteRedeemSession` does: `await rotateSessionKey(env, u.email, tctx)`, then `token2 = await userToken(env, u, undefined, tctx.SESSION_KEYS, tctx)`, respond 303 `Location: /` with `Set-Cookie: ${USER_COOKIE}=${u.email}.${token2}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`.
  - `ACCOUNT_ORIGIN` from `loadConfig`/env (`deploy.config.json`), default none → route inert.
- [ ] **Step 4: GREEN**, focused suite; then `npm test`.
- [ ] **Step 5: Commit.**

## Task 7: Membership notify on roster write + reconcile (Engine)

**Files:** `src/_worker.js`; Test: `test/cross-workspace-enter.test.mjs` / a membership test.

**Interfaces consumed:** `adminUsersApi` (`:9850`), the workspace `accountKey()`, `ACCOUNT_ORIGIN`.
**Produced:** after an invite/add/remove roster write, a best-effort `POST ${ACCOUNT_ORIGIN}/__account/index` (bearer = accountKey) `{verb:"member"|"left", email, label}`; a `reconcile-membership` admin/operator action that walks the roster and notifies each member.

- [ ] **Step 1: Failing tests.** An admin invite (`POST /__admin/users {op:"invite", email}`) fires a `POST /__account/index` (captured by a stubbed fetch) with the workspace bearer and `{verb:"member", email}`; a remove fires `{verb:"left"}`. No `accountKey` → no call, no error. The notify is `waitUntil` best-effort — a failing account store does NOT fail the admin op.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** A helper `noteMembershipUpstream(env, tctx, {email, state, label})` that no-ops without `accountKey`/`ACCOUNT_ORIGIN`, else `ctx.waitUntil(fetch(...))`. Call it from the invite/add and remove branches of `adminUsersApi`. Add `reconcile-membership`: an admin-only route (or a control verb) that reads the full roster and calls the helper per member — for the demo/delta backfill.
- [ ] **Step 4: GREEN**, `npm test`.
- [ ] **Step 5: Commit.**

## Task 8: Rehearsal — the full round trip on real workerd + CLAUDE.md (Engine)

**Files:** `scripts/tenant-do-rehearsal.mjs` (or a new rehearsal), `CLAUDE.md`; 

- [ ] **Step 1:** Add a rehearsal clause driving `/enter`→`/__enter` end to end: set an account key on the object, mint a hand-off in a local account store (or stub the `/__account/handoff` response), hit `/__enter`, assert a `__Host-augur_user` cookie is set and `identify` accepts it; assert a non-member 404s. Run on `wrangler dev --local`.
- [ ] **Step 2:** Run it → all green.
- [ ] **Step 3:** `CLAUDE.md`: document the sign-in straddle (central magic-link → hand-off → `/__enter` → roster check → `SESSION_KEYS` session), the `account_key` in `meta`, the `SIGNIN_OPEN`/`SESSION_KEYS` flags, and that it's additive/flag-gated. Snapshot voice.
- [ ] **Step 4:** `npm run check` (all gates) + `npm test`.
- [ ] **Step 5:** Commit.

---

# PHASE 2 — THE DROPDOWN

## Task 9: Workspace-authed workspace list + `GET /enter` (CP)

**Files:** `src/account-route.js`, `src/signin-route.js`, `src/index.js`; Test: `test/account-route.test.mjs`, `test/signin-route.test.mjs`

**Produced:** `POST /__account/workspaces {email}` (bearer = a workspace key) → `{workspaces:[{workspace,label}]}` from `workspacesFor` — answers only for the asked email, requires a valid workspace bearer (`workspaceForKey`), never lists across accounts. `GET /enter?workspace=` (beside POST) → account session → `mintHandoff` → 303 into the workspace.

- [ ] Failing tests → implement → green. `POST /__account/workspaces` with no/invalid bearer → the ordinary 404 (like the other `/__account/*` doors); with a valid bearer → the email's member workspaces. `GET /enter?workspace=acme` with a session → 303 to the workspace enter URL; no session → 303 `/signin`. Gate on `signinOpen`.
- [ ] Commit.

## Task 10: `GET /__me/workspaces` proxy (Engine)

**Files:** `src/_worker.js`; Test: membership/enter test file.

**Produced:** `GET /__me/workspaces` (signed-in users only, their OWN email from `identify`) → proxies to `${ACCOUNT_ORIGIN}/__account/workspaces` with the workspace `accountKey`, returns `[{workspace,label,current}]` (marking the current workspace). Empty/unwired → `[]`.

- [ ] Failing tests → implement → green. Not signed in → 401/empty. No accountKey → `[]`. Commit.

## Task 11: The switcher dropdown in chrome (Engine)

**Files:** `build.js` (chrome CSS + JS), `src/chrome/appchrome.mjs` (or where `spaceSwitcher` lives); Test: a build/DOM assertion or a route test.

**Produced:** a workspace switcher on the workspace icon that fetches `/__me/workspaces` and renders one row per workspace; each non-current row links to `${ACCOUNT_ORIGIN}/enter?workspace=<id>`; the current one is marked. Degrades to nothing when the list is empty/one. Distinct from the existing space switcher (which stays).

- [ ] Failing test (assert the chrome emits the switcher container + the client JS fetches `/__me/workspaces`) → implement → green. `UI_VERSION` bump (shell change). Commit.

## Task 12: Phase 2 rehearsal + docs

- [ ] Extend the rehearsal / add a test proving the dropdown's data path (`/__me/workspaces` → `/__account/workspaces`) round-trips; `CLAUDE.md` note on the switcher + `GET /enter`. `npm run check` + `npm test` both repos green. Commit.

---

# PHASE 3 — DEPLOY, ENABLE, VERIFY (operator steps — run by the controller, not a task subagent)

- [ ] Push both repos; deploy engine (hosted worker) + control-plane; confirm dry-run clean first.
- [ ] Set on the hosted worker: `SESSION_KEYS=true`, `ACCOUNT_ORIGIN=https://augur.works`. Set `SIGNIN_OPEN=true` on BOTH the hosted worker (if it reads it) and the control plane. Redeploy.
- [ ] `node scripts/ensure-account-key.mjs flint-birch-702` and `… stoic-canyon-873` (give demo + delta their account keys).
- [ ] Add `roberto@…` to demo's roster as admin (delta already has him); run `reconcile-membership` on both so his `account_workspaces` rows exist.
- [ ] **Acceptance:** roberto `GET https://augur.works/signin` → email → magic link → `/signin/verify` → `/workspaces` shows demo + delta → enter each → signed-in (`/__me` returns his email/role on each host); the dropdown switches demo↔delta; a workspace he's not in 404s. Existing password sign-in on demo/delta still works (regression check on a seeded password user).
- [ ] Mark `B-cross-workspace-signin` done (+ note `B-signup-flow`), ship the plan page.

---

## Self-Review

**Spec coverage:** passwordless sign-in (T1–3), account-key delivery (T4–5), `/__enter` (T6), membership notify (T7), SESSION_KEYS + rehearsal + docs (T8), dropdown data path (T9–10), dropdown UI (T11), Phase-2 docs (T12), deploy/enable/verify (Phase 3). ✓ Every spec section maps to a task.
**Placeholder scan:** test-harness helper names (`freshAccountStore`, `stubMail`, `requestProofCapture`) are marked "adapt to the existing harness" because those fixtures are the source of truth; the behaviors/assertions are concrete. The `signin-link` template's exact copy is left to Task 2's implementer to match the existing template style — not a placeholder, a named reuse.
**Type consistency:** `redeemProofPasswordless → {email, sessionBinding}`, `openSessionFor(email, sessionBinding) → token`, `ensureWorkspaceKey(env, workspace)`, `account-key` control verb + `accountKey()` reader, `WORKSPACE_ENTER_PATH = "/__enter"`, `ACCOUNT_ORIGIN` — used consistently across tasks. The `account-key` verb is added to BOTH `CONTROL_VERBS` (T5) and `TENANT_RPC` (T4); the plan flags the cross-repo pairing so neither suite is left red.
