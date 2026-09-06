// demote-owner.mjs — the one suite person who cannot remove themself becomes a viewer:
// no admin routes, no publish token, nothing to land. Removal is one click by a real admin.
import { addressOf } from "./env.mjs";
import { human } from "./persona.mjs";
const owner = await human("owner");
const r = await owner.admin({ op: "role", email: addressOf("owner"), role: "viewer", space: process.env.LIVE_SPACE });
console.log(`demote owner to viewer: ${r.status} ${JSON.stringify(r).slice(0, 120)}`);
await new Promise((res) => setTimeout(res, 3000));
console.log(`owner cookie on /__admin/tokens: ${(await owner.get("/__admin/tokens")).status}`);
console.log(`owner cookie on POST /__unit/open: ${(await owner.json("/__unit/open", { unit: process.env.LIVE_UNITS.split(",")[0] })).status}`);
