// Probe: what the workspace says each suite persona's role is right now — the admin list,
// as the owner sees it. Run after an interrupted drill, before trusting the roster.
import { human } from "./persona.mjs";
import { ROSTER_PERSONAS, addressOf } from "./env.mjs";

const owner = await human("owner");
const r = await owner.users(process.env.LIVE_SPACE);
const list = r.users || r.people || r.members || [];
for (const p of ROSTER_PERSONAS) {
  const u = list.find((x) => x && String(x.email).toLowerCase() === addressOf(p).toLowerCase());
  console.log(`${p.padEnd(8)} ${u ? `${u.role || "?"}${u.removed ? " (removed)" : ""}` : "NOT ON THE ROSTER"}`);
}
if (!list.length) console.log(`(admin list answered ${r.status}: ${JSON.stringify(r).slice(0, 200)})`);
