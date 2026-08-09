#!/usr/bin/env node
// augur — one entry for the platform commands.
//
//   augur dev       full local shell in the current space folder (or god-mode root)
//   augur build     compose dist/ once
//   augur deploy    build + direct-upload the whole site (see deploy.mjs)
//   augur ship      commit + publish + push — the default way a change goes out
//   augur publish   publish only, without committing or pushing (see publish.mjs)
//   augur status    what is live vs what your clones hold (see status.mjs)
//   augur export    take an off-Cloudflare copy of the store (see export.mjs)
//   augur restore   put a copy back (see restore.mjs)
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
  dev: "dev.mjs",
  offline: "offline.mjs",
  deploy: "deploy.mjs",
  ship: "ship.mjs",
  publish: "publish.mjs",
  status: "status.mjs",
  export: "export.mjs",
  restore: "restore.mjs",
  login: "login.mjs",
  build: path.join("..", "build.js"),
};
if (!map[sub]) {
  console.error("usage: augur <ship|dev|offline|build|deploy|publish|status|export|restore|login> [options]");
  process.exit(sub ? 1 : 0);
}
const child = spawn(process.execPath, [path.join(SCRIPTS, map[sub]), ...rest], { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
