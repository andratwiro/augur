// The seed pack: what a freshly provisioned workspace is furnished with, and how it lands.
//
// `F-seed-pack-at-provision`. The content is `seed/` in this repo — the three start-here
// prototypes, the worked examples, the starter design system and the comment threads that
// belong on the sample page. It is BUILT ONCE PER ENGINE PIN by build.js on an engine-only
// build (`scripts/lib/seed-pack-build.mjs`) into ONE document, `dist/__seed/pack.json`,
// which ships inside the worker's own asset bundle and is sealed from external requests
// like `/__config/`. Nothing is composed at signup: provisioning reads the pack the
// deployed engine carries and writes it under the new workspace's segment of the bundle
// store, exactly where a real publish of the same space would land.
//
// WHO WRITES IT, AND WHY THAT IS THE WORKSPACE OBJECT. The control plane may never name a
// store a tenant writes to (its isolation test is what it is allowed a Cloudflare token
// for), and the front door's publish route needs a credential no fresh workspace has yet.
// The workspace object holds the same env the worker does — the `BUNDLES` binding and the
// `ASSETS` binding — and it is the one place that already knows the workspace it IS. So
// `provision` takes `seedPack: true` and the object furnishes itself. The control plane
// carries no content and no key: it asks, in one call, for a workspace with the pack in it.
//
// THE ORDER, AND THE FAILURE IT IS SHAPED AROUND. Published content lives in R2 and the
// workspace's roster lives in the object's own storage; there is no transaction across
// the two and this module does not pretend there is. The content is written FIRST — blobs,
// then `versions/1.json`, then `manifest.json` — and only then does provisioning commit the
// admin, the seeded threads and the version row in ONE transaction. A failure anywhere
// before that commit leaves the object unprovisioned, and an unprovisioned workspace is
// REFUSED at the front door (`readSuspension` carries `provisioned: false`; the router
// answers what it answers for a hostname naming nobody), so content nobody can reach is
// content nobody can see — the label resolves to nobody rather than to a half-furnished
// site. A second provisioning of the same object rewrites the same keys with its own pack,
// so a label can never inherit an orphan's bytes it did not write itself.
//
// WHAT IT REFUSES. A live manifest under this workspace whose provenance is NOT the seed
// sentinel is somebody's real publish, and no provisioning may overwrite that — the write
// throws `seed-over-real-content` before a byte moves. `isSeedSource` is the one predicate
// (src/provenance.mjs), never a string compare.
//
// EVERY SEED VERSION READS AS SEED. `source` is `seedSource()`, `publishedBy` is the seed
// actor, each unit's `routing.unitSources` entry is the seed sentinel too, and no file
// carries a `by` — so the floor-check ("has this workspace published anything REAL yet")
// reads `connected: false` until a person publishes, and no card ever credits a stranger
// with the seed. Files are stamped `editedAt` at the provisioning instant, all the same
// instant, which is what keeps Start Here the first card (seed/README.md, "Start Here has
// to be the first card").
//
// ONE SUBSTITUTION. connect-your-terminal ships with an empty `CONNECT_COMMAND` slot and
// derives a command from the URL it is served on. Provisioning fills the slot with the
// workspace's REAL command — `npx augur connect --origin https://<label><suffix>` — so the
// page is exact rather than merely not wrong. The filled page hashes differently, so it is
// the one blob that is per-workspace rather than shared; everything else dedups.

import { SEED_ACTOR, seedSource, isSeedSource } from "./provenance.mjs";

/** Where the pack sits in the asset bundle. Sealed at the front door like `/__config/`. */
export const SEED_PACK_PATH = "__seed/pack.json";
export const SEED_PACK_FORMAT = 1;

/** The exact line the connect page ships with, and the one thing provisioning rewrites. */
export const SEED_CONNECT_SLOT = 'var CONNECT_COMMAND = "";';

/** The one-line command a person runs to pair a terminal with their workspace. */
export function connectCommandFor(origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  return o ? `npx augur connect --origin ${o}` : "";
}

/**
 * The origin a hosted workspace is served at: the label plus the platform suffix, which is
 * exactly how the front door resolves it. Null on a deployment with no suffix — there the
 * workspace is not addressed by label and the page's own URL-derived fallback is right.
 */
export function workspaceOrigin(env, workspaceId) {
  const suffix = env && typeof env.TENANT_HOST_SUFFIX === "string" ? env.TENANT_HOST_SUFFIX.trim() : "";
  const ws = String(workspaceId || "").trim();
  if (!suffix || !ws) return null;
  return `https://${ws}${suffix}`;
}

/**
 * Fill the connect slot. Exactly one occurrence is expected; zero means the page no longer
 * carries the slot (the pack builder refuses that), more than one would be a page that
 * declares the variable twice. Returns the html unchanged and `filled: false` for either.
 */
export function fillConnectCommand(html, command) {
  const s = String(html || "");
  const first = s.indexOf(SEED_CONNECT_SLOT);
  if (first < 0 || s.indexOf(SEED_CONNECT_SLOT, first + 1) >= 0 || !command) return { html: s, filled: false };
  return {
    html: s.slice(0, first) + `var CONNECT_COMMAND = ${JSON.stringify(String(command))};` + s.slice(first + SEED_CONNECT_SLOT.length),
    filled: true,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Why a document is not a seed pack, or null when it is one. */
export function validateSeedPack(pack) {
  if (!pack || typeof pack !== "object") return "not-an-object";
  if (pack.format !== SEED_PACK_FORMAT) return `format-${String(pack.format)}`;
  if (!pack.space || typeof pack.space !== "object" || !pack.space.id || !/^[a-z0-9-]+$/.test(pack.space.id)) return "no-space-id";
  if (!pack.files || typeof pack.files !== "object" || Array.isArray(pack.files)) return "no-files";
  const paths = Object.keys(pack.files);
  if (!paths.length) return "empty";
  for (const p of paths) {
    const f = pack.files[p];
    if (!p.startsWith("/")) return `bad-path:${p}`;
    if (!f || typeof f !== "object") return `bad-entry:${p}`;
    if (!HEX64.test(String(f.h || ""))) return `bad-hash:${p}`;
    if (typeof f.b64 !== "string" || !f.b64) return `no-bytes:${p}`;
    if (typeof f.ct !== "string" || !f.ct) return `no-type:${p}`;
    if (f.by !== undefined || f.editedAt !== undefined) return `stamped:${p}`;
  }
  if (pack.threads !== undefined && (!pack.threads || typeof pack.threads !== "object" || Array.isArray(pack.threads))) return "bad-threads";
  if (pack.connectCommandFile !== undefined && !(pack.connectCommandFile in pack.files)) return "connect-file-missing";
  return null;
}

/**
 * The pack the deployed engine carries, read through the worker's own asset binding — the
 * same channel `/__config/instance.json` is read over. Null when this deployment ships no
 * pack (an assets-mode build, or an engine that predates it) or the document is not one.
 */
export async function loadSeedPack(env) {
  const assets = env && env.ASSETS;
  if (!assets || typeof assets.fetch !== "function") return null;
  let res;
  try { res = await assets.fetch("https://config/" + SEED_PACK_PATH); } catch (e) { return null; }
  if (!res || !res.ok) return null;
  let pack;
  try { pack = await res.json(); } catch (e) { return null; }
  return validateSeedPack(pack) ? null : pack;
}

/**
 * The overlay seed a pack carries — the comment threads, keyed the way the comments family
 * is keyed (scope "", key = the page path), restamped to the provisioning instant so day-one
 * threads do not read as months old. Message order is kept by spacing the stamps one second
 * apart. Shape: `{ comments: { "": { "/path/": [thread…] } } }`, what `seedOverlay` takes.
 */
export function seedOverlayFrom(pack, at) {
  const threads = pack && pack.threads && typeof pack.threads === "object" ? pack.threads : {};
  const base = Date.parse(at || "") || Date.now();
  const byPath = {};
  for (const [path, list] of Object.entries(threads)) {
    if (!path.startsWith("/") || !Array.isArray(list)) continue;
    let i = 0;
    byPath[path] = list.map((t) => ({
      ...t,
      ...(t && t.at !== undefined ? { at: new Date(base).toISOString() } : {}),
      messages: Array.isArray(t && t.messages)
        ? t.messages.map((m) => ({ ...m, at: new Date(base + 1000 * i++).toISOString() }))
        : [],
    }));
  }
  return Object.keys(byPath).length ? { comments: { "": byPath } } : {};
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same definition as the commit handler's: bytes of the distinct blobs a manifest names. */
function bytesReferenced(files) {
  const byHash = {};
  for (const f of Object.values(files)) if (f && f.h) byHash[f.h] = Number(f.s) || 0;
  return Object.values(byHash).reduce((n, b) => n + b, 0);
}

class SeedPackError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

/**
 * Write the pack into one workspace's view of the bundle store, as the seed publish of
 * that workspace's space: every blob, then `versions/1.json`, then `manifest.json`.
 *
 * `store` is the workspace's segmented store (`bundleStore(env, workspaceId)` in
 * src/bundle-keys.mjs) — one object, five verbs over logical keys, the segment applied on
 * the way in. `blobs/` is a shared family and the key shape leaves it unprefixed, so one
 * store serves both the shared bytes and the per-workspace index.
 *
 * Refuses (throws, code on the error) rather than degrading: `seed-pack-corrupt` when a
 * blob's bytes do not hash to the name the pack gave them, `seed-over-real-content` when a
 * live manifest with real provenance already sits here. Returns what was written.
 */
export async function publishSeedPack({ store, pack, workspaceId, origin = null, at } = {}) {
  if (!store || typeof store.put !== "function" || typeof store.get !== "function") throw new SeedPackError("no-store");
  const why = validateSeedPack(pack);
  if (why) throw new SeedPackError("seed-pack-invalid", why);
  const space = pack.space.id;
  const stamp = at || new Date().toISOString();

  const liveObj = await store.get(`spaces/${space}/manifest.json`);
  if (liveObj) {
    let live = null;
    try { live = JSON.parse(await liveObj.text()); } catch (e) { live = null; }
    // An unreadable document is not a real publish either way round; a readable one with a
    // person's provenance is, and it stays.
    if (live && !isSeedSource(live.source)) throw new SeedPackError("seed-over-real-content", `${workspaceId}/${space}`);
  }

  const command = origin ? connectCommandFor(origin) : "";
  const files = {};
  let connectFilled = false;
  const puts = [];
  for (const [path, f] of Object.entries(pack.files)) {
    let bytes = fromBase64(f.b64);
    let h = f.h;
    if (path === pack.connectCommandFile && command) {
      const filled = fillConnectCommand(new TextDecoder().decode(bytes), command);
      if (filled.filled) {
        bytes = new TextEncoder().encode(filled.html);
        h = await sha256Hex(bytes);
        connectFilled = true;
      }
    } else if ((await sha256Hex(bytes)) !== h) {
      throw new SeedPackError("seed-pack-corrupt", path);
    }
    // No `by`: the seed is nobody's work, and absent is the honest answer a card renders
    // from. One `editedAt` for every file, the provisioning instant.
    files[path] = { h, ct: f.ct, s: bytes.byteLength, ...(f.sh ? { sh: f.sh } : {}), editedAt: stamp };
    puts.push(store.put(`blobs/${h}`, bytes));
  }
  await Promise.all(puts);

  const routing = { ...(pack.routing || {}) };
  const units = Array.isArray(routing.publicPrefixes) ? routing.publicPrefixes : [];
  routing.unitSources = Object.fromEntries(units.map((u) => [u, seedSource({ sha: pack.engine || null, dirty: false })]));
  const manifest = {
    id: space,
    format: 1,
    files,
    space: { ...pack.space, id: space },
    routing,
    ...(pack.builtWith ? { builtWith: pack.builtWith } : {}),
    source: seedSource({ sha: pack.engine || null, dirty: false, at: stamp }),
    version: 1,
    bytesReferenced: bytesReferenced(files),
    publishedAt: stamp,
    publishedBy: SEED_ACTOR,
  };
  const body = JSON.stringify(manifest);
  await store.put(`spaces/${space}/versions/1.json`, body);
  await store.put(`spaces/${space}/manifest.json`, body);
  return {
    space, version: 1,
    files: Object.keys(files).length,
    bytes: manifest.bytesReferenced,
    units: units.length,
    connectCommand: connectFilled ? command : null,
  };
}

export { SeedPackError };
