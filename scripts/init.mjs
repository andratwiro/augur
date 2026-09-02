// init.mjs — `augur init`: scaffold a new space in the current directory.
//
//   augur init [--id <id>] [--name "<name>"] [--origin https://…]
//              [--project <folder>] [--prototype <name>]
//
// Writes the two files that make a directory a space the engine can build:
// a `space.json` satisfying agents/space-json.md, and one starter prototype at
// `<project>/prototypes/<name>/index.html`. Nothing else — a space needs no CI,
// no secrets and no submodule mount (see templates/README.md).
//
// That nesting is not decoration: the build only finds prototypes one level down,
// inside a top-level project folder (`<opportunity>/prototypes/<name>/` in
// agents/prototype-contract.md). A `prototypes/` directory at the space root
// discovers as zero prototypes and the build still reports success, which is a
// quiet way to lose an afternoon — so the scaffold puts it where it is seen.
//
// Defaults come from the directory you run it in, so the common case is a bare
// `augur init`. It refuses to overwrite an existing space.json or prototype:
// re-running after filling one in is a no-op you can trust.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NOTE as CANON_NOTE } from "./canon.mjs";

const log = (msg) => console.error(`\x1b[32m[init]\x1b[0m ${msg}`);
const die = (msg) => { console.error(`\x1b[31m[init]\x1b[0m ${msg}`); process.exit(1); };
const opt = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };

const CWD = process.cwd();

// `id` is the URL prefix and the manifest key, so it is the one field the build
// constrains: lowercase [a-z0-9-]. Derive a legal one from the folder name rather
// than making the common case ask a question.
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
const title = (s) => s.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

const id = slug(opt("--id") || path.basename(CWD));
if (!id) die(`could not derive a space id from "${path.basename(CWD)}" — pass --id <id> (lowercase letters, digits, hyphens).`);

const name = opt("--name") || title(id);
const origin = (opt("--origin") || process.env.AUGUR_ORIGIN || "").replace(/\/+$/, "");
const proto = slug(opt("--prototype") || "hello");
const project = slug(opt("--project") || "hello");

const spaceJsonPath = path.join(CWD, "space.json");
const rel = path.join(project, "prototypes", proto, "index.html");
const protoDir = path.join(CWD, project, "prototypes", proto);
const protoPath = path.join(protoDir, "index.html");

if (existsSync(spaceJsonPath)) die(`${path.relative(CWD, spaceJsonPath) || "space.json"} already exists — this is already a space. Nothing written.`);
if (existsSync(protoPath)) die(`${rel} already exists. Pass --prototype <name> for a different starter.`);

// Only the fields a new space actually needs. Every other key in
// agents/space-json.md is optional and better added when it is wanted than
// scaffolded as noise — `default: true` because a fresh space is a one-space
// site until something else mounts beside it.
const space = { id, name, default: true };
// siteOrigin is what lets `augur connect`/`augur login` and `augur publish` work from a bare
// clone with no deploy shell around it, so write it when we know it.
if (origin) space.siteOrigin = origin;

writeFileSync(spaceJsonPath, JSON.stringify(space, null, 2) + "\n");

// The starter has to open over file:// with no build step (agents/prototype-contract.md),
// so: no imports, no absolute paths, no fonts off the network. The description meta is
// what the gallery card, the OG preview and the canvas insert-picker all read.
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<meta name="description" content="Starter prototype for the ${name} space — replace this with one sentence saying what it shows.">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f4efe6; color: #2c2150;
  }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 2rem; margin: 0 0 .5rem; letter-spacing: -.02em; }
  p { margin: 0 0 1rem; }
  code { background: rgba(44, 33, 80, .08); padding: .15em .4em; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #17141f; color: #ece7dd; }
    code { background: rgba(236, 231, 221, .12); }
  }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p>This file is <code>${rel}</code>. Edit it — it is
     self-contained static HTML with no build step, so it opens straight from disk
     and ships exactly as written.</p>
  <p>When it works, run <code>augur ship</code>. That commits, publishes, and gives
     you the live URL.</p>
</main>
</body>
</html>
`;

mkdirSync(protoDir, { recursive: true });
writeFileSync(protoPath, html);

// The naming scheme travels WITH the workspace, because the agent that needs it is the one
// that arrives cold — often with no engine clone beside it to read agents/canon.md from.
// Written at birth rather than at the first promotion: an affordance nobody can see is one
// nobody uses, and a workspace that has been worked in for a month is exactly the one whose
// names have already drifted. Never overwritten — same rule as space.json.
const canonPath = path.join(CWD, "CANON.md");
const wroteCanon = !existsSync(canonPath);
if (wroteCanon) writeFileSync(canonPath, CANON_NOTE);

log(`space "${id}" scaffolded:`);
log(`  space.json`);
log(`  ${rel}`);
if (wroteCanon) log(`  CANON.md`);
if (!origin) log(`no siteOrigin set — add one to space.json (or pass --origin) so connect/login/publish work from this clone.`);
log(`next: edit the prototype, then \`augur ship\`.`);
