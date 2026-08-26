// The shell's nightly KV backup is shell, not JavaScript, so the codec's guarantees do
// not reach it by import — they have to hold in jq and curl too. This test EXTRACTS the
// per-value encode block from templates/shell/kv-backup.yml (between the `value-encode`
// sentinels) and runs it, so what is asserted is the shipped lines rather than a
// paraphrase of them.
//
// The value it runs them against is a real PNG. A string with odd characters in it would
// pass the old code as happily as the new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeKvValue, isBinaryKvValue, sha256Hex } from "../src/kv-codec.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YML = path.join(ROOT, "templates", "shell", "kv-backup.yml");
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

// The sentinels are load-bearing: without them this test silently stops testing the
// workflow and starts testing nothing at all.
function encodeBlock() {
  const src = readFileSync(YML, "utf8");
  const lines = src.split("\n");
  const a = lines.findIndex((l) => l.includes(">>> value-encode"));
  const b = lines.findIndex((l) => l.includes("<<< value-encode"));
  assert.ok(a > 0 && b > a, "templates/shell/kv-backup.yml lost its value-encode sentinels");
  return lines.slice(a + 1, b).map((l) => l.replace(/^ {10}/, "")).join("\n");
}

const have = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
  || spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;

// Run the extracted block once, with KEY/WORK/OUT bound the way the workflow binds them.
function runBlock(key, valueBytes) {
  const work = mkdtempSync(path.join(tmpdir(), "kvbk-"));
  writeFileSync(path.join(work, "value"), Buffer.from(valueBytes));
  const out = path.join(work, "out.json");
  const script = `set -euo pipefail\nKEY=${JSON.stringify(key)}\nWORK=${JSON.stringify(work)}\nOUT=${JSON.stringify(out)}\nBIN=0\n${encodeBlock()}\necho "BIN=$BIN" >&2\n`;
  const r = spawnSync("bash", ["-c", script], { encoding: "buffer" });
  assert.equal(r.status, 0, `the workflow block failed: ${r.stderr}`);
  assert.ok(existsSync(out), "the block wrote no pair object");
  return { doc: JSON.parse(readFileSync(out, "utf8")), stderr: String(r.stderr) };
}

test("the workflow keeps its extraction sentinels and its round-trip comparison", () => {
  // The CODE, not the commentary around it — the comment names `base64 -w0` in order to
  // say not to use it, and a scan that read comments would be answered by the warning.
  const block = encodeBlock().split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(block, /cmp -s "\$WORK\/value" "\$WORK\/back"/,
    "the value must be compared with what jq gives back, not assumed to survive");
  assert.match(block, /\{b64: /, "and the values that do not survive must ride as base64");
  assert.doesNotMatch(block, /base64 -w/, "base64 -w is GNU-only; the runner is not the only place this runs");
});

test("the workflow carries a PNG as base64 and it decodes byte for byte", { skip: !have("jq") && "jq is not installed" }, async () => {
  const key = "basset:" + (await sha256Hex(PNG)).slice(0, 40);
  const { doc, stderr } = runBlock(key, PNG);
  assert.ok(isBinaryKvValue(doc[key]), "a PNG cannot ride as a JSON string");
  assert.deepEqual(decodeKvValue(doc[key]), PNG);
  // The key is the checksum. This is the same assertion a restore makes before writing.
  assert.equal("basset:" + (await sha256Hex(decodeKvValue(doc[key]))).slice(0, 40), key);
  assert.match(stderr, /BIN=1/, "and it is counted, so the run says how many values were binary");
});

test("the workflow still carries text as a plain string", { skip: !have("jq") && "jq is not installed" }, () => {
  for (const s of ['[{"id":"t1"}]', "héllo wörld", "日本語 😀", "\uFEFF{}"]) {
    const { doc, stderr } = runBlock("c:/proto/", new TextEncoder().encode(s));
    assert.equal(doc["c:/proto/"], s, `${JSON.stringify(s)} is text and must stay text`);
    assert.match(stderr, /BIN=0/);
  }
});

test("the workflow's own copy in a shell repo is not what is tested here", () => {
  // Stated so nobody reads a green run as covering a deployed instance: this is the
  // TEMPLATE. A shell that took a copy of this file before the fix keeps its own broken
  // version until the file is re-copied — which is what health.yml's template-drift check
  // (e) is for.
  assert.ok(readFileSync(YML, "utf8").includes("A KV VALUE IS BYTES, NOT TEXT"));
});
