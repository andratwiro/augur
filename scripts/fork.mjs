#!/usr/bin/env node
/**
 * augur fork — take your own copy of a published artifact, at a new URL.
 *
 *   augur fork /toolkit/map/ /toolkit/map-mine/
 *   augur fork /toolkit/map/ /toolkit/map-mine/ --space alpha
 *
 * `F-fork-verb`. Divergence-then-convergence needs fork as a deliberate verb rather than as
 * conflict cleanup or as "copy the folder and republish it". The copy is made in the
 * MANIFEST — the blobs already exist, so a hundred-file prototype forks without uploading,
 * downloading or hashing a byte — and the store remembers where it came from.
 *
 * ⚠️ IT NEEDS NO TREE, and that is the point. Every other publishing command starts from a
 * folder on disk; this one is two paths and a token, so a workspace that has never had a
 * repo can still say "give me my own copy of this". Nothing is written to your working
 * directory, and nothing is read from it.
 *
 * ⚠️ THE COPY IS YOURS. It is stamped with you as its owner rather than inheriting the
 * original's, so forking to get an editable copy cannot hand the fork the same restriction
 * it was forked to escape. Lineage rides along as `forkedFrom {path, version}` naming a
 * manifest version the store still holds — versions are never pruned, so the parent stays
 * reachable even after the source moves on.
 */
import { target, apiClient, buildStamp, idsFromStamp } from "./lib/store.mjs";

const log = (m) => console.error(`\x1b[36m[fork]\x1b[0m ${m}`);
const die = (m) => { log(m); process.exit(1); };

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--space");
const [FROM, TO] = positional;
if (!FROM || !TO) die("usage: augur fork <from-path> <to-path> [--space <id>]");

let origin, token;
try { ({ origin, token } = target()); } catch (e) { die(e.message); }
const req = apiClient(origin, token);

// Which workspace. Named, or the one the instance serves — asked of the public build stamp
// rather than of a folder, because a forking publisher may have no folder.
let space = opt("--space");
if (!space) {
  const ids = idsFromStamp(await buildStamp(origin)).filter((id) => id !== "_engine");
  if (ids.length !== 1) die(`name the workspace: --space <${ids.join("|") || "id"}>`);
  space = ids[0];
}

let res;
try {
  res = await (await req(`${space}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: TO }),
  })).json();
} catch (e) {
  // The store's refusals are specific on purpose, so pass its words through rather than
  // flattening them into "fork failed".
  die(e.message.replace(/^POST \S+ → /, ""));
}

log(`\x1b[32mforked\x1b[0m ${res.from} → ${res.to}  (v${res.version})`);
console.log(`${origin}${res.to}`);
console.log(`\x1b[2m${res.files} file(s) aliased, ${res.blobsUploaded} blob(s) uploaded — `
  + `forked from ${res.forkedFrom.path} at v${res.forkedFrom.version}\x1b[0m`);
