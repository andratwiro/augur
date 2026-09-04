import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, merge3 } from "../scripts/lib/merge3.mjs";

const L = (s) => s.split("\n");

test("diffLines reports replace hunks in both coordinate systems", () => {
  assert.deepEqual(diffLines(L("a\nb\nc"), L("a\nb\nc")), []);
  assert.deepEqual(diffLines(L("a\nb\nc"), L("a\nX\nc")), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(L("a\nc"), L("a\nb\nc")), [{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(L("a\nb\nc"), L("a\nc")), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
  assert.deepEqual(diffLines(L("a\nb\nc\nd\ne"), L("A\nb\nc\nd\nE")), [
    { aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 }, { aStart: 4, aEnd: 5, bStart: 4, bEnd: 5 },
  ]);
});

test("non-overlapping edits from both sides merge", () => {
  const base = "<h1>t</h1>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n<footer/>";
  const mine = base.replace("<p>one</p>", "<p>ONE</p>");
  const theirs = base.replace("<footer/>", "<footer>x</footer>");
  const r = merge3(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.equal(r.text, "<h1>t</h1>\n<p>ONE</p>\n<p>two</p>\n<p>three</p>\n<footer>x</footer>");
  assert.deepEqual(r.conflicts, []);
});

test("identical edits on both sides merge once", () => {
  const base = "a\nb\nc";
  const r = merge3(base, "a\nB\nc", "a\nB\nc");
  assert.equal(r.ok, true);
  assert.equal(r.text, "a\nB\nc");
});

test("one side unchanged takes the other side verbatim", () => {
  const base = "a\nb\nc";
  assert.equal(merge3(base, base, "a\nb\nc\nd").text, "a\nb\nc\nd");
  assert.equal(merge3(base, "z\na\nb\nc", base).text, "z\na\nb\nc");
});

test("overlapping edits are a conflict, reported with both versions and mine kept in the text", () => {
  const base = "a\nb\nc\nd";
  const r = merge3(base, "a\nMINE\nc\nd", "a\nTHEIRS\nc\nd");
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, [{ baseStart: 1, baseEnd: 2, mine: ["MINE"], theirs: ["THEIRS"] }]);
  assert.equal(r.text, "a\nMINE\nc\nd");
});

test("insertions at the same point conflict, adjacent edits do not", () => {
  const same = merge3("a\nb", "a\nX\nb", "a\nY\nb");
  assert.equal(same.ok, false);
  const adjacent = merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nB\nc\nd");
  assert.equal(adjacent.ok, true);
  assert.equal(adjacent.text, "A\nB\nc\nd");
});

test("a trailing newline survives", () => {
  const r = merge3("a\nb\n", "a\nb\nc\n", "a\nb\n");
  assert.equal(r.text, "a\nb\nc\n");
});

test("an emptied side merges to empty, not to a blank line", () => {
  const empty = merge3("", "", "");
  assert.equal(empty.ok, true);
  assert.equal(empty.text, "");
  const deleted = merge3("x", "", "x");
  assert.equal(deleted.ok, true);
  assert.equal(deleted.text, "");
  const deletedNewline = merge3("x\n", "", "x\n");
  assert.equal(deletedNewline.ok, true);
  assert.equal(deletedNewline.text, "");
});

test("a small edit in a very large file merges", () => {
  const baseLines = Array.from({ length: 200000 }, (_, i) => "line " + i);
  const base = baseLines.join("\n");
  const mineLines = baseLines.slice();
  mineLines[10] = "MINE 10";
  const mine = mineLines.join("\n");
  const theirLines = baseLines.slice();
  theirLines[199990] = "THEIRS 199990";
  const theirs = theirLines.join("\n");

  assert.equal(diffLines(baseLines, mineLines).length, 1);
  assert.equal(diffLines(baseLines, theirLines).length, 1);

  const r = merge3(base, mine, theirs);
  assert.equal(r.ok, true);
  const outLines = r.text.split("\n");
  assert.equal(outLines.length, 200000);
  assert.equal(outLines[10], "MINE 10");
  assert.equal(outLines[199990], "THEIRS 199990");
});
