// Build the seed pack: `seed/` composed by the real build, folded into ONE document.
//
// `F-seed-pack-at-provision`. The pack is what a freshly provisioned workspace is furnished
// with, and it is built ONCE PER ENGINE PIN rather than composed per signup: build.js calls
// this on every engine-only build (what a deploy shell runs) and writes the result to
// `dist/__seed/pack.json`, beside `__config/`, sealed from external requests like it.
// `node scripts/build-seed-pack.mjs` builds the same document by hand.
//
// HOW: a CHILD build of build.js with `GV_SPACES_ROOT` pointed at `seed/` and `GV_DIST` at
// a scratch directory — the same composition `augur publish` runs over a clone of the seed,
// so the pages a workspace is born with are byte-for-byte what a person would have published
// from the same tree with the same engine. The child gets NO identity file and NO deploy
// config, whatever the parent build was handed: a shell's deploy config is that instance's
// (vanity redirects, sentinels, its runtime-chrome switch) and none of it belongs in content
// that ships to every workspace on every instance. Then `__manifests/<space>.json` is read
// back, every file it names is inlined base64, and the two seed documents that are not
// files — `threads.json` and the connect-page slot — are carried beside it.
//
// WHAT IS STRIPPED, deliberately. build.js stamps every authored file with git's answer to
// "who last changed this" (`by`, a one-way person id; `editedAt`). For the seed that would
// be the engine author's id, written into every customer's workspace as the author of the
// welcome content — the exact leak the reserved actor namespace exists to prevent. The
// pack carries neither; provisioning stamps `editedAt` with its own instant and no `by`.
//
// WHAT IS ASSERTED, because the failure it catches is silent. A prototype folder the build
// did not discover (nested one level wrong — the trap `augur init` documents) builds a pack
// with five prototypes instead of six and reports success; the connect page losing its
// `CONNECT_COMMAND` slot builds a pack that provisioning can no longer fill. Both throw here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SEED_CONNECT_SLOT, SEED_PACK_FORMAT, validateSeedPack } from "../../src/seed-pack.mjs";

const ENGINE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The page carrying the connect slot, as the site path the build emits it at. */
export const SEED_CONNECT_FILE = "/start-here/connect-your-terminal/index.html";

/** Every prototype the seed tree declares: `<project>/prototypes/<name>/index.html`. */
export function seedPrototypes(seedRoot) {
  const out = [];
  for (const proj of fs.readdirSync(seedRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const protos = path.join(seedRoot, proj.name, "prototypes");
    if (!fs.existsSync(protos)) continue;
    for (const p of fs.readdirSync(protos, { withFileTypes: true })) {
      if (p.isDirectory() && fs.existsSync(path.join(protos, p.name, "index.html"))) {
        out.push(`/${proj.name}/${p.name}/index.html`);
      }
    }
  }
  return out.sort();
}

/**
 * Compose `seed/` with the real build and return the pack document.
 * @param {{engineRoot?: string, seedRoot?: string, env?: object, node?: string}} opts
 */
export function buildSeedPack({ engineRoot = ENGINE_ROOT, seedRoot = null, env = process.env, node = process.execPath } = {}) {
  const seed = seedRoot || path.join(engineRoot, "seed");
  const spaceJson = JSON.parse(fs.readFileSync(path.join(seed, "space.json"), "utf8"));
  const spaceId = String(spaceJson.id || "");
  if (!/^[a-z0-9-]+$/.test(spaceId)) throw new Error(`seed/space.json has no usable id (${JSON.stringify(spaceJson.id)})`);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "augur-seed-pack-"));
  try {
    // Nothing GV_/AUGUR_-shaped is inherited: the parent's flags describe the parent's
    // build. The child is told exactly two things — where the seed is and where to write.
    const childEnv = {};
    for (const [k, v] of Object.entries(env)) if (!/^(GV_|AUGUR_)/.test(k)) childEnv[k] = v;
    childEnv.GV_SPACES_ROOT = seed;
    childEnv.GV_DIST = out;
    childEnv.GV_SEED_PACK = "0"; // never recurse
    execFileSync(node, [path.join(engineRoot, "build.js")], {
      cwd: engineRoot, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });

    const manifestPath = path.join(out, "__manifests", `${spaceId}.json`);
    if (!fs.existsSync(manifestPath)) throw new Error(`the seed build emitted no manifest for space "${spaceId}"`);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    const files = {};
    for (const [p, f] of Object.entries(m.files || {})) {
      const bytes = fs.readFileSync(path.join(out, p.slice(1)));
      const { by: _by, editedAt: _editedAt, ...entry } = f;
      files[p] = { ...entry, s: bytes.length, b64: bytes.toString("base64") };
    }

    // Every prototype the tree declares is in the pack, at the path the site serves it.
    const declared = seedPrototypes(seed);
    const missing = declared.filter((p) => !(p in files));
    if (!declared.length) throw new Error("seed/ declares no prototypes");
    if (missing.length) throw new Error(`the seed build did not emit ${missing.join(", ")} — is the folder at <project>/prototypes/<name>/?`);

    // The connect page still carries the slot provisioning fills, exactly once.
    const connect = files[SEED_CONNECT_FILE];
    if (!connect) throw new Error(`the seed build did not emit ${SEED_CONNECT_FILE}`);
    const html = Buffer.from(connect.b64, "base64").toString("utf8");
    const slots = html.split(SEED_CONNECT_SLOT).length - 1;
    if (slots !== 1) throw new Error(`${SEED_CONNECT_FILE} carries the CONNECT_COMMAND slot ${slots} times; provisioning fills exactly one`);

    const threadsPath = path.join(seed, "threads.json");
    const threads = fs.existsSync(threadsPath) ? JSON.parse(fs.readFileSync(threadsPath, "utf8")) : {};
    delete threads._comment;
    for (const p of Object.keys(threads)) {
      if (!p.startsWith("/") || !Array.isArray(threads[p])) throw new Error(`seed/threads.json: "${p}" is not a page path with a list of threads`);
      if (!(`${p}index.html` in files)) throw new Error(`seed/threads.json names ${p}, which the seed build did not emit`);
    }

    const pack = {
      format: SEED_PACK_FORMAT,
      builtAt: new Date().toISOString(),
      engine: (m.builtWith && m.builtWith.engine) || null,
      space: m.space || { id: spaceId },
      routing: m.routing || {},
      ...(m.builtWith ? { builtWith: m.builtWith } : {}),
      connectCommandFile: SEED_CONNECT_FILE,
      files,
      threads,
    };
    const why = validateSeedPack(pack);
    if (why) throw new Error(`the built seed pack does not validate: ${why}`);
    return pack;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** Build and write the pack to `<dist>/__seed/pack.json`. Returns the path written. */
export function writeSeedPack(dist, opts = {}) {
  const pack = buildSeedPack(opts);
  const dir = path.join(dist, "__seed");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pack.json");
  fs.writeFileSync(file, JSON.stringify(pack));
  return { file, pack };
}
