#!/usr/bin/env node
// refine — the screenshot-verified refine loop, as a harness rather than a habit.
//
// WHAT IT IS FOR. Rebuilding a design system's components against a real product is not
// finished when an agent says it is finished. It is finished when each component, rendered
// and photographed, looks like the original — and that is a measurement, taken by
// something with no stake in the answer. This runs that loop: for every component in a
// manifest, render the candidate, render (or load) the original, compare the two images,
// and record the number. Then it prints a pass-rate.
//
//   augur refine                       verify every component in refine.json
//   augur refine --gate 0.99           …and exit 1 unless 99% of them pass
//   augur refine --only card,toolbar   just these
//   augur refine --restart             ignore the ledger and re-measure everything
//   augur refine --audit               re-derive every verdict from the saved shots, no browser
//
// THE ONE RULE. No self-assessment. Nothing an agent says about its own work reaches the
// verdict: the harness renders the pixels itself, measures them itself, and derives pass
// and fail from the number every time the report is drawn. There is no "mark as done", no
// approve, and — deliberately — **no command that adopts a candidate render as the
// reference**. A blessing tool would be the whole hole: an agent that can nominate its own
// output as the thing to match can make anything pass. References come from OUTSIDE the
// loop, from the original product.
//
// Two smaller holes are closed the same way. `--gate` REFUSES to run with `--only`, because
// a pass-rate over components you picked is a claim about your own work wearing a
// measurement's clothes. And the threshold is printed on the same line as the pass-rate,
// every time, because loosening the bar is the cheapest way to turn a night green and it
// should never be possible to quote the rate without it.
//
// WHAT REMAINS THE READER'S JOB. The manifest and the references are the canon; anyone who
// can edit those can change what "correct" means, and no harness can tell that from a real
// correction. That is why references are extracted from the original product and reviewed
// like source. This tool guarantees the number describes the pixels — not that the pixels
// are the right ones to have asked for.
//
// RESUMABLE, BECAUSE OVERNIGHT RUNS DIE. Each component's measurement is appended to a
// JSONL ledger and fsynced before the next one starts. A run killed at component 340 of
// 500 restarts at 341. Skipping is by content digest, not by position, so editing one
// component re-verifies that one and nothing else. See `scripts/lib/refine-ledger.mjs`.
//
// WHAT A REFERENCE MAY BE — one string per side, kind inferred:
//   `components/card`      a folder (or .html file) on disk, rendered over file://
//   `/components/card/`    a site path, rendered through --base <origin> — the REAL
//                          serving path, e.g. against `npm run offline -- --sandbox`
//   `https://…`            a URL, rendered as-is
//   `shots/card.png`       an image already captured; loaded, not rendered
//
// PREFER RENDERING BOTH SIDES OVER A CAPTURED PNG. When both sides are rendered in the
// same browser in the same run, font rasterisation, hinting and antialiasing are identical
// on both sides and cancel exactly — the comparison is about the component. A PNG captured
// on another machine brings that machine's font stack with it, and the threshold then has
// to absorb text-edge noise, which is how a harness ends up too loose to catch anything.
//
// Requires: playwright (devDep). Run output lands in `.augur-refine/` (gitignored).

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodePng, encodePng } from "./lib/refine-png.mjs";
import { compareImages, verdict, DEFAULT_THRESHOLD, DEFAULT_PIXEL_TOLERANCE } from "./lib/refine-compare.mjs";
import {
  LEDGER_NAME, appendLedger, contentDigest, isFresh, readLedger, report, settingsFingerprint, sha256,
} from "./lib/refine-ledger.mjs";

const RUN_DIR = ".augur-refine";
const MANIFEST = "refine.json";
// The gallery tiers build.js publishes, plus each opportunity's prototypes — the same
// list `scripts/shoot.mjs` walks, and for the same reason: these are the folders that
// hold one rendered thing each.
const TIERS = ["base", "components", "patterns", "pages"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

if (flag("help") || flag("h")) {
  console.log(await fs.readFile(new URL(import.meta.url), "utf8").then((s) =>
    s.split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")));
  process.exit(0);
}

const ROOT = path.resolve(opt("root", process.cwd()));
const base = opt("base", process.env.AUGUR_REFINE_BASE || "");
const only = (opt("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const gate = opt("gate", "") ? Number(opt("gate")) : null;
const auditOnly = flag("audit");
const restart = flag("restart");

// A GATE IS A STATEMENT ABOUT THE CANON, NOT ABOUT A CHOSEN SUBSET OF IT. `--only` is for
// working on one component; `--gate` is the number a caller has to satisfy. Together they
// are the one way left to manufacture a pass-rate without touching a pixel — measure the
// four components that already work and report 100%. So they are refused together, by name.
if (gate != null && only.length) {
  console.error("refine: --gate and --only cannot be combined — a pass-rate over components you chose is not a pass-rate.");
  console.error("        Run --only while you work; run the whole manifest when you want the number.");
  process.exit(2);
}
if (gate != null && !(Number.isFinite(gate) && gate >= 0 && gate <= 1)) {
  console.error(`refine: --gate ${opt("gate")} is not a fraction between 0 and 1 (0.99 means 99%)`);
  process.exit(2);
}

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

// ---------------------------------------------------------------- the manifest

async function loadManifest() {
  const file = path.join(ROOT, MANIFEST);
  if (await exists(file)) {
    const m = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(m.components) || !m.components.length) {
      throw new Error(`${MANIFEST} has no components — a manifest with nothing in it is not a verified canon`);
    }
    return m;
  }
  return { ...(await discover()), discovered: true };
}

// Without a manifest, a component is a tier folder that has something to be compared
// AGAINST — `reference.png` beside it, or a `reference/` folder to render. A folder with
// no reference is not verifiable, so it is listed as such rather than silently dropped.
async function discover() {
  const components = [];
  const unverifiable = [];
  const dirs = [];
  for (const tier of TIERS) {
    const t = path.join(ROOT, tier);
    if (!(await exists(t))) continue;
    for (const e of await fs.readdir(t, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) dirs.push([`${tier}/${e.name}`, path.join(t, e.name)]);
    }
  }
  for (const e of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const pp = path.join(ROOT, e.name, "prototypes");
    if (!(await exists(pp))) continue;
    for (const p of await fs.readdir(pp, { withFileTypes: true })) {
      if (p.isDirectory() && !p.name.startsWith(".")) dirs.push([`${e.name}/${p.name}`, path.join(pp, p.name)]);
    }
  }
  for (const [id, dir] of dirs) {
    if (await exists(path.join(dir, "reference.png"))) {
      components.push({ id, candidate: path.relative(ROOT, dir), reference: path.relative(ROOT, path.join(dir, "reference.png")) });
    } else if (await exists(path.join(dir, "reference"))) {
      components.push({ id, candidate: path.relative(ROOT, dir), reference: path.relative(ROOT, path.join(dir, "reference")) });
    } else {
      unverifiable.push(id);
    }
  }
  return { components, unverifiable };
}

// ---------------------------------------------------------------- targets

// Entry HTML for a folder: index.html, else the first .html. Same rule `shoot.mjs` uses —
// if that rule ever changes, change it in both, because a poster and a verification shot
// of the same folder must be of the same page.
async function entryFile(dir) {
  if ((await fs.stat(dir)).isFile()) return dir;
  const index = path.join(dir, "index.html");
  if (await exists(index)) return index;
  const es = await fs.readdir(dir, { withFileTypes: true });
  const h = es.find((e) => e.isFile() && e.name.endsWith(".html"));
  if (!h) throw new Error(`no .html entry in ${path.relative(ROOT, dir)}`);
  return path.join(dir, h.name);
}

/**
 * Resolve one side of a comparison to `{kind, url|file, digestOf}`.
 *
 * `digestOf` is the thing on disk whose bytes decide whether this side has CHANGED since
 * the ledger last measured it. For a folder or a PNG that is the target itself. For a URL
 * it is a question the URL cannot answer — and getting this wrong is a lie the harness
 * would tell every night: digest the URL STRING and an edited component keeps its stale
 * verdict forever, because the string never changes. So:
 *
 *   • a site path resolves to the same-named folder under the canon root, when there is
 *     one — serving your canon over a local server is the normal reason to use `--base`,
 *     and `/components/card/` is `components/card` on disk;
 *   • `candidateSource` / `referenceSource` in the manifest override that, for a server
 *     whose URLs are not its folder names;
 *   • anything left with no source on disk is VOLATILE: re-measured every run, never
 *     resumed, and said out loud, because "I cannot tell whether this changed" is an
 *     honest answer and "unchanged" is not.
 */
async function resolveTarget(spec, label, sourceOverride) {
  if (typeof spec !== "string" || !spec) throw new Error(`${label} is missing`);
  let source = null;
  if (sourceOverride) {
    source = path.resolve(ROOT, sourceOverride);
    if (!(await exists(source))) throw new Error(`${label} source "${sourceOverride}" does not exist`);
  }
  if (/^https?:\/\//.test(spec)) return { kind: "url", url: spec, digestOf: source };
  if (spec.startsWith("/")) {
    if (!base) throw new Error(`${label} "${spec}" is a site path — pass --base <origin> (e.g. a local offline server) to render it`);
    if (!source) {
      const guess = path.resolve(ROOT, spec.replace(/^\/+/, "").replace(/\/+$/, ""));
      if (guess.startsWith(ROOT) && (await exists(guess))) source = guess;
    }
    return { kind: "url", url: base.replace(/\/+$/, "") + spec, digestOf: source };
  }
  const abs = path.resolve(ROOT, spec);
  if (!(await exists(abs))) throw new Error(`${label} "${spec}" does not exist`);
  if (abs.endsWith(".png")) return { kind: "image", file: abs, digestOf: abs };
  return { kind: "page", file: await entryFile(abs), digestOf: abs };
}

// ---------------------------------------------------------------- rendering

async function renderShot(browser, target, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const url = target.kind === "url" ? target.url : pathToFileURL(target.file).href;
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    // Everything that moves is noise in a still photograph. A CSS animation caught
    // mid-frame is the classic source of a flaky screenshot verdict.
    await page.addStyleTag({
      content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}",
    });
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.waitForTimeout(250);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, ...viewport } });
    if (!buf || !buf.length) throw new Error("empty screenshot");
    return buf;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- the run

function pct(n) { return (n * 100).toFixed(2) + "%"; }

function printReport(r, { gate: g, unverifiable = [], threshold, manifestTotal }) {
  const w = Math.max(9, ...r.rows.map((x) => x.id.length));
  console.log("");
  console.log("component".padEnd(w) + "   diff      verdict");
  console.log("-".repeat(w) + "   --------  -------");
  for (const row of r.rows) {
    const d = row.diffRatio == null ? "     —  " : pct(row.diffRatio).padStart(8);
    const mark = row.state === "pass" ? "pass" : row.state === "incomplete" ? "not measured" : "FAIL";
    console.log(row.id.padEnd(w) + "   " + d + "  " + mark + (row.reason ? "  " + row.reason : ""));
  }
  console.log("");
  console.log(`${r.total} components · ${r.passed} pass · ${r.failed} fail · ${r.incomplete} not measured`);
  // The threshold is printed with the pass-rate, always. The number only means something
  // next to the bar it was measured against, and a loosened bar is the cheapest way to
  // turn a red run green — so it travels in the same line the caller reads.
  console.log(`measured pass-rate ${pct(r.passRate)} at threshold ${pct(threshold)}`
    + (g != null ? ` · gate ${pct(g)} → ${r.passRate >= g ? "MET" : "NOT MET"}` : ""));
  if (manifestTotal != null && manifestTotal !== r.total) {
    console.log(`FILTERED: ${r.total} of ${manifestTotal} components in the manifest were measured — this rate is not the canon's.`);
  }
  if (unverifiable.length) {
    console.log(`\n${unverifiable.length} folder(s) carry no reference and were not verified: ${unverifiable.join(", ")}`);
    console.log("A component nothing can be compared against is not a passing component.");
  }
}

async function main() {
  const manifest = await loadManifest();
  const viewport = { width: manifest.viewport?.width ?? 1000, height: manifest.viewport?.height ?? 700 };
  const threshold = manifest.threshold ?? DEFAULT_THRESHOLD;
  const pixelTolerance = manifest.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE;
  const fingerprint = settingsFingerprint({ viewport, threshold, pixelTolerance, base, v: 1 });

  const manifestTotal = manifest.components.length;
  let components = manifest.components;
  if (only.length) components = components.filter((c) => only.includes(c.id));
  if (!components.length) throw new Error("no components selected");

  const runDir = path.join(ROOT, RUN_DIR);
  const shotsDir = path.join(runDir, "shots");
  const ledgerFile = path.join(runDir, LEDGER_NAME);
  await fs.mkdir(shotsDir, { recursive: true });
  if (restart) await fs.rm(ledgerFile, { force: true });

  const { entries, torn } = await readLedger(ledgerFile);
  if (torn) console.log(`ledger: ${torn} torn line(s) from an interrupted run, discarded`);

  if (auditOnly) return audit(components, threshold, pixelTolerance, shotsDir, entries, manifest, manifestTotal);

  const { chromium } = await import("playwright");
  // ONE BROWSER FOR THE RUN, REPLACED IF IT DIES. A five-hundred-component night is long
  // enough for a browser to be killed by the OS, run out of memory, or be caught by a
  // laptop sleeping. Holding a single handle for the whole run means the first crash turns
  // every remaining component into an error line; a lazily (re)launched one costs the same
  // when nothing goes wrong and survives when something does.
  let browser = null;
  const browserNow = async () => {
    if (browser && browser.isConnected()) return browser;
    if (browser) {
      console.log("browser: the previous one is gone — launching a replacement");
      await browser.close().catch(() => {});
    }
    browser = await chromium.launch();
    return browser;
  };
  let done = 0, skipped = 0, relaunched = 0;
  const volatile = [];
  try {
    for (const c of components) {
      const safe = c.id.replace(/[^a-z0-9]+/gi, "-");
      let cand, ref;
      try {
        cand = await resolveTarget(c.candidate, `${c.id}: candidate`, c.candidateSource);
        ref = await resolveTarget(c.reference, `${c.id}: reference`, c.referenceSource);
      } catch (e) {
        await appendLedger(ledgerFile, { id: c.id, fingerprint, diffRatio: 1, error: e.message, measuredAt: new Date().toISOString() });
        entries.set(c.id, { id: c.id, fingerprint, diffRatio: 1, error: e.message });
        console.log(`✗ ${c.id} — ${e.message}`);
        done++;
        continue;
      }
      // `null` where there is no source on disk — and null is what makes the entry
      // volatile, never what makes it match. See `resolveTarget`.
      const candidateDigest = cand.digestOf ? await contentDigest(cand.digestOf) : null;
      const referenceDigest = ref.digestOf ? await contentDigest(ref.digestOf) : null;
      if (!candidateDigest || !referenceDigest) volatile.push(c.id);

      if (isFresh(entries.get(c.id), { candidateDigest, referenceDigest, fingerprint })) {
        skipped++;
        continue;
      }

      let record;
      // Two attempts, and the second only ever happens because the BROWSER went away. A
      // component that is genuinely unrenderable fails on the first attempt and is not
      // retried — retrying a real fault just doubles the night.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const b = await browserNow();
          const candBuf = cand.kind === "image" ? await fs.readFile(cand.file) : await renderShot(b, cand, viewport);
          const refBuf = ref.kind === "image" ? await fs.readFile(ref.file) : await renderShot(b, ref, viewport);
          await fs.writeFile(path.join(shotsDir, `${safe}.candidate.png`), candBuf);
          await fs.writeFile(path.join(shotsDir, `${safe}.reference.png`), refBuf);
          const m = compareImages(decodePng(candBuf), decodePng(refBuf), { pixelTolerance, withDiff: true });
          if (m.diff && m.diffPixels) await fs.writeFile(path.join(shotsDir, `${safe}.diff.png`), encodePng(m.diff));
          record = {
            id: c.id, fingerprint, candidateDigest, referenceDigest,
            diffRatio: m.diffRatio, diffPixels: m.diffPixels, pixels: m.pixels,
            maxDelta: m.maxDelta, meanDelta: m.meanDelta,
            sizeMismatch: m.sizeMismatch || undefined,
            referenceSize: m.referenceSize, candidateSize: m.candidateSize,
            candidateShot: sha256(candBuf).slice(0, 16), referenceShot: sha256(refBuf).slice(0, 16),
            measuredAt: new Date().toISOString(),
          };
          break;
        } catch (e) {
          const msg = e.message.split("\n")[0];
          if (attempt === 1 && !(browser && browser.isConnected())) {
            relaunched++;
            console.log(`… ${c.id} — ${msg}  (the browser died; retrying this one with a fresh browser)`);
            continue;
          }
          record = { id: c.id, fingerprint, candidateDigest, referenceDigest, diffRatio: 1, error: msg, measuredAt: new Date().toISOString() };
        }
      }
      await appendLedger(ledgerFile, record);
      entries.set(c.id, record);
      done++;
      const v = verdict(record, c.threshold ?? threshold);
      console.log(`${v.pass ? "✓" : "✗"} ${c.id}  ${record.error ? record.error : pct(record.diffRatio)}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const r = report(components, entries, threshold);
  await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify({
    ranAt: new Date().toISOString(),
    // Relative to where the run was started, never absolute: a report is a file people
    // paste, and an absolute path carries the name of whoever ran it.
    root: path.relative(process.cwd(), ROOT) || ".",
    viewport, threshold, pixelTolerance, base: base || null,
    manifestComponents: manifestTotal, filtered: r.total !== manifestTotal,
    measuredNow: done, resumedFromLedger: skipped, browserRelaunches: relaunched,
    volatile,
    ...r,
  }, null, 2));
  if (skipped) console.log(`\nresumed: ${skipped} component(s) already measured in a previous run, ${done} measured now`);
  if (relaunched) console.log(`browser: replaced ${relaunched} time(s) mid-run`);
  if (volatile.length) {
    console.log(`\n${volatile.length} component(s) render from a URL with nothing on disk behind it, so they are re-measured every`);
    console.log(`run and never resumed: ${volatile.slice(0, 8).join(", ")}${volatile.length > 8 ? ", …" : ""}`);
    console.log('Give them "candidateSource"/"referenceSource" in the manifest to make them resumable.');
  }
  printReport(r, { gate, unverifiable: manifest.unverifiable || [], threshold, manifestTotal });
  console.log(`\nreport: ${path.join(RUN_DIR, "report.json")} · shots: ${path.join(RUN_DIR, "shots")}`);
  finish(r);
}

// Re-derive every verdict from the SAVED SHOTS, with no browser and no trust in the
// ledger's arithmetic. This is what makes the record auditable rather than merely
// tamper-evident-in-principle: a line whose diffRatio was edited disagrees with the
// pixels it claims to describe, and this says so by name.
async function audit(components, threshold, pixelTolerance, shotsDir, entries, manifest, manifestTotal) {
  const rebuilt = new Map();
  const discrepancies = [];
  for (const c of components) {
    const safe = c.id.replace(/[^a-z0-9]+/gi, "-");
    const cf = path.join(shotsDir, `${safe}.candidate.png`);
    const rf = path.join(shotsDir, `${safe}.reference.png`);
    if (!(await exists(cf)) || !(await exists(rf))) continue;
    const candBuf = await fs.readFile(cf), refBuf = await fs.readFile(rf);
    const m = compareImages(decodePng(candBuf), decodePng(refBuf), { pixelTolerance });
    const claimed = entries.get(c.id);
    rebuilt.set(c.id, { id: c.id, ...m, diff: undefined, measuredAt: claimed?.measuredAt ?? null, fingerprint: claimed?.fingerprint });
    if (claimed && typeof claimed.diffRatio === "number" && Math.abs(claimed.diffRatio - m.diffRatio) > 1e-9) {
      discrepancies.push(`${c.id}: ledger says ${pct(claimed.diffRatio)}, the shots say ${pct(m.diffRatio)}`);
    }
    if (claimed?.candidateShot && sha256(candBuf).slice(0, 16) !== claimed.candidateShot) {
      discrepancies.push(`${c.id}: the saved candidate shot is not the one the ledger recorded`);
    }
  }
  const r = report(components, rebuilt, threshold);
  console.log(`audit — every verdict re-derived from ${rebuilt.size} saved shot pair(s), no browser, ledger numbers not trusted`);
  printReport(r, { gate, unverifiable: manifest.unverifiable || [], threshold, manifestTotal });
  if (discrepancies.length) {
    console.log("\nLEDGER DISAGREES WITH THE PIXELS:");
    for (const d of discrepancies) console.log("  " + d);
    process.exitCode = 1;
    return;
  }
  console.log("\nledger agrees with the pixels on every measured component");
  finish(r);
}

// The exit code IS the answer, because the caller is an agent's shell loop and a printed
// table is not something a loop can read. With a gate, the gate alone decides — a canon at
// 99.4% of five hundred components is a canon that passed, and three stragglers are not a
// reason to report failure. Without one, any fail or any component the run never reached
// is a non-zero exit: silence is not a pass.
//
// It sets `process.exitCode` rather than calling `process.exit`, on purpose. An unattended
// run is read through a pipe (`refine … | tee`, an agent's captured stdout), and
// `process.exit` abandons whatever is still buffered on the way to that pipe — so the exit
// code and the report it is supposed to explain can disagree, and the table that vanished
// is the one a person would have needed. Letting the process end on its own flushes first.
function finish(r) {
  if (gate != null) {
    const met = r.passRate >= gate;
    console.log(`\nrefine: pass-rate ${pct(r.passRate)} ${met ? "meets" : "is below"} the gate ${pct(gate)}`);
    process.exitCode = met ? 0 : 1;
    return;
  }
  process.exitCode = r.failed || r.incomplete ? 1 : 0;
}

main().catch((e) => { console.error("refine: " + e.message); process.exitCode = 2; });
