#!/usr/bin/env node
/**
 * augur mark — say what you are about to work on, and read what everyone else is.
 *
 *   augur mark                       what is being worked on right now
 *   augur mark <path> [--ttl <s>]    leave a mark on it, then start
 *   augur mark <path> --clear        take yours down early
 *   augur mark … --json              the same answer, for a tool to read
 *
 * `F-presence-marks`. Nothing anywhere said what was already being worked on. Two agents
 * on two machines, both told to improve the checkout flow, would each open the folder,
 * each edit it, and find out at publish time — where the answer is a fork and a conflict
 * file nobody asked for.
 *
 * ⚠️ THIS IS NOT A LOCK AND IT MUST NEVER BECOME ONE. Marking a path grants nothing and
 * refuses nothing: a marked path can still be edited, published and shipped by anybody, and
 * this command exits 0 whatever it finds. The protocol is social and it is one sentence —
 * READ THE MARKS BEFORE YOU START, LEAVE ONE WHEN YOU DO. What happens when coordination
 * fails anyway is the composed publish's problem, and it settles it on evidence rather than
 * on a claim.
 *
 * ⚠️ AND IT EXPIRES BY ITSELF. A mark carries how long it is good for — ten minutes by
 * default, an hour at the most — and the instance stops reporting it the moment that
 * passes, whether or not anything ever clears it. That is the point rather than a detail:
 * the thing leaving marks is a process that can be killed, and a claim that outlives the
 * claimant is worse than no claim at all. `--clear` is a courtesy, never the guarantee.
 *
 * A path is a URL path (`/checkout/flow/`). A repo folder is accepted and translated, so
 * `checkout/prototypes/flow` — the folder you were just editing — marks the URL it
 * publishes to. The line printed back is always the instance's own spelling.
 */
import { target, apiClient } from "./lib/store.mjs";
import { fetchMarks, markPathFor, othersOverlapping, markLine, forAnother } from "./lib/marks.mjs";

const C = { dim: "\x1b[2m", ok: "\x1b[32m", warn: "\x1b[33m", off: "\x1b[0m" };
const log = (m) => console.log(`\x1b[35m[mark]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[mark] ${m}\x1b[0m`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = flag("--json");
const CLEAR = flag("--clear");
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--ttl"));

async function main() {
  const { origin, token } = target({ needToken: true });
  const req = apiClient(origin, token);

  const raw = positional[0] || "";
  const path = raw ? markPathFor(raw) : "";
  if (raw && !path) die(`"${raw}" is not a path anything could be working on.`);

  // ── list ──────────────────────────────────────────────────────────────────
  if (!path) {
    const marks = await fetchMarks(req);
    if (JSON_OUT) { console.log(JSON.stringify({ origin, marks }, null, 2)); return; }
    if (!marks.length) { log(`${C.dim}nobody is working on anything at ${origin} right now${C.off}`); return; }
    log(`being worked on at ${origin}:`);
    for (const m of marks) console.log(`  ${markLine(m)}`);
    console.log(`\n${C.dim}Nothing here stops you. Pick a different path, or go ahead and expect to merge.${C.off}`);
    return;
  }

  // ── clear ─────────────────────────────────────────────────────────────────
  if (CLEAR) {
    const r = await req("_marks/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const body = await r.json();
    if (JSON_OUT) { console.log(JSON.stringify({ origin, path, ...body }, null, 2)); return; }
    if (body.cleared) log(`${C.ok}${path} released${C.off}`);
    else if (body.reason === "not-yours") log(`${C.dim}${path} is somebody else's mark — left alone. It expires on its own.${C.off}`);
    else log(`${C.dim}no mark of yours on ${path}${C.off}`);
    return;
  }

  // ── set ───────────────────────────────────────────────────────────────────
  const ttlArg = opt("--ttl");
  const ttl = ttlArg ? Math.round(Number(ttlArg) * 1000) : undefined;
  if (ttlArg && !Number.isFinite(ttl)) die(`--ttl takes seconds, not "${ttlArg}".`);

  // WHO ELSE IS ALREADY HERE — read BEFORE writing, because that is the whole protocol and
  // an agent that only ever writes is an agent that has learned nothing. Taken before the
  // write and not after: the write replaces the row for this path, so a read afterwards
  // could no longer see the person this is worth telling you about.
  const before = await fetchMarks(req);

  const r = await req("_marks/set", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, ...(ttl ? { ttl } : {}) }),
  });
  const body = await r.json();
  if (body.error) die(`${origin} refused the mark: ${body.error}`);

  // Who was already here that is not you. The rule, and the trap inside it, are on
  // `othersOverlapping` — it is a pure function precisely so the trap has a test.
  const overlapping = othersOverlapping(before, body.mark.path, body.mark.personId);

  if (JSON_OUT) { console.log(JSON.stringify({ origin, overlapping, ...body }, null, 2)); return; }
  log(`${C.ok}${body.mark.path}${C.off} marked ${forAnother(body.mark.expiresIn)}`);
  if (overlapping.length) {
    console.log(`\n  ${C.warn}somebody is already working here${C.off}`);
    for (const m of overlapping) console.log(`  ${markLine(m)}`);
    console.log(`\n${C.dim}Your mark went down anyway — marks never refuse. Pick a different path, wait it out, or carry on knowing you will be merging.${C.off}`);
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
