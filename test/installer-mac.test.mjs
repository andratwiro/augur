// installer-mac.test.mjs — the macOS installer arrives EXECUTABLE, is valid bash, names
// the agent tool only through AGENT_TOOL, needs no admin rights, and never stops without
// telling the person what to do next.
//
// The first test is the load-bearing one and it is deliberately not a string assertion:
// the whole reason the route serves a zip is that HTTP carries no file mode, so the only
// honest check is to unpack the archive the way a person's Mac would and look at the mode
// on the file that comes out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { macInstallerScript, installerFileNames } from "../src/installer-mac.mjs";
import { zipSingleFile } from "../src/zip-store.mjs";
import { AGENT_TOOL } from "../src/agent-tool.mjs";

const SCRIPT = () => macInstallerScript({ origin: "https://acme.example", agentTool: AGENT_TOOL });
const haveUnzip = () => {
  const r = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  return !r.error && r.status === 0;
};

test("the download unpacks to an EXECUTABLE .command holding the script, and bash accepts it", (t) => {
  if (!haveUnzip()) {
    t.skip("`unzip` is not on PATH here — install it (it ships with macOS and most Linux runners) to run the one check that proves the download arrives executable");
    return;
  }
  const s = SCRIPT();
  const names = installerFileNames("acme.example");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inst-"));
  const archive = path.join(dir, names.zip);
  fs.writeFileSync(archive, zipSingleFile({ name: names.command, bytes: s }));

  const un = spawnSync("unzip", ["-o", "-q", archive, "-d", dir], { encoding: "utf8" });
  assert.equal(un.status, 0, `unzip: ${un.stderr || un.stdout}`);

  const out = path.join(dir, names.command);
  const mode = fs.statSync(out).mode;
  assert.ok(mode & 0o111, `the unpacked ${names.command} is not executable (mode ${(mode & 0o777).toString(8)}) — Terminal will refuse to run it`);
  assert.equal(fs.readFileSync(out, "utf8"), s, "the unpacked file is the script, byte for byte");
  // The shebang is /bin/bash, so this is the interpreter that has to accept it — `bash`
  // off PATH could be a 5.x from a package manager and would not be what runs it.
  assert.equal(spawnSync("/bin/bash", ["-n", out]).status, 0, "/bin/bash -n on the unpacked file");
});

test("the installer is valid bash, bakes the origin in, and touches nothing outside the home", () => {
  const s = SCRIPT();
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inst-")), "x.command"); fs.writeFileSync(f, s);
  assert.equal(spawnSync("/bin/bash", ["-n", f]).status, 0, "bash -n");
  assert.match(s, /connect --origin "https:\/\/acme\.example"/, "quoted: an origin is interpolated into a shell line");
  assert.doesNotMatch(s, /\bsudo\b/);
  assert.match(s, /set -euo pipefail/);
});

test("the script names the agent tool only through agentTool.name/install/bin", () => {
  const tool = { id: "x", name: "Widget Agent", install: "npm install -g @widget/agent", bin: "widgetagent" };
  const s = macInstallerScript({ origin: "https://acme.example", agentTool: tool });
  assert.match(s, /Widget Agent/);
  assert.match(s, /npm install -g @widget\/agent/);
  assert.match(s, /widgetagent/);
});

test("every failure path prints a sentence and waits for Return before exiting", () => {
  const s = SCRIPT();
  assert.match(s, /fail\(\)\s*\{[^}]*read -r[^}]*exit 1/s, "fail() prints, waits, then exits");
  // a bare `set -e` exit with no trap is a vanished window — this is the catch-all.
  assert.match(s, /trap\s+.*\bERR\b/, "an ERR trap catches anything not explicitly guarded");
  assert.match(s, /Nothing outside your home folder was changed/, "the reassurance has to be true: this script writes ~/.augur, ~/Augur, ~/.zprofile and (through the CLI) ~/.config/augur");
});

// ⚠️ THE RULE THIS PINS. The reader of a `fail` line has no terminal, no colleague and no
// idea which of the four steps they were on. "could not install X" leaves them nowhere;
// a next move they can make alone is the whole point. A new failure sentence with no
// remedy in it fails here, and widening REMEDIES to admit it is the wrong fix.
const REMEDIES = [
  /run this file again/i,
  /open a new one/i,
  /open Terminal/i,
  /ask the person who invited you/i,
  /send the person who invited you/i,
];
test("every fail message says one thing the person can do next", () => {
  const s = SCRIPT();
  const said = [...s.matchAll(/\bfail "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(said.length >= 6, `expected the script's failure sentences, found ${said.length}`);
  for (const line of said) {
    assert.ok(REMEDIES.some((r) => r.test(line)), `no remedy in: ${line}`);
  }
});

test("the last step is guarded, so exec cannot slip past the ERR trap", () => {
  const s = SCRIPT();
  const guardAt = s.lastIndexOf(`command -v ${AGENT_TOOL.bin} >/dev/null 2>&1 || fail`);
  const execAt = s.lastIndexOf(`exec ${AGENT_TOOL.bin}`);
  assert.ok(guardAt >= 0, "a command -v guard stands before the exec");
  assert.ok(execAt > guardAt, "the guard comes first — exec replaces the shell and takes the trap with it");
});

test("step 3 verifies the CLI is really there, and lets npm say why when it is not", () => {
  const s = SCRIPT();
  assert.match(s, /command -v augur >\/dev\/null 2>&1 \|\| fail "/, "the CLI is verified, not merely version-probed");
  assert.doesNotMatch(s, /npm install -g @augurworks\/augur\s*>\/dev\/null/, "npm's own words are the only diagnosis a person has");
  assert.doesNotMatch(s, /npm install -g \S+\s*>\/dev\/null/, "neither global install may be silenced");
  assert.doesNotMatch(s, /augur --version/, "a version probe that swallows its own failure verifies nothing");
});

test("the unpack has its own sentence, and the version probe cannot print a shell error", () => {
  const s = SCRIPT();
  assert.match(s, /tar -xzf[^\n]*\|\| fail "the download was damaged/, "a truncated tarball is its own failure, not the catch-all's");
  // `[ "" -ge 20 ]` prints `integer expression expected` at a person who has done nothing
  // wrong. NODE_MAJOR is defaulted AND filtered to digits before it is compared.
  assert.match(s, /case "\$\{NODE_MAJOR:-0\}" in ''\|\*\[!0-9\]\*\) NODE_MAJOR=0/, "a non-numeric probe answer is normalised before the comparison");
  assert.match(s, /\[ "\$\{NODE_MAJOR:-0\}" -ge 20 \]/);
});

test("the PATH is persisted for later Terminal windows, once, and the person is told", () => {
  const s = SCRIPT();
  assert.match(s, /PROFILE="\$HOME\/\.zprofile"/);
  assert.match(s, /\$HOME\/\.augur\/node\/bin/, "the Node install is on the persisted PATH");
  assert.match(s, /\$HOME\/\.augur\/npm\/bin/, "so are the globally installed CLIs");
  assert.match(s, /if ! grep -qF "\$PATH_LINE" "\$PROFILE"/, "appended only when it is not already there — running this twice must not write it twice");
  assert.match(s, /echo "added these tools to your PATH in ~\/\.zprofile/, "a change to a person's shell profile is announced, never silent");
});

// ── the ~/.zprofile append, run for real ────────────────────────────────────────────────
//
// Extracted as a standalone fragment rather than run through the whole installer, because
// the rest of the script downloads Node and installs two globals. The fragment is exactly
// what a real run executes — same text, same PROFILE/PATH_LINE variables, same guard.
function extractProfileBlock(s) {
  const start = s.indexOf('PROFILE="$HOME/.zprofile"');
  const end = s.indexOf('\nmkdir -p "$HOME/Augur/', start);
  assert.ok(start >= 0 && end > start, "the profile-append block markers were found in the generated script");
  return s.slice(start, end);
}
const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

test("the ~/.zprofile append lands on its own line, exactly once, whatever the file looked like before", () => {
  const block = extractProfileBlock(SCRIPT());
  const cases = [
    { label: "no ~/.zprofile at all", seed: null },
    { label: "~/.zprofile already ends in a newline", seed: "export EDITOR=vim\n" },
    { label: "~/.zprofile does NOT end in a newline", seed: "export EDITOR=vim" },
  ];
  for (const { label, seed } of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prof-"));
    const profile = path.join(home, ".zprofile");
    if (seed !== null) fs.writeFileSync(profile, seed);
    for (let run = 1; run <= 2; run++) {
      const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${block}`], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      assert.equal(r.status, 0, `${label}, run ${run}: ${r.stderr}`);
    }
    const text = fs.readFileSync(profile, "utf8");
    const pathLines = text.split("\n").filter((l) => l.includes("added by Augur"));
    assert.equal(pathLines.length, 1, `${label}: expected the PATH line exactly once, found ${pathLines.length}\n---\n${text}`);
    assert.equal(pathLines[0], 'export PATH="$HOME/.augur/node/bin:$HOME/.augur/npm/bin:$PATH"  # added by Augur', `${label}: the PATH line is on its own line, not glued to another`);
    if (seed) {
      assert.ok(text.split("\n").includes("export EDITOR=vim"), `${label}: the pre-existing line survives intact, not corrupted by the append`);
    }
  }
});

test("an unwritable ~/.zprofile is a warning, not a failure — everything else already succeeded", (t) => {
  if (isRoot()) { t.skip("running as root — file permissions do not block root, so this cannot be proven here"); return; }
  const block = extractProfileBlock(SCRIPT());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prof-"));
  const profile = path.join(home, ".zprofile");
  fs.writeFileSync(profile, "export EDITOR=vim\n");
  fs.chmodSync(profile, 0o444);
  const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${block}`], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, `an unwritable profile must not fail the script (pairing already succeeded): ${r.stderr}`);
  assert.match(r.stdout, /Setup finished/, "says setup finished");
  assert.match(r.stdout, /new Terminal window/i, "says what to do in a new Terminal");
  assert.match(r.stdout, new RegExp(`\\b${AGENT_TOOL.bin}\\b`), "names the fallback command to start the agent directly");
  assert.equal(fs.readFileSync(profile, "utf8"), "export EDITOR=vim\n", "the unwritable file itself is untouched");
});

test("connects with --no-wait first (to print the code) then again to collect it — the second call opens the tab itself, so the installer never opens one of its own", () => {
  const s = SCRIPT();
  assert.match(s, /connect --origin "https:\/\/acme\.example" --no-wait/);
  // Since 9b, a waiting `augur connect` opens the approval page (/__connect?code=…) itself (scripts/connect.mjs)
  // with the code already filled in — an installer-side `open` would be a second tab.
  assert.doesNotMatch(s, /\bopen "https:\/\/acme\.example/);
  assert.match(s, /code below already filled in/);
});

test("exports npm_config_prefix before installing the CLI with npm", () => {
  const s = SCRIPT();
  const prefixAt = s.indexOf("npm_config_prefix");
  const installAt = s.indexOf("npm install -g @augurworks/augur");
  assert.ok(prefixAt >= 0 && installAt >= 0 && prefixAt < installAt, "npm_config_prefix exported before the npm install line");
});

// ── the names, in one place ──────────────────────────────────────────────────────────

test("installerFileNames turns a host:port into a filename without collapsing it", () => {
  assert.deepEqual(installerFileNames("acme.example"), { command: "connect-acme.example.command", zip: "connect-acme.example.zip" });
  // The old sanitiser DROPPED the colon, so `localhost:8788` became `localhost8788` — a
  // name that reads as a hostname nobody has.
  assert.deepEqual(installerFileNames("localhost:8788"), { command: "connect-localhost-8788.command", zip: "connect-localhost-8788.zip" });
  assert.equal(installerFileNames("a/../b").command, "connect-a..b.command", "anything not [a-z0-9.-] is dropped");
});

// ── the archive itself ───────────────────────────────────────────────────────────────

test("zipSingleFile records the unix mode where an unpacker looks for it", () => {
  const z = zipSingleFile({ name: "a.command", bytes: "hi\n", mode: 0o755 });
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, "local file header signature");
  const cd = 30 + "a.command".length + 3;
  assert.equal(view.getUint32(cd, true), 0x02014b50, "central directory signature");
  assert.equal(view.getUint16(cd + 4, true) >> 8, 3, "version made by: upper byte 3 = Unix, or the mode below is ignored");
  assert.equal(view.getUint16(cd + 10, true), 0, "method 0 = stored, so the payload is legible in the archive");
  assert.equal(view.getUint32(cd + 38, true) >>> 16, 0o100755, "external attributes carry S_IFREG | 0755");
  assert.equal(view.getUint32(cd + centralOffset("a.command"), true), 0x06054b50, "end of central directory");
});
function centralOffset(name) { return 46 + name.length; }

test("zipSingleFile round-trips exact bytes and refuses a nameless entry", (t) => {
  if (!haveUnzip()) { t.skip("`unzip` is not on PATH here"); return; }
  const body = "#!/bin/bash\n# ünïcødé and \"quotes\" and $dollars\necho ok\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
  const archive = path.join(dir, "a.zip");
  fs.writeFileSync(archive, zipSingleFile({ name: "payload.sh", bytes: body, mode: 0o644 }));
  assert.equal(spawnSync("unzip", ["-o", "-q", archive, "-d", dir]).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "payload.sh"), "utf8"), body);
  assert.equal(fs.statSync(path.join(dir, "payload.sh")).mode & 0o111, 0, "a mode of 0644 stays 0644");
  assert.throws(() => zipSingleFile({ bytes: "x" }), /entry name/);
});
