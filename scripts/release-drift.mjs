#!/usr/bin/env node
/**
 * release-drift — is anybody still cutting tags?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT HYGIENE. Every instance on `TRACK: release` follows
 * the newest GitHub release, faithfully and forever. So when tagging stops, those
 * instances do not break, do not warn, and do not fall behind visibly — they keep
 * auto-updating to the same old tag and reporting themselves healthy. The failure is
 * SILENT ON THE FOLLOWER and invisible on the publisher, which is the shape nobody
 * notices without a clock.
 *
 * It has already happened twice. The release track was abandoned once because no tag had
 * been cut since v0.9.0 and pins had drifted ~87 commits behind while looking fine.
 * Tagging resumed at v0.11.0 and v0.12.0, then lapsed again.
 *
 * This is the supply-side guard, and it is deliberately on the ENGINE rather than in each
 * shell: a shell can only see the tags that exist, so a shell-side check can never say
 * "the tag you are following is the newest one AND it is four months old".
 *
 * WHAT IT DOES NOT DO. It does not cut a tag. Deciding that a set of commits is a release
 * is a judgement about what changed and who it reaches, and an automatic tag would remove
 * exactly the review that `TRACK: release` exists to provide.
 *
 * Run: node scripts/release-drift.mjs [--max-age-days N] [--max-commits N] [--json]
 * Exit 1 when either ceiling is passed, 0 when clean, 2 when it could not tell.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The cadence, as two numbers. They are ceilings on DRIFT, not a promised schedule: a
// quiet fortnight with four commits is fine, and a busy afternoon with ninety is not.
const DEFAULT_MAX_AGE_DAYS = 21;
const DEFAULT_MAX_COMMITS = 60;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const MAX_AGE_DAYS = arg("--max-age-days", DEFAULT_MAX_AGE_DAYS);
const MAX_COMMITS = arg("--max-commits", DEFAULT_MAX_COMMITS);
const asJson = process.argv.includes("--json");

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();

// A RELEASE tag, not any tag. The repo also carries working tags (backup points before a
// rebase, for instance), and treating one of those as a release would report the drift as
// closed on a tag no self-hoster will ever be offered.
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

let newest, tagIso, ahead;
try {
  const tags = git("tag", "--sort=-creatordate").split("\n").map((t) => t.trim()).filter((t) => RELEASE_TAG.test(t));
  if (!tags.length) {
    const out = { ok: false, reason: "no release tag exists at all", newest: null };
    console.log(asJson ? JSON.stringify(out) : `release-drift: NO RELEASE TAG EXISTS. Every instance on TRACK: release has nothing to follow.`);
    process.exit(1);
  }
  newest = tags[0];
  tagIso = git("log", "-1", "--format=%cI", newest);
  ahead = Number(git("rev-list", "--count", `${newest}..HEAD`));
} catch (e) {
  // A shallow clone has no tags and no history to count. Saying "clean" there would be a
  // guard that reports success precisely when it cannot see.
  console.error(`release-drift: could not read tags or history (${(e && e.message) || e}). This is not a pass.`);
  process.exit(2);
}

const ageDays = Math.floor((Date.now() - Date.parse(tagIso)) / 86_400_000);
const findings = [];
if (ageDays > MAX_AGE_DAYS) {
  findings.push(`no release cut in ${ageDays} days (ceiling ${MAX_AGE_DAYS}) — newest is ${newest}, from ${tagIso.slice(0, 10)}`);
}
if (ahead > MAX_COMMITS) {
  findings.push(`main is ${ahead} commits ahead of ${newest} (ceiling ${MAX_COMMITS}) — a self-hoster on TRACK: release is running none of them`);
}

const result = { ok: !findings.length, newest, tagIso, ageDays, ahead, maxAgeDays: MAX_AGE_DAYS, maxCommits: MAX_COMMITS, findings };
if (asJson) { console.log(JSON.stringify(result, null, 2)); process.exit(findings.length ? 1 : 0); }

if (!findings.length) {
  console.log(`release-drift: OK — ${newest} is ${ageDays}d old with ${ahead} commit(s) since (ceilings: ${MAX_AGE_DAYS}d, ${MAX_COMMITS})`);
  process.exit(0);
}
for (const f of findings) console.log(`  ${f}`);
console.log("\nInstances on TRACK: release follow the newest tag faithfully and report themselves healthy while doing it, so this drift is invisible from their side. Cut a release, or move the ceilings deliberately.");
process.exit(1);
