// Drill K — the editor hooks against the live instance.
//   post-hook: an edit inside a draft folder is live at the draft address before the hook
//   returns. pre-hook: a write into a prototype of a shared checkout is refused with the
//   `open` hint; a write into a read-only copy is refused too.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UNITS, RUN, workDir } from "../env.mjs";
import { cliEnv, cli, draftDir } from "../persona.mjs";
import { assert, served, resetUnit } from "./lib.mjs";
import { readState } from "../../../scripts/lib/draft.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = path.join(ROOT, "scripts", "hook.mjs");
const U = UNITS()[8];
const bare = U.replace(/^\/|\/$/g, "");

function hook(event, env, payload) {
  const r = spawnSync(process.execPath, [HOOK, event], { env, input: JSON.stringify(payload), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("K1: an edit in a draft folder is live before the post-hook returns", async () => {
  const dir = draftDir("editor", "K");
  const env = await cliEnv("editor", "k-session");
  const o = await cli("editor", "k-session", ["open", bare, "--dir", dir]);
  assert.equal(o.code, 0, o.err);
  const st = readState(dir);
  const file = path.join(dir, "index.html");
  const stampText = `<!-- ${RUN} K hook -->`;
  fs.appendFileSync(file, "\n" + stampText);
  const pre = hook("pre", env, { tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "k" });
  assert.equal(pre.code, 0, `pre-hook allows a write inside the draft: ${pre.err}`);
  const t0 = Date.now();
  const post = hook("post", env, { tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "k" });
  const ms = Date.now() - t0;
  assert.equal(post.code, 0, `post-hook saved: ${post.err}`);
  const s = await served(`${new URL(st.address, "https://x").pathname}index.html`);
  assert.ok(s.text.includes(stampText), `the draft address serves the edit the moment the hook returns (${ms} ms)`);
  console.log(`K1: post-hook returned in ${ms} ms and the draft address already served the edit`);
  await cli("editor", "k-session", ["close", "--discard"], { cwd: dir });
  await resetUnit(U);
});

test("K2: a write into a shared checkout's prototype is refused with the open hint", async () => {
  const env = await cliEnv("editor", "k2");
  const checkout = workDir("fake-checkout");
  fs.writeFileSync(path.join(checkout, "space.json"), JSON.stringify({ id: "fake" }));
  const proto = path.join(checkout, "some-opportunity", "prototypes", "some-proto");
  fs.mkdirSync(proto, { recursive: true });
  const file = path.join(proto, "index.html");
  const pre = hook("pre", env, { tool_name: "Write", tool_input: { file_path: file }, cwd: checkout, session_id: "k2" });
  assert.notEqual(pre.code, 0, "the write is refused");
  assert.match(pre.err + pre.out, /augur open some-opportunity\/some-proto|open/, `the refusal says what to run: ${pre.err}${pre.out}`);
  // Outside a unit home, the same checkout is not policed.
  const doc = path.join(checkout, "research.md");
  const ok = hook("pre", env, { tool_name: "Write", tool_input: { file_path: doc }, cwd: checkout, session_id: "k2" });
  assert.equal(ok.code, 0, "a file outside any prototype folder is not the hook's business");
});

test("K3: a read-only copy refuses writes and names the draft to open instead", async () => {
  const env = await cliEnv("editor", "k3");
  const cwd = workDir(`k3-${Date.now().toString(36)}`);
  const r = await cli("editor", "k3", ["read", bare], { cwd });
  assert.equal(r.code, 0, `read: ${r.err}`);
  const copy = path.join(cwd, "_read", ...U.split("/").filter(Boolean));
  assert.ok(fs.existsSync(path.join(copy, "index.html")), "the copy exists under _read/");
  const pre = hook("pre", env, { tool_name: "Edit", tool_input: { file_path: path.join(copy, "index.html") }, cwd, session_id: "k3" });
  assert.notEqual(pre.code, 0, "a write into the copy is refused");
  assert.match(pre.err + pre.out, /read-only/, pre.err + pre.out);
  const mode = fs.statSync(path.join(copy, "index.html")).mode & 0o222;
  assert.equal(mode, 0, "the copy's files carry no write bit");
  await cli("editor", "k3", ["close"], { cwd: copy });
});
