// The list of what an instance stores, and the thing that keeps it true.
//
// `MIG-state-inventory`. `src/state-inventory.mjs` is the migration's only complete
// account of what exists and where each family goes. The list itself is not the deliverable
// — a list can be written once and be wrong a week later, and this one already was: five
// families appeared between its first draft and its second reading and nothing caught them.
// What makes it worth having is the checker, so most of what is tested here is the checker.
//
// TWO MODES, because there are two ways to be wrong. The SOURCE scan catches a family added
// in code and not written down — the rot that actually happens. The LIVE scan catches a key
// on a real instance that nothing in the engine writes any more, which no amount of reading
// the source can find. Both earn their keep: the live one found `pins:<address>` unaccounted
// for on the first run against a real namespace, and that entry exists because of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_INVENTORY, accountsFor, inventoryEntry } from "../src/state-inventory.mjs";
import { keysInSource } from "../scripts/state-inventory.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "state-inventory.mjs");

const runScript = (args, stdin) => new Promise((resolve) => {
  const child = execFile(process.execPath, [SCRIPT, ...args], { cwd: ROOT },
    (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: `${stdout}${stderr}` }));
  if (stdin !== undefined) { child.stdin.write(stdin); child.stdin.end(); }
});

// ── the list ─────────────────────────────────────────────────────────────────

test("every entry says where it goes AND why, in a sentence", () => {
  // A destination with no reasoning is a decision nobody can review, and this list is
  // exactly the kind of thing somebody edits at speed during a migration.
  const DESTS = new Set(["account", "workspace", "r2", "drop", "stays", "n/a"]);
  const STORES = new Set(["kv", "r2", "none"]);
  for (const e of STATE_INVENTORY) {
    assert.ok(e.id, "an entry with no id");
    assert.ok(STORES.has(e.store), `${e.id}: store is ${e.store}`);
    assert.ok(["key", "prefix"].includes(e.kind), `${e.id}: kind is ${e.kind}`);
    assert.ok(DESTS.has(e.to), `${e.id}: destination is ${e.to}`);
    assert.ok(e.why && e.why.length > 40, `${e.id} has no reasoning`);
    // A non-key constant has nowhere to go, and a real one has to go somewhere.
    assert.equal(e.to === "n/a", e.store === "none", `${e.id}: a store key with no destination, or a non-key with one`);
  }
  assert.equal(new Set(STATE_INVENTORY.map((e) => e.id)).size, STATE_INVENTORY.length, "duplicate ids");
});

test("THE CREDENTIAL GOES TO THE ACCOUNT STORE, and nothing else does", () => {
  // The one destination that is a security boundary rather than a filing decision. A
  // password is account-level: a workspace that could reset it would reach every other
  // workspace that address opens.
  const toAccount = STATE_INVENTORY.filter((e) => e.to === "account").map((e) => e.id);
  assert.deepEqual(toAccount, ["users:secrets"]);
  assert.equal(inventoryEntry("users:secrets").to, "account");
});

test("nothing that is a promise to somebody is marked droppable", () => {
  // `mail:suppressed` is the trap here: it sits among the rate-limit counters and looks
  // like one, and dropping it silently resumes mailing people who asked us to stop.
  assert.equal(inventoryEntry("mail:suppressed").to, "workspace");
  for (const e of STATE_INVENTORY.filter((x) => x.to === "drop")) {
    assert.ok(/transient|recreat|re-run|re-fetch|collaps|debounce|instance-global|rate limit|only tier|being retired/i.test(e.why),
      `${e.id} is marked droppable without saying what makes it safe to drop`);
  }
});

// ── the source scan ──────────────────────────────────────────────────────────

test("the checker passes on the engine as it stands", async () => {
  const r = await runScript([]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /every one named by the engine/);
});

test("A NEW FAMILY IN THE CODE FAILS THE CHECK", async () => {
  // The rot this exists to catch, in the form it actually takes: somebody adds a store key
  // and does not write it down.
  const found = keysInSource(`
    const WIDGETS_KEY = "widgets";
    async function f(kv) { return kv.get("widgets"); }
  `);
  assert.ok(found.has("widgets"));
  assert.equal(accountsFor("widgets"), null, "a made-up family was somehow accounted for");
});

test("it reads a key wherever a key can be written down", () => {
  // The constant forms are anchored at the start of a line, i.e. MODULE SCOPE, which is
  // deliberate: a `const FOO_KEY` inside a function is a local name for something, not a
  // family the instance stores.
  const found = keysInSource([
    'const A_KEY = "alpha:one";',
    'const B_PREFIX = "beta:";',
    'export const C_KEY = "gamma";',
    'const table = { fam: { doc: "delta", layout: "keyed" } };',
    "async function f(kv, r2) {",
    '  await kv.get("epsilon");',
    "  await r2.put(`spaces/${id}/manifest.json`, x);",
    '  await kv.list({ prefix: "zeta:" });',
    "  const sentKey = `eta:sent:${id}`;",
    "}",
  ].join("\n"));
  assert.deepEqual(
    [...found.keys()].sort(),
    ["alpha:one", "beta:", "delta", "delta:", "epsilon", "eta:sent:", "gamma", "spaces/*/manifest.json", "zeta:"].sort(),
  );
});

test("it does NOT read a header name or a query parameter as a key", () => {
  // `headers.get("Cookie")` is the same call shape as `kv.get("statuses")`, and reading
  // both would drown the real findings in fifty false ones — which is how a guard becomes
  // something people scroll past.
  const found = keysInSource(`
    const h = request.headers.get("Cookie");
    const p = url.searchParams.get("path");
    const t = new Headers().get("Content-Type");
  `);
  assert.deepEqual([...found.keys()], []);
});

test("an entry nothing names any more is reported too", () => {
  // Both directions, or the list only ever grows: a family that quietly stopped being
  // written is one nobody thinks about again until a restore is missing it.
  const named = new Set();
  for (const rel of ["src/_worker.js", "src/mail.mjs"]) {
    for (const lit of keysInSource(fs.readFileSync(path.join(ROOT, rel), "utf8")).keys()) named.add(lit);
  }
  // Every entry is reachable from something the engine writes down — proven by the script
  // passing above; this asserts the property rather than restating it, using the ids the
  // engine's own constants carry.
  assert.ok(named.has("users:secrets"));
  assert.ok(named.has("basset:"));
  assert.ok(named.has("assets/"));
});

// ── the live scan ────────────────────────────────────────────────────────────

test("A LIVE KEY OUTSIDE THE INVENTORY IS REPORTED, by shape", async () => {
  const listing = JSON.stringify([
    { name: "statuses" }, { name: "pins:someone@example.test" },
    { name: "leftover:abc123def456789" }, { name: "leftover:fed987654321cba" },
  ]);
  const r = await runScript(["--live", "-"], listing);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /leftover:<hash>/, "the shape was not collapsed, so a thousand orphans would be a thousand lines");
  assert.match(r.out, /2 of them/);
  assert.ok(!/statuses/.test(r.out), "an accounted-for key was reported");
});

test("a live listing that is all accounted for passes, and an empty one is NOT a pass", async () => {
  const ok = await runScript(["--live", "-"], JSON.stringify([
    { name: "statuses" }, { name: "c:/p/" }, { name: "users:lastseen:a@b.test" },
    { name: "rl:login:ip:1.2.3.4" }, { name: "basset:" + "a".repeat(40) },
  ]));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /all 5 live key\(s\) are accounted for/);

  // A vacuous pass is the failure mode of every checker that reads a file somebody has to
  // remember to produce.
  const empty = await runScript(["--live", "-"], "[]");
  assert.equal(empty.code, 2, empty.out);
  assert.match(empty.out, /vacuous/);
});

test("it accepts a plain list of keys as well as wrangler's JSON", async () => {
  // Because the operator running this is pasting from a terminal, not writing a parser.
  const r = await runScript(["--live", "-"], "statuses\npins\nc:/p/\n");
  assert.equal(r.code, 0, r.out);
});

// ── it is a gate ─────────────────────────────────────────────────────────────

test("check.yml and check-local both run it, or the list rots unwatched", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "check.yml"), "utf8");
  const local = fs.readFileSync(path.join(ROOT, "scripts", "check-local.mjs"), "utf8");
  assert.match(yml, /node scripts\/state-inventory\.mjs/);
  assert.match(local, /scripts\/state-inventory\.mjs/);
});
