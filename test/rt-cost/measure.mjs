/* Drive a real room and record what it costs in Durable Object active duration.
 *
 *   node test/rt-cost/measure.mjs grace        # how long the runtime waits before evicting
 *   node test/rt-cost/measure.mjs idle         # what an open tab with nobody in it costs
 *   node test/rt-cost/measure.mjs edit         # what a two-person editing session costs
 *   node test/rt-cost/measure.mjs alarm        # what an edit-then-walk-away costs later
 *   node test/rt-cost/measure.mjs leave        # what the tail after the last person costs
 *   node test/rt-cost/measure.mjs all
 *
 * By default it starts its own local runtime (`wrangler dev`, real workerd, real Durable
 * Objects, real WebSocket Hibernation) and reads the ledger off its stdout. Against a
 * DEPLOYED worker instead:
 *
 *   node test/rt-cost/measure.mjs grace --origin wss://<host> --tail <worker-name>
 *
 * which reads the same ledger through `wrangler tail`. Nothing here names an account, a
 * host or an instance; both are arguments.
 *
 * TWO NUMBERS, NOT ONE, AND THEY ARE NOT THE SAME NUMBER.
 *
 *   awakeMs   — wall-clock the object was RESIDENT: from a wake to its last event, plus
 *               one eviction grace per wake. This is the quantity `rtMonthlyDoMinutes`
 *               is written in ("minutes those rooms may stay awake").
 *   handlerMs — wall-clock the object was RUNNING a handler, summed over invocations.
 *
 * The platform bills the second, not the first: duration accrues "while the Durable Object
 * is actively running or is idle in memory but unable to hibernate", and an object that is
 * idle and hibernation-eligible is "not billed for duration, even before the runtime has
 * hibernated" it. A room whose every socket was accepted through acceptWebSocket() is
 * hibernation-eligible in every gap between messages, so awakeMs is a CEILING on the bill
 * and handlerMs is the floor. handlerMs is a floor and not the answer because a Worker's
 * clock does not advance during synchronous execution — a handler that does no I/O reads
 * as 0ms here however much CPU it burned.
 *
 * Both are reported. Neither is presented as the other.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, sleep, PING_MS } from "./client.mjs";
import { makeLedger, startLocalRuntime, startTailRuntime, activeMs, tally, saveResult, saveLedger, round } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const RESULTS = resolve(HERE, "results");

const argv = process.argv.slice(2);
const scenario = argv[0] || "all";
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(opt("port", 8809));
const ORIGIN = opt("origin", `ws://127.0.0.1:${PORT}`);
const TAIL = opt("tail", "");
const MINUTES = Number(opt("minutes", 5));
const LOCAL = !TAIL;
// board-room.mjs PERSIST_MS is 45s: a dirty board's mirror alarm fires that long after the
// write that dirtied it. Anything that wants to observe a QUIET room has to outlast that,
// or the alarm lands inside the observation and reads as something the room did on its own.
const SETTLE_MS = 62000;

const LEDGER = makeLedger();
const ledger = LEDGER.records;
let child = null;
async function startRuntime() {
  child = LOCAL
    ? await startLocalRuntime({ cwd: ROOT, config: "test/rt-cost/wrangler.toml", port: PORT, ledger: LEDGER })
    : await startTailRuntime({ cwd: ROOT, name: TAIL, ledger: LEDGER });
}
function stopRuntime() { if (child) { try { child.kill("SIGTERM"); } catch (e) {} child = null; } }
process.on("exit", stopRuntime);
process.on("SIGINT", () => { stopRuntime(); process.exit(1); });

const since = () => ledger.length;
const from = (mark) => ledger.slice(mark);

const SUFFIX = opt("suffix", "");
const save = (name, payload) => saveResult(RESULTS, name + SUFFIX, payload);
const RUNTIME = () => ({
  runtime: LOCAL ? "local wrangler dev (workerd)" : `deployed worker via wrangler tail (${TAIL})`,
  origin: ORIGIN,
  at: new Date().toISOString(),
});

// ---- scenario: the eviction grace ----------------------------------------
// Everything else is calibrated against this, so it runs first and its answer is written
// where the other scenarios read it from.
async function scenarioGrace() {
  const path = `/rtcost/grace-${Date.now()}`;
  const c = await new BoardClient(ORIGIN, path, "Probe").open();
  // Deliberately NOT c.start(): the diff tick would poke the object every second and the
  // room would never be allowed to go idle. Only the keepalive runs, exactly as it does
  // in a tab whose owner has walked away.
  const ping = setInterval(() => c.raw("ping"), PING_MS);
  // Same reason as the idle scenario: the join seeds the board and arms the mirror alarm,
  // and an alarm inside a probe gap is a `ctor` this scenario would read as an eviction.
  await sleep(SETTLE_MS);
  const probes = [];
  const probe = async (gapSec) => {
    await sleep(gapSec * 1000);
    const mark = since();
    c.send({ t: "cursor", x: gapSec, y: 1 }); // pure relay: no storage write, so no alarm
    await sleep(2000);
    const seen = from(mark);
    // ⚠️ THE GUARD THAT MAKES A NEGATIVE MEAN SOMETHING. "No ctor" is the answer this
    // scenario is looking for, and it is also exactly what a ledger that is not connected
    // says about everything. The room certainly received the cursor frame — if that did
    // not come back, the silence is the pipe's and every probe below would be measuring it.
    if (!seen.some((r) => r.ev === "msg:in")) {
      throw new Error("the ledger recorded nothing for a message the room did receive — the ledger source is not connected, so no verdict here would be about the room");
    }
    const woke = seen.some((r) => r.ev === "ctor");
    probes.push({ gapSec, woke });
    console.log(`  gap ${String(gapSec).padStart(3)}s → ${woke ? "WOKE (was evicted)" : "still resident"}`);
    return woke;
  };
  console.log("grace: walking the idle gap upward until the object has to be reconstructed");
  let lo = 0, hi = null;
  for (const g of [4, 8, 12, 16, 20, 25, 30, 45, 60, 90]) {
    const woke = await probe(g);
    if (woke) { hi = g; break; }
    lo = g;
  }
  if (hi != null) {
    for (let i = 0; i < 3 && hi - lo > 2; i++) {
      const mid = Math.round((lo + hi) / 2);
      if (await probe(mid)) hi = mid; else lo = mid;
    }
  }
  clearInterval(ping);
  c.close();
  const out = {
    ...RUNTIME(),
    scenario: "grace",
    question: "how long does the runtime keep a Durable Object resident after its last event?",
    probes,
    graceLowerBoundSec: lo,
    graceUpperBoundSec: hi,
    verdict: hi == null
      ? "no probe up to 90s ever forced a reconstruction — this runtime did not evict, so hibernation cannot be timed here"
      : `eviction happens between ${lo}s and ${hi}s of idleness`,
  };
  save("grace", out);
  return out;
}

// ---- scenario: an idle tab ----------------------------------------------
async function scenarioIdle(graceMs) {
  const path = `/rtcost/idle-${Date.now()}`;
  const a = (await new BoardClient(ORIGIN, path, "Ana").open()).start();
  const b = (await new BoardClient(ORIGIN, path, "Ben").open()).start();
  // Same guard as the grace probe, and for the same reason: this scenario's headline
  // result is a COUNT OF ZERO, which a disconnected ledger produces just as readily.
  const live = since();
  a.send({ t: "cursor", x: 1, y: 1 });
  await sleep(2000);
  if (!from(live).some((r) => r.ev === "msg:in")) {
    throw new Error("the ledger recorded nothing for a message the room did receive — a zero here would be the pipe's silence, not the room's");
  }
  // Joining SEEDS the board, which dirties it, which arms the 45s mirror alarm. Waiting
  // that out is what makes phase A "an idle tab" rather than "an idle tab plus the wake
  // the join owed" — and phase B is where that wake is measured on purpose.
  await sleep(SETTLE_MS);

  console.log(`idle A: two open tabs, nobody touching them, ${MINUTES} min`);
  const markA = since();
  const t0 = Date.now();
  await sleep(MINUTES * 60000);
  const idleOnly = from(markA);
  const t1 = Date.now();

  console.log("idle B: one 6s edit burst to dirty the board, then the same idle window");
  a.addNode("n1");
  await a.drag("n1", 6000);
  await sleep(1000);
  const markB = since();
  const t2 = Date.now();
  await sleep(MINUTES * 60000);
  const afterEdit = from(markB);
  const t3 = Date.now();

  a.close(); b.close();
  const out = {
    ...RUNTIME(),
    scenario: "idle",
    question: "does an idle tab cost anything under the WebSocket Hibernation API?",
    graceMsApplied: graceMs,
    clean: {
      wallClockMs: t1 - t0,
      events: idleOnly.length,
      kinds: tally(idleOnly),
      ...activeMs(idleOnly, graceMs),
    },
    afterAnEdit: {
      wallClockMs: t3 - t2,
      events: afterEdit.length,
      kinds: tally(afterEdit),
      ...activeMs(afterEdit, graceMs),
    },
    pingsSent: a.sent.ping + b.sent.ping,
    pingReachedHandler: ledger.some((r) => r.k === "PING-REACHED-HANDLER"),
  };
  save("idle", out);
  return out;
}

// ---- scenario: a two-person editing session ------------------------------
// THE PROFILE IS AN ASSUMPTION AND IS STATED AS ONE. A person editing a board works in
// gestures separated by pauses; these are the numbers used, and the report carries them
// so the result can be re-read against a different belief about how people work.
const PROFILE = {
  gestureSecMin: 2, gestureSecMax: 6,
  thinkSecMin: 3, thinkSecMax: 20,
  typeShare: 0.4,   // of gestures, this many are typing rather than dragging
  panShare: 0.15,   // and this many are pure pan/zoom
};
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function person(c, seed, untilTs, log) {
  const rnd = mulberry(seed);
  const span = (lo, hi) => lo + rnd() * (hi - lo);
  let i = 0;
  while (Date.now() < untilTs) {
    const ms = span(PROFILE.gestureSecMin, PROFILE.gestureSecMax) * 1000;
    const roll = rnd();
    const id = c.name.toLowerCase() + "-" + (i % 4);
    c.addNode(id, { x: 100 + (i % 4) * 260, y: 100 });
    if (roll < PROFILE.panShare) { log.pan += ms; await c.pan(ms); }
    else if (roll < PROFILE.panShare + PROFILE.typeShare) { log.type += ms; await c.type(id, ms); }
    else { log.drag += ms; await c.drag(id, ms); }
    log.gestures++;
    const think = span(PROFILE.thinkSecMin, PROFILE.thinkSecMax) * 1000;
    log.think += think;
    await sleep(Math.min(think, Math.max(0, untilTs - Date.now())));
  }
}
const NAMES = ["Ana", "Ben", "Cai", "Dev", "Eli"];
async function scenarioEdit(graceMs, people, tag) {
  const path = `/rtcost/edit-${people}p-${Date.now()}`;
  const cs = [];
  for (let i = 0; i < people; i++) cs.push((await new BoardClient(ORIGIN, path, NAMES[i]).open()).start());
  await sleep(2000);
  console.log(`edit: ${people} ${people === 1 ? "person" : "people"} working the same board for ${MINUTES} min`);
  const mark = since();
  const t0 = Date.now();
  const until = t0 + MINUTES * 60000;
  const logs = cs.map(() => ({ gestures: 0, drag: 0, type: 0, pan: 0, think: 0 }));
  await Promise.all(cs.map((c, i) => person(c, 11 + i * 18, until, logs[i])));
  const t1 = Date.now();
  const rs = from(mark);
  for (const c of cs) c.close();
  const wall = t1 - t0;
  const act = activeMs(rs, graceMs);
  const out = {
    ...RUNTIME(),
    scenario: tag,
    question: "how many minutes does an hour of editing keep the room's Durable Object awake?",
    profile: PROFILE,
    people,
    wallClockMs: wall,
    activity: Object.fromEntries(cs.map((c, i) => [c.name, logs[i]])),
    messages: Object.fromEntries(cs.map((c) => [c.name, c.sent])),
    bytes: cs.reduce((a, c) => a + c.bytes, 0),
    events: rs.length,
    kinds: tally(rs),
    ...act,
    // The room is ONE object however many people are in it, so these two differ by
    // exactly the head count — which is the whole reason both are printed.
    awakeMinPerRoomHour: round(act.awakeMs / 60000 / (wall / 3600000)),
    awakeMinPerPersonHour: round(act.awakeMs / 60000 / ((wall * people) / 3600000)),
    handlerMinPerRoomHour: round(act.handlerMs / 60000 / (wall / 3600000), 3),
    awakeFraction: round(act.awakeMs / wall, 3),
  };
  save(tag, out);
  return out;
}

// ---- scenario: the one thing that wakes a room nobody is touching ---------
// board-room.mjs arms a 45s alarm on the first accepted op and mirrors to KV when it
// fires. A person who edits and then walks away therefore costs one wake AFTER the last
// message — which the idle scenario cannot see, because it starts its clock after that
// alarm would already be armed. Kept separate for that reason.
async function scenarioAlarm() {
  const path = `/rtcost/alarm-${Date.now()}`;
  const c = (await new BoardClient(ORIGIN, path, "Ana").open()).start();
  await sleep(1500);
  const mark = since();
  const t0 = Date.now();
  c.addNode("n1");
  await sleep(1500);           // one op lands, the board is dirty, the alarm is armed
  const ping = setInterval(() => c.raw("ping"), PING_MS);
  await sleep(105000);         // 45s cadence + the 5s retry re-arm, with room to spare
  clearInterval(ping);
  const rs = from(mark);
  c.close();
  const armed = rs.filter((r) => r.ev === "arm");
  const fired = rs.filter((r) => r.ev === "alarm:in");
  const out = {
    ...RUNTIME(),
    scenario: "alarm",
    question: "does the 45s mirror alarm wake a room whose people have stopped touching it?",
    watchedMs: Date.now() - t0,
    armed: armed.length,
    fired: fired.length,
    firstFireAtMs: fired.length ? fired[0].t - t0 : null,
    kinds: tally(rs),
    // FIRING is what matters and ARMING is only the diagnosis for a failure to fire, so
    // the verdict reads them in that order. (`armed: 0` with `fired: 1` is normal and not a
    // contradiction: the JOIN dirties the board first, so the arming already happened
    // before this window opened.)
    verdict: fired.length
      ? `fired ${fired.length}× — an edit and then walking away costs that many extra wakes`
      : armed.length
        ? "ARMED BUT NEVER FIRED on this runtime: the KV mirror is not happening on its cadence here"
        : "neither armed nor fired inside this window — the op did not dirty the board, which is a different bug",
    trace: rs.map((r) => ({ dtMs: r.t - t0, ev: r.ev, k: r.k, inst: r.inst })),
  };
  save("alarm", out);
  console.log("  " + out.verdict);
  return out;
}

// ---- scenario: the tail after the last person leaves ----------------------
async function scenarioLeave(graceMs) {
  const path = `/rtcost/leave-${Date.now()}`;
  const a = (await new BoardClient(ORIGIN, path, "Ana").open()).start();
  await sleep(1500);
  a.addNode("n1");
  await a.drag("n1", 5000);   // leave the board dirty, which is the expensive case
  await sleep(500);
  const mark = since();
  const closedAt = Date.now();
  a.close();
  await sleep(120000);        // long enough to catch the 45s mirror alarm if one is armed
  const rs = from(mark);
  // THE TAIL IS TWO THINGS AND ADDING THEM IS A LIE. reap() flushes the mirror inside the
  // instance the leaver was talking to — that is the tail proper, and it is milliseconds.
  // The straggler is the cadence alarm that was already armed BEFORE the flush cleared the
  // dirty flag: it fires once more into an empty room, finds nothing to do and returns.
  // One is work the departure caused; the other is a wake it had already paid for.
  const flush = rs.filter((r) => r.ev !== "ctor" && r.t - closedAt < 5000);
  const flushEnd = flush.length ? Math.max(...flush.map((r) => r.t)) : closedAt;
  const straggler = rs.filter((r) => r.t - closedAt >= 5000);
  const stragglerWakes = straggler.filter((r) => r.ev === "ctor").length;
  const out = {
    ...RUNTIME(),
    scenario: "leave",
    question: "what does a room cost between the last person leaving and the object going quiet?",
    graceMsApplied: graceMs,
    flushWorkMs: flushEnd - closedAt,
    flushAwakeMs: flushEnd - closedAt + graceMs,
    stragglerWakes,
    stragglerAwakeMs: stragglerWakes * graceMs,
    totalAwakeMs: flushEnd - closedAt + graceMs + stragglerWakes * graceMs,
    events: rs.length,
    kinds: tally(rs),
    trace: rs.map((r) => ({ dtMs: r.t - closedAt, ev: r.ev, k: r.k, inst: r.inst })),
  };
  save("leave", out);
  return out;
}

// ---- run -----------------------------------------------------------------
const WANTED = scenario === "all" ? ["grace", "idle", "edit", "edit1", "alarm", "leave"] : scenario.split(",");
(async () => {
  await startRuntime();
  const results = {};
  let graceMs = Number(opt("grace-ms", 0));
  const want = (n) => WANTED.includes(n);
  if (want("grace")) {
    results.grace = await scenarioGrace();
    if (!graceMs) {
      graceMs = results.grace.graceUpperBoundSec == null
        ? 0
        : Math.round(((results.grace.graceLowerBoundSec + results.grace.graceUpperBoundSec) / 2) * 1000);
    }
  }
  if (want("idle")) results.idle = await scenarioIdle(graceMs);
  if (want("edit")) results.edit = await scenarioEdit(graceMs, Number(opt("people", 2)), "edit");
  if (want("edit1")) results.edit1 = await scenarioEdit(graceMs, 1, "edit1");
  if (want("alarm")) results.alarm = await scenarioAlarm();
  if (want("leave")) results.leave = await scenarioLeave(graceMs);
  saveLedger(RESULTS, "ledger-" + WANTED.join("+") + SUFFIX, { ...RUNTIME(), scenarios: WANTED, graceMs }, ledger);
  console.log("\n" + JSON.stringify(results, null, 2));
  stopRuntime();
  process.exit(0);
})().catch((e) => { console.error(e); stopRuntime(); process.exit(1); });
