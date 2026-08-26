#!/usr/bin/env node
// state-inventory — the inventory stays true, or the build stops.
//
// WHY. `scripts/lib/state-inventory.mjs` is the authoritative map from every stored key to
// where it goes in the migration off shared KV. A list like that rots by default: five
// families appeared between its first draft and its second reading, and nothing caught
// them. A family nobody remembers is a family nobody exports, and the first anyone hears
// of it is a workspace arriving on its new home missing something.
//
// TWO MODES, because the two questions are different and only one of them can run in CI.
//
//   SOURCE (default, and what `check` runs). Every key-shaped constant and every literal
//   handed to a store call in the engine must be accounted for, and every inventory entry
//   must still appear in the source. No credentials, so it runs anywhere — and it catches
//   the rot that actually happens, which is somebody adding a family in code.
//
//   LIVE (`--live <file>`). Every key on a real instance must be accounted for. This is
//   the one the plan item asks for and it needs a KV listing, which needs an account
//   credential CI does not have:
//
//     npx wrangler kv key list --namespace-id <id> --remote > /tmp/keys.json
//     node scripts/state-inventory.mjs --live /tmp/keys.json
//
//   Run it before a migration, not on a schedule. What it finds that the source scan
//   cannot is a key written by something that is no longer in the engine at all.
//
// WHAT THIS IS NOT: a parser. It reads literals, so a key assembled at runtime from pieces
// it cannot see is a key it cannot see either — the same floor `wrangler-preflight.mjs`
// stands on, and stated for the same reason. The LIVE mode is what closes that gap.
//
// Usage: node scripts/state-inventory.mjs [--live <file>] [--print] [--quiet]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_INVENTORY, accountsFor, inventoryEntry } from "./lib/state-inventory.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCES = ["src/_worker.js", "src/mail.mjs"];

const argv = process.argv.slice(2);
const quiet = argv.includes("--quiet");
const liveArg = argv[argv.indexOf("--live") + 1];
const live = argv.includes("--live") ? liveArg : null;

/**
 * Every key-ish literal the engine names, as a set.
 *
 * Four shapes, and only four, because each is a place a key can be WRITTEN DOWN:
 *   · a module-scope `const SOMETHING_KEY = "…"` or `_PREFIX`
 *   · a `doc: "…"` inside the overlay's family table
 *   · a string handed straight to a store call
 *   · a template handed straight to a store call, with its holes blanked
 * Anything else is a key built out of pieces, which the live mode is for.
 */
export function keysInSource(text) {
  const found = new Map(); // literal -> the line it was found on
  const add = (lit, line) => { if (lit && !found.has(lit)) found.set(lit, line); };
  const lineOf = (idx) => text.slice(0, idx).split("\n").length;

  for (const m of text.matchAll(/^const\s+([A-Z0-9_]*_(?:KEY|PREFIX))\s*=\s*"([^"]+)"/gm)) {
    add(m[2], lineOf(m.index));
  }
  for (const m of text.matchAll(/^export const\s+([A-Z0-9_]*_(?:KEY|PREFIX))\s*=\s*"([^"]+)"/gm)) {
    add(m[2], lineOf(m.index));
  }
  for (const m of text.matchAll(/\bdoc:\s*"([^"]+)"/g)) {
    // The overlay family table stores the document NAME; the keys it composes are
    // `<doc>:<something>`, so record the prefix form the inventory carries.
    add(m[1] + ":", lineOf(m.index));
    add(m[1], lineOf(m.index));
  }
  // The receiver has to be a STORE, or this reads every header name and query parameter in
  // the file: `headers.get("Cookie")` is the same call shape as `kv.get("statuses")`.
  // These four names are what the engine calls its stores, and a fifth would be caught by
  // the live mode rather than silently skipped.
  const RECEIVER = String.raw`(?:kv|r2|bundles|env\.BUNDLES|env\.COMMENTS)`;
  for (const m of text.matchAll(new RegExp(RECEIVER + String.raw`\.(?:get|put|delete|head|getWithMetadata)\(\s*"([^"]+)"`, "g"))) {
    add(m[1], lineOf(m.index));
  }
  for (const m of text.matchAll(new RegExp(RECEIVER + String.raw`\.(?:get|put|delete|head|getWithMetadata)\(\s*` + "`([^`]+)`", "g"))) {
    add(m[1].replace(/\$\{[^}]*\}/g, "*"), lineOf(m.index));
  }
  for (const m of text.matchAll(new RegExp(RECEIVER + String.raw`\.list\(\{\s*prefix:\s*` + "[`\"]([^`\"]+)[`\"]", "g"))) {
    add(m[1].replace(/\$\{[^}]*\}/g, "*"), lineOf(m.index));
  }
  for (const m of text.matchAll(/const\s+\w+\s*=\s*`([a-z][a-z0-9:_-]*:)\$\{/g)) {
    // `const sentKey = \`rebake:sent:${id}\`` — a prefix written as a template.
    add(m[1], lineOf(m.index));
  }
  return found;
}

/**
 * The inventory entries a literal accounts for — plural, because one literal can.
 *
 * A trailing colon is not a distinction: `statuses` and `statuses:` are the same family
 * written two ways, and the overlay's family table writes the second. A DOCUMENT NAME
 * covers every key under it, which is how `pt` accounts for both `pt:view` and
 * `pt:remarks`. And a composed key (`spaces/*​/manifest.json`) belongs to its prefix.
 */
function accountedBy(lit) {
  const star = lit.indexOf("*");
  const head = star === -1 ? lit : lit.slice(0, star);
  const bare = head.replace(/:$/, "");
  const out = new Set();
  for (const f of [lit, head, lit.replace(/:$/, ""), bare, bare + ":"]) {
    const direct = inventoryEntry(f);
    if (direct) out.add(direct.id);
  }
  // A document name ALSO stands for every key beneath it, and it can do both at once:
  // `pins` is a document AND a prefix, because a signed-out visitor's pins live under the
  // bare name while everybody else's live under `pins:<address>`. Collecting both is what
  // stops the second one being reported as an entry nothing names.
  for (const e of STATE_INVENTORY) if (e.id.startsWith(bare + ":")) out.add(e.id);
  if (out.size) return [...out];
  const covering = accountsFor(head);
  return covering ? [covering.id] : [];
}

const problems = [];

if (live) {
  const raw = fs.readFileSync(live === "-" ? 0 : live, "utf8");
  let keys;
  try {
    const doc = JSON.parse(raw);
    keys = (Array.isArray(doc) ? doc : doc.result || []).map((k) => (typeof k === "string" ? k : k.name));
  } catch (e) {
    keys = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  if (!keys.length) {
    console.error("state-inventory: that listing is empty — a vacuous pass is not a pass");
    process.exit(2);
  }
  const unaccounted = new Map();
  for (const k of keys) {
    if (accountsFor(k)) continue;
    // Report the SHAPE, not every key: a thousand orphans under one prefix is one problem.
    const shape = k.replace(/[0-9a-f]{8,}/gi, "<hash>").replace(/[^:/]+@[^:/]+/g, "<address>");
    unaccounted.set(shape, (unaccounted.get(shape) || 0) + 1);
  }
  for (const [shape, n] of unaccounted) {
    problems.push(`live key not in the inventory: ${shape}${n > 1 ? ` (${n} of them)` : ""}`);
  }
  if (!problems.length && !quiet) {
    console.log(`state-inventory: OK — all ${keys.length} live key(s) are accounted for`);
  }
} else {
  const seen = new Set();
  for (const rel of SOURCES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const [lit, line] of keysInSource(fs.readFileSync(abs, "utf8"))) {
      const ids = accountedBy(lit);
      if (!ids.length) {
        problems.push(`${rel}:${line}: "${lit}" is not in the inventory. Add it to scripts/lib/state-inventory.mjs with a destination and a reason — including "not a store key", if that is what it is.`);
        continue;
      }
      for (const id of ids) seen.add(id);
    }
  }
  // And the other direction: an entry nothing names any more is an entry to delete, or a
  // family that quietly stopped being written and is about to be forgotten.
  for (const e of STATE_INVENTORY) {
    if (!seen.has(e.id)) {
      problems.push(`the inventory lists "${e.id}" but nothing in the engine names it. Delete the entry, or find out what stopped writing it.`);
    }
  }
  if (!problems.length && !quiet) {
    console.log(`state-inventory: OK — ${STATE_INVENTORY.length} entries, every one named by the engine and every named key accounted for`);
  }
}

if (argv.includes("--print")) {
  const w = Math.max(...STATE_INVENTORY.map((e) => e.id.length));
  for (const e of STATE_INVENTORY) {
    console.log(`${e.id.padEnd(w)}  ${e.store.padEnd(4)} ${e.kind.padEnd(6)} → ${e.to}`);
  }
}

if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  console.log(`\n${problems.length} problem(s). The inventory is the migration's only complete list of what exists; a family missing from it is a family nobody exports.`);
  process.exit(1);
}
