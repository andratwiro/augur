# Augur

A build and deploy platform for prototyping sites. Augur composes one or more
spaces, each a separate git repo holding a self-contained design system and its
prototypes, into a single static site with a shared overlay layer, and ships it
to Cloudflare Pages.

## How it works

- **Spaces are repos.** The deploy shell mounts each space as a git submodule at
  `spaces/<id>`; locally, any folder of space clones works via `GV_SPACES_ROOT`.
  A directory counts as a space when it has a `space.json` at its root. The
  default space builds at the site root; every other space serves under
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
  itself. A separate private shell repo mounts the engine (and spaces) as pinned
  submodules and holds the CI workflows, the user list and all secrets.
  **Engine changes ship on push:** pushing the engine fires a
  `repository_dispatch` that bumps the engine pin in the shell and redeploys,
  about a minute end to end. **Space content ships by direct publish:**
  `augur publish` from a space clone uploads only what changed and flips the
  live site atomically in seconds (self-serve token via `augur login`; a git
  push saves and shares the work but does not deploy it). Instances that prefer
  pure CI can instead wire the push→pin-bump relay with the
  [templates/](./templates/) workflows. Collaborators only ever need their own
  space repo.
- **Offline mode.** `npm run offline` builds from editable sibling clones, runs
  the real worker locally, and hot-reloads in about a second. See
  [CLAUDE.md](./CLAUDE.md) for the full conventions.

## Quick start

```bash
git clone <this-repo>
cd augur
GV_SPACES_ROOT=/path/to/spaces node build.js     # any dir holding space repos (each with a space.json)
GV_SPACES_ROOT=/path/to/spaces npm run dev       # build + serve locally (keep the env var — a bare
                                                 # clone has no ./spaces and the build refuses to run empty)
```

CI lives in the deploy shell repo — copy-paste workflows and a full instance
recipe live in [templates/](./templates/). The shell needs a Cloudflare Pages
project (with a KV namespace bound as `COMMENTS` for the overlay state) and
three secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`SUBMODULE_PAT` (Contents:read on the shell itself + every private space repo;
`.gitmodules` URLs must stay HTTPS for it to work). Relay-mode extras: a space
repo announcing its pushes needs `AUGUR_DISPATCH_TOKEN` (Contents:write on the
shell), and a shell may add `AUGUR_PIN_TOKEN` (Contents:write on itself) if it
wants pin pushes to retrigger CI by themselves — the template workflows don't
need it (they push with their own `GITHUB_TOKEN` and start the deploy
explicitly). Publish-mode instances skip both: space tokens are minted at
`/__admin/tokens` and collaborators self-serve with `augur login`.

## Adding a space

Create a repo with a `space.json` and one or more `<project>/prototypes/`
folders — a design system is optional; plain self-contained HTML builds fine.
(The UI calls these top-level folders "Projects" by default; a space renames
the section via `space.json` `projectsLabel`.)
Grant `SUBMODULE_PAT` read access on the new repo, then, in the shell:
`git submodule add <https-url> spaces/<id>` and push. The space id comes from
`space.json`, so the repo name is a free label. Its content then ships with
`augur publish` from the space clone. Relay-mode instances additionally add
[templates/space-deploy-trigger.yml](./templates/space-deploy-trigger.yml) as
`.github/workflows/deploy-trigger.yml` (point `SHELL_REPO` at the shell) with
the `AUGUR_DISPATCH_TOKEN` secret, so pushes bump the pin instead.

## Modifying the engine

Instances **pin** this engine and take fixes by pin bump — never fork-and-patch an
instance. If the engine is missing something, **send it here — PRs are welcome**
(see [CONTRIBUTING.md](./CONTRIBUTING.md)): fork to PR, not to deploy; your instance
takes the fix by its next pin bump. Instance-specific behavior belongs in the shell's
`deploy.config.json`, space-specific behavior in `space.json`. Full rationale:
[CLAUDE.md](./CLAUDE.md).

## License

MIT. See [LICENSE](./LICENSE).
