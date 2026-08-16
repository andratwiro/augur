// shell-lint decides what counts as drift. Getting that judgement wrong is worse than
// not having the canary: too strict and every shell shows permanent red until people
// stop reading it, too loose and a real divergence hides among the noise. These tests
// pin the three judgements that matter — filled-in placeholders are fine, chosen
// settings are fine, changed behaviour is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "scripts", "shell-lint.mjs");

// Build a throwaway template dir + shell dir and run the real script over them.
function run(templates, workflows) {
  const dir = mkdtempSync(path.join(tmpdir(), "shell-lint-"));
  const tDir = path.join(dir, "templates");
  const wDir = path.join(dir, "shell", ".github", "workflows");
  mkdirSync(tDir, { recursive: true });
  mkdirSync(wDir, { recursive: true });
  for (const [f, body] of Object.entries(templates)) writeFileSync(path.join(tDir, f), body);
  for (const [f, body] of Object.entries(workflows)) writeFileSync(path.join(wDir, f), body);
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--shell", path.join(dir, "shell"), "--templates", tDir], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a filled-in `your-…` placeholder is not drift", () => {
  const r = run(
    { "a.yml": "jobs:\n  x:\n    env:\n      SITE: https://your-site-origin.example # ← your siteOrigin\n" },
    { "a.yml": "jobs:\n  x:\n    env:\n      SITE: https://real.example.com # ← your siteOrigin\n" },
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /clean/);
});

test("a setting marked SET BEFORE USE may be chosen differently, even with the comment rewritten", () => {
  const r = run(
    { "a.yml": "# SET BEFORE USE — pick a channel:\n#   release  follow tags\n#   main     follow main\nTRACK: release\n" },
    { "a.yml": "# main, not release: this instance dogfoods the engine and a lagging\n# pin is the one state it must not be in.\nTRACK: main\n" },
  );
  assert.equal(r.code, 0, r.out);
});

test("a changed command IS drift, and the diverging line is shown", () => {
  const r = run(
    { "a.yml": "steps:\n  - run: node engine/scripts/export.mjs --out backup\n" },
    { "a.yml": "steps:\n  - run: node engine/scripts/export.mjs --out /tmp/backup\n" },
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /DRIFT/);
  assert.match(r.out, /--out backup/);
  assert.match(r.out, /--out \/tmp\/backup/);
});

test("a trigger the shell is missing IS drift — the silent-dispatch case this was built for", () => {
  const r = run(
    { "a.yml": "on:\n  repository_dispatch:\n    types: [engine-updated]\n  schedule:\n    - cron: \"17 6 * * 1\"\n" },
    { "a.yml": "on:\n  schedule:\n    - cron: \"17 6 * * 1\"\n" },
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /repository_dispatch/);
});

test("a reworded comment is reported but does not fail the run", () => {
  const r = run(
    { "a.yml": "# Ships the site.\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n" },
    { "a.yml": "# Ships the site. Runs on every push to main.\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n" },
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /prose|reworded/);
});

test("a workflow with no template, and a template the shell skipped, are both reported not fatal", () => {
  const r = run(
    { "a.yml": "jobs:\n  x:\n    runs-on: ubuntu-latest\n", "unused.yml": "jobs:\n  y:\n    runs-on: ubuntu-latest\n" },
    { "a.yml": "jobs:\n  x:\n    runs-on: ubuntu-latest\n", "mine.yml": "jobs:\n  z:\n    runs-on: ubuntu-latest\n" },
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not installed.*unused\.yml/);
  assert.match(r.out, /no template.*mine\.yml/);
});
