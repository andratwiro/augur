// test/paired-origin.test.mjs — after `augur connect`, the CLI knows which workspace it
// paired with. Seen on a cold machine: the agent paired, then `clone` and `open` refused
// with "no target origin" until it set AUGUR_ORIGIN by hand, which the front door had
// said the pairing would carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const probe = (home) => spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { resolveOrigin } from "./scripts/lib/store.mjs"; console.log(resolveOrigin("/nowhere"));'],
  { env: { ...process.env, HOME: home, AUGUR_ORIGIN: "" }, encoding: "utf8", cwd: path.resolve(".") });
const homeWith = (tokens) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  if (tokens) { fs.mkdirSync(path.join(home, ".config", "augur"), { recursive: true }); fs.writeFileSync(path.join(home, ".config", "augur", "tokens.json"), JSON.stringify(tokens)); }
  return home;
};

test("one saved pairing is the origin when nothing else names one", () => {
  const r = probe(homeWith({ "acme.example": { token: "t", space: "acme", via: "connect", at: "2026-09-06T12:00:00.000Z" } }));
  assert.equal(r.stdout.trim(), "https://acme.example");
  assert.equal(r.stderr.trim(), "", "nothing to warn about");
});

test("several saved pairings: the most recent, said on stderr", () => {
  const r = probe(homeWith({
    "old.example": { token: "t", space: "old", via: "connect", at: "2026-08-01T00:00:00.000Z" },
    "new.example": { token: "t", space: "new", via: "connect", at: "2026-09-06T12:00:00.000Z" },
  }));
  assert.equal(r.stdout.trim(), "https://new.example");
  assert.match(r.stderr, /using the last pairing, https:\/\/new\.example/);
});

test("no pairing at all still resolves to nothing", () => {
  const r = probe(homeWith(null));
  assert.equal(r.stdout.trim(), "");
});
