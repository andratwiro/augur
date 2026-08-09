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
  "pass": "<seed password>",       // the SEED only — see below
  "initials": "PN",                // presence chip fallback
  "color": "#7A5AF8",              // presence chip color
  "avatar": "data:image/webp;base64,…"  // optional; served at /__avatar/<key>
}
```

- **KV overrides beat seeds.** Passwords are editable at runtime from the Admin
  panel (profile dropdown → Admin settings, admin-only), stored in KV — so the
  `pass` in the file is only what applies until someone changes it live.
  Changing a password signs that user out (their cookie stops matching).
- Avatars are data-URIs in the file, served ungated at `/__avatar/<key>` so
  presence chips and contributor faces work on public pages.
- Publishing does not need the identity file: `publish.mjs` fetches sanitized
  contributor profiles from the live worker (`/__publish/_instance/profiles`)
  when no identity file is around, so bare-clone publishes keep the faces.

## Optional AI endpoint

`/__ai/summarize` is a public worker endpoint that summarizes an uploaded
document. It needs two pieces of instance config: the builder prompts + output
schema (from the deploy config) and an `ANTHROPIC_API_KEY` worker env var.
Missing the builder config → **501**; missing the key → **503**. In either case
features that use it hide themselves and fall back to their heuristic.
