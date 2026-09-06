// Drill F — two people on one machine.
//   The CLI keeps ONE token per origin in ~/.config/augur/tokens.json, so a second identity
//   on the same machine can only speak through AUGUR_TOKEN. What happens when it forgets:
//   a save in the second person's draft folder, run without the override, goes out with
//   the first person's token. Does the server notice? Whose name lands? This drill RECORDS
//   the answers; whether that is the right design is a question for the product owner.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UNITS, RUN, ORIGIN, workDir } from "../env.mjs";
import { token, human } from "../persona.mjs";
import { assert, resetUnit } from "./lib.mjs";
import { readState } from "../../../scripts/lib/draft.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ENGINE, "scripts", "cli.mjs");
const [UA, UB] = [UNITS()[10], UNITS()[11]];
const bare = (u) => u.replace(/^\/|\/$/g, "");

function run(args, { cwd, env }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("F: one machine, one tokens.json, two people", async () => {
  const findings = [];
  const home = workDir(`home-${Date.now().toString(36)}`);
  const tA = await token("editor"), tB = await token("editor2");
  // The first person paired this machine: their token is the one in tokens.json.
  fs.mkdirSync(path.join(home, ".config", "augur"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "augur", "tokens.json"), JSON.stringify({ [new URL(ORIGIN()).host]: { token: tA.token, space: tA.space, via: "connect" } }));
  const base = { ...process.env, HOME: home, AUGUR_ORIGIN: ORIGIN(), AUGUR_NO_ADAPTERS: "1" };
  delete base.AUGUR_TOKEN; delete base.AUGUR_DRAFTS_REGISTRY;
  const dA = path.join(home, "a"), dB = path.join(home, "b");
  const oA = await run(["open", bare(UA), "--dir", dA, "--session", "person-a"], { cwd: home, env: base });
  assert.equal(oA.code, 0, oA.err);
  // The second person, on the same machine, overrides the token for their open.
  const oB = await run(["open", bare(UB), "--dir", dB, "--session", "person-b"], { cwd: home, env: { ...base, AUGUR_TOKEN: tB.token } });
  assert.equal(oB.code, 0, oB.err);
  const stB = readState(dB);
  try {
    fs.appendFileSync(path.join(dB, "index.html"), `\n<!-- ${RUN} F: edited in b's folder -->`);
    // …and forgets the override on the save: the request goes out with person a's token.
    const sB = await run(["save"], { cwd: dB, env: base });
    findings.push({ what: "save in b's draft folder with a's token", code: sB.code, err: sB.err.trim().slice(0, 300) });
    const owner = await human("owner");
    const p = await owner.presence(UB);
    findings.push({ what: "presence on b's unit after that save", drafts: (p.drafts || []).map((d) => ({ id: d.id || d.draftId, session: d.session, name: d.name, active: d.active })) });
    const st = await run(["status"], { cwd: home, env: base });
    findings.push({ what: "status on this machine (a's token)", listsA: st.out.includes(readState(dA).draftId), listsB: st.out.includes(stB.draftId) });
    const lB = await run(["land", "-m", `${RUN} F landed from b's folder with a's token`], { cwd: dB, env: base });
    findings.push({ what: "land b's draft with a's token", code: lB.code, last: lB.out.trim().split("\n").pop(), err: lB.err.trim().slice(0, 200) });
    const h = await owner.history(UB);
    findings.push({ what: "history row", row: { by: h.landings[0].by, name: h.landings[0].name, session: h.landings[0].session, note: h.landings[0].note } });
    const faces = { a: (await human("editor")).email, b: (await human("editor2")).email };
    findings.push({ note: `person a = ${faces.a.replace(/^[^+]+/, "<qa>")}, person b = ${faces.b.replace(/^[^+]+/, "<qa>")}` });
  } finally {
    console.log("F findings:\n" + JSON.stringify(findings, null, 2));
    await run(["close", "--discard"], { cwd: dA, env: base }).catch(() => {});
    await run(["close", "--discard"], { cwd: dB, env: { ...base, AUGUR_TOKEN: tB.token } }).catch(() => {});
    await resetUnit(UA); await resetUnit(UB);
  }
});
