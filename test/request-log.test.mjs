// One structured log line per request, and the field it exists for is `tenant`.
//
// `D-8-tenant-log-tag`. This worker had no logging at all. Once one deployment serves
// several workspaces, an error rate or a burst of 404s means nothing until you can say
// WHOSE it was — a log you have to correlate by hand at 3am is a log nobody reads.
//
// The two properties that are not about convenience: the line must never carry a secret,
// and the logger must never be able to fail the request it is describing.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";

// A minimal env: just enough for a request to reach the end of the router and come back
// as the login page or a 404, without a KV or R2 binding.
const ENV = () => ({ ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } });

/** Drive the real default export and collect whatever it logged. */
async function drive(url, { env = ENV(), method = "GET" } = {}) {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    const res = await worker.fetch(new Request(url, { method }), env, {});
    return { res, lines };
  } finally { console.log = orig; }
}

test("every request emits exactly one JSON line with the documented fields", async () => {
  const { res, lines } = await drive("https://x.example/nope");
  assert.equal(lines.length, 1, `expected one log line, got ${lines.length}`);
  const l = JSON.parse(lines[0]);
  for (const f of ["tenant", "status", "method", "path", "ms"]) {
    assert.ok(f in l, `the log line has no ${f}: ${lines[0]}`);
  }
  assert.equal(l.status, res.status);
  assert.equal(l.method, "GET");
  assert.equal(l.path, "/nope");
  assert.equal(typeof l.ms, "number");
});

test("the line names the workspace the request resolved to", async () => {
  const { lines } = await drive("https://x.example/nope");
  const l = JSON.parse(lines[0]);
  assert.ok(l.tenant && l.tenant !== "-", `no tenant on a resolved request: ${lines[0]}`);
});

test("a refusal that PREDATES the resolve says so rather than inventing a workspace", async () => {
  // /__config is answered before resolveTenant runs, on purpose: it is the same answer
  // for every workspace and must not reach for one. The log has to be honest about that
  // instead of filling in a default, which would attribute the request to a workspace
  // that had nothing to do with it.
  const { lines } = await drive("https://x.example/__config/instance.json");
  assert.equal(JSON.parse(lines[0]).tenant, "-");
});

test("THE QUERY STRING IS NEVER LOGGED", async () => {
  // Publish and review paths carry bearer tokens and export secrets in the query string.
  // A log is a place secrets go to be kept, and this one is read by whoever runs the
  // instance and by whatever ships its logs onward.
  const { lines } = await drive("https://x.example/__review/api/export?key=SUPERSECRETVALUE");
  assert.ok(!lines[0].includes("SUPERSECRETVALUE"), `the log line carries the query string: ${lines[0]}`);
  assert.equal(JSON.parse(lines[0]).path, "/__review/api/export");
});

test("a cookie is never logged either", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    await worker.fetch(new Request("https://x.example/nope", {
      headers: { cookie: "__Host-augur_user=SESSIONTOKENVALUE" },
    }), ENV(), {});
  } finally { console.log = orig; }
  assert.ok(!lines.join("\n").includes("SESSIONTOKENVALUE"));
});

test("a very long path cannot dominate the line", async () => {
  const { lines } = await drive(`https://x.example/${"a".repeat(4000)}`);
  assert.ok(JSON.parse(lines[0]).path.length <= 200, "the path is not capped");
});

test("a throwing route is logged as an error AND still throws", async () => {
  // The VERIFY for this item is "force an error for tenant X; the log names tenant X".
  // Errors are the case the whole thing is for, so they must not be the case it drops —
  // and swallowing the throw would turn a 500 into a silent wrong answer.
  // A binding whose ACCESS throws. ASSETS is not the one to use: assetFetch catches its
  // failures, which is correct behaviour and means an exploding ASSETS would make this
  // test pass while proving nothing. COMMENTS is read on the gate path and is not caught.
  const explode = new Proxy(
    { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } },
    { get(t, p) { if (p === "COMMENTS") throw new Error("KV exploded"); return t[p]; } },
  );
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  let threw = false;
  try { await worker.fetch(new Request("https://x.example/nope"), explode, {}); }
  catch { threw = true; }
  finally { console.log = orig; }
  assert.equal(threw, true, "the exploding binding did not produce a throw, so this test proved nothing");
  const err = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((l) => l && l.level === "error");
  assert.ok(err, `an error was thrown but no error line was logged: ${lines.join(" | ")}`);
  assert.equal(err.status, 500);
  assert.match(err.error, /KV exploded/);
});

test("a logger that throws cannot break the response", async () => {
  // A logger able to fail the request it describes is a worse availability risk than
  // having no logs. The whole line sits inside a try/catch that discards its own errors.
  const orig = console.log;
  console.log = () => { throw new Error("log sink is down"); };
  try {
    const res = await worker.fetch(new Request("https://x.example/nope"), ENV(), {});
    assert.ok(res.status >= 200, "the response did not survive a failing logger");
  } finally { console.log = orig; }
});
