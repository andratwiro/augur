// A different BAKE of the same source is not an edit.
//
// `C-manifest-provenance` stamps `{by, editedAt}` on every file whose bytes changed, and
// the first day it rendered on a busy instance every card read "Edited 8 hours ago" by
// the CI token. Nobody had edited anything. The stamp compared the BUILT bytes, and the
// engine leaves its fingerprint in every authored page it emits — a `?v=<version>` on two
// injected script tags, the unfurl meta, the tab emoji — so a publish made with a
// different engine clone than the last one flips every page's hash and calls all of it
// one person's work. Measured 2026-09-02 on the reference instance: fourteen publishes
// overnight alternating between a collaborator's clone and the shell's re-bake, each
// restamping 368 of 479 pages, until 158 of 158 units carried the same minute.
//
// The fix is to compare what a PERSON wrote. build.js records `sh`, the hash of the source
// bytes before any decoration, on every entry it transforms; the commit handler prefers it
// to `h` whenever both sides carry one. `h` stays what it is — the address of the served
// bytes — and every consumer of it is untouched.
//
// Two belts ride with it. A publish whose source commit IS the live one, clean on both
// sides, changed nothing a person wrote whatever its bytes say — that is exactly what a
// re-bake is. And a live entry that predates `sh` cannot be judged, so it keeps what it had:
// the alternative is one publish that restamps the whole site on the day this ships, which
// is the symptom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testables as W } from "../src/_worker.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CTX = W.applyInstance({ users: [{ email: "someone@example.test", name: "Someone" }] });
const sha = (s) => createHash("sha256").update(s).digest("hex");

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })), truncated: false };
    },
  };
}

// An entry as build.js emits it: `h` over the built bytes, `sh` over the source bytes.
// Passing `source` as null models a file build.js does not transform (no `sh`).
const entry = (built, source) => ({
  h: sha(built), ct: "text/html; charset=utf-8", s: built.length,
  ...(source == null ? {} : { sh: sha(source) }),
});
const manifest = (files, source = { sha: "abc", dirty: false }) => ({
  id: "alpha", format: 1, space: { id: "alpha", default: true },
  source, files,
  routing: { publicPrefixes: [...new Set(Object.keys(files).map((p) => p.slice(0, p.lastIndexOf("/") + 1)))], versionMap: {} },
});

function envWith(live) {
  const objects = {};
  if (live) objects["spaces/alpha/manifest.json"] = JSON.stringify(live);
  return { BUNDLES: memR2(objects), PUBLISH_BOOTSTRAP_TOKEN: "tok" };
}
const commit = (env, m) => {
  for (const f of Object.values(m.files || {})) env.BUNDLES.store.set(`blobs/${f.h}`, "x");
  return W.publishApi(CTX,
    new Request("https://x.test/__publish/alpha/commit", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify(m),
    }),
    new URL("https://x.test/__publish/alpha/commit"), env);
};
const liveNow = (env) => JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
const stampOf = (f) => ({ by: f.by, editedAt: f.editedAt });
const tick = () => new Promise((r) => setTimeout(r, 5));

test("A DIFFERENT BAKE OF THE SAME SOURCE KEEPS THE STAMP", async () => {
  const env = envWith(null);
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--engine 1-->", "<p>hi</p>") }));
  const before = stampOf(liveNow(env).files["/a/index.html"]);
  await tick();
  // The next engine decorates the same page differently: new built bytes, same source.
  const r = await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--engine 2-->", "<p>hi</p>") }, { sha: "def", dirty: false }));
  assert.equal(r.status, 200);
  const after = liveNow(env).files["/a/index.html"];
  assert.deepEqual(stampOf(after), before, "a re-bake restamped a page nobody edited");
  assert.equal(after.h, sha("<p>hi</p><!--engine 2-->"), "the served bytes did not move to the new bake");
});

test("a changed source is an edit, whatever the engine did", async () => {
  const env = envWith(null);
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--e1-->", "<p>hi</p>") }));
  const before = stampOf(liveNow(env).files["/a/index.html"]);
  await tick();
  await commit(env, manifest({ "/a/index.html": entry("<p>hello</p><!--e1-->", "<p>hello</p>") }, { sha: "def", dirty: false }));
  assert.notEqual(liveNow(env).files["/a/index.html"].editedAt, before.editedAt, "a real edit was not stamped");
});

test("an entry without a source hash on either side still compares served bytes", async () => {
  // Images, scripts, generated indexes: build.js emits no `sh` for them, and the rule
  // for those is exactly what it was.
  const env = envWith(null);
  await commit(env, manifest({ "/a/x.js": { h: sha("one"), ct: "text/javascript", s: 3 } }));
  const before = stampOf(liveNow(env).files["/a/x.js"]);
  await tick();
  await commit(env, manifest({ "/a/x.js": { h: sha("two"), ct: "text/javascript", s: 3 } }, { sha: "def", dirty: false }));
  assert.notEqual(liveNow(env).files["/a/x.js"].editedAt, before.editedAt);
});

test("⚠️ A LIVE ENTRY THAT PREDATES `sh` KEEPS ITS STAMP, ONCE — the upgrade must not be the wipe", async () => {
  // Live was published by an engine that recorded no source hash. The first publish
  // after the upgrade carries one, and its built bytes differ (new engine). Nothing can
  // say whether the source moved, so the honest answer is the one already recorded.
  const legacy = manifest({ "/a/index.html": { ...entry("<p>hi</p><!--old-->", null), by: "someone", editedAt: "2026-07-09T10:00:00.000Z" } });
  const env = envWith({ ...legacy, version: 7 });
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--new-->", "<p>hi</p>") }, { sha: "def", dirty: false }));
  const once = liveNow(env).files["/a/index.html"];
  assert.deepEqual(stampOf(once), { by: "someone", editedAt: "2026-07-09T10:00:00.000Z" }, "the first `sh` publish restamped a legacy entry");
  assert.equal(once.sh, sha("<p>hi</p>"), "the source hash was not recorded for next time");
  // From here on the source hash decides: a real edit stamps.
  await tick();
  await commit(env, manifest({ "/a/index.html": entry("<p>hello</p><!--new-->", "<p>hello</p>") }, { sha: "ghi", dirty: false }));
  assert.notEqual(liveNow(env).files["/a/index.html"].editedAt, "2026-07-09T10:00:00.000Z");
});

test("a legacy entry that is UNSTAMPED stays unstamped through the upgrade", async () => {
  // Absent is the honest answer for a file nobody has edited since stamping began, and
  // the upgrade publish must not invent one.
  const legacy = manifest({ "/a/index.html": entry("<p>hi</p><!--old-->", null) });
  const env = envWith({ ...legacy, version: 7 });
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--new-->", "<p>hi</p>") }, { sha: "def", dirty: false }));
  const f = liveNow(env).files["/a/index.html"];
  assert.equal(f.editedAt, undefined);
  assert.equal(f.by, undefined);
});

test("THE SAME CLEAN SOURCE COMMIT CHANGES NOTHING A PERSON WROTE, even without source hashes", async () => {
  // A re-bake checks out the live sha and publishes with the current engine. Same
  // commit, both clean: whatever the bytes say, nobody edited anything.
  const env = envWith(null);
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--e1-->", null) }, { sha: "abc", dirty: false }));
  const before = stampOf(liveNow(env).files["/a/index.html"]);
  await tick();
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p><!--e2-->", null) }, { sha: "abc", dirty: false }));
  assert.deepEqual(stampOf(liveNow(env).files["/a/index.html"]), before, "a same-commit republish restamped");
});

test("a same-commit publish from a DIRTY tree is not that belt", async () => {
  // Uncommitted edits on top of the live commit are edits.
  const env = envWith(null);
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p>", null) }, { sha: "abc", dirty: false }));
  const before = stampOf(liveNow(env).files["/a/index.html"]);
  await tick();
  await commit(env, manifest({ "/a/index.html": entry("<p>hello</p>", null) }, { sha: "abc", dirty: true }));
  assert.notEqual(liveNow(env).files["/a/index.html"].editedAt, before.editedAt);
});

test("A RESTORE INTO AN EMPTY STORE KEEPS THE STAMPS THE COPY CARRIES", async () => {
  // `augur restore` replays an export as a commit. With no live manifest there is no
  // prior entry, and stamping every file with the restorer launders the whole history
  // into one person on the day of a migration. The copy's own record is the truth here,
  // on the same trust-on-first-publish footing lineage already has.
  const env = envWith(null);
  const carried = { by: "someone", editedAt: "2026-07-09T10:00:00.000Z" };
  await commit(env, manifest({
    "/a/index.html": { ...entry("<p>hi</p>", "<p>hi</p>"), ...carried },
    "/b/index.html": entry("<p>b</p>", "<p>b</p>"),
  }));
  const files = liveNow(env).files;
  assert.deepEqual(stampOf(files["/a/index.html"]), carried, "the restorer overwrote the copy's provenance");
  assert.ok(files["/b/index.html"].editedAt, "a file the copy did not stamp stays a fresh publish");
  assert.notEqual(files["/b/index.html"].by, "someone");
});

test("a body-carried stamp is ignored when live already holds the file", async () => {
  // Trust on FIRST publish only. Afterwards a claim in the body is an assertion anybody
  // can type, and the recorded stamp wins.
  const env = envWith(null);
  await commit(env, manifest({ "/a/index.html": entry("<p>hi</p>", "<p>hi</p>") }));
  const before = stampOf(liveNow(env).files["/a/index.html"]);
  await tick();
  await commit(env, manifest({ "/a/index.html": { ...entry("<p>hi</p>", "<p>hi</p>"), by: "forged", editedAt: "1999-01-01T00:00:00.000Z" } }, { sha: "def", dirty: false }));
  assert.deepEqual(stampOf(liveNow(env).files["/a/index.html"]), before);
});

// ── build.js records the source hash ───────────────────────────────────────────────────

function makeSpace() {
  const dir = mkdtempSync(path.join(tmpdir(), "sh-space-"));
  const proto = path.join(dir, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  writeFileSync(path.join(proto, "app.js"), "console.log(1)\n");
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "acme", default: true }));
  return dir;
}

test("BUILD.JS RECORDS THE SOURCE HASH ON EVERY PAGE IT TRANSFORMS, AND ONLY THOSE", () => {
  const dir = makeSpace();
  const out = path.join(dir, "__dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: dir, GV_DIST: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const m = JSON.parse(readFileSync(path.join(out, "__manifests", "acme.json"), "utf8"));
  const page = m.files["/demo/hello/index.html"];
  assert.ok(page, "the prototype page is not in the manifest");
  const source = readFileSync(path.join(dir, "demo", "prototypes", "hello", "index.html"));
  assert.equal(page.sh, sha(source), "sh is not the hash of the source bytes");
  assert.notEqual(page.h, page.sh, "the built page carries no decoration — this test proves nothing");
  const script = m.files["/demo/hello/app.js"];
  assert.ok(script, "the verbatim asset is not in the manifest");
  assert.equal(script.sh, undefined, "a verbatim copy carries a redundant source hash");
  for (const [p, f] of Object.entries(m.files)) {
    if (f.sh !== undefined && !p.endsWith(".html")) assert.fail(`${p} carries sh but is not a transformed page`);
  }
});
