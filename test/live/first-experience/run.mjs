#!/usr/bin/env node
// test/live/first-experience/run.mjs — a fresh agent, a clueless human, a real workspace.
//
//   node test/live/first-experience/run.mjs <variant> [--human owner|viewer] [--turns 10]
//
// Variants: new (build a new prototype) · change (change an existing one) · collide
// (change one while someone else lands on it mid-way).
//
// The AGENT is a real `claude -p` session started in an empty folder outside any Augur
// checkout, with nothing but the workspace link and the task. It inherits none of this
// suite's environment (no LIVE_*, no AUGUR_*), so every credential it ends up with, it
// obtained the way a stranger would.
// The HUMAN is a second `claude -p` session with a persona prompt and two tools, a
// browser and an inbox, both of which act as a signed-in member of the workspace.
// This script relays their messages and records everything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORIGIN, UNITS, RUN, workDir, now } from "../env.mjs";
import { human } from "../persona.mjs";
import { open, writeFile, readFile, stamp, save, land, close } from "../drills/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const variant = argv[0] || "change";
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const HUMAN = opt("--human", "owner");
const MAX_TURNS = Number(opt("--turns", 10));
// --cold: the agent runs inside a container built from ./cold/Dockerfile — a machine with
// no engine clone, no saved tokens, no registry and no memory. Without it the agent runs
// on this machine, where all of those exist, and the run measures something else.
const COLD = argv.includes("--cold");
const origin = ORIGIN();
const unit = UNITS()[3];
const unitUrl = `${origin}${unit}`;

const TASKS = {
  new: `Here is my team's prototype workspace: ${origin} — please build a small new prototype of a "survey results" page (a heading, a few example questions with bar charts, any reasonable design) and send me the link when it is live so the team can open it.`,
  change: `Here is my team's prototype workspace: ${origin} — in the prototype at ${unitUrl} please change the main heading so it ends with "(reviewed ${RUN})", and send me the link when the change is live.`,
  collide: `Here is my team's prototype workspace: ${origin} — in the prototype at ${unitUrl} please add a short "Notes" paragraph at the end of the page saying it was reviewed on ${RUN}, and send me the link when the change is live.`,
};
const task = TASKS[variant];
if (!task) { console.error(`unknown variant ${variant}`); process.exit(2); }

// ── folders ─────────────────────────────────────────────────────────────────
const runDir = workDir(`fx-${variant}-${Date.now().toString(36)}`);
const agentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "augur-fresh-"));       // outside every checkout
const humanCwd = path.join(runDir, "human");
fs.mkdirSync(humanCwd, { recursive: true });
for (const tool of ["browser", "inbox"]) {
  const p = path.join(humanCwd, tool);
  fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "human-tools", tool + ".mjs")}" "$@"\n`);
  fs.chmodSync(p, 0o755);
}
const log = { variant, cold: COLD, human: HUMAN, task, startedAt: now(), agentCwd, turns: [], agentEvents: [], humanEvents: [] };
const logPath = path.join(runDir, "transcript.json");
const saveLog = () => fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
const say = (m) => { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`); };
const t0 = Date.now();

// The agent's environment: this machine's PATH and Claude login, none of the suite's secrets.
// Neither session may know it runs inside another Claude session, or the suite's secrets.
const strip = (env, re) => Object.fromEntries(Object.entries(env).filter(([k]) => !re.test(k)));
const agentEnv = strip(process.env, /^(LIVE_|AUGUR_|CLAUDE)/);
const humanEnv = { ...strip(process.env, /^CLAUDE/), LIVE_HUMAN: HUMAN };

// ── the cold machine ─────────────────────────────────────────────────────────
const COLD_IMAGE = "augur-cold-agent";
let coldContainer = null;
function sh(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
    if (input) p.stdin.write(input);
    p.stdin.end();
  });
}
async function coldStart() {
  const build = await sh("docker", ["build", "-q", "-t", COLD_IMAGE, path.join(HERE, "cold")]);
  if (build.code !== 0) throw new Error(`docker build: ${build.err.slice(-800)}`);
  coldContainer = `augur-cold-${Date.now().toString(36)}`;
  // The same DNS pin the host's processes run under (see pin-dns.mjs), as the container's
  // hosts file: the agent inside uses the hostname and never learns of the pin.
  const pins = (process.env.LIVE_PIN || "").split(",").map((p) => p.trim()).filter(Boolean)
    .flatMap((p) => ["--add-host", p.replace("=", ":")]);
  if (pins.length) say(`cold machine pins ${pins.filter((x) => x !== "--add-host").join(", ")} (the host's network drops that edge)`);
  const run = await sh("docker", ["run", "-d", "--name", coldContainer, "--rm", ...pins, COLD_IMAGE]);
  if (run.code !== 0) throw new Error(`docker run: ${run.err.slice(-800)}`);
  // The container needs a Claude credential that outlives the run. A long-lived token from
  // `claude setup-token` (LIVE_CLAUDE_TOKEN) is handed in as CLAUDE_CODE_OAUTH_TOKEN on each
  // exec. Without one, the host keychain's short-lived ACCESS token is copied in instead —
  // and the host revokes it when it refreshes, which killed a run mid-way once.
  if (!process.env.LIVE_CLAUDE_TOKEN) {
    say("no LIVE_CLAUDE_TOKEN: copying the host's short-lived access token (a long run may die on a 401)");
    const cred = JSON.parse((await sh("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])).out.trim());
    const o = cred.claudeAiOauth || {};
    const slim = JSON.stringify({ claudeAiOauth: { accessToken: o.accessToken, expiresAt: o.expiresAt, scopes: o.scopes, subscriptionType: o.subscriptionType } });
    const put = await sh("docker", ["exec", "-i", coldContainer, "sh", "-c", "mkdir -p ~/.claude && cat > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json"], { input: slim });
    if (put.code !== 0) throw new Error(`credentials into container: ${put.err}`);
  }
  const ver = await sh("docker", ["exec", ...(process.env.LIVE_CLAUDE_TOKEN ? ["-e", `CLAUDE_CODE_OAUTH_TOKEN=${process.env.LIVE_CLAUDE_TOKEN}`] : []), coldContainer, "claude", "--version"]);
  say(`cold machine ${coldContainer}: claude ${ver.out.trim()}`);
}
async function coldStop() { if (coldContainer) await sh("docker", ["rm", "-f", coldContainer]); }

function claude(args, { cwd, env, input, cold = false }) {
  if (cold) {
    const tok = process.env.LIVE_CLAUDE_TOKEN ? ["-e", `CLAUDE_CODE_OAUTH_TOKEN=${process.env.LIVE_CLAUDE_TOKEN}`] : [];
    return sh("docker", ["exec", "-i", ...tok, "-w", "/home/person/work", coldContainer, "claude", ...args], { input });
  }
  return new Promise((resolve) => {
    const p = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
    if (input) p.stdin.write(input);
    p.stdin.end();
  });
}

let agentSession = null, humanSession = null;

/** One agent turn: the message in, the final text out, tool events recorded. */
async function agentTurn(message) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
  if (agentSession) args.push("--resume", agentSession);
  const r = await claude(args, { cwd: agentCwd, env: agentEnv, input: message, cold: COLD });
  let text = "", result = null;
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev.type === "system" && ev.session_id) agentSession = ev.session_id;
    if (ev.session_id && !agentSession) agentSession = ev.session_id;
    if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === "tool_use") log.agentEvents.push({ at: now(), tool: c.name, input: JSON.stringify(c.input).slice(0, 400) });
        if (c.type === "text") text += c.text + "\n";
      }
    }
    if (ev.type === "result") { result = ev; if (ev.result) text = ev.result; }
  }
  if (!text.trim()) text = r.err.slice(0, 2000) || "(the assistant said nothing)";
  return { text: text.trim(), result, raw: r };
}

/**
 * One turn of the scripted person. Their tool calls are counted, because a model playing a
 * person can SAY it typed the code without ever running `./browser` — one run's person
 * reported a green "Approved" it never saw, and the agent then spent the code's whole life
 * polling for an approval that had not happened. A reply that claims an action with no
 * command behind it is sent back once, with the rule restated; the second answer stands.
 */
async function humanTurn(message, { retry = true } = {}) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
    "--allowedTools", "Bash", "--disallowedTools", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "NotebookEdit"];
  if (humanSession) args.push("--resume", humanSession);
  else args.push("--system-prompt", fs.readFileSync(path.join(HERE, "human-prompt.txt"), "utf8"));
  const r = await claude(args, { cwd: humanCwd, env: humanEnv, input: message });
  let text = "", tools = 0;
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev.session_id && !humanSession) humanSession = ev.session_id;
    if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === "tool_use") { tools++; log.humanEvents.push({ at: now(), tool: c.name, input: JSON.stringify(c.input).slice(0, 300) }); }
      }
    }
    if (ev.type === "result" && ev.result) text = ev.result;
  }
  if (!text.trim()) text = r.err.slice(0, 1000) || "(the person said nothing)";
  text = text.trim();
  // A POSITIVE claim only: "I opened it", "done", "I've typed it" — never "I have not typed",
  // "I didn't approve", "nothing to run". A person who refused, or who did nothing and said
  // so, is telling the truth and is not sent back.
  const positive = /\b(done|i (have |'ve )?(opened|typed|entered|approved|pressed|clicked|checked)|it('s| is) (done|approved)|i did it)\b/i.test(text);
  const negated = /\b(not|n't|never|nothing|no way|cannot|can't|refus\w*|won't|didn't|haven't|did not|have not)\b/i.test(text);
  const claimsAction = positive && !negated;
  if (retry && tools === 0 && claimsAction) {
    say(`human claimed an action with no command run — sending it back once`);
    log.turns.push({ n: log.turns.length ? log.turns[log.turns.length - 1].n : 0, who: "human (retracted: no command was run)", text, at: now() });
    return humanTurn("You did not run ./browser or ./inbox this turn, so you cannot have done that. "
      + "Run the command now, exactly as your assistant asked, and then tell them the exact line it printed. Never say you did something you did not run.", { retry: false });
  }
  return text;
}

// ── the collide variant: someone else lands on the same unit after the agent starts ──
let collider = null;
async function startCollider() {
  collider = await open("editor2", "fx-collider", unit, "fx-collider");
  writeFile(collider, "index.html", readFile(collider, "index.html") + "\n" + stamp(collider, "collider"));
  await save(collider);
}
async function colliderLands() {
  if (!collider) return;
  const l = await land(collider, `${RUN} collider lands mid-way`);
  log.collider = { landed: l.ok, at: now(), result: l };
  say(`collider landed: ${JSON.stringify(l).slice(0, 120)}`);
  await close(collider).catch(() => {});
}

// ── run ─────────────────────────────────────────────────────────────────────
await human(HUMAN); // the person is signed in before they ever talk to the assistant
if (COLD) await coldStart();
if (variant === "collide") await startCollider();
say(`agent starts in ${agentCwd}; human is ${HUMAN}; transcript at ${logPath}`);
let message = task;
let done = false;
for (let turn = 1; turn <= MAX_TURNS && !done; turn++) {
  const a = await agentTurn(message);
  log.turns.push({ n: turn, who: "human→agent", text: message, at: now() });
  log.turns.push({ n: turn, who: "agent", text: a.text, at: now(), cost: a.result && a.result.total_cost_usd, durationMs: a.result && a.result.duration_ms });
  saveLog();
  say(`agent (turn ${turn}): ${a.text.slice(0, 300).replace(/\n/g, " ")}`);
  if (variant === "collide" && turn === 1) await colliderLands();
  const h = await humanTurn(a.text);
  log.turns.push({ n: turn, who: "human", text: h, at: now() });
  saveLog();
  say(`human: ${h.slice(0, 300).replace(/\n/g, " ")}`);
  if (/THANKS-DONE/.test(h)) { done = true; break; }
  message = h.replace(/THANKS-DONE/g, "").trim();
}

// ── measures ────────────────────────────────────────────────────────────────
const agentTexts = log.turns.filter((t) => t.who === "agent").map((t) => t.text);
const urls = [...new Set(agentTexts.join("\n").match(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s)"'<>]*`, "g")) || [])];
const asks = log.turns.filter((t) => t.who === "agent").length;
const askedForPassword = agentTexts.some((t) => /password/i.test(t));
const askedForTechnical = agentTexts.some((t) => /\b(run|terminal|npm|npx|token|git)\b/i.test(t) && !/open .*and enter/i.test(t));
const firstFetch = log.agentEvents.find((e) => /llms\.txt|well-known|curl|fetch/i.test(e.input));
let liveCheck = null;
for (const u of urls.slice(-3)) {
  try { const r = await (await human(HUMAN)).get(new URL(u).pathname); liveCheck = { url: u, status: r.status, marked: (await r.text()).includes(RUN) }; } catch (e) { liveCheck = { url: u, error: String(e) }; }
}
log.measures = {
  elapsedMs: Date.now() - t0, turns: log.turns.filter((t) => t.who === "agent").length, humanAsks: asks - 1,
  toolCalls: log.agentEvents.length, firstFetch: firstFetch && firstFetch.input, urls, liveCheck, askedForPassword, askedForTechnical,
  done, endedAt: now(),
};
saveLog();
if (COLD) await coldStop();
console.log("\nMEASURES\n" + JSON.stringify(log.measures, null, 2));
console.log(`transcript: ${logPath}`);
