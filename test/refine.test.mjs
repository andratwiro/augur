// The refine harness — the loop that decides whether a rebuilt component is finished, and
// refuses to take the rebuilder's word for it.
//
// WHAT THIS SUITE IS ACTUALLY DEFENDING. `scripts/refine.mjs` exists because an agent
// rebuilding a design system says "done" long before the components survive being looked
// at. So the harness renders, photographs and MEASURES, and the verdict is arithmetic on
// pixels. Every property below is one of the ways that promise could quietly stop being
// true — a stored verdict being believed, a run that resumes a crash as a permanent
// failure, a pass-rate quoted over a hand-picked subset, a torn file taking the night down.
//
// IT RUNS WITH NO BROWSER AND NO NETWORK. The end-to-end cases drive the real CLI over a
// canon of PNG references synthesised here, byte by byte, by the harness's own encoder.
// That is deliberate: `npm test` has to be runnable on a machine that has never downloaded
// a browser, and a committed corpus of screenshots is a corpus that rots. The browser path
// is one `renderShot` call away from what is exercised here — everything downstream of the
// pixels, which is everything that decides anything, is under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decodePng, encodePng } from "../scripts/lib/refine-png.mjs";
import { compareImages, verdict, DEFAULT_THRESHOLD, DEFAULT_PIXEL_TOLERANCE } from "../scripts/lib/refine-compare.mjs";
import { isFresh, readLedger, appendLedger, report, settingsFingerprint } from "../scripts/lib/refine-ledger.mjs";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const REFINE = path.join(ENGINE, "scripts", "refine.mjs");

const W = 40, H = 30;

/** A solid RGBA image. */
function solid(w, h, [r, g, b]) {
  const data = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = b; data[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** A dark block on white at a given left offset — the shape a padding change moves. */
function block(x) {
  const img = solid(W, H, [255, 255, 255]);
  for (let y = 10; y < 20; y++) {
    for (let px = x; px < x + 10; px++) {
      const o = (y * W + px) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
    }
  }
  return img;
}

function tmpCanon(components, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-refine-"));
  fs.mkdirSync(path.join(dir, "img"));
  const manifest = { viewport: { width: W, height: H }, ...extra, components: [] };
  for (const [id, cand, ref] of components) {
    fs.writeFileSync(path.join(dir, "img", `${id}.candidate.png`), encodePng(cand));
    fs.writeFileSync(path.join(dir, "img", `${id}.reference.png`), encodePng(ref));
    manifest.components.push({ id, candidate: `img/${id}.candidate.png`, reference: `img/${id}.reference.png` });
  }
  fs.writeFileSync(path.join(dir, "refine.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

const run = (dir, args = []) =>
  spawnSync(process.execPath, [REFINE, "--root", dir, ...args], { cwd: ENGINE, encoding: "utf8" });

const reportOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".augur-refine", "report.json"), "utf8"));
const ledgerPath = (dir) => path.join(dir, ".augur-refine", "ledger.jsonl");

// The three canons every end-to-end case is built from: one component that matches, one
// whose fill hue moved, one whose padding moved.
const SAME = ["same", solid(W, H, [46, 109, 246]), solid(W, H, [46, 109, 246])];
const HUE = ["hue", solid(W, H, [60, 109, 232]), solid(W, H, [46, 109, 246])];
const PADDING = ["padding", block(12), block(8)];

// ---------------------------------------------------------------- the PNG reader

test("a PNG survives the round trip this harness's own encoder and decoder make of it", () => {
  const img = block(8);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, W);
  assert.equal(back.height, H);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
});

test("THE READER REFUSES WHAT IT CANNOT READ, rather than decoding it to something plausible", () => {
  // A comparator handed a silently wrong decode reports a silently wrong number, which is
  // the exact failure the whole harness exists to prevent. Each of these throws by name.
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
  const png = encodePng(block(8));
  const sixteenBit = Buffer.from(png);
  sixteenBit[8 + 8 + 8] = 16; // IHDR bit depth
  assert.throws(() => decodePng(sixteenBit), /bit depth 16/);
  const interlaced = Buffer.from(png);
  interlaced[8 + 8 + 12] = 1; // IHDR interlace method
  assert.throws(() => decodePng(interlaced), /interlaced/);
});

// ---------------------------------------------------------------- the measurement

test("two identical renders measure zero, so the comparison is not merely always-fail", () => {
  const m = compareImages(solid(W, H, [46, 109, 246]), solid(W, H, [46, 109, 246]));
  assert.equal(m.diffPixels, 0);
  assert.equal(m.diffRatio, 0);
  assert.equal(verdict(m).state, "pass");
});

test("A WRONG HUE AND A SHIFTED PADDING LEAVE OPPOSITE SIGNATURES, which is why there are two numbers", () => {
  // A hue moves a LARGE NUMBER of pixels a SHORT way; a padding moves a SMALL NUMBER a
  // LONG way. A single mean delta hides both under a big flat background, so the harness
  // counts pixels over a per-pixel cutoff instead.
  const hue = compareImages(HUE[1], HUE[2]);
  const padding = compareImages(PADDING[1], PADDING[2]);

  assert.equal(hue.diffRatio, 1, "every pixel of a re-tinted fill differs");
  assert.ok(hue.maxDelta < 0.01, `the worst hue pixel barely moves (${hue.maxDelta})`);

  assert.ok(padding.diffRatio > DEFAULT_THRESHOLD, `a 4px shift clears the threshold (${padding.diffRatio})`);
  assert.ok(padding.diffRatio < 0.2, "and it is only the strips either side that move");
  // 0.93 rather than 1: the normaliser is the largest distance between ANY two colours,
  // and black-to-white is not it — the extremes of the I and Q axes are further apart.
  assert.ok(padding.maxDelta > 0.9, `black landing where white was is nearly the largest move there is (${padding.maxDelta})`);
  assert.ok(padding.maxDelta / hue.maxDelta > 100, "and it is orders of magnitude past the hue's worst pixel");

  for (const m of [hue, padding]) assert.equal(verdict(m).state, "fail");
});

test("the tolerances are tight enough for the hue to count at all", () => {
  // The widely-used per-pixel default of 0.1 puts the cutoff twenty-five times higher and
  // lets exactly this class of error through unremarked. If someone loosens the constant,
  // this is the case that goes quiet first.
  assert.equal(compareImages(HUE[1], HUE[2], { pixelTolerance: DEFAULT_PIXEL_TOLERANCE }).diffRatio, 1);
  assert.equal(compareImages(HUE[1], HUE[2], { pixelTolerance: 0.1 }).diffRatio, 0);
});

test("images of different sizes are a fail, never a comparison of their overlap", () => {
  const m = compareImages(solid(10, 10, [0, 0, 0]), solid(20, 20, [0, 0, 0]));
  assert.equal(m.sizeMismatch, true);
  assert.equal(m.diffRatio, 1);
  assert.match(verdict(m).reason, /size mismatch/);
});

// ---------------------------------------------------------------- no self-assessment

test("A STORED VERDICT IS NOT READ — the only thing that decides is the number", () => {
  // This is the mechanical form of the rule. A ledger line edited to claim a pass carries
  // a field nothing consults; the diffRatio beside it is what the report is drawn from.
  const forged = { id: "x", pass: true, verdict: "pass", ok: true, approved: true, diffRatio: 0.5 };
  assert.equal(verdict(forged, 0.02).state, "fail");
  const r = report([{ id: "x" }], new Map([["x", forged]]), 0.02);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 1);
});

test("a line with an opinion but no number is INCOMPLETE, never a pass", () => {
  assert.equal(verdict({ id: "x", pass: true }).state, "incomplete");
  assert.equal(verdict(null).state, "incomplete");
});

test("the pass-rate is over every component in the manifest, not over the ones that got measured", () => {
  // A run that fell over after one of three otherwise reports 100%, which is the most
  // flattering possible reading of a night that did not happen.
  const entries = new Map([["a", { id: "a", diffRatio: 0 }]]);
  const r = report([{ id: "a" }, { id: "b" }, { id: "c" }], entries, 0.02);
  assert.equal(r.passed, 1);
  assert.equal(r.incomplete, 2);
  assert.ok(Math.abs(r.passRate - 1 / 3) < 1e-9);
});

// ---------------------------------------------------------------- the ledger

test("a measurement is fresh only while both sides and the settings are unchanged", () => {
  const key = { candidateDigest: "c", referenceDigest: "r", fingerprint: "f" };
  assert.equal(isFresh({ diffRatio: 0, ...key }, key), true);
  assert.equal(isFresh({ diffRatio: 0, ...key, candidateDigest: "c2" }, key), false);
  assert.equal(isFresh({ diffRatio: 0, ...key, referenceDigest: "r2" }, key), false);
  assert.equal(isFresh({ diffRatio: 0, ...key, fingerprint: "f2" }, key), false);
  assert.equal(isFresh(undefined, key), false);
});

test("AN ERRORED LINE IS NEVER RESUMED AS A FAILURE — it is retried", () => {
  // A failed render records diffRatio 1 so it counts as failed rather than as missing,
  // which means it carries a number, and a number is what "already measured" is made of.
  // Without this, one browser crash at component 200 of 500 writes a permanent FAIL for
  // the remaining 300 and every resume afterwards skips them: the run reports 40% forever
  // and nothing re-renders.
  const key = { candidateDigest: "c", referenceDigest: "r", fingerprint: "f" };
  assert.equal(isFresh({ diffRatio: 1, error: "browser has been closed", ...key }, key), false);
});

test("A SIDE WITH NOTHING ON DISK BEHIND IT IS NEVER FRESH — two unknowns are not a match", () => {
  // A URL is not a description of its own contents. Digesting the STRING would make an
  // edited component keep its stale verdict forever, because the string never changes:
  // the component fixed at 2am would still be reported at its 11pm number in the morning.
  const both = { candidateDigest: null, referenceDigest: null, fingerprint: "f" };
  assert.equal(isFresh({ diffRatio: 0, ...both }, both), false);
  const half = { candidateDigest: "c", referenceDigest: null, fingerprint: "f" };
  assert.equal(isFresh({ diffRatio: 0, candidateDigest: "c", referenceDigest: "r", fingerprint: "f" }, half), false);
});

test("a settings change invalidates every entry, because the numbers were measured under the old ones", () => {
  const a = settingsFingerprint({ threshold: 0.02, viewport: { width: 10, height: 10 } });
  const b = settingsFingerprint({ threshold: 0.05, viewport: { width: 10, height: 10 } });
  assert.notEqual(a, b);
  // Key order is not a setting.
  assert.equal(a, settingsFingerprint({ viewport: { width: 10, height: 10 }, threshold: 0.02 }));
});

test("a torn final line is discarded, because that is the only sane reading of a killed run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "augur-refine-led-"));
  const file = path.join(dir, "ledger.jsonl");
  await appendLedger(file, { id: "a", diffRatio: 0 });
  await appendLedger(file, { id: "b", diffRatio: 0.5 });
  fs.appendFileSync(file, '{"id":"c","diffRat');
  const { entries, torn } = await readLedger(file);
  assert.equal(torn, 1);
  assert.equal(entries.size, 2);
  assert.equal(entries.get("b").diffRatio, 0.5);
});

// ---------------------------------------------------------------- end to end

test("A RUN PRODUCES A PER-COMPONENT PASS/FAIL REPORT and an exit code that carries it", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  const r = run(dir);
  assert.equal(r.status, 1, `a canon with two wrong components exits non-zero\n${r.stdout}${r.stderr}`);

  const rep = reportOf(dir);
  assert.equal(rep.total, 3);
  assert.equal(rep.passed, 1);
  assert.equal(rep.failed, 2);
  assert.equal(rep.incomplete, 0);
  const by = Object.fromEntries(rep.rows.map((x) => [x.id, x]));
  assert.equal(by.same.state, "pass");
  assert.equal(by.hue.state, "fail");
  assert.equal(by.padding.state, "fail");
  // The report is a MEASUREMENT, so every row carries the number it was decided by.
  for (const row of rep.rows) assert.equal(typeof row.diffRatio, "number");
  // And a pasted report never carries the absolute path of whoever ran it.
  assert.ok(!path.isAbsolute(rep.root), `report root should be relative, got ${rep.root}`);
  assert.match(r.stdout, /measured pass-rate .* at threshold/);
});

test("a clean canon passes, so a green run is a fact about the canon and not about the harness", () => {
  const dir = tmpCanon([SAME, ["same2", solid(W, H, [255, 255, 255]), solid(W, H, [255, 255, 255])]]);
  const r = run(dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(reportOf(dir).passRate, 1);
});

test("A SECOND RUN RESUMES: nothing is re-measured and the numbers do not move", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  run(dir);
  const first = reportOf(dir);
  assert.equal(first.measuredNow, 3);
  assert.equal(first.resumedFromLedger, 0);

  const second = run(dir);
  const rep = reportOf(dir);
  assert.equal(rep.measuredNow, 0);
  assert.equal(rep.resumedFromLedger, 3);
  assert.equal(rep.passed, first.passed);
  assert.equal(rep.failed, first.failed);
  assert.match(second.stdout, /resumed: 3 component\(s\) already measured/);
});

test("a run KILLED partway through picks up where it stopped, not at the beginning", () => {
  // The overnight property, in miniature: truncate the ledger to one line — what a kill
  // between components leaves behind — and the next run measures the other two only.
  const dir = tmpCanon([SAME, HUE, PADDING]);
  run(dir);
  const lines = fs.readFileSync(ledgerPath(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  fs.writeFileSync(ledgerPath(dir), lines[0] + "\n" + lines[1].slice(0, 30)); // one whole line + a torn one
  const r = run(dir);
  const rep = reportOf(dir);
  assert.equal(rep.resumedFromLedger, 1);
  assert.equal(rep.measuredNow, 2);
  assert.equal(rep.passed, 1);
  assert.equal(rep.failed, 2);
  assert.match(r.stdout, /torn line\(s\) from an interrupted run/);
});

test("editing ONE component re-verifies that one and skips the rest", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  run(dir);
  fs.writeFileSync(path.join(dir, "img", "padding.candidate.png"), encodePng(block(8))); // now correct
  const r = run(dir);
  const rep = reportOf(dir);
  assert.equal(rep.measuredNow, 1, `${r.stdout}${r.stderr}`);
  assert.equal(rep.resumedFromLedger, 2);
  assert.equal(rep.rows.find((x) => x.id === "padding").state, "pass");
});

test("loosening the threshold re-measures EVERYTHING, so a moved bar is never silently reused", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  run(dir);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "refine.json"), "utf8"));
  m.threshold = 0.5;
  fs.writeFileSync(path.join(dir, "refine.json"), JSON.stringify(m));
  const r = run(dir);
  const rep = reportOf(dir);
  assert.equal(rep.measuredNow, 3);
  assert.equal(rep.threshold, 0.5);
  // …and the loosened bar is printed on the same line as the rate it produced.
  assert.match(r.stdout, /at threshold 50\.00%/);
});

test("--restart throws the ledger away and measures the whole canon again", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  run(dir);
  run(dir, ["--restart"]);
  assert.equal(reportOf(dir).measuredNow, 3);
});

test("--audit RE-DERIVES EVERY VERDICT FROM THE SAVED SHOTS and names a ledger that lies", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  run(dir);
  // Edit the record to claim the padding component matched perfectly.
  const doctored = fs.readFileSync(ledgerPath(dir), "utf8").trim().split("\n").map((l) => {
    const rec = JSON.parse(l);
    if (rec.id === "padding") { rec.diffRatio = 0; rec.diffPixels = 0; }
    return JSON.stringify(rec);
  }).join("\n") + "\n";
  fs.writeFileSync(ledgerPath(dir), doctored);

  // The plain report believes the ledger's arithmetic — that is what --audit is for.
  const audited = run(dir, ["--audit"]);
  assert.equal(audited.status, 1);
  assert.match(audited.stdout, /LEDGER DISAGREES WITH THE PIXELS/);
  assert.match(audited.stdout, /padding: ledger says 0\.00%, the shots say/);
});

test("--audit needs no browser and agrees with an honest ledger", () => {
  const dir = tmpCanon([SAME]);
  run(dir);
  const audited = run(dir, ["--audit"]);
  assert.equal(audited.status, 0, `${audited.stdout}${audited.stderr}`);
  assert.match(audited.stdout, /ledger agrees with the pixels/);
});

test("A GATE OVER A HAND-PICKED SUBSET IS REFUSED, because that is a claim wearing a measurement's clothes", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  const r = run(dir, ["--only", "same", "--gate", "0.99"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--gate and --only cannot be combined/);
});

test("--only still says, in the report, that the rate is not the canon's", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  const r = run(dir, ["--only", "same"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FILTERED: 1 of 3 components/);
  const rep = reportOf(dir);
  assert.equal(rep.filtered, true);
  assert.equal(rep.manifestComponents, 3);
});

test("a gate is what the run's exit code answers to — one stubborn component is not a failed night", () => {
  const dir = tmpCanon([SAME, HUE, PADDING]);
  assert.equal(run(dir, ["--gate", "0.9"]).status, 1, "two of three is below 90%");
  assert.equal(run(dir, ["--gate", "0.3"]).status, 0, "one of three clears 30%");
  assert.equal(run(dir, ["--gate", "99"]).status, 2, "a gate is a fraction, not a percentage");
});

test("a manifest with no components is refused rather than reported as a perfect canon", () => {
  const dir = tmpCanon([SAME]);
  fs.writeFileSync(path.join(dir, "refine.json"), JSON.stringify({ components: [] }));
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a verified canon/);
});

test("a reference that is not there is recorded against the component, not swallowed", () => {
  const dir = tmpCanon([SAME]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "refine.json"), "utf8"));
  m.components.push({ id: "missing", candidate: "img/same.candidate.png", reference: "img/nope.png" });
  fs.writeFileSync(path.join(dir, "refine.json"), JSON.stringify(m));
  const r = run(dir);
  assert.equal(r.status, 1);
  const row = reportOf(dir).rows.find((x) => x.id === "missing");
  assert.equal(row.state, "error");
  assert.match(row.reason, /does not exist/);
});

// ---------------------------------------------------------------- the sample canon

// `docs/canon-refine.md` tells a reader to run `augur refine --root test/fixtures/canon`
// and promises what they will see. Nothing else reads that folder — it needs a browser —
// so without these two cases it is free to rot into a sample that demonstrates nothing.
test("the sample canon the docs point at is complete: every component has both sides", () => {
  const root = path.join(ENGINE, "test", "fixtures", "canon");
  const m = JSON.parse(fs.readFileSync(path.join(root, "refine.json"), "utf8"));
  assert.equal(m.components.length, 14);
  for (const c of m.components) {
    for (const side of ["candidate", "reference"]) {
      assert.ok(fs.existsSync(path.join(root, c[side], "index.html")), `${c.id}: ${side} has no index.html`);
    }
  }
});

test("AND IT IS STILL WRONG IN THE TWO WAYS IT IS SUPPOSED TO BE WRONG", () => {
  // A sample canon someone "fixed" is a sample canon that proves the harness catches
  // nothing. The two deliberate errors are the whole point of shipping it.
  const root = path.join(ENGINE, "test", "fixtures", "canon");
  const read = (p) => fs.readFileSync(path.join(root, p, "index.html"), "utf8");

  // Shifted padding: the rebuild says 28px 20px 12px where the original says 20px.
  assert.match(read("candidate/summary-card"), /padding:28px 20px 12px/);
  assert.ok(!/padding:28px 20px 12px/.test(read("original/summary-card")));

  // Wrong hue: a blue-tinted banner fill rebuilt as a green-tinted one.
  assert.match(read("original/notice-banner"), /#dbe9ff/);
  assert.match(read("candidate/notice-banner"), /#dbe9e2/);
  assert.ok(!/#dbe9ff/.test(read("candidate/notice-banner")));
});

test("a site path with no --base is refused by name, not rendered as a file", () => {
  const dir = tmpCanon([SAME]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "refine.json"), "utf8"));
  m.components.push({ id: "served", candidate: "/components/card/", reference: "img/same.reference.png" });
  fs.writeFileSync(path.join(dir, "refine.json"), JSON.stringify(m));
  const row = (run(dir), reportOf(dir)).rows.find((x) => x.id === "served");
  assert.equal(row.state, "error");
  assert.match(row.reason, /pass --base/);
});
