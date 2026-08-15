// dev.mjs — the standalone local shell: run the full Augur experience (login
// gate, rail, overlays, live reload) in ANY single space folder.
//
//   cd <space repo> && augur dev        (or node <engine>/scripts/dev.mjs)
//
// A thin wrapper over offline.mjs that fills in the standalone defaults:
//   • the cwd carries a space.json → GV_SPACES_ROOT = cwd: a one-space site,
//     built at the root URLs, exactly as a hosted default space would serve
//   • no deploy shell resolves → a local dev identity (dev@local / password
//     "dev", admin) so the gate and admin panel behave like a real instance
//     instead of falling open — the "same shell as online" contract
//   • KV stays local unless real credentials are present (offline.mjs's rule)
// From a multi-space workspace (sibling spaces + shell) it degrades gracefully to
// plain offline mode semantics for the cwd space.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findShellDir } from "./lib/instance.mjs";
import { __testables } from "../src/_worker.js";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, "..");
const log = (msg) => console.error(`\x1b[35m[dev]\x1b[0m ${msg}`);

const env = { ...process.env };
const cwd = process.cwd();
if (existsSync(path.join(cwd, "space.json")) && !env.GV_SPACES_ROOT) {
  env.GV_SPACES_ROOT = cwd;
  log(`single-space mode: ${cwd}`);
}
if (!env.GV_IDENTITY_PATH && !findShellDir(ROOT)) {
  const dir = path.join(os.tmpdir(), "augur-dev");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "identity.json");
  // A real pbkdf2$… hash, not a plaintext `pass` — verifyPassword() (src/_worker.js)
  // accepts only that format, so a plaintext seed used to read as an "active" account
  // (effectiveSecret resolves it) while being unable to ever log in (verifyPassword
  // rejects it outright) — the documented dev@local / "dev" fallback 401ed, every time.
  // Derive it the same way a redeemed invite does (__testables.hashPassword is the
  // exact function invitePost calls), so the seeded account can actually authenticate.
  const passHash = await __testables.hashPassword("dev");
  writeFileSync(file, JSON.stringify([{
    email: "dev@local", name: "Dev", passHash,
    initials: "D", color: "#2c2150", role: "admin",
  }], null, 2));
  env.GV_IDENTITY_PATH = file;
  log('no deploy shell found — local dev identity active (sign in: dev@local / "dev")');
}

const child = spawn(process.execPath, [path.join(SCRIPTS, "offline.mjs")], { env, stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
