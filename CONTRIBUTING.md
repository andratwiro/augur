# Contributing to Augur

PRs are welcome — and they're the *intended* way to change the engine, even for
people running their own instance. Augur's whole update model depends on it:

- **Instances pin this engine** and take updates by moving the pin (see
  [templates/](./templates/)). A patched local copy or a long-lived private fork
  strands your instance off that update train — and keeps your fix from every
  other instance.
- So: **fork to PR, not to deploy.** A fork is the vehicle for sending a change
  here; your instance keeps deploying from the public engine and picks your fix
  up with its next pin bump, like everyone else.

## What belongs where

The contribution filter, in one table:

| Change | Belongs in |
|---|---|
| Build, worker, overlays, canvas, offline tooling | **this repo** |
| Your site's origin, realtime worker URL, redirects, MCP hosts, AI-builder prompts | your shell's `deploy.config.json` |
| Your users + passwords | your shell's `identity.json` |
| Space name, default/adminOnly flags, design-system override, ignores, the exact MCP hosts its own prototypes need (`mcpAllowlists`) | the space's `space.json` |

If a PR hardcodes a URL, a product name, or any single instance's value into the
engine, it will be asked to move that value into config. New worker knobs follow
the existing pattern: a placeholder constant in `src/_worker.js`, injected at
build from the deploy config, presence-checked in `build.js` (grep for
`RT_ORIGIN` to see a complete example).

## Dev loop

```bash
git clone https://github.com/andratwiro/augur.git && cd augur
mkdir -p ../spaces/demo && cd ../spaces/demo
echo '{ "id": "demo", "name": "Demo", "default": true }' > space.json
mkdir -p hello/prototypes/hello && echo '<h1>hi</h1>' > hello/prototypes/hello/index.html
cd ../../augur
GV_SPACES_ROOT=../spaces node build.js   # full static build → dist/
npm run offline                          # live preview + real worker, ~1s hot reload
```

## PR guidelines

- Small, focused changes; explain the failure or gap the change closes.
- **Don't break the minimal instance.** A DS-less space (no `registry.json`, no
  `skills/`) and a one-line `deploy.config.json` (`siteOrigin` only) must keep
  building — that contract is what makes fresh instances cheap.
- No secrets, tokens, or instance URLs in code, tests, or fixtures.
- Not sure it's engine-shaped? Open an issue first and ask.
