# Deploy templates

Copy-paste workflows for a **deploy shell** — the private repo that pins this engine,
holds the user list and the secrets, and ships the site. The engine deploys nothing
itself.

**The recipe that uses these files is [INSTALL.md](../INSTALL.md)** — read that first;
this page is only the file index.

```
templates/shell/          → <shell-repo>/.github/workflows/
├── deploy.yml            # REQUIRED. Build engine chrome → Pages → publish chrome to the store.
├── engine-bump.yml       # REQUIRED in practice. Take engine updates on your own schedule.
├── health.yml            # Canary: pushed-but-never-published drift, stale dirty publishes.
├── store-backup.yml      # Weekly + monthly off-Cloudflare copies of the bundle store.
├── space-preflight.yml   # Probe that CI's PAT can read a space repo before you add it.
└── roster-update.yml     # Commit Admin-panel invites/removals back to identity.json.
```

Each file carries its own header explaining what it does and what it needs. Three of them
have an instance value to fill in before first use — the Pages project name and site
origin in `deploy.yml`, the site origin in `health.yml` and `store-backup.yml`.

**There is no template for a space repo, and that is deliberate.** Space content reaches
the live site through `augur publish` and through nothing else, so a space repo needs no
CI, no secrets and no submodule mount — just a `space.json` and some `prototypes/`
folders. `deploy.yml` builds with `GV_ENGINE_ONLY=1`, which makes it structurally
incapable of emitting space content, so a stale CI checkout can never overwrite a
publish.

Engine missing something your instance needs? Don't patch your copy — **open a PR
upstream** ([CONTRIBUTING.md](../CONTRIBUTING.md)) and take it back via pin bump. That
keeps your instance on the update train and ships your fix to everyone.
