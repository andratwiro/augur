// `augur adopt` — the command that copies an instance's KV into its own workspace object.
//
// `B-kv-to-do-migration-tool`. The script is thin on purpose: the instance already knows how
// to export itself and how to import a document, so adopt is those two joined. What is
// tested here is the part that is NOT thin — the four things it must refuse or report, each
// of which is a way a copy could look successful while having copied nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(path.join(ROOT, "scripts/adopt.mjs"), "utf8");

test("it refuses when no workspace object took the copy", () => {
  // The failure this exists to prevent: with no TENANTS binding the import writes KV exactly
  // as it found it and answers ok, so every other signal looks like a successful copy. The
  // worker says `workspaceObject` out loud and the command has to act on it.
  assert.match(SRC, /res\.workspaceObject/, "adopt must read the workspaceObject flag");
  const at = SRC.indexOf("res.workspaceObject");
  const after = SRC.slice(at, at + 400);
  assert.match(after, /die\(/, "a missing workspace object has to be fatal, not a warning");
});

test("it never sends prune or clear", () => {
  // Both are a RESET's verbs. A copy that could empty a family is not a copy, and an export
  // document would carry them straight through if the body were built by spreading it.
  assert.doesNotMatch(SRC, /\.\.\.doc\b/, "spreading the export document would carry prune/clear into the copy");
  const body = /const body = \{([^}]*)\}/.exec(SRC);
  assert.ok(body, "the request body is built explicitly");
  assert.doesNotMatch(body[1], /prune|clear/, "neither verb belongs in a copy");
});

test("it refuses an export that could not read a family", () => {
  // A short copy that reports success is the whole failure mode. The worker refuses this too;
  // failing here is what makes the operator hear which family rather than read a rejection.
  assert.match(SRC, /doc\.failed/, "an incomplete export has to stop the run");
});

test("it reports what it could NOT carry, every run", () => {
  // `unmapped` names families with nowhere to land and `refusedRows` names rows the object
  // declined — a role outside the CHECK constraint, say. Printing them only behind a flag
  // would make the default output a claim the copy was complete.
  assert.match(SRC, /res\.unmapped/);
  assert.match(SRC, /res\.refusedRows/);
  assert.doesNotMatch(SRC, /if \(VERBOSE\)|--verbose/, "these are not optional output");
});

test("the CLI knows the verb, and keeps it apart from migrate", () => {
  const cli = readFileSync(path.join(ROOT, "scripts/cli.mjs"), "utf8");
  assert.match(cli, /adopt:\s*"adopt\.mjs"/);
  assert.match(cli, /\|adopt\|/, "the usage line lists it");
  // `augur migrate` moves a workspace to ANOTHER instance. Two verbs one keystroke apart,
  // run against something live, is a trap rather than a naming quibble — so the map says so
  // where somebody adding a third verb will read it.
  assert.match(cli, /NOT a synonym for migrate/);
});
