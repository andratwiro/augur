// ship.mjs — the default way a change goes out: commit, publish, push.
//
//   augur ship                      commit everything, publish, push
//   augur ship -m "message"         with your own commit message
//   … --space <id>                  from outside the space folder
//   … --no-push                     commit + publish only (offline)
//   … --dry-run                     say what would happen, change nothing
//   … --allow-unpublish             let this ship take live public pages down
//
// Three jobs used to be three decisions, and skipping any of them was silent:
//   commit   local, instant, cannot fail — the step that makes losing work
//            structurally impossible. Untracked files included, deliberately:
//            work that reached the live site while existing in no repository is
//            exactly how two prototypes ended up one `git clean` from gone.
//   publish  makes the live URL true, in seconds. This is what people look at,
//            so it runs BEFORE the push — a network problem must never stand
//            between someone and seeing their own work. (A quick fetch+merge
//            runs first when origin is reachable, so a stale checkout ships the
//            union instead of briefly reverting whoever shipped since.)
//   push     makes GitHub true: how everyone else (and their agents) learn what
//            changed. Retried, because it is the only step that can legitimately
//            fail — someone else may have pushed first.
//
// The last line of stdout is the live URL, so an agent can hand it straight to a
// human. Progress goes to stderr. Exit code is truth.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (msg) => console.error(`\x1b[35m[ship]\x1b[0m ${msg}`);
const warn = (msg) => console.error(`\x1b[33m[ship]\x1b[0m ${msg}`);
const die = (msg) => { console.error(`\x1b[31m[ship]\x1b[0m ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const MSG = opt("-m") || opt("--message");
const NO_PUSH = flag("--no-push");
const DRY = flag("--dry-run");
const ALLOW_UNPUBLISH = flag("--allow-unpublish");

// ── which space ──────────────────────────────────────────────────────────────
const idOf = (dir) => {
  try { return JSON.parse(readFileSync(path.join(dir, "space.json"), "utf8")).id || path.basename(dir); }
  catch (e) { return path.basename(dir); }
};
let dir = null;
if (existsSync(path.join(process.cwd(), "space.json"))) dir = process.cwd();
const want = opt("--space");
if (want) {
  const parent = path.join(ROOT, "..");
  for (const root of [parent, path.join(ROOT, "spaces")]) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const d = path.join(root, e.name);
      if (e.isDirectory() && existsSync(path.join(d, "space.json")) && idOf(d) === want) dir = d;
    }
  }
  if (!dir) die(`no space "${want}" next to this engine.`);
}
if (!dir) die("run this from a space folder, or name one with --space <id>.");
const SPACE = idOf(dir);

const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const gitQuiet = (...a) => {
  try { return { ok: true, out: git(...a) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`.trim() }; }
};

const BRANCH = git("rev-parse", "--abbrev-ref", "HEAD");
// Who forked, for the folder name. `git var GIT_AUTHOR_IDENT` rather than
// `git config user.email`, because that config is often unset — git then derives
// an identity from the machine and stamps commits with it regardless. Asking for
// the config gives you an empty string and a folder called "-conflict-someone";
// asking git what it will ACTUALLY sign as gives you the person.
const whoami = (() => {
  const ident = gitQuiet("var", "GIT_AUTHOR_IDENT").out || "";
  const email = (/<([^>]*)>/.exec(ident) || [, ""])[1];
  const n = email.split("@")[0] || (ident.split("<")[0] || "").trim() || "someone";
  return n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "someone";
})();

// ── 1. commit ────────────────────────────────────────────────────────────────
// A prototype's folder is the unit people think in, so name the commit after the
// folders that moved rather than a file count.
function foldersOf(paths) {
  const out = new Set();
  for (const p of paths) {
    const m = /^([a-z0-9][a-z0-9._-]*)\/prototypes\/([a-z0-9][a-z0-9._-]*)\//.exec(p)
      || /^(playground)\/([a-z0-9][a-z0-9._-]*)\//.exec(p);
    out.add(m ? m[2] : p.split("/")[0]);
  }
  return [...out];
}

const dirtyPaths = git("status", "--porcelain").split("\n").filter(Boolean)
  .map((l) => l.slice(3).replace(/^"|"$/g, ""));
let committed = null;

if (dirtyPaths.length) {
  const touched = foldersOf(dirtyPaths);
  const subject = MSG || `Ship ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ` +${touched.length - 3} more` : ""}`;
  log(`${dirtyPaths.length} change(s) in ${touched.length} folder(s) — committing`);
  if (!DRY) {
    git("add", "-A");
    const body = MSG ? "" : "\n\nCommitted automatically by `augur ship` so the live site is never\nserving anything that exists only in a working folder.";
    git("commit", "-q", "-m", subject + body);
    committed = git("rev-parse", "--short", "HEAD");
    log(`committed ${committed}`);
  }
} else {
  log("nothing to commit — working folder is clean");
}

// ── 1.5 catch up with origin BEFORE the tree defines the live site ───────────
// Reconciling used to happen only when the PUSH was rejected — one step after
// this tree had already replaced the whole live space, reverting whoever shipped
// since the checkout last pulled (for the seconds until the post-merge republish,
// or for good when nothing forced a rejection). Pulling first means the publish
// below ships the union. An unreachable remote is fine: publishing must never
// wait on the git host, and publish's own store guard still stands between a
// stale tree and everyone's live work.
let forks = [];
if (DRY) {
  log("would fetch origin and reconcile if behind");
} else {
  const f = gitQuiet("fetch", "origin", BRANCH);
  if (!f.ok) {
    warn("could not reach the remote — publishing this tree as-is; the push step will retry");
  } else {
    const behind = gitQuiet("rev-list", "--count", `HEAD..origin/${BRANCH}`).out;
    if (behind && behind !== "0") {
      warn(`origin has ${behind} commit(s) this checkout hasn't seen — reconciling before publish`);
      const res = await reconcile({ alreadyLive: false });
      forks = res.forks;
    }
  }
}

// ── 2. publish ───────────────────────────────────────────────────────────────
async function publish() {
  if (DRY) { log("would publish"); return null; }
  let tail = "";
  const code = await new Promise((resolve) => {
    // --allow-unpublish passes straight through: deleting a prototype means
    // committing the deletion and shipping it, and ship is how that goes out.
    const p = spawn(process.execPath,
      [path.join(ROOT, "scripts", "publish.mjs"), "--space", SPACE, ...(ALLOW_UNPUBLISH ? ["--allow-unpublish"] : [])],
      { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", (d) => { tail += d.toString(); });
    p.on("close", resolve);
  });
  if (code !== 0) die(`publish failed (exit ${code}) — nothing was lost, your work is committed. Fix and re-run.`);
  return tail.trim().split("\n").filter(Boolean).pop() || null;
}
let liveLine = await publish();

// ── 3. push, and the conflict it may hit ─────────────────────────────────────
// A rejected push means someone else shipped first. Prototype HTML must not be
// textually merged — git will happily interleave two edits into markup that
// renders wrong and nobody notices until a demo — so the decision is made per
// PROTOTYPE FOLDER, which is the unit of both publishing and the UI.
function conflictedFolders(files) {
  const proto = [], other = [];
  for (const f of files) {
    const m = /^([a-z0-9][a-z0-9._-]*)\/prototypes\/([a-z0-9][a-z0-9._-]*)\//.exec(f)
      || /^(playground)\/([a-z0-9][a-z0-9._-]*)\//.exec(f);
    if (m) proto.push(`${m[1]}${m[1] === "playground" ? "" : "/prototypes"}/${m[2]}`);
    else other.push(f);
  }
  return { folders: [...new Set(proto)], other };
}

async function reconcile({ alreadyLive }) {
  const merge = gitQuiet("merge", "--no-edit", `origin/${BRANCH}`);
  if (merge.ok) {
    log("their work merged cleanly with yours");
    return { merged: true, forks: [] };
  }

  const unmerged = gitQuiet("diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
  const { folders, other } = conflictedFolders(unmerged);

  // Anything outside a prototype folder — a design-system file, space.json — is
  // not safe to resolve mechanically, and forking it makes no sense. Back all the
  // way out and leave a human a clean tree to work in.
  if (other.length) {
    gitQuiet("merge", "--abort");
    die(`this needs you: ${other.length} conflict(s) outside a prototype folder:\n` +
        other.map((o) => `    ${o}`).join("\n") +
        (alreadyLive
          ? `\n\n  Your work is committed and already live. Nothing was merged.`
          : `\n\n  Your work is committed but NOT published — resolving first means the live\n  site never serves a tree that reverts anyone.`) +
        `\n  Resolve in ${dir}, then run \`augur ship\` again.`);
  }

  // Their version keeps the real path — a shared URL must stay pointing at the
  // shared truth. Yours forks to a sibling folder, so it stays live, stays
  // reviewable, and shows up as its own card next to theirs.
  const forks = [];
  for (const folder of folders) {
    const fork = `${folder}-conflict-${whoami}`;
    const ourFiles = gitQuiet("ls-tree", "-r", "--name-only", "HEAD", "--", folder).out.split("\n").filter(Boolean);
    for (const rel of ourFiles) {
      const dest = path.join(dir, rel.replace(folder, fork));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, execFileSync("git", ["-C", dir, "show", `HEAD:${rel}`], { encoding: "buffer" }));
    }
    const theirs = gitQuiet("log", "-1", "--format=%an", `origin/${BRANCH}`).out || "someone else";
    writeFileSync(path.join(dir, fork.replace(/\/$/, ""), "CONFLICT.md"),
      `# Live edit conflict\n\n` +
      `You and **${theirs}** changed \`${folder}\` at the same time, in ways that overlap.\n\n` +
      `Rather than interleave the two into markup that renders wrong, \`augur ship\` kept\n` +
      `**their** version at \`${folder}\` — so any shared link still resolves — and moved\n` +
      `**your** version here.\n\n` +
      `Both are live. Compare them, fold in whatever should survive, then delete this\n` +
      `folder. Nothing has been lost.\n`);
    // Take their whole folder for the canonical path — this resolves every
    // conflicted file in it at once.
    gitQuiet("checkout", "MERGE_HEAD", "--", folder);
    gitQuiet("add", "--", folder, fork);
    forks.push({ folder, fork, theirs });
  }
  git("add", "-A");
  git("commit", "-q", "-m",
    `Reconcile a live edit conflict in ${forks.map((f) => path.basename(f.folder)).join(", ")}\n\n` +
    forks.map((f) => `${f.folder} kept ${f.theirs}'s version; yours forked to ${f.fork}.`).join("\n") +
    `\n\nResolved by \`augur ship\`: prototype HTML is not textually merged.`);
  return { merged: true, forks };
}

let pushed = false;
if (NO_PUSH) {
  warn("--no-push: GitHub does not know about this yet. Run `augur ship` again when you're back online.");
} else if (DRY) {
  log("would push");
} else {
  for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
    const r = gitQuiet("push", "origin", BRANCH);
    if (r.ok) { pushed = true; break; }
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(r.out)) {
      warn("someone else shipped while this was publishing — reconciling");
      const f = gitQuiet("fetch", "origin", BRANCH);
      if (!f.ok) die(`could not reach the remote:\n${f.out}`);
      const res = await reconcile({ alreadyLive: true });
      forks = forks.concat(res.forks);
      // The merge changed the tree, so the live site must be caught up to it.
      liveLine = await publish();
      continue;
    }
    if (attempt < 3) { warn(`push failed, retrying (${attempt}/3)…`); await new Promise((r2) => setTimeout(r2, attempt * 1500)); }
    else {
      warn(`could not push:\n${r.out}`);
      warn("Your work IS committed and IS live. Only GitHub is behind — re-run `augur ship` to retry.");
    }
  }
  if (pushed) log(`pushed to ${BRANCH}`);
}

// ── report ───────────────────────────────────────────────────────────────────
if (forks.length) {
  for (const f of forks) {
    warn(`conflict: ${f.folder} kept ${f.theirs}'s version — yours is now ${f.fork} (both live)`);
  }
}
if (DRY) { console.log("(dry run, nothing changed)"); process.exit(0); }
console.log(liveLine || `${SPACE} published`);
process.exit(pushed || NO_PUSH ? 0 : 1);
