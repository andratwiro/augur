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
the runtime-config pattern: `src/_worker.js` ships verbatim (no build-time
stamping); `build.js` emits the value into `dist/__config/instance.json` from the
shell's `deploy.config.json`, and the worker reads it in `loadConfig()` (grep
`src/_worker.js` for `loadConfig` or `rtOrigin` to see a complete example).

## Dev loop

```bash
git clone https://github.com/andratwiro/augur.git && cd augur
mkdir -p ../demo && cd ../demo     # a space = a SIBLING dir of augur with a space.json at its root
echo '{ "id": "demo", "name": "Demo", "default": true }' > space.json
mkdir -p hello/prototypes/hello && echo '<h1>hi</h1>' > hello/prototypes/hello/index.html
cd ../augur
GV_SPACES_ROOT=.. node build.js   # full static build → dist/
npm run offline                   # live preview + real worker, ~1s hot reload
                                  # (offline scans augur's sibling dirs for space.json files —
                                  # keep the demo a direct sibling, not nested deeper)
```

## PR guidelines

- Small, focused changes; explain the failure or gap the change closes.
- **Don't break the minimal instance.** A DS-less space (no `registry.json`, no
  `skills/`) and a one-line `deploy.config.json` (`siteOrigin` only) must keep
  building — that contract is what makes fresh instances cheap.
- No secrets, tokens, or instance URLs in code, tests, or fixtures.
- Not sure it's engine-shaped? Open an issue first and ask.
