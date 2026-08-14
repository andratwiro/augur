# INSTALL — stand up an Augur instance

The complete recipe, start to finish. It is written to be **executed top to bottom by an
agent**: every step is a command with a check, and the handful of things only a person can
do are marked **HUMAN** — stop there, ask, continue.

Budget: about an hour, most of it waiting on DNS and CI.

If you only want to run the engine locally against some spaces, you do not need any of
this — see [README.md](./README.md).

## What you are building

An instance is **three repos and one Cloudflare project**:

```
<shell repo>   private   the deploy shell: engine pin, identity.json, deploy.config.json,
                         CI workflows, every secret. Ships the site's CODE.
<space repo>   private   the content: space.json + <project>/prototypes/**. One repo per
                         space; a design system is optional.
augur          public    this engine. Pinned as a submodule. Deploys nothing itself.

Cloudflare               Pages project + KV namespace + R2 bucket (+ optional realtime worker)
```

Two things move independently, and keeping them straight is the whole model:

| What | Ships by | Takes |
|---|---|---|
| Engine code + shared chrome | push to the shell (or an engine pin bump) | ~1 min, via CI |
| Space content | `augur publish` from a space clone | seconds, no CI |

**Rule zero: pin, don't fork.** Never patch the engine inside a shell or a space, never
run an instance off a private engine fork. A patched instance stops taking upstream
fixes. Engine gaps get fixed upstream (generic, no instance-specific words) and every
instance takes them by pin bump. See [CONTRIBUTING.md](./CONTRIBUTING.md).

**R2 is required.** CI builds the shell with `GV_ENGINE_ONLY=1` — no space is ever on
disk there — so the bundle store is the only path content has to the live site. An
instance without R2 serves chrome and nothing else.

## Step 0 — fill this in

Decide these first and keep them at hand; every later step substitutes from this table.

| Value | Placeholder | Example |
|---|---|---|
| Instance slug | `<instance>` | `acme` |
| Shell repo | `<owner>/<shell>` | `acme-co/augur-deploy-acme` |
| Space repo | `<owner>/<space-repo>` | `acme-co/augur-space-acme` |
| Space id (from its `space.json`) | `<space-id>` | `acme` |
| Pages project | `<pages-project>` | `augur-acme` |
| KV namespace | `<kv-id>` | filled in at step 4 |
| R2 bucket | `<bucket>` | `augur-acme-bundles` |
| Site origin | `<site>` | `https://augur-acme.pages.dev` |
| Site host (origin without the scheme) | `<site-host>` | `augur-acme.pages.dev` |
| Admin email | `<admin-email>` | the first user, `role: "admin"` |

The space id is the mount name and the URL prefix; the repo name is a free label. The
**default** space owns the site root, every other space serves under `/<space-id>/`.

## Step 1 — HUMAN: credentials

Three things an agent cannot obtain. Ask for them all at once.

1. **Cloudflare API token** (dashboard → My Profile → API Tokens → Create). Account-scoped
   permissions: `Cloudflare Pages: Edit`, `Workers KV Storage: Edit`,
   `Workers R2 Storage: Edit`, and `Workers Scripts: Edit` if you want canvas multiplayer.
   Add `Zone → DNS: Edit` on the zone if you want a custom domain automated.
2. **Cloudflare account id** (dashboard sidebar, or the URL after `/accounts/`).
3. **R2 enabled on the account** — a one-time dashboard click (R2 → Enable). The API
   cannot do it and returns error code `10042` until it is done.
4. **A GitHub PAT**, fine-grained, `Contents: Read and write` on the shell repo, and
   `Contents: Read` on every space repo. One token covers every use below.

Export them for the rest of this run:

```bash
export CF_TOKEN=…  CF_ACCOUNT=…  GH_TOKEN=…
export API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT"
```

Check R2 before going further — this is the one gate that bites late:

```bash
curl -s "$API/r2/buckets" -H "Authorization: Bearer $CF_TOKEN" | grep -q '"code":10042' \
  && echo "R2 NOT ENABLED — ask the human to click Enable in the dashboard" || echo "R2 ok"
```

## Step 2 — the local workspace

Clone the three repos **side by side** in a parent folder that is not itself a repo. The
layout is load-bearing: local scripts find the shell by shape (a sibling holding an
`identity.json`), and offline mode picks up every sibling that has a `space.json`.

```
<parent>/                 # not a repo
├── augur/                # this engine (public)
├── <shell>/              # the deploy shell
└── <space-repo>/         # the space — where content is edited
```

```bash
mkdir -p <parent> && cd <parent>
git clone https://github.com/andratwiro/augur.git augur
```

The engine has no runtime dependencies — `login`, `publish`, `build` and `status` run on
a bare clone with plain `node`. `npm install` is only needed for the Playwright-backed
screenshot scripts. The commands below call the scripts by path
(`node <parent>/augur/scripts/<name>.mjs`); `npm link` inside `augur/` gives you the
shorter `augur <cmd>` form if you want it.

Never nest one instance's parent inside another's — offline mode would serve both
instances' spaces at once.

## Step 3 — the space repo

Content lives here, and this is the only repo a collaborator ever needs.

```bash
mkdir -p <space-repo>/<project>/prototypes/hello
cd <space-repo>
cat > space.json <<'JSON'
{
  "id": "<space-id>",
  "name": "<Space name>",
  "default": true,
  "siteOrigin": "<site>"
}
JSON
echo '<!doctype html><meta charset=utf-8><title>Hello</title><h1>Hello</h1>' \
  > <project>/prototypes/hello/index.html
git init -b main && git add . && git commit -m "space: initial"
gh repo create <owner>/<space-repo> --private --source=. --push
```

- Only the contents of `prototypes/` folders are published. Notes, research and anything
  outside them stay private by construction.
- A design system is optional. Plain self-contained HTML builds and ships fine.
- `"adminOnly": true` seals a space behind the admin login. `"default": true` puts it at
  the site root — exactly one space per instance should have it.
- Every field, with semantics: [agents/space-json.md](./agents/space-json.md).

**No CI belongs in a space repo.** Content ships by publishing, not by pushing.

## Step 4 — Cloudflare resources

```bash
# KV — overlay state (comments, pins, statuses, sessions, publish tokens)
curl -s -X POST "$API/storage/kv/namespaces" -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" -d '{"title":"<instance>-kv"}'
# → note result.id as <kv-id>

# R2 — the bundle store (published content)
curl -s -X POST "$API/r2/buckets" -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" -d '{"name":"<bucket>"}'

# Pages project
curl -s -X POST "$API/pages/projects" -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" -d '{
    "name":"<pages-project>","production_branch":"main",
    "deployment_configs":{
      "production":{"compatibility_date":"2026-06-14",
                    "kv_namespaces":{"COMMENTS":{"namespace_id":"<kv-id>"}}},
      "preview":   {"compatibility_date":"2026-06-14",
                    "kv_namespaces":{"COMMENTS":{"namespace_id":"<kv-id>"}}}}}'

# Bindings + runtime secrets on production. PATCH merges, so this keeps the KV binding.
curl -s -X PATCH "$API/pages/projects/<pages-project>" -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" -d "{\"deployment_configs\":{\"production\":{
    \"r2_buckets\":{\"BUNDLES\":{\"name\":\"<bucket>\"}},
    \"env_vars\":{\"SESSION_SECRET\":{\"type\":\"secret_text\",\"value\":\"$(openssl rand -hex 32)\"}}}}}"
```

The binding **names** matter — the worker reads `env.COMMENTS`, `env.BUNDLES`. A missing
KV binding makes the overlay APIs answer `{"warning":"no-kv-binding"}` instead of
persisting; a missing R2 binding makes publishing impossible.

`SESSION_SECRET` is not optional in practice. Session cookies are HMACs keyed on it;
without it the worker falls back to an unkeyed digest and sessions are not
cryptographically bound to anything. Set it before the first login exists.

Do **not** set `GV_ASSET_SOURCE` yet. Serving flips to the store in step 7, after the
store has content — flipping an empty store serves a login page at every URL.

## Step 5 — the shell repo

```bash
cd <parent>/<shell> || { mkdir -p <parent>/<shell> && cd <parent>/<shell>; }
git init -b main
git submodule add https://github.com/andratwiro/augur.git engine
```

`.gitmodules` URLs **must be HTTPS**. `actions/checkout` authenticates submodules by
rewriting HTTPS URLs with its token and cannot authenticate `git@github.com:` URLs — an
SSH URL here breaks every deploy at checkout.

`identity.json` — who exists. It is a roster, not a credential store: passwords live in
KV as PBKDF2 hashes, set by the person redeeming an invite. `[]` leaves the gate open to
anyone.

The one exception is the **first admin**, who has nobody to invite them. Seed that
account with a `passHash` — generate it with the engine's own hasher:

```bash
cd <parent>/augur && node --input-type=module -e "
  const W = (await import('./src/_worker.js')).__testables;
  console.log(await W.hashPassword(process.argv[1]));" '<your-password>'
```

```json
[
  { "email": "<admin-email>", "name": "<Name>", "initials": "XX",
    "color": "#4a6cf7", "role": "admin", "passHash": "pbkdf2$100000$…$…" }
]
```

Use `passHash`, never a plaintext `pass`. A plaintext value still *resolves* as that
user's secret — so the account reads as active rather than pending — but nothing verifies
it, because password checking accepts only `pbkdf2$…` strings. The account would look
fine and be permanently unloginnable. Everyone after the first admin gets no password
field at all: invite them from the Admin panel and they choose their own.

`deploy.config.json` — instance knobs. Minimum viable:

```json
{
  "siteOrigin": "<site>",
  "spaces": [{ "id": "<space-id>", "repo": "<owner>/<space-repo>" }],
  "shellContract": 1
}
```

`spaces` is a roster for repo-side automation (the health canary reads it), **not** a
build input — the shell mounts no space submodules. Optional keys: `realtimeOrigin`
(step 9), `sentinels`, `mcpHostSuffixes`, `mcpHostAllowlistUrl`, `vanityRedirects`,
`builder`, `updateFeed`, `loginHint` (one line of plain text rendered under the
login form — how a demo instance surfaces its test credentials).

`package.json` — so a local build reproduces CI's:

```json
{ "name": "<shell>", "private": true, "type": "module",
  "scripts": { "build": "GV_ENGINE_ONLY=1 GV_IDENTITY_PATH=\"$PWD/identity.json\" GV_DEPLOY_CONFIG_PATH=\"$PWD/deploy.config.json\" node engine/build.js" } }
```

Workflows — copy from [templates/shell/](./templates/shell/) into
`.github/workflows/`, then set the two instance values in `deploy.yml`
(`--project-name=<pages-project>` and `AUGUR_ORIGIN: <site>`) and the origin in
`health.yml`:

| File | Does |
|---|---|
| `deploy.yml` | build engine chrome → Pages → publish chrome to the store. Required. |
| `engine-bump.yml` | take engine updates on your schedule. Required in practice. |
| `health.yml` | canary: pushed-but-never-published drift, stale dirty publishes. |
| `store-backup.yml` | off-Cloudflare copies of the store, weekly + monthly. |
| `space-preflight.yml` | probe that CI's PAT can read a space repo before you add it. |
| `roster-update.yml` | commit Admin-panel invites/removals back to `identity.json`. |

Commit and create the repo:

```bash
git add . && git commit -m "shell: initial" \
  && gh repo create <owner>/<shell> --private --source=. --push
```

## Step 6 — secrets, then the first deploy

```bash
gh secret set CLOUDFLARE_API_TOKEN  -R <owner>/<shell> --body "$CF_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID -R <owner>/<shell> --body "$CF_ACCOUNT"
gh secret set SUBMODULE_PAT         -R <owner>/<shell> --body "$GH_TOKEN"
gh workflow run deploy.yml -R <owner>/<shell> && sleep 90 && curl -s <site>/_build.json
```

`SUBMODULE_PAT` needs read on the **shell itself**, not just the spaces — checkout uses
one token for the host repo too. If the checkout step dies with
`Input required and not supplied: token`, the secret is missing; if it dies fetching a
space repo, the PAT's repository access does not cover it (run `space-preflight.yml` to
probe).

Verify: `<site>` serves the login page, and signing in as `<admin-email>` with the
password you hashed into `passHash` lands you inside. There is no content yet — that is correct. The workflow's
store-publish step reports `AUGUR_TOKEN not configured — skipping` and passes; that
secret arrives in the next step.

## Step 7 — seed the store, then flip serving

The order matters. A flip before a seed serves a login page at every URL, because an
empty store means every path is unknown, and the gate answers unknown paths with the
login form.

```bash
cd <parent>/augur

# 1. Mint a publish token from your own credentials. Admins get "*" — every space.
AUGUR_EMAIL=<admin-email> AUGUR_PASSWORD='<your-password>' node scripts/login.mjs --origin <site>

# 2. Seed: every sibling space + the engine chrome + the instance config.
node scripts/publish.mjs --all

# 3. Give CI the same token, so future engine deploys can publish the chrome.
gh secret set AUGUR_TOKEN -R <owner>/<shell> --body "$(python3 -c \
  "import json,os;print(json.load(open(os.path.expanduser('~/.config/augur/tokens.json')))['<site-host>']['token'])")"

# 4. Confirm the store really has manifests BEFORE flipping.
curl -s "$API/r2/buckets/<bucket>/objects?prefix=spaces/&per_page=50" \
  -H "Authorization: Bearer $CF_TOKEN" | grep -c 'manifest.json'

# 5. Flip serving to the store, then redeploy so the change takes effect.
curl -s -X PATCH "$API/pages/projects/<pages-project>" -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" \
  -d '{"deployment_configs":{"production":{"env_vars":{"GV_ASSET_SOURCE":{"type":"plain_text","value":"r2"}}}}}'
gh workflow run deploy.yml -R <owner>/<shell>
```

Notes on each:

- **Log in as the admin, not as anyone else.** An admin gets a `*`-scoped token; everyone
  else gets a token scoped to the default space, and `/__publish/_instance/config`
  rejects that with a 403. On a brand-new instance a non-admin login cannot even be
  scoped yet, since no space has published.
- The token is saved to `~/.config/augur/tokens.json`, keyed by origin host, mode 0600;
  publishing picks it up from there afterwards. Collaborators self-serve the same way
  with `augur login` — never paste a password into a chat or a workflow file.
- `--all` discovers every sibling space next to the engine clone. From inside a single
  space clone, plain `node <parent>/augur/scripts/publish.mjs` infers that one space.
- A Pages env var only applies to **new** deployments, which is why step 5 redeploys.

**The flip is one-way.** Unsetting `GV_ASSET_SOURCE` again does not roll anything back: CI
only ever uploads engine chrome to Pages, so assets mode on an instance built this way
serves a site with no content in it. To undo a bad **publish**, use the store's own
history — every version is kept and blobs are never collected, so any past publish is one
call away:

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/augur/tokens.json')))['<site-host>']['token'])")
curl -s <site>/__publish/<space-id>/versions -H "Authorization: Bearer $TOKEN"
curl -s -X POST <site>/__publish/<space-id>/rollback -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"version":<n>}'
```

A rollback republishes the old content under a **new** version number rather than
repointing at the old one, so it is itself visible in the history and undone by another
rollback.

## Step 8 — verify

```bash
curl -s <site>/_build.json                 # builtAt fresh; spaces.<space-id>.sha == repo HEAD
curl -s -o /dev/null -w '%{http_code}\n' <site>/<project>/hello/     # 200 — public prototype
curl -s -o /dev/null -w '%{http_code}\n' <site>/__config/instance.json  # 404 — config is sealed
curl -s <site>/__canvas/catalog.json | head -c 200                   # synthesized, not stored
```

Then, in a browser: the login page appears logged out; signing in works; a comment posted
on a page survives a reload (that is KV); the Admin panel lists your user.

`/_build.json` is the public deploy proof — a collaborator who cannot see your CI compares
its `spaces.<id>.sha` to their own `git rev-parse HEAD`. `augur status` does the same
comparison locally across every clone.

## Step 9 — optional: custom domain

```bash
curl -s -X POST "$API/pages/projects/<pages-project>/domains" -H "Authorization: Bearer $CF_TOKEN" \
  -H "content-type: application/json" -d '{"name":"<host>"}'
```

Then a **proxied CNAME `<host>` → `<pages-project>.pages.dev`** in the zone that owns the
domain. If the Pages token cannot see that zone — common — this is one dashboard click:
**HUMAN**. The domain flips to `active` on its own once the record resolves. Afterwards
update `siteOrigin` in `deploy.config.json`, `AUGUR_ORIGIN` in `deploy.yml` and
`health.yml`, and `siteOrigin` in each `space.json`.

## Step 10 — optional: canvas multiplayer

Live boards need a second worker, **one per instance** — rooms are keyed by board path, so
two instances sharing a worker would share rooms and board storage.

1. Copy `realtime/wrangler.example.toml` from the engine into the shell as
   `realtime.wrangler.toml`; set `name` and point `BOARD_KV` at `<kv-id>`.
2. `npx wrangler deploy -c realtime.wrangler.toml` from the shell root, with the engine
   submodule checked out and the Cloudflare credentials in the environment.
3. Add `"realtimeOrigin": "https://<worker>.<subdomain>.workers.dev"` to
   `deploy.config.json`, push, redeploy.
4. Optionally set `RT_SHARED_SECRET` on both workers so the realtime worker only accepts
   traffic proxied through the site (which is where the admin-only seal is enforced).

Verify with a websocket upgrade to `/__rt?path=/__test/x` — **101**. Paths under
`/__test/` never persist. Without any of this, `/__rt` answers 501 and boards run
single-user, persisting to KV through the Pages worker. A brand-new workers.dev worker
can 500 (`error code: 1104`) for its first minute — retry before debugging.

## Step 11 — optional: the platform MCP proxy

A prototype talking to an upstream API usually cannot call it from the browser, so
`/__mcp/<host>/<path>` forwards from the site's own origin. Which hosts it forwards comes
from three explicit sources, and nothing else:

- `"mcpHostSuffixes": ["example.com"]` in `deploy.config.json` — any subdomain of each
  entry.
- `"mcpAllowlists": ["path/in/space/allowlist.json"]` in a `space.json` — each path names
  a JSON document the space ships, shaped `{"hosts": ["a.example"]}`, matched as **exact
  hosts**. For platforms on a vanity domain, where no suffix rule is safe. Mounting the
  space is the trust act. A declared list that is missing or malformed fails the build.
- `"mcpHostAllowlistUrl"` in `deploy.config.json` — the same document shape fetched at
  runtime, cached an hour, for a list that lives outside any space. Unreachable → the
  other two still apply, so a broken URL never revokes working access.

Forwarding "anything that looks like the right kind of API" would make this an open proxy
for whatever is reachable from the edge. Hence three explicit lists.

## Operating it

**Engine updates.** `engine-bump.yml` runs weekly and on demand
(`gh workflow run engine-bump.yml -R <owner>/<shell>`). On the default `release` track it
opens a PR moving the pin to the latest engine release with the notes in the body —
nothing lands unread. `TRACK: main` follows the bleeding edge instead. The pin is your
release valve: skip an update by not merging, roll back by reverting the pin commit.
Release mode needs one repo setting once:

```bash
gh api -X PUT repos/<owner>/<shell>/actions/permissions/workflow \
  -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true
```

**Backups.** The store is the only copy of published content and R2 has no
point-in-time restore. Most of it is reproducible from git at the sha `/_build.json`
reports — but a publish from an uncommitted working tree (`"dirty": true`) serves bytes
held in no repository. `store-backup.yml` takes weekly and monthly copies; on demand it is
`augur export --out <dir>`, and `augur restore <dir>` puts one back. Walkthrough:
`docs/store-recovery.md`.

**Drift.** `health.yml` compares each space repo's `main` HEAD against the live stamp
every six hours and opens a single issue when work is pushed but never published, or when
a dirty publish outlives its grace window. It closes the issue itself when things go
green.

**Adding another space later.** Create the repo (step 3, without `"default": true`), grant
the PAT read access, verify the grant with
`gh workflow run space-preflight.yml -R <owner>/<shell> -f repo=<owner>/<repo>`, add it to
the `spaces` roster in `deploy.config.json`, and publish from its clone. It serves under
`/<space-id>/`. No submodule, no CI, no pin.

**Local preview.** `npm run offline` from the engine builds every sibling space, runs the
real worker locally with the shell's identity, and hot-reloads in about a second — see
[CLAUDE.md](./CLAUDE.md). A second instance on the same machine needs `OFFLINE_PORT`. Note
that if `augur/.env.deploy` holds real credentials, the offline worker reads and writes the
**production** KV; rename it for a local-only sandbox (the startup log says which mode it
is in).

## Gotchas

- **Flipping `GV_ASSET_SOURCE` before the store is seeded** takes the whole site down to a
  login page. Verify manifests exist first; roll back with the same PATCH set to `null`.
- **HTTPS in `.gitmodules`, always.** Checkout cannot authenticate SSH URLs.
- **`SUBMODULE_PAT` must cover the shell repo too**, not only the spaces.
- **`GITHUB_TOKEN` pushes never retrigger workflows**, by design. The bump workflows
  therefore start `deploy.yml` explicitly, which needs `actions: write`. Anything that
  must retrigger CI by pushing (`roster-update.yml`) needs a real PAT, `AUGUR_PIN_TOKEN`.
- **`/__publish/_instance/config` requires a `*`-scoped token.** A token scoped to one
  space, or to `_engine`, gets a 403 there — this is the usual cause of a first CI publish
  failing.
- **Publishing ships the working tree.** A publish from an uncommitted tree is flagged
  `"dirty": true` in `/_build.json`; those exact bytes exist in no repository. `augur ship`
  commits first for that reason.
- **A publish defines the whole space.** A clone missing a folder would remove its public
  URLs for everyone, so `commit` refuses to drop public prefixes unless you pass
  `--allow-unpublish`. Never work around it by passing the flag reflexively.
- **Never publish from a shallow clone.** Edit dates and contributor chips come from git
  history; a `--depth 1` clone flattens both. Publish refuses, and tells you the unshallow
  command.
- **A fresh Pages deploy serves mixed old and new assets for a minute or two** at some
  edges. Poll until two consecutive fetches agree before diagnosing a "bug" reported
  seconds after a ship.
- **Scheduled workflows quietly stop after ~60 idle days.** The manual dispatch always
  works.
- **Do not unbind KV to escape a KV outage.** Authentication fails closed on a KV error on
  purpose, but "no binding at all" is the offline-build case and falls through to whatever
  `identity.json` seeds. Wait the outage out or fix the binding.
- **A plaintext `pass` in `identity.json` creates an unloginnable account** that reports
  itself as active. Seed `passHash`, or nothing at all.
