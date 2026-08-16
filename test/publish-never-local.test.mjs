// The failure mode this guards is behavioural, not technical.
//
// When a publish fails, a built `dist/` may already be sitting on disk — a real,
// servable artifact. An agent mid-task, watching for "did it build", can mistake that
// for a completed hand-off and give a human a `file://` or `localhost` path. The human
// then looks at something nobody else can see, believing it shipped. It has happened in
// a real adversarial agent test, which is why publish.mjs carries the MEANWHILE line:
// the sanctioned local preview is the real shell, said out loud to be local-only, and
// never a bare file:// path.
//
// Saying it once in one message is not enough — the guidance has to be on every failure
// where an artifact could exist to be mishandled. So this pins the invariant
// structurally: every die() either carries MEANWHILE, or is named below as a failure
// that happens BEFORE anything is built and therefore has nothing to hand over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scripts/publish.mjs", import.meta.url), "utf8");

// Pull out each die(...) call with balanced parentheses, so multi-line messages are
// read whole rather than truncated at the first ");".
function dieCalls(src) {
  const out = [];
  for (let i = src.indexOf("die("); i !== -1; i = src.indexOf("die(", i + 1)) {
    // Skip the definition itself and any `dieFoo(` helper name.
    if (/[A-Za-z0-9_$]/.test(src[i - 1] || "")) continue;
    if (/^\s*(const|function)\s/.test(src.slice(Math.max(0, i - 20), i))) continue;
    let d = 0, j = i + 3;
    for (; j < src.length; j++) {
      if (src[j] === "(") d++;
      else if (src[j] === ")") { d--; if (d === 0) break; }
    }
    out.push({ line: src.slice(0, i).split("\n").length, text: src.slice(i, j + 1) });
  }
  return out;
}

// Failures that fire before the build runs. Nothing has been produced, so there is no
// artifact for an agent to mistake for a hand-off. Each entry is a distinctive substring
// of the message plus the reason it is exempt.
const PRE_BUILD_EXEMPT = [
  ["no target origin", "config error, before discovery — nothing built"],
  ["both declare space", "refuses ambiguous discovery, before the build"],
  ["name a target", "usage error, before the build"],
  ["unknown space", "usage error, before the build"],
];

test("every publish failure that could leave an artifact says not to hand over a local path", () => {
  const calls = dieCalls(SRC);
  assert.ok(calls.length >= 10, `expected to find the die() calls, found ${calls.length}`);

  const missing = [];
  for (const c of calls) {
    if (c.text.includes("MEANWHILE")) continue;
    const exempt = PRE_BUILD_EXEMPT.find(([needle]) => c.text.includes(needle));
    if (exempt) continue;
    missing.push(`  publish.mjs:${c.line}  ${c.text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  assert.deepEqual(missing, [],
    "these failures can happen with a built dist/ on disk but never tell the agent not to\n" +
    "hand over a file:// path. Append ${MEANWHILE}, or add them to PRE_BUILD_EXEMPT with a\n" +
    "reason if they genuinely fire before anything is built:\n" + missing.join("\n"));
});

test("the guidance itself names the sanctioned alternative AND forbids the bare path", () => {
  const i = SRC.indexOf("const MEANWHILE");
  const text = SRC.slice(i, SRC.indexOf(";", i));
  // Offering nothing in place of file:// is how it gets ignored — it has to say what to
  // do instead, and say that the alternative is local-only rather than a hand-off.
  assert.match(text, /dev\.mjs/, "must name the real local shell as the sanctioned preview");
  assert.match(text, /local-only|nobody else can see/i, "must say the preview is not a hand-off");
  assert.match(text, /never hand over a file:\/\/ path/i, "must forbid the bare path explicitly");
});

test("the exempt list stays honest — every entry still matches a real failure", () => {
  const calls = dieCalls(SRC);
  for (const [needle, why] of PRE_BUILD_EXEMPT) {
    assert.ok(calls.some((c) => c.text.includes(needle)),
      `PRE_BUILD_EXEMPT names "${needle}" (${why}) but no die() says that any more — ` +
      "remove the entry rather than leaving a hole nothing checks");
  }
});
