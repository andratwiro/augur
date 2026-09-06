#!/usr/bin/env node
// test/live/roster.mjs — put the suite's four people on the workspace roster, and take
// them off again.
//
//   node test/live/roster.mjs add      # export the state first (kept beside the work dir), then import
//   node test/live/roster.mjs remove   # import the roster overlay as it was before `add`
//   node test/live/roster.mjs show     # what the overlay holds now
//
// It writes the `users:roster` overlay through `/__publish/_state/import`, the same door
// the state restore uses, with a star token. The overlay is REPLACED by what is sent, so
// `add` merges the personas into what is there and `remove` restores the export taken
// before `add`. Nothing else in the workspace's state is sent.
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, STAR, PERSONAS, addressOf, workDir } from "./env.mjs";

const origin = ORIGIN(), star = STAR();
const headers = { Authorization: `Bearer ${star}` };
const SNAP = path.join(workDir(), "roster-before.json");

/** The roster overlay AND the roles overlay: a drill's demotion lives in the second, and a
 *  re-add that restores only the first leaves the person demoted (found 6 Sep 2026: the
 *  owner came back as a viewer, and no persona was an admin any more). */
async function exportRoster() {
  const r = await fetch(`${origin}/__publish/_state/export`, { headers });
  if (!r.ok) throw new Error(`export ${r.status}`);
  const doc = await r.json();
  return {
    roster: doc.families["users:roster"] || { add: {}, remove: [] },
    roles: doc.families["users:roles"] || {},
  };
}
async function importRoster(roster, roles) {
  const r = await fetch(`${origin}/__publish/_state/import`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ format: 1, families: { "users:roster": roster, "users:roles": roles } }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`import ${r.status} ${JSON.stringify(body)}`);
  return body;
}
const personaAddresses = () => Object.keys(PERSONAS).map(addressOf);
/** Everybody else's role overrides, exactly as they are; the personas' cleared. */
const rolesWithoutPersonas = (roles) => Object.fromEntries(Object.entries(roles).filter(([e]) => !personaAddresses().includes(e)));

const op = process.argv[2];
const { roster: cur, roles: curRoles } = await exportRoster();
if (op === "show") {
  console.log(JSON.stringify({ add: Object.keys(cur.add || {}), remove: cur.remove || [], rolesOverlay: curRoles }, null, 2));
} else if (op === "add") {
  if (!fs.existsSync(SNAP)) fs.writeFileSync(SNAP, JSON.stringify({ ...cur, roles: curRoles }, null, 2));
  const add = { ...(cur.add || {}) };
  const at = new Date().toISOString();
  for (const [key, p] of Object.entries(PERSONAS)) {
    const email = addressOf(key);
    add[email] = { email, name: p.name, role: p.role, initials: p.initials, color: p.color, addedAt: at };
  }
  const res = await importRoster({ add, remove: (cur.remove || []).filter((e) => !Object.keys(add).includes(e)) }, rolesWithoutPersonas(curRoles));
  console.log(`added ${Object.keys(PERSONAS).length} personas (role overlays cleared); import: ${JSON.stringify(res)}; snapshot ${SNAP}`);
} else if (op === "remove") {
  const before = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, "utf8")) : { add: {}, remove: [] };
  const add = { ...(cur.add || {}) };
  for (const key of Object.keys(PERSONAS)) delete add[addressOf(key)];
  const res = await importRoster({ add: { ...before.add, ...add }, remove: before.remove || [] }, rolesWithoutPersonas(curRoles));
  console.log(`removed personas from the overlay (⚠️ the object keeps them — see README "Leaving"); import: ${JSON.stringify(res)}`);
} else {
  console.error("usage: roster.mjs add|remove|show");
  process.exit(2);
}
