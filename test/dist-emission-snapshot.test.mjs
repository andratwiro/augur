// What a deploy actually ships, frozen as hashes.
//
// WHY THIS EXISTS, AND WHY IT LANDS BEFORE THE WORKER MIGRATION. Nothing in this repo
// constrains the SHAPE of dist/. Renaming the emitted entry, dropping a config file, or
// moving the worker out of the asset directory keeps every test green and both deploy
// gates green, because every other test asks what the worker DOES, never what the build
// EMITS. Three live instances take this engine by pin bump, so a change to the emission
// reaches production before anyone reads the diff.
//
// The Pages -> plain-Worker migration is exactly the change that touches this and nothing
// else, so this test goes first: from here on, any step that alters what Pages serves has
// to say so as a baseline diff, in the same commit, on purpose.
//
// TWO FILES ARE NOT BYTE-STABLE and are compared by key shape instead:
//   · _build.json           — carries `builtAt`, a timestamp
//   · __manifests/_engine.json — carries the engine sha and the same timestamp
// Everything else is byte-exact, INCLUDING the content-hashed chrome bundle names. That
// is deliberate: `_chrome.<UI_VERSION>.<hash>.css` moving is a real event — it renames a
// cache key, evicts every visitor's service-worker precache, and is a legitimate thing to
// do — so it should cost a visible baseline update, not nothing.
//
// TO UPDATE: run `node test/dist-emission-snapshot.test.mjs --write` and read the diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = fileURLToPath(new URL("./dist-emission.baseline.json", import.meta.url));

// Compared by SHAPE, not bytes: these carry a build timestamp.
const VOLATILE = new Set(["_build.json", "__manifests/_engine.json"]);

function buildEngineOnly() {
  // NEVER the shared dist/ — `node --test` runs files in parallel and other tests read it.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "dist-emission-"));
  execFileSync(process.execPath, [path.join(ENGINE, "build.js")], {
    cwd: ENGINE,
    env: { ...process.env, GV_ENGINE_ONLY: "1", GV_DIST: out },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}

function* walk(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs, base);
    else yield path.relative(base, abs).split(path.sep).join("/");
  }
}

/** Recursive sorted key path list — the shape of a JSON document, without its values. */
function keyShape(value, prefix = "") {
  if (Array.isArray(value)) return [`${prefix}[]`];
  if (value && typeof value === "object") {
    return Object.keys(value).sort().flatMap((k) => keyShape(value[k], prefix ? `${prefix}.${k}` : k));
  }
  return [`${prefix}:${typeof value}`];
}

function snapshot(dist) {
  const out = {};
  for (const rel of walk(dist)) {
    const buf = fs.readFileSync(path.join(dist, rel));
    out[rel] = VOLATILE.has(rel)
      ? `shape:${crypto.createHash("sha256").update(keyShape(JSON.parse(buf.toString("utf8"))).join("\n")).digest("hex").slice(0, 16)}`
      : `sha256:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}`;
  }
  return out;
}

// `node test/dist-emission-snapshot.test.mjs --write` regenerates the baseline.
if (process.argv.includes("--write")) {
  const dist = buildEngineOnly();
  try {
    fs.writeFileSync(BASELINE, JSON.stringify(snapshot(dist), null, 2) + "\n");
    console.log(`baseline written: ${Object.keys(snapshot(dist)).length} files`);
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
} else {
  test("an engine-only build emits exactly the files the baseline records", () => {
    const dist = buildEngineOnly();
    let now;
    try { now = snapshot(dist); } finally { fs.rmSync(dist, { recursive: true, force: true }); }
    const was = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

    const added = Object.keys(now).filter((k) => !(k in was));
    const removed = Object.keys(was).filter((k) => !(k in now));
    const changed = Object.keys(now).filter((k) => k in was && was[k] !== now[k]);

    const why = "Run `node test/dist-emission-snapshot.test.mjs --write` and put the diff in the commit. "
      + "A file appearing, vanishing or changing here is a change to what three live instances serve.";
    assert.deepEqual(added, [], `dist gained file(s): ${added.join(", ")}\n${why}`);
    assert.deepEqual(removed, [], `dist LOST file(s): ${removed.join(", ")}\n${why}`);
    assert.deepEqual(changed, [], `dist content changed: ${changed.join(", ")}\n${why}`);
  });

  test("the baseline is not vacuous — it records a real site", () => {
    // A baseline of {} would make every assertion above pass. Name the files a deploy
    // cannot work without, so an emptied or truncated baseline fails loudly.
    const was = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const names = Object.keys(was);
    assert.ok(names.length > 20, `baseline holds only ${names.length} files`);
    for (const required of ["_worker.js", "_build.json", "404.html", "sw.js", "__config/instance.json", "__config/routing.json"]) {
      assert.ok(names.includes(required), `baseline is missing ${required}`);
    }
    assert.ok(names.some((n) => /^_chrome\.[\d.]+\.[0-9a-f]{8}\.css$/.test(n)), "baseline names no chrome stylesheet");
    assert.ok(names.some((n) => /^_chrome\.[\d.]+\.[0-9a-f]{8}\.js$/.test(n)), "baseline names no chrome script");
  });

  test("the worker and the modules it imports are emitted beside it", () => {
    // The migration's whole question is where the worker sits relative to the assets
    // directory. Pin today's answer so the move is a visible edit rather than a drift.
    const was = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    for (const m of ["_worker.js", "tenant-context.mjs", "tenant-cache.mjs", "mail.mjs", "kv-codec.mjs", "chrome/appchrome.mjs"]) {
      assert.ok(m in was, `${m} is no longer emitted into dist/`);
    }
  });
}
