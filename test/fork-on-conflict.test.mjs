// Two editors change the same prototype, and the store resolves it.
//
// `C-fork-on-conflict`. A commit carries `baseVersion` — the live version its delta was
// computed against — and a mismatch means somebody published in between. Today that is a
// flat 409 and the CLI recomposes and retries, which works because the CLI HAS GIT: it can
// prove which units it edited.
//
// ⚠️ A HOSTED WORKSPACE MAY HAVE NO REPO AT ALL. "Repo-less multi-editor at v1, not phase
// two" is settled, and a repo-less editor has no evidence to recompose FROM — for that
// publisher a 409 is not a retry, it is a dead end. So the server has to be able to answer.
//
// ⚠️ IT IS OPT-IN, and a publisher that does not ask gets byte-for-byte today's 409. The
// commit handler is the live publish path of every instance; nothing that works now may
// start resolving conflicts differently because a server moved underneath it. The first
// three tests here are that promise.
//
// ⚠️ AND IT RUNS THE CLIENT'S OWN COMPOSITION. `composePublish` is the same module
// `publish.mjs` calls; what the server substitutes is the EVIDENCE — git says "which units
// did I edit", the BASE MANIFEST says the same thing in bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { __testables as W } from "../src/_worker.js";

const CTX = W.applyInstance({ users: [] });
const sha = (s) => createHash("sha256").update(s).digest("hex");

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : (typeof v === "object" && v.byteLength !== undefined ? new TextDecoder().decode(v) : JSON.stringify(v))); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "" } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })), truncated: false };
    },
  };
}

const file = (body) => ({ h: sha(body), ct: "text/html; charset=utf-8", s: body.length });

/** A manifest with one file per unit, whose bytes are the unit's name plus a marker. */
function manifestOf(version, units, { source = { sha: "base", dirty: false } } = {}) {
  const files = {};
  for (const [u, body] of Object.entries(units)) files[`${u}index.html`] = file(body);
  return {
    id: "alpha", version, format: 1,
    space: { id: "alpha", default: true },
    source, publishedBy: "them@example.test",
    files,
    routing: { publicPrefixes: Object.keys(units), versionMap: {}, unitSources: {} },
  };
}

/** A store holding a base version, a live manifest, and every blob either names. */
function fleet({ base, live }) {
  const objects = {
    "spaces/alpha/manifest.json": JSON.stringify(live),
    [`spaces/alpha/versions/${base.version}.json`]: JSON.stringify(base),
  };
  for (const m of [base, live]) {
    for (const f of Object.values(m.files)) objects[`blobs/${f.h}`] = "x";
  }
  return { BUNDLES: memR2(objects), PUBLISH_BOOTSTRAP_TOKEN: "tok" };
}

/**
 * Commit, after storing the outgoing manifest's own blobs — which is what a real publish
 * does first (`PUT /blob/<h>` per new hash) and what the store's spot-check is for. Without
 * it every case here dies on `blobs-missing` and reads as a resolver bug.
 */
const commit = (env, manifest) => {
  for (const f of Object.values(manifest.files || {})) env.BUNDLES.store.set(`blobs/${f.h}`, "x");
  return commitRaw(env, manifest);
};

const commitRaw = (env, manifest) => W.publishApi(
  CTX,
  new Request("https://x.test/__publish/alpha/commit", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(manifest),
  }),
  new URL("https://x.test/__publish/alpha/commit"),
  env);

const outgoing = (m, extra) => {
  const { version, ...rest } = m;
  return { ...rest, ...extra };
};

const liveNow = (env) => JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));

// ── the promise to every existing publisher ─────────────────────────────────────────

test("WITHOUT ASKING, A STALE BASE IS THE SAME 409 IT HAS ALWAYS BEEN", async () => {
  const base = manifestOf(4, { "/toolkit/map/": "base map" });
  const live = manifestOf(5, { "/toolkit/map/": "their map" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(manifestOf(0, { "/toolkit/map/": "my map" }), { baseVersion: 4 }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "stale-base");
  assert.equal(liveNow(env).version, 5, "refused means nothing shipped");
});

test("and asking for it explicitly is the only way to get it", async () => {
  const base = manifestOf(4, { "/toolkit/map/": "base map" });
  const live = manifestOf(5, { "/toolkit/map/": "their map" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(manifestOf(0, { "/toolkit/map/": "my map" }),
    { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
});

test("`forkOnConflict` is transport-only and never reaches the stored manifest", async () => {
  const base = manifestOf(4, { "/toolkit/map/": "base map" });
  const live = manifestOf(4, { "/toolkit/map/": "base map" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(manifestOf(0, { "/toolkit/map/": "my map" }),
    { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
  assert.equal("forkOnConflict" in liveNow(env), false);
});

// ── the drill ───────────────────────────────────────────────────────────────────────

test("THE SECOND EDITOR LANDS: THEIRS KEEPS THE URL, MINE IS AT -conflict-<who>", async () => {
  const base = manifestOf(4, { "/toolkit/map/": "base map", "/toolkit/chart/": "base chart" });
  const live = manifestOf(5, { "/toolkit/map/": "their map", "/toolkit/chart/": "base chart" });
  const env = fleet({ base, live });

  const res = await commit(env, outgoing(
    manifestOf(0, { "/toolkit/map/": "my map", "/toolkit/chart/": "base chart" }),
    { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, 6);
  assert.equal(body.forks.length, 1, JSON.stringify(body.forks));
  assert.equal(body.forks[0].unit, "/toolkit/map/");
  assert.match(body.forks[0].fork, /^\/toolkit\/map-conflict-[a-z0-9-]+\/$/);

  const after = liveNow(env);
  const fork = body.forks[0].fork;
  // THEIRS at the canonical path — any shared link still resolves.
  assert.equal(after.files["/toolkit/map/index.html"].h, sha("their map"));
  // MINE at the fork, pointing at a blob the store already had. No re-upload.
  assert.equal(after.files[`${fork}index.html`].h, sha("my map"));
  assert.ok(after.routing.publicPrefixes.includes(fork), "the fork is not routable");
  assert.ok(after.routing.publicPrefixes.includes("/toolkit/map/"));
});

test("A CONFLICT.md IS SYNTHESIZED SERVER-SIDE, and its bytes are stored", async () => {
  const base = manifestOf(4, { "/toolkit/map/": "base map" });
  const live = manifestOf(5, { "/toolkit/map/": "their map" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(manifestOf(0, { "/toolkit/map/": "my map" }),
    { baseVersion: 4, forkOnConflict: true }));
  const { forks } = await res.json();
  const after = liveNow(env);
  const note = after.files[`${forks[0].fork}CONFLICT.md`];
  assert.ok(note, "no CONFLICT.md in the composed manifest");
  const stored = env.BUNDLES.store.get(`blobs/${note.h}`);
  assert.ok(stored, "the note is in the manifest and its bytes are in no store");
  assert.match(stored, /conflict/i);
});

test("A UNIT ONLY I CHANGED SHIPS; ONE ONLY THEY CHANGED IS KEPT; ONE NOBODY TOUCHED SURVIVES", async () => {
  const base = manifestOf(4, {
    "/a/": "base a", "/b/": "base b", "/c/": "base c",
  });
  const live = manifestOf(5, {
    "/a/": "base a", "/b/": "their b", "/c/": "base c",
  });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(
    manifestOf(0, { "/a/": "my a", "/b/": "base b", "/c/": "base c" }),
    { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
  // Absent rather than empty: "nothing was contested" is a different fact from "nothing was
  // resolved", and a publisher printing a conflict summary should print none at all.
  assert.equal((await res.json()).forks, undefined, "an uncontested publish reported forks");

  const after = liveNow(env);
  assert.equal(after.files["/a/index.html"].h, sha("my a"), "my edit did not ship");
  assert.equal(after.files["/b/index.html"].h, sha("their b"), "their edit was reverted");
  assert.equal(after.files["/c/index.html"].h, sha("base c"), "an untouched unit changed");
});

test("A NEW UNIT ONLY I HAVE SHIPS, and nothing of theirs is dropped to make room", async () => {
  const base = manifestOf(4, { "/a/": "base a" });
  const live = manifestOf(5, { "/a/": "base a", "/theirs/": "their new page" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(
    manifestOf(0, { "/a/": "base a", "/mine/": "my new page" }),
    { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
  const after = liveNow(env);
  assert.equal(after.files["/mine/index.html"].h, sha("my new page"));
  assert.equal(after.files["/theirs/index.html"].h, sha("their new page"),
    "a unit published while I was working disappeared");
});

// ── the hard 409 that stays ─────────────────────────────────────────────────────────

test("⚠️ A CHANGE OUTSIDE EVERY UNIT, ON BOTH SIDES, IS STILL A HARD 409", async () => {
  // A design-system file, a shared token sheet, space.json. Not safe to resolve
  // mechanically — forking a stylesheet puts two versions of it on the site and lets the
  // fork's copy win somewhere. The CLI aborts the merge for a human for the same reason.
  const base = manifestOf(4, { "/a/": "base a" });
  base.files["/skills/acme-ui/acme-ui.css"] = file("base css");
  const live = manifestOf(5, { "/a/": "base a" });
  live.files["/skills/acme-ui/acme-ui.css"] = file("their css");
  const env = fleet({ base, live });

  const mine = manifestOf(0, { "/a/": "base a" });
  mine.files["/skills/acme-ui/acme-ui.css"] = file("my css");
  const res = await commit(env, outgoing(mine, { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "conflict-outside-prototype");
  assert.deepEqual(body.paths, ["/skills/acme-ui/acme-ui.css"]);
  assert.equal(liveNow(env).version, 5, "a refused conflict shipped anyway");
});

test("but a loose file only ONE side changed is not a conflict", async () => {
  const base = manifestOf(4, { "/a/": "base a" });
  base.files["/robots.txt"] = file("base robots");
  const live = manifestOf(5, { "/a/": "base a" });
  live.files["/robots.txt"] = file("base robots");
  const env = fleet({ base, live });

  const mine = manifestOf(0, { "/a/": "base a" });
  mine.files["/robots.txt"] = file("my robots");
  const res = await commit(env, outgoing(mine, { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
});

test("and identical edits on both sides are not a conflict either", async () => {
  // Two people typing the same fix is not a disagreement.
  const base = manifestOf(4, { "/a/": "base a" });
  base.files["/robots.txt"] = file("base robots");
  const live = manifestOf(5, { "/a/": "base a" });
  live.files["/robots.txt"] = file("same new robots");
  const env = fleet({ base, live });

  const mine = manifestOf(0, { "/a/": "base a" });
  mine.files["/robots.txt"] = file("same new robots");
  assert.equal((await commit(env, outgoing(mine, { baseVersion: 4, forkOnConflict: true }))).status, 200);
});

// ── the refusals that are not conflicts ─────────────────────────────────────────────

test("⚠️ A BASE VERSION THIS STORE NEVER HAD IS NOT A CONFLICT TO RESOLVE", async () => {
  // Versions are never pruned, so a miss means a client claiming a version that never
  // existed. Composing against nothing would silently treat every unit as newly authored.
  const base = manifestOf(4, { "/a/": "base a" });
  const live = manifestOf(5, { "/a/": "their a" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(manifestOf(0, { "/a/": "my a" }),
    { baseVersion: 99, forkOnConflict: true }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "stale-base");
});

test("a matching baseVersion never reaches the resolver at all", async () => {
  const base = manifestOf(4, { "/a/": "base a" });
  const live = manifestOf(4, { "/a/": "base a" });
  const env = fleet({ base, live });
  const res = await commit(env, outgoing(manifestOf(0, { "/a/": "my a" }),
    { baseVersion: 4, forkOnConflict: true }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).forks, undefined, "a clean publish reported forks");
  assert.equal(liveNow(env).files["/a/index.html"].h, sha("my a"));
});

test("THE UNIT VOCABULARY IS ONE DEFINITION, shared with the CLI", async () => {
  // Two implementations of "which folder does this path belong to" would disagree on
  // exactly the paths a conflict is about.
  const units = await import("../src/publish-units.mjs");
  const cli = await import("../scripts/lib/publish-conflict.mjs");
  assert.equal(cli.authoredUnits, units.authoredUnits);
  assert.equal(cli.unitOfPath, units.unitOfPath);
  assert.equal(cli.unitPaths, units.unitPaths);
});

test("⚠️ THE LONGEST UNIT PREFIX WINS, not the first one the manifest happens to list", async () => {
  // With /toolkit/ and /toolkit/embed/ both units, a file under the second belonged to
  // whichever came first in Set iteration order — which is JSON key order. A conflict
  // decided by key order is a conflict decided at random.
  const { unitOfPath } = await import("../src/publish-units.mjs");
  const set = new Set(["/toolkit/", "/toolkit/embed/"]);
  assert.equal(unitOfPath("/toolkit/embed/index.html", set), "/toolkit/embed/");
  const reversed = new Set(["/toolkit/embed/", "/toolkit/"]);
  assert.equal(unitOfPath("/toolkit/embed/index.html", reversed), "/toolkit/embed/");
  assert.equal(unitOfPath("/elsewhere/x.html", set), null);
});
