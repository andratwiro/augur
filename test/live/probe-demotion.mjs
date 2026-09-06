// probe-demotion.mjs — after a per-space demotion, which admin routes still answer?
import { addressOf } from "./env.mjs";
import { human } from "./persona.mjs";
const owner = await human("owner");
const routes = ["/__admin/tokens", "/__admin/users", `/__admin/users?space=${process.env.LIVE_SPACE}`, "/__admin/version", "/__admin/storage", "/__admin/backup"];
const probe = async (tag) => { const out = []; for (const r of routes) out.push(`${r}=${(await owner.get(r)).status}`); console.log(`${tag}: ${out.join("  ")}`); };
await probe("per-space viewer, global still admin");
const g = await owner.admin({ op: "role", email: addressOf("owner"), role: "viewer" });
console.log(`global demotion (no space): ${g.status} ${JSON.stringify(g).slice(0, 100)}`);
await new Promise((res) => setTimeout(res, 4000));
await probe("after global demotion");
