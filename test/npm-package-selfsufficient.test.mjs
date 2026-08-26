// Does the packed CLI work with no engine checkout beside it?
//
// `C-npm-package-cli`. Every script here resolves its paths relative to ITSELF —
// `scripts/lib/store.mjs` computes `ENGINE_ROOT` from its own directory, `cli.mjs`
// dispatches to `path.join(SCRIPTS, …)`, and `publish.mjs` unconditionally spawns
// `node build.js` before every upload. That works today because there is always a git
// clone around it. A published package has no clone: it has whatever the `files`
// allowlist shipped, and anything missing fails at the moment somebody is trying to
// publish their work.
//
// So this packs the real tarball, unpacks it somewhere with NO sibling engine, no
// `.env.deploy` and no deploy shell, and drives the CLI there. It is the item's VERIFY
// minus the one step an agent should not take — the publish itself.
//
// NOTE ON THE NAME: `augur` is already taken on npm (a promises library, v1.0.2), so
// `npm install -g augur` will never be this project and the item's VERIFY cannot be met
// as written. That is a naming decision, not a packaging one, and it is written down for
// the maintainer rather than guessed at here. Nothing below depends on the package's name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(ENGINE, "package.json"), "utf8"));

/** Pack the real package and unpack it into a throwaway directory. */
let packed = null;
function unpacked() {
  if (packed) return packed;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-pack-"));
  const tgz = execFileSync("npm", ["pack", "--pack-destination", dir], { cwd: ENGINE, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", path.join(dir, tgz), "-C", dir]);
  packed = path.join(dir, "package");
  return packed;
}

test("the package declares a files allowlist rather than shipping the repo", () => {
  assert.ok(Array.isArray(PKG.files) && PKG.files.length, "no `files` allowlist — a publish would ship the whole tree");
});

test("EVERY command in the CLI dispatch map resolves inside the tarball", () => {
  // The dispatch map is the contract. A command that resolves to a file the allowlist did
  // not ship fails at the moment somebody is trying to publish their work.
  const dir = unpacked();
  const cli = fs.readFileSync(path.join(ENGINE, "scripts", "cli.mjs"), "utf8");
  const block = cli.slice(cli.indexOf("const map = {"), cli.indexOf("};", cli.indexOf("const map = {")));
  const targets = [...block.matchAll(/^\s*(\w+):\s*(?:"([^"]+)"|path\.join\(([^)]+)\))/gm)].map((m) => {
    if (m[2]) return [m[1], path.join("scripts", m[2])];
    // path.join("..", "build.js") — resolve it relative to scripts/
    const parts = m[3].split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""));
    return [m[1], path.normalize(path.join("scripts", ...parts))];
  });
  assert.ok(targets.length >= 10, `only found ${targets.length} commands in the dispatch map`);
  for (const [name, rel] of targets) {
    assert.ok(fs.existsSync(path.join(dir, rel)), `\`augur ${name}\` dispatches to ${rel}, which the tarball does not contain`);
  }
});

test("everything scripts/ and build.js IMPORT is in the tarball too", () => {
  // The allowlist is a list of directories, so a new relative import into a directory
  // nobody listed is the way this breaks. Follow them rather than trusting the list.
  const dir = unpacked();
  const seen = new Set();
  const missing = [];
  const walk = (abs) => {
    const rel = path.relative(dir, abs);
    if (seen.has(rel)) return;
    seen.add(rel);
    let src;
    try { src = fs.readFileSync(abs, "utf8"); } catch { missing.push(rel); return; }
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(abs), m[1]);
      const candidates = [target, target + ".mjs", target + ".js", path.join(target, "index.mjs"), path.join(target, "index.js")];
      const hit = candidates.find((c) => fs.existsSync(c));
      if (!hit) missing.push(`${path.relative(dir, abs)} → ${m[1]}`);
      else walk(hit);
    }
  };
  walk(path.join(dir, "build.js"));
  for (const f of fs.readdirSync(path.join(dir, "scripts"))) {
    if (f.endsWith(".mjs")) walk(path.join(dir, "scripts", f));
  }
  assert.deepEqual(missing, [], `the tarball is missing modules its own code imports:\n  ${missing.join("\n  ")}`);
});

test("`augur` with no arguments prints usage from a tarball with no clone around it", () => {
  const dir = unpacked();
  // Deliberately run with a cwd that is NOT a space and NOT next to an engine checkout.
  // Usage goes to STDERR and exits 0, so read both streams rather than assuming stdout.
  const r = spawnSync(process.execPath, [path.join(dir, "scripts", "cli.mjs")], {
    cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, GV_SPACES_ROOT: "", AUGUR_TOKEN: "" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.match(out, /usage: augur/);
  assert.match(out, /publish/);
  assert.equal(r.status, 0, "bare `augur` should exit 0 — it is a help request, not an error");
});

test("`augur build` RUNS from the tarball, with no repo and no .env.deploy", () => {
  // build.js is the one every publish spawns, and it is the one with real inputs on disk
  // (templates, brand, fonts, src). If the allowlist missed any of them this is where it
  // shows, rather than in front of somebody mid-publish.
  const dir = unpacked();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "augur-pack-dist-"));
  const spaces = fs.mkdtempSync(path.join(os.tmpdir(), "augur-pack-spaces-"));
  const res = execFileSync(process.execPath, [path.join(dir, "scripts", "cli.mjs"), "build"], {
    cwd: os.tmpdir(), encoding: "utf8",
    env: { ...process.env, GV_ENGINE_ONLY: "1", GV_DIST: out, GV_SPACES_ROOT: spaces },
  });
  assert.match(res, /Built dist/);
  for (const f of ["_worker.js", "404.html", "sw.js", "__config/instance.json"]) {
    assert.ok(fs.existsSync(path.join(out, f)), `a tarball build did not emit ${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(spaces, { recursive: true, force: true });
});

test("the tarball does NOT carry the test suite, CI config, or docs nobody needs", () => {
  // Not tidiness: `test/` alone is ~80 files and several fixtures, and a published package
  // that ships its own CI config invites somebody to run it.
  const dir = unpacked();
  for (const junk of ["test", ".github", "docs", "node_modules", "dist", ".env.deploy"]) {
    assert.ok(!fs.existsSync(path.join(dir, junk)), `the tarball ships ${junk}/`);
  }
});

test("the tarball carries no credential-shaped file", () => {
  const dir = unpacked();
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (/^\.env|\.pem$|\.key$|secrets?\.(json|env)$/i.test(e.name)) bad.push(path.relative(dir, abs));
    }
  };
  walk(dir);
  assert.deepEqual(bad, [], `the tarball ships credential-shaped files: ${bad.join(", ")}`);
});

test("it is still marked private, so nobody publishes it before the name is settled", () => {
  // `augur` is taken on npm. Flipping this is the publish decision and it belongs to a
  // person, along with choosing the scope or the new name. Until then the safety catch
  // stays on, and this test is what says so out loud.
  assert.equal(PKG.private, true,
    "package.json is no longer private — if the name is settled, delete this test in the same commit that says what the name is");
});
