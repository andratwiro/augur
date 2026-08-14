# Users, login, avatars

The engine has per-user accounts (login by email + password). The engine repo
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
  "role": "admin",                 // "admin" or omit for a regular user
  "passHash": "pbkdf2$…",          // FIRST ADMIN ONLY — everyone else is invited
  "initials": "PN",                // presence chip fallback
  "color": "#7A5AF8",              // presence chip color
  "avatar": "data:image/webp;base64,…"  // optional SEED photo; served at /__avatar/<key>
}
```

- **The panel can add and remove people without a commit.** The Admin page lists
  everyone as a table (name + email, role, last active) with an **Invite** action
  and, on clicking a row, **Reset password** / **Remove user**. Invite and remove
  write a runtime overlay in KV (`users:roster`) on top of the file: an address the
  file names always wins over an overlay entry of the same address, and a removal
  hides it from both. So `identity.json` stays the durable record — edit it when a
  change should outlive the instance — while day-to-day onboarding is a click.
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
  their cookie stops matching).
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

## Optional AI endpoint

`/__ai/summarize` is a public, open worker endpoint that summarizes an uploaded
document. It needs the builder prompts + output schema (from the deploy config).
The engine carries **no Anthropic key of its own** — a public instance never
spends the operator's account. The key comes from the caller: either a local
`AI_CLI_URL` bridge (offline mode) or an `x-anthropic-key` request header the
caller's own agent supplies (their own key, their own spend). Missing the
builder config → **501**; no backend/key → **503**. In either case the
prototypes that use it fall back to their local heuristic.
