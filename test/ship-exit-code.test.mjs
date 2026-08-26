// Guards ship.mjs's final exit-code semantics.
//
// `augur ship` is commit → publish → push, in that order, specifically so a network
// problem never stands between someone and seeing their own work (publish.mjs's own
// header: "exit code is truth"). By the time ship.mjs reaches its report section, commit
// and publish have ALREADY succeeded — either failing calls die() upstream, which exits
// the whole process before this point is ever reached (see publish() and the commit
// block above it in ship.mjs). So a push that didn't land is the only outcome this file's
// exit code can still get wrong, and getting it wrong is exactly the bug this guards: the
// live site is already true, and reporting total failure over a lagging `git push` is a
// lie a coding agent has no way to catch on its own — it would report work as lost that
// is, in fact, live.
//
// ship.mjs has no exports (it runs for its side effects), so this lifts the pure decision
// out of the source and runs it for real, the same technique test/publish-filter.test.mjs
// and test/canvas.test.mjs use for build.js and canvas.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scripts/ship.mjs", import.meta.url), "utf8");
const fnStart = SRC.indexOf("function pushFailureNotice(");
const fnSrc = SRC.slice(fnStart, SRC.indexOf("\n}", fnStart) + 2);
const pushFailureNotice = new Function(`${fnSrc}\nreturn pushFailureNotice;`)();

test("the notice was actually lifted out of ship.mjs", () => {
  assert.equal(typeof pushFailureNotice, "function");
});

test("push succeeded: no notice", () => {
  assert.equal(pushFailureNotice(true, false, true), null);
});

test("--no-push: no notice — the user explicitly asked to skip it", () => {
  assert.equal(pushFailureNotice(false, true, true), null);
});

test("NO REPO: no notice, because there is nowhere to push to", () => {
  // `C-repo-less-ship`. A hosted workspace may never have a git repo — `augur clone`
  // already produces a folder with no `.git` — and "GitHub does not know about this yet"
  // is advice about a thing that does not exist. The publish is the whole of the ship.
  assert.equal(pushFailureNotice(false, false, false), null);
  assert.equal(pushFailureNotice(true, false, false), null);
});

test("push failed (not --no-push): an explicit notice that says the work is live", () => {
  const notice = pushFailureNotice(false, false, true);
  assert.match(notice, /published/i);
  assert.match(notice, /live/i);
  assert.match(notice, /push failed/i);
  assert.doesNotMatch(notice, /error|failed to publish|nothing shipped/i,
    "must not read as the ship itself having failed — only the sync to GitHub did");
});

// The line that regresses this bug in the first place: the exit code itself. Verified
// directly against the source rather than by spawning the CLI (which would need a real
// git remote and a real publish backend) — the exact bug report was `process.exit(pushed
// || NO_PUSH ? 0 : 1)`, a nonzero exit for a state that is already fully live.
test("the final exit is unconditional 0 — a lagging push is never reported as failure", () => {
  const reportSection = SRC.slice(SRC.indexOf("// ── report"));
  assert.match(reportSection, /process\.exit\(0\);\s*$/,
    "the last statement in the file must be an unconditional process.exit(0)");
  assert.doesNotMatch(reportSection, /process\.exit\(\s*pushed/,
    "must not condition the ship's own exit code on whether the push landed");
});
