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
 *   node scripts/review.mjs resolve <path> <id>   # mark one thread resolved
 *   node scripts/review.mjs reopen  <path> <id>   # mark it open again
 *   node scripts/review.mjs delete  <path> <id>   # remove a thread
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
  const [cmd, argPath, argId] = process.argv.slice(2).filter((a) => a !== "--open");
  const openOnly = process.argv.includes("--open");

  // ---- moderation ops (resolve / reopen / delete) ----
  if (cmd === "resolve" || cmd === "reopen" || cmd === "delete") {
    if (!argPath || (cmd !== "delete" && !argId) || (cmd === "delete" && !argId)) {
      console.error(`Usage: node scripts/review.mjs ${cmd} <path> <id>`);
      process.exit(1);
    }
    const op = cmd === "delete"
      ? { path: argPath, op: "delete", id: argId }
      : { path: argPath, op: "resolve", id: argId, resolved: cmd === "resolve" };
    const res = await fetch(exportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(op),
    });
    if (!res.ok) { console.error(`Failed: ${res.status} ${res.statusText}`); process.exit(1); }
    const data = await res.json();
    console.log(`✓ ${cmd} ${argId} on ${argPath} — ${(data.threads || []).length} thread(s) remain on that page.`);
    return;
  }

  // ---- read ----
  const res = await fetch(exportUrl);
  if (!res.ok) { console.error(`Export failed: ${res.status} ${res.statusText}`); process.exit(1); }
  const data = await res.json();
  const pages = data.pages || {};
  const keys = Object.keys(pages).filter((p) => (pages[p] || []).length).sort();
  console.log(`Review comments — pulled ${fmt(data.generatedAt)} from ${base}\n`);
  let total = 0, open = 0;
  if (!keys.length) { console.log("No comments yet."); return; }
  for (const p of keys) {
    const threads = (pages[p] || []).filter((t) => (openOnly ? !t.resolved : true));
    if (!threads.length) continue;
    console.log(`══ ${p}`);
    threads.forEach((t) => {
      total++; if (!t.resolved) open++;
      const pos = (t.fx || t.fy)
        ? `at ${Math.round(t.fx * 100)}%×${Math.round(t.fy * 100)}% of the element`
        : `page ${Math.round(t.px)},${Math.round(t.py)}`;
      console.log(`  • ${t.resolved ? "✅" : "🟠"} id=${t.id}`);
      console.log(`      module: ${t.sel || "(page)"}`);
      console.log(`      view:   ${t.view || "(base)"}    pin: ${pos}`);
      (t.messages || []).forEach((m) => console.log(`      “${m.body}”  — ${m.author}, ${fmt(m.at)}`));
    });
    console.log("");
  }
  console.log(`${total} thread(s)${openOnly ? "" : `, ${open} open`}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
