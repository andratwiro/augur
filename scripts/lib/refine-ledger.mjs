// refine-ledger — the record that makes a refine run resumable, and auditable.
//
// WHY APPEND-ONLY JSONL AND NOT A JSON FILE. A run over five hundred components is an
// overnight run, and an overnight run gets killed: the laptop sleeps, the socket drops,
// the agent's own process is stopped. Rewriting one JSON document after each component
// means five hundred chances to be interrupted mid-write and lose the whole record; one
// appended line per component means the worst a kill can cost is the line being written.
// A torn final line is DISCARDED on read rather than crashing the next run, which is the
// only sane reading of a file that a `kill -9` was allowed to end.
//
// WHAT A LINE HOLDS: a measurement and the digests of the two images it was measured
// from. WHAT IT NEVER HOLDS: a verdict. Pass and fail are derived by
// `refine-compare.mjs#verdict` every time the report is drawn, so a line edited to say
// `"pass": true` changes nothing at all — the field is not read. That is the mechanical
// form of "no self-assessment": there is no key an agent can write to make its own work
// count as done, and `--audit` re-measures from the saved PNGs to catch a line whose
// NUMBER was edited instead.
//
// RESUME IS BY CONTENT, NOT BY POSITION. A component is skipped only when the ledger
// already holds a completed measurement for it whose candidate digest, reference digest
// and settings fingerprint all still match. So a re-run after editing one component
// re-verifies that one and skips the other four hundred and ninety-nine, and a re-run
// after changing the threshold re-verifies everything, because the settings changed.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { verdict } from "./refine-compare.mjs";

export const LEDGER_NAME = "ledger.jsonl";

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** A stable digest of a settings object — what invalidates every entry when it changes. */
export function settingsFingerprint(settings) {
  const ordered = Object.keys(settings).sort().reduce((o, k) => (o[k] = settings[k], o), {});
  return sha256(JSON.stringify(ordered)).slice(0, 16);
}

/**
 * Content digest of a folder or file. Names AND bytes, so a renamed file counts as a
 * change; mtime is deliberately not read, because a fresh clone rewrites every mtime and
 * would invalidate a whole ledger for no reason.
 */
export async function contentDigest(target) {
  const h = crypto.createHash("sha256");
  const walk = async (p, rel) => {
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(p)).sort()) {
        if (name.startsWith(".")) continue;
        await walk(path.join(p, name), rel ? `${rel}/${name}` : name);
      }
    } else {
      h.update(rel + "\0");
      h.update(await fs.readFile(p));
    }
  };
  await walk(target, "");
  return h.digest("hex").slice(0, 16);
}

/** Read a ledger, tolerating a torn final line. Later lines win over earlier ones for the same id. */
export async function readLedger(file) {
  let text = "";
  try { text = await fs.readFile(file, "utf8"); } catch { return { entries: new Map(), lines: 0, torn: 0 }; }
  const entries = new Map();
  let lines = 0, torn = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let rec;
    try { rec = JSON.parse(line); } catch { torn++; continue; }
    if (rec && typeof rec.id === "string") entries.set(rec.id, rec);
  }
  return { entries, lines, torn };
}

/**
 * Append one measurement. Opened, written and closed per call with an fsync, so the line
 * is on disk before the next component starts rendering — the property the whole resume
 * story rests on.
 */
export async function appendLedger(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, "a");
  try {
    await fh.write(JSON.stringify(record) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Is this ledger entry still a usable answer for this component, under these settings? */
export function isFresh(entry, { candidateDigest, referenceDigest, fingerprint }) {
  if (!entry || typeof entry.diffRatio !== "number") return false;
  // ⚠️ AN ERRORED LINE IS NEVER FRESH, and this is not a nicety. A failed render records
  // `diffRatio: 1` so the component counts as failed rather than as missing — which means
  // it carries a number, and a number is what "already measured" is made of. Without this
  // line, the browser dying at component 200 of 500 writes a permanent FAIL for the other
  // 300, and every resume afterwards skips them because the ledger looks complete. The
  // overnight run then reports 40% forever and nothing re-renders. A transient failure has
  // to be retried by the next run; a real one costs a re-render and says the same thing.
  if (entry.error) return false;
  if (entry.fingerprint !== fingerprint) return false;
  // No digest means the caller could not tell what this side is made of — a URL with
  // nothing on disk behind it. Two nulls must never compare equal and count as unchanged:
  // that is how a component fixed at 2am keeps its 11pm verdict all night.
  if (!candidateDigest || !referenceDigest) return false;
  if (entry.candidateDigest !== candidateDigest) return false;
  if (entry.referenceDigest !== referenceDigest) return false;
  return true;
}

/**
 * Turn a ledger into the per-component report. Verdicts are computed HERE, from the
 * numbers, every time — a stored `pass` field is not consulted and never will be.
 */
export function report(components, entries, threshold) {
  const rows = components.map((c) => {
    const e = entries.get(c.id);
    const v = verdict(e, c.threshold ?? threshold);
    return {
      id: c.id,
      state: v.state,
      pass: v.pass,
      reason: v.reason,
      diffRatio: e && typeof e.diffRatio === "number" ? e.diffRatio : null,
      diffPixels: e?.diffPixels ?? null,
      pixels: e?.pixels ?? null,
      maxDelta: e?.maxDelta ?? null,
      threshold: c.threshold ?? threshold,
      measuredAt: e?.measuredAt ?? null,
    };
  });
  const measured = rows.filter((r) => r.state !== "incomplete");
  const passed = rows.filter((r) => r.pass);
  return {
    total: rows.length,
    measured: measured.length,
    passed: passed.length,
    failed: measured.length - passed.length,
    incomplete: rows.length - measured.length,
    // The pass-rate is over EVERY component in the manifest, not over the ones that got
    // measured. A run that fell over after ten of five hundred otherwise reports 100%.
    passRate: rows.length ? passed.length / rows.length : 0,
    rows,
  };
}
