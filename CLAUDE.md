# Augur — the engine (conventions)

**Augur** is a build + deploy platform for prototyping sites. This repo is the ENGINE
only: `build.js`, the overlay worker (`src/_worker.js`), the comment/canvas layers, and
the platform scripts. It carries **no secrets, no user list, no product content** — a
raw clone builds an empty, open-gated site. Everything deployment-specific lives in a
separate private **deploy shell** repo (name yours anything), which pins this engine
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
(~1 min). **Space content does NOT ship on push, and cannot** — spaces publish via
`augur publish` (seconds, atomic; token from `augur login`).

**One source of content, structurally.** A shell builds with `GV_ENGINE_ONLY=1`:
space discovery is skipped, no space is on disk, and the manifest writer THROWS if
the build emitted anything that isn't engine chrome (`ENGINE_CHROME` in `build.js`).
So a redeploy cannot overwrite a publish however stale its checkout — not by
convention, by construction. Shells therefore mount no space submodules at all;
they keep a `spaces` roster in `deploy.config.json` for repo-side automation.
Four files used to break this rule while looking like chrome — the composition
graph, the space icon, and the two canvas aggregates — and CI republished them
from pinned trees on every push. The first two now belong to the default space;
the aggregates are no longer files (see below).

Deploy verification is the public **`/_build.json`** stamp:
`{builtAt, engine:{…}, spaces:{<id>:{sha, dirty?, version, publishedAt, publishedBy}}}`.
It means one thing — the last thing published. `augur status` puts it next to your
clones and `origin/main`; the admin panel renders the same table. **`dirty` is the
one to watch**: a publish from an uncommitted tree serves bytes held in no
repository, so it is the only state that cannot be reproduced from git.

**Cross-space aggregates are synthesized, never shipped.** `/__canvas/catalog.json`
(the insert picker) and `/__canvas/tracks.json` span every space, so no single
publisher can write them — one space publishing would blank the others. Each space
carries its slice in its routing fragment and the worker merges them
(`canvasAggregate`). Adding a site-wide aggregate means adding a fragment field,
never a file.

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
`/__publish/_instance/config`). Reads mirror the writes for backup —
`GET /__publish/<space>/{manifest,versions,version/<n>,blob/<h>}`, same bearer auth.
Routing then derives from the LIVE manifests — `routing.json` is a Pages-mode
artifact only. Without the flag/binding, serving is Pages `ASSETS`, byte-identical
to the pre-bundle behavior.

**Durability.** The store is the only copy of live content, and R2 has no
point-in-time restore. In-store: manifest versions are never pruned and blobs are
never garbage-collected, so `rollback` reaches any past publish. Off-Cloudflare:
`augur export --out <dir> [--history]` walks the read endpoints with a publish
token (no account credentials) into an incremental, content-addressed directory;
`augur restore <dir>` puts it back as a normal publish, preserving `source`
provenance and refusing to bury newer live content without `--force`. Walkthrough:
`docs/2026-08-09-bundle-store-recovery.md`.

**Shipping a change** — `augur ship` is the default and what agents should run:
commit (everything, untracked included) → publish (the live URL, in seconds) →
push (retried). That order is deliberate: the commit makes losing work
impossible, and the publish must not wait on the network. A rejected push
reconciles automatically — different prototypes merge silently, a genuine
same-prototype conflict keeps THEIR version at the real path and forks yours to
`<name>-conflict-<who>` with a note, because prototype HTML must never be
textually merged. Conflicts outside a prototype folder abort the merge for a
human.

**Local commands** (`augur <cmd>` via the bin entry, or `node scripts/<cmd>.mjs`):
`augur dev` (standalone shell — single space folder, dev identity fallback) ·
`npm run offline` (god-mode multi-space) · `npm run deploy` (build + direct upload;
`--check`, `--preview`) · `augur ship [-m msg] [--no-push]` (the default path) ·
`augur publish [--space <id>|--all] [--dry-run]`
(publish only; `AUGUR_TOKEN` + `AUGUR_ORIGIN`) · `augur status`
(live vs clones vs `origin/main`; exit 1 on drift) · `augur export --out <dir>` /
`augur restore <dir>` (store backup).

Env reference: `GV_SPACES_ROOT` (spaces location) · `GV_ENGINE_ONLY` (=1: chrome
only, no space discovery — what a shell's CI runs) · `GV_ONLY_SPACE` (build one
space) · `GV_IDENTITY_PATH` (user list) · `GV_DEPLOY_CONFIG_PATH` (deploy config) ·
`OFFLINE_PORT` (offline preview).
Runtime worker env (per-instance Cloudflare project settings, not build-time):
`DELETE_DISPATCH_URL` + `DELETE_DISPATCH_TOKEN` — the webhook the admin-only
`/__delete` route forwards to (a `prototype-delete` repository_dispatch on the deploy
shell, whose workflow `git rm`s the folder in the space repo; the redeploy that follows
removes it live). Unset → the route answers 501 and the "Delete forever" menu item
reports deletion unconfigured. The local
deploy scripts read `.env.deploy` for the rest (`PAGES_PROJECT`, `REALTIME_CONFIG`, the
Cloudflare creds) — see `.env.deploy.example`. **No account id, project, worker name or
shell repo name is hardcoded in this repo's code or scripts — they resolve the instance
through `scripts/lib/instance.mjs` or fail loudly (docs name example repos
illustratively).**

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

## Worker gate rules (list public overlay assets in `isPublicPath()`)

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
  Engine gaps get fixed HERE on `main` (generic, zero product words); every instance
  takes them by pin bump (the reference instance automatically, others via their
  shell's `engine-bump.yml`). Instance values live in the shell's `deploy.config.json`,
  space values in `space.json`. Outside contributors go through PRs (CONTRIBUTING.md) —
  fork to PR, not to deploy; maintainer review holds PRs to the same bar: generic,
  config-driven, minimal-instance-safe.
- The canvas layer is documented in `CANVAS.md`; the pet layer in `pitis/README.md`.

## Authentication

Invite-only. `identity.json` is a roster of **who exists**, not what they know — email,
name, initials, colour and role. Passwords live in KV as PBKDF2 hashes under
`users:secrets`; invite tokens under `users:invites`.

- Admins **cannot set or read passwords.** Reset clears a user's hash and mints a
  single-use invite link, in one action — there is never a live password alongside a
  pending invite.
- **⚠️ Reset writes a tombstone, never a deletion.** The reset handler sets
  `ov[u.email] = null` — a key that is *present* holding `null` — rather than deleting
  it. `effectiveSecret` falls back to the roster's `pass` field only when the key is
  *absent*, and changing the `null` to a `delete` reopens that exact fallback — every
  roster user has a `users:secrets` entry (a hash if redeemed, a tombstone if reset), so
  nothing today should ever hit that fallback, but "tidying" a tombstone into an absent
  key would put the reset password right back in service.
- **⚠️ No effective secret ⇒ no session.** `identify()` refuses any user whose
  `effectiveSecret` is empty (pending invite, or just reset), *before* deriving the
  session token. `userToken()`'s own no-`SESSION_SECRET` fallback degrades to a publicly
  computable `SHA-256("gv:<email>:")` when there is no secret, so without this guard
  anyone who knows an email could forge a cookie for that account — including a reset
  admin, which hands over the admin API and admin-only spaces. **This must survive any
  future refactor.** It signs no legitimate user out: the two cookie issuers, `/__auth`
  and `invitePost`, both establish a truthy secret before issuing one.
  (`/__publish/_login/token` runs the same credential check but mints a publish token,
  not a session.)
- **⚠️ `identify()` resolves the effective secret ONCE and passes it to the token
  derivation.** Re-resolving inside `userToken` is not atomic with the guard above: a
  truthy first read passes the guard while a later read returns `""`, and the
  derivation then collapses to the publicly computable `tokenFor("<email>:")` —
  reopening exactly the forgery the guard exists to stop. The `resolved` parameter on
  `userToken` is optional; every other caller resolves its own.
- **⚠️ `effectiveSecret` fails closed on a KV error.** No KV binding at all (offline and
  raw engine builds) falls back to the roster, as it must. But if KV *is* bound and the
  read or the JSON parse throws — or the stored value is not a plain object (an array
  passes `typeof x === "object"`, hence the explicit `Array.isArray` rejection) — the
  answer is `""`, never the roster. Restoring a blanket `catch` that falls through would
  make every tombstone evaporate at once on one transient KV blip and put every reset
  password back in service.
  - **⛔ Do NOT unbind the `COMMENTS` KV namespace to recover from a KV outage.** The
    fail-closed trade is deliberate and it has no in-app escape hatch: while KV is down
    nobody — admins included — can log in, and there is no recovery path in the product.
    The one thing a locked-out operator would naturally reach for is unbinding KV, and
    that does not fail closed: "no binding at all" is the *offline build* case, which
    falls straight through to the roster's `pass` field. Wait the outage out, or fix the
    binding — never remove it.
- Sessions are HMACs keyed on the runtime `SESSION_SECRET`, bound to the user's effective
  secret, so changing or clearing a password invalidates that user's cookies for free.
  This holds only when `SESSION_SECRET` is actually set on the project — `userToken()`
  falls back to an unkeyed SHA-256 when it's absent, so the secret must be configured for
  sessions to be HMAC-backed at all.
- **The roster has two layers.** `identity.json` (injected at build time) names who the
  deploy shell knows about; KV `users:roster` (`{add:{…}, remove:[…]}`) records who the
  admin panel has invited or removed since, so onboarding a teammate is a click rather
  than a commit + redeploy. `mergeRoster` applies the overlay: the config file wins over
  an `add` of the same address, and `remove` hides an address from both. A person the
  config names is still best removed from the file eventually — the overlay entry is a
  live decision, not a record.
- **⚠️ The overlay is a convenience; the tombstone is the security boundary.** A failed
  KV read leaves the roster as the config list, which would put a removed CONFIG user
  back in it — so removal ALSO writes the `users:secrets` tombstone, and that read fails
  closed. Never reduce removal to the list alone.

See `docs/superpowers/specs/2026-08-08-invite-only-auth-design.md` for the original
design record.
