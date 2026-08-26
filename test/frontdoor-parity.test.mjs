// The probe that asks a running deployment whether a gated path is gated.
//
// Driven against two in-process stub servers, so the matrix is exercised with no network
// and no account. The decisive test is "a leaking front door is CAUGHT": a server that
// serves dist/ as static files — which is precisely what a Workers deploy missing
// `run_worker_first = true` does — must make this probe exit non-zero, naming the roster.
//
// A probe nobody has watched fail is a probe nobody knows the shape of, and this one's
// whole job is to fail on a deployment that every other check calls healthy.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/frontdoor-parity.mjs", import.meta.url));

const GATE_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>'
  + '<body><form><input type="password" name="p"></form></body></html>';
const BUILD_JSON = JSON.stringify({ builtAt: "2026-01-01T00:00:00.000Z", engine: { sha: "abc123def456" }, spaces: {} });
const SW_JS = "/* Augur service worker */\nself.addEventListener('install', () => {});\n";

/** The real files that live in dist/ and must never come back as themselves. */
const REAL = {
  "/__config/instance.json": ['{"users":[{"email":"a@b.c","pass":"seed"}],"tenantId":"x"}', "application/json"],
  "/__config/routing.json": ['{"publicPrefixes":["/x/"]}', "application/json"],
  "/__manifests/_engine.json": ['{"id":"_engine","files":{"/sw.js":{}}}', "application/json"],
  "/_worker.js": ["export default { fetch() {} };\n", "application/javascript"],
  "/tenant-context.mjs": ["export const FIELDS = [];\n", "application/javascript"],
  "/tenant-cache.mjs": ["export function tenantCache() {}\n", "application/javascript"],
  "/kv-codec.mjs": ["export const KV_BACKUP_FORMAT = 1;\n", "application/javascript"],
  "/mail.mjs": ["export function sendMail() {}\n", "application/javascript"],
  "/chrome/appchrome.mjs": ["export function renderAppChrome() {}\n", "application/javascript"],
  "/.assetsignore": ["_worker.js\n*.mjs\n", "text/plain"],
};

/**
 * `mode: "worker"` — the platform ran the gate first, so anything not public is the gate.
 * `mode: "assets"` — the platform served the matching file first. This is the failure.
 */
function server(mode) {
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    const send = (code, body, ct) => { res.writeHead(code, { "content-type": ct }); res.end(req.method === "HEAD" ? "" : body); };
    if (p === "/_build.json") return send(200, BUILD_JSON, "application/json");
    if (p === "/sw.js") return send(200, SW_JS, "application/javascript");
    if (mode === "assets" && REAL[p]) return send(200, REAL[p][0], REAL[p][1]);
    if (p.startsWith("/__config/")) return send(404, "Not found", "text/plain");
    return send(200, GATE_HTML, "text/html"); // gate, root, and every unknown path
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, origin: `http://127.0.0.1:${srv.address().port}` })));
}

/**
 * ASYNC, and it has to be. `execFileSync` blocks the calling process's event loop, so a
 * stub server living in THIS process can never answer the child probing it — the two
 * deadlock and the test hangs until the runner kills it. The first draft did exactly that.
 */
function run(...origins) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...origins], { encoding: "utf8", timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "") + (stderr || "") });
    });
  });
}

test("a front door where the worker decides every request PASSES", async () => {
  const { srv, origin } = await server("worker");
  try {
    const r = await run(origin);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /OK — every sealed path was decided by the worker/);
    // It must not pass by finding nothing: the alive checks have to have run.
    assert.match(r.out, /ok     alive \/_build\.json/);
  } finally { srv.close(); }
});

test("a front door serving dist/ as static files is CAUGHT, and the roster is named", async () => {
  // This is the deploy that all 837 tests, both deploy gates and the health canary call
  // healthy. If this test ever goes green-by-passing, the probe has stopped working.
  const { srv, origin } = await server("assets");
  try {
    const r = await run(origin);
    assert.equal(r.ok, false, `the probe PASSED a leaking front door:\n${r.out}`);
    assert.match(r.out, /FAIL   sealed \/__config\/instance\.json/);
    assert.match(r.out, /roster/);
    assert.match(r.out, /seed passwords/);
    // Every module is a separate finding, so the count is a measure of the blast radius.
    for (const p of ["/_worker.js", "/tenant-context.mjs", "/mail.mjs", "/chrome/appchrome.mjs"]) {
      assert.ok(r.out.includes(`FAIL   sealed ${p}`), `${p} leaked but was not reported:\n${r.out}`);
    }
  } finally { srv.close(); }
});

test("a deployment that is sealed but DEAD fails too", async () => {
  // Everything 404s: no roster leaks, and no site either. A matrix of "must not be X"
  // passes that trivially, which is why the alive checks exist.
  const srv = http.createServer((_, res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end("gone"); });
  await new Promise((r) => srv.listen(0, r));
  try {
    const r = await run(`http://127.0.0.1:${srv.address().port}`);
    assert.equal(r.ok, false, `the probe passed a dead site:\n${r.out}`);
    assert.match(r.out, /FAIL   alive \/_build\.json/);
  } finally { srv.close(); }
});

test("an unknown path answered with the root page is caught as SPA fallback", async () => {
  // not_found_handling = "single-page-application". Only detectable when the root is not
  // itself the gate, which is why the probe SKIPS this on a gated instance rather than
  // counting it as a pass.
  const LANDING = '<!doctype html><html><body><h1>Projects</h1></body></html>';
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/_build.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(BUILD_JSON); }
    if (p === "/sw.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(SW_JS); }
    if (p.startsWith("/__config/")) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": "text/html" }); res.end(LANDING); // every path is the index
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const r = await run(`http://127.0.0.1:${srv.address().port}`);
    assert.equal(r.ok, false, `SPA fallback was not caught:\n${r.out}`);
    assert.match(r.out, /FAIL   not-found/);
    assert.match(r.out, /single-page-application/);
  } finally { srv.close(); }
});

test("two identical front doors reach parity; two different ones do not", async () => {
  const a = await server("worker");
  const b = await server("worker");
  try {
    const same = await run(a.origin, b.origin);
    assert.equal(same.ok, true, same.out);
    assert.match(same.out, /ok     \/sw\.js  200 identical/);
  } finally { a.srv.close(); b.srv.close(); }

  const c = await server("worker");
  const d = await server("assets");
  try {
    const differ = await run(c.origin, d.origin);
    assert.equal(differ.ok, false, `parity passed between a gated and a leaking door:\n${differ.out}`);
  } finally { c.srv.close(); d.srv.close(); }
});

test("the edge's per-response email obfuscation is normalised, not compared", async () => {
  // Cloudflare rewrites any address in HTML into data-cfemail="…" with a fresh key each
  // response. Left alone it made two fetches of ONE origin differ on every HTML path,
  // which would have made this whole check noise on its first real use.
  let n = 0;
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/_build.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(BUILD_JSON); }
    if (p === "/sw.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(SW_JS); }
    if (p.startsWith("/__config/")) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(GATE_HTML.replace("</body>", `<a class="__cf_email__" data-cfemail="${(n++).toString(16).padStart(8, "0")}">x</a></body>`));
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const r = await run(origin, origin);
    assert.equal(r.ok, true, `a rotating cfemail key broke parity:\n${r.out}`);
  } finally { srv.close(); }
});
