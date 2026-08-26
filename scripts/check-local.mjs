#!/usr/bin/env node
/**
 * check-local — run every gate `.github/workflows/check.yml` runs, here, before pushing.
 *
 * WHY. `check` gates the deploy: `deploy-trigger.yml` only dispatches when it is green,
 * so a red check does not break a live instance — it silently STOPS the engine reaching
 * one. A push whose check fails looks exactly like a push that shipped, from this side,
 * and the instance that auto-bumps within a minute simply never bumps.
 *
 * That already happened once. A commit landed on main naming a person in a comment, the
 * repo-wide word scan caught it in CI, the deploy trigger skipped, and the engine sat one
 * commit behind on every instance until someone looked at the run list. Every check runs
 * locally in seconds; there was no reason not to have run them.
 *
 * THE WORD SCAN IS THE ONE THAT NEEDED THIS. The other five gates are node scripts anyone
 * would think to run. The word scan is a shell grep that only exists inside the workflow
 * YAML, so it was the one gate with no local form at all — and it is the one that fires
 * on ordinary prose written into a comment without thinking, which is the easiest mistake
 * in this repo to make.
 *
 * IF YOU EDIT check.yml, EDIT THIS. They are two copies of one list. The last check below
 * compares them and fails when the workflow grows a step this file does not run, so the
 * drift is caught rather than discovered.
 *
 * Run: npm run check     (exit 1 on the first failure, like the workflow)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "check.yml");

// The repo-wide instance/product/personal word scan, kept BYTE-IDENTICAL to the pattern in
// check.yml. It is read out of the workflow rather than duplicated here, so the two can
// never disagree — and so this file does not itself become a list of the words (which is
// why check.yml excludes itself from the scan, and why this script must be excluded too).
function wordScanPattern() {
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  const m = yml.match(/^\s*'([^']*go\[[^']*)'\s*\\?\s*$/m);
  if (!m) throw new Error("could not find the word-scan pattern in check.yml — has the step changed shape?");
  return m[1];
}

const steps = [
  ["Doc drift (doc-lint)", () => run("node", ["scripts/doc-lint.mjs"])],
  ["No new module-scope tenant state", () => run("node", ["scripts/no-tenant-globals.mjs"])],
  ["One tenant resolver, one call site", () => run("node", ["scripts/one-tenant-resolver.mjs"])],
  ["No foreign vocabulary", () => run("node", ["scripts/no-foreign-vocabulary.mjs"])],
  ["No other company's product named", () => run("node", ["scripts/no-product-names.mjs"])],
  ["Empty states are a ghost and one line", () => run("node", ["scripts/ui-copy-lint.mjs"])],
  ["The state inventory still names everything", () => run("node", ["scripts/state-inventory.mjs"])],
  ["No instance, product, or personal words", wordScan],
];

function run(cmd, args) {
  const out = execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim().split("\n").pop();
}

function wordScan() {
  // WHAT TO SCAN: everything the repository WILL contain if you commit — tracked files plus
  // untracked-but-not-ignored ones. Neither half alone is right, and both halves were
  // learned the same way.
  //
  // Not the whole working tree: a local tree also holds everything .gitignore covers —
  // agent scratch, notes, old reports — which are full of these words on purpose and are
  // going nowhere near a deploy. Grepping `.` reported hundreds of findings CI cannot see,
  // which trains whoever runs this to scroll past its output.
  //
  // And not the tracked set alone: a brand-new file is invisible to `git ls-files` until
  // it is added, so that reports OK on exactly the file you are about to commit, and then
  // CI — which sees it — goes red. That happened: a new test used a person's name as a
  // fixture, this check passed because the file was not staged yet, and the push landed
  // with a red gate and a skipped deploy.
  //
  // A brand-new file is invisible to `git ls-files` until it is added, so scanning only the
  // tracked set reports OK on exactly the file you are about to commit — and then CI, which
  // sees it, goes red. That happened: a new test used a person's name as a fixture, this
  // check passed because the file was not staged yet, and the push landed with a red gate
  // and a skipped deploy. Untracked-and-not-ignored is precisely "what the repository will
  // contain if you commit", which is what CI is going to scan.
  //
  // Ignored files stay out, which is what keeps agent scratch from swamping the output.
  const ls = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: "buffer" })
    .toString("utf8").split("\0").filter(Boolean);
  const tracked = [...ls("ls-files -z"), ...ls("ls-files -o --exclude-standard -z")]
    // check.yml necessarily writes the words down; so does this file's own excludes.
    .filter((f) => f !== ".github/workflows/check.yml" && f !== "scripts/check-local.mjs")
    .filter((f, i, a) => a.indexOf(f) === i);

  // grep exit codes: 0 = found (FAIL), 1 = clean (pass), >=2 = the scan itself broke.
  // Treating >=2 as a pass is how a renamed path turns a guard into a no-op.
  let rc = 1, out = "";
  try {
    out = execFileSync("grep", ["-InEi", "--binary-files=without-match", wordScanPattern(), ...tracked],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    rc = 0;
  } catch (e) {
    rc = e.status;
    out = (e.stdout || "") + (e.stderr || "");
  }
  if (rc === 0) throw new Error(`instance/product/personal word found:\n${out.trim()}`);
  if (rc >= 2) throw new Error(`the word scan failed to RUN (grep rc=${rc}) — that is a failure, never a pass:\n${out}`);
  return `clean — ${tracked.length} files (tracked + untracked), no instance/product words`;
}

let failed = 0;
for (const [name, fn] of steps) {
  try {
    const last = fn();
    console.log(`  ok    ${name}${last ? `  —  ${last.slice(0, 90)}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    const msg = (e.stdout || "") + (e.stderr || "") || e.message;
    console.log(msg.split("\n").map((l) => `        ${l}`).join("\n"));
    break; // the workflow stops at the first failing step; so does this
  }
}

// Drift: a step added to the workflow that this file does not run would make a green local
// check mean less than it says.
if (!failed) {
  const names = [...fs.readFileSync(WORKFLOW, "utf8").matchAll(/^\s*-\s*name:\s*(.+)$/gm)].map((m) => m[1].trim());
  const missing = names.filter((n) => !steps.some(([s]) => n.toLowerCase().startsWith(s.toLowerCase().slice(0, 18))));
  if (missing.length) {
    console.log(`\n  FAIL  check.yml has step(s) this script does not run: ${missing.join(", ")}`);
    console.log("        Add them here. A local check that is a subset of CI is a local check that lies.");
    process.exit(1);
  }
}

console.log(failed ? "\ncheck-local: FAILED — this push would not deploy" : "\ncheck-local: OK — every gate check.yml runs is green here");
process.exit(failed ? 1 : 0);
