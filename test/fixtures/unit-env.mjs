// test/fixtures/unit-env.mjs — a bundle-mode env for the drafts routes: memory store,
// memory KV with one publish token, and a UNITS namespace running the real UnitObject
// over node:sqlite. Shared by unit-api, unit-serve and the drill.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { UnitObject } from "../../src/unit-object.mjs";
import { __testables as W } from "../../src/_worker.js";

export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const ADA = { email: "ada@example.test", name: "Ada", initials: "AD", role: "editor" };
export const ctxFor = (tenantId) => ({ ...W.applyInstance({ users: [ADA] }), tenantId });

function sqlHandle(db) {
  return {
    exec(stmt, ...params) {
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all(...params);
      if (params.length) { db.prepare(stmt).run(...params); return []; }
      db.exec(stmt);
      return [];
    },
  };
}

export function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  const etags = new Map([...store.keys()].map((k) => [k, "e0"]));
  let seq = 0;
  const text = (v) => typeof v === "string" ? v : (v && v.byteLength !== undefined ? new TextDecoder().decode(v) : JSON.stringify(v));
  return {
    store,
    async get(k, opts) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      const bytes = new TextEncoder().encode(v);
      const slice = opts && opts.range ? bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : bytes;
      return { text: async () => v, arrayBuffer: async () => slice.buffer, body: new Blob([slice]).stream(), etag: etags.get(k) };
    },
    async put(k, v) { store.set(k, text(v)); etags.set(k, `e${++seq}`); },
    async head(k) { return store.has(k) ? { etag: etags.get(k) } : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      if (delimiter) {
        const set = new Set();
        for (const k of keys) { const i = k.indexOf(delimiter, prefix.length); if (i >= 0) set.add(k.slice(0, i + 1)); }
        return { delimitedPrefixes: [...set], objects: [], truncated: false };
      }
      return { objects: keys.map((k) => ({ key: k })), truncated: false };
    },
  };
}

export function memKV() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async getWithMetadata(k) { return { value: map.get(k) ?? null, metadata: null }; },
    async put(k, v) { map.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { map.delete(k); },
    async list({ prefix = "" } = {}) { return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

/** A UNITS namespace: one real object per name, each over its own in-memory database. */
export function unitsNamespace() {
  const objects = new Map();
  return {
    objects,
    idFromName: (n) => n,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:");
        const ctx = { storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f() };
        objects.set(name, new UnitObject(ctx, {}));
      }
      const obj = objects.get(name);
      return { fetch: (input, init) => obj.fetch(new Request(input, init)) };
    },
  };
}

export const file = (body, ct = "text/html; charset=utf-8") => ({ h: sha(body), ct, s: body.length });

export function manifestOf(version, units) {
  const files = {};
  for (const [u, entries] of Object.entries(units)) for (const [name, body] of Object.entries(entries)) {
    files[`${u}${name}`] = file(body, name.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
  }
  return {
    id: "alpha", version, format: 1,
    space: { id: "alpha", default: true, adminOnly: false, name: "Alpha" },
    source: { sha: "a".repeat(40), dirty: false },
    builtWith: { engine: "e".repeat(40), version: "0.15.0" },
    publishedAt: "2026-08-20T09:14:02.000Z", publishedBy: ADA.email,
    files, routing: { publicPrefixes: Object.keys(units), versionMap: {}, unitSources: {} },
  };
}

/** Bundle-mode env holding `live` as the alpha manifest, every blob it names, and one token. */
export async function makeEnv({ live, token = "tok", label = ADA.email, units = unitsNamespace() } = {}) {
  const objects = { "spaces/alpha/manifest.json": JSON.stringify(live) };
  for (const [p, f] of Object.entries(live.files)) objects[`blobs/${f.h}`] = bodyOf(live, p);
  const env = { GV_ASSET_SOURCE: "r2", BUNDLES: memR2(objects), COMMENTS: memKV(), UNITS: units, SESSION_SECRET: "unit-fixed-secret" };
  await env.COMMENTS.put("publish:tokens", JSON.stringify({ [await W.tokenFor(`pub:${token}`)]: { space: "alpha", label } }));
  return env;
}
// The fixture's bodies are recoverable from the manifest: `manifestOf` hashed them.
const BODIES = new Map();
export function bodyOf(live, p) { return BODIES.get(live.files[p].h) || ""; }
export function remember(body) { BODIES.set(sha(body), body); return body; }

export const liveNow = (env) => JSON.parse(env.BUNDLES.store.get("spaces/alpha/manifest.json"));
