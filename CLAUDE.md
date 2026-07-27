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

`space.json` contract: `{ id, name, default, badge, adminOnly, methodPages,
pendingPages, designSystem, ignore }`.
- `id` = the `spaces/<id>` mount name + URL prefix (lowercase `[a-z0-9-]`). The repo
  NAME is a free label — the deploy bridge names spaces from `space.json`, not the repo.
- `adminOnly: true` seals every URL under the space's base behind the admin login
  (injected into the worker as `RESTRICTED_BASES`).
- **The UI skill is auto-detected**: the dir under `<space>/skills/` named
  `<prefix>-ui` containing `<dirname>.css`. Every canonical asset name derives from the
  prefix (`<prefix>-tokens.css`, `<prefix>-primitives.css`, …). Override with
  `designSystem: { "skill": "<dir>" }`.
- `ignore`: extra top-level dirs the build must never treat as opportunities.

**Publishing is whitelist-driven (critical guardrail).** Only the contents of
`prototypes/` folders, the gallery tiers (`base/ components/ pages/ patterns/`,
rebuilt), the `playground/`, and the whitelisted skill assets ship. `research.md`,
`context.md`, anything outside `prototypes/` — internal, never copied to `/dist`.

## Deploys — this repo ships nothing

**Push-to-main deploys, via the shell.** A push here fires
`.github/workflows/deploy-trigger.yml` (an `engine-updated` dispatch); a space-repo
push fires its own `deploy-trigger.yml` (`workspace-updated`, naming the space by its
`space.json` id). The shell moves the matching submodule pin and its `deploy.yml`
builds + ships (~1 min). Deploy verification is the public **`/_build.json`** stamp:
`{builtAt, spaces:{<id>:{sha}}}` — compare a space's sha to `git rev-parse HEAD`.

Build-time injection (all presence-checked placeholders in `src/_worker.js`):
`USERS` (from `GV_IDENTITY_PATH`), `RESTRICTED_BASES`, `PUBLIC_SKILL_PREFIXES` (the
default space's skill dir, gate-exempt for asset extensions), and from
`GV_DEPLOY_CONFIG_PATH` (`deploy.config.json` in the shell): `MCP_HOST_SUFFIXES`,
`VANITY_REDIRECTS`, `BUILDER_CONFIG` (AI project-builder prompts + schema; without it
`/__ai/summarize` answers 501), plus `SITE_ORIGIN` for absolute og/unfurl URLs.

Env reference: `GV_SPACES_ROOT` (spaces location) · `GV_IDENTITY_PATH` (user list) ·
`GV_DEPLOY_CONFIG_PATH` (deploy config) · `OFFLINE_PORT` (offline preview).

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
