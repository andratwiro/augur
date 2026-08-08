# Invite-only authentication

**Status:** design, approved 2026-08-08
**Supersedes:** the `hardening` branch (2026-07-05), which this absorbs and extends

## Problem

Augur's identity layer stores and compares passwords in plaintext. `src/_worker.js`
documents this as "a casual identity layer, not auth hardening" — a defensible call for
a private internal tool, but the engine is now a public repository and that assumption no
longer holds.

Three consequences follow from plaintext storage:

1. **Seeds are committed.** `identity.json` carries each user's password, so anyone with
   repository access has every credential, and git history keeps them after any change.
2. **KV overrides are readable.** The admin password-change endpoint writes plaintext into
   the `users:secrets` KV key. Anything that reads or backs up KV — including an ordinary
   disaster-recovery export — captures live credentials in the clear.
3. **Passwords are issued, never chosen.** An operator generates a password, transmits it,
   and it stays valid indefinitely. The operator knows every user's password permanently.

The `hardening` branch solved (1) and (2) in July with PBKDF2 hashing and HMAC sessions,
but was never merged. It does not address (3).

## Goals

- No plaintext password is ever stored, logged, committed, transmitted, or recoverable.
- The operator never knows any user's password, at any point, including at account creation.
- A user who forgets their password can regain access without an operator setting one.
- Credentials cannot leak through a KV export, because KV holds no reversible secret.
- The admin surface manages *people*, not *credentials*.

## Non-goals

Deliberately excluded. Each is a reasonable future addition; none is needed now.

- **Email delivery.** Invite and reset links are delivered manually (see *Delivery*). The
  token machinery is designed so email is an additive change, not a redesign.
- **Custom domains / URL migration.** Unrelated to auth; tracked separately.
- **Multi-factor auth, SSO, OAuth.** Out of scope for an internal prototyping tool.
- **Password strength policy beyond a minimum length.** Users choose their own; a length
  floor is the only enforced rule.
- **Rate limiting on login.** Worth adding, but it is a separate concern from this design
  and should not gate it.

## Model

Three pieces of state, each with one job:

| Store | Holds | Reversible? |
|---|---|---|
| `identity.json` (committed) | email, name, initials, colour, role | n/a — no secret |
| `users:secrets` (KV) | `{email: pbkdf2 hash string}` | no |
| `users:invites` (KV) | `{token: {email, expires}}` | no — token is the secret |

`identity.json` becomes a pure roster. It contains no credential in any form, which means
committing it, backing it up, or publishing it is harmless.

### Credential storage

PBKDF2-SHA-256, per-hash random 16-byte salt, 100,000 iterations, serialised as:

```
pbkdf2$<iterations>$<saltB64>$<hashB64>
```

This is the `hardening` branch's format and implementation, carried over unchanged. The
parameters live in `src/_worker.js` and are imported by anything else that needs them, so
the runtime verifier and any tooling cannot drift apart on format or cost.

Verification accepts a legacy plaintext value and upgrades it to a hash on successful
login. This exists only to keep a mid-migration deploy from locking anyone out; once
migration completes, no plaintext values remain and the branch is dead code that can be
removed.

### Sessions

Cookie `gv_user` = `<email>.<token>`, where the token is
`HMAC-SHA-256(SESSION_SECRET, email + ":" + effectiveSecret)`.

`SESSION_SECRET` is a runtime environment secret, never bundled and never committed, so a
cookie cannot be forged from repository-visible data. Sessions stay stateless — no session
store, one KV read per request.

Binding the token to the user's effective secret gives session invalidation for free:
changing or clearing a password changes the HMAC input, so every existing cookie for that
user stops verifying immediately. This is relied upon by the migration.

### Invite and reset tokens

One mechanism serves account creation and password recovery. They differ only in wording.

- 32 bytes from `crypto.getRandomValues`, base64url-encoded.
- Stored in KV under `users:invites` as `{token: {email, expires}}`.
- **Single-use** — consumed and deleted the moment a password is set.
- **Expires after 7 days**, enforced on redemption and independently of deletion.
- **Issuing a new token for a user invalidates any outstanding token for that user** —
  issuance sweeps the map for entries matching that email and drops them before writing the
  new one. This prevents an accumulation of live links and makes re-invitation idempotent.
- Redemption is the *only* code path that writes to `users:secrets`.

Expiry matters because links are pasted into chat, where they persist in scrollback
indefinitely. Single-use plus a 7-day window means a link found in history later opens
nothing.

### User lifecycle

```
(admin adds account) → pending ──redeem invite──→ accepted ──login──→ active
                          ↑                            │
                          └────── admin resets ────────┘
```

- **pending** — on the roster, no hash in `users:secrets`. Cannot log in. An invite token
  may or may not be outstanding.
- **accepted** — has set their own password. Can log in.
- **active** — accepted, plus a recent `users:lastseen:<email>` stamp.

`users:lastseen:<email>` already exists and is already rendered in the admin list, so the
activity dimension needs no new storage.

Resetting a user clears their hash and mints a fresh invite token in **one action**. There
is deliberately no state in which a user has both a live old password and a pending
invite — that overlap is what lets a known-compromised credential survive a rotation.

### Admin surface

The admin panel manages people:

- **invite / reset** — clear hash + mint token (the same action for a new and an existing
  user; a roster entry with no hash has simply never been redeemed)
- **view** — lifecycle state and last seen

**Adding and removing people stays a commit.** The roster lives in `identity.json` and is
injected at build time, so runtime add/remove would mean moving identity into KV — a
larger change than the rest of this design, and one that buys little at this scale (a
handful of people per year). Deferred deliberately; the invite flow works identically
whether the roster entry arrived by commit or otherwise.

The endpoint that sets a password on a user's behalf is **removed**. No administrative
path can set, read, or recover a password. `role: "admin"` grants user management only.

The consequence is accepted deliberately: an operator cannot restore access directly, only
re-issue an invite. The break-glass, if invites themselves are broken, is editing
`identity.json` and redeploying — friction that suits something which should approximately
never happen.

## Delivery

Redemption links are delivered **manually**: the admin UI renders the URL with a copy
button, and the operator sends it over whatever channel already exists (chat, DM). For a
team of this size that is not a compromise — a chat DM is an already-authenticated channel
with no inbox to compromise, no deliverability, and no sending reputation.

Email is deliberately deferred. The seam is narrow by construction: token issuance,
storage, redemption, expiry and invalidation are all delivery-agnostic, so adding email
means adding a *sender* alongside the copy button. No change to tokens, hashing, sessions
or lifecycle. That narrowness is the test of whether deferring was correct.

## Migration from plaintext seeds

Any deployment upgrading from the plaintext scheme must treat every existing password as
compromised — they were committed to git, so history retains them regardless of any later
change.

Migration is **per-user**, not a single cutover, so that an operator can deploy and migrate
themselves without disturbing anyone else. This requires two temporary compatibility paths,
both of which are removed together at the end.

**Deploy (invisible to users).**

1. Set `SESSION_SECRET` on the project **before** the worker deploys.
2. Deploy the hashed worker with both compatibility paths active:
   - **Legacy secret** — `verifyPassword` accepts a plaintext value and
     `upgradeSecretIfLegacy` rewrites it as a hash on successful login. This covers both
     places a legacy plaintext can live: an old plaintext value in `users:secrets`, and
     the roster's own `pass` field with no `users:secrets` key at all — which is where
     every seeded account actually sits. In the second case the upgrade *creates* the
     `users:secrets` entry, so it only fires for a password that verifies against the
     roster plaintext. A key that is present but falsy is a revocation tombstone and is
     never upgraded. Existing seeds keep working, and stop being plaintext on first use.
   - **Legacy session** — `identify()` accepts either the old or new cookie derivation,
     while issuing only the new one. Existing sessions survive the deploy.
3. Leave `pass` in `identity.json` and leave `users:secrets` populated.

Nobody is signed out and no password stops working. The deploy is a no-op from a user's
point of view.

**Migrate (per user, operator-paced).** Resetting a user overwrites their `users:secrets`
entry with a tombstone (`null`) and mints an invite token — one action. The tombstone is
what kills the roster `pass` fallback: reset cannot edit `identity.json` (that is a build
input), so it revokes by making the key *present and falsy* rather than absent. That
user's legacy password dies at that moment, their sessions stop verifying, and — because
`identify()` refuses any user with no effective secret — no cookie can be forged for them
in the window before they redeem. They redeem the link and choose their own password.

**Finish (once the last user is migrated).**

1. Confirm no user retains a `pass` field and `users:secrets` contains only `pbkdf2$…`
   values — no plaintext remains anywhere.
2. Delete both compatibility paths: the plaintext branch in `verifyPassword` and the legacy
   derivation branch in `identify()`. **Keep the no-effective-secret guard in `identify()`**
   — it is not a compatibility path. `userToken()`'s own no-`SESSION_SECRET` fallback has
   the same secretless shape, so removing the guard would reopen cookie forgery for every
   pending or reset user even after both migration paths are gone.
3. `scripts/rotate-seeds.mjs` does not exist on this branch — there is nothing to delete.
   It was never ported here: invite-only has no seeds to rotate, only hashes to clear, so
   the script had no reason to exist in the first place. (It's present on the older
   `hardening` branch, where seed rotation is still a live concept — don't expect to find
   it in this history.)
4. Deploy. Any session still riding the legacy derivation is invalidated, which is correct:
   by this point every user has migrated.

The compatibility paths exist only to make step *Migrate* incremental. Leaving them in
place indefinitely would preserve the ability to authenticate against a plaintext value,
which is the defect this design exists to remove. Their deletion is not optional cleanup.

## Testing

- **Unit** — `test/worker.test.mjs` covers hash/verify round-trips, format stability,
  legacy-plaintext upgrade, HMAC token derivation, and cookie verification. Extend with
  token issuance, single-use redemption, expiry, and re-issue invalidating prior tokens.
- **Smoke** — `scripts/smoke-offline.mjs` exercises the flow against the offline harness:
  add → pending → redeem → accepted → login → reset → old password rejected.
- **Canary** — ship to a single-user instance first and validate the whole flow against a
  real deployment before any multi-user instance receives it.

Note on sequencing: a push to engine `main` dispatches to the shell named by the
`SHELL_REPO` repository variable and deploys there within about a minute. Any instance not
named by that variable bumps on its own schedule. An engine change therefore reaches one
specific instance immediately, which may not be the one intended as the canary. Auth work
should happen on a branch, be deployed manually to the canary instance, and merge to `main`
only when the multi-user instance is ready to receive it.

## Consequences

- The failure mode that motivated this design becomes structurally impossible rather than
  merely fixed: there is no plaintext credential anywhere for an export, a backup, or a
  commit to capture.
- KV backups become safe to retain, since `users:secrets` holds only hashes.
- The operator loses the ability to restore a user's access directly. This is the intended
  trade and the reason invite delivery must actually work.
- Users must complete a redemption step before first use, replacing "here is your password"
  with "here is your link".
