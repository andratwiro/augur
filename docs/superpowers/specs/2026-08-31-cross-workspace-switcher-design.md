# Magic-link sign-in and the cross-workspace switcher

**Status:** design, approved (autonomy granted) 2026-08-31
**Acceptance (the two live tests):**
1. roberto's account signs in once with a magic link and can **switch** between the two hosted workspaces (`demo`=`flint-birch-702`, `delta`=`stoic-canyon-873`), reaching each signed-in.
2. **Magic-link sign-in works for all hosted instances** — the central passwordless sign-in reaches every workspace on the hosted `augur-tenant` worker.

**Touches (control plane `augur-control-plane/`):** `src/accounts.js`, `src/signin-route.js`, `src/provisioning.js`, `src/account-route.js`, `src/index.js`, `wrangler.toml`, tests.
**Touches (engine `augur/`):** `src/_worker.js` (the `/__enter` route + membership notify + config), `src/tenant-do.js` (store the account-store bearer; a control verb to set it), `build.js` (Phase 2 switcher chrome), `CLAUDE.md`, tests.
**Deploy shell:** `augur-deploy-hosted/wrangler.toml` (flags: `SESSION_KEYS`, `SIGNIN_OPEN`).

## Problem

The hosted deployment serves two workspaces from one worker, each its own host. A person who
belongs to several can't move between them without a fresh credential per host, and there is no
account-level identity — passwords (`users:secrets`) and `SESSION_SECRET` are *shared* across
every workspace on the hosted worker by accident of the deployment, which is a footgun the
moment a customer who is not the operator lands there. `B-cross-workspace-signin`'s **control-plane half is
built and live** (account store v7: `accounts`, `account_workspaces`, `sessions`, `handoffs`,
`workspace_keys`; routes `/signin`, `/workspaces`, `/enter`, `/signout`; `mintHandoff` /
`redeemHandoff` / `noteMembership` / `mintWorkspaceKey`). What is missing is the **engine half**
(no `/__enter` to redeem a hand-off, nothing that gives a workspace its account-store bearer,
nothing that reports membership) and the credential model is **password**, not magic-link.

## The trust model (unchanged from the built half — the spec obeys it)

- **Central sign-in proves WHO, never WHAT.** `augur.works` authenticates an email (now by
  magic link) and holds one account session (`__Host-augur_session`, this origin only). It
  never decides whether that email may enter a workspace.
- **The workspace decides WHAT.** A per-workspace session (`__Host-augur_user`, that host only)
  is minted by the **workspace itself**, and only after it checks its own roster. A lagging or
  compromised control plane cannot widen access inside a workspace.
- **The bridge is a single-use hand-off.** `/enter` mints one bound to ONE workspace (60 s,
  single-use); the workspace's `/__enter` redeems it over its own bearer and mints its session.
- **`__Host-` cookie prefixes are load-bearing** and stay exactly as they are: no `Domain`, so
  no cookie spans hosts. Switching is a central sign-in minting a separate per-host session,
  never a shared cookie.

## Goals

- Passwordless central sign-in: email → mailed link → account session. No password stored for
  a magic-link account (`accounts.credential` stays `NULL`).
- A workspace can redeem a hand-off and mint a local session for a roster member — and 404s a
  non-member exactly as it 404s a stranger (no membership oracle).
- One sign-in reaches every hosted workspace the account belongs to.
- **Phase 2:** an in-chrome workspace-icon dropdown that lists your workspaces and switches,
  routing every switch through `augur.works` (the account session never leaves it).
- **Backwards-compatible and flag-gated:** existing password sign-in on every workspace keeps
  working byte-for-byte; nothing changes for anyone until the flags are set.

## Non-goals

- Public workspace **signup** (creating a workspace from a form). That stays behind
  `SIGNUP_OPEN` and is not opened here — this decouples sign-in from signup with a new
  `SIGNIN_OPEN` flag (justified: magic-link has no password to guess, so the "guessing surface"
  reason the two were tied no longer applies to sign-in).
- Removing per-workspace passwords / moving `users:secrets` to account-level. The account layer
  is **additive**; `effectiveSecret` and per-workspace passwords are untouched.
- Retiring the shared `SESSION_SECRET`. Noted as a known limitation; not this feature.
- Per-workspace login pages offering magic-link directly. Central sign-in covers "all hosted
  instances" by construction; a per-host passwordless form is a later nicety.

## Design

### 1. Passwordless central sign-in — control plane (`signin-route.js`, `accounts.js`)

The `credential_proofs` table is already an emailed single-use proof (a magic link). Today
`redeemCredentialProof` *requires a password*. Add a passwordless path:

- **`accounts.js`: `redeemProofPasswordless(env, token, now)`** — the same CAS INSERT as
  `redeemCredentialProof` but writing `credential = NULL` (the account exists, verified, no
  password), returning `{email, sessionBinding}`. Reuses the proof-is-one-event discipline
  verbatim; only the `credential` value and the missing password arg differ.
- **`signin-route.js` becomes email-only:**
  - `GET /signin` → an email-only form (no password field), carries `next`.
  - `POST /signin {email, next}` → rate-limited, then `requestCredentialProof(env, email, {mail})`
    mails a link to `GET /signin/verify?token=<t>&next=<ws>`. Always answers the same "check
    your email" page whether or not the address has an account (no oracle). No session yet.
  - **`GET /signin/verify?token&next`** (new) → `redeemProofPasswordless` → `openSession` →
    set `__Host-augur_session` → if a valid `next` workspace rode along, `mintHandoff` and 303
    into it; else 303 `/workspaces`. Single-use: the proof is spent by redemption.
  - `/workspaces`, `/enter`, `/signout` unchanged (already built).
- **Gate:** all sign-in routes move from `signupOpen(env)` to **`signinOpen(env)`**
  (`SIGNIN_OPEN === "true"`), a new export in `signup-route.js` beside `signupOpen`. Signup
  routes keep `signupOpen`. Update the header comment: magic-link removes the guessing surface,
  so sign-in opens independently of signup.
- Mail: reuse the account store's existing `mail` injectable (the same one
  `requestCredentialProof` already takes); the hosted control plane already has Scaleway mail
  configured (`MAIL_*`). The magic-link email is a new template `signin-link` (text + HTML).

### 2. Every workspace holds an account-store bearer — provisioning + the workspace object

`mintWorkspaceKey(env, workspace)` exists but nothing calls it or delivers the bearer to the
workspace. Wire it:

- **`provisioning.js`: `provisionWorkspace`** mints the workspace's account-store bearer
  (`mintWorkspaceKey`) and passes it to the workspace object in the SAME provisioning call — a
  new field on the `provision` control verb payload (`accountKey`). One transaction, like the
  first admin.
- **`tenant-do.js`:** the `provision` handler stores `accountKey` in the object's `meta`/settings
  (never in a bundle, never in KV a reset clears). A new control verb **`set-account-key`**
  (operator-reachable, like the others) sets/rotates it on an ALREADY-provisioned workspace —
  needed to backfill demo and delta, which were provisioned before this field existed.
- The engine reads the current workspace's `accountKey` from its object when it needs to call
  the account store. It is a per-workspace secret; it never crosses to another workspace.

### 3. The engine hand-off — `GET /__enter?handoff=<token>` (`src/_worker.js`)

The core straddle. `WORKSPACE_ENTER_PATH = "/__enter"` is already the control plane's contract.

1. Resolve the workspace (the normal `resolveTenant`). Read its `accountKey` from the object.
   No key → this deployment isn't wired for central sign-in → behave as an unknown path (the
   ordinary gate response), never an error that reveals the seam.
2. `POST` the control plane's **`/__account/handoff`** with `Authorization: Bearer <accountKey>`
   and `{token}` → `redeemHandoff` returns `{email}` (single-use; a second redemption fails).
   The control-plane URL comes from a config value (`ACCOUNT_ORIGIN`, e.g. `https://augur.works`).
3. **Membership check — the workspace is the authority.** Is `email` in THIS workspace's roster
   (`tctx.USERS` / the roster overlay)? If not → **404, byte-identical to a stranger's**
   (`unknownHostResponse`-style), so a hand-off for a workspace you don't belong to is not an
   oracle. Exactly the built design's promise.
4. If a member → mint the session **the passwordless way**, reusing `inviteRedeemSession`'s
   path (`src/_worker.js:2673`): `rotateSessionKey(env, email, tctx)` then issue
   `${USER_COOKIE}=${email}.${token2}` with the standard attributes. This requires
   `SESSION_KEYS` on (below). 303 to `/`.
5. Not on `SUSPENDED_ALLOWED` and behind the front-door gates like any other write path — a
   suspended/tombstoned workspace's `/__enter` answers the suspension page, not a session.

`/__enter` is added to `isPublicPath`-style routing as a first-class gate branch (it runs
BEFORE the login-HTML gate, since it IS a sign-in path — mirror how `/__auth`/`/__invite` are
handled).

### 4. Membership notify — engine → control plane (`src/_worker.js`)

So `/workspaces` (and the Phase 2 dropdown) list the right workspaces:

- On every roster **write** (invite/add/remove in `adminUsersApi`, and provisioning's first
  admin), the engine `POST`s the control plane's **`/__account/index`** with the workspace
  bearer and `{email, state: "member"|"left", label}`. Best-effort on `waitUntil` — the
  account index is PRESENTATION ONLY (never authorization), so a missed write costs a stale
  switcher row, never access. `noteMembership`'s ordering-token CAS makes it idempotent.
- **Backfill:** a one-shot reconcile that walks a workspace's current roster and notifies each
  member — run once for demo and delta so roberto (and existing members) appear. Implemented as
  a control verb / admin action `reconcile-membership` so it's repeatable and operator-run, not
  a migration script.

### 5. `SESSION_KEYS` on for the hosted worker

Passwordless workspace sessions bind to a per-person rotated session key, not a password
(`sessionBinding`, `src/_worker.js:2077`). Turn `SESSION_KEYS=true` on the hosted worker.
**Backwards-compatible, asserted not argued:** with the flag on, `sessionBinding` returns the
stored key and *falls back to the credential when no key is stored*, so existing password users'
live cookies keep validating and their next `/__auth` establishes a key. `/__auth` and
`invitePost` already establish a truthy binding before issuing a cookie. `FIRST_RUN` stays off.

### 6. Phase 2 — the in-chrome switcher dropdown (`build.js`, `src/_worker.js`, control plane)

- **Data:** a new workspace-authed control-plane route **`POST /__account/workspaces {email}`**
  (bearer = the workspace's accountKey) returns THAT email's member workspaces
  (`workspacesFor`). It is not an open oracle: the workspace proves the email via its own
  signed-in session before asking, and answers only for its own current user.
- **Engine endpoint:** `GET /__me/workspaces` (signed-in users only, their own email) proxies
  to the above using the workspace's accountKey, returns `[{workspace, label, current}]`.
- **Chrome:** extend the existing `spaceSwitcher` dropdown (`appchrome.mjs`) — or add a sibling
  workspace switcher on the workspace icon — that fetches `/__me/workspaces` and renders one row
  per workspace. **Each row is a link to `https://augur.works/enter?workspace=<id>`** (a GET
  entry point added beside the POST `/enter`; safe because it only sends the signed-in account
  to a workspace it belongs to, SameSite-Lax, single-use hand-off). The current workspace is
  marked, not linked. Empty/one-workspace → the dropdown simply shows the current one.
- **`GET /enter` (control plane):** beside the existing POST — reads the account session, mints
  a hand-off for `?workspace=`, 303s into it. GET is acceptable here (no destructive state; a
  cross-site GET can only bounce the already-signed-in user into their own workspace).

### 7. Enabling + roberto's setup (the live acceptance)

- Deploy engine + control-plane + hosted worker with the code (flags still off).
- Set `SESSION_KEYS=true`, `SIGNIN_OPEN=true`, `ACCOUNT_ORIGIN=https://augur.works` on the
  hosted worker; `SIGNIN_OPEN=true` on the control plane. Redeploy.
- Give demo and delta their account-store bearers (`set-account-key`, operator-run).
- Add roberto's account to **demo's** roster as admin (delta already has him); reconcile
  membership on both so his `account_workspaces` rows exist.
- Verify: roberto `/signin` at augur.works → magic link → `/workspaces` shows demo + delta →
  enter each → signed-in; the dropdown switches; a workspace he's not in 404s.

## Security considerations

- **No membership oracle:** `/enter` and `/__enter` never reveal membership — a hand-off for a
  non-member workspace is minted and then 404'd inside, the stranger's answer.
- **The account key is per-workspace and minimal:** it authorizes only `/__account/handoff`,
  `/__account/index`, `/__account/workspaces` for its own workspace (read from the key, never
  the payload). It cannot name another workspace.
- **WHO/WHAT split preserved:** the workspace re-checks its roster on every `/__enter`; the
  control plane's word is never sufficient to enter.
- **Magic-link anti-abuse:** the existing per-address proof cap + the signup-counter rate limit
  guard link-spam; the same-answer-for-known-and-unknown keeps `/signin` from enumerating.
- **Single-use, short-lived:** proofs and hand-offs are single-use with TTLs; redemption is a
  CAS DELETE…RETURNING so two redemptions can't both win.
- **Flag-gated backwards compatibility** proved by tests: with the flags off, every path is
  byte-for-byte prior behavior.

## Testing

- **Control plane:** `redeemProofPasswordless` (creates account, credential NULL, single-use,
  CAS); `/signin` email-only + `/signin/verify` (mails, redeems, sessions, `next` hand-off);
  `signinOpen` gates independently of `signupOpen`; `GET /enter`; `/__account/workspaces` (bearer
  scoping, own-workspace only). Rehearsal on real D1 for the account-key wiring.
- **Engine:** `/__enter` (member → session; non-member → 404 identical to stranger; bad/expired
  hand-off → 404; suspended workspace → suspension page; no accountKey → ordinary gate);
  membership notify fires on roster write; `SESSION_KEYS` on is byte-for-byte for existing
  password users (regression). Drive over the real worker like `test/tenant-route-sweep`.
- **Cross-repo:** the `/__enter` ↔ `/enter`/`mintHandoff`/`redeemHandoff` contract; the
  `accountKey` ↔ `workspace_keys` contract; verb-list mirrors if a control verb is added.
- **Rehearsal:** the account-key set + a full `/enter`→`/__enter` round trip on `wrangler dev`
  with a local account store, proving the session mints.
- `npm test` + `npm run check` green in both repos.

## Rollout / acceptance

Deploy behind flags → enable on the hosted worker → wire keys → set up roberto → run the live
acceptance (roberto switches demo↔delta via magic link; a non-member 404s). Update the plan
items (`B-cross-workspace-signin`, `B-signup-flow` where relevant) and ship the plan page.

---

## Current status & handoff (as of 2026-08-31) — READ THIS FIRST if picking up

**The design above is BUILT, reviewed, and DEPLOYED. One live blocker remains and it can lock the
operator out of a workspace if done wrong — do not guess at it.**

### Where the pieces are
- Implementation plan (12 tasks, all done): `docs/superpowers/plans/2026-08-31-cross-workspace-switcher.md`.
- Full execution log + per-task review notes + every commit SHA: `augur/.superpowers/sdd/progress.md`
  (⚠️ git-IGNORED scratch — on this machine only, not in a fresh clone).
- Engine straddle documented in `augur/CLAUDE.md` (search "central sign-in", "GET /__enter").
- Control-plane runbook for the account-key backfill: `augur-control-plane/runbooks/operator-credential.md`.

### What is live (both repos green; committed + pushed)
- Engine HEAD `f9e58b6b` (hosted worker deployed = version `afbb6d1d`; also auto-propagated to the reference instance, inert).
- Control-plane HEAD `297b378` (deployed). `augur.works/signin` is LIVE (email-only magic link); signup stays off.
- Account-store bearers WIRED for `flint-birch-702` (demo) and `stoic-canyon-873` (delta) via the new
  `account-key` operator verb (`operator-route.js`). Confirmed `ok` live.
- Flags ON: `SESSION_KEYS` + `accountOrigin` in `augur-deploy-hosted/deploy.config.json`; `SIGNIN_OPEN="true"`
  in the control-plane `wrangler.toml`. (Fixed a real gap: `sessionKeys` was never threaded from
  deploy.config into `instance.json` — commit `f9e58b6b`.)

### The blocker (diagnosed via a synthetic live test)
Drive `/enter` (control plane) → it mints a hand-off and 303s to a workspace's `GET /__enter?handoff=…`.
The control-plane half works. **`/__enter` returns 404.** Root cause: **delta and demo have NO
`config/instance.json` in the R2 bundle store** (`t/<ws>/config/instance.json` — key ABSENT). So
`loadTenantContext` reads config FIELDS from the empty base → `ACCOUNT_ORIGIN=""`, `SESSION_KEYS=false`
→ `/__enter` is inert. (Roster + credential load from the workspace OBJECT, which is why login still
works; the flag fields do not.) The `deploy.config.json` flags reach the built dist ASSETS, NOT the
per-workspace store config the worker actually reads in bundle mode.

⛔ **THE HAZARD — why this was NOT auto-fixed:** setting `accountOrigin`/`sessionKeys` needs a config
write per workspace (`/__publish/_instance/config`). `augur/CLAUDE.md` and the Delta notes warn a config
push built from the hosted shell's `identity.json` (`[]`) **"would overwrite the credential and lock him
out"** of Delta. There is an unresolved contradiction: the R2 config key is ABSENT, yet CLAUDE.md says
Delta's seeded passHash lives in `config/instance.json`. **Resolve WHERE the Delta credential actually
lives (workspace object `users:secrets` vs a store config) BEFORE any config write.** The safe shape is
almost certainly: read the workspace's CURRENT effective config, add only `accountOrigin` +
`sessionKeys`, write it back without touching `users`/secrets — but confirm the storage first.

### Remaining steps to the acceptance (roberto switches demo↔delta via magic link)
1. **(blocker)** Safely give delta + demo a config carrying `accountOrigin: "https://augur.works"` and
   `sessionKeys: true`, WITHOUT blanking the credential. This unblocks `/__enter`.
2. **Add `roberto@<the operator's domain>` to DEMO's roster** (demo-admin invite; delta already has him),
   then run the engine's `reconcile-membership` admin op so demo appears in his switcher.
   (His DELTA `account_workspaces` row is already seeded.)
3. **The operator clicks the magic link** at `augur.works/signin` — it goes to their own inbox; only they
   can complete that step.
4. Then update `B-cross-workspace-signin`/`B-signup-flow` on the hosted plan and ship the plan page.

### Re-verify tool (no email needed)
The synthetic live test: INSERT an `accounts` row (credential NULL) + a `sessions` row (binding =
`incarnation:epoch`, token_hash = SHA-256 of the cookie value) in `augur-accounts-eu`, then
`GET augur.works/enter?workspace=<ws>` with `Cookie: __Host-augur_session=<token>` and follow the 303
into `/__enter`. A 303 + `Set-Cookie: __Host-augur_user=…` means the whole straddle works live. Creds:
`.secrets/hosted.env`.

### Known minor (pre-public-launch): no Turnstile on `POST /signin` (bounded by existing rate limits).
