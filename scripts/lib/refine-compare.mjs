// refine-compare — the measurement the refine harness reports, and the only thing that
// decides a component's verdict.
//
// THE RULE THIS FILE ENFORCES: no self-assessment. A verdict is `diffRatio <= threshold`
// computed from two images, and nothing else. There is no argument, no field and no file
// through which an agent's opinion of its own work reaches the answer — `verdict()` takes
// pixels and a number. Anything that reads a stored verdict must re-derive it here (see
// `refine-ledger.mjs`, which stores measurements and never a pass).
//
// THE METRIC. Per pixel, the YIQ-weighted colour distance — the same perceptual delta the
// well-known browser-screenshot comparators use — against `pixelTolerance`; then the
// fraction of pixels that exceed it, against `threshold`. Two numbers rather than one
// because they catch different lies: a shifted padding moves a large NUMBER of pixels a
// long way, and a wrong hue moves a large number of pixels a SHORT way. A single mean
// delta hides both under a big flat background.
//
// IT IS DELIBERATELY NAIVE ABOUT ANTIALIASING, and that is a posture, not an oversight.
// Antialiasing-aware comparators exist so that a golden PNG captured on one machine can
// be compared against a render on another. This harness would rather not be in that
// business at all: in `source`/`url` reference mode both sides are rendered by the same
// browser in the same run, so text antialiasing is byte-identical and there is nothing to
// forgive — and a comparator that forgives nothing is the sensitive one. The cost is
// stated where it is paid: an `image` reference captured on another machine WILL produce
// font-edge noise here, and `docs/canon-refine.md` says to keep the threshold for that
// mode empirical rather than hopeful.

import { decodePng, encodePng } from "./refine-png.mjs";

// Largest possible squared YIQ distance between two 8-bit colours, used to normalise.
const MAX_YIQ_DELTA = 35215;

// THE TWO NUMBERS, AND WHY THESE ONES.
//
// `pixelTolerance` 0.02 puts the per-pixel cutoff at 35215 · 0.02² ≈ 14.1 squared YIQ
// units. In plain terms that forgives a uniform grey shift of about five levels out of
// 255 and catches six — tight, because in same-run mode two renders of the same thing are
// bit-identical and there is nothing legitimate to forgive. The widely-used default of 0.1
// was measured against this fixture and was too loose to be worth running: it puts the
// cutoff at 352, which lets a twenty-level channel error through unremarked, and a wrong
// hue is exactly a twenty-level channel error.
//
// `threshold` 0.02 lets 2% of a frame differ before the component fails. It is a fraction
// of the FRAME, so it only means anything if the component fills the frame — a small
// component photographed on a large empty page can be badly wrong in 1% of the pixels and
// pass. Size each component's viewport to the component. `docs/canon-refine.md` repeats
// this because it is the one way to get a green run that means nothing.
export const DEFAULT_THRESHOLD = 0.02;       // ≤2% of the frame may differ
export const DEFAULT_PIXEL_TOLERANCE = 0.02; // how far one pixel may move before it counts

const y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const i = (r, g, b) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
const q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

/** Composite an RGBA sample over white, because a screenshot's transparent pixels are what the page shows through. */
function flatten(data, p) {
  const a = data[p + 3] / 255;
  return [
    data[p] * a + 255 * (1 - a),
    data[p + 1] * a + 255 * (1 - a),
    data[p + 2] * a + 255 * (1 - a),
  ];
}

/**
 * Compare two decoded images.
 *
 * Returns `{width, height, pixels, diffPixels, diffRatio, maxDelta, meanDelta, diff}`
 * where the deltas are normalised 0..1 and `diff` is an RGBA buffer marking every
 * counted pixel — for a human to look at AFTER the fact, never for the verdict.
 */
export function compareImages(a, b, { pixelTolerance = DEFAULT_PIXEL_TOLERANCE, withDiff = false } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sizeMismatch: true,
      width: a.width, height: a.height,
      referenceSize: `${b.width}x${b.height}`, candidateSize: `${a.width}x${a.height}`,
      pixels: 0, diffPixels: 0, diffRatio: 1, maxDelta: 1, meanDelta: 1, diff: null,
    };
  }
  const pixels = a.width * a.height;
  const cutoff = MAX_YIQ_DELTA * pixelTolerance * pixelTolerance;
  const diff = withDiff ? Buffer.alloc(pixels * 4) : null;
  let diffPixels = 0, maxDelta = 0, sumDelta = 0;

  for (let p = 0; p < pixels; p++) {
    const o = p * 4;
    const [ar, ag, ab] = flatten(a.data, o);
    const [br, bg, bb] = flatten(b.data, o);
    const dy = y(ar, ag, ab) - y(br, bg, bb);
    const di = i(ar, ag, ab) - i(br, bg, bb);
    const dq = q(ar, ag, ab) - q(br, bg, bb);
    const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
    if (delta > maxDelta) maxDelta = delta;
    sumDelta += delta;
    const counted = delta > cutoff;
    if (counted) diffPixels++;
    if (diff) {
      if (counted) { diff[o] = 255; diff[o + 1] = 0; diff[o + 2] = 200; diff[o + 3] = 255; }
      else {
        // Ghost the reference so the marks have somewhere to sit.
        const grey = Math.round(255 - (255 - y(br, bg, bb)) * 0.15);
        diff[o] = diff[o + 1] = diff[o + 2] = grey; diff[o + 3] = 255;
      }
    }
  }
  return {
    sizeMismatch: false,
    width: a.width, height: a.height, pixels, diffPixels,
    diffRatio: diffPixels / pixels,
    maxDelta: maxDelta / MAX_YIQ_DELTA,
    meanDelta: sumDelta / pixels / MAX_YIQ_DELTA,
    diff: diff ? { width: a.width, height: a.height, data: diff } : null,
  };
}

/** Same, from PNG bytes. */
export function comparePngs(candidateBuf, referenceBuf, opts) {
  return compareImages(decodePng(candidateBuf), decodePng(referenceBuf), opts);
}

/**
 * The verdict. Derived, never stored, never supplied.
 *
 * A measurement with no `diffRatio` is not a pass and not a fail — it is `incomplete`,
 * so a ledger line that carries an opinion but no number can never be mistaken for work
 * that was done.
 */
export function verdict(measurement, threshold = DEFAULT_THRESHOLD) {
  if (!measurement || typeof measurement.diffRatio !== "number" || !Number.isFinite(measurement.diffRatio)) {
    return { state: "incomplete", pass: false, reason: "no measurement" };
  }
  if (measurement.error) return { state: "error", pass: false, reason: measurement.error };
  if (measurement.sizeMismatch) {
    return { state: "fail", pass: false, reason: `size mismatch — reference ${measurement.referenceSize}, candidate ${measurement.candidateSize}` };
  }
  const pass = measurement.diffRatio <= threshold;
  return { state: pass ? "pass" : "fail", pass, reason: pass ? "" : `${(measurement.diffRatio * 100).toFixed(2)}% of pixels differ (threshold ${(threshold * 100).toFixed(2)}%)` };
}

export { encodePng, decodePng };
