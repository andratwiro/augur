// A card's faces are the people whose work is IN it — never someone whose only trace
// under that folder was deleted.
//
// The publish-conflict machinery used to write fork folders (`<name>-conflict-<who>/`)
// into the tree, and those forks were committed and later swept out. The commits stay in
// history, so a folder that has existed for one afternoon and been deleted for months
// still credited its author on the surviving PARENT — the credit pass walks a touched
// path up through every ancestor directory, and nothing checked that the path is still
// there. Measured live 2026-08-25 on the reference instance: one person's face on 9 of
// 14 project cards, in every case from litter that no longer exists (one commit alone
// carried 412 such files across 10 project folders).
//
// build.js exports nothing, so this drives the actual binary against a git fixture and
// reads the face piles out of the rendered landing page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEC = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function git(dir, args, dateISO, who) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (dateISO) { env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = `${SEC(dateISO)} +0000`; }
  if (who) { env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = who.name; env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = who.email; }
  execFileSync("git", ["-C", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
}

const ANA = { name: "Ana", email: "ana@example.test" };
const BEA = { name: "Bea", email: "bea@example.test" };

function proto(dir, opp, name, body) {
  const p = path.join(dir, opp, "prototypes", name);
  mkdirSync(p, { recursive: true });
  writeFileSync(path.join(p, "index.html"), `<!doctype html><title>${name}</title><p>${body}</p>\n`);
  return p;
}

// A minimal default space (skill + registry so the DS build is happy), git-initialised,
// with two project folders: `demo` (Ana's) and `real` (Ana's, later edited by Bea).
function makeSpace() {
  const ws = mkdtempSync(path.join(tmpdir(), "card-credit-ws-"));
  const dir = path.join(ws, "acme");
  const skill = path.join(dir, "skills", "acme-ui");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "acme-ui.css"), ":root{--acme:1}\n");
  writeFileSync(path.join(skill, "skill.json"), JSON.stringify({ assets: ["acme-ui.css"], cssPrefixes: ["acme"] }));
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify({
    items: [{ name: "stat", type: "primitive", classes: ["acme-stat"], label: "Stat", description: "A number." }],
  }));
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "acme", default: true }));
  proto(dir, "demo", "hello", "hi");
  proto(dir, "real", "thing", "hi");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", ANA.email]);
  git(dir, ["config", "user.name", ANA.name]);
  const identity = path.join(ws, "identity.json");
  writeFileSync(identity, JSON.stringify([
    { email: ANA.email, name: ANA.name, initials: "AN", color: "#123456" },
    { email: BEA.email, name: BEA.name, initials: "BE", color: "#654321" },
  ]));
  return { ws, dir, identity };
}

// The landing page's project cards, as { "Demo": ["Ana", …] } — a face chip carries the
// person's name in its title, which is what a reader actually sees on the card.
function landingFaces(ws, identity) {
  const out = path.join(ws, "__dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, GV_SPACES_ROOT: ws, GV_DIST: out, GV_IDENTITY_PATH: identity },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const html = readFileSync(path.join(out, "index.html"), "utf8");
  const faces = {};
  for (const card of html.split(/(?=<div class="card-opp)/).slice(1)) {
    const name = (card.match(/<div class="proto-name">([^<]+)</) || [])[1];
    if (!name) continue;
    // sorted: WHO is on the card is what this is about, not the busiest-first order
    faces[name.trim()] = [...card.matchAll(/class="proto-editor opp-face"[^>]*title="([^"]+)"/g)].map((m) => m[1]).sort();
  }
  return faces;
}

test("a folder that was deleted credits nobody on the surviving parent", () => {
  const { ws, dir, identity } = makeSpace();
  try {
    const T0 = "2025-01-05T12:00:00Z", LITTER = "2025-02-10T12:00:00Z", SWEEP = "2025-02-11T12:00:00Z";
    git(dir, ["add", "-A"], T0, ANA);
    git(dir, ["commit", "-q", "-m", "the prototypes"], T0, ANA);

    // Bea's publish forks a copy into demo/, and it is swept out the next day. Her only
    // trace under `demo` is a path that no longer exists.
    proto(dir, "demo", "hello-conflict-bea", "fork");
    git(dir, ["add", "-A"], LITTER, BEA);
    git(dir, ["commit", "-q", "-m", "fork litter"], LITTER, BEA);
    rmSync(path.join(dir, "demo", "prototypes", "hello-conflict-bea"), { recursive: true, force: true });
    git(dir, ["add", "-A"], SWEEP, ANA);
    git(dir, ["commit", "-q", "-m", "delete the fork"], SWEEP, ANA);

    const faces = landingFaces(ws, identity);
    assert.deepEqual(faces.Demo, ["Ana"], "Bea's face must go with the folder she left behind");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("the filter is precise: a surviving edit still credits its author", () => {
  const { ws, dir, identity } = makeSpace();
  try {
    const T0 = "2025-01-05T12:00:00Z", EDIT = "2025-02-10T12:00:00Z", SWEEP = "2025-02-11T12:00:00Z";
    git(dir, ["add", "-A"], T0, ANA);
    git(dir, ["commit", "-q", "-m", "the prototypes"], T0, ANA);

    // One commit of Bea's, half real work and half litter: the real edit must count, the
    // deleted fork must not — the same commit is evidence for one card and not the other.
    writeFileSync(path.join(dir, "real", "prototypes", "thing", "index.html"),
      "<!doctype html><title>thing</title><p>edited by Bea</p>\n");
    proto(dir, "demo", "hello-conflict-bea", "fork");
    git(dir, ["add", "-A"], EDIT, BEA);
    git(dir, ["commit", "-q", "-m", "edit thing + fork litter"], EDIT, BEA);
    rmSync(path.join(dir, "demo", "prototypes", "hello-conflict-bea"), { recursive: true, force: true });
    git(dir, ["add", "-A"], SWEEP, ANA);
    git(dir, ["commit", "-q", "-m", "delete the fork"], SWEEP, ANA);

    const faces = landingFaces(ws, identity);
    assert.deepEqual(faces.Real, ["Ana", "Bea"], "Bea edited a file that is still there — she keeps that card");
    assert.deepEqual(faces.Demo, ["Ana"], "…and still loses the one where only her litter was");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a renamed folder keeps its history — the rename is not a deletion", () => {
  const { ws, dir, identity } = makeSpace();
  try {
    const T0 = "2025-01-05T12:00:00Z", EDIT = "2025-02-10T12:00:00Z", RENAME = "2025-02-11T12:00:00Z";
    git(dir, ["add", "-A"], T0, ANA);
    git(dir, ["commit", "-q", "-m", "the prototypes"], T0, ANA);
    writeFileSync(path.join(dir, "real", "prototypes", "thing", "index.html"),
      "<!doctype html><title>thing</title><p>edited by Bea</p>\n");
    git(dir, ["add", "-A"], EDIT, BEA);
    git(dir, ["commit", "-q", "-m", "edit thing"], EDIT, BEA);
    git(dir, ["mv", "real/prototypes/thing", "real/prototypes/thingy"], RENAME, ANA);
    git(dir, ["commit", "-q", "-m", "rename thing"], RENAME, ANA);

    const faces = landingFaces(ws, identity);
    assert.deepEqual(faces.Real, ["Ana", "Bea"], "the old path is gone but the work is not — credit follows the rename");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
