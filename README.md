# Augur

The build/deploy platform for the Go Vocal prototyping site. Augur **composes** a single git
submodule and is the only thing that builds + ships the live site:

- **`gv-workspace/`** (the one submodule) — the merged design system **and** prototypes,
  organized into **spaces** (`spaces/<id>/`). Each space is a self-contained bundle: its own
  `.gv-*` tokens, primitives, CSS/JS, galleries (`base/ components/ pages/ patterns/
  registry.json`) **plus** its opportunity/prototype folders, a `playground/`, and a
  `space.json`. Augur reads everything per space. (The old separate `gv-design-system`
  submodule is **retired** — the DS now lives inside gv-workspace, per space.)

> The GitHub repo is `andratwiro/augur`; the Cloudflare Pages project is still named
> `govocal-prototypes` (URL `https://govocal-prototypes.pages.dev`).

## Quick start

```bash
git clone --recurse-submodules git@github.com:andratwiro/augur.git
cd augur
node build.js        # generate /dist from the gv-workspace submodule (all spaces)
npm run dev          # build + serve dist locally at http://localhost:3000
```

For live-reload local preview against an editable sibling clone, use `npm run offline`
(http://localhost:8788) — see [CLAUDE.md](./CLAUDE.md).

## Structure

```
augur/
├── build.js                 # composes the submodule → generates /dist + index.html (every space)
├── CLAUDE.md                # conventions (read this)
├── src/_worker.js           # Cloudflare worker: auth gate, KV status/comments, space routing
├── pitis/                   # the Pitis overlay layer + its build addon
├── scripts/                 # platform scripts: offline, shoot (posters), og, review (comments)
└── gv-workspace/            # the ONLY submodule — spaces/<id>/ (DS assets + opportunities)
```

## Adding a prototype

Prototypes (and the design system) live in the **gv-workspace** repo, not here — under a space
at `gv-workspace/spaces/<id>/`. Edit gv-workspace in its **own standalone clone**, then push to
its `main`. **There is no manual pin step:** a push to gv-workspace fires a `workspace-updated`
dispatch that auto-bumps Augur's submodule pin and deploys (~1 min). See [CLAUDE.md](./CLAUDE.md).

## Important

Only files inside `prototypes/` folders (under a space in `gv-workspace/spaces/<id>/`) are
published. `research.md`, `context.md`, `GOVOCAL.md`, and anything outside `prototypes/` are
**never** copied to `/dist`.

## Deployment

- **Host:** Cloudflare Pages (project `govocal-prototypes`) — build `node build.js`, output `dist`.
- **CI:** push to `main` → `.github/workflows/deploy.yml` builds + deploys. The
  gv-workspace→Augur auto-bump bridge (`workspace-bump.yml` here, `deploy-trigger.yml` in
  gv-workspace) keeps the pin current. Needs repo secrets `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, `SUBMODULE_PAT` (reads the private submodule), plus `AUGUR_PIN_TOKEN`
  for the auto-bump commit. `.gitmodules` URL must stay **HTTPS** for the PAT to work.
- **Access control:** per-user login gate in `src/_worker.js`.
