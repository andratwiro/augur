// What happens to a publish token when a workspace moves.
//
// `MIG-token-remint`. The item's premise was that every token stops resolving the moment a
// workspace's state lands in its Durable Object, because the lookup path changes.
//
// ⚠️ THAT IS NO LONGER TRUE, and the correction matters more than the item. `publish:tokens`
// is a workspace-destined family, so `augur export --full` carries it and
// `augur restore --state` replays it — a migration moves the token map with everything else.
// A token that worked before the move works after it, which is the no-lock-in property
// doing its job rather than an oversight.
//
// SO THE REAL FAILURE IS THE HOSTNAME, not the store. `~/.config/augur/tokens.json` is keyed
// by origin host: a workspace that moved to a new hostname leaves a file full of entries for
// the old one, and "no publish token" on its own reads as "you never logged in" — which
// sends somebody looking for a problem they solved months ago. That is what this pins.
//
// And the other half of the VERIFY: no publish failure may ever end with somebody handing
// over a `file://` path. Every refusal carries the sanctioned meanwhile, and it says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { __testables as W } from "../src/_worker.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISH = path.join(ROOT, "scripts", "publish.mjs");

const run = (argv, env) => new Promise((resolve) => {
  execFile(process.execPath, [PUBLISH, ...argv], { cwd: ROOT, env: { ...process.env, ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
});

/** An instance that answers the publish preflight however the test wants. */
async function refusing(body, status = 403) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// ── the correction: a token SURVIVES a migration ─────────────────────────────

test("A MIGRATION CARRIES THE TOKEN MAP, so a token that worked still works", async () => {
  // The item assumed the opposite. `publish:tokens` is workspace-destined, so the export
  // takes it and the restore replays it — and a CLI whose workspace moved to the same
  // hostname keeps publishing without anybody re-authenticating.
  const memKv = (initial = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      store,
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async getWithMetadata(k) { return { value: store.get(k) ?? null, metadata: null }; },
      async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async list({ prefix = "" } = {}) {
        return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
      },
    };
  };
  const memR2 = () => ({
    async head() { return null; }, async get() { return null; }, async put() {}, async delete() {},
    async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
  });
  const hash = await W.tokenFor("pub:carried");
  const ctx = Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: "acme" });

  const from = { COMMENTS: memKv({ "publish:tokens": JSON.stringify({ [hash]: { space: "*", label: "ci" } }) }), BUNDLES: memR2() };
  const doc = await W.exportState(ctx, from);
  assert.ok(doc.families["publish:tokens"], "the token map was not exported");

  const to = { COMMENTS: memKv(), BUNDLES: memR2() };
  await W.importState(ctx, to, doc);
  assert.deepEqual(JSON.parse(to.COMMENTS.store.get("publish:tokens")), { [hash]: { space: "*", label: "ci" } });
});

// ── the real failure: the hostname moved ─────────────────────────────────────

test("NO TOKEN FOR THIS HOST NAMES THE HOSTS YOU DO HAVE", async () => {
  // The commonest way to arrive here is a move, and the generic message reads as "you
  // never logged in".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  fs.mkdirSync(path.join(dir, ".config", "augur"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".config", "augur", "tokens.json"),
    JSON.stringify({ "old.example": { token: "t", space: "*" } }));
  try {
    const r = await run(["--engine", "--dry-run"], {
      HOME: dir, AUGUR_ORIGIN: "https://new.example", AUGUR_TOKEN: "",
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no publish token for new\.example/);
    assert.match(r.out, /You have one for old\.example/);
    assert.match(r.out, /if this workspace moved, that is why/);
    assert.match(r.out, /augur login --origin https:\/\/new\.example/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("with no tokens at all it says what a first-time person needs, not what a mover does", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  try {
    const r = await run(["--engine", "--dry-run"], {
      HOME: dir, AUGUR_ORIGIN: "https://new.example", AUGUR_TOKEN: "",
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Run `augur login` once/);
    assert.ok(!/if this workspace moved/.test(r.out), "a first-time person was told about a move");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the refusals a stale credential produces ─────────────────────────────────

test("AN EXPIRED TOKEN SAYS SO, and names the one command that fixes it", async () => {
  const inst = await refusing({ error: "token-expired", message: "This publish token has expired. Run `augur login` again." });
  try {
    const r = await run(["--engine", "--dry-run"], { AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "stale" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /EXPIRED/);
    assert.match(r.out, /augur login/);
    assert.ok(!/\b403\b/.test(r.out), "the raw status was printed instead of the fix");
  } finally { inst.server.close(); }
});

test("a token whose account is gone says THAT, rather than a status code", async () => {
  const inst = await refusing({ error: "forbidden", message: "This token's account is no longer a member of this workspace." });
  try {
    const r = await run(["--engine", "--dry-run"], { AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "stale" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no longer a member of this workspace/);
  } finally { inst.server.close(); }
});

test("an instance too old to explain itself still gets the old, useful message", async () => {
  const inst = await refusing({ error: "forbidden" });
  try {
    const r = await run(["--engine", "--dry-run"], { AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "stale" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /publish token rejected/);
    assert.match(r.out, /augur login/);
  } finally { inst.server.close(); }
});

// ── and never a file:// hand-off ─────────────────────────────────────────────

test("EVERY PUBLISH FAILURE CARRIES THE SANCTIONED MEANWHILE, and it forbids file://", async () => {
  // The other half of the VERIFY. A publish that cannot happen must not end with somebody
  // opening the built HTML off disk and sending the path to a colleague: that page has no
  // chrome, no login and no canvas, and the link works on exactly one machine.
  const inst = await refusing({ error: "token-expired", message: "expired" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-home-"));
  try {
    const cases = [
      [["--engine", "--dry-run"], { AUGUR_ORIGIN: inst.origin, AUGUR_TOKEN: "stale" }],
      [["--engine", "--dry-run"], { HOME: dir, AUGUR_ORIGIN: "https://new.example", AUGUR_TOKEN: "" }],
      [["--engine", "--dry-run"], { AUGUR_ORIGIN: "http://127.0.0.1:1/", AUGUR_TOKEN: "x" }],
    ];
    for (const [argv, env] of cases) {
      const r = await run(argv, env);
      assert.equal(r.code, 1, `expected a refusal:\n${r.out}`);
      assert.match(r.out, /Never hand over a file:\/\/ path/, `no meanwhile on:\n${r.out}`);
      assert.match(r.out, /dev\.mjs/);
    }
  } finally {
    inst.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the meanwhile is one string, so a new failure cannot invent its own advice", () => {
  // A second copy would drift, and the copy that drifts is the one that stops saying
  // "never hand over a file:// path".
  const src = fs.readFileSync(PUBLISH, "utf8");
  const occurrences = src.split("Never hand over a file:// path").length - 1;
  assert.equal(occurrences, 1, "the meanwhile text appears more than once — it should be one constant");
  assert.ok(src.split("${MEANWHILE}").length - 1 >= 5, "some refusals do not carry the meanwhile");
});
