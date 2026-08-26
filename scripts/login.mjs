// login.mjs — `augur login`: trade your existing web credentials for a publish
// token, saved to ~/.config/augur/tokens.json (keyed by origin host). Run once;
// `augur publish` picks the token up automatically after that.
//
//   augur login [--origin https://…]
//
// Credentials: AUGUR_EMAIL / AUGUR_PASSWORD env vars, else an interactive
// prompt (password input is muted). The token is never printed.

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployConfig, originHost } from "./lib/instance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (msg) => console.error(`\x1b[32m[login]\x1b[0m ${msg}`);
const opt = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };

const cwdSpaceOrigin = (() => {
  try { return JSON.parse(readFileSync(path.join(process.cwd(), "space.json"), "utf8")).siteOrigin || ""; }
  catch (e) { return ""; }
})();
const ORIGIN = (opt("--origin") || process.env.AUGUR_ORIGIN ||
  deployConfig(ROOT, originHost(cwdSpaceOrigin)).siteOrigin || cwdSpaceOrigin || "").replace(/\/+$/, "");
if (!ORIGIN) { log("no origin — pass --origin https://<your instance> (or add \"siteOrigin\" to space.json)"); process.exit(1); }

function ask(question, mute) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (mute) {
      // Mute the echo after the prompt prints: overwrite the output hook.
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => { if (s.includes(question)) write(s); };
    }
    rl.question(question, (answer) => { rl.close(); if (mute) process.stderr.write("\n"); resolve(answer.trim()); });
  });
}

const email = process.env.AUGUR_EMAIL || (await ask("Email: "));
const password = process.env.AUGUR_PASSWORD || (await ask("Password: ", true));
if (!email || !password) { log("email + password required."); process.exit(1); }

const r = await fetch(`${ORIGIN}/__publish/_login/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!r.ok) {
  const err = await r.text().catch(() => "");
  // The server distinguishes "wrong password" from "this account was reset". Surface the
  // second as prose — otherwise a reset user reads `bad-credentials` and goes hunting for
  // a typo in a password that no longer exists.
  let parsed = null;
  try { parsed = JSON.parse(err); } catch {}
  if (parsed && parsed.message) log(parsed.message);
  else log(`login failed (${r.status}): ${err.slice(0, 200)}`);
  process.exit(1);
}
const { token, space, expiresAt } = await r.json();

const dir = path.join(os.homedir(), ".config", "augur");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "tokens.json");
let all = {};
try { all = JSON.parse(readFileSync(file, "utf8")); } catch (e) {}
// `expiresAt` is stored as well as printed: a line in a terminal is gone by the time it
// matters, and the file is what a later command can read to say "this ran out yesterday"
// instead of "forbidden". An older instance sends none, and none means it does not expire.
all[new URL(ORIGIN).host] = {
  token, space, email, at: new Date().toISOString(),
  ...(expiresAt ? { expiresAt } : {}),
};
writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
log(`signed in as ${email} — publish access: ${space === "*" ? "all spaces" : space}`);
console.log(`ready — \`augur publish\` will now use this login for ${ORIGIN}`);
if (expiresAt) {
  const days = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 86400000));
  console.log(`\x1b[2mit expires in ${days} days (${expiresAt.slice(0, 10)}) — run \`augur login\` again then\x1b[0m`);
}
