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
`./spaces`). **One instance serves exactly one space, at the site root.** The
path-mount tier — several spaces in one deploy, the default at `/` and the rest under
`/<id>/` — is RETIRED (Phase A). A build still discovers siblings so a local workspace
can preview any of them, but nothing routes to a non-default space: name the one you
mean with `GV_SPACES_ROOT` or `GV_ONLY_SPACE`. Serving several workspaces from one
deploy is Phase B's job, resolved by Host, not by path.

**Which workspace a request is for is decided in exactly one place**:
`resolveTenant(request, env)` in `src/_worker.js`, called once at the top of `fetch()`
before any config is read. Today it answers the `tenantId` the build stamped into
`instance.json`; Host-based resolution replaces that body and nothing else.
`scripts/one-tenant-resolver.mjs` runs in `check` and fails the deploy if a second call
site appears or the one call drifts below the config load — a second caller returns the
same answer while there is one workspace, so nothing else would notice.

`space.json` contract: **single source = [agents/space-json.md](agents/space-json.md)**
(all fields incl. `siteOrigin` + `mcpAllowlists`, with semantics). Load-bearing
highlights: `id` is the only required field (mount name + URL prefix; repo name is a
free label); **`adminOnly` no longer seals anything** — it only ever sealed a
NON-default mount, and there are no non-default mounts, so `RESTRICTED_BASES` is
permanently empty and the field is still parsed but inert (who may see a workspace is a
membership question, not a path one); the UI skill is auto-detected from
`skills/<prefix>-ui/` and every
canonical asset name derives from that prefix (`designSystem.skill` overrides). If you
change what `discoverSpaces()` parses, update agents/space-json.md in the same commit.

**Publishing is whitelist-driven (critical guardrail).** Only the contents of
`prototypes/` folders, the gallery tiers (`base/ components/ pages/ patterns/`,
rebuilt), the `playground/`, and the skill assets the skill declares in its
`skill.json` ship (see [agents/ui-skill.md](agents/ui-skill.md); skills without
a manifest get a fixed default inventory). `research.md`, `context.md`, anything
outside `prototypes/` — internal, never copied to `/dist`.

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
The assertion is what makes this hold: anything space-derived that merely LOOKS
like chrome (a composition graph, a space icon, a cross-space aggregate) fails
the build rather than shipping. Chrome is what `ENGINE_CHROME` names, and
nothing else.

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
`rtOrigin`, `sentinels`, plus a `tenantId` — the deploy config's if it sets one,
otherwise the id of the space mounted at the root) and
`dist/__config/routing.json` (public prefixes,
version map, restricted bases, space list, the mcp host + path allowlist union spaces
declare via `space.json "mcpAllowlists"` — the engine's own path floor is the three
paths the MCP/OAuth protocol speaks, and no platform's API endpoint is named in it —
except ⏳ `LEGACY_MCP_PATH_FLOOR`, the pre-declaration floor handed to a routing fragment
that carries no `mcpPaths` KEY at all, since such a manifest was published before
declarations existed and cannot grow one by taking a newer engine; `mcpPaths: []` is a
real declaration meaning none and gets nothing, and one publish by a current clone
retires the shim for that workspace).
The worker fills these via `loadConfig()` (~1.5s
per-isolate cache) and seals `/__config/*` from external requests. Build.js also
emits `dist/__manifests/<id>.json` per space (+ pseudo-space `_engine` for shared
chrome): `{files: {path → {sha256, mime, size}}}` + the space's routing fragment.

**Direct publish (the bundle store).** With `GV_ASSET_SOURCE=r2` + a `BUNDLES` R2
binding, the worker serves those manifests from content-addressed R2 blobs and takes
publishes over `/__publish/<space>/{check,blob,commit,rollback}` (per-space bearer
tokens, minted at `/__admin/tokens`; instance config pushed via
`/__publish/_instance/config`). Reads mirror the writes for backup —
`GET /__publish/<space>/{manifest,versions,version/<n>,blob/<h>}`, same bearer auth.
Routing then derives from the LIVE manifests, so `routing.json` is read only when
serving from `ASSETS`. **A deployed instance runs in bundle mode**: its CI ships
chrome and worker code, never content, so `ASSETS` alone is a site with nothing in
it. Assets mode is the local path (`augur dev`, `npm run offline`, a raw engine
build), not a fallback a live instance can drop back to. Undoing a bad publish is
`rollback` against the store's version history, not a serving-mode switch.

**A publish may not silently unpublish.** The tree that publishes defines the
whole space, so a checkout missing a folder REMOVES its public URLs for everyone —
invisibly, because the gate answers a now-unknown path with the login page and
"gone" reads as "locked" (it took an opportunity's links, and the embeds pasted
into third-party sites, down for an hour). `commit` therefore refuses a manifest
whose `routing.publicPrefixes` drops anything the live one has, unless the body
carries `allowUnpublish` (`augur publish|ship --allow-unpublish`) — the
INSTANCE_SENTINELS rule widened from a path list to the whole public surface.
Star-scope tokens included: a maintainer's stale tree removes as much as anyone's.

**A publish may not silently REVERT either — and since protocol 5 that is
structural, not policed.** A publish COMPOSES on top of the live manifest
(`publish.mjs` + `scripts/lib/publish-{compose,evidence,conflict}.mjs`): per
authored unit (a unit = a prototype/playground folder = a `publicPrefixes`
entry), the publisher's build lands only when live's recorded unit source
(`routing.unitSources`, falling back to the space-level `source`) is a clean
commit in their history — a per-unit fast-forward, like `git push` — or when git
evidences a local edit (porcelain, or commits since a provable ancestor base).
Everything else keeps live's bytes verbatim, so a stale checkout cannot revert,
unpublish, adopt, or fork what it never edited, by construction. The working
tree is NEVER written to: a genuinely concurrent same-unit edit keeps theirs at
the URL and publishes mine at `<name>-conflict-<who>` + CONFLICT.md in the
MANIFEST only. Shared skill files are per-file: mine ships with evidence, theirs
is never implicitly dropped. Removals require the deletion committed AND
`--allow-unpublish`; `--takeover` ships the whole tree (repo surgery only).
Hard rule: tree folders named `*-conflict-*` never publish implicitly, and
ship's auto-commit leaves untracked ones unstaged — fork litter cannot re-enter
live or ride into a person's commit (the 2026-08-19/22 laundering + cascade
class, closed). Generated pages (galleries, indexes) stay last-writer-wins.
`stripVolatileHead` remains the tolerant comparator (og/twitter meta, marker
chrome, title emoji) so a contested verdict is only reached on real content.
Server side, `baseVersion` CAS (`stale-base` 409) still guards the race between
check and commit, and the one-round-trip fast path rides only when live is
exactly the publisher's own last publish. `_engine` is exempt (no authored
units). `ship` still fetch+merges before publishing, so the common stale case
ships the union without composition ever holding anything back.

**Durability.** The store is the only copy of live content, and R2 has no
point-in-time restore. In-store: manifest versions are never pruned and blobs are
never garbage-collected, so `rollback` reaches any past publish. Off-Cloudflare:
`augur export --out <dir> [--history]` walks the read endpoints with a publish
token (no account credentials) into an incremental, content-addressed directory;
`augur restore <dir>` puts it back as a normal publish, preserving `source`
provenance and refusing to bury newer live content without `--force`. Walkthrough:
`docs/store-recovery.md`.

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
`augur init [--id] [--name] [--origin] [--project] [--prototype]` (scaffold a new
space in the current dir: `space.json` + one starter prototype at
`<project>/prototypes/<name>/`, the nesting `discoverSpaces()` actually looks in;
refuses to overwrite) ·
`augur dev` (standalone shell — single space folder, dev identity fallback) ·
`npm run offline` (multi-space workspace) · `augur login` (trade web credentials for a
publish token, once per instance) · `npm run deploy` (build + direct upload to Pages;
`--check`, `--preview`) — in bundle mode this ships CHROME, so reserve it for
engine/worker verification; content goes out with `ship`/`publish` ·
`augur ship [-m msg] [--no-push]` (the default path) ·
`augur publish [--space <id>|--all] [--dry-run] [--allow-unpublish]`
(publish only; `AUGUR_TOKEN` + `AUGUR_ORIGIN`) · `augur status`
(live vs clones vs `origin/main`; exit 1 on drift) · `augur export --out <dir>` /
`augur restore <dir>` (store backup).

Env reference: `GV_SPACES_ROOT` (spaces location) · `GV_ENGINE_ONLY` (=1: chrome
only, no space discovery — what a shell's CI runs) · `GV_ONLY_SPACE` (build one
space) · `GV_IDENTITY_PATH` (user list) · `GV_DEPLOY_CONFIG_PATH` (deploy config) ·
`OFFLINE_PORT` (offline preview).
Runtime worker env (per-instance Cloudflare project settings, not build-time):
`DELETE_DISPATCH_URL` + `DELETE_DISPATCH_TOKEN` — the shell-dispatch channel
(`shellDispatch`): the one way a worker action changes a REPO rather than only live
state. Two event types ride it: `prototype-delete` (the admin-only `/__delete` route;
the shell workflow `git rm`s the folder in the space repo) and `roster-update` (Admin
invite/remove; the shell's `roster-update.yml` — see `templates/shell/` — commits the
person to `identity.json`, so the file stays the one durable roster record). Unset →
`/__delete` answers 501 and reports deletion unconfigured; invites still work but
answer `fileSync: "unconfigured"` and the person lives in the KV overlay only.
`MAIL_PROVIDER` + `MAIL_FROM` + `MAIL_API_KEY` (+ `MAIL_REGION`/`MAIL_PROJECT_ID`, or
`MAIL_API_URL`) — the mail transport (`src/mail.mjs`, see Email below). The local
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
everyone); rename `.env.deploy` for a local-only sandbox (logs `KV: local`). Canvas
realtime follows the same split: live KV **plus `RT_SHARED_SECRET` in `.env.deploy`**
joins the instance's real rooms (without the secret the realtime worker refuses the
join and boards silently run solo — saves still land in prod KV); sandbox mode
disables realtime outright (`GV_RT_DISABLE`), so sandbox boards never broadcast into
shared rooms. The wrangler child is supervised — a workerd crash respawns it (loop
cutoff in `scripts/lib/offline-respawn.mjs`) instead of killing the server. Only one
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
- **No workspace's private vocabulary in the engine.** `check` runs two guards, and they
  work differently on purpose. The word scan is a denylist of instance/product/personal
  words — it catches a name someone already wrote down. `scripts/no-foreign-vocabulary.mjs`
  catches the one nobody has: it names nothing, and fails on SHAPES only a foreign
  vocabulary has — a colour stored as a quoted value under a proper noun (a brand table),
  a regex anchored on a literal `--<prefix>-` (the token vocabulary is the skill's
  `cssPrefixes`, carried out on the graph — interpolate it), and a `<meta name>` the
  engine reads that is neither standard web vocabulary nor `augur-*`. Its own header
  states the two gaps it does NOT cover (a workspace's slug prefixes, and a private word
  smuggled into a general-vocabulary list) — both are the same shape as the engine's own
  names, so they are review questions, not lint ones. Read that before assuming cover.
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
  it. `effectiveSecret` falls back to the roster's seeded `passHash` only when the key is
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
    falls straight through to whatever the roster seeds. Wait the outage out, or fix the
    binding — never remove it.
- **⚠️ The session cookie is `__Host-augur_user`, and the prefix is load-bearing.** `__Host-`
  is a name prefix the BROWSER enforces: it stores a cookie so named only when the cookie
  is `Secure`, has `Path=/`, and carries **no `Domain` attribute**. That last rule is the
  point — several workspaces share one apex host, so a page published on one of them can
  otherwise set `Domain=.<apex>` and have the browser send that cookie to a sibling
  workspace too. It could never forge a session (the token HMACs on `SESSION_SECRET` plus
  the user's effective secret), but it could *shadow* the real one and break login next
  door. Issue this cookie without all three attributes and the browser silently drops
  every session the deployment hands out, so never add a `Domain`, never narrow the
  `Path`, never drop `Secure`. One workspace host therefore cannot share a session with
  another by cookie, on purpose; spanning them is a central sign-in minting a separate
  session per host, never a weaker cookie.
  - **⏳ Migration window — the read set is THREE names, the write set is one.**
    `LEGACY_USER_COOKIES` in `src/_worker.js` lists the two names this cookie used to be
    issued under (`__Host-gv_user`, then the pre-prefix `gv_user`). Both are READ by
    `identify()` — always AFTER `USER_COOKIE`, so a stale name can never shadow a live
    session — and CLEARED by `/__logout`, and neither is ever ISSUED, so each drains away
    within `MAX_AGE` (a week) once the last instance issuing it has moved off it.
    **Adding a name to the read set is free; removing one signs people out**, so an entry
    goes only after checking what a live instance actually SETS — an instance whose engine
    pin is frozen can still be minting the oldest name, and its week has not started. The
    constant's comment carries the per-entry condition; `test/host-cookie-prefix.test.mjs`
    covers all three, and its ⏳ cases retire name by name with the list.
- Sessions are HMACs keyed on the runtime `SESSION_SECRET`, bound to the user's effective
  secret, so changing or clearing a password invalidates that user's cookies for free.
  This holds only when `SESSION_SECRET` is actually set on the project — `userToken()`
  falls back to an unkeyed SHA-256 when it's absent, so the secret must be configured for
  sessions to be HMAC-backed at all.
- **Profile photos are the one overlay that beats the config file.** A photo set from
  the profile menu (`POST /__me/avatar`, signed-in users only, always their own row)
  lands in KV — the image under `avatar:<hash>`, a pointer per person in
  `users:avatars` — and `applyAvatars()` stamps it over whatever `identity.json`
  carried. An `avatar` data-URI in the config is therefore a SEED: shown until that
  person changes it, restored if they remove it. That inversion is deliberate (a face
  is the person's, not the deployment's) and it's what lets an instance with baked
  photos take the feature by pin bump with nothing to migrate. `applyAvatars` copies
  the user objects rather than stamping `avatar` onto them — mutating in place would
  outlive the overlay and make removal un-undoable. Uploads are validated against
  their magic bytes, not their declared mime, because `/__avatar/` is ungated and
  echoes that mime back.
- **The roster has two layers, and the second drains into the first.** `identity.json`
  (injected at build time) is the durable record; KV `users:roster`
  (`{add:{…}, remove:[…]}`) makes an Admin-panel invite/removal live INSTANTLY, without
  waiting on a commit. The overlay is transitional by design, not a second record: the
  invite/remove handlers fire a `roster-update` shell dispatch so a workflow commits
  the same change to `identity.json`, and when the deploy that follows pushes the new
  config back (`/__publish/_instance/config`), the worker drains every overlay entry
  the config now supersedes — an `add` the file names, a `remove` for someone the file
  no longer names. Left un-drained, the two records diverge visibly: builds bake
  people-derived state into every generated page, an identity-file build and a
  live-roster build disagree about who exists, and each publish flips ~hundreds of
  gallery pages between the two renderings. `mergeRoster` precedence is unchanged
  (config wins over `add`; `remove` hides both), and none of this touches
  `users:secrets` — the tombstone stays the security boundary.
- **⚠️ The overlay is a convenience; the tombstone is the security boundary.** A failed
  KV read leaves the roster as the config list, which would put a removed CONFIG user
  back in it — so removal ALSO writes the `users:secrets` tombstone, and that read fails
  closed. Never reduce removal to the list alone.

## Email

`src/mail.mjs` — `sendMail(env, {to, template, vars})` over a provider's **HTTP API**
(a Worker has no outbound sockets, so SMTP is not an option). Three templates:
`signup-verify`, `roster-invite`, `credential-reset`, each rendering text and HTML.

**Mail is an addition to the link, never a replacement for it, and that is the whole
design.** An invite has always been a single-use link the Admin panel hands back for a
human to send. It still is: `sendMail` returns a VERDICT and never throws, the admin API
returns `url` in every case and puts the verdict beside it as `mail`, and the panel shows
the link whatever happened. The four ways it does not send are all reported, never
swallowed — `unconfigured` (no provider; the panel reads exactly as it did before mail
existed), `misconfigured` (names the env var that is missing), `rate-limited`, `failed`
(the provider's own words). A provider outage costs the convenience of the send and
nothing else.

- **A driver is a shape of HTTP request, selected by `MAIL_PROVIDER`.** Endpoint, key,
  sending address and region are runtime env, so no deployment's domain, account or key
  is in the engine. `http` — a bearer-authenticated JSON POST to a URL you name — is the
  escape hatch, so an unsupported provider is a small relay rather than a fork.
- **The two templates a stranger can trigger are capped per recipient address**
  (`MAIL_RATE`), because a reset or signup form otherwise aims a mail cannon at whoever
  the caller types. The cap is on the MAIL, not on the action: a capped call still
  returns a live link, so nothing an admin was doing is refused. `roster-invite` is
  uncapped on purpose — only an authenticated admin reaches it, and a cap there blocks
  re-sending a lost invite while protecting nobody.
- Send from a domain the operator controls the DNS for, and **not** the domain
  prototypes are published on: published content is arbitrary user JavaScript, and the
  first phishing page harms that domain's sending reputation. SPF, DKIM and DMARC have
  to pass or the mail is spam, which is indistinguishable from an invite that never came.
- The provider call goes through an injectable `fetch`, so the suite drives every verdict
  — including a dead provider — with no network and no account. **Never send live mail
  from the test suite.**
