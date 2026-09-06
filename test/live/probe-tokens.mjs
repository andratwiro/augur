// Probe: the publish tokens the workspace holds right now, as the owner sees them in the
// admin panel — label, scope, minted when. For finding out what a run left behind.
import { human } from "./persona.mjs";
const owner = await human("owner");
const r = await owner.json("/__admin/tokens", null, "GET");
const rows = Object.entries(r.tokens || {}).map(([h, t]) => ({ hash: h.slice(0, 8), label: t.label, space: t.space, createdAt: t.createdAt, expiresAt: t.expiresAt || "" }))
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const since = process.argv[2] || "";
for (const t of rows) if (!since || t.createdAt >= since) console.log(`${t.createdAt}  ${String(t.space).padEnd(9)} ${t.label}  ${t.hash}`);
console.log(`${rows.length} token(s) in all${since ? `, listed those since ${since}` : ""}; admin answered ${r.status}`);
