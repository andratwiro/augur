// Chaos suite v1 — hostile/degraded publishers against the REAL store handler.
//
// The 2026-08-19..23 incident class was never one bug: it was interleavings of
// stale clones, old clients, dirty trees, collided ships and litter-carrying
// checkouts, each individually plausible, none simulated anywhere. This suite
// plays those personas CONCURRENTLY against publishApi over an in-memory R2 in
// randomized interleavings (seeded PRNG — a failure reproduces from its seed),
// then asserts the invariants that must hold no matter who won each race:
//
//   I1  no live public URL is ever lost without allowUnpublish
//   I2  versions advance monotonically, one per accepted commit
//   I3  live never carries conflict-litter beyond the ceiling
//   I4  a below-floor client never lands a commit (with a floor set)
//   I5  oversized manifests never go live
//   I6  every accepted commit's manifest is internally consistent (files ⊇ prefixes)
//
// This is the server half of the chaos gate. Client-half personas (real git
// clones: shallow, stale, killed mid-publish) live with the release-train work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

// Deterministic PRNG: mulberry32. Date.now/Math.random stay out of the suite so
// every run of a given seed replays the exact interleaving.
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  const etags = new Map();
  const bump = (k) => etags.set(k, `"e${(etags.get(k) || "").length}${store.get(k)?.length || 0}"`);
  for (const k of store.keys()) bump(k);
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), etag: etags.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); bump(k); },
    async head(k) { return store.has(k) ? { etag: etags.get(k) } : null; },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (delimiter) {
        const set = new Set();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const i = rest.indexOf(delimiter);
          if (i >= 0) set.add(prefix + rest.slice(0, i + 1));
        }
        return { objects: [], delimitedPrefixes: [...set], truncated: false };
      }
      return { objects: keys.map((k) => ({ key: k })), truncated: false };
    },
  };
}

const H = (s) => s.repeat(64).slice(0, 64);
const unitFiles = (u, h) => ({ [`${u}index.html`]: { h: H(h), ct: "text/html", s: 10 } });
const mani = (units, extra = {}) => {
  const files = {}, prefixes = [];
  for (const [u, h] of units) { Object.assign(files, unitFiles(u, h)); prefixes.push(u); }
  return {
    id: "alpha", format: 1, space: { id: "alpha", default: true },
    files, routing: { publicPrefixes: prefixes, versionMap: {} },
    source: { sha: "s0", dirty: false, actor: "chaos" },
    ...extra,
  };
};

const call = (env, op, body) => W.publishApi(
  new Request(`https://x.test/__publish/alpha/${op}`, {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
  new URL(`https://x.test/__publish/alpha/${op}`),
  env);

async function seedBlobs(env, ...hashes) {
  for (const h of hashes) await env.BUNDLES.put("blobs/" + H(h), "content-" + h);
}
const liveManifest = (env) => JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));

// ── the personas ─────────────────────────────────────────────────────────────
// Each returns commit bodies to fire. `sane` marks the ones whose commits are
// allowed to land; the rest must ALWAYS be refused.
const PERSONAS = {
  // A protocol-5 client shipping its own edit composed on live (fetches live first).
  goodComposer: (env, r, mine) => async () => {
    const liveRaw = env.BUNDLES.store.get("spaces/alpha/manifest.json");
    const live = JSON.parse(liveRaw);
    const m = mani([], {});
    m.files = { ...live.files, ...unitFiles(mine, mine + "v2") };
    m.routing.publicPrefixes = [...new Set([...live.routing.publicPrefixes, mine])];
    await seedBlobs(env, mine + "v2");
    return call(env, "commit", { ...m, baseVersion: live.version, clientProtocol: 5 });
  },
  // A stale whole-tree client: last saw v1, ships only what existed then.
  staleTree: (env, r, mine, v1files, v1prefixes) => async () => {
    const m = mani([], {});
    m.files = { ...v1files };
    m.routing.publicPrefixes = [...v1prefixes];
    return call(env, "commit", { ...m, baseVersion: 1, clientProtocol: 5 });
  },
  // A pre-floor client (protocol 3): must be turned away at the door.
  oldClient: (env, r, mine) => async () => {
    const live = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
    const m = mani([], {});
    m.files = { ...live.files, ...unitFiles(mine, mine + "old") };
    m.routing.publicPrefixes = [...new Set([...live.routing.publicPrefixes, mine])];
    await seedBlobs(env, mine + "old");
    return call(env, "commit", { ...m, clientProtocol: 3 });
  },
  // A litter-carrier: a patched/hostile client shipping a fork cascade.
  litterBomb: (env, r) => async () => {
    const live = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
    const m = mani([], {});
    m.files = { ...live.files };
    m.routing.publicPrefixes = [...live.routing.publicPrefixes];
    for (let i = 0; i < 60; i++) {
      const u = `/toolkit/x-conflict-demo-${i}/`;
      Object.assign(m.files, unitFiles(u, "l"));
      m.routing.publicPrefixes.push(u);
    }
    await seedBlobs(env, "l");
    return call(env, "commit", { ...m, baseVersion: live.version, clientProtocol: 5 });
  },
  // A resource bomb: manifest with a flood of prefixes.
  prefixFlood: (env) => async () => {
    const live = JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
    const m = mani([], {});
    m.files = { ...live.files };
    m.routing.publicPrefixes = [...live.routing.publicPrefixes];
    for (let i = 0; i < 1200; i++) m.routing.publicPrefixes.push(`/flood/p${i}/`);
    return call(env, "commit", { ...m, baseVersion: live.version, clientProtocol: 5 });
  },
};

async function runChaos(seed) {
  const r = rng(seed);
  // Live starts at v1 with three public units, floor at 5.
  const v1 = mani([["/toolkit/a/", "a"], ["/toolkit/b/", "b"], ["/toolkit/c/", "c"]], { version: 1 });
  const env = {
    BUNDLES: memR2({ "spaces/alpha/manifest.json": JSON.stringify(v1) }),
    PUBLISH_BOOTSTRAP_TOKEN: "tok",
  };
  await seedBlobs(env, "a", "b", "c");
  W.applyInstance({ users: [], minClientProtocol: 5 });
  try {
    const thunks = [];
    const editors = ["/toolkit/a/", "/toolkit/b/", "/toolkit/c/"];
    for (let round = 0; round < 6; round++) {
      thunks.push(PERSONAS.goodComposer(env, r, editors[Math.floor(r() * editors.length)]));
      thunks.push(PERSONAS.staleTree(env, r, null, v1.files, v1.routing.publicPrefixes));
      thunks.push(PERSONAS.oldClient(env, r, editors[Math.floor(r() * editors.length)]));
      if (round % 2 === 0) thunks.push(PERSONAS.litterBomb(env, r));
      if (round % 3 === 0) thunks.push(PERSONAS.prefixFlood(env));
    }
    // Shuffle (Fisher-Yates on the seeded PRNG) and fire with random micro-stagger.
    for (let i = thunks.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [thunks[i], thunks[j]] = [thunks[j], thunks[i]];
    }
    const results = await Promise.all(thunks.map((t, i) =>
      new Promise((res) => setTimeout(res, Math.floor(r() * 20))).then(t).then(
        async (resp) => ({ status: resp.status, body: await resp.json().catch(() => ({})) }))));

    // ── invariants ────────────────────────────────────────────────────────────
    const live = liveManifest(env);
    const livePrefixes = live.routing.publicPrefixes;

    // I1: nothing unpublished — every original unit is still live.
    for (const u of ["/toolkit/a/", "/toolkit/b/", "/toolkit/c/"]) {
      assert.ok(livePrefixes.includes(u), `seed ${seed}: ${u} lost from live`);
    }
    // I2: version == 1 + accepted commits.
    const accepted = results.filter((x) => x.status === 200).length;
    assert.equal(live.version, 1 + accepted, `seed ${seed}: version drift`);
    // I3: litter never lands.
    const litter = livePrefixes.filter((p) => /-conflict-/.test(p));
    assert.equal(litter.length, 0, `seed ${seed}: litter went live: ${litter.slice(0, 3)}`);
    // I4: every old-client attempt got 426.
    const oldResults = results.filter((x) => x.body && x.body.error === "cli-outdated");
    assert.ok(oldResults.every((x) => x.status === 426), `seed ${seed}: old client not refused properly`);
    // I5: floods never land.
    assert.ok(livePrefixes.length < 1000, `seed ${seed}: flood reached live`);
    // I6: consistency — every live prefix has at least one file under it.
    for (const u of livePrefixes) {
      assert.ok(Object.keys(live.files).some((p) => p.startsWith(u)), `seed ${seed}: empty prefix ${u} live`);
    }
    // Refusal taxonomy sanity: stale trees died on stale-base or unpublish-refused,
    // litter/floods on the ceiling; nothing failed in an UNKNOWN way.
    for (const x of results) {
      if (x.status === 200) continue;
      assert.ok(["stale-base", "unpublish-refused", "manifest-ceiling", "cli-outdated", "blobs-missing"]
        .includes(x.body.error), `seed ${seed}: unexpected refusal ${x.status} ${JSON.stringify(x.body).slice(0, 120)}`);
    }
    return { accepted, total: results.length };
  } finally {
    W.applyInstance({ users: [] });
  }
}

test("chaos: 5 personas × 6 rounds × 4 seeds — invariants hold under every interleaving", async () => {
  for (const seed of [1, 2026, 424242, 98765]) {
    const { accepted, total } = await runChaos(seed);
    assert.ok(accepted >= 1, `seed ${seed}: nothing at all landed (${accepted}/${total}) — the suite lost its signal`);
  }
});
