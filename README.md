# GoVocal Prototypes

A monorepo of clickable design prototypes, published to a private URL for the team.

## Quick start

```bash
node build.js        # generate /dist
npm run dev          # build + serve dist locally at http://localhost:3000
```

## Structure

```
govocal-prototypes/
├── build.js                 # scans folders → generates /dist + index.html
├── CLAUDE.md                # conventions (read this)
├── skills/
│   └── govocal-design/      # design-system skill
├── parallel-participation/
│   ├── research.md          # internal — never published
│   ├── context.md           # internal — never published
│   └── prototypes/          # publishable prototypes live here
└── departments/
    └── prototypes/
```

## Adding a prototype

1. Pick an opportunity folder (or create a new top-level one with a `prototypes/`
   subfolder).
2. Create `prototypes/<your-prototype>/index.html` (self-contained static HTML/JS).
3. Run `node build.js` and open `dist/index.html`.
4. Commit and push — Cloudflare Pages rebuilds and deploys automatically.

## Important

Only files inside `prototypes/` folders are published. `research.md`, `context.md`,
and anything outside `prototypes/` are **never** copied to `/dist`. See
[CLAUDE.md](./CLAUDE.md).

## Deployment

- **Host:** Cloudflare Pages — build command `node build.js`, output dir `dist`.
- **Access control:** Cloudflare Access (email allowlist) in front of the URL.

See the setup steps shared during scaffolding (GitHub + Cloudflare Pages + Access).
