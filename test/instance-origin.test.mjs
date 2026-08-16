// deployConfig's tiebreak when several instances share one parent folder.
//
// findShellDir has always been able to pick the shell matching a target host
// (instance-resolve.test.mjs covers it), but deployConfig never passed one — so it
// fell through to "first shell BY NAME". Every origin-resolving caller
// (publish/login/export) ranks deployConfig().siteOrigin ABOVE the space's own
// space.json siteOrigin, so with two shells checked out side by side the
// alphabetically-first instance answered for every space in the folder: publishing
// from space B aimed at instance A, and `augur login` from space B logged you into
// instance A. Which live instance a publish reached came down to directory sort
// order.
//
// The tiebreak is the space's OWN declared siteOrigin, and it must stay a TIEBREAK:
// with one shell the answer has to be that shell either way, or anyone who cloned a
// starter space to run their own instance would publish to the origin the space.json
// they inherited names — someone else's live site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deployConfig, originHost } from "../scripts/lib/instance.mjs";

function tempParent() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "augur-origin-"));
  const engine = path.join(parent, "engine");
  mkdirSync(engine);
  return { parent, engine };
}
function shell(parent, name, siteOrigin) {
  const dir = path.join(parent, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "identity.json"), "[]");
  writeFileSync(path.join(dir, "deploy.config.json"), JSON.stringify({ siteOrigin }));
  return dir;
}

test("two shells: the space's own origin picks its instance, not the alphabet", () => {
  const { parent, engine } = tempParent();
  try {
    shell(parent, "deploy-alpha", "https://alpha.example.test");
    shell(parent, "deploy-beta", "https://beta.example.test");
    // The bug: no hint, so the alphabetically-first shell answers for everything.
    assert.equal(deployConfig(engine).siteOrigin, "https://alpha.example.test");
    // The fix: a space declaring beta resolves to beta's shell.
    assert.equal(
      deployConfig(engine, originHost("https://beta.example.test")).siteOrigin,
      "https://beta.example.test",
    );
    // …and one declaring alpha still gets alpha.
    assert.equal(
      deployConfig(engine, originHost("https://alpha.example.test")).siteOrigin,
      "https://alpha.example.test",
    );
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("one shell wins regardless of what the space declares", () => {
  const { parent, engine } = tempParent();
  try {
    shell(parent, "the-shell", "https://mine.example.test");
    // A clone of someone else's starter space carries THEIR siteOrigin. It must not
    // drag the publish to their instance — with a single shell that shell answers,
    // and the inherited origin is ignored.
    assert.equal(
      deployConfig(engine, originHost("https://someone-elses.example.test")).siteOrigin,
      "https://mine.example.test",
    );
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a host that matches no shell falls back rather than resolving to nothing", () => {
  const { parent, engine } = tempParent();
  try {
    shell(parent, "deploy-alpha", "https://alpha.example.test");
    shell(parent, "deploy-beta", "https://beta.example.test");
    // A vanity alias or a typo must not strand the caller with an empty config.
    assert.equal(
      deployConfig(engine, originHost("https://unknown.example.test")).siteOrigin,
      "https://alpha.example.test",
    );
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("originHost tolerates the empty and the malformed", () => {
  assert.equal(originHost("https://x.example.test/base/"), "x.example.test");
  assert.equal(originHost(""), "");
  assert.equal(originHost("not a url"), "");
  assert.equal(originHost(undefined), "");
});
