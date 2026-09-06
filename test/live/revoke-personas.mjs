#!/usr/bin/env node
// revoke-personas.mjs — leave no credential behind: put the owner back on the roster just
// long enough to revoke every token the suite minted through the admin route, remove the
// other three people through the admin operation (which revokes as it goes), then take the
// owner off again. Verifies each cached token answers a refusal afterwards.
//
// Also cleans up what the `invited` variant leaves that nothing else knows about: the
// invitee themself (a real admin invite, never the roster-overlay shortcut `roster.mjs`
// uses — see env.mjs's ROSTER_PERSONAS) and the start-here page the platform landed for
// them, which — like a stray `new`-variant prototype — has no unit verb to remove it.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORIGIN, PERSONAS, addressOf, workDir, STAR, SPACE } from "./env.mjs";
import { human } from "./persona.mjs";
import { personIdFor } from "../../src/purge.mjs";

const ROSTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "roster.mjs");
const box = process.env.LIVE_MAILBOX; const [local, dom] = box.split("@");
const ours = (label) => String(label || "").startsWith(local + "+") && String(label || "").endsWith("@" + dom);

/**
 * Take one member's start-here page out of the live manifest. No unit verb removes a
 * unit — the same recipe the skill documents for a stray `new`-variant prototype:
 * re-commit the space's manifest without its files, drop the fields the store owns
 * (`version`/`publishedAt`/`publishedBy`), and ask for the removal explicitly
 * (`allowUnpublish`) since the unpublish guard would otherwise refuse it.
 */
async function removeStartHerePage(email) {
  const space = SPACE();
  const headers = { Authorization: `Bearer ${STAR()}` };
  const unit = `/start-here/${personIdFor(email)}/`;
  const r = await fetch(`${ORIGIN()}/__publish/${encodeURIComponent(space)}/manifest`, { headers });
  if (!r.ok) return { skipped: true, why: `manifest read: ${r.status}` };
  const manifest = await r.json();
  const before = Object.keys(manifest.files || {}).length;
  const files = Object.fromEntries(Object.entries(manifest.files || {}).filter(([p]) => !p.startsWith(unit)));
  if (Object.keys(files).length === before) return { present: false };
  const { version, publishedAt, publishedBy, ...rest } = manifest;
  const body = { ...rest, files, baseVersion: version, allowUnpublish: true, clientProtocol: 5 };
  const cr = await fetch(`${ORIGIN()}/__publish/${encodeURIComponent(space)}/commit`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await cr.json().catch(() => ({}));
  return { present: true, removed: cr.ok, status: cr.status, version: out.version, error: out.error };
}

execFileSync(process.execPath, [ROSTER, "add"], { env: process.env, stdio: "pipe" });
const owner = await human("owner");
const list = await owner.json("/__admin/tokens", null, "GET");
const mine = Object.entries(list.tokens || {}).filter(([, t]) => ours(t.label));
console.log(`suite tokens on the workspace: ${mine.length}`);
for (const [hash, t] of mine) {
  const r = await owner.json("/__admin/tokens", { hash }, "DELETE");
  console.log(`  revoke ${t.space} ${t.label.replace(local, "<qa>")}: ${r.status}`);
}
for (const p of ["editor", "editor2", "viewer"]) {
  const r = await owner.admin({ op: "remove", email: addressOf(p) });
  console.log(`  admin remove ${p}: ${r.status}`);
}
// The `invited` variant's person: may or may not exist, depending on whether that
// variant has run since the last cleanup. Both calls are safe to make unconditionally —
// an absent member or unit answers a harmless "not found" shape, never a throw.
{
  const r = await owner.admin({ op: "remove", email: addressOf("invitee") });
  console.log(`  admin remove invitee: ${r.status}`);
  const page = await removeStartHerePage(addressOf("invitee"));
  console.log(`  start-here page for invitee: ${JSON.stringify(page)}`);
}
execFileSync(process.execPath, [ROSTER, "remove"], { env: process.env, stdio: "pipe" });
for (const p of Object.keys(PERSONAS)) {
  const f = path.join(workDir("tokens"), `${p}.json`);
  if (!fs.existsSync(f)) continue;
  const { token } = JSON.parse(fs.readFileSync(f, "utf8"));
  const r = await fetch(`${ORIGIN()}/__unit/drafts`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`  ${p} cached token now: ${r.status}`);
}
const again = await owner.json("/__admin/tokens", null, "GET");
console.log(`owner cookie after own removal: ${again.status}`);
