// probe-fails.mjs — look directly at what G, H2, J and K3 tripped on.
import { UNITS, ORIGIN, addressOf } from "./env.mjs";
import { human, client, cli, token } from "./persona.mjs";

const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
say(`connectivity: ${(await fetch(`${ORIGIN()}/_build.json`)).status}`);

const owner = await human("owner");
const users = await owner.users(process.env.LIVE_SPACE);
const e2 = (users.users || []).find((u) => u.email === addressOf("editor2"));
say(`editor2 on the roster: ${JSON.stringify(e2)}`);

const c = await client("editor2", "probe");
say(`editor2 open on ${UNITS()[5]}: ${JSON.stringify(await c.open({ unit: UNITS()[5] })).slice(0, 200)}`);
const t = await token("editor2");
const r = await fetch(`${ORIGIN()}/__publish/${process.env.LIVE_SPACE}/manifest`, { headers: { Authorization: `Bearer ${t.token}` } });
say(`editor2 token on the manifest read: ${r.status} ${(await r.text()).slice(0, 120)}`);

const st = await cli("editor", "probe", ["status"]);
say(`augur status as editor: exit ${st.code}\n--- out ---\n${st.out.slice(0, 600)}\n--- err ---\n${st.err.slice(0, 600)}`);

const rd = await cli("editor", "probe", ["read", UNITS()[8].replace(/^\/|\/$/g, "")]);
say(`augur read as editor: exit ${rd.code}\n--- out ---\n${rd.out.slice(0, 400)}\n--- err ---\n${rd.err.slice(0, 600)}`);

// G's unit: how big is it, and does a plain open work now?
const ce = await client("editor", "probe");
const o = await ce.open({ unit: UNITS()[4] });
say(`open ${UNITS()[4]}: files=${Object.keys(o.table || {}).length} draft=${o.draftId} ${o.status || ""}`);
if (o.draftId) await ce.discard({ unit: UNITS()[4], draftId: o.draftId });
