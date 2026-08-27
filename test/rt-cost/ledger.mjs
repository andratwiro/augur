/* The shared instrument: read RTCOST lines off a runtime, turn them into residency.
 *
 * Both drivers use this — the scripted one (measure.mjs) and the two-real-browsers one
 * (browser.mjs) — so a number from either is computed by the same arithmetic and a
 * disagreement between them is a disagreement about the SESSION, never about the ruler.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const ANSI = /\x1b\[[0-9;]*m/g;

export function makeLedger() {
  const records = [];
  function feedLine(line) {
    const clean = line.replace(ANSI, "");
    const m = clean.match(/RTCOST (\{.*\})/);
    if (m) { try { records.push({ ...JSON.parse(m[1]), host: Date.now() }); } catch (e) {} return; }
    // `wrangler tail --format json` wraps console output in an event envelope.
    if (clean.startsWith("{")) {
      try {
        const ev = JSON.parse(clean);
        for (const l of ev.logs || []) for (const part of l.message || []) {
          const mm = String(part).match(/RTCOST (\{.*\})/);
          if (mm) { try { records.push({ ...JSON.parse(mm[1]), host: Date.now() }); } catch (e) {} }
        }
      } catch (e) {}
    }
  }
  function pipe(child) {
    let buf = "";
    const on = (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { feedLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", on);
    child.stderr.setEncoding("utf8"); child.stderr.on("data", on);
  }
  return { records, feedLine, pipe };
}

// Start the local runtime and wait for the realtime worker's own health answer, which is
// a stronger readiness signal than a line of wrangler's output.
export async function startLocalRuntime({ cwd, config, port, ledger }) {
  const env = { ...process.env };
  // A local rehearsal must not be able to reach an account, even by accident.
  for (const k of Object.keys(env)) if (k.startsWith("CLOUDFLARE_")) delete env[k];
  const child = spawn("npx", ["wrangler", "dev", "-c", config, "--port", String(port), "--inspector-port", "0"], {
    cwd, env, stdio: ["ignore", "pipe", "pipe"],
  });
  ledger.pipe(child);
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok && (await r.json()).ok) return child;
    } catch (e) {}
  }
  try { child.kill("SIGTERM"); } catch (e) {}
  throw new Error("local runtime never came up");
}

// The same ledger off a DEPLOYED worker. Keeps the account credentials the local starter
// strips, and cannot be pointed at anything the caller did not name.
export async function startTailRuntime({ cwd, name, ledger }) {
  const child = spawn("npx", ["wrangler", "tail", name, "--format", "json"], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  ledger.pipe(child);
  // ⚠️ ECHO THE FIRST SECONDS. A tail that never connects — a missing token permission is
  // the usual reason — is silent, and a silent ledger reads downstream as "the room did
  // nothing", which is a verdict about the pipe wearing the clothes of a verdict about
  // the room. This is the only place that failure is visible, so it is not swallowed.
  const echo = (c) => process.stdout.write("  tail| " + String(c).trimEnd().slice(0, 400) + "\n");
  child.stdout.on("data", echo);
  child.stderr.on("data", echo);
  await sleep(8000);
  child.stdout.off("data", echo);
  child.stderr.off("data", echo);
  return child;
}

// ---- residency ------------------------------------------------------------
// A wake is bounded by `ctor`: the runtime constructs the class exactly once per
// residency, so no ctor between two events means the object never left memory.
export function wakes(records) {
  const rs = records.slice().sort((a, b) => a.t - b.t);
  const out = [];
  for (const r of rs) {
    if (r.ev === "ctor" || !out.length) out.push({ from: r.t, to: r.t, events: 0, inst: r.inst });
    const w = out[out.length - 1];
    w.to = r.t;
    w.events++;
  }
  return out;
}

// Handler occupancy: every `<kind>:in` paired with the next `<kind>:out`. A LOWER bound —
// a Worker's clock does not advance during synchronous execution, so a handler that does
// no I/O reads as 0ms here however much CPU it burned.
export function handlerMs(records) {
  const open = new Map();
  let total = 0, n = 0;
  for (const r of records.slice().sort((a, b) => a.t - b.t)) {
    const [kind, phase] = String(r.ev).split(":");
    if (phase === "in") open.set(kind, r.t);
    else if (phase === "out" && open.has(kind)) { total += r.t - open.get(kind); open.delete(kind); n++; }
  }
  return { handlerMs: total, invocations: n };
}

export function activeMs(records, graceMs) {
  const ws = wakes(records);
  const span = ws.reduce((a, w) => a + (w.to - w.from), 0);
  return { wakes: ws.length, observedSpanMs: span, graceMs, awakeMs: span + ws.length * graceMs, ...handlerMs(records), windows: ws };
}

export function tally(rs) {
  const t = {};
  for (const r of rs) { const k = r.ev + (r.k ? ":" + r.k : ""); t[k] = (t[k] || 0) + 1; }
  return t;
}

// The raw record, one event per line. It is the evidence behind every derived number, so
// it is kept whole rather than summarised — but pretty-printing ten thousand four-field
// objects costs four times the bytes and reads no better, so it goes out as JSONL with the
// run's own description as the first line.
export function saveLedger(dir, name, meta, records) {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name + ".jsonl");
  writeFileSync(file, [JSON.stringify({ meta }), ...records.map((r) => JSON.stringify(r))].join("\n") + "\n");
  console.log(`\n→ ${file} (${records.length} events)`);
  return file;
}

export function saveResult(dir, name, payload) {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name + ".json");
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  console.log(`\n→ ${file}`);
  return file;
}
