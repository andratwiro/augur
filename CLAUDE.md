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
├── realtime/           # canvas multiplayer worker (Durable Objects; deployed separately)
└── brand/              # the engine's own marks + fonts
```

## The spaces model

A **space** is a separate git repo: a self-contained design system + prototypes bundle.
`build.js` enumerates every dir with a `space.json` under `GV_SPACES_ROOT` (default:
`./spaces`). The default space builds at the site root; every other space under
`/<id>/`.

`space.json` contract: `{ id, name, default, badge, adminOnly, projectsLabel,
methodPages, pendingPages, designSystem, ignore }`.
- `id` = the `spaces/<id>` mount name + URL prefix (lowercase `[a-z0-9-]`). The repo
  NAME is a free label — the deploy bridge names spaces from `space.json`, not the repo.
- `adminOnly: true` seals every URL under the space's base behind the admin login
  (injected into the worker as `RESTRICTED_BASES`).
- `projectsLabel`: what the UI calls the space's top-level prototype folders (rail
  section + landing title). Default "Projects"; a space whose team has its own
  vocabulary for them (e.g. "Opportunities") overrides it here. Internal code keeps
  the historical `opportunities` identifiers — only user-facing strings read the label.
- **The UI skill is auto-detected**: the dir under `<space>/skills/` named
  `<prefix>-ui` containing `<dirname>.css`. Every canonical asset name derives from the
  prefix (`<prefix>-tokens.css`, `<prefix>-primitives.css`, …). Override with
  `designSystem: { "skill": "<dir>" }`.
- `ignore`: extra top-level dirs the build must never treat as project folders.

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
