#!/usr/bin/env node
/**
 * augur identity-rekey — move a live workspace's IDENTITY documents onto the workspace
 * segment, without an account credential.
 *
 *   augur identity-rekey                        what WOULD move (a dry run; the default)
 *   augur identity-rekey --confirm <workspace>  move it
 *   augur identity-rekey --confirm <ws> --families roster,publishTokens
 *
 * `B-identity-kv-write-segmentation`. The roster, the roles, the display names, the
 * avatars, the icons, the invites, the last-seen stamps and the publish tokens now carry
 * the workspace on a deployment that resolves one from the Host (`identityKey` in
 * src/_worker.js). A deployment that starts WRITING `t/<workspace>/users:roster` does not
 * thereby start reading what it wrote yesterday, and there is deliberately no read-through
 * to the unsegmented key: it belongs to whichever workspace this deployment served before
 * the segment existed, and nothing in the key says which. So a live workspace is MOVED,
 * and this is the command that moves it.
 *
 * ⚠️ THE TWIN OF `augur bundle-rekey`, AND A SEPARATE COMMAND ON PURPOSE. That one asks
 * "is my published content where I read it"; this one asks "is my roster". An operator
 * moving content must not silently move the login gate's documents in the same breath,
 * and the two have different things to check afterwards.
 *
 * ⚠️ IT IS A COPY AND NEVER A CUT, and here that matters more than it does for content:
 * the unsegmented documents are what a per-family revert READS. Flip one word in
 * `IDENTITY_TENANCY` back with the sources deleted and the revert is a rollback to the day
 * of the cut, with everybody minted since gone.
 *
 * ⛔ `users:secrets` DOES NOT MOVE, because it is not segmented. A credential is
 * account-level — one address, one password, several workspaces — and it belongs to
 * `B-cross-workspace-signin`.
 *
 * ⚠️ IT IS CORRECT FOR EXACTLY ONE WORKSPACE PER DEPLOYMENT, and the worker refuses rather
 * than trusting this script about it: a deployment already holding a second workspace
 * answers `not-the-only-workspace`.
 *
 * RUN IT BEHIND A FREEZE (`augur freeze`). The `_state/*` routes are exempt from the
 * freeze, so the move runs with no identity write racing it; reads and sign-in are
 * unaffected, so the site stays up.
 *
 * ⚠️ AFTERWARDS, GIVE KV A MINUTE BEFORE BELIEVING A READ. A `kv.get` through the worker
 * is cached for up to sixty seconds, so a key written by this command can answer as
 * missing for that long — which reads exactly like a broken move. Re-check past the minute
 * before concluding anything, or read the namespace directly.
 *
 * Exit 0 when the move is complete (or was already), 1 on a refusal.
 */
import { target, apiClient } from "./lib/store.mjs";

const log = (m) => console.error(`\x1b[36m[identity-rekey]\x1b[0m ${m}`);
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
  const res = await req("_state/identity-rekey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let out;
  try { out = await res.json(); } catch (e) { die(`${origin} answered ${res.status} with something that is not JSON`); }
  if (!out.ok) {
    if (out.reason === "not-the-only-workspace") {
      die(`${origin} refused: this deployment already holds another workspace (${(out.others || []).join(", ")}).`
        + ` An unsegmented identity document there belongs to nobody in particular, so nothing may claim it.`);
    }
    if (out.reason === "confirm-mismatch") die(`${origin} refused: --confirm must be "${out.expected}"`);
    if (out.reason === "unknown-family") die(`${origin} refused: no such family (${(out.unknown || []).join(", ")})`);
    die(`${origin} refused: ${out.reason}`);
  }
  return out;
};

const base = { ...(FAMILIES.length ? { families: FAMILIES } : {}) };

const plan = await call(base);
if (plan.reason === "no-segment") {
  log(`${origin} serves one workspace and writes no segment — there is nothing to move.`);
  process.exit(0);
}
log(`${origin} — workspace ${plan.workspace} → ${plan.segment}`);
log(`families ${plan.families.join(", ")}; ${plan.considered} document(s) considered, ${plan.skipped} already there`);

if (!CONFIRM) {
  const left = plan.copied + plan.pending;
  if (!left) { log("\x1b[32mnothing to move\x1b[0m — this workspace is already on the segment"); process.exit(0); }
  log(`\x1b[33mwould copy ${left} document(s)\x1b[0m`);
  for (const k of plan.keys) console.log(`  ${k}`);
  if (plan.keys.length < left) console.log(`  … and ${left - plan.keys.length} more`);
  console.log("\x1b[2mre-run with --confirm <workspace> to move them; nothing is ever deleted\x1b[0m");
  process.exit(0);
}

let copied = 0, bytes = 0, pages = 0;
for (;;) {
  const out = await call({ ...base, confirm: CONFIRM });
  copied += out.copied; bytes += out.bytes; pages++;
  if (out.copied) log(`page ${pages}: ${out.copied} copied (${(bytes / 1e3).toFixed(1)} kB so far)`);
  if (out.done) break;
  if (pages >= MAX_PAGES) die(`stopped after ${MAX_PAGES} pages with work left — re-run to continue`);
}
log(`\x1b[32mdone\x1b[0m — ${copied} document(s) copied, ${(bytes / 1e3).toFixed(1)} kB`);
console.log("\x1b[2mthe originals are untouched: this is a copy, and it is what the per-family revert reads\x1b[0m");
