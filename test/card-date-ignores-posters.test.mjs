// A card's "edited N ago" is the last HUMAN change, never a poster reshoot.
//
// preview.webp (and og.jpg) are build outputs committed back into each folder by
// scripts/shoot.mjs / scripts/og.mjs. A reshoot commit touches every folder at once —
// so if the git-date pass counted it, every card on the site would jump to "edited now"
// and the real human-edit recency (and the sort order that rides on it) would be wiped.
// This happened for real on 2026-08-19 when 76 posters were committed in one go.
//
// build.js exports nothing, so this drives the actual binary against a git fixture and
// reads the version map it emits (routing.json versionMap = per-URL mtimeMs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEC = (iso) => Math.floor(new Date(iso).getTime() / 1000); // git %ct is seconds

function git(dir, args, dateISO) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (dateISO) { env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = `${SEC(dateISO)} +0000`; }
  execFileSync("git", ["-C", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
}

// A minimal default space (skill + registry so the DS build is happy), git-initialised.
function makeSpace() {
  const ws = mkdtempSync(path.join(tmpdir(), "card-date-ws-"));
  const dir = path.join(ws, "acme");
  const skill = path.join(dir, "skills", "acme-ui");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "acme-ui.css"), ":root{--acme:1}\n");
  writeFileSync(path.join(skill, "skill.json"), JSON.stringify({ assets: ["acme-ui.css"], cssPrefixes: ["acme"] }));
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify({
    items: [{ name: "stat", type: "primitive", classes: ["acme-stat"], label: "Stat", description: "A number." }],
  }));
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "acme", default: true }));
  const proto = path.join(dir, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const proto2 = path.join(dir, "demo", "prototypes", "world");
  mkdirSync(proto2, { recursive: true });
  writeFileSync(path.join(proto2, "index.html"), "<!doctype html><title>World</title><p>hi</p>\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "dev@example.test"]);
  git(dir, ["config", "user.name", "Test Dev"]);
  return { ws, dir, proto, proto2 };
}

function versionMap(ws) {
  const out = path.join(ws, "__dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT,
    env: { ...process.env, GV_SPACES_ROOT: ws, GV_DIST: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(readFileSync(path.join(out, "__config", "routing.json"), "utf8")).versionMap || {};
}

test("a poster-only commit does not touch a card's edited time", () => {
  const { ws, dir, proto } = makeSpace();
  try {
    const HUMAN = "2021-03-15T12:00:00Z", POSTER = "2024-09-20T12:00:00Z";
    // 1) the real human edit, long ago
    git(dir, ["add", "-A"], HUMAN);
    git(dir, ["commit", "-q", "-m", "hello prototype"], HUMAN);
    // 2) a much later reshoot: preview.webp (+ og.jpg) into the SAME folder, nothing else
    writeFileSync(path.join(proto, "preview.webp"), "RIFFxxxxWEBP");
    writeFileSync(path.join(proto, "og.jpg"), "\xFF\xD8\xFFjpeg");
    git(dir, ["add", "-A"], POSTER);
    git(dir, ["commit", "-q", "-m", "Posters: reshoot"], POSTER);

    const v = versionMap(ws)["/demo/hello/"];
    assert.ok(v, "the hello prototype is in the version map");
    assert.equal(v, String(SEC(HUMAN) * 1000), "edited time must be the human commit, not the reshoot");
    assert.notEqual(v, String(SEC(POSTER) * 1000), "the reshoot must not count as an edit");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("the filter is precise: a real edit riding alongside a poster still counts", () => {
  const { ws, dir, proto, proto2 } = makeSpace();
  try {
    const HUMAN = "2021-03-15T12:00:00Z", MIXED = "2024-09-20T12:00:00Z";
    git(dir, ["add", "-A"], HUMAN);
    git(dir, ["commit", "-q", "-m", "both prototypes"], HUMAN);
    // one commit that reshoots hello AND makes a real edit to world
    writeFileSync(path.join(proto, "preview.webp"), "RIFFxxxxWEBP");
    writeFileSync(path.join(proto2, "index.html"), "<!doctype html><title>World</title><p>edited</p>\n");
    git(dir, ["add", "-A"], MIXED);
    git(dir, ["commit", "-q", "-m", "reshoot hello + edit world"], MIXED);

    const vm = versionMap(ws);
    assert.equal(vm["/demo/hello/"], String(SEC(HUMAN) * 1000), "hello only got a poster — stays at the human date");
    assert.equal(vm["/demo/world/"], String(SEC(MIXED) * 1000), "world got a real edit — advances, poster in the same commit notwithstanding");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
