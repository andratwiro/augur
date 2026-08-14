# Augur

A build and deploy platform for prototyping sites. Augur composes one or more
spaces, each a separate git repo holding a self-contained design system and its
prototypes, into a single static site with a shared overlay layer, and ships it
to Cloudflare.

## How it works

- **Spaces are repos.** A directory counts as a space when it has a `space.json`
  at its root; locally, any folder of space clones works via `GV_SPACES_ROOT`.
  The default space builds at the site root; every other space serves under
  `/<id>/`. A space with `adminOnly: true` in its `space.json` is sealed behind
  the admin login.
- **The build is a single script.** `node build.js` walks every space,
  publishes only the contents of `prototypes/` folders plus the space's
  galleries, generates the landing page and per-space indexes, and stamps a
  public `/_build.json` so collaborators can verify their commit is live.
  Internal files (research notes, anything outside `prototypes/`) are never
  published.
- **An overlay worker runs on top.** `src/_worker.js` adds a per-user login
  gate, review comments and pins, dev status chips, and live multiplayer canvas
  boards over the static pages. State lives in Cloudflare KV.
- **Two ship paths, via a deploy shell.** This engine repo deploys nothing
  itself. A separate private shell repo pins the engine as a submodule and holds
  the CI workflows, the user list and all secrets. **Engine changes ship on
  push:** pushing the engine fires a `repository_dispatch` that bumps the engine
  pin in the shell and redeploys, about a minute end to end. **Space content
  ships by direct publish:** `augur publish` from a space clone uploads only
  what changed to the R2 bundle store and flips the live site atomically in
  seconds (self-serve token via `augur login`; a git push saves and shares the
  work but does not deploy it). The shell never holds space content — its CI
  builds with no space on disk — so a redeploy cannot overwrite a publish, and
  collaborators only ever need their own space repo.
- **Offline mode.** `npm run offline` builds from editable sibling clones, runs
  the real worker locally, and hot-reloads in about a second. See
  [CLAUDE.md](./CLAUDE.md) for the full conventions.

## Quick start

```bash
git clone <this-repo> augur
cd <a space repo, next to the engine clone>
node ../augur/scripts/dev.mjs                    # the full local shell: login gate, rail,
                                                 # overlays, ~1s hot reload
```

`augur dev` runs one space at its real root URLs. To build or serve several at once,
point the engine at a folder of space clones:

```bash
GV_SPACES_ROOT=/path/to/spaces node build.js     # any dir holding space repos (each with a space.json)
GV_SPACES_ROOT=/path/to/spaces npm run dev       # build + serve statically, no worker
```

Keep the env var — a bare clone has no `./spaces` and the build refuses to run empty.

## Deploying an instance

**[INSTALL.md](./INSTALL.md) is the full recipe** — an hour, start to finish,
written to be executed step by step (by a person or an agent) with the handful
of human-only steps marked. In outline: a private deploy shell pinning this
engine, one repo per space, and a Cloudflare Pages project with a KV namespace
bound as `COMMENTS`, an R2 bucket bound as `BUNDLES`, and a `SESSION_SECRET`.
The shell holds three secrets — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
and `SUBMODULE_PAT` (Contents:read on the shell itself and every private space
repo; `.gitmodules` URLs must stay HTTPS for it to work). Copy-paste workflows
for the shell are in [templates/](./templates/).

## Adding a space

Create a repo with a `space.json` and one or more `<project>/prototypes/`
folders — a design system is optional; plain self-contained HTML builds fine.
(The UI calls these top-level folders "Projects" by default; a space renames
the section via `space.json` `projectsLabel`.) Add it to the `spaces` roster in
the shell's `deploy.config.json`, then publish from its clone with
`augur publish`. The space id comes from `space.json`, so the repo name is a
free label; the default space builds at the site root and every other serves
under `/<id>/`.

A space repo needs no CI, no secrets and no submodule mount — publishing is the
whole content path.

## Modifying the engine

Instances **pin** this engine and take fixes by pin bump — never fork-and-patch an
instance. If the engine is missing something, **send it here — PRs are welcome**
(see [CONTRIBUTING.md](./CONTRIBUTING.md)): fork to PR, not to deploy; your instance
takes the fix by its next pin bump. Instance-specific behavior belongs in the shell's
`deploy.config.json`, space-specific behavior in `space.json`. Full rationale:
[CLAUDE.md](./CLAUDE.md).

## License

MIT. See [LICENSE](./LICENSE).
