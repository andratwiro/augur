# Users, login, avatars

## Getting in, if you are an agent

You do not need a login. Publishing needs a **publish token**, and the way to get one
is device pairing: `npx augur connect --origin <the workspace>` prints a link and a
code, the owner enters the code in a browser they are already signed in to, and the
token lands on this machine. Nobody's password is asked for, typed or stored. The
instance says the same at `GET /llms.txt`. The full shape is in [README.md](./README.md)
under *Getting in*.

The `pass` field on a user record below is a first-sign-in seed for a **self-hosted**
instance, consulted only when that person has no credential in the store yet. It is not
a key: on a hosted workspace it is dead, on a self-hosted one it stops working the moment
the person sets a password, and the gate throttles failed attempts. Never try it.

## The account model

The engine has per-user accounts. Sign-in is email + password on a self-hosted
instance, or an emailed code from the central account store on a hosted one (no
password exists there; see `ACCOUNT_ORIGIN` / `SESSION_KEYS`). The engine repo
itself carries **no users** — `src/identity.json` is an empty placeholder; the
live list lives in the instance's deploy shell repo as `identity.json` (NOT in
this engine repo). Editing it is a config change: it only reaches the live site
once the instance config is redeployed/published (build re-emits
`dist/__config/instance.json` from it), never on a bare file save.

## The user record

`identity.json` is an ARRAY of user objects:

```jsonc
{
  "email": "person@example.org",   // login id
  "emails": ["alias@example.org"], // optional extra addresses that also log in
  "name": "Person Name",
  "role": "admin",                 // "admin" | "editor" | "viewer". Omit for editor.
                                   // (`user` is the legacy spelling of "editor" and
                                   // still reads as one — never a flag day — but
                                   // nothing new should be written wearing it.)
  "passHash": "pbkdf2$…",          // FIRST ADMIN ONLY — everyone else is invited
  "initials": "PN",                // presence chip fallback
  "color": "#7A5AF8",              // presence chip color
  "avatar": "data:image/webp;base64,…"  // optional SEED photo; served at /__avatar/<key>
}
```

### The three roles

| | Sign in, comment, drive boards | Publish | Admin panel, tokens, delete |
|---|---|---|---|
| `viewer` | ✅ | ❌ | ❌ |
| `editor` | ✅ | ✅ | ❌ |
| `admin`  | ✅ | ✅ | ✅ |

`viewer` is the role for an account whose password is public knowledge — a demo
instance's `loginHint` credentials. It is refused a publish token at mint time, and
any token it already holds stops resolving, so a demotion cannot leave the old
privilege alive in a credential.

**Changing a role** is a per-person control in the Admin panel (click a row →
Role). It takes effect on the next request via a KV overlay, and the panel asks the
deploy shell to commit the change to `identity.json` so the file stays the durable
record — at which point the overlay entry drains itself. The one refusal: the **last
admin cannot be demoted**, because an instance with no admin cannot be repaired from
inside it (every admin route, the panel and the star-scoped publish token all
require one).
Promote someone else first.

- **The panel can add and remove people without a commit, and the two records
  converge.** The Admin page lists everyone as a table (name + email, role, last
  active) with an **Invite** action and, on clicking a row, **Reset password** /
  **Remove user**. Invite and remove write a runtime overlay on top of the file, so
  the change is live instantly; the same action asks the deploy shell to commit it
  to `identity.json`, and when the deploy that follows pushes the new config back,
  the worker DRAINS every overlay entry the file now supersedes.

  ⚠️ **The overlay is transitional by design, not a second record.** Left
  un-drained the two disagree visibly: builds bake people-derived state into every
  generated page, so an identity-file build and a live-roster build disagree about
  who exists, and each publish flips hundreds of gallery pages between the two
  renderings. `identity.json` stays the durable record — edit it when a change
  should outlive the instance — while day-to-day onboarding is a click.
- **Credentials are invite-set, never issued.** `identity.json` is the ROSTER —
  who exists, not what they know. A new user is added with NO password; the admin
  panel's **Reset / invite** action mints a single-use link (`/__invite?t=…`,
  7-day expiry) that the maintainer copies and sends manually. Opening it lets the
  user choose their own password. Passwords live only as PBKDF2 hashes in KV
  (`users:secrets`) — the operator never sets, reads, or can recover one; "reset"
  just revokes the old hash and mints a fresh invite. The one account that cannot
  be invited is the **first admin** of a new instance; seed that one with a
  `passHash` (`hashPassword` in the worker generates it). Password verification
  accepts `pbkdf2$…` strings and nothing else, so a **plaintext** value in the
  file is worse than useless: it resolves as that user's secret, which makes the
  account read as active rather than pending, while no password on earth verifies
  against it.
  Account states: **pending** (on the roster, no hash → can't log in yet),
  **accepted** (has set a password), **active** (accepted + recently seen).
  Resetting or changing a password signs that user out (the session changes, so
  their cookie stops matching) and revokes every publish token they minted.

  ⚠️ **A reset writes a TOMBSTONE, not a deletion**, and the difference is the
  whole of the guarantee: a key that is present holding `null` reads as "no
  secret", where an ABSENT key falls back to whatever `passHash` the roster seeded.
  Tidying a tombstone away would put a reset password straight back in service.
- **Photos are self-serve, and the file does NOT win.** Anyone signed in sets
  their own from the profile menu (Add / Change / Remove photo): the browser
  square-crops and downscales the file to ~192px, then `POST /__me/avatar` stores
  it in KV — the image under `avatar:<hash>`, a one-line pointer per person in
  `users:avatars` — and it serves ungated at `/__avatar/u/<hash>` so presence
  chips and contributor faces work on public pages. An `avatar` data-URI in
  `identity.json` is a **seed**: it shows until that person sets their own, and
  it comes back if they remove it. This is the one field where the runtime
  overlay beats the config file, deliberately — a person's face is theirs.
  A photo kept in `identity.json` keeps working as a seed, and can be dropped
  once that person has set their own.
  Admins cannot set someone else's photo (there is no email parameter on the
  route) — removing a user clears theirs.
- Publishing does not need the identity file: `publish.mjs` fetches sanitized
  contributor profiles from the live worker (`/__publish/_instance/profiles`)
  when no identity file is around, so bare-clone publishes keep the faces.

## ⏳ Where this is going, and what is already true

A workspace is becoming the only tier, and identity is splitting in two — a
**credential is account-level** (one address, one password, several workspaces)
and **membership is workspace-level**. That is not cosmetic: an admin who could
reset a shared credential would silently become an admin of their colleague's
unrelated workspace, so a workspace's own store holds no password and no hash of
one, by construction rather than by care.

What is already true, and what a doc reader should not be surprised by:

- **A publish token expires.** Thirty days by default, set per instance. It used
  to last forever. Where the instance offers device pairing, a missing or expired
  token pairs itself inside the publish (`augur connect`: a link and a code for a
  signed-in browser); see [publishing.md](./publishing.md) for the refusals and
  what each one does.
- **A viewer cannot hold one at all**, and a demotion invalidates the tokens the
  account already minted rather than leaving old privilege alive in a credential.
- **Removal is not erasure.** Removing somebody revokes their access and leaves
  their name on the comments they wrote, deliberately: the thread is a record
  other people are part of. Erasure is a separate, explicit act that redacts
  authorship and keeps every message body and every reply intact.
- **The self-hosted single-instance shape above is not going away.** `identity.json`
  plus an admin-issued invite is how an instance with no account service works, and
  it stays the recovery path for one — that is the case a hosted platform's
  account-level credential does not cover.
