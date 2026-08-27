#!/usr/bin/env node
/**
 * migrate-board-keys — give every board document in a KV namespace its workspace segment.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… AUGUR_KV_NS=… \
 *     node scripts/migrate-board-keys.mjs --workspace <id> [--apply] [--json]
 *
 * A ONE-SHOT, and the least important half of the change it belongs to. `board:<path>`
 * becomes `board:<workspace>:<path>` on the deploy that moves an instance's canvas rooms
 * into its own worker; the worker READS THROUGH on a miss and writes the document back
 * scoped, so every board migrates itself the first time anybody opens it and nothing is
 * ever unreachable. What this script buys is that the migration finishes for the boards
 * nobody opens — a board read once a quarter would otherwise keep a legacy key alive
 * indefinitely, and the fallback can only be retired when nothing depends on it.
 *
 * ⚠️ DRY RUN IS THE DEFAULT. Writing needs `--apply`, spelled out, because the destination
 * is a live namespace and the failure mode is silent: a wrong `--workspace` writes every
 * board under a name nothing resolves to, and the site keeps working (the read-through
 * still finds the legacy key) while a second, stale copy of every board accumulates.
 *
 * IT COPIES AND DOES NOT DELETE, on purpose. The legacy key is left exactly where it is:
 * rolling the deploy back has to leave the boards reachable, and a migration that has
 * removed the thing it migrated is not reversible. Sweeping the legacy keys is a separate
 * decision for a separate day, once the read-through has been off for longer than anyone's
 * memory of a board.
 *
 * WHAT IT REPORTS, and why the numbers are the point:
 *   scanned    legacy `board:` keys found (a scoped key is not one)
 *   identical  already present at the scoped key with the SAME bytes — nothing to do
 *   differing  present at the scoped key with DIFFERENT bytes — SKIPPED and named. The
 *              scoped copy is the newer one by construction (only the current code writes
 *              it), so overwriting it with the legacy document would revert a live board.
 *   copied     written (or, on a dry run, would be)
 *
 * A dry run that reports `differing: 0` is the acceptance test: it says the batch is a pure
 * addition, that no board is about to be reverted, and that the read-through and the direct
 * path resolve the same bytes for every board in the namespace.
 *
 * Values are copied VERBATIM as bytes — never parsed, never re-serialised. A board document
 * is JSON today and a migration that parses is a migration that fails on the one document
 * that is not what it expected.
 */
import { BOARD_PREFIX, boardKvKey } from "../src/board-key.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const WORKSPACE = (opt("--workspace") || process.env.AUGUR_WORKSPACE || "").trim();
const APPLY = flag("--apply");
const JSON_OUT = flag("--json");

const ACC = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOK = process.env.CLOUDFLARE_API_TOKEN;
const NS = process.env.AUGUR_KV_NS || process.env.KV_NAMESPACE_ID || process.env.GV_KV_NS;

const log = (m) => console.error(`\x1b[36m[board-keys]\x1b[0m ${m}`);
const die = (m) => { log(`\x1b[31m${m}\x1b[0m`); process.exit(1); };

// Overridable so the whole run can be driven against a local stand-in: that a value comes
// off the wire and back onto it unchanged is exactly what cannot be proven by reading the
// code, and proving it must not need an account or a network.
const API_ROOT = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";

/**
 * The migration itself, over an interface of four calls, so the same code runs against the
 * REST API and against an in-memory namespace in the suite.
 *
 * `store` is `{ list(prefix) -> [names], get(name) -> ArrayBuffer|null, put(name, body) }`.
 */
export async function migrateBoardKeys(store, { workspace, apply = false, onProgress } = {}) {
  if (!workspace) throw new Error("a workspace id is required — the segment is what this writes");
  if (workspace.includes(":")) throw new Error("a workspace id may not contain ':' — it is the segment separator");
  const scopedPrefix = boardKvKey(workspace, "");
  const names = await store.list(BOARD_PREFIX);
  // A scoped key matches the legacy prefix too, so the legacy set is what is left after
  // this workspace's own scoped keys are taken out. Another workspace's scoped keys are
  // NOT excluded here and must not be: a namespace holding two workspaces' boards has
  // never had an unscoped key to migrate, so it will not reach this line with any.
  const legacy = names.filter((n) => n.startsWith(BOARD_PREFIX) && !n.startsWith(scopedPrefix));
  const out = { workspace, apply, scanned: legacy.length, identical: 0, differing: [], copied: [], vanished: [] };
  for (const name of legacy) {
    const path = name.slice(BOARD_PREFIX.length);
    const target = boardKvKey(workspace, path);
    const src = await store.get(name);
    if (src === null || src === undefined) { out.vanished.push(name); continue; }
    const dst = await store.get(target);
    if (dst !== null && dst !== undefined) {
      if (sameBytes(src, dst)) out.identical++;
      else out.differing.push(path);
      continue;
    }
    if (apply) await store.put(target, src);
    out.copied.push(path);
    if (onProgress) onProgress(path);
  }
  return out;
}

function sameBytes(a, b) {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** The REST-API namespace. Reads bytes, writes bytes. */
export function apiStore({ root = API_ROOT, account, namespace, token }) {
  const base = `${root}/accounts/${account}/storage/kv/namespaces/${namespace}`;
  const H = { authorization: `Bearer ${token}` };
  return {
    async list(prefix) {
      const names = [];
      let cursor = "";
      for (;;) {
        const url = `${base}/keys?limit=1000&prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await fetch(url, { headers: H });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.success) throw new Error(`list → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
        for (const k of j.result || []) names.push(k.name);
        cursor = (j.result_info && j.result_info.cursor) || "";
        if (!cursor) break;
      }
      return names;
    },
    async get(name) {
      const res = await fetch(`${base}/values/${encodeURIComponent(name)}`, { headers: H });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`get ${name} → ${res.status}`);
      return await res.arrayBuffer();
    },
    async put(name, body) {
      const res = await fetch(`${base}/values/${encodeURIComponent(name)}`, {
        method: "PUT", headers: H, body,
      });
      if (!res.ok) throw new Error(`put ${name} → ${res.status}`);
    },
  };
}

// ---- CLI --------------------------------------------------------------------
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("migrate-board-keys.mjs");
if (invokedDirectly) {
  if (!ACC || !TOK) die("need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID");
  if (!NS) die("need AUGUR_KV_NS — the namespace id this instance's worker is bound to");
  if (!WORKSPACE) die("need --workspace <id> — the segment to write. It is instance.json's tenantId, and getting it wrong writes a second copy of every board under a name nothing resolves to.");

  const store = apiStore({ account: ACC, namespace: NS, token: TOK });
  const res = await migrateBoardKeys(store, { workspace: WORKSPACE, apply: APPLY });

  if (JSON_OUT) console.log(JSON.stringify({ ...res, copied: res.copied.length, differing: res.differing }, null, 2));
  else {
    log(`${APPLY ? "APPLY" : "DRY RUN"} · workspace "${WORKSPACE}"`);
    log(`scanned ${res.scanned} legacy board keys`);
    log(`identical ${res.identical} · ${APPLY ? "copied" : "would copy"} ${res.copied.length} · vanished ${res.vanished.length}`);
    if (res.differing.length) {
      log(`\x1b[31mdiffering ${res.differing.length} — SKIPPED, the scoped copy is newer:\x1b[0m`);
      for (const p of res.differing.slice(0, 20)) log(`  ${p}`);
    } else log("differing 0 — every legacy board matches its scoped copy or has none");
  }
  // A run that skipped something is not a success: the operator has to look before the
  // read-through can be considered finished with.
  if (res.differing.length) process.exit(2);
}
