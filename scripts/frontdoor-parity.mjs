#!/usr/bin/env node
/**
 * frontdoor-parity — ask a RUNNING deployment whether a gated path is gated.
 *
 * WHY. Nothing in this engine or any shell checks that. The shells' health canary curls
 * /_build.json, which is a static file: a bare host with no worker running at all answers
 * it correctly and reports "healthy". Every test in the suite drives the worker in
 * process, so none of them can observe how the platform in front of it routes.
 *
 * That gap is survivable on Pages, where the worker runs first for every request by
 * construction. It stops being survivable the moment an instance moves to a plain Worker,
 * because there the platform serves a matching static asset FIRST unless
 * `run_worker_first = true` — and the asset directory holds __config/instance.json, which
 * carries the roster including seed passwords.
 *
 * THE DISCRIMINATOR, and it is the whole idea: ask for a file that EXISTS in the asset
 * directory and is not meant to be public, then check the response is not that file. On a
 * healthy instance /tenant-context.mjs answers with the gate's HTML, because the worker
 * ran and decided. On a broken one it answers with `export const …`, because the platform
 * served the file before the worker was ever invoked. Status codes cannot tell those
 * apart — both are 200.
 *
 * WHAT IT CANNOT DO. It is a black-box prober: it can only see what a stranger sees. It
 * says which checks it could not discriminate rather than counting them as passes — a
 * gated instance answers every unknown path with the login page at 200, so the
 * not-found check has nothing to compare against there and says so.
 *
 * Usage:
 *   node scripts/frontdoor-parity.mjs <origin>                 assert the matrix
 *   node scripts/frontdoor-parity.mjs <origin-a> <origin-b>    assert both, then diff them
 *
 * Exit 1 on any failure. Exit 2 on a usage or network error, which is not a pass.
 */
import crypto from "node:crypto";

/**
 * Bodies are not byte-stable across two requests for the same page, and the reason is not
 * in this repo: Cloudflare's Email Address Obfuscation rewrites any address it finds in
 * HTML into `<a data-cfemail="…">`, with a FRESH random key each response. Comparing raw
 * bytes therefore reported every HTML path as a difference — including two fetches of one
 * origin — which would have made the parity check pure noise on its first real use.
 *
 * Normalise it out, and nothing else. A comparator that strips more than it must is a
 * comparator that stops noticing the difference it exists to find.
 */
function normalise(body) {
  return body
    .replace(/data-cfemail="[0-9a-f]+"/gi, 'data-cfemail=""')
    .replace(/\/cdn-cgi\/l\/email-protection#[0-9a-f]+/gi, "/cdn-cgi/l/email-protection#");
}
const sha = (s) => crypto.createHash("sha256").update(normalise(s)).digest("hex").slice(0, 12);
const isHtml = (b) => /^\s*<!doctype html/i.test(b);
const looksLikeLoginPage = (b) => isHtml(b) && /type=["']password["']/i.test(b);

/**
 * SEALED: the path exists as a file in dist/ and must never come back as that file.
 * `leaks` returns a reason when the body IS the file, i.e. when the worker did not run.
 */
const SEALED = [
  ["/__config/instance.json", (b) => /"users"\s*:/.test(b) && "the instance roster (this file carries seed passwords)"],
  ["/__config/routing.json", (b) => /"publicPrefixes"\s*:/.test(b) && "the routing document"],
  ["/__manifests/_engine.json", (b) => /"files"\s*:/.test(b) && "an engine manifest"],
  ["/_worker.js", (b) => /export\s+default|addEventListener\s*\(/.test(b) && "the worker source"],
  ["/tenant-context.mjs", (b) => /export\s+(const|function)/.test(b) && "the tenant-context module"],
  ["/tenant-cache.mjs", (b) => /export\s+(const|function)/.test(b) && "the tenant-cache module"],
  ["/kv-codec.mjs", (b) => /export\s+(const|function)/.test(b) && "the KV codec module"],
  ["/mail.mjs", (b) => /export\s+(const|function)/.test(b) && "the mail transport"],
  ["/chrome/appchrome.mjs", (b) => /export\s+(const|function)/.test(b) && "the chrome renderer"],
  ["/.assetsignore", (b) => /^_worker\.js/m.test(b) && "the deploy ignore list"],
];

/**
 * ALIVE: must be the real thing. Without these the matrix would pass on a deployment that
 * answered everything with a 404 — sealed, and also completely broken.
 */
const ALIVE = [
  ["/_build.json", (b) => { try { return !!JSON.parse(b).engine.sha; } catch { return false; } }, "a build stamp naming an engine sha"],
  ["/sw.js", (b) => /service worker/i.test(b) || /addEventListener/.test(b), "the service worker script"],
  ["/", (b) => isHtml(b), "an HTML page"],
];

const BOGUS = "/__frontdoor-parity-probe-no-such-path";

async function get(origin, path, method = "GET") {
  const url = origin.replace(/\/$/, "") + path;
  const res = await fetch(url, { method, redirect: "manual", headers: { "user-agent": "augur-frontdoor-parity" } });
  const body = method === "HEAD" ? "" : await res.text();
  return { status: res.status, ct: (res.headers.get("content-type") || "").split(";")[0].trim(), body, url };
}

async function probe(origin) {
  const results = [];
  const fail = (name, detail) => results.push({ ok: false, name, detail });
  const pass = (name, detail) => results.push({ ok: true, name, detail });
  const skip = (name, detail) => results.push({ skip: true, name, detail });

  for (const [path, leaks] of SEALED) {
    const r = await get(origin, path);
    const why = leaks(r.body);
    if (why) fail(`sealed ${path}`, `answered with ${why} (${r.status} ${r.ct}, ${r.body.length}B). The worker did not decide this request.`);
    else pass(`sealed ${path}`, `${r.status} ${r.ct || "-"} — not the file`);
  }

  for (const [path, ok, expected] of ALIVE) {
    const r = await get(origin, path);
    if (r.status !== 200 || !ok(r.body)) fail(`alive ${path}`, `expected ${expected}, got ${r.status} ${r.ct} (${r.body.length}B)`);
    else pass(`alive ${path}`, `${r.status} ${r.ct || "-"}`);
  }

  // not_found_handling. A gated instance answers every unknown path with the login page,
  // and its root is that same page, so there is nothing here to discriminate — say so
  // rather than counting it.
  const root = await get(origin, "/");
  const bogus = await get(origin, BOGUS);
  if (looksLikeLoginPage(root.body)) {
    skip("not-found", "this instance gates its root, so an unknown path and the root are the same page by design");
  } else if (bogus.status === 200 && sha(bogus.body) === sha(root.body)) {
    fail("not-found", `an unknown path returned the ROOT PAGE at 200. That is not_found_handling = "single-page-application"; every typo and every unpublished URL now looks real.`);
  } else {
    pass("not-found", `${bogus.status} and not the root page`);
  }

  // A HEAD must agree with the GET about whether the thing exists.
  const headBuild = await get(origin, "/_build.json", "HEAD");
  if (headBuild.status !== 200) fail("HEAD /_build.json", `${headBuild.status}, but GET answers 200`);
  else pass("HEAD /_build.json", "200");

  return results;
}

async function main() {
  const origins = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (!origins.length) {
    console.error("usage: node scripts/frontdoor-parity.mjs <origin> [origin-b]");
    process.exit(2);
  }

  let failures = 0;
  const bodies = [];
  for (const origin of origins) {
    console.log(`\n${origin}`);
    let results;
    try { results = await probe(origin); }
    catch (e) { console.log(`  ERROR  ${e.message}`); process.exit(2); }
    for (const r of results) {
      if (r.skip) console.log(`  skip   ${r.name}  —  ${r.detail}`);
      else if (r.ok) console.log(`  ok     ${r.name}  —  ${r.detail}`);
      else { console.log(`  FAIL   ${r.name}`); console.log(`         ${r.detail}`); failures++; }
    }
    bodies.push({ origin, results });
  }

  // Parity. Two front doors onto ONE instance must answer identically; that is what makes
  // a cutover checkable rather than hoped-for.
  if (origins.length === 2) {
    console.log(`\nparity  ${origins[0]}  vs  ${origins[1]}`);
    const paths = ["/_build.json", "/sw.js", "/", ...SEALED.map(([p]) => p)];
    for (const p of paths) {
      const [a, b] = await Promise.all(origins.map((o) => get(o, p)));
      // /_build.json carries a timestamp, so compare the engine sha rather than the bytes.
      if (p === "/_build.json") {
        const s = (x) => { try { return JSON.parse(x.body).engine.sha; } catch { return null; } };
        if (s(a) !== s(b)) { console.log(`  FAIL   ${p}  engine sha differs: ${s(a)} vs ${s(b)}`); failures++; }
        else console.log(`  ok     ${p}  same engine sha`);
        continue;
      }
      if (a.status !== b.status || sha(a.body) !== sha(b.body)) {
        console.log(`  FAIL   ${p}  ${a.status}/${sha(a.body)}  vs  ${b.status}/${sha(b.body)}`);
        failures++;
      } else console.log(`  ok     ${p}  ${a.status} identical`);
    }
  }

  console.log(failures
    ? `\nfrontdoor-parity: ${failures} FAILURE(S). A 'sealed' failure means the platform answered before the worker ran.`
    : `\nfrontdoor-parity: OK — every sealed path was decided by the worker, and the site is actually serving`);
  process.exit(failures ? 1 : 0);
}

main();
