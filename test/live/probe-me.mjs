// Probe: what the workspace says a persona IS right now (/__me), beside what the KV-side
// export says about roles and the roster overlay. For a roster that looks wrong after an
// interrupted drill.
import { human } from "./persona.mjs";
import { STAR, ORIGIN, PERSONAS, addressOf } from "./env.mjs";

const who = process.argv[2] || "owner";
const h = await human(who);
const me = await (await h.get("/__me", { accept: "application/json" })).json();
console.log(`${who}: /__me →`, JSON.stringify(me.user && { email: me.user.email, role: me.user.role, admin: me.user.admin }));
const doc = await (await fetch(`${ORIGIN()}/__publish/_state/export`, { headers: { Authorization: `Bearer ${STAR()}` } })).json();
const roles = doc.families["users:roles"] || {};
const roster = doc.families["users:roster"] || { add: {}, remove: [] };
for (const p of Object.keys(PERSONAS)) {
  const e = addressOf(p);
  console.log(`${p.padEnd(8)} KV roles overlay: ${roles[e] || "-"}   roster.add role: ${(roster.add[e] || {}).role || "-"}   removed: ${(roster.remove || []).includes(e)}`);
}
