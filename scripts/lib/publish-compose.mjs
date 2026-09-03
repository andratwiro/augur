// Moved to src/publish-compose.mjs, re-exported here so no CLI import had to change.
//
// ⚠️ IT MOVED BECAUSE THE WORKER RUNS IT. `C-fork-on-conflict` resolves a stale base inside
// the commit handler using the SAME composition the CLI uses — two implementations of "who
// keeps the URL" would disagree on exactly the publishes a conflict is about. `src/` is what
// the deploy copies beside `_worker.js`; a module the worker imports from `scripts/` resolves
// nowhere at the edge, and the build's derived copy list would have to reach outside `src/`
// to fix it. See the header of src/publish-compose.mjs for the composition rules themselves.
export { composePublish, filterLitter, forkLanded, LITTER_RE } from "../../src/publish-compose.mjs";
// The unit vocabulary rode along here before the move (compose re-exported what it imported),
// and CLI modules import it from this path. Kept, pointing at its one definition.
export { authoredUnits, unitOfPath, unitPaths } from "../../src/publish-units.mjs";
