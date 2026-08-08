# Augur — the engine (conventions)

**Augur** is a build + deploy platform for prototyping sites. This repo is the ENGINE
only: `build.js`, the overlay worker (`src/_worker.js`), the comment/canvas layers, and
the platform scripts. It carries **no secrets, no user list, no product content** — a
raw clone builds an empty, open-gated site. Everything deployment-specific lives in a
separate private **deploy shell** repo (here: `augur-deploy`), which pins this engine
plus one repo per space and holds `identity.json`, `deploy.config.json`, the CI
workflows and every secret.

```
augur/
├── build.js            # composes spaces → /dist (landing, galleries, tokens, worker stamping)
├── src/_worker.js      # Cloudflare worker: login gate, comments/pins/status KV, canvas, MCP proxy
├── src/canvas/         # infinite-canvas engine (see CANVAS.md)
├── src/review/         # comment/annotation overlay
├── pitis/              # optional cursor-companion build addon (site builds identically without it)
├── scripts/            # offline preview, poster shots, og cards, review CLI
├── agents/             # engine contract docs for SPACE-collaborator agents (publish,
│                       #   review feedback, prototype contract, space.json, identity)
├── realtime/           # canvas multiplayer worker (Durable Objects; deployed separately)
└── brand/              # the engine's own marks + fonts
```

## The spaces model

A **space** is a separate git repo: a self-contained design system + prototypes bundle.
`build.js` enumerates every dir with a `space.json` under `GV_SPACES_ROOT` (default:
`./spaces`). The default space builds at the site root; every other space under
`/<id>/`.

`space.json` contract: **single source = [agents/space-json.md](agents/space-json.md)**
(all fields incl. `siteOrigin` + `mcpAllowlists`, with semantics). Load-bearing
highlights: `id` is the only required field (mount name + URL prefix; repo name is a
free label); `adminOnly: true` seals the space behind the admin login (worker
`RESTRICTED_BASES`); the UI skill is auto-detected from `skills/<prefix>-ui/` and every
canonical asset name derives from that prefix (`designSystem.skill` overrides). If you
change what `discoverSpaces()` parses, update agents/space-json.md in the same commit.

**Publishing is whitelist-driven (critical guardrail).** Only the contents of
`prototypes/` folders, the gallery tiers (`base/ components/ pages/ patterns/`,
rebuilt), the `playground/`, and the whitelisted skill assets ship. `research.md`,
`context.md`, anything outside `prototypes/` — internal, never copied to `/dist`.

## Deploys — this repo ships nothing

**Engine pushes auto-deploy; space content publishes directly.** A push here fires
`.github/workflows/deploy-trigger.yml` (an `engine-updated` dispatch); the shell
moves the engine pin and its `deploy.yml` ships worker code + engine chrome
(~1 min). **Space content does NOT ship on push** — spaces publish via
`augur publish` (seconds, atomic; token from `augur login`). Deploy verification
is the public **`/_build.json`** stamp: `{builtAt, spaces:{<id>:{sha, dirty?}}}` —
compare a space's sha to `git rev-parse HEAD`.

**Runtime config (no build-time worker stamping).** `src/_worker.js` ships VERBATIM;
build.js emits `dist/__config/instance.json` (users from `GV_IDENTITY_PATH`; from
`GV_DEPLOY_CONFIG_PATH`: `mcpHostSuffixes`, `mcpHostAllowlistUrl`, `vanityRedirects`,
`builder`, `rtOrigin`, `sentinels`) and `dist/__config/routing.json` (public prefixes,
version map, restricted bases, space list, the mcp allowlist union spaces declare via
`space.json "mcpAllowlists"`). The worker fills these via `loadConfig()` (~1.5s
per-isolate cache) and seals `/__config/*` from external requests. Build.js also
emits `dist/__manifests/<id>.json` per space (+ pseudo-space `_engine` for shared
chrome): `{files: {path → {sha256, mime, size}}}` + the space's routing fragment.

**Direct publish (the bundle store).** With `GV_ASSET_SOURCE=r2` + a `BUNDLES` R2
binding, the worker serves those manifests from content-addressed R2 blobs and takes
publishes over `/__publish/<space>/{check,blob,commit,rollback}` (per-space bearer
tokens, minted at `/__admin/tokens`; instance config pushed via
`/__publish/_instance/config`). Routing then derives from the LIVE manifests —
`routing.json` is a Pages-mode artifact only. Without the flag/binding, serving is
Pages `ASSETS`, byte-identical to the pre-bundle behavior.

**Local commands** (`augur <cmd>` via the bin entry, or `node scripts/<cmd>.mjs`):
`augur dev` (standalone shell — single space folder, dev identity fallback) ·
`npm run offline` (god-mode multi-space) · `npm run deploy` (build + direct upload;
`--check`, `--preview`) · `augur publish [--space <id>|--all] [--dry-run]`
(incremental per-space publish; `AUGUR_TOKEN` + `AUGUR_ORIGIN`).

Env reference: `GV_SPACES_ROOT` (spaces location) · `GV_IDENTITY_PATH` (user list) ·
`GV_DEPLOY_CONFIG_PATH` (deploy config) · `OFFLINE_PORT` (offline preview).
Runtime worker env (per-instance Cloudflare project settings, not build-time):
`DELETE_DISPATCH_URL` + `DELETE_DISPATCH_TOKEN` — the webhook the admin-only
`/__delete` route forwards to (a `prototype-delete` repository_dispatch on the deploy
shell, whose workflow `git rm`s the folder in the space repo; the redeploy that follows
removes it live). Unset → the route answers 501 and the "Delete forever" menu item
reports deletion unconfigured. The local
deploy scripts read `.env.deploy` for the rest (`PAGES_PROJECT`, `REALTIME_CONFIG`, the
Cloudflare creds) — see `.env.deploy.example`. **No account id, project, worker name or
shell repo name is hardcoded anywhere in this repo; scripts resolve the instance through
`scripts/lib/instance.mjs` or fail loudly.**

## Offline mode (local live preview)

`npm run offline` (`scripts/offline.mjs`) builds `dist`, runs the real worker via
`wrangler pages dev`, and watches every build input with ~1s reload. It points
`GV_SPACES_ROOT` at the PARENT folder and picks out sibling space clones by their
`space.json` — so edits in any sibling clone preview instantly, no commit or pin bump.
It auto-detects a sibling deploy shell's `identity.json` (login gate ON, same as live);
without one the gate is open. **⚠️ If `.env.deploy` holds real KV credentials, the
offline worker reads/writes the PRODUCTION KV** (comments/pins/statuses are live for
everyone); rename `.env.deploy` for a local-only sandbox (logs `KV: local`). Only one
offline server needs to run regardless of how many agents edit.

## Worker gate rules (bit twice — don't get bit again)

Any file the overlay loads from a public page (e.g. `/__review/*`, images embedded in
public prototypes) **must be listed in `isPublicPath()`** in `src/_worker.js`, or the
gate serves the login HTML in place of the asset and an `<img>` fails silently. Avoid
inline `data:` images for overlay UI — serve a real same-origin file.

**Screen contract (SPA prototypes):** the comment overlay scopes to
`<body data-gv-screen>`. Multi-page prototypes need nothing (URL fallback); a prototype
that swaps screens without changing the URL must publish its visible state there, or
comments bleed across screens.

## Conventions

- Commit directly to `main`, small logical units, push often. **Stage only the paths
  you changed — never `git add -A`** (shared checkout, concurrent agents).
- Never commit secrets. `.env*`, `dist/`, `node_modules/` are gitignored.
- `UI_VERSION` in build.js versions the SITE shell (rail, indexes, overlays). Bump it
  only for shell changes, never for edits inside individual prototypes.
- Prototypes are self-contained static HTML (no build step); they live in the space
  repos, not here. Edit spaces in their own clones — the `spaces/` mounts in a deploy
  shell are read-only build mirrors.
- **The engine is a pinned dependency of every instance — never fork-and-patch it.**
  Don't edit engine code from inside a shell checkout (the `engine/` mount there is a
  read-only build mirror), don't vendor build.js or worker snippets into a space or
  shell, don't keep an instance on a private engine fork. Engine gaps get fixed HERE
  on `main` (generic, zero product words), then every instance takes them by pin bump
  — GoVocal automatically, others via their shell's `engine-bump.yml`. Instance values
  live in the shell's `deploy.config.json`; space values in `space.json`. Outside
  contributors go through PRs (CONTRIBUTING.md) — fork to PR, not to deploy — and
  Rob's agents hold PRs to the same bar: generic, config-driven, minimal-instance-safe.
- The canvas layer is documented in `CANVAS.md`; the pet layer in `pitis/README.md`.

## Authentication

Invite-only. `identity.json` is a roster of **who exists**, not what they know — email,
name, initials, colour and role. Passwords live in KV as PBKDF2 hashes under
`users:secrets`; invite tokens under `users:invites`. *During this migration only*, a
roster entry may still carry a legacy plaintext `pass`; it is consulted only when
`users:secrets` has no key for that email, and it is rewritten as a hash on that user's
next successful login.

- Admins **cannot set or read passwords.** Reset clears a user's hash and mints a
  single-use invite link, in one action — there is never a live password alongside a
  pending invite.
- **⚠️ Reset writes a tombstone, never a deletion.** The reset handler sets
  `ov[u.email] = null` — a key that is *present* holding `null` — rather than deleting
  it. `effectiveSecret` falls back to the roster's `pass` field only when the key is
  *absent*; during this migration that roster value is the leaked password being
  revoked. "Tidying" the `null` into a `delete` reopens that exact fallback.
- **⚠️ No effective secret ⇒ no session.** `identify()` refuses any user whose
  `effectiveSecret` is empty (pending invite, or just reset), *before* checking either
  token derivation. Both derivations degrade to a publicly computable
  `SHA-256("gv:<email>:")` when there is no secret, so without this guard anyone who
  knows an email could forge a cookie for that account — including a reset admin, which
  hands over the admin API and admin-only spaces. **This is not a migration path and
  must survive the finish step.** It signs no legitimate user out: the two cookie
  issuers, `/__auth` and `invitePost`, both establish a truthy secret before issuing
  one. (`/__publish/_login/token` runs the same credential check but mints a publish
  token, not a session.)
- **⚠️ `identify()` resolves the effective secret ONCE and passes it to both token
  derivations.** Re-resolving inside `userToken`/`legacyUserToken` is not atomic with
  the guard above: a truthy first read passes the guard while a later read returns `""`,
  and the derivation then collapses to the publicly computable `tokenFor("<email>:")` —
  reopening exactly the forgery the guard exists to stop. The `resolved` parameter on
  both functions is optional; every other caller resolves its own.
- **⚠️ `effectiveSecret` fails closed on a KV error.** No KV binding at all (offline and
  raw engine builds) falls back to the roster, as it must. But if KV *is* bound and the
  read or the JSON parse throws — or the stored value is not a plain object (an array
  passes `typeof x === "object"`, hence the explicit `Array.isArray` rejection) — the
  answer is `""`, never the roster. Restoring a blanket `catch` that falls through would
  make every tombstone evaporate at once on one transient KV blip and put every leaked
  roster password back in service.
  - **⛔ Do NOT unbind the `COMMENTS` KV namespace to recover from a KV outage.** The
    fail-closed trade is deliberate and it has no in-app escape hatch: while KV is down
    nobody — admins included — can log in, and there is no recovery path in the product.
    The one thing a locked-out operator would naturally reach for is unbinding KV, and
    that does not fail closed: "no binding at all" is the *offline build* case, which
    falls straight through to the roster and puts **all nine leaked plaintext passwords
    back in service at once**, site-wide. Wait the outage out, or fix the binding —
    never remove it.
- Sessions are HMACs keyed on the runtime `SESSION_SECRET`, bound to the user's effective
  secret, so changing or clearing a password invalidates that user's cookies for free.
  This holds only when `SESSION_SECRET` is actually set on the project — `userToken()`
  falls back to an unkeyed SHA-256 when it's absent, so the secret must be configured for
  sessions to be HMAC-backed at all.
- Adding or removing a person is still a commit to `identity.json` — the roster is
  injected at build time.

**Two migration paths are temporary.** Both are marked
`// TEMPORARY (migration) — remove in the finish step`:

1. `verifyPassword` accepts a legacy plaintext value, and `upgradeSecretIfLegacy` rewrites
   it as a hash on next login — for a plaintext held in `users:secrets` *and* for one held
   in the roster's `pass` with no `users:secrets` key (which is where every legacy account
   actually sits). A present-but-falsy entry is a tombstone and is never upgraded.
2. `identify` accepts the pre-HMAC session derivation via `legacyUserToken`.

They exist only so migration can proceed user-by-user without a mass lockout. **Leaving
them in place preserves the ability to authenticate against a plaintext value, which is
the defect this design removes.** Delete both — and their tests — once every user has
redeemed an invite. See `docs/superpowers/specs/2026-08-08-invite-only-auth-design.md`.
