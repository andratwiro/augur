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
├── kv-backup.yml         # Nightly copy of KV — the half store-backup does not cover.
├── space-preflight.yml   # Probe that CI's PAT can read a space repo before you add it.
└── roster-update.yml     # Commit Admin-panel invites/removals back to identity.json.

templates/space/          → <space-repo>/.github/workflows/  (OPTIONAL — see below)
└── publish.yml           # Auto-publish on push + keep baked chrome current with the engine.
```

Drift between a shell and these files is caught by `shell-lint` — run it from a shell
(`node engine/scripts/shell-lint.mjs`), where the engine submodule IS that shell's
pinned engine. `health.yml` runs it on every canary pass. Filled-in placeholders and
reworded comments stay quiet; changed behaviour fails.

Each file carries its own header explaining what it does and what it needs. Three of them
have an instance value to fill in before first use — the Pages project name and site
origin in `deploy.yml`, the site origin in `health.yml` and `store-backup.yml`.

**The two backups do not overlap, and a shell needs both.** `store-backup.yml` copies
published *content* out of the bundle store (R2). `kv-backup.yml` copies the mutable
*state* the worker keeps alongside it — comment threads, statuses, pins, renames,
canvases, and the identity records below. Neither store has point-in-time restore, and
neither backup covers the other, so running only one is being half-backed-up while
reading as backed-up.

⚠️ `kv-backup.yml` commits the **whole** namespace to a branch on the shell repo, and
that includes `users:secrets` (password hashes, and the tombstones that hold reset
passwords out of service) and `publish:tokens` (live bearer tokens that can overwrite
published content). **Do not enable it on a public shell.** Everything else here is
safe on one; this is not.

**A space repo needs no CI to publish — `templates/space/publish.yml` is optional.**
Space content reaches the live site through `augur publish` and nothing else, so a bare
space repo needs no CI, no submodule mount, just a `space.json` and some `prototypes/`
folders — and `deploy.yml`'s `GV_ENGINE_ONLY=1` makes the shell structurally incapable
of emitting space content, so a stale CI checkout can never overwrite a publish. What the
optional space template adds is convenience, not a second content path: it runs the SAME
`augur publish` client with an ordinary per-space token (same door, no key under the mat),
and it earns its keep on two jobs a person forgets:

- **publish-on-push** — for a space where the last pusher is often not the person who
  would remember to publish (a public demo). Delete the `push:` trigger for a working
  space, where publishing is a deliberate act; keep the rest.
- **keep baked chrome current** — page-level chrome (rail, overlays, layout) is baked
  into each page at publish time (`/_build.json` `builtWithEngine`), so an engine bump
  refreshes the *serving* engine but leaves already-published pages on older chrome until
  the space republishes. The template re-bakes automatically: the shell's `deploy.yml`
  fires an `engine-rebake` dispatch when it moves its pin, and a schedule self-heals any
  missed dispatch. The shell's `health.yml` check (f) alarms if a space is ever left on
  chrome older than the deployed engine. This part is useful to *every* space, working or
  public.

The one secret is `AUGUR_TOKEN`, scoped to that space (not `*`); the file's header has the
mint-and-set steps.

Engine missing something your instance needs? Don't patch your copy — **open a PR
upstream** ([CONTRIBUTING.md](../CONTRIBUTING.md)) and take it back via pin bump. That
keeps your instance on the update train and ships your fix to everyone.
