// probe-read.mjs — why does `augur read` say "network", and what happened to editor2's token?
import { UNITS, ORIGIN, SPACE, addressOf, workDir } from "./env.mjs";
import { human, client } from "./persona.mjs";
import { doRead } from "../../scripts/lib/draft.mjs";
import path from "node:path";

const c = await client("editor", "probe-read");
const unit = UNITS()[8];
const dir = path.join(workDir("probe-read"), "_read", ...unit.split("/").filter(Boolean));
const r = await doRead({ client: c, unit, dir, origin: ORIGIN(), space: SPACE() });
console.log("doRead:", JSON.stringify(r).slice(0, 600));
const m = await c.main(unit);
console.log("main:", JSON.stringify(m).slice(0, 300));

const owner = await human("owner");
const toks = await owner.json("/__admin/tokens", null, "GET");
const mine = Object.entries(toks.tokens || {}).filter(([, t]) => /\+editor2|\+editor@|\+owner|\+viewer/.test(t.label || ""));
console.log("suite tokens:", JSON.stringify(mine.map(([h, t]) => ({ hash: h.slice(0, 8), space: t.space, label: t.label.replace(/^[^+]+/, "<qa>"), createdAt: t.createdAt, revoked: t.revokedAt || t.revoked || null }))));
