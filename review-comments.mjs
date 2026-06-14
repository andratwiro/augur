#!/usr/bin/env node
/*
 * review-comments.mjs — pull all prototype review comments from production and
 * write them to a gitignored Markdown file Claude (or anyone) can read.
 *
 * Reads from the worker's secret-guarded export endpoint, so it does NOT need
 * the Cloudflare API token's KV permission — only the export key.
 *
 * Requires in .env.deploy (gitignored):
 *   REVIEW_SITE_URL=https://govocal-prototypes.pages.dev
 *   REVIEW_EXPORT_KEY=<same value set as the Pages REVIEW_EXPORT_KEY secret>
 *
 * Usage: npm run comments   (writes review-comments.local.md and prints a summary)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, "review-comments.local.md");

// Minimal .env.deploy parser (KEY=VALUE lines; ignores comments/blanks).
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
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  } catch { return iso || ""; }
}

async function main() {
  const env = await loadEnv();
  const base = (env.REVIEW_SITE_URL || "").replace(/\/$/, "");
  const key = env.REVIEW_EXPORT_KEY;
  if (!base || !key) {
    console.error("Missing REVIEW_SITE_URL or REVIEW_EXPORT_KEY in .env.deploy — comments not configured yet.");
    process.exit(1);
  }

  const url = `${base}/__review/api/export?key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Export request failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = await res.json();
  const pages = data.pages || {};
  const paths = Object.keys(pages).filter((p) => (pages[p] || []).length).sort();

  // Dev-facing pipeline. "in_progress" is the default (absent key), so it's not listed.
  const STATUS_LABELS = {
    playground: "Playground",
    in_progress: "In progress",
    dev_ready: "Dev ready",
    shipped: "Shipped",
    parked: "Parked",
  };
  const STATUS_ORDER = ["playground", "dev_ready", "shipped", "parked"];
  const statuses = data.statuses || {};
  const byStatus = (s) => Object.keys(statuses).filter((p) => statuses[p] === s).sort();
  // Parked + Shipped are the cue to roll learnings into GOVOCAL.md §13.
  const rollup = [...byStatus("parked"), ...byStatus("shipped")].sort();

  const statusLines = STATUS_ORDER.flatMap((s) => {
    const paths = byStatus(s);
    if (!paths.length) return [];
    return [`**${STATUS_LABELS[s]}**`, ...paths.map((p) => `- \`${p}\``), ""];
  });

  const lines = [
    "# GoVocal prototype review comments",
    "",
    `_Pulled ${fmt(data.generatedAt || new Date().toISOString())} from ${base}_`,
    "",
    "## Prototype statuses",
    "",
    ...(statusLines.length ? statusLines : ["_All prototypes are In progress (the default)._", ""]),
    rollup.length
      ? `> ℹ️ **Roll learnings into \`GOVOCAL.md\` §13** for these Parked/Shipped prototypes if not done:\n${rollup.map((p) => `> - \`${p}\``).join("\n")}`
      : "",
    "",
  ];
  let total = 0, open = 0;
  if (!paths.length) lines.push("_No comments yet._");
  for (const p of paths) {
    lines.push(`## ${p}`, "");
    pages[p].forEach((t, i) => {
      total++;
      if (!t.resolved) open++;
      const where = t.sel ? ` — \`${t.sel}\`` : "";
      lines.push(`### Pin ${i + 1}${t.resolved ? " ✅ resolved" : ""}${where}`);
      (t.messages || []).forEach((m) => {
        lines.push(`- **${m.author}** · ${fmt(m.at)}`);
        lines.push(`  ${(m.body || "").replace(/\n/g, "\n  ")}`);
      });
      lines.push("");
    });
  }

  await fs.writeFile(OUT, lines.join("\n"), "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT)} — ${total} thread(s), ${open} open, across ${paths.length} prototype(s).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
