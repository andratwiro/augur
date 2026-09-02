// Who last changed each file, and when — recorded where it is true.
//
// `C-manifest-provenance`. Provenance used to be DERIVED from `git log` at build time, and
// publishing keeps disturbing the evidence. On one day in August 2026 the same instance lost
// it three independent ways: a 76-poster mass commit reset every card to "edited now"; a
// build from a shallow clone credited the graft author with the entire site; and a
// reconcile-adoption laundered 169 pages' authorship into one collaborator. Each needed its
// own build.js guard, and every guard is a tell — the derivation was reading evidence that
// the act of publishing keeps rewriting.
//
// So it is RECORDED instead, at commit, which is the only moment it is true.
//
// ⚠️ IT DOES NOT STORE AN ADDRESS, and that is a deliberate deviation from the plan item's
// `{author: who.label}`. A manifest is read by more things than a comment thread is, and the
// engine already made this exact choice for messages: `by: personId(email)`, a one-way hash,
// resolved to a name and a face at RENDER time from the roster.
//
// THE GALLERY NOW RENDERS IT, at serve time — see test/currency.test.mjs. build.js still
// derives the baked date from git and must, because a card cannot read a stamp that is
// assigned AFTER the build that draws it; that line is the baseline the served answer
// replaces. What this file buys the render is that a stamp, once written, is never
// disturbed — so "untouched for 7 months" is a fact about the work and not about the
// publish that happened to run last.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { __testables as W } from "../src/_worker.js";

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

const file = (body) => ({ h: sha(body), ct: "text/html; charset=utf-8", s: body.length });
// Every manifest is a DIFFERENT clean commit. A publish whose bytes differ from live under
// the SAME clean commit is what a re-bake looks like, and the handler carries every stamp
// through one (test/provenance-source-hash.test.mjs) — a fixture that republished "changed"
// files under one constant sha was modelling something no tree can produce.
let commitSeq = 0;
const manifest = (units) => {
  const files = {};
  for (const [u, body] of Object.entries(units)) files[`${u}index.html`] = file(body);
  return {
    id: "alpha", format: 1, space: { id: "alpha", default: true },
    source: { sha: `commit-${++commitSeq}`, dirty: false }, files,
    routing: { publicPrefixes: Object.keys(units), versionMap: {} },
  };
};

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

test("A PUBLISHED FILE CARRIES WHO AND WHEN", async () => {
  const env = envWith(null);
  assert.equal((await commit(env, manifest({ "/a/": "one" }))).status, 200);
  const f = liveNow(env).files["/a/index.html"];
  assert.ok(f.by, "no author recorded");
  assert.match(f.editedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("⚠️ THE AUTHOR IS A ONE-WAY ID, NEVER AN ADDRESS", async () => {
  // A manifest is read by more things than a comment thread. The engine already made this
  // choice for messages, and "finishing" this by storing the address would undo it.
  const env = envWith(null);
  await commit(env, manifest({ "/a/": "one" }));
  const raw = env.BUNDLES.store.get("spaces/alpha/manifest.json");
  const f = liveNow(env).files["/a/index.html"];
  assert.ok(!/@/.test(String(f.by)), `an address is stored as the author: ${f.by}`);
  assert.equal(f.by, W.personId("bootstrap"), "the id is not personId of the publisher's label");
  assert.ok(!raw.includes('"author"'), "an `author` field appeared beside `by`");
});

test("AN UNTOUCHED FILE KEEPS ITS STAMP when something else is republished", async () => {
  const env = envWith(null);
  await commit(env, manifest({ "/a/": "one", "/b/": "two" }));
  const first = liveNow(env).files;
  const stampA = { by: first["/a/index.html"].by, editedAt: first["/a/index.html"].editedAt };

  // A different publish, later, changing only /b/.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await commit(env, manifest({ "/a/": "one", "/b/": "two changed" }))).status, 200);
  const after = liveNow(env).files;
  assert.deepEqual(
    { by: after["/a/index.html"].by, editedAt: after["/a/index.html"].editedAt }, stampA,
    "an untouched file was restamped — this is the 76-poster mass-commit failure, back");
  assert.notEqual(after["/b/index.html"].editedAt, stampA.editedAt, "the changed file was not restamped");
});

test("a file whose bytes changed back to a previous hash counts as changed", async () => {
  // The stamp follows the BYTES the previous publish recorded, not the history of the file.
  // A revert is an edit: somebody did it, just now.
  const env = envWith(null);
  await commit(env, manifest({ "/a/": "one" }));
  const t0 = liveNow(env).files["/a/index.html"].editedAt;
  await new Promise((r) => setTimeout(r, 5));
  await commit(env, manifest({ "/a/": "two" }));
  await new Promise((r) => setTimeout(r, 5));
  await commit(env, manifest({ "/a/": "one" }));
  assert.notEqual(liveNow(env).files["/a/index.html"].editedAt, t0);
});

test("⚠️ A FILE THAT PREDATES THE FIELD STAYS UNSTAMPED — absent is the honest answer", async () => {
  // Inventing a stamp at the first publish that happens not to touch the file would say
  // "edited now, by whoever published something else", which is the exact lie the git
  // derivation used to tell. The renderer's fallback is for these, and they age out on
  // their own the next time somebody really edits them.
  const legacy = { ...manifest({ "/a/": "one", "/b/": "two" }), version: 4 };
  const env = envWith(legacy);
  assert.equal((await commit(env, manifest({ "/a/": "one", "/b/": "two changed" }))).status, 200);
  const after = liveNow(env).files;
  assert.equal(after["/a/index.html"].by, undefined, "a stamp was invented for an untouched legacy file");
  assert.equal(after["/a/index.html"].editedAt, undefined);
  assert.ok(after["/b/index.html"].editedAt, "the file that really changed was not stamped");
});

test("the stamp survives a version read-back, so a rollback restores provenance too", async () => {
  const env = envWith(null);
  await commit(env, manifest({ "/a/": "one" }));
  const v1 = JSON.parse(env.BUNDLES.store.get("spaces/alpha/versions/1.json"));
  assert.ok(v1.files["/a/index.html"].editedAt);
  assert.deepEqual(v1.files, liveNow(env).files, "the version copy and live disagree about provenance");
});

test("⏳ BUILD.JS STILL DERIVES FROM GIT, and must until the render moves", () => {
  // A card cannot read a stamp that is assigned AFTER the build that draws it. Ripping the
  // git system out now would blank every date and every face on both live instances.
  const src = readSource("../build.js");
  assert.match(src, /function spaceDates\(/, "the git derivation was removed before the render moved");
  const worker = readSource("../src/_worker.js");
  assert.match(worker, /NOTHING RENDERS IT YET/);
});

import fs from "node:fs";
function readSource(rel) { return fs.readFileSync(new URL(rel, import.meta.url), "utf8"); }
