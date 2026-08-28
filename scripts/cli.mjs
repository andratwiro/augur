#!/usr/bin/env node
// augur — one entry for the platform commands.
//
//   augur dev       full local shell in the current space folder (or workspace root)
//   augur build     compose dist/ once
//   augur deploy    build + direct-upload the whole site (see deploy.mjs)
//   augur ship      commit + publish + push — the default way a change goes out
//   augur publish   publish only, without committing or pushing (see publish.mjs)
//   augur fork      copy a published artifact to a new URL, moving no bytes (see fork.mjs)
//   augur status    what is live vs what your clones hold (see status.mjs)
//   augur refine    render every component, photograph it, measure it against the
//                   original, and report a pass-rate nobody can assert (see refine.mjs)
//   augur mark      say what you are about to work on; read what everyone else is
//   augur export    take an off-Cloudflare copy of the store (see export.mjs)
//   augur restore   put a copy back (see restore.mjs)
//   augur migrate   move a workspace to another instance, and prove it arrived
//   augur freeze    make a workspace read-only while it is being moved
//   augur thaw      accept writes again, and print how long the freeze lasted
//
// Each subcommand is its own script with its own --help-worthy header; this
// router only dispatches, so `node scripts/<name>.mjs` keeps working too.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const sub = process.argv[2];
const rest = process.argv.slice(3);
const map = {
  init: "init.mjs",
  dev: "dev.mjs",
  offline: "offline.mjs",
  deploy: "deploy.mjs",
  ship: "ship.mjs",
  publish: "publish.mjs",
  // The one publishing verb that needs no tree: two paths and a token (see fork.mjs).
  fork: "fork.mjs",
  status: "status.mjs",
  refine: "refine.mjs",
  mark: "mark.mjs",
  export: "export.mjs",
  restore: "restore.mjs",
  login: "login.mjs",
  connect: "connect.mjs",
  clone: "clone.mjs",
  // Same script again: `thaw` is `freeze` in the other direction, and one file is what
  // keeps the two from disagreeing about which paths a freeze closes.
  freeze: "freeze.mjs",
  thaw: "freeze.mjs",
  migrate: "migrate.mjs",
  // NOT a migration either, and the third name in this neighbourhood on purpose: a re-key
  // moves one workspace's content onto the store's workspace segment WITHOUT it leaving the
  // instance, the bucket, or its own hostname. `migrate` cannot do it — it is
  // origin-addressed and a restore lands every space at v1, which would strand the history.
  "bundle-rekey": "bundle-rekey.mjs",
  // NOT a synonym for migrate, and the names are kept apart on purpose: migrate MOVES a
  // workspace to another instance, adopt copies THIS instance's KV into its own object.
  adopt: "adopt.mjs",
  // Same script: `pull` is `clone` with a three-way merge instead of an overwrite, and one
  // file is what keeps the URL→source mapping from being written twice.
  pull: "clone.mjs",
  // The canon: resolve a canonical name to files, and promote a working screen into it.
  canon: "canon.mjs",
  build: path.join("..", "build.js"),
};
if (!map[sub]) {
  console.error("usage: augur <init|ship|dev|offline|build|deploy|publish|fork|status|canon|refine|mark|clone|pull|export|restore|migrate|bundle-rekey|adopt|freeze|thaw|connect|login> [options]");
  process.exit(sub ? 1 : 0);
}
const child = spawn(process.execPath, [path.join(SCRIPTS, map[sub]), ...rest], {
  stdio: "inherit",
  // `clone` and `pull` share a script; the verb is how it knows which one was asked for.
  env: {
    ...process.env,
    AUGUR_CLONE_MODE: sub === "pull" ? "pull" : "clone",
    // Which verb was typed, for the two scripts that serve two of them.
    AUGUR_CMD: sub,
  },
});
child.on("close", (code) => process.exit(code ?? 0));
