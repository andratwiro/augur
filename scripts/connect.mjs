#!/usr/bin/env node
/**
 * augur connect — pair this machine with a browser you are already signed in to.
 *
 * `C-cli-connect-device-flow`. `augur login` asks for an email and a password, which puts
 * a human credential into a terminal, a shell history, and quite possibly an agent
 * transcript. This asks for neither: it prints a code, you type that code into a browser
 * that already has your session, and the token approval mints comes back here.
 *
 *   npx @augurworks/augur connect [--origin https://your.site]
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
// `--no-wait`: print the line to relay and exit at once. For an agent that talks to its
// person through messages rather than a terminal — a chat, a ticket, a print-mode run —
// waiting here is a dead end: the person cannot see the code until the command ends, and
// the command does not end until the person acts. The pairing is kept on this machine, so
// `augur connect` run again after the approval collects the token, minting no new code.
const NO_WAIT = argv.includes("--no-wait");
const PENDING_FILE = path.join(os.homedir(), ".config", "augur", "pairing.json");
const host = new URL(ORIGIN).host;
function readPending() {
  try {
    const all = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
    const p = all[host];
    return p && p.code && p.deviceSecret && Date.parse(p.expiresAt) > Date.now() ? p : null;
  } catch (e) { return null; }
}
function writePending(p) {
  mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  let all = {};
  try { all = JSON.parse(readFileSync(PENDING_FILE, "utf8")); } catch (e) {}
  if (p) all[host] = p; else delete all[host];
  writeFileSync(PENDING_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

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

// A pairing this machine already started and nobody has collected: ask once whether it
// was approved meanwhile, and if not, keep waiting on THAT code rather than minting a
// second one for the same person to type.
const pending = readPending();
if (pending) {
  const res = await post("claim", { code: pending.code, deviceSecret: pending.deviceSecret });
  if (res.status === 200 && res.json && res.json.token) {
    writePending(null);
    finish(res.json);
  } else if (res.status === 202) {
    log(`the pairing started earlier is still waiting to be approved.`);
  } else {
    writePending(null);
  }
}
const start = readPending() ? { status: 200, json: { ...readPending(), expiresInMs: Date.parse(readPending().expiresAt) - Date.now() } } : await post("start");
if (start.status === 429) die("too many attempts from here. Wait a few minutes.");
if (start.status !== 200 || !start.json || !start.json.code) {
  // The routes answer as though they are not there when the instance has not opted in,
  // so this is the message that has to name the setting rather than the status code.
  die(`this instance has not switched device pairing on.\n`
    + `  Add "devicePairing": true to its deploy.config.json and redeploy, or use \`augur login\`.\n`
    + `  (${ORIGIN} answered ${start.status})`);
}

const { code, deviceSecret, approveUrl, expiresInMs } = start.json;
const mins = Math.max(1, Math.round((expiresInMs || 300000) / 60000));
const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
if (!readPending()) writePending({ code, deviceSecret, approveUrl, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (expiresInMs || 300000)).toISOString() });

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
if (NO_WAIT) {
  console.log(`  ${C.dim}Not waiting. Once they have approved, run \`augur connect\` again here: it collects the`);
  console.log(`  token for this same code and mints no new one.${C.off}`);
  process.exit(0);
}
console.log(`  ${C.dim}You can stop waiting (Ctrl-C) and run \`augur connect\` again after they approve —`);
console.log(`  it collects the token for this same code. Talking to your person through messages`);
console.log(`  rather than a terminal? Use \`augur connect --no-wait\`.${C.off}`);
console.log("");

const deadline = Date.now() + (expiresInMs || 300000);
let saved = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const res = await post("claim", { code, deviceSecret });
  if (res.status === 200 && res.json && res.json.token) { saved = res.json; break; }
  if (res.status === 202) continue;          // still waiting for somebody to approve
  if (res.status === 404) { writePending(null); die("this pairing is no longer valid. Run `augur connect` again."); }
}
if (!saved) { writePending(null); die(`nobody approved it within ${mins} minutes. Run \`augur connect\` again.`); }
writePending(null);
finish(saved);

function finish(saved) {

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
  process.exit(0);
}
