#!/usr/bin/env node
/**
 * augur connect — pair this machine with a browser you are already signed in to.
 *
 * `C-cli-connect-device-flow`. `augur login` asks for an email and a password, which puts
 * a human credential into a terminal, a shell history, and quite possibly an agent
 * transcript. This asks for neither: it prints a code, you type that code into a browser
 * that already has your session, and the token approval mints comes back here.
 *
 *   npx augur connect [--origin https://your.site]
 *
 * `augur login` stays for CI and scripts, where there is no browser to type into.
 *
 * WHAT THIS PROCESS NEVER HOLDS: your password. What it does hold, briefly, is a device
 * secret that authorises collecting the token — printed nowhere, kept in memory, and dead
 * five minutes after `start`.
 */
import path from "node:path";
import os from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolveOrigin } from "./lib/store.mjs";

const C = { dim: "\x1b[2m", bold: "\x1b[1m", ok: "\x1b[32m", warn: "\x1b[33m", off: "\x1b[0m" };
const log = (m) => console.log(`\x1b[35m[connect]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[connect] ${m}\x1b[0m`); process.exit(1); };

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const ORIGIN = (opt("--origin") || process.env.AUGUR_ORIGIN || resolveOrigin() || "").replace(/\/$/, "");
if (!ORIGIN) die("no origin — pass --origin https://your.site, or set AUGUR_ORIGIN.");

const POLL_MS = 2000;

async function post(pathPart, body) {
  const r = await fetch(`${ORIGIN}/__publish/_pair/${pathPart}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}

const start = await post("start");
if (start.status === 429) die("too many attempts from here. Wait a few minutes.");
if (start.status !== 200 || !start.json || !start.json.code) {
  // The routes answer as though they are not there when the instance has not opted in,
  // so this is the message that has to name the setting rather than the status code.
  die(`this instance has not switched device pairing on.\n`
    + `  Add "devicePairing": true to its deploy.config.json and redeploy, or use \`augur login\`.\n`
    + `  (${ORIGIN} answered ${start.status})`);
}

const { code, deviceSecret, approveUrl, expiresInMs } = start.json;
const mins = Math.round((expiresInMs || 300000) / 60000);
const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

// Written to be RELAYED, not read: the usual runner of this command is an agent, which
// pastes the first line to a person. So the first line is the whole instruction, and it
// names who has to act — the owner of the workspace, in a browser they are already in.
console.log("");
console.log(`  Ask the owner of this workspace to open ${C.bold}${approveUrl}${C.off} and enter ${C.bold}${pretty}${C.off}.`);
console.log("");
console.log(`  ${C.dim}Send them that line as it is. They open it in a browser they are already signed in`);
console.log(`  to; nothing is typed here, and nobody is asked for a password.`);
console.log(`  The code is good for ${mins} minutes and only for this terminal. Waiting…${C.off}`);
console.log("");
console.log(`  ${C.warn}If you did not just run this command, do not approve it.${C.off}`);
console.log("");

const deadline = Date.now() + (expiresInMs || 300000);
let saved = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const res = await post("claim", { code, deviceSecret });
  if (res.status === 200 && res.json && res.json.token) { saved = res.json; break; }
  if (res.status === 202) continue;          // still waiting for somebody to approve
  if (res.status === 404) die("this pairing is no longer valid. Run `augur connect` again.");
}
if (!saved) die(`nobody approved it within ${mins} minutes. Run \`augur connect\` again.`);

const dir = path.join(os.homedir(), ".config", "augur");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "tokens.json");
let all = {};
try { all = JSON.parse(readFileSync(file, "utf8")); } catch (e) {}
// Same shape `augur login` writes, so publish/ship/status find it with no second lookup.
// `via` is the one addition: a token nobody can account for is a token nobody revokes.
all[new URL(ORIGIN).host] = {
  token: saved.token, space: saved.space, via: "connect", at: new Date().toISOString(),
  ...(saved.expiresAt ? { expiresAt: saved.expiresAt } : {}),
};
writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });

log(`${C.ok}paired — publish access: ${saved.space === "*" ? "all spaces" : saved.space}${C.off}`);
console.log(`ready — \`augur publish\` will now use this token for ${ORIGIN}`);
if (saved.expiresAt) {
  const days = Math.max(0, Math.round((Date.parse(saved.expiresAt) - Date.now()) / 86400000));
  console.log(`${C.dim}It expires in ${days} days (${saved.expiresAt.slice(0, 10)}). Run \`augur connect\` again then.${C.off}`);
} else {
  console.log(`${C.dim}It expires on its own. Run \`augur connect\` again when it does.${C.off}`);
}
