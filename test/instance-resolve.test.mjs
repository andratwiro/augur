// findShellDir with several instances in one parent: the shell whose declared
// siteOrigin matches the target host wins; without a host, the old shape-only
// resolution (alphabetical) still applies, and a single shell needs no origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findShellDir } from "../scripts/lib/instance.mjs";

function tempParent() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "augur-shells-"));
  const engine = path.join(parent, "engine");
  mkdirSync(engine);
  return { parent, engine };
}
function shell(parent, name, siteOrigin) {
  const dir = path.join(parent, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "identity.json"), "[]");
  if (siteOrigin) writeFileSync(path.join(dir, "deploy.config.json"), JSON.stringify({ siteOrigin }));
  return dir;
}

test("two shells, a target host: the origin-matched shell wins over the alphabetical one", () => {
  const { parent, engine } = tempParent();
  try {
    const a = shell(parent, "a-shell", "https://a.example.test");
    const b = shell(parent, "b-shell", "https://b.example.test");
    assert.equal(findShellDir(engine, "b.example.test"), b);
    assert.equal(findShellDir(engine, "a.example.test"), a);
    // Unknown host (an alias the shells don't declare): shape resolution, first sorted.
    assert.equal(findShellDir(engine, "cname-alias.example.test"), a);
    // No host at all: unchanged legacy behavior.
    assert.equal(findShellDir(engine), a);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("one shell resolves with or without a host, config or not", () => {
  const { parent, engine } = tempParent();
  try {
    const only = shell(parent, "the-shell", null); // no deploy.config.json at all
    assert.equal(findShellDir(engine, "whatever.example.test"), only);
    assert.equal(findShellDir(engine), only);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a space dir (space.json) is never mistaken for a shell", () => {
  const { parent, engine } = tempParent();
  try {
    const dir = path.join(parent, "a-space");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "identity.json"), "[]");
    writeFileSync(path.join(dir, "space.json"), "{}");
    assert.equal(findShellDir(engine), null);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
