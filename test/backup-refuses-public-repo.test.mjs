// The backup workflows refuse to run on a public repository.
//
// THIS IS NOT HYPOTHETICAL. A public fork of this engine ran a workflow of this shape and
// published a full production KV export of a live instance — 58 keys, 26 internal comment
// threads, five real names and personal addresses — reachable with no authentication.
// GitHub shares git objects across a fork network, so the commit resolved through the
// PARENT repository's own raw URL: deleting the branch, deleting the fork and rewriting
// the parent's history all leave it fetchable, and only a support-side object purge closes
// it. Both workflow headers said "the shell repo must be private" throughout.
//
// So the guard is EXTRACTED FROM THE SHIPPED YAML AND EXECUTED here, rather than
// paraphrased: what is asserted is the lines that will actually run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = ["kv-backup.yml", "store-backup.yml"];
const STEP = "- name: Refuse to run on a public repository";

/** Pull the guard's `run:` script out of a workflow and dedent it. */
function guardScript(file) {
  const lines = fs.readFileSync(path.join(ROOT, "templates", "shell", file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === STEP);
  assert.notEqual(at, -1, `${file} has no "${STEP}" step`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run:\s*\|\s*$/.test(l));
  assert.notEqual(runAt, -1, `${file}'s guard has no run: block`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { body.push(""); continue; }
    if (!/^ {10}/.test(l)) break; // dedented out of the run: block
    body.push(l.slice(10));
  }
  assert.ok(body.length > 4, `${file}'s guard script looks empty`);
  return body.join("\n");
}

/**
 * Run the guard with a stubbed `gh` on PATH. `visibility` is what `gh api … --jq .private`
 * prints; "" stands for gh failing or being absent.
 */
function runGuard(script, { visibility, ctxPrivate = "" }) {
  const bin = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "guard-bin-"));
  try {
    fs.writeFileSync(path.join(bin, "gh"), visibility === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nprintf '%s\\n' '${visibility}'\n`);
    fs.chmodSync(path.join(bin, "gh"), 0o755);
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "someone/augur-deploy-example",
        GH_TOKEN: "x",
        CTX_PRIVATE: ctxPrivate,
      },
    });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
}

for (const file of WORKFLOWS) {
  test(`${file}: the guard is the FIRST step, before any checkout`, () => {
    const lines = fs.readFileSync(path.join(ROOT, "templates", "shell", file), "utf8").split("\n");
    const steps = lines.map((l, i) => [l, i]).filter(([l]) => /^      - (name|uses):/.test(l));
    assert.ok(steps.length, `${file} has no steps`);
    assert.equal(steps[0][0].trim(), STEP,
      `${file}'s first step is "${steps[0][0].trim()}". The guard must run before anything fetches or exports, so a refusal costs nothing and leaks nothing.`);
  });

  test(`${file}: a PUBLIC repository is refused, and the message says why`, () => {
    const r = runGuard(guardScript(file), { visibility: "false" });
    assert.equal(r.code, 1, `the guard allowed a public repository:\n${r.out}`);
    assert.match(r.out, /PUBLIC/);
    assert.match(r.out, /fork network|fetchable/i, "the message does not explain that deleting it does not close it");
  });

  test(`${file}: a private repository proceeds`, () => {
    const r = runGuard(guardScript(file), { visibility: "true" });
    assert.equal(r.code, 0, `the guard refused a private repository — this would silently stop every backup:\n${r.out}`);
  });

  test(`${file}: it FAILS when it cannot tell, rather than assuming private`, () => {
    // The direction a guard is allowed to be wrong in. An absent answer is an unanswered
    // question, and this is the one question that must not have a default.
    for (const [label, opts] of [
      ["gh is unavailable and the context is empty", { visibility: null, ctxPrivate: "" }],
      ["gh prints something unexpected", { visibility: "maybe", ctxPrivate: "" }],
    ]) {
      const r = runGuard(guardScript(file), opts);
      assert.equal(r.code, 1, `${label}: the guard proceeded anyway:\n${r.out}`);
      assert.match(r.out, /could not determine|REFUSING/i);
    }
  });

  test(`${file}: it falls back to the event context when gh is unavailable`, () => {
    // Scheduled runs carry github.event.repository.private; some event types do not.
    assert.equal(runGuard(guardScript(file), { visibility: null, ctxPrivate: "true" }).code, 0);
    assert.equal(runGuard(guardScript(file), { visibility: null, ctxPrivate: "false" }).code, 1);
  });
}

test("the guard REFUSES, it never skips", () => {
  // A skip is worse than having no backup workflow at all: the operator goes on believing
  // a backup exists. If anyone ever "softens" this to a conditional skip, this fails.
  for (const file of WORKFLOWS) {
    const src = fs.readFileSync(path.join(ROOT, "templates", "shell", file), "utf8");
    const at = src.indexOf(STEP);
    const step = src.slice(at, at + 2000);
    assert.ok(/exit 1/.test(step), `${file}'s guard does not exit non-zero`);
    assert.ok(!/^\s*if:\s/m.test(step.split("run: |")[0]),
      `${file}'s guard carries a step-level \`if:\`, which would let it be skipped rather than refuse`);
  }
});
