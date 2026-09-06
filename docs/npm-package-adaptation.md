# Adapting the engine to its npm package — what is still open

`@augurworks/augur` is on npm (6 September 2026). The maintainer's commit `eaad7707` already
renamed the package, dropped `private`, and changed the connect and clone commands in the
front door, the agents index, the seeded connect page and the `upgrade` hint. What follows
is what that commit did not reach. Each item names the file and the exact change; nothing
here is a design question.

## Every place that still says "not on npm yet"

- `src/_worker.js`, `doorText` (the `/llms.txt` text): the paragraph *"Not on npm yet? The
  engine clone sits next to every workspace that publishes: `node <engine>/scripts/cli.mjs
  connect …`"* goes. `test/agent-front-door.test.mjs` reads the door text; check it does
  not pin that sentence.
- `agents/README.md`, "Getting in": the same paragraph goes.
- `agents/publishing.md`: every `node ../augur/scripts/<x>.mjs` form exists because
  `augur` was only on PATH after `npm link`. With the package installed
  (`npm i -g @augurworks/augur`, or `npx @augurworks/augur <verb>`), the `augur <verb>` form
  is the one to print. Keep the `node …` form as the fallback for a clone-only setup, in
  one sentence, not as the headline. `README.md` has one such line (the local preview).

## The editor hooks (slice 3)

- `scripts/lib/adapters.mjs`, `hookCommand`: the hook installed into the tool's settings is
  `node "<absolute path to this clone>/scripts/hook.mjs" pre|post`. With a global install
  that path is inside the global install folder and moves on every `npm i -g`. Prefer `augur hook pre`
  when `augur` resolves on PATH (check with `which augur` at install time, or
  `process.execPath`-relative resolution of the package's own bin), else the absolute path
  as today. `mergeHooks` already replaces our entries when the command changes, so a
  re-install after an upgrade heals a stale path — `augur open` calls it on every run.
- `OURS_RE` in the same file identifies our entries by `hook.mjs" pre|post`. If the
  command becomes `augur hook pre`, widen it to match both spellings so an older entry is
  still recognised and replaced rather than duplicated.

## The instance's own engine updates

- `scripts/publish.mjs` fast-forwards a git clone of the engine when the instance speaks a
  newer protocol (`engine updated <a> → <b>`). A package install has no clone to
  fast-forward. Print the `npm i -g @augurworks/augur@<version>` line instead when
  `ENGINE_ROOT` has no `.git`. The publish tests under `test/` cover the message shapes.
- `agents/publishing.md`, "The engine is yours to maintain": the same sentence.

## What does not change

- `augur-deploy-*` shells pin the engine as a git submodule and build from it. That is a
  deploy concern, not a package one; leave it.
- The hosted worker's `/llms.txt` is served by whatever engine the shell pins, so the door
  text changes reach a live instance only with a pin bump and a deploy.
