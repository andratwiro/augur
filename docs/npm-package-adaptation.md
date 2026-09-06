# Adapting the engine to its npm package — a note for the next agent

`@augurworks/augur@0.15.1` is on npm (published 6 September 2026 by the maintainer). Until
that day every contract, message and hook in this repo assumed the engine was a git clone
sitting beside a workspace. This note lists what that assumption touched, so one pass
brings the repo in line. Each item names the file and the exact change; nothing here is a
design question.

## The package itself

- `package.json`: `name` is still `"augur"` and `"private": true`. The published package is
  `@augurworks/augur`. Set the name, drop `private`, and delete the test that pins it —
  `test/npm-package-selfsufficient.test.mjs`, the case *"it is still marked private, so
  nobody publishes it before the name is settled"* — in the same commit, as that test's own
  message asks. The `bin` stays `augur`, so `npx @augurworks/augur <verb>` runs it.
- Check `files` in `package.json` still names everything the CLI needs at runtime: `src/`,
  `scripts/`, `build.js`, `seed/`, `agents/`, `templates/`. The new `src/drafts/`,
  `src/galleries.mjs` and `scripts/lib/adapters.mjs` live under folders already listed.

## Every place that says "not on npm yet"

- `src/_worker.js`, `doorText` (the `/llms.txt` text): the paragraph *"Not on npm yet? The
  engine clone sits next to every workspace that publishes: `node <engine>/scripts/cli.mjs
  connect …`"* goes. The connect line above it is `npx augur connect --origin …` in
  `doorFacts` — change it to `npx @augurworks/augur connect --origin …`, and the
  `/.well-known/augur.json` `connect` fact with it. `test/agent-front-door.test.mjs` pins
  both strings.
- `agents/README.md`, "Getting in": the same two changes (`npx @augurworks/augur connect`,
  drop the "not on npm yet" sentence), and `npx augur clone --space <id>` →
  `npx @augurworks/augur clone --space <id>`.
- `src/seed-pack.mjs` and `scripts/lib/seed-pack-build.mjs`: the seeded connect page's
  `CONNECT_COMMAND` slot is filled at provision with `npx augur connect --origin …`
  (search for `npx augur`). Same rename. The seed pack is rebuilt on every engine build,
  so the change ships with the next pin bump.
- `agents/publishing.md`: every `node ../augur/scripts/<x>.mjs` form exists because
  `augur` was only on PATH after `npm link`. With the package installed
  (`npm i -g @augurworks/augur`, or `npx @augurworks/augur`), the `augur <verb>` form is
  the one to print. Keep the `node …` form as the fallback for a clone-only setup, in one
  sentence, not as the headline.
- `scripts/init.mjs` scaffold paragraph and its final "next:" line, `README.md`,
  `INSTALL.md` (search `augur ship`, `npm link`, `node ../augur`): same rename.

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
