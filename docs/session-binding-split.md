# Splitting the session binding out of the credential

`F-auth-first-run-model`, stage one. **On a branch, unmerged, and the flag is off.**

## Why this is on a branch and not on main

Everything else this session went straight to `main`, because `main` auto-deploys to three
live instances within a minute and every one of those changes was inert or additive. This
one touches `identify()`, `userToken()` and both cookie issuers — the login gate. The
engine's own `CLAUDE.md` says of the guard it sits beside: *"This must survive any future
refactor."* And `HANDOFF.md` says of getting it wrong: *"there is no in-app recovery: while
it is broken nobody signs in, admins included."*

So it wants a person watching one real sign-in before it lands, and there was nobody
watching. Merge it in daylight, sign in, and then decide about the flag separately.

## What it does

`effectiveSecret` was doing two jobs:

1. **The authenticator** — what `verifyPassword` checks a typed password against. Three
   call sites, all on a login path.
2. **The session binding** — what `userToken` HMACs, so that changing or clearing a
   credential invalidated that person's cookies for free.

Job 2 is the one nobody notices until it is gone. Remove the password and there is nothing
left for the cookie to bind to, and the obvious fix — binding to the address alone —
collapses `userToken` to `tokenFor("<email>:")`, which anybody who knows the address can
compute. That is precisely the forgery the guard in `identify()` exists to stop.

So the jobs get separated **while passwords still exist**, which is the only moment the
change can be proved to do nothing.

`sessionBinding(env, u, authenticator, enabled)` is the new seam. With `enabled` false it
returns the authenticator and reads nothing.

## Why it is safe to merge with the flag off

Not "compatible" — identical. `test/session-binding.test.mjs` opens with the proof:

- the binding **is** the authenticator, same string;
- the derived token is byte-for-byte the one the old code produced;
- **the store is not read** — the read counter does not move.

A session key stored while the flag was on is ignored when it goes back off, so flipping it
off is a real rollback rather than a second sign-out.

## Turning it on, when you want to

`"sessionKeys": true` in an instance's `deploy.config.json`. Turn it on somewhere you can
watch before anywhere you cannot.

**Turning it on signs nobody out.** There is no backfill and no flag day: with the flag on
and no key stored, the binding still falls back to the credential, so every existing cookie
keeps verifying until something rotates a key. The fallback *is* the migration.

## What it buys, and the one regression to watch

**Session invalidation stops being a side effect and becomes a verb.** `rotateSessionKey`
ends every session a person holds without touching their credential. Today that is
impossible — a session ends only as a side effect of the hash changing — which means
enrolling a device, redeeming a recovery link and "sign me out everywhere" all end nothing.

⚠️ **A stored key WINS over the credential.** So once one exists, changing a password would
not end that person's sessions by itself. That is the one regression this seam could
introduce, and it is closed by calling `clearSessionKey` beside every write to
`users:secrets` — both `setUserSecret` and `revokeSecret` do. There is a test named for it:
*"⚠️ A CREDENTIAL CHANGE STILL ENDS SESSIONS, even once a key is stored"*.

## The auth warnings, and where each one landed

- **No effective secret ⇒ no session.** Untouched. `identify()` still guards on the
  credential before anything else.
- **Resolve once.** Now TWO resolves, of two different values, each exactly once —
  the credential for the guard, the binding for the derivation. Both must be truthy.
  Re-resolving either inside `userToken` would reopen the forgery; `userToken`'s header
  says so.
- **Fail closed on a store error.** `sessionBinding` matches `effectiveSecret` exactly:
  no binding at all is the offline case and falls back; bound-but-unreadable returns `""`,
  which `identify()` refuses. There is a test for both, and for the array-shaped document
  that passes `typeof === "object"`.
- **Present-and-falsy is a revocation.** Same semantics as the credential tombstone.
- **The `__Host-` cookie prefix.** Untouched; no cookie name changes.
- **Sessions HMAC on `SESSION_SECRET`.** Untouched. Note this composes cleanly with
  `B-cross-workspace-signin`, which replaces the Worker-wide secret with the workspace's
  own signing key: both are changes to *what gets HMAC'd with*, not to the derivation.

## What is deliberately NOT in this branch

**The invite flow still ends at "set a password".** Deleting that step is the other half of
stage one and it changes how people actually get in, which is not something to ship
unwatched. Do it as its own change, after this one has been live for a while.

**The session keys have no table in the workspace object.** They are declared in
`UNMAPPED_WORKSPACE_FAMILIES` with the reason: the object has `signing_keys`, which is the
*workspace's* own key, and a per-person key belongs in the same schema decision rather than
in two. `B-cross-workspace-signin` is the item that makes it, because minting a session on
a workspace host is what decides what a session binds to. Losing this family in a copy
signs that workspace's people out once, which is the recoverable direction to be wrong in.

## One record per person, since `B-sessionkeys-lost-update`

The keys first landed as ONE document, `users:sessionkeys`, every person's key in a map that
`rotateSessionKey` and `clearSessionKey` rebuilt read-modify-write. A KV read serves a cache
that can be a minute stale, so rotating person A could read a map that predated person B's
fresh key and write B's *old* key back — which both killed B's live session and un-did the
invalidation the verb exists to guarantee. Two writes inside one window is what an invite
flow does, and it cost two admin sessions on staging.

Now each person has a record of their own — `users:sessionkeys:<sha256 of the lowercased
address>` → `{key}`, or `{key: null}` for a clear — and rotate and clear each write theirs
**blind**, reading nothing. There is no shared document, so there is nothing a stale read can
carry into a write. `test/session-key-lost-update.test.mjs` drives both verbs through a
store whose reads lag its writes and asserts each person's newest key is the stored one.

**The old document is read, never written, and only for a person who has no record yet.**
That read-through is the migration: a cookie minted before the change verifies on its first
request after the deploy, with nothing backfilled and nothing written on the read path. A
person leaves the document the first time something rotates or clears their key — which is
why a clear writes a tombstone rather than deleting: absent means "ask the old document",
and the old document holds the key the clear is ending. Rolling the engine back below this
change re-exposes the document: everybody rotated since would fall back to their old entry
(or their credential) and be signed out once, and a cleared entry would verify again.

## Merging

```
git -C augur checkout main && git -C augur merge auth/session-binding-split
npm --prefix augur run check && npm --prefix augur test
```

Then push, wait for the pin to reach an instance, and **sign in.** That is the test that
matters and it is the one no suite can run.
