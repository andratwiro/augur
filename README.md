# Augur

The build/deploy platform for the Go Vocal prototyping site. Augur **composes one git
submodule per space** and is the only thing that builds + ships the live site:

- **`spaces/<id>/`** (one submodule per space) — each space is its own repo, a
  self-contained bundle at its root: `.gv-*` tokens, primitives, CSS/JS, galleries
  (`base/ components/ pages/ patterns/ registry.json`) **plus** its opportunity/prototype
  folders, a `playground/`, and a `space.json`. Currently mounted: **`go-vocal`**
  (`andratwiro/go-vocal`, the default space — previously named `gv-workspace`).

> The GitHub repo is `andratwiro/augur`; the Cloudflare Pages project is still named
> `govocal-prototypes` (URL `https://govocal-prototypes.pages.dev`).

## Quick start

```bash
git clone --recurse-submodules git@github.com:andratwiro/augur.git
cd augur
node build.js        # generate /dist from the space submodules (all spaces)
npm run dev          # build + serve dist locally at http://localhost:3000
```

For live-reload local preview against editable sibling clones, use `npm run offline`
(http://localhost:8788) — see [CLAUDE.md](./CLAUDE.md).

## Structure

```
augur/
├── build.js                 # composes the space submodules → generates /dist + index.html
├── CLAUDE.md                # conventions (read this)
├── src/_worker.js           # Cloudflare worker: auth gate, KV status/comments, space routing
├── pitis/                   # the Pitis overlay layer + its build addon
├── scripts/                 # platform scripts: offline, shoot (posters), og, review (comments)
└── spaces/
    └── go-vocal/            # submodule → andratwiro/go-vocal (the default space)
```

## Adding a prototype

Prototypes (and the design system) live in the **space repos**, not here. Edit a space in
its **own standalone clone** (e.g. `../go-vocal`), then push to its `main`. **There is no
manual pin step:** the push fires a `workspace-updated` dispatch naming the space, which
auto-bumps that space's submodule pin here and deploys (~1 min). See [CLAUDE.md](./CLAUDE.md).

## Adding a space

Spaces are repos. Create a GitHub repo templated from `go-vocal` (own `space.json`, DS
assets, `deploy-trigger.yml`); grant `SUBMODULE_PAT` read on it and add
`AUGUR_DISPATCH_TOKEN` to its Actions secrets; then here:
`git submodule add https://github.com/andratwiro/<id>.git spaces/<id>` and push. The
default space builds at the root URLs; others under `/<id>/`.

## Important

Only files inside `prototypes/` folders (within a space) are published. `research.md`,
`context.md`, `GOVOCAL.md`, and anything outside `prototypes/` are **never** copied to
`/dist`.

## Deployment

- **Host:** Cloudflare Pages (project `govocal-prototypes`) — build `node build.js`, output `dist`.
- **CI:** push to `main` → `.github/workflows/deploy.yml` builds + deploys. The
  space→Augur auto-bump bridge (`workspace-bump.yml` here, `deploy-trigger.yml` in each
  space repo) keeps the pins current. Needs repo secrets `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, `SUBMODULE_PAT` (reads the private space submodules), plus
  `AUGUR_PIN_TOKEN` for the auto-bump commit. `.gitmodules` URLs must stay **HTTPS** for
  the PAT to work.
- **Access control:** per-user login gate in `src/_worker.js`.
