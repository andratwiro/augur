#!/usr/bin/env node
/**
 * augur bundle-rekey — move a live workspace's published content onto the workspace
 * segment, one page at a time, without an account credential.
 *
 *   augur bundle-rekey                          what WOULD move (a dry run; the default)
 *   augur bundle-rekey --confirm <workspace>    move it
 *   augur bundle-rekey --confirm <ws> --families spaces,config,assets
 *
 * `B-bundle-store-tenancy`. The store's keys now carry the workspace on a deployment that
 * resolves one from the Host (`bundleKey` in src/_worker.js). A deployment that starts
 * WRITING `t/<workspace>/…` does not thereby start reading what it wrote yesterday: the
 * unprefixed keys stay where they are, and there is deliberately no read-through fallback
 * to them, because an unprefixed key on a shared bucket belongs to whichever workspace the
 * deployment served before the segment existed and nothing in the key says which. So a
 * live workspace is MOVED, and this is the command that moves it.
 *
 * WHY THIS IS NOT `augur migrate`, and it is structural rather than a missing flag.
 * `migrate` is origin-addressed — it writes INTO a workspace over `/__publish/*` and cannot
 * name a key — and a restore lands every space at v1, so re-keying by exporting and
 * restoring into the same workspace would strand the whole version history under the old
 * prefix and start the new one at one. `rollback` would then reach nothing. This copies
 * KEYS, so the history comes with it.
 *
 * ⚠️ IT IS A COPY AND NEVER A CUT. Nothing is deleted. That is what makes it safe to
 * interrupt, safe to re-run, and what keeps `BUNDLE_TENANCY`'s per-family flag a revert:
 * flip the word back and the unprefixed answer is still there. Reclaiming the originals is
 * a separate act for after somebody has looked.
 *
 * ⚠️ IT IS CORRECT FOR EXACTLY ONE WORKSPACE PER DEPLOYMENT, and the worker refuses rather
 * than trusting this script about it: a bucket that already holds a second workspace prefix
 * answers `not-the-only-workspace`, because there the unprefixed keys cannot be said to be
 * anybody's.
 *
 * WHAT DOES NOT MOVE, and must not: `blobs/` and `spaces/_engine/`. Both are shared across
 * every workspace on the deployment by decision — the blob namespace is content-addressed
 * and deduplicated, the engine chrome is one build serving everyone — so both are already
 * at the key every workspace reads them at. The run reports them as `shared`.
 *
 * RUN IT BEHIND A FREEZE (`augur freeze`). `/__publish/` writes are refused while frozen and
 * the `_state/*` routes are exempt, so a re-key runs with no publish racing it. Reads and
 * sign-in are unaffected, so the site stays up for the whole move.
 *
 * Exit 0 when the move is complete (or was already), 1 on a refusal.
 */
import { target, apiClient } from "./lib/store.mjs";

const log = (m) => console.error(`\x1b[36m[bundle-rekey]\x1b[0m ${m}`);
const die = (m) => { log(m); process.exit(1); };

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const CONFIRM = opt("--confirm");
const FAMILIES = (opt("--families") || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_PAGES = Number(opt("--max-pages")) > 0 ? Number(opt("--max-pages")) : 200;

let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }
const req = apiClient(origin, token);

const call = async (body) => {
  const res = await req("_state/rekey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let out;
  try { out = await res.json(); } catch (e) { die(`${origin} answered ${res.status} with something that is not JSON`); }
  if (!out.ok) {
    if (out.reason === "not-the-only-workspace") {
      die(`${origin} refused: this bucket already holds another workspace (${(out.others || []).join(", ")}).`
        + ` An unprefixed key there belongs to nobody in particular, so nothing may claim it.`);
    }
    if (out.reason === "confirm-mismatch") die(`${origin} refused: --confirm must be "${out.expected}"`);
    die(`${origin} refused: ${out.reason}`);
  }
  return out;
};

const base = { ...(FAMILIES.length ? { families: FAMILIES } : {}) };

// The dry run always happens, confirmed or not: the number it prints is what the caller
// gets to check before anything is written, and after a real run it is the receipt.
const plan = await call(base);
if (plan.reason === "no-segment") {
  log(`${origin} serves one workspace and writes no segment — there is nothing to move.`);
  process.exit(0);
}
log(`${origin} — workspace ${plan.workspace} → ${plan.segment}`);
log(`families ${plan.families.join(", ")}; ${plan.considered} object(s) considered, `
  + `${plan.skipped} already there, ${plan.shared} deliberately shared (blobs/ and spaces/_engine/)`);

if (!CONFIRM) {
  const left = plan.copied + plan.pending;
  if (!left) { log("\x1b[32mnothing to move\x1b[0m — this workspace is already on the segment"); process.exit(0); }
  log(`\x1b[33mwould copy ${left} object(s)\x1b[0m`);
  for (const k of plan.keys) console.log(`  ${k}`);
  if (plan.keys.length < left) console.log(`  … and ${left - plan.keys.length} more`);
  console.log("\x1b[2mre-run with --confirm <workspace> to move them; nothing is ever deleted\x1b[0m");
  process.exit(0);
}

let copied = 0, bytes = 0, pages = 0;
for (;;) {
  const out = await call({ ...base, confirm: CONFIRM });
  copied += out.copied; bytes += out.bytes; pages++;
  if (out.copied) log(`page ${pages}: ${out.copied} copied (${(bytes / 1e6).toFixed(2)} MB so far)`);
  if (out.done) break;
  if (pages >= MAX_PAGES) die(`stopped after ${MAX_PAGES} pages with work left — re-run to continue`);
}
log(`\x1b[32mdone\x1b[0m — ${copied} object(s) copied, ${(bytes / 1e6).toFixed(2)} MB`);
console.log("\x1b[2mthe originals are untouched: this is a copy, and it is what the per-family revert reads\x1b[0m");
