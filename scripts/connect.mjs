#!/usr/bin/env node
/**
 * augur connect — pair this machine with a browser you are already signed in to.
 *
 * `C-cli-connect-device-flow`. `augur login` asks for an email and a password, which puts
 * a human credential into a terminal, a shell history, and quite possibly an agent
 * transcript. This asks for neither: it prints a code, you type that code into a browser
 * that already has your session, and the token approval mints comes back here.
 *
 *   npx @augurworks/augur connect [--origin https://your.site] [--no-wait] [--no-open]
 *
 * Waiting, it opens the approval page on THIS machine with the code already in the field
 * (`--no-open`, or `AUGUR_NO_OPEN=1`, does not) — so where the terminal and the browser
 * are the same machine, which is the common case, the code never travels through an agent.
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
import { spawn } from "node:child_process";
import { resolveOrigin } from "./lib/store.mjs";
import { augurOnPath } from "./lib/adapters.mjs";

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
// `--no-open` (or AUGUR_NO_OPEN=1, which is the same switch for a script or a test that
// must never take over somebody's screen): do not open a browser tab here.
//
// WHY THE TAB EXISTS AT ALL. The code does not have to travel through the agent when the
// terminal and the browser are the same machine, which is the common case. Relaying one
// is a bad habit to teach — "ask your assistant to run this and read back the code" is
// the exact shape of a device-code phishing attack, and on 7 Sep 2026 an agent refused
// the whole flow on those grounds, correctly, without running anything. So this opens the
// approval page with the code already in the field and the person presses one button; the
// printed line above stays the answer for everything this cannot serve — a container with
// no opener, a remote box, a second machine, a headless run.
const NO_OPEN = argv.includes("--no-open") || process.env.AUGUR_NO_OPEN === "1";
function openApprovalPage(target) {
  // Every failure here is fine and none of them may be shown: an opener that is missing
  // (a container), refuses, or dies is a machine whose person reads the printed line.
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(cmd, [target], {
      detached: true, stdio: "ignore",
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch (e) { return false; }
}
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

// A machine that is ALREADY connected to this origin does not pair again by accident. One
// cold agent collected its token with a blocking `connect`, did not read the answer, ran
// `connect` again, minted a second code, and had the person approve that too. If the saved
// token still answers, say so and stop; `--again` pairs afresh on purpose, and a token the
// workspace no longer honours (revoked, another workspace's) falls through to a new pairing.
const AGAIN = argv.includes("--again");
// Whether this workspace serves drafts, from its own door — the success line names the
// right next verb, not `publish` on a workspace that refuses it. Asked before any path
// that can finish, including the one that collects a pairing started earlier.
let draftsHere = false;
try { const j = await (await fetch(`${ORIGIN}/.well-known/augur.json`, { headers: { Accept: "application/json" } })).json(); draftsHere = !!(j && j.drafts && j.drafts.enabled); } catch (e) { draftsHere = false; }
const TOKENS_FILE = path.join(os.homedir(), ".config", "augur", "tokens.json");
function savedToken() {
  try { const t = JSON.parse(readFileSync(TOKENS_FILE, "utf8"))[host]; return t && t.token ? t : null; } catch (e) { return null; }
}
if (!AGAIN && !process.env.AUGUR_TOKEN) {
  const saved = savedToken();
  if (saved && !(saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now())) {
    let live = false;
    try {
      const r = await fetch(`${ORIGIN}/__unit/drafts`, { headers: { Authorization: `Bearer ${saved.token}`, Accept: "application/json" } });
      live = r.status === 200;
    } catch (e) { live = false; }
    if (live) {
      log(`this machine is already connected to ${C.bold}${host}${C.off}${saved.at ? ` (since ${saved.at.slice(0, 16).replace("T", " ")})` : ""}. Nothing to approve.`);
      console.log(`  ${C.dim}\`augur open <opportunity>/<prototype>\` works from here. \`augur connect --again\` pairs afresh.${C.off}`);
      process.exit(0);
    }
  }
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
// The plain approval page, with the code in the field: one Approve and the terminal is
// paired. (Not /__welcome — the welcome flow is parked, see docs/welcome-flow.md.)
if (!NO_WAIT && !NO_OPEN && openApprovalPage(`${ORIGIN}/__connect?code=${encodeURIComponent(code)}`)) {
  console.log(`  ${C.dim}A browser tab with the code filled in should have opened on this machine; if it`);
  console.log(`  did not, send the line above.${C.off}`);
  console.log("");
}
if (NO_WAIT) {
  console.log(`  ${C.dim}Not waiting. Once they have approved, run \`augur connect\` again here: it collects the`);
  console.log(`  token for this same code and mints no new one.${C.off}`);
  process.exit(0);
}
// Run INLINE by a verb (open, land … — AUGUR_PAIR_INLINE), the wait is that verb's: the tab
// is already open on this machine, the person presses Approve, the verb carries on. The
// paragraphs for a standalone run — stop waiting, agents do not poll here — would only
// tell the agent to abandon a verb that is about to finish.
if (process.env.AUGUR_PAIR_INLINE === "1") {
  console.log(`  ${C.dim}Waiting for Approve in that tab (up to ${mins} minutes)…${C.off}`);
  console.log("");
} else {
console.log(`  ${C.dim}You can stop waiting (Ctrl-C) and run \`augur connect\` again after they approve —`);
console.log(`  it collects the token for this same code.${C.off}`);
console.log("");
// Addressed to an agent, in the second person, because the polite version above was
// read and ignored: an agent whose person only sees its messages once it finishes its
// turn kept polling here for the code's whole life, twice, and nobody ever saw the code.
console.log(`  ${C.warn}AGENTS: if your person reads your messages only after you finish, do not wait here.`);
console.log(`  Stop now, send them the first line above, and run \`augur connect\` again once they say`);
console.log(`  they have approved — it collects the token then. (\`augur connect --no-wait\` does`);
console.log(`  exactly that in one step.)${C.off}`);
console.log("");
}

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
  // Whose name every landing from this machine carries (the approver's), when the instance says.
  ...(saved.label ? { email: saved.label } : {}),
};
writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });

log(`${C.ok}paired — publish access: ${saved.space === "*" ? "all spaces" : saved.space}${saved.label ? `; landings carry ${saved.label}` : ""}${C.off}`);
// The next verb, spelled so it runs from THIS machine: `augur` after a global install, the
// package's own `npx` line otherwise — and the verb this workspace takes, which the door
// knows (drafts: open and land; a whole-tree instance: publish).
const verb = augurOnPath() ? "augur" : "npx @augurworks/augur";
if (draftsHere) {
  console.log(`ready — \`${verb} open <opportunity>/<prototype>\` opens one prototype as a draft (live at once at its own address);`);
  console.log(`        edit the folder it makes, then \`${verb} land\` in that folder: the real URL moves.`);
} else {
  console.log(`ready — \`${verb} publish\` will now use this token for ${ORIGIN}`);
}
if (verb !== "augur") console.log(`${C.dim}(\`augur\` is not on this machine's PATH; \`npm i -g @augurworks/augur\` puts it there for good.)${C.off}`);
if (saved.expiresAt) {
  const days = Math.max(0, Math.round((Date.parse(saved.expiresAt) - Date.now()) / 86400000));
  console.log(`${C.dim}It expires in ${days} days (${saved.expiresAt.slice(0, 10)}). Run \`augur connect\` again then.${C.off}`);
} else {
  console.log(`${C.dim}It expires on its own. Run \`augur connect\` again when it does.${C.off}`);
}
  process.exit(0);
}
