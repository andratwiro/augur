#!/usr/bin/env node
/*
 * review.mjs — read & moderate prototype review comments straight from production.
 *
 * The user just drops pins on the live site (Shift+C → click an element → type).
 * This tool reads them directly from the worker's secret-guarded export endpoint
 * (no site password needed) and can resolve/close threads once addressed.
 *
 * Requires in .env.deploy (gitignored):
 *   REVIEW_SITE_URL=https://govocal-prototypes.pages.dev
 *   REVIEW_EXPORT_KEY=<same value set as the Pages REVIEW_EXPORT_KEY secret>
 *
 * Usage:
 *   node scripts/review.mjs                 # list every thread (rich: anchor, view, position, messages)
 *   node scripts/review.mjs --open          # only unresolved threads
 *   node scripts/review.mjs resolve <path> <id> ["note"]  # mark resolved (+ optional reply explaining the fix)
 *   node scripts/review.mjs reply   <path> <id> "note"    # post a reply without resolving
 *   node scripts/review.mjs reopen  <path> <id>   # mark it open again
 *   node scripts/review.mjs delete  <path> <id>   # remove a thread
 *
 * Convention: when resolving, pass a very brief note saying HOW it was fixed — it
 * posts as a "Claude" reply on the thread so the reviewer sees the resolution inline.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = await fs.readFile(path.join(ROOT, ".env.deploy"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return env;
}

function fmt(iso) {
  try { return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso || ""; }
}

async function main() {
  const env = await loadEnv();
  const base = (env.REVIEW_SITE_URL || "").replace(/\/$/, "");
  const key = env.REVIEW_EXPORT_KEY;
  if (!base || !key) {
    console.error("Missing REVIEW_SITE_URL / REVIEW_EXPORT_KEY in .env.deploy.");
    process.exit(1);
  }
  const exportUrl = `${base}/__review/api/export?key=${encodeURIComponent(key)}`;
  const [cmd, argPath, argId, argNote] = process.argv.slice(2).filter((a) => a !== "--open");
  const openOnly = process.argv.includes("--open");

  const postOp = async (op) => {
    const res = await fetch(exportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(op),
    });
    if (!res.ok) { console.error(`Failed: ${res.status} ${res.statusText}`); process.exit(1); }
    return res.json();
  };

  // ---- moderation ops (resolve / reopen / delete / reply) ----
  if (cmd === "resolve" || cmd === "reopen" || cmd === "delete" || cmd === "reply") {
    if (!argPath || !argId || (cmd === "reply" && !argNote)) {
      console.error(`Usage: node scripts/review.mjs ${cmd} <path> <id>${cmd === "reply" ? ' "note"' : cmd === "resolve" ? ' ["note"]' : ""}`);
      process.exit(1);
    }
    // Post the explanation reply first (resolve w/ note, or a bare reply).
    if ((cmd === "resolve" || cmd === "reply") && argNote) {
      await postOp({ path: argPath, op: "reply", id: argId,
        message: { author: "Claude", body: argNote, at: new Date().toISOString() } });
    }
    if (cmd === "reply") {
      console.log(`✓ replied on ${argId} (${argPath}).`);
      return;
    }
    const op = cmd === "delete"
      ? { path: argPath, op: "delete", id: argId }
      : { path: argPath, op: "resolve", id: argId, resolved: cmd === "resolve" };
    const data = await postOp(op);
    console.log(`✓ ${cmd} ${argId} on ${argPath}${argNote ? " (+note)" : ""} — ${(data.threads || []).length} thread(s) remain on that page.`);
    return;
  }

  // ---- read ----
  const res = await fetch(exportUrl);
  if (!res.ok) { console.error(`Export failed: ${res.status} ${res.statusText}`); process.exit(1); }
  const data = await res.json();
  const pages = data.pages || {};
  const keys = Object.keys(pages).filter((p) => (pages[p] || []).length).sort();
  console.log(`Review comments — pulled ${fmt(data.generatedAt)} from ${base}\n`);
  const isAnno = (t) => !!t.annotation;
  let total = 0, open = 0, annos = 0;
  if (!keys.length) { console.log("No comments yet."); return; }
  for (const p of keys) {
    // Annotations are always-on dev-delivery notes, not feedback — never list them
    // as actionable. --open hides them; the full list shows them flagged.
    const threads = (pages[p] || []).filter((t) => (openOnly ? (!t.resolved && !isAnno(t)) : true));
    if (!threads.length) continue;
    console.log(`══ ${p}`);
    threads.forEach((t) => {
      total++;
      if (isAnno(t)) annos++; else if (!t.resolved) open++;
      const pos = (t.fx || t.fy)
        ? `at ${Math.round(t.fx * 100)}%×${Math.round(t.fy * 100)}% of the element`
        : `page ${Math.round(t.px)},${Math.round(t.py)}`;
      const badge = isAnno(t) ? "📌 ANNOTATION (dev note — do NOT resolve)" : (t.resolved ? "✅" : "🟠");
      console.log(`  • ${badge} id=${t.id}`);
      console.log(`      module: ${t.sel || "(page)"}`);
      console.log(`      view:   ${t.view || "(base)"}    pin: ${pos}`);
      (t.messages || []).forEach((m) => console.log(`      “${m.body}”  — ${m.author}, ${fmt(m.at)}`));
    });
    console.log("");
  }
  console.log(`${total} thread(s)${openOnly ? "" : `, ${open} open comment(s), ${annos} annotation(s)`}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
