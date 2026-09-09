#!/usr/bin/env node
// augur — one entry for the platform commands.
//
//   augur dev       full local shell in the current space folder (or workspace root)
//   augur build     compose dist/ once
//   augur deploy    build + direct-upload the whole site (see deploy.mjs)
//   augur publish   publish only, without committing or pushing (see publish.mjs)
//   augur fork      copy a published artifact to a new URL, moving no bytes (see fork.mjs)
//   augur status    what is live vs what your clones hold (see status.mjs)
//   augur refine    render every component, photograph it, measure it against the
//                   original, and report a pass-rate nobody can assert (see refine.mjs)
//   augur ls        the opportunities this workspace serves, or one opportunity's prototypes
//   augur open      open one prototype into a folder of its own, live at once
//   augur save      push every changed file in this draft folder
//   augur land      replace the prototype's main with this draft
//   augur sync      fold what landed on main since this draft opened into the draft
//   augur close     remove a draft folder — the one named, or this one (see docs/drafts-that-land.md)
//   augur read      a read-only copy of a prototype, for context
//   augur watch     save this draft folder on every burst of changes
//   augur hook      the agent tool's hooks: pre|post (stdin), install|remove|status
//   augur export    take an off-Cloudflare copy of the store (see export.mjs)
//   augur restore   put a copy back (see restore.mjs)
//   augur migrate   move a workspace to another instance, and prove it arrived
//   augur freeze    make a workspace read-only while it is being moved
//   augur thaw      accept writes again, and print how long the freeze lasted
//
// Each subcommand is its own script with its own --help-worthy header; this
// router only dispatches, so `node scripts/<name>.mjs` keeps working too.
//
// Two things the router does for every verb: it accepts `--origin <url>` (the flag the
// front door teaches on `connect`) and hands it to the verb as AUGUR_ORIGIN, and it refuses
// with one sentence when the shell's own folder is gone — see lib/cli-args.mjs for both.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { takeOrigin, cwdGone } from "./lib/cli-args.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const gone = cwdGone();
if (gone) { console.error(`\x1b[31m[augur]\x1b[0m ${gone}`); process.exit(1); }
const sub = process.argv[2];
const { rest, origin, error: originError } = takeOrigin(process.argv.slice(3));
if (originError) { console.error(`\x1b[31m[augur]\x1b[0m ${originError}`); process.exit(1); }
const map = {
  init: "init.mjs",
  dev: "dev.mjs",
  offline: "offline.mjs",
  deploy: "deploy.mjs",
  publish: "publish.mjs",
  // The one publishing verb that needs no tree: two paths and a token (see fork.mjs).
  fork: "fork.mjs",
  status: "status.mjs",
  refine: "refine.mjs",
  // The opportunities this workspace serves, or one opportunity's prototypes — read live so
  // an agent finds a name instead of guessing one.
  ls: "ls.mjs",
  // Drafts that land (docs/drafts-that-land.md): one prototype, one folder, live at once.
  open: "open.mjs",
  save: "save.mjs",
  land: "land.mjs",
  sync: "sync.mjs",
  close: "close.mjs",
  read: "read.mjs",
  watch: "watch.mjs",
  // The agent tool's hooks (deny outside a draft, save after an edit) and their install.
  hook: "hook.mjs",
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
  "identity-rekey": "identity-rekey.mjs",
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
// Two verbs that are gone, answered rather than dropped: a person or an agent following an
// older note lands on one sentence saying where the work went, not on "unknown command".
if (sub === "ship") {
  console.error("augur ship is retired. A prototype is changed by opening it: `augur open <opportunity>/<prototype>`, edit, `augur land` (engine agents/drafts.md). A workspace without a unit store still publishes a tree with `augur publish`.");
  process.exit(1);
}
if (sub === "mark") {
  console.error("augur mark is retired: a draft IS the mark. `augur open <prototype>` tells you who else has it open, and `augur status` lists what is open on this machine.");
  process.exit(1);
}
if (!map[sub]) {
  console.error("usage: augur <init|dev|offline|build|deploy|publish|fork|status|canon|refine|ls|open|save|land|sync|close|read|watch|hook|clone|pull|export|restore|migrate|bundle-rekey|identity-rekey|adopt|freeze|thaw|connect|login> [options] [--origin https://your.site]");
  process.exit(sub ? 1 : 0);
}
const child = spawn(process.execPath, [path.join(SCRIPTS, map[sub]), ...rest], {
  stdio: "inherit",
  // `clone` and `pull` share a script; the verb is how it knows which one was asked for.
  env: {
    ...process.env,
    // An explicit `--origin` beats the environment, the pairing file and the space folder.
    ...(origin ? { AUGUR_ORIGIN: origin } : {}),
    AUGUR_CLONE_MODE: sub === "pull" ? "pull" : "clone",
    // Which verb was typed, for the two scripts that serve two of them.
    AUGUR_CMD: sub,
  },
});
child.on("close", (code) => process.exit(code ?? 0));
