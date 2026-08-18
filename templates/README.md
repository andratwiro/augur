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

**Keeping baked chrome current is the SHELL's job, not the space's.** Page-level chrome
(rail, overlays, layout) is baked into each page at publish time (`/_build.json`
`builtWithEngine`), so an engine bump refreshes the *serving* engine but leaves
already-published pages on older chrome until the space republishes. `deploy.yml` closes
that with a `rebake` job: when the engine pin moves it clones each roster space and
re-publishes it with the shell's own `*`-scoped `AUGUR_TOKEN` (the one it already uses for
`--engine`). The star token therefore lives ONLY in the private shell — never in a
(possibly public) space repo — and **no space needs a token or CI just to stay on the
current chrome.** `health.yml` check (f) alarms if a space is ever left on chrome older
than the deployed engine.

**`templates/space/publish.yml` is optional and only for a PUBLIC auto-publish space** —
a demo whose last pusher is often not the person who'd remember to publish. It joins
push→publish so content goes live on push, running the same `augur publish` client with a
token scoped to that space (not `*`, since the repo may be public). A working space needs
none of this: it publishes deliberately from a terminal, and its chrome is re-baked by the
shell above. A bare space repo is just a `space.json` and some `prototypes/` folders — no
CI, no secret, no submodule mount.

Engine missing something your instance needs? Don't patch your copy — **open a PR
upstream** ([CONTRIBUTING.md](../CONTRIBUTING.md)) and take it back via pin bump. That
keeps your instance on the update train and ships your fix to everyone.
