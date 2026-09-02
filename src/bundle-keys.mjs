// The bundle store's KEY SHAPE — the one place a logical store key becomes a physical one.
//
// Lifted out of src/_worker.js so the workspace object (src/tenant-do.js) can address the
// store for the workspace it IS, without a second key computation living beside this one:
// the seed pack a fresh workspace is furnished with at provisioning is written by the
// object, and the object has to land it under exactly the segment the front door reads
// (`F-seed-pack-at-provision`). The worker imports everything here and re-exports it under
// `__testables`, so every test and rehearsal that reads these names off the worker keeps
// reading them there. Nothing else changed in the move: the text below is the worker's,
// verbatim, including the two families that stay shared and why.
//
// ⚠️ `scripts/bundle-tenancy-rehearsal.mjs` edits a COPY of this file to run the per-family
// revert (`BUNDLE_TENANCY.spaces = false`); rename the constant and it says so.

// ---- The workspace segment on a bundle-store key ----------------------------
//
// `B-bundle-store-tenancy`. Not one key above carries a workspace: `config/instance.json`
// is one document for the whole bucket, `spaces/<id>/…` names a SPACE, and one deployment
// serving several workspaces therefore has them all writing the same keys. Two workspaces
// publishing a space under the same id write the same object, so the commit CAS, the
// unpublish guard and the stale-base check all evaluate against a stranger's document —
// and a route-level gate cannot un-collide a key. So the key gains the segment.
//
// THE SHAPE, decided rather than discovered (`DECISION-bundle-store-tenancy.md`, option 1):
// a tenant PREFIX in the one bucket. `t/<workspace>/spaces/…`,
// `t/<workspace>/config/instance.json`, `t/<workspace>/assets/…`.
//
// ⚠️ TWO FAMILIES STAY GLOBAL AND SHARED, DELIBERATELY. Both exceptions are written out
// below rather than left to fall out of the change, because falling out of a change is
// exactly how they would be got wrong.
//
//   `blobs/<sha256>` — published bytes. Every write verifies the digest against the key
//   before storing, so a workspace can only ever write bytes that hash to the name it
//   used: an overwrite is a no-op by construction and there is nothing to poison. Dedup
//   across workspaces is load-bearing (a migration's frozen pass uploaded 0 blobs of 854
//   already present), and `blobGc` is written FOR a shared namespace — it reads every
//   remaining manifest before deleting anything, because only the sweep can tell an
//   orphan from a blob another workspace is serving. Prefixing them would break that
//   design and buy nothing: a SHA-256 is not enumerable, so the disclosure door is the
//   INDEX, not the bytes — and the index is `spaces/`, which is prefixed.
//
//   `spaces/_engine/` — the engine chrome. ONE worker build serves every workspace on a
//   deployment, so one chrome bundle is correct rather than a leak. Prefix it by accident
//   and every workspace loses its chrome on the deploy that does it.
export const BUNDLE_TENANT_PREFIX = "t/";
export const ENGINE_SPACE_ID = "_engine";
// Which families take the segment. One word each, and flipping one back is the revert for
// that family alone — the shape `KV_CUTOVER` uses, for the same reason: a change that has
// to be reverted as a unit is a change nobody wants to make on a live instance.
export const BUNDLE_TENANCY = Object.freeze({
  spaces: true,   // spaces/<id>/manifest.json + spaces/<id>/versions/<n>.json
  config: true,   // config/instance.json
  assets: true,   // assets/<sha256[0:40]> — canvas image bytes
  // blobs: NOT HERE, AND NOT AN OMISSION. See the header above.
});

/** Which family a bundle-store key belongs to, or "" for one this scheme does not name. */
export function bundleFamily(key) {
  const k = String(key || "");
  if (k.startsWith("blobs/")) return "blobs";
  if (k.startsWith("assets/")) return "assets";
  if (k.startsWith("config/")) return "config";
  if (k.startsWith("spaces/")) return "spaces";
  return "";
}

/**
 * The physical store key for a logical one.
 *
 * `workspace` is the second argument and it DEFAULTS TO NONE, which is the whole of the
 * straddle: a deployment that serves one workspace passes nothing and gets back the string
 * it has always got back, byte for byte. Only a prefixing deployment passes a segment —
 * see `bundleWorkspaceSegment`.
 */
export function bundleKey(key, workspace = "") {
  if (!workspace) return key;
  const family = bundleFamily(key);
  if (!family || !BUNDLE_TENANCY[family]) return key;
  // ⚠️ THE ENGINE EXCEPTION, WRITTEN OUT. `spaces/_engine/…` is the chrome one worker
  // build serves to every workspace on this deployment. It is not this workspace's to
  // hold and it is not another's to be kept from.
  if (family === "spaces" && key.startsWith(`spaces/${ENGINE_SPACE_ID}/`)) return key;
  return BUNDLE_TENANT_PREFIX + workspace + "/" + key;
}

/**
 * The bundle store as ONE workspace sees it: the same five verbs over LOGICAL keys, with
 * the segment applied on the way in and stripped on the way out.
 *
 * ⚠️ WITH NO SEGMENT THIS IS THE BINDING ITSELF — not a wrapper around it, the object.
 * That is deliberate, and it is what makes the change additive for every instance running
 * today: with no segment this function is the identity, so there is no new code at all
 * between the worker and R2 and nothing to get subtly wrong on a deployment that never
 * asked for a segment.
 *
 * Stripping on the way out is what lets every caller keep the key it already had: a
 * listing hands back `spaces/x/versions/3.json`, and handing that straight back to `get`
 * or `delete` re-applies the segment rather than double-prefixing it.
 */
export function bundleStore(env, workspace = "") {
  const r2 = env && env.BUNDLES;
  if (!r2 || !workspace) return r2 || null;
  const seg = BUNDLE_TENANT_PREFIX + workspace + "/";
  const K = (k) => bundleKey(k, workspace);
  const un = (k) => (String(k).startsWith(seg) ? String(k).slice(seg.length) : String(k));
  // ⚠️ A WRITE GOES TO THE SEGMENTED KEY AND NOWHERE ELSE. This view used to write the
  // unprefixed key too, as a straddle meant to keep the per-family flag a revert rather
  // than a rollback — and on the one kind of deployment that has a segment at all, it was
  // never that. Where the bucket is shared an unprefixed key is unattributable: the
  // deployment's own rule (`legacyIsOurs: false`) already refuses to READ one, and flipping
  // a family's flag back there reads whatever was last written under the bare key by
  // whichever workspace wrote it last — the collision this scheme exists to close, not
  // yesterday. So the second write bought no revert, and it cost a real thing: every
  // workspace's `config/instance.json` — its roster — and every manifest — its blob index,
  // the disclosure door the header above names — copied to where every workspace shares.
  // Found on a live shared deployment, attributed by content, the same second as the
  // segmented write.
  //
  // Deletes never touched the unprefixed key either, for the same reason in the other
  // direction: removing one is removing an object that may be a neighbour's. That still
  // holds, so what predates the segment is left exactly where and as it was.
  const store = {
    get: (k, opts) => (opts === undefined ? r2.get(K(k)) : r2.get(K(k), opts)),
    put: (k, v, opts) => (opts === undefined ? r2.put(K(k), v) : r2.put(K(k), v, opts)),
    list: async (opts = {}) => {
      const page = await r2.list({ ...opts, prefix: K(opts.prefix || "") });
      return {
        ...page,
        objects: (page.objects || []).map((o) => ({ ...o, key: un(o.key) })),
        delimitedPrefixes: (page.delimitedPrefixes || []).map(un),
      };
    },
  };
  if (typeof r2.head === "function") store.head = (k) => r2.head(K(k));
  if (typeof r2.delete === "function") store.delete = (k) => r2.delete(K(k));
  return store;
}

