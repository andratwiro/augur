#!/usr/bin/env node
// Put a deploy shell's worker back to an earlier version.
//
//   node engine/scripts/ops/rollback.mjs --reason "<why>" [--to <version-id>] [--dry-run]
//                                        [-c wrangler.toml] [--check-url <origin>]
//
// Run from the shell's root with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID set. Without
// --to, the target is the version the PREVIOUS deployment served. Before rolling back:
//
//   · the target's engine commit must be known — deploys are labelled `engine-<sha>` by the
//     shell's deploy script; an unlabelled target is refused (exit 3) unless --to names it,
//     because nothing else says what code it is;
//   · the stored-format versions (TENANT_SCHEMA_VERSION, UNIT_SCHEMA_VERSION) must be the
//     same at both commits. A newer engine may already have written rows the older one can't
//     read, so rolling back across a format change can turn one outage into data trouble —
//     refused with exit 3: that one is a person's call.
//
// Then `wrangler rollback`, a ROLLBACK-HOLD.json that stops the next deploy re-shipping the
// bad pin (see deploy-gate.mjs), and — with --check-url — a wait until <origin>/_build.json
// serves the target's engine commit (chrome included; it is served newest-of-assets-or-R2,
// and a rollback that left the new chrome in front would show up here).
//
// Exit 0 rolled back (and verified, with --check-url); 1 failed; 3 refused, needs a person.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const reason = opt("--reason");
const config = opt("-c", "wrangler.toml");
const checkUrl = opt("--check-url");
const dry = argv.includes("--dry-run");
const say = (m) => console.error(`\x1b[35m[rollback]\x1b[0m ${m}`);
const fail = (m, code = 1) => { console.error(`\x1b[31m[rollback]\x1b[0m ${m}`); process.exit(code); };
if (!reason) fail("say why: --reason \"<what broke>\" (it goes on the Cloudflare version and in the hold file).");

const engineDir = path.resolve("engine");
function wrangler(args, { json = false } = {}) {
  const r = spawnSync("npx", ["--yes", "wrangler@4", ...args, "-c", config, ...(json ? ["--json"] : [])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`wrangler ${args[0]} failed:\n${(r.stderr || r.stdout || "").slice(-1500)}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}
const engineOf = (v) => {
  const a = (v && v.annotations) || {};
  const m = String(a["workers/tag"] || "").match(/^engine-([0-9a-f]{7,40})$/) || String(a["workers/message"] || "").match(/engine ([0-9a-f]{7,40})/);
  return m ? m[1] : null;
};

const deployments = wrangler(["deployments", "list"], { json: true });
const versions = wrangler(["versions", "list"], { json: true });
const byId = new Map(versions.map((v) => [v.id, v]));
const liveOf = (d) => (d.versions.find((x) => x.percentage === 100) || d.versions[0] || {}).version_id;
const current = liveOf(deployments[deployments.length - 1]);
let target = opt("--to");
if (!target) {
  for (let i = deployments.length - 2; i >= 0; i--) { const v = liveOf(deployments[i]); if (v && v !== current) { target = v; break; } }
}
if (!target) fail("there is no earlier version to roll back to.", 3);
if (target === current) fail(`${target} is what is live now.`, 3);
const fromEngine = engineOf(byId.get(current));
const toEngine = engineOf(byId.get(target));
say(`live ${current} (engine ${fromEngine || "unlabelled"}) → ${target} (engine ${toEngine || "unlabelled"})`);
if (!toEngine && !opt("--to")) fail("the previous version carries no engine label, so nothing says what code it is. Name it with --to after checking.", 3);

function schemaAt(sha) {
  const read = (f, re) => {
    const r = spawnSync("git", ["-C", engineDir, "show", `${sha}:${f}`], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const m = r.stdout.match(re); return m ? Number(m[1]) : null;
  };
  return { tenant: read("src/tenant-do.js", /TENANT_SCHEMA_VERSION = (\d+)/), unit: read("src/unit-object.mjs", /UNIT_SCHEMA_VERSION = (\d+)/) };
}
if (fromEngine && toEngine) {
  spawnSync("git", ["-C", engineDir, "fetch", "--quiet", "origin"], { stdio: "ignore" });
  const a = schemaAt(fromEngine), b = schemaAt(toEngine);
  if (a.tenant == null || b.tenant == null) fail(`could not read the stored-format versions at ${fromEngine} / ${toEngine} — is the engine checkout missing one of them?`, 3);
  if (a.tenant !== b.tenant || a.unit !== b.unit) {
    fail(`the stored format changed between them (tenant ${b.tenant}→${a.tenant}, unit ${b.unit}→${a.unit}); rows written since may not read on the older code. Not rolling back — this is a person's call.`, 3);
  }
  say(`stored formats match (tenant ${a.tenant}, unit ${a.unit})`);
}
if (dry) { say("dry run — nothing changed"); process.exit(0); }

wrangler(["rollback", target, "-m", `rollback: ${reason}`.slice(0, 100), "-y"]);
const hold = { at: new Date().toISOString(), reason, from: { version: current, engine: fromEngine }, to: { version: target, engine: toEngine } };
fs.writeFileSync("ROLLBACK-HOLD.json", JSON.stringify(hold, null, 2) + "\n");
say(`rolled back; ROLLBACK-HOLD.json written — the next deploy is refused until the pin moves past ${fromEngine || current}`);

if (checkUrl && toEngine) {
  const deadline = Date.now() + 120000;
  let seen = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${checkUrl.replace(/\/$/, "")}/_build.json`, { headers: { "cache-control": "no-cache" } });
      const b = await r.json();
      seen = (b.engine && (b.engine.builtWithEngine || b.engine.sha)) || "";
      if (seen.startsWith(toEngine) || toEngine.startsWith(seen.slice(0, toEngine.length))) { say(`${checkUrl} serves engine ${seen.slice(0, 12)} — verified`); process.exit(0); }
    } catch (e) { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail(`rolled back, but ${checkUrl}/_build.json still says ${seen || "nothing"} after 2 minutes`);
}
