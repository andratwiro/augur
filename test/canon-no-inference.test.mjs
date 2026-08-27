// Bring-your-own inference, held shut mechanically.
//
// `augur canon` is the one feature in this engine whose obvious implementation is a model
// call: "look at this product and write me a design system" is a prompt. Building it that
// way would put a provider account, an API key, a per-extraction cost and a vendor
// dependency into a repository that has none of those and is not going to acquire them —
// and it would do it QUIETLY, because a single `fetch` to a provider inside a script
// nobody reads looks exactly like the rest of the file.
//
// The design instead is: Augur ships the harness — the working folder, the token roles,
// the evidence collector, the grader, the emitter — and the user's own agent, on the
// user's own account, does the judging. That is a claim about the code, so it is a test
// about the code, and it fails on the commit that breaks it rather than on the day
// someone reads the dependency list.
//
// It deliberately does NOT work from a list of provider names. A denylist of vendors goes
// stale by the next funding round, and the shape being forbidden is not "a company" — it
// is a credential, an endpoint, a model identifier, or a dependency at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CANON_FILES = [
  "src/canon/schema.mjs",
  "src/canon/observe.mjs",
  "src/canon/emit.mjs",
  "src/canon/collect-in-browser.js",
  "scripts/canon.mjs",
  "agents/canon-extract.md",
];

test("the engine declares no runtime dependency, and canon added none", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [],
    "the engine ships with no runtime dependencies — anything here is a supply chain every instance inherits");
  assert.deepEqual(Object.keys(pkg.optionalDependencies || {}), []);
  assert.deepEqual(Object.keys(pkg.peerDependencies || {}), []);
  // And the lockfile agrees: nothing an instance installs at runtime, only the local
  // browser tooling the screenshot scripts use. Checked as a PROPERTY of every resolved
  // package rather than as a list of names, so it holds for whatever gets added next.
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const root = (lock.packages || {})[""] || {};
  assert.equal(root.dependencies, undefined, "the lockfile's root declares runtime dependencies");
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!name) continue;
    assert.equal(entry.dev, true, `${name} is resolved as a RUNTIME dependency — the engine has none`);
  }
});

test("nothing in the canon flow imports anything that is not the standard library or this repo", () => {
  for (const rel of CANON_FILES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p) || !/\.(mjs|js)$/.test(rel)) continue;
    const src = fs.readFileSync(p, "utf8");
    for (const m of src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']|import\(\s*["']([^"']+)["']/gm)) {
      const spec = m[1] || m[2];
      assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"),
        `${rel} imports "${spec}" — the canon flow may use the standard library and this repo, nothing else`);
    }
  }
});

test("the canon flow holds no credential, endpoint or model identifier", () => {
  // Shapes, not vendors. Each of these is what a model call looks like from the outside
  // regardless of whose model it is.
  const SHAPES = [
    [/\bapi[_-]?key\b/i, "an API key"],
    [/\bauthorization\s*[:=]\s*["'`]?\s*bearer\b/i, "a bearer credential"],
    [/\bprocess\.env\.[A-Z_]*(?:KEY|TOKEN|SECRET)[A-Z_]*\b/, "a credential read from the environment"],
    [/\/v\d+\/(?:chat\/)?(?:completions|messages|responses|generate|embeddings)\b/i, "an inference endpoint"],
    [/\bmax[_-]?tokens\b/i, "an inference parameter"],
    [/\btemperature\s*:/i, "an inference parameter"],
    [/\bsystem[_-]?prompt\b/i, "a prompt"],
    [/\bmodel\s*:\s*["'`]/i, "a model identifier"],
  ];
  for (const rel of CANON_FILES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    for (const [re, what] of SHAPES) {
      const hit = re.exec(src);
      assert.equal(hit, null, `${rel} contains ${what}: ${hit && hit[0]}`);
    }
  }
});

test("the only thing the canon flow fetches is a URL the person named", () => {
  // `collect` makes HTTP requests — that is its job — and every one of them has to come
  // from the argument or from a link inside the page it just read. A literal host in the
  // source is the shape of a call to somewhere the person did not ask for.
  const src = fs.readFileSync(path.join(ROOT, "scripts", "canon.mjs"), "utf8");
  const literals = [...src.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)].map((m) => m[1]);
  for (const u of literals) {
    assert.ok(/^https?:\/\/(?:app\.)?example\.(?:com|test)/.test(u),
      `scripts/canon.mjs names ${u} — the only URLs in here may be the documented placeholders`);
  }
  // The browser collector may name no address at all, with one exception: the SVG
  // namespace URI, which is an identifier the DOM compares against and not somewhere a
  // request can go. It is allowed BY VALUE rather than by pattern, so a second address
  // cannot arrive under the same excuse.
  const SVG_NS = ["http://www.w3", ".org/2000/svg"].join("");
  const browser = fs.readFileSync(path.join(ROOT, "src", "canon", "collect-in-browser.js"), "utf8")
    .replace(/^\s*\*.*$/gm, "")
    .split(SVG_NS).join("");
  assert.equal(/https?:\/\//.test(browser), false,
    "the browser collector names an address — it must make no request at all");
});

test("the brief tells the person whose agent is doing the work", () => {
  // The BYO design only holds if the person understands it: an agent that thinks Augur
  // will do the mapping produces a null canon and a report saying it is done.
  const brief = fs.readFileSync(path.join(ROOT, "agents", "canon-extract.md"), "utf8");
  assert.match(brief, /(?:your|user's)\s+own\s+agent/is);
  assert.match(brief, /no model|does none of the deciding|does no thinking/i);
});
