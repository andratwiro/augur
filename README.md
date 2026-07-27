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
- **Deploys are push-to-main, via a deploy shell.** This engine repo deploys
  nothing itself. A separate private shell repo mounts the engine and the spaces
  as pinned submodules and holds the CI workflows, the user list and all
  secrets. Pushing the engine or a space repo fires a `repository_dispatch`
  that bumps the matching pin in the shell and redeploys, about a minute end to
  end. Collaborators only ever need their own space repo.
- **Offline mode.** `npm run offline` builds from editable sibling clones, runs
  the real worker locally, and hot-reloads in about a second. See
  [CLAUDE.md](./CLAUDE.md) for the full conventions.

## Quick start

```bash
git clone <this-repo>
cd augur
GV_SPACES_ROOT=/path/to/spaces node build.js  # any dir holding space repos (each with a space.json)
npm run dev                                   # build + serve locally
```

CI lives in the deploy shell repo, which needs a Cloudflare Pages project and
four secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUBMODULE_PAT`
(reads the engine + space submodules; `.gitmodules` URLs must stay HTTPS for it
to work) and `AUGUR_PIN_TOKEN` (pushes the auto-bump commits). This repo needs
only `AUGUR_DISPATCH_TOKEN` (write on the shell) to announce its pushes.

## Adding a space

Create a repo with a `space.json`, design system assets, and the
`deploy-trigger.yml` workflow. Grant `SUBMODULE_PAT` read access on it and
verify with the deploy shell's `space-preflight.yml`. Then, in the shell:
`git submodule add <repo-url> spaces/<id>` and push. The space id comes from
`space.json`, so the repo name is a free label.

## License

MIT. See [LICENSE](./LICENSE).
