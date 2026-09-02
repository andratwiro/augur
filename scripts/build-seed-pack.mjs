#!/usr/bin/env node
// build-seed-pack.mjs — build `dist/__seed/pack.json` by hand.
//
//   node scripts/build-seed-pack.mjs [--out <dist>] [--print]
//
// build.js does this itself on every engine-only build (the deploy path); this is the same
// builder for a person who wants to see the document — `--print` writes the pack's summary
// (space, engine, files, threads) to stdout instead of the bytes. See
// scripts/lib/seed-pack-build.mjs for what the pack is and what it asserts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedPack, writeSeedPack } from "./lib/seed-pack-build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : null; };

const summary = (pack) => ({
  format: pack.format, engine: pack.engine, space: pack.space.id,
  files: Object.keys(pack.files).length,
  prototypes: (pack.routing.publicPrefixes || []).length,
  threads: Object.values(pack.threads).reduce((n, l) => n + l.length, 0),
  connectCommandFile: pack.connectCommandFile,
});

if (argv.includes("--print")) {
  console.log(JSON.stringify(summary(buildSeedPack({ engineRoot: ROOT })), null, 2));
} else {
  const dist = path.resolve(opt("--out") || path.join(ROOT, "dist"));
  const { file, pack } = writeSeedPack(dist, { engineRoot: ROOT });
  console.error(`[seed-pack] wrote ${path.relative(process.cwd(), file)} — ${JSON.stringify(summary(pack))}`);
}
