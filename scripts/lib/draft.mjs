// draft.mjs — the CLI half of drafts that land, as functions over an injected client.
//
// Every verb here is `do<Verb>({client, dir, …}) → result`, and the entry points in
// scripts/{open,save,land,sync,close}.mjs only print the result. The client is the small
// object `unitClient` returns, so a test can stand in a fake instance and drive the whole
// loop on disk without a network. See docs/drafts-that-land.md §4 and §7.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { merge3 } from "./merge3.mjs";
import { authoredUnits } from "../../src/publish-units.mjs";

export const STATE_FILE = ".augur/draft.json";
/** How many times `land` tries again when the space's manifest is contended. */
export const LAND_RETRIES = 4;
export const THEIRS_DIR = ".augur/theirs";
// The machine-wide registry of open draft folders. `AUGUR_DRAFTS_REGISTRY` exists for the
// test suite, which must never write into the developer's own home folder.
export const REGISTRY = path.join(os.homedir(), ".config", "augur", "drafts.json");
const registryPath = () => process.env.AUGUR_DRAFTS_REGISTRY || REGISTRY;

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", wasm: "application/wasm",
};
export const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
export const hashBytes = (buf) => createHash("sha256").update(buf).digest("hex");
export const relOf = (unit, urlPath) => urlPath.slice(unit.length);
/**
 * A REPO folder or a URL, as the unit path it publishes to: `<project>/prototypes/<name>`
 * is the nesting a space clone keeps, served at `/<project>/<name>/`. An agent has just been
 * looking at the folder, so it is the spelling it will type.
 */
export function unitPathFor(input) {
  const s = String(input == null ? "" : input).trim().slice(0, 300).replace(/\/prototypes\//g, "/");
  if (!s) return "";
  const t = s.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!t || t === "/") return "/";
  return `/${t.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}
export const urlOf = (unit, rel) => unit + rel;

export function scanFolder(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === "" && e.name === ".augur") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) {
        const buf = fs.readFileSync(path.join(d, e.name));
        out[r] = { h: hashBytes(buf), ct: mimeOf(e.name), s: buf.length };
      }
    }
  };
  walk(dir, "");
  return out;
}

export function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf8")); } catch (e) { return null; }
}
export function writeState(dir, state) {
  fs.mkdirSync(path.join(dir, ".augur"), { recursive: true });
  const p = path.join(dir, STATE_FILE);
  fs.writeFileSync(p + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(p + ".tmp", p);
}

export function changesBetween(unit, savedTable, localScan) {
  const changes = [];
  const seen = new Set();
  for (const [rel, f] of Object.entries(localScan)) {
    const p = urlOf(unit, rel);
    seen.add(p);
    const prior = savedTable[p];
    if (prior && prior.h === f.h) continue;
    changes.push({ path: p, h: f.h, ct: f.ct, s: f.s, baseHash: prior ? prior.h : null });
  }
  for (const [p, f] of Object.entries(savedTable)) if (!seen.has(p)) changes.push({ path: p, baseHash: f.h, delete: true });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ── the machine-wide registry of open draft folders ──────────────────────────
function readRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), "utf8")); } catch (e) { return { drafts: [] }; }
}
function writeRegistry(reg) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(reg, null, 2));
  fs.renameSync(p + ".tmp", p);
}
export function registryAdd(entry) {
  const reg = readRegistry();
  reg.drafts = reg.drafts.filter((d) => d.dir !== entry.dir).concat([entry]);
  writeRegistry(reg);
}
export function registryRemove(dir) {
  const reg = readRegistry();
  reg.drafts = reg.drafts.filter((d) => d.dir !== dir);
  writeRegistry(reg);
}
export const registryList = () => readRegistry().drafts;

// ── the client ───────────────────────────────────────────────────────────────
/**
 * `fetchJson(url, init)` is fetch with the bearer header added; the unit routes live at
 * `/__unit/<verb>` and blobs at `/__publish/<space>/blob/<hash>`. Non-2xx answers come back
 * as `{status, ...body}` rather than throwing, because a 409 is an answer, not a failure.
 */
/**
 * The server answers a token it does not know with a bare `forbidden` and no sentence,
 * ON PURPOSE — a guessed token must learn nothing. This side knows something the server
 * will not say: the token it just sent is the one saved on this machine, so a bare
 * refusal means that token is dead here — revoked by a role change or a removal, or
 * minted for another workspace — and the way back is to pair again.
 */
export const TOKEN_NOT_ACCEPTED = "this machine's publish token is not accepted here — it may have been revoked (a role change or a removal does that), or it belongs to another workspace. Run `augur connect` again.";
export function explainRefusal(body, status) {
  if (status === 403 && body && body.error === "forbidden" && !body.message) return { ...body, message: TOKEN_NOT_ACCEPTED };
  return body;
}

export function unitClient({ origin, token, space, session }) {
  const headers = { Authorization: `Bearer ${token}`, "X-Augur-Session": session || "" };
  const post = async (verb, body) => {
    const r = await fetch(`${origin}/__unit/${verb}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    return r.ok ? out : { status: r.status, ...explainRefusal(out, r.status) };
  };
  const get = async (verb, unit) => {
    const r = await fetch(`${origin}/__unit/${verb}?unit=${encodeURIComponent(unit)}`, { headers });
    const out = await r.json().catch(() => ({}));
    return r.ok ? out : { status: r.status, ...explainRefusal(out, r.status) };
  };
  return {
    open: (b) => post("open", b), save: (b) => post("save", b), land: (b) => post("land", b),
    sync: (b) => post("sync", b), discard: (b) => post("discard", b), presence: (unit) => get("presence", unit),
    main: (unit) => get("main", unit),
    // The live manifest, for the one check that needs to see every unit at once rather
    // than one at a time: `open --new` naming an opportunity that does not exist yet.
    // Same bearer this client already holds, over the read side of the publish API
    // (`store.mjs`'s `apiClient` speaks the same route for every other CLI script).
    async manifest() {
      const r = await fetch(`${origin}/__publish/${space}/manifest`, { headers });
      if (!r.ok) throw await refusalError("manifest fetch", r);
      return r.json();
    },
    async blobPut(h, body) {
      const r = await fetch(`${origin}/__publish/${space}/blob/${h}`, { method: "PUT", headers, body });
      if (!r.ok && r.status !== 204) throw await refusalError("blob upload", r);
    },
    async blobGet(h) {
      const r = await fetch(`${origin}/__publish/${space}/blob/${h}`, { headers });
      if (!r.ok) throw await refusalError("blob fetch", r);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

/**
 * A non-2xx answer from the blob routes, carried as an error that REMEMBERS it was an
 * answer: the status and whatever the server said. `guarded` turns that back into a
 * result, so a role refusal on an upload reads as the refusal it is — before this, a
 * viewer's save came back as "unreachable, nothing is lost", which was neither.
 */
async function refusalError(what, r) {
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  const err = new Error(`${what} failed: ${r.status}${body && body.error ? ` ${body.error}` : ""}`);
  err.status = r.status;
  err.body = body && typeof body === "object" ? explainRefusal(body, r.status) : null;
  return err;
}

// ── the verbs ────────────────────────────────────────────────────────────────
// `blobPut`/`blobGet` throw on a non-2xx answer, and a raw `fetch` can reject outright
// (offline, DNS, a dropped connection mid-transfer) — a transient failure anywhere inside
// a verb must come back as a result, not an unhandled rejection. `guarded` is that catch,
// applied once to each `do<Verb>` export rather than five times: whatever the body threw
// becomes `{ok: false, error: "network", message}`, and since nothing here writes state
// until its work has actually succeeded, disk is left exactly as it was at the failure —
// a retry reprocesses safely.
function guarded(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (err) {
      // An answer the server gave (a status) is a refusal and keeps the server's words;
      // anything else — DNS, a dropped connection, a thrown fixture — is the network.
      if (err && err.status) {
        const body = err.body || {};
        return { ok: false, status: err.status, error: body.error || "refused", message: body.message || String(err.message), ...(body.reason ? { reason: body.reason } : {}) };
      }
      return { ok: false, error: "network", message: String((err && err.message) || err) };
    }
  };
}

async function materialise(client, unit, table, dir) {
  for (const [p, f] of Object.entries(table)) {
    const dest = path.join(dir, relOf(unit, p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await client.blobGet(f.h));
  }
}

async function doOpenImpl({ client, unit, dir, origin, space, session, now, isNew = false, allowNewOpportunity = false }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { ok: false, error: "folder-not-empty", dir };
  const createdFolder = !fs.existsSync(dir);
  if (isNew) {
    // Two refusals BEFORE anything reaches the server: a guessed name never opens even an
    // empty draft. The slug rule is per-segment lowercase letters, digits and dashes, and
    // the refusal names the slug it would accept — the fix, not just the complaint.
    const bare = unit.replace(/^\/|\/$/g, "");
    const slug = bare.toLowerCase().replace(/[^a-z0-9/]+/g, "-").replace(/-+\//g, "/").replace(/\/-+/g, "/").replace(/^-+|-+$/g, "");
    if (slug !== bare) return { ok: false, error: "unslugged-unit", unit, slug };
    if (!allowNewOpportunity) {
      // "Which opportunities exist" comes from the live manifest, not a guess: an agent
      // told to "put it under Broad Listening" has to find `broad-listening`, not invent a
      // new top-level folder next to it. A client that cannot answer (an older fixture, a
      // fake in a unit test) is treated as having nothing to say — never a refusal that a
      // client-capability gap would otherwise manufacture.
      let live = null;
      if (typeof client.manifest === "function") { try { live = await client.manifest(); } catch (e) { live = null; } }
      const opps = new Set([...authoredUnits(live || {})].map((u) => u.replace(/^\/|\/$/g, "").split("/")[0]).filter(Boolean));
      const opp = bare.split("/")[0];
      if (opps.size && !opps.has(opp)) return { ok: false, error: "unknown-opportunity", unit, opportunity: opp };
    }
  }
  const o = await client.open({ unit });
  if (o.status) return { ok: false, ...o };
  // A unit with no files is one that does not exist yet. Creating one is a decision the
  // caller states with `isNew`; without it, a typo would quietly open an empty draft on a
  // prototype that was never there. Either mismatch hands the draft straight back.
  const exists = Object.keys(o.table || {}).length > 0;
  if (exists !== !isNew) {
    try { await client.discard({ unit, draftId: o.draftId }); } catch (e) { /* best-effort */ }
    return { ok: false, error: exists ? "unit-exists" : "unknown-unit", unit };
  }
  // From here the server-side draft exists, so any failure below must both undo what we
  // wrote to disk and tell the server to drop the orphan — otherwise a retry finds a
  // half-materialised folder (`folder-not-empty`) and the draft it opened is never freed.
  try {
    fs.mkdirSync(dir, { recursive: true });
    await materialise(client, unit, o.table, dir);
    // `table` is what the DRAFT last saved (the per-file bases a save is checked against);
    // `baseTable` is what MAIN held at the draft's base revision (what a sync merges from).
    const state = { origin, space, unit, address: o.address, draftId: o.draftId, session, baseRevision: o.baseRevision, draftRevision: 0, table: o.table, baseTable: o.table, openedAt: now };
    writeState(dir, state);
    registryAdd({ dir, unit, draftId: o.draftId, origin, openedAt: now });
  } catch (err) {
    // When we created `dir` ourselves, the whole thing is ours to remove. When it
    // pre-existed, the empty-folder check above guarantees everything under it now is
    // ALSO ours (nothing else can have written there since) — so every entry goes, not
    // just the ones named in `o.table`, leaving the pre-existing folder itself in place.
    if (createdFolder) fs.rmSync(dir, { recursive: true, force: true });
    else for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    try { await client.discard({ unit, draftId: o.draftId }); } catch (e) { /* best-effort */ }
    throw err;
  }
  const others = (o.presence || []).filter((d) => d.id !== o.draftId);
  return { ok: true, draftId: o.draftId, address: `${origin}${o.address}`, files: Object.keys(o.table).length, others, isNew: !exists };
}

async function doSaveImpl({ client, dir, baseRevision, baseTable }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const local = scanFolder(dir);
  const changes = changesBetween(st.unit, st.table, local);
  if (!changes.length && baseRevision === undefined) return { ok: true, changed: [], draftRevision: st.draftRevision };
  for (const c of changes) if (!c.delete) await client.blobPut(c.h, fs.readFileSync(path.join(dir, relOf(st.unit, c.path))));
  const r = await client.save({ unit: st.unit, draftId: st.draftId, draftRevision: st.draftRevision, changes, ...(baseRevision !== undefined ? { baseRevision } : {}) });
  if (r.status) return { ok: false, ...r };
  // A caller mid-sync (`doSyncImpl`) hands its advanced `baseTable` in here rather than
  // writing state itself, so the whole revision — `draftRevision`, `table`, `baseRevision`
  // and `baseTable` — lands in the ONE `writeState` below, only once the server has
  // actually accepted the save. A failure anywhere above this line leaves the file on disk
  // byte-identical to before the call, whatever advanced state a caller was carrying.
  st.draftRevision = r.draftRevision; st.table = r.table;
  if (baseRevision !== undefined) st.baseRevision = baseRevision;
  if (baseTable !== undefined) st.baseTable = baseTable;
  writeState(dir, st);
  return { ok: true, changed: changes.map((c) => relOf(st.unit, c.path)), draftRevision: r.draftRevision };
}

async function doLandImpl({ client, dir, note }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const saved = await doSave({ client, dir });
  if (!saved.ok) return saved;
  // Every landing in a space writes the one manifest by compare-and-set, so eight agents
  // landing eight prototypes in the same second contend on it. The server retries a few
  // times and then answers `manifest-contended`; that is a moment, not a refusal — the
  // draft is still open, its lease released — so this side lands again, with a little
  // jitter, before telling anyone. Measured live: 8 parallel landings, 2 contended.
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await client.land({ unit: st.unit, draftId: st.draftId, baseRevision: st.baseRevision, note: note || "" });
    if (r.error !== "manifest-contended" || attempt >= LAND_RETRIES) break;
    await new Promise((res) => setTimeout(res, 150 + Math.random() * 400 * (attempt + 1)));
  }
  if (r.status) return { ok: false, ...r };
  st.landed = true; st.landedRevision = r.revision;
  writeState(dir, st);
  registryRemove(dir);
  // `recorded: false` means the bytes are live and the history entry is not — the server
  // wrote the manifest and could not tell the unit's object about it. Carried through so
  // the command can say so; the landing itself happened either way.
  return { ok: true, url: r.url, revision: r.revision, version: r.version,
    recorded: r.recorded !== false, warning: r.warning || null };
}

async function doSyncImpl({ client, dir }) {
  const st = readState(dir);
  if (!st) return { ok: false, error: "not-a-draft", dir };
  const r = await client.sync({ unit: st.unit, draftId: st.draftId });
  if (r.status) return { ok: false, ...r };
  const local = scanFolder(dir);
  const baseTable = st.baseTable || {};
  const nextBase = { ...baseTable };
  const taken = [], merged = [], conflicts = [], kept = [];
  const isText = (ct) => /^text\//.test(ct) || /javascript|json|svg/.test(ct);
  for (const c of r.changed) {
    const rel = relOf(st.unit, c.path);
    const base = baseTable[c.path] || null;             // what main held when this draft was based
    nextBase[c.path] = { h: c.h, ct: c.ct, s: c.s };
    if (base && base.h === c.h) continue;                // main's file is what my base already had
    const mine = local[rel] || null;
    const theirBytes = await client.blobGet(c.h);
    const dest = path.join(dir, rel);
    if (!mine && base) {                                  // absent locally but the base had it: I deleted it.
      // main changed it too (we would have `continue`d above otherwise) — that's a real
      // conflict, not a resurrection: leave the file gone, drop theirs beside it.
      // `nextBase[c.path]` above already advanced to main's version despite the conflict staying open, so a later land is possible once the agent has decided; landing without deciding lands the draft's table (this file absent) as it stands.
      writeTheirs(dir, rel, theirBytes);
      conflicts.push({ rel, hunks: [], deleted: true });
      continue;
    }
    if (!mine || (base && mine.h === base.h)) {          // new on main, or I did not touch it: take theirs
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, theirBytes);
      taken.push(rel);
      continue;
    }
    if (mine.h === c.h) { kept.push(rel); continue; }    // we made the same change
    if (!base || !isText(c.ct)) {                        // no common base, or binary: theirs beside, mine stays
      writeTheirs(dir, rel, theirBytes); conflicts.push({ rel, hunks: [] }); continue;
    }
    const baseBytes = await client.blobGet(base.h);
    const m = merge3(baseBytes.toString("utf8"), fs.readFileSync(dest, "utf8"), theirBytes.toString("utf8"));
    if (m.ok) { fs.writeFileSync(dest, m.text); merged.push(rel); }
    else { writeTheirs(dir, rel, theirBytes); conflicts.push({ rel, hunks: m.conflicts }); }
  }
  for (const p of r.removed) {
    const rel = relOf(st.unit, p);
    const base = baseTable[p], mine = local[rel];
    delete nextBase[p];
    if (mine && base && mine.h === base.h) { fs.rmSync(path.join(dir, rel), { force: true }); taken.push(rel); }
    else if (mine) kept.push(rel);
  }
  // The draft is now based on main's current revision. Do not write that here: hand
  // `nextBase` to `doSave` and let it land in the SAME `writeState` the trailing save
  // already does after the server accepts it — a save that fails on the network must
  // leave `.augur/draft.json` exactly as it was before this sync, not holding an advanced
  // `baseTable` alongside a stale `table`/`baseRevision`.
  const saved = await doSave({ client, dir, baseRevision: r.mainRevision, baseTable: nextBase });
  if (!saved.ok) return saved;
  return { ok: true, mainRevision: r.mainRevision, taken, merged, kept, conflicts };
}

function writeTheirs(dir, rel, bytes) {
  const dest = path.join(dir, THEIRS_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
}

async function doCloseImpl({ client, dir, discard }) {
  const st = readState(dir);
  if (!st) {
    // A read-only copy has no state file; the registry is what says it is ours to remove.
    const copy = registryList().find((e) => e.readOnly && path.resolve(e.dir) === path.resolve(dir));
    if (!copy) return { ok: false, error: "not-a-draft", dir };
    registryRemove(copy.dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, readOnly: true };
  }
  if (!st.landed && !discard) return { ok: false, error: "draft-still-open", draftId: st.draftId, address: st.address };
  if (!st.landed && discard) {
    const r = await client.discard({ unit: st.unit, draftId: st.draftId });
    if (r.status && r.status !== 404) return { ok: false, ...r };
  }
  registryRemove(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, discarded: !st.landed };
}

// ── read-only copies (§7 `read`) ─────────────────────────────────────────────
// A unit materialised for CONTEXT, not for editing: beside the draft folders under `_read/`,
// files with no write bit, and a registry row the deny hook reads so an editor that ignores
// the mode is refused with the reason. No `.augur/draft.json` — a copy is not a draft.
export const READ_DIR = "_read";
export const readDirFor = (unit) => path.join(READ_DIR, ...unit.split("/").filter(Boolean));

async function doReadImpl({ client, unit, dir, origin, now }) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { ok: false, error: "folder-not-empty", dir };
  const m = await client.main(unit);
  if (m.status) return { ok: false, ...m };
  fs.mkdirSync(dir, { recursive: true });
  await materialise(client, unit, m.table || {}, dir);
  for (const p of Object.keys(m.table || {})) fs.chmodSync(path.join(dir, relOf(unit, p)), 0o444);
  registryAdd({ dir, unit, origin, readOnly: true, openedAt: now, revision: m.revision });
  return { ok: true, dir, files: Object.keys(m.table || {}).length, revision: m.revision };
}

// ── the watch loop (§7 `watch`) ──────────────────────────────────────────────
// For people editing by hand in an editor that runs no hooks: every burst of changes is one
// save. `fs.watch` with `recursive` is what every platform this repo supports offers; the
// state file's own writes are ignored or a save would trigger the next.
export function watchFolder(dir, onSettle, { debounceMs = 300 } = {}) {
  let timer = null;
  const watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
    const rel = String(name || "");
    if (rel === ".augur" || rel.startsWith(".augur" + path.sep) || rel.startsWith(".augur/")) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onSettle(); }, debounceMs);
  });
  return { close() { clearTimeout(timer); watcher.close(); } };
}

// ── does the instance serve drafts at all (§10) ───────────────────────────────
// Read from the public well-known file, so it needs no token and answers before anything
// is committed or built. False on ANY failure: an instance that cannot be asked is treated
// as one that does not serve drafts, which is the path that already works everywhere.
export async function draftsServed(origin, { timeoutMs = 2500 } = {}) {
  if (!origin) return false;
  try {
    const r = await fetch(`${String(origin).replace(/\/+$/, "")}/.well-known/augur.json`, {
      signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" },
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.drafts && j.drafts.enabled === true);
  } catch (e) { return false; }
}

// ── what is open on this machine (§4 `status`) ───────────────────────────────
export function draftsReport(entries, presenceByUnit = {}) {
  const out = [];
  for (const e of entries || []) {
    if (!e || e.readOnly) continue;
    out.push(`${e.unit.replace(/^\/|\/$/g, "")}  draft ${e.draftId}  ${e.dir}`);
    for (const d of presenceByUnit[e.unit] || []) {
      if (d.id === e.draftId) continue;
      out.push(`    also here: ${d.name ? d.name + " · " : ""}${d.session || "someone"} (${d.active ? "active" : "idle"})`);
    }
  }
  return out;
}

// Each verb's public surface is its body wrapped in `guarded` — see the comment above
// `guarded` itself. Internal callers (`doLandImpl` → `doSave`, `doSyncImpl` → `doSave`) go
// through the same wrapped export, so a blob failure partway through a land or a sync comes
// back as the same `{ok: false, error: "network"}` shape a bare save would return.
export const doOpen = guarded(doOpenImpl);
export const doSave = guarded(doSaveImpl);
export const doLand = guarded(doLandImpl);
export const doSync = guarded(doSyncImpl);
export const doClose = guarded(doCloseImpl);
export const doRead = guarded(doReadImpl);
