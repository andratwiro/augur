// A prototype may carry criteria it must keep true: `oracle/oracle.json` beside a page at
// `oracle/`, with checks a runner executes (see /__oracle/ and agents/prototype-contract.md).
// `augur land` asks that runner before a landing when both are present, so the criteria hold
// however the landing was started — an editor's hook, an agent, or a plain terminal.
//
// The engine does not run the checks itself: they are code, the runner is what a person
// installed and trusts on their own machine. The runner answers with its exit status: 0 go
// ahead, 2 refused (its reason is on stderr, which is passed through).
//
// A runner that CRASHES, times out or is killed refuses too. It used to land anyway, and a
// checker falling over is exactly what a broken prototype makes it do — so "landing anyway"
// was the one answer that could never be right. The way past a broken checker is a person
// saying so: AUGUR_SKIP_CRITERIA=1.
//
// A machine with NO runner (a teammate who never installed one) still lands — refusing
// would lock out everyone but the person who bound the criteria — but the landing is marked
// unchecked (`unchecked`, which land.mjs writes into the landing's note), so it shows in
// the prototype's history instead of passing as checked. The escape hatch is marked too.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function criteriaGate(dir, { log = () => {}, run = spawnSync, env = process.env } = {}) {
  if (!fs.existsSync(path.join(dir, "oracle", "oracle.json"))) return { ok: true, ran: false };
  if (env.AUGUR_SKIP_CRITERIA === "1") {
    log("this prototype has criteria (oracle/); AUGUR_SKIP_CRITERIA=1, so they were not checked — the landing says so");
    return { ok: true, ran: false, skipped: "env", unchecked: "criteria skipped (AUGUR_SKIP_CRITERIA)" };
  }
  log("this prototype has criteria (oracle/) — checking them before landing…");
  const r = run("oracle", ["land-check", dir], { stdio: ["ignore", "inherit", "inherit"], timeout: 15 * 60 * 1000 });
  if (r.error && r.error.code === "ENOENT") {
    log("no `oracle` runner on this machine, so the criteria were not checked; landing, marked unchecked");
    return { ok: true, ran: false, skipped: "no-runner", unchecked: "criteria not checked (no runner on this machine)" };
  }
  if (r.status === 0) return { ok: true, ran: true };
  if (r.status === 2) return { ok: false, ran: true, why: "refused" };
  const how = r.error ? (r.error.code || r.error.message) : r.status == null ? r.signal : "status " + r.status;
  log(`the criteria runner stopped with ${how} before it could answer`);
  return { ok: false, ran: true, why: "runner-failed" };
}
