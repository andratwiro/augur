// `augur open --new a/b` is how the docs spell it; `augur open a/b --new` is how the code
// read it. Both must name the same prototype, and a value flag's value is never a name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { positionals } from "../scripts/lib/cli-args.mjs";

const V = ["--dir", "--session", "--origin"];
test("a bare flag takes no value, on either side of the name", () => {
  assert.deepEqual(positionals(["--new", "opp/name", "--dir", "x"], V), ["opp/name"]);
  assert.deepEqual(positionals(["opp/name", "--new", "--dir", "x"], V), ["opp/name"]);
  assert.deepEqual(positionals(["--new-opportunity", "--new", "opp/name"], V), ["opp/name"]);
});
test("a value flag's value is never taken for the name", () => {
  assert.deepEqual(positionals(["--dir", "folder", "opp/name"], V), ["opp/name"]);
  assert.deepEqual(positionals(["--dir=folder", "opp/name"], V), ["opp/name"]);
  assert.deepEqual(positionals(["--session", "s1", "--dir", "d"], V), []);
});
