#!/usr/bin/env node
// augur ls [<opportunity>]
//
// The opportunities this workspace serves, one per line with a prototype count, or — given
// one — its prototypes, one per line as `<opportunity>/<name>`. Read straight from the live
// manifest, so it is never stale and never a guess. Exists so an agent asked to "put it
// under Broad Listening" finds `broad-listening` instead of guessing, inventing a new
// top-level project, or using a display name with a space.
import { targetPaired, apiClient, buildStamp } from "./lib/store.mjs";
import { authoredUnits } from "../src/publish-units.mjs";
import { isWelcomeUnit } from "../src/galleries.mjs";

const die = (m) => { console.error(`\x1b[31m[ls]\x1b[0m ${m}`); process.exit(1); };
// The first positional — never a flag, and never the VALUE of one (`--origin <url>`,
// `--session <label>`): the URL after `--origin` is not an opportunity.
const argv = process.argv.slice(2);
const want = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))) || null;

let origin, token;
try { ({ origin, token } = await targetPaired({ needToken: true })); } catch (e) { die(e.message); }

let space;
try { space = Object.keys((await buildStamp(origin)).spaces || {})[0]; }
catch (e) { die(`could not reach ${origin} (${e.message}).`); }
if (!space) die("could not tell which space this instance serves.");

const req = apiClient(origin, token);
let live;
try { live = await (await req(`${space}/manifest`)).json(); }
catch (e) { die(`could not read the live manifest (${e.message}).`); }

const sources = (live && live.routing && live.routing.unitSources) || {};
const byOpp = new Map();
for (const u of authoredUnits(live)) {
  // A member's own welcome page lists in the manifest like any other authored unit, but it
  // was landed by the platform for one person, not published by a person for the team — the
  // gallery agrees (`isWelcomeUnit`, src/galleries.mjs) and the CLI must not disagree.
  if (isWelcomeUnit(sources[u])) continue;
  const [opp, name] = u.replace(/^\/|\/$/g, "").split("/");
  if (!opp || !name) continue;
  if (!byOpp.has(opp)) byOpp.set(opp, []);
  byOpp.get(opp).push(name);
}

if (!want) {
  for (const [opp, names] of [...byOpp].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${opp.padEnd(28)} ${names.length} prototype${names.length === 1 ? "" : "s"}`);
  }
  process.exit(0);
}

const key = want.replace(/^\/|\/$/g, "");
const names = byOpp.get(key);
if (!names) die(`no opportunity "${want}" here — \`augur ls\` lists them.`);
for (const n of names.sort()) console.log(`${key}/${n}`);
