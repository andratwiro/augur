// A prototype may carry criteria it must keep true: `oracle/oracle.json` beside a page at
// `oracle/`, with checks a runner executes (see /__oracle/ and agents/prototype-contract.md).
// `augur land` asks that runner before a landing when both are present, so the criteria hold
// however the landing was started — an editor's hook, an agent, or a plain terminal.
//
// The engine does not run the checks itself: they are code, the runner is what a person
// installed and trusts on their own machine, and a machine without one lands as before and
// says so. The runner answers with its exit status: 0 go ahead, 2 refused (its reason is on
// stderr, which is passed through). Anything else, a missing runner included, never blocks:
// a broken checker must not take landing down with it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function criteriaGate(dir, { log = () => {}, run = spawnSync, env = process.env } = {}) {
  if (!fs.existsSync(path.join(dir, "oracle", "oracle.json"))) return { ok: true, ran: false };
  if (env.AUGUR_SKIP_CRITERIA === "1") {
    log("this prototype has criteria (oracle/); AUGUR_SKIP_CRITERIA=1, so they were not checked");
    return { ok: true, ran: false, skipped: "env" };
  }
  log("this prototype has criteria (oracle/) — checking them before landing…");
  const r = run("oracle", ["land-check", dir], { stdio: ["ignore", "inherit", "inherit"], timeout: 15 * 60 * 1000 });
  if (r.error && r.error.code === "ENOENT") {
    log("no `oracle` runner on this machine, so the criteria were not checked; landing anyway");
    return { ok: true, ran: false, skipped: "no-runner" };
  }
  if (r.status === 2) return { ok: false, ran: true };
  if (r.status !== 0) log(`the criteria runner stopped with ${r.status == null ? r.signal : "status " + r.status}; landing anyway`);
  return { ok: true, ran: true };
}
