# Deploy templates

Copy-paste starting points for standing up an Augur instance. The engine repo
deploys nothing itself — a private **deploy shell** repo composes it with your
space repos and ships the site (see the root README).

```
templates/
├── space-deploy-trigger.yml   # → <space-repo>/.github/workflows/deploy-trigger.yml
└── shell/
    ├── deploy.yml             # → <shell-repo>/.github/workflows/deploy.yml
    ├── workspace-bump.yml     # → <shell-repo>/.github/workflows/workspace-bump.yml
    ├── engine-bump.yml        # → <shell-repo>/.github/workflows/engine-bump.yml
    └── space-preflight.yml    # → <shell-repo>/.github/workflows/space-preflight.yml
```

## Minimal instance recipe

1. **Space repo** (private, one per space): a `space.json` (`{ "id": "...",
   "default": true }` for the space that owns the site root), project
   folders with `prototypes/`, and `space-deploy-trigger.yml` (set `SHELL_REPO`).
   A design system is optional — a space of plain HTML prototypes builds fine.
2. **Shell repo** (private): mount the engine at `engine/` and each space at
   `spaces/<id>/` as submodules (**HTTPS URLs** — CI checkout cannot
   authenticate SSH), add `identity.json` (the user list; `[]` = open gate),
   `deploy.config.json` (`{ "siteOrigin": "https://..." }`), and the three
   `shell/` workflows (set the Pages project name in `deploy.yml`).
3. **Cloudflare**: a Pages project with a KV namespace bound as `COMMENTS`
   (production + preview), and an API token that can deploy Pages. Before
   mounting any later space, run `space-preflight.yml` with the new repo —
   mounting before the token grant breaks every deploy at checkout.
4. **Secrets**: on the shell — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `SUBMODULE_PAT` (Contents:read on the shell itself + every private space
   repo; the engine is public). On each space repo — `AUGUR_DISPATCH_TOKEN`
   (Contents:write on the shell). One fine-grained PAT with Contents:read&write
   on the shell + the space repos can serve as both.

Push the shell → the site deploys. Push a space → its pin bumps → the site
deploys (~1 min). Engine updates arrive on the shell's schedule via
`engine-bump.yml` — the public engine carries no per-instance wiring.

Engine missing something for your instance? Don't patch your copy — **open a PR
upstream** (see the engine's CONTRIBUTING.md) and take it back via pin bump.
That keeps your instance on the update train and ships your fix to everyone.

## Canvas multiplayer (optional)

Live multiplayer boards need a second Cloudflare worker — `realtime/` in the
engine, deployed **once per instance** with its own name and its own board KV
binding (rooms are keyed by board path, so two instances sharing one worker
would share rooms and board storage). Keep a small wrangler config in the shell
(name, `BOARD_KV` → the instance's KV namespace, Durable Object migration as in
`realtime/wrangler.toml`), deploy it with `wrangler deploy -c`, and set
`"realtimeOrigin": "https://<that-worker>.workers.dev"` in `deploy.config.json`.
Without it, boards still work single-user (they persist through the Pages
worker to the instance's KV); `/__rt` answers 501.
