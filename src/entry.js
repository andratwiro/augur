/**
 * The DEPLOY ENTRY. `wrangler deploy` bundles from here; nothing else imports it.
 *
 * WHY THIS FILE EXISTS AT ALL, given it is four lines of code. Two deploy models have to
 * coexist for as long as the instances take to migrate:
 *
 *   Pages    build.js copies src/_worker.js VERBATIM into dist/_worker.js and Cloudflare
 *            runs that copy. There is no bundler, so that file can only import modules
 *            that build.js also copies next to it in dist/.
 *   Workers  wrangler's `main` points HERE, in the source tree, and esbuild inlines the
 *            whole import graph into one script. dist/ is only the asset directory.
 *
 * So the two front doors read DIFFERENT files, and this is the one only Workers reads.
 * That is what makes it the place for everything a Worker can declare and Pages cannot:
 * a Durable Object class export (Pages Advanced Mode cannot define one at all, which is
 * why the canvas rooms are a second worker today), a `scheduled` handler (the cron that
 * removes the last reason an instance needs GitHub Actions to operate), a `queue`
 * consumer. Each of those is one line here.
 *
 * THE ONE RULE, and it is not a style preference:
 *
 *     NO REQUEST LOGIC IN THIS FILE. EVER.
 *
 * Anything written here runs on Workers instances and does not exist on Pages instances.
 * A gate check, a header, a redirect added here would be live on one instance and absent
 * on its neighbour, and every test in this repo drives src/_worker.js, so the suite would
 * be green either way. test/worker-entry.test.mjs enforces it by reading this source, so
 * the rule is checked rather than described.
 *
 * WHY NOT THE THREE-FILE SPLIT the plan item recommended: it assumed a single 3049-line
 * file with zero imports. That is no longer true. src/_worker.js already imports five
 * leaf modules (chrome/appchrome.mjs, tenant-context.mjs, tenant-cache.mjs, mail.mjs,
 * kv-codec.mjs), none of which imports anything of its own, so the module graph the
 * bundler needs already exists. Carving request logic out of _worker.js would be a
 * refactor with no deploy-model reason behind it, and it would have to be done twice —
 * once for each front door — for as long as both exist.
 */
import worker from "./_worker.js";

// The canvas rooms. `wrangler deploy` resolves a [[durable_objects.bindings]] class_name
// against THIS file's exports, so a Durable Object the engine worker is to hold has to be
// named here — which is the reason this file exists at all.
//
// Exporting it costs a Pages instance nothing: Pages reads src/_worker.js, never this
// file. And it costs a Worker instance nothing either until its wrangler.toml declares
// the binding and the migration, so this can land ahead of any instance being ready for it.
export { BoardRoom } from "./board-room.mjs";

// One workspace's mutable state, in storage that belongs to that workspace and to no
// other. Same deal as above: named here so wrangler can resolve the class, inert on every
// instance until one declares the binding and the migration.
export { TenantStore } from "./tenant-do.js";

export default worker;
