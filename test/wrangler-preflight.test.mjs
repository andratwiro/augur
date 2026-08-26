// The preflight refuses a worker config that would open the site.
//
// THE ONE THAT MATTERS is the first test below. Pages runs the worker first and lets it
// decide what is public; Workers serves a matching static asset first and only invokes
// the worker on a miss. The asset directory is `dist`, and `dist/__config/instance.json`
// carries the instance's user roster INCLUDING SEED PASSWORDS — build.js writes
// `users: IDENTITY` unstripped and says so in a comment beside the write.
//
// So one missing line publishes the roster and the admin panel, while every test in this
// repo stays green and the shell's health check still answers "healthy" (it curls
// /_build.json, which a bare static host serves correctly with no worker running at all).
// Nothing else here can tell those two deploys apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/wrangler-preflight.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = path.join(ENGINE, "templates", "shell", "wrangler.example.toml");
const FIXTURE = path.join(ENGINE, "test", "fixtures", "wrangler.filled.toml");

const GOOD = `
name = "probe"
main = "engine/src/entry.js"
compatibility_date = "2026-07-01"
[assets]
directory = "engine/dist"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "none"
[[kv_namespaces]]
binding = "COMMENTS"
id = "beef"
[[r2_buckets]]
binding = "BUNDLES"
bucket_name = "b"
`;

/** Run the preflight over a scratch shell that mimics a real one: shell/ + shell/engine/. */
function check(toml, { withRoster = true, withAssetsIgnore = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const dist = path.join(dir, "engine", "dist");
    fs.mkdirSync(path.join(dist, "__config"), { recursive: true });
    fs.mkdirSync(path.join(dir, "engine", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "engine", "src", "entry.js"), "export default {};\n");
    fs.writeFileSync(path.join(dist, "_worker.js"), "// worker\n");
    if (withAssetsIgnore) fs.writeFileSync(path.join(dist, ".assetsignore"), "_worker.js\n");
    if (withRoster) fs.writeFileSync(path.join(dist, "__config", "instance.json"), '{"users":[{"email":"a@b.c","pass":"hunter2"}]}');
    const cfg = path.join(dir, "wrangler.toml");
    fs.writeFileSync(cfg, toml);
    try { return { ok: true, out: execFileSync(process.execPath, [SCRIPT, "-c", cfg], { encoding: "utf8" }) }; }
    catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || "") }; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const rejects = (toml, opts) => { const r = check(toml, opts); assert.equal(r.ok, false, `expected a finding:\n${r.out}`); return r.out; };
const accepts = (toml, opts) => { const r = check(toml, opts); assert.equal(r.ok, true, `expected NO finding:\n${r.out}`); };

// ── the gate ─────────────────────────────────────────────────────────────────

test("a config without run_worker_first is REFUSED, and the message says what leaks", () => {
  const out = rejects(GOOD.replace("run_worker_first = true\n", ""));
  assert.match(out, /run-worker-first/);
  assert.match(out, /instance\.json/);
  assert.match(out, /SEED PASSWORDS/i);
});

test("run_worker_first = false is refused as loudly as omitting it", () => {
  assert.match(rejects(GOOD.replace("run_worker_first = true", "run_worker_first = false")), /run-worker-first/);
});

test("the good config passes", () => { accepts(GOOD); });

// ── the other ways a config opens or breaks the site ─────────────────────────

test("single-page-application not-found handling is refused", () => {
  assert.match(rejects(GOOD.replace('not_found_handling = "none"', 'not_found_handling = "single-page-application"')), /not-found-handling/);
});

test("a missing binding the worker cannot start without is refused", () => {
  assert.match(rejects(GOOD.replace(/\[\[kv_namespaces\]\]\nbinding = "COMMENTS"\nid = "beef"\n/, "")), /binding-comments/);
  assert.match(rejects(GOOD.replace(/\[\[r2_buckets\]\]\nbinding = "BUNDLES"\nbucket_name = "b"\n/, "")), /binding-bundles/);
});

test("main pointing anywhere but the deploy entry is refused", () => {
  // Pointing main at _worker.js would still deploy — and would silently un-scan the
  // module graph, since scripts/no-tenant-globals.mjs walks from src/entry.js.
  assert.match(rejects(GOOD.replace("engine/src/entry.js", "engine/src/_worker.js")), /main/);
});

test("a plaintext credential under [vars] is refused", () => {
  assert.match(rejects(GOOD + '\n[vars]\nSESSION_SECRET = "s3cret"\n'), /secret-in-vars/);
  assert.match(rejects(GOOD + '\n[vars]\nPUBLISH_BOOTSTRAP_TOKEN = "t"\n'), /bootstrap-token/);
  assert.match(rejects(GOOD + '\n[vars]\nGV_KV_TOKEN = "t"\n'), /kv-token/);
});

test("remote = true on a binding is refused", () => {
  assert.match(rejects(GOOD + "\nremote = true\n"), /remote-binding/);
});

test("a dist with no .assetsignore beside _worker.js is refused", () => {
  assert.match(rejects(GOOD, { withAssetsIgnore: false }), /assetsignore/);
});

test("a # inside a quoted value is not treated as a comment", () => {
  // An unquoted # starting a comment truncated a 24-character password to 6 elsewhere in
  // this project and produced a 401 that looked like a wrong credential. The preflight
  // strips WHOLE-LINE comments only, so a value carrying a # stays intact and a secret
  // hidden behind one is still caught.
  assert.match(rejects(GOOD + '\n[vars]\nMAIL_API_KEY = "abc#def"\n'), /secret-in-vars/);
});

// ── one workspace or many ────────────────────────────────────────────────────

test("TENANT_HOST_SUFFIX without a TENANTS binding is refused", () => {
  // The two halves live in different tables, so adding one and not the other is an easy
  // mistake — and each half alone fails somewhere nobody would connect back to this file.
  // With a suffix and no binding, every hostname resolves to a workspace with nowhere to
  // keep anything.
  const out = rejects(GOOD + '\n[vars]\nTENANT_HOST_SUFFIX = ".example.com"\n');
  assert.match(out, /tenants-binding/);
  assert.match(out, /Host header/);
});

test("with both halves it passes", () => {
  accepts(GOOD
    + '\n[[durable_objects.bindings]]\nname = "TENANTS"\nclass_name = "TenantStore"\n'
    + '\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["TenantStore"]\n'
    + '\n[vars]\nTENANT_HOST_SUFFIX = ".example.com"\n');
});

test("an EMPTY suffix is refused rather than quietly meaning single-workspace", () => {
  // It reads as multi-workspace to a person and as single-workspace to the resolver, and
  // the difference between those two readings is whether hostnames are identity.
  assert.match(rejects(GOOD + '\n[vars]\nTENANT_HOST_SUFFIX = ""\n'), /tenants-suffix-empty/);
});

test("a single-workspace config is not asked for any of this", () => {
  // Every self-hosted instance is this shape, and the new rule must be invisible to it.
  accepts(GOOD);
});

// ── the shipped template and fixture are themselves valid ────────────────────

test("the shell template declares the gate and every binding", () => {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  assert.match(tpl, /^\s*run_worker_first\s*=\s*true\s*$/m, "the template does not set run_worker_first");
  assert.match(tpl, /^\s*not_found_handling\s*=\s*"none"\s*$/m);
  assert.match(tpl, /binding\s*=\s*"ASSETS"/);
  assert.match(tpl, /binding\s*=\s*"COMMENTS"/);
  assert.match(tpl, /binding\s*=\s*"BUNDLES"/);
  assert.match(tpl, /main\s*=\s*"engine\/src\/entry\.js"/);
  // The template must never ship a real credential or a real id.
  assert.ok(!/SESSION_SECRET\s*=/.test(tpl.replace(/^\s*#.*$/gm, "")), "the template assigns SESSION_SECRET outside a comment");
  assert.match(tpl, /GV_ASSET_SOURCE\s*=\s*"r2"/, "the template does not put the instance in bundle mode");
});

test("THE SHIPPED TEMPLATE PASSES ITS OWN PREFLIGHT once its placeholders are filled", () => {
  // The recipe is: copy templates/shell/wrangler.example.toml, fill it in, run the
  // preflight. That path was never actually walked, and it FAILED — the template annotates
  // almost every line, and the reader kept the trailing comment as part of the value, so
  // `binding = "ASSETS"   # …` read as a binding that is not ASSETS. Two spurious findings
  // on a correct config, in the script that gates the deploy.
  //
  // Which is the worse kind of wrong: a guard that fires on the file it tells you to copy
  // is a guard the next person deletes.
  const filled = fs.readFileSync(TEMPLATE, "utf8")
    .replace(/^name = .*/m, 'name = "probe"')
    .replace(/^account_id = .*/m, 'account_id = "0123456789abcdef0123456789abcdef"')
    .replace(/^main = .*/m, 'main = "engine/src/entry.js"')
    .replace(/^directory = .*/m, 'directory = "engine/dist"')
    .replace(/^id = "<your-kv-namespace-id>"/m, 'id = "beef"')
    .replace(/^bucket_name = .*/m, 'bucket_name = "b"');
  accepts(filled);
});

test("a trailing comment is not part of the value, and a quoted # still is", () => {
  // The two halves pull opposite ways. Keep the quoted `#` — that lesson cost a
  // 24-character secret becoming a 6-character one — and drop the trailing comment, or
  // the template cannot pass.
  accepts(GOOD.replace('binding = "ASSETS"', 'binding = "ASSETS"   # the worker reads its config through this'));
  accepts(GOOD.replace("run_worker_first = true", "run_worker_first = true  # THE GATE"));
  assert.match(rejects(GOOD + '\n[vars]\nMAIL_API_KEY = "abc#def"  # a comment too\n'), /secret-in-vars/);
});

test("the committed fixture passes the preflight", () => {
  // It is what `wrangler deploy --dry-run` runs against in test/worker-bundles.test.mjs,
  // so a fixture that would not pass preflight would be proving the wrong thing.
  const out = execFileSync(process.execPath, [SCRIPT, "-c", FIXTURE], { encoding: "utf8" });
  assert.match(out, /OK/);
});
