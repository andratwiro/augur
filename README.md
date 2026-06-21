# Augur

The build/deploy platform for the Go Vocal prototyping site. Augur **composes** two repos as
git submodules and is the only thing that builds + ships the live site:

- **`gv-design-system/`** (submodule, read-only) — canonical design system: `.gv-*` tokens,
  primitives, CSS/JS, and the component/page galleries.
- **`gv-workspace/`** (submodule) — opportunity folders (prototypes + research) + `GOVOCAL.md`.

> The GitHub repo is `andratwiro/augur`; the Cloudflare Pages project is still named
> `govocal-prototypes` (URL `https://govocal-prototypes.pages.dev`).

## Quick start

```bash
git clone --recurse-submodules git@github.com:andratwiro/augur.git
cd augur
node build.js        # generate /dist from both submodules
npm run dev          # build + serve dist locally at http://localhost:3000
```

## Structure

```
augur/
├── build.js                 # composes submodules → generates /dist + index.html
├── CLAUDE.md                # conventions (read this)
├── src/_worker.js           # Cloudflare worker: auth gate, KV status/comments
├── pitis/                   # the Pitis overlay layer + its build addon
├── scripts/                 # platform scripts: shoot (posters), og, review (comments)
├── gv-design-system/        # submodule — canonical DS (edit in its own repo)
└── gv-workspace/            # submodule — opportunities + research + GOVOCAL.md
```

## Adding a prototype

Prototypes live in the **gv-workspace** repo, not here. Edit gv-workspace, push, then bump the
submodule pin in Augur (`git submodule update --remote gv-workspace && git add gv-workspace &&
git commit && git push`). See [CLAUDE.md](./CLAUDE.md).

## Important

Only files inside `prototypes/` folders (under `gv-workspace/`) are published. `research.md`,
`context.md`, `GOVOCAL.md`, and anything outside `prototypes/` are **never** copied to `/dist`.

## Deployment

- **Host:** Cloudflare Pages (project `govocal-prototypes`) — build `node build.js`, output `dist`.
- **CI:** push to `main` → `.github/workflows/deploy.yml` builds + deploys. Needs repo secrets
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `SUBMODULE_PAT` (reads the private
  submodules). `.gitmodules` URLs must stay **HTTPS** for the PAT to work.
- **Access control:** auth gate in `src/_worker.js`.
