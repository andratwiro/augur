// The canon: names resolve, and a promotion needs no hand-edit afterwards.
//
// WHAT IS ACTUALLY AT RISK. "Pull screens X, Y and Z" is the instruction a design system
// exists to make answerable, and it presumes X names something an agent can find COLD. Two
// things break that, and neither is visible by looking at the site:
//
//   1. A name drifts (`checkout-v2`, `new_Checkout`, a scratch folder wearing a canonical
//      name) and the instruction stops resolving.
//   2. A promotion carries a design-system reference written for the depth the page USED to
//      sit at. The build rewrites that reference on the way into dist, so the site looks
//      perfect — and the file opens unstyled from disk, which is where an agent reads it.
//      This is the hand-edit `canon save` exists to remove, so it is the one asserted
//      hardest here: not that the string changed, but that the rewritten path RESOLVES.
//
// Everything below drives the shipped `scripts/canon.mjs` as a subprocess against a real
// copy of the seed workspace. Nothing is paraphrased: what is asserted is what will run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANON = path.join(ROOT, "scripts", "canon.mjs");
const SEED = path.join(ROOT, "seed");
const TIERS = ["base", "components", "patterns", "pages"];

/** A throwaway copy of the seed — a genuine buildable workspace, prototypes three deep. */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-"));
  const root = path.join(dir, "starter");
  fs.cpSync(SEED, root, { recursive: true });
  return root;
}

const canon = (root, ...args) =>
  spawnSync(process.execPath, [CANON, ...args], { cwd: root, encoding: "utf8" });

const PROTO = "worked-examples/prototypes/specimen-viewer";

/** Every `skills/<x>/…` reference in a page, paired with whether it resolves from there. */
function skillRefs(file) {
  const html = fs.readFileSync(file, "utf8");
  const out = [];
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']((?:\.\.\/)+skills\/[^"']+)["']/gi))
    out.push({ ref: m[1], resolves: fs.existsSync(path.resolve(path.dirname(file), m[1])) });
  return out;
}

// ── The tiers are the build's, not this command's ────────────────────────────

test("the four tiers are exactly the directories build.js scans at a workspace root", () => {
  const build = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  for (const tier of TIERS)
    assert.match(
      build,
      new RegExp(String.raw`path\.join\(space\.root,\s*["']${tier}["']\)`),
      `build.js no longer scans ${tier}/ — the canon would name a directory nothing publishes`,
    );
});

// ── The workspace's own note ─────────────────────────────────────────────────

test("seed/CANON.md is byte-for-byte what a promotion writes into a workspace that has none", () => {
  const root = workspace();
  fs.rmSync(path.join(root, "CANON.md"));
  const r = canon(root, "save", PROTO);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, "CANON.md"), "utf8"),
    fs.readFileSync(path.join(SEED, "CANON.md"), "utf8"),
    "the seed's CANON.md and the one `augur canon save` writes have drifted — regenerate the seed copy from the NOTE string in scripts/canon.mjs",
  );
});

test("the note names every tier and every state qualifier, so reading it is enough to guess a name", () => {
  const note = fs.readFileSync(path.join(SEED, "CANON.md"), "utf8");
  for (const tier of TIERS) assert.ok(note.includes(`\`${tier}/<name>/\``), `the note never mentions ${tier}/`);
  for (const s of ["list", "detail", "new", "edit", "empty", "error", "loading", "confirm", "success"])
    assert.ok(note.includes(`\`-${s}\``), `the note never mentions the -${s} qualifier`);
  // The resolution rule has to survive a workspace with no engine clone beside it — a
  // hosted workspace has no repo at all, so a rule that needs the CLI is no rule.
  assert.match(note, /needs no tool/);
});

// ── Promotion ────────────────────────────────────────────────────────────────

test("a promoted screen lands in the canon with its design-system references repointed AND RESOLVING", () => {
  const root = workspace();
  const before = skillRefs(path.join(root, PROTO, "index.html"));
  assert.ok(before.length >= 2, "the fixture prototype should reference the skill");
  assert.ok(before.every((r) => r.ref.startsWith("../../../")), "the prototype sits three levels down");

  assert.equal(canon(root, "save", PROTO).status, 0);

  const entry = path.join(root, "pages", "specimen-viewer", "index.html");
  const after = skillRefs(entry);
  assert.equal(after.length, before.length, "a reference went missing in the copy");
  assert.ok(after.every((r) => r.ref.startsWith("../../")), "the canon entry sits two levels down");
  // The assertion that matters: not that the path changed, but that it points at a file.
  for (const r of after) assert.ok(r.resolves, `${r.ref} does not resolve from pages/specimen-viewer/ — the page opens unstyled from disk`);
});

test("promotion COPIES — the prototype is the record of an exploration and stays where it was reviewed", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  assert.ok(fs.existsSync(path.join(root, PROTO, "index.html")), "the source prototype was moved, not copied");
  // Comment pins are keyed to the URL a screen was reviewed at; moving it drops them.
  assert.ok(skillRefs(path.join(root, PROTO, "index.html")).every((r) => r.ref.startsWith("../../../")),
    "the source page was rewritten in place");
});

test("the description travels, because an entry nobody can read the point of is one nobody pulls", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const entry = fs.readFileSync(path.join(root, "pages", "specimen-viewer", "index.html"), "utf8");
  const src = fs.readFileSync(path.join(root, PROTO, "index.html"), "utf8");
  const desc = (h) => (h.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || [])[1];
  assert.ok(desc(entry), "the promoted entry carries no description");
  assert.equal(desc(entry), desc(src));
});

test("--dry-run reports the identical plan and writes nothing", () => {
  const root = workspace();
  fs.rmSync(path.join(root, "CANON.md")); // the seed ships one; a workspace mid-life may not
  const dry = canon(root, "save", PROTO, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would promote/);
  assert.match(dry.stdout, /pages\/specimen-viewer\/index\.html/);
  assert.ok(!fs.existsSync(path.join(root, "pages")), "--dry-run created the tier directory");
  assert.ok(!fs.existsSync(path.join(root, "CANON.md")), "--dry-run wrote the note");
  // The real run, from the identical starting state, writes exactly what the plan listed.
  assert.equal(canon(root, "save", PROTO).status, 0);
  assert.ok(fs.existsSync(path.join(root, "pages", "specimen-viewer", "index.html")));
  assert.ok(fs.existsSync(path.join(root, "CANON.md")));
});

test("a name carrying a version is promoted under the name without it, and the change is announced", () => {
  const root = workspace();
  const r = canon(root, "save", PROTO, "--as", "specimen-viewer-v2");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, "pages", "specimen-viewer", "index.html")));
  assert.ok(!fs.existsSync(path.join(root, "pages", "specimen-viewer-v2")), "a version rode into the canon");
  assert.match(r.stdout, /carries no version/);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test("a screen with no description is refused rather than promoted unfindable", () => {
  const root = workspace();
  const src = path.join(root, "playground", "nameless");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "index.html"), "<!doctype html><title>x</title><body>x</body>");
  const r = canon(root, "save", "playground/nameless");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /description/);
  assert.ok(!fs.existsSync(path.join(root, "pages", "nameless")), "it was promoted anyway");
});

test("one name resolves to one thing — the same name in a second tier is refused", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const r = canon(root, "save", PROTO, "--tier", "components");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one name resolves to one thing/);
});

test("an existing entry is never silently overwritten", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const again = canon(root, "save", PROTO);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--replace/);
  assert.equal(canon(root, "save", PROTO, "--replace").status, 0);
});

test("a folder already in a tier is refused — the folder name IS the name", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const r = canon(root, "save", "pages/specimen-viewer", "--as", "renamed");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already canonical/);
});

// ── Finding ──────────────────────────────────────────────────────────────────

test("find resolves a canonical name to its tier, folder and entry page", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const r = canon(root, "find", "specimen-viewer");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pages/);
  assert.match(r.stdout, /pages\/specimen-viewer\/index\.html/);
});

test("find on an unknown name exits non-zero and points at the prototype that could become it", () => {
  const root = workspace();
  const r = canon(root, "find", "specimen-viewer");
  assert.equal(r.status, 1, "a name that is not canonical must not report success");
  assert.match(r.stdout, /not in the canon/);
  assert.match(r.stdout, /canon save worked-examples\/prototypes\/specimen-viewer/);
});

test("list prints every canonical name with what it shows", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const entries = JSON.parse(canon(root, "list", "--json").stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "specimen-viewer");
  assert.equal(entries[0].tier, "pages");
  assert.ok(entries[0].description);
});

// ── Checking ─────────────────────────────────────────────────────────────────

test("check passes on a workspace whose canon came from a promotion, with nothing hand-edited", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const r = canon(root, "check");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 to fix/);
});

test("check FAILS on a reference that does not resolve from where the entry sits", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const entry = path.join(root, "pages", "specimen-viewer", "index.html");
  // Exactly the hand-edit-shaped mistake: the depth a prototype uses, in a canon entry.
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replaceAll("../../skills/", "../../../skills/"));
  const r = canon(root, "check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /opens unstyled from disk/);
});

test("check FAILS on an entry with no description, and on a name that says when instead of what", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const bad = path.join(root, "pages", "checkout-v2");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "index.html"), "<!doctype html><title>x</title><body>x</body>");
  const r = canon(root, "check");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no <meta name="description">/);
  assert.match(r.stdout, /says what, never when/);
});

test("check reports a prototype shadowing a canonical name as advice, not as a failure", () => {
  const root = workspace();
  assert.equal(canon(root, "save", PROTO).status, 0);
  const r = canon(root, "check");
  // `save` copies, so this state is the one a correct promotion LEAVES BEHIND. Failing it
  // would mean the command's own output could not pass the command's own check.
  assert.equal(r.status, 0);
  assert.match(r.stdout, /shadows pages\/specimen-viewer\//);
});

test("outside a workspace it says so, rather than inventing a root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-bare-"));
  const r = canon(dir, "list");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no space\.json/);
});
