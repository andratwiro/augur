// Graduating one prototype: it has to come out standing on its own, or not come out.
//
// `F-graduate-path`. The unit cases below pin the pieces, but the one that decides whether
// this works is at the bottom: build a REAL space, serve its real manifest and real blobs
// over the real store protocol, run the real CLI against it, and then read every byte that
// landed. A peel that merely looks right passes every unit case here and fails that one —
// the build decorates authored HTML in five places and each of them is a separate way for
// a "standalone" copy to keep phoning the instance it came from.
//
// The second decisive one is PARITY: the same prototype graduated from the live store and
// from the repo it was published out of must produce identical bytes. Two sources, two code
// paths, one answer — which is the only way "leaving is free" means the same thing to a
// workspace with a repo and a hosted one without.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  resolveUnit, unitFilesFromManifest, skillDirsReferenced, skillFilesFromManifest,
  rerootHtml, residualFindings, referencesIn, isSkillInternal,
} from "../scripts/lib/graduate.mjs";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const PREFIXES = ["/garden/seed-swap/", "/garden/plot-care/", "/almanac/sowing-wheel/", "/playground/scratch/"];

// ── naming the one you mean ──────────────────────────────────────────────────

test("a prototype can be named the three ways a person knows it", () => {
  for (const arg of ["/garden/seed-swap/", "garden/seed-swap", "garden/prototypes/seed-swap", "seed-swap"]) {
    assert.equal(resolveUnit(arg, PREFIXES).prefix, "/garden/seed-swap/", `"${arg}" did not resolve`);
  }
});

test("AN AMBIGUOUS BARE NAME LISTS, IT DOES NOT PICK", () => {
  // Picking one graduates the wrong tool, and nothing about the resulting folder would
  // say so — it would look exactly as correct as the right answer.
  const two = ["/garden/overview/", "/almanac/overview/"];
  assert.throws(() => resolveUnit("overview", two), /names 2 prototypes/);
  assert.equal(resolveUnit("garden/overview", two).prefix, "/garden/overview/");
});

test("a name that is not published says what is", () => {
  assert.throws(() => resolveUnit("nope", PREFIXES), /no published prototype "nope"[\s\S]*seed-swap/);
});

// ── re-rooting ───────────────────────────────────────────────────────────────

test("the design-system depth follows the file to where it now sits", () => {
  // The single most load-bearing rewrite here. A prototype references the skill three
  // levels up in a repo and two on the site; standalone at a domain root it is none.
  const page = `<link rel="stylesheet" href="../../skills/acme-ui/acme-ui.css">`;
  assert.match(rerootHtml(page, "index.html"), /href="skills\/acme-ui\/acme-ui\.css"/);
  assert.match(rerootHtml(page, "sub/page.html"), /href="\.\.\/skills\/acme-ui\/acme-ui\.css"/);
  assert.match(rerootHtml(page, "a/b/page.html"), /href="\.\.\/\.\.\/skills\/acme-ui\/acme-ui\.css"/);
});

test("everything the build stamped onto the page comes off", () => {
  const built = [
    "<!doctype html><html><head>",
    '<title>🌱 Seed swap</title>',
    '<meta property="og:title" content="Seed swap">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<script>window.__GV_LINKED=["acme-ui.css"];</script>',
    "</head><body>hi",
    '<!--gv-review-start--><script src="/__review/comments.js?v=1.14" defer></script><!--gv-review-end-->',
    '<!--gv-piti-start--><script src="/piti.js" defer></script><!--gv-piti-end-->',
    "</body></html>",
  ].join("\n");
  const out = rerootHtml(built, "index.html");
  assert.equal(out.includes("gv-review"), false, "the review overlay tag survived");
  assert.equal(out.includes("gv-piti"), false, "the companion tag survived");
  assert.equal(out.includes("og:title"), false, "social meta survived");
  assert.equal(out.includes("__GV_LINKED"), false, "the linked-assets stamp survived");
  assert.match(out, /<title>Seed swap<\/title>/, "the title emoji survived");
  assert.equal(residualFindings([{ path: "index.html", text: out }], new Set(["index.html"])).filter((f) => f.level === "fatal").length, 0);
});

// ── what comes with it ───────────────────────────────────────────────────────

test("the unit's files lose the URL prefix, so its index is the domain's index", () => {
  const m = { files: { "/garden/seed-swap/index.html": { h: "a" }, "/garden/seed-swap/img/x.png": { h: "b" }, "/garden/plot-care/index.html": { h: "c" } } };
  assert.deepEqual(unitFilesFromManifest(m, "/garden/seed-swap/").map((f) => f.out), ["img/x.png", "index.html"]);
});

test("the design system is found through either spelling of its path", () => {
  // The repo writes ../../../skills/x/, the published page ../../skills/x/. Depth is
  // exactly what differs between them, and it is not what is being asked here.
  assert.deepEqual(skillDirsReferenced([`href="../../../skills/acme-ui/a.css"`]), ["acme-ui"]);
  assert.deepEqual(skillDirsReferenced([`href="../../skills/acme-ui/a.css"`, `url(skills/other-ui/f.woff2)`]), ["acme-ui", "other-ui"]);
  assert.deepEqual(skillDirsReferenced(["nothing shared here"]), []);
});

test("A SKILL COMES AS A WHOLE FOLDER, minus this engine's own contract files", () => {
  // Not the files a reference scan saw: a stylesheet reaches its own fonts by paths no
  // scan finds, and a component script reaches its own assets the same way. What does NOT
  // come is the engine's contract with itself — a manifest and a doc are vocabulary from
  // a system that is supposed to be gone.
  const m = {
    files: {
      "/skills/acme-ui/acme-ui.css": { h: "1" }, "/skills/acme-ui/vendor/fonts/x.woff2": { h: "2" },
      "/skills/acme-ui/skill.json": { h: "3" }, "/skills/acme-ui/SKILL.md": { h: "4" },
      "/skills/acme-ui/graph.js": { h: "5" }, "/skills/other-ui/other.css": { h: "6" },
    },
  };
  assert.deepEqual(skillFilesFromManifest(m, ["acme-ui"]).map((f) => f.out),
    ["skills/acme-ui/acme-ui.css", "skills/acme-ui/vendor/fonts/x.woff2"]);
  for (const f of ["skill.json", "SKILL.md", "graph.js", "sub/skill.json"]) assert.ok(isSkillInternal(f), f);
  assert.equal(isSkillInternal("acme-ui.css"), false);
});

// ── the proof the command runs on itself ─────────────────────────────────────

test("an engine trace is FATAL, and each kind is caught", () => {
  const cases = [
    ['<!--gv-review-start--><script src="x"></script><!--gv-review-end-->', "marker"],
    ['<script src="/__review/comments.js"></script>', "engine route"],
    ["<script>window.__GV_SPACE = {};</script>", "page global"],
    ['<img src="/__canvas/thumb.png">', "engine route"],
  ];
  for (const [text] of cases) {
    const f = residualFindings([{ path: "index.html", text }], new Set(["index.html"]));
    assert.ok(f.some((x) => x.level === "fatal"), `not caught: ${text}`);
  }
});

test("an absolute link back to the instance is fatal — that is the copy phoning home", () => {
  const f = residualFindings(
    [{ path: "index.html", text: '<a href="https://example.invalid/garden/other/">the other one</a>' }],
    new Set(["index.html"]), { sourceHost: "example.invalid" });
  assert.ok(f.some((x) => x.level === "fatal" && /example\.invalid/.test(x.why)));
});

test("a reference to nothing is reported with its file and line, not swallowed", () => {
  // The old site answered these; a domain serving only this folder will 404 them. Silence
  // here means somebody finds out from a customer.
  const text = "<html>\n<body>\n<a href=\"/garden/plot-care/\">next</a>\n<img src=\"missing.png\">\n</body>";
  const f = residualFindings([{ path: "index.html", text }], new Set(["index.html"]));
  assert.deepEqual(f.filter((x) => x.level === "dangling").map((x) => [x.line, x.ref]), [[3, "/garden/plot-care/"], [4, "missing.png"]]);
});

test("a reference that DOES resolve is not reported, including a directory index", () => {
  const present = new Set(["index.html", "sub/index.html", "skills/acme-ui/a.css", "img/x.png"]);
  const text = '<a href="sub/">s</a><link href="skills/acme-ui/a.css"><img src="img/x.png?v=2"><a href="#top">t</a><a href="mailto:x@y.z">m</a>';
  assert.deepEqual(residualFindings([{ path: "index.html", text }], present), []);
});

test("another origin is reported without being refused", () => {
  const f = residualFindings([{ path: "index.html", text: '<script src="https://cdn.example.com/x.js"></script>' }], new Set(["index.html"]));
  assert.deepEqual(f.map((x) => x.level), ["external"]);
});

test("references are read out of stylesheets too, inline and standalone", () => {
  assert.deepEqual(referencesIn('@import "a.css";\nbody{background:url(b.png)}', ".css").map((r) => r.ref), ["a.css", "b.png"]);
  assert.ok(referencesIn('<style>body{background:url("c.png")}</style>', ".html").some((r) => r.ref === "c.png"));
});

// ── the decisive pair, against a real build ──────────────────────────────────

/**
 * The store, as a separate process serving a real build (test/fixtures/fake-store.mjs).
 * Separate because the CLI is what is under test: it has to open its own socket, verify
 * the hashes the manifest names, and peel what comes back.
 */
function startStore(dist, spaceId) {
  const child = spawn(process.execPath, [path.join(ENGINE, "test", "fixtures", "fake-store.mjs"), dist, spaceId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("the store fixture never said ready")), 15000);
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /ready (\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve({ child, origin: `http://127.0.0.1:${m[1]}` }); }
    });
    child.on("error", reject);
  });
}

test("A PROTOTYPE GRADUATED FROM A LIVE PUBLISH CARRIES NOTHING OF THIS ENGINE", async (t) => {
  const space = path.join(ENGINE, "..", "augur-space-fulla");
  if (!fs.existsSync(path.join(space, "space.json"))) return; // not in a full workspace

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grad-root-"));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "grad-dist-"));
  const outStore = fs.mkdtempSync(path.join(os.tmpdir(), "grad-store-"));
  const outTree = fs.mkdtempSync(path.join(os.tmpdir(), "grad-tree-"));
  let store = null;
  try {
    fs.cpSync(space, path.join(root, "fulla"), { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
    execFileSync(process.execPath, [path.join(ENGINE, "build.js")], {
      cwd: ENGINE, env: { ...process.env, GV_SPACES_ROOT: root, GV_DIST: dist }, stdio: ["ignore", "pipe", "pipe"],
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, "__manifests", "fulla.json"), "utf8"));
    const unit = manifest.routing.publicPrefixes.find((p) => p.startsWith("/garden/")) || manifest.routing.publicPrefixes[0];
    const name = unit.replace(/^\/|\/$/g, "").split("/").pop();

    // The built page really is decorated — otherwise the peel below proves nothing.
    const built = fs.readFileSync(path.join(dist, unit.replace(/^\//, ""), "index.html"), "utf8");
    assert.match(built, /<!--gv-review-start-->/, "the build did not decorate the page; this test would be vacuous");

    store = await startStore(dist, "fulla");
    const origin = store.origin;

    fs.rmSync(outStore, { recursive: true, force: true });
    const run = spawnSync(process.execPath, [path.join(ENGINE, "scripts", "clone.mjs"), "--prototype", name, "--space", "fulla", "--out", outStore], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, AUGUR_ORIGIN: origin, AUGUR_TOKEN: "test-token", AUGUR_CLONE_MODE: "clone" },
    });
    assert.equal(run.status, 0, `graduating from the store failed:\n${run.stdout}\n${run.stderr}`);

    // 1. The domain's index is the prototype's own page.
    const page = fs.readFileSync(path.join(outStore, "index.html"), "utf8");
    assert.ok(page.length > 500);

    // 2. NOTHING of this engine, checked over every written file rather than the page.
    const walk = (d, base = d, acc = []) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs, base, acc);
        else acc.push(path.relative(base, abs).split(path.sep).join("/"));
      }
      return acc;
    };
    const written = walk(outStore);
    assert.ok(written.includes("index.html"), "no index.html at the root of the graduated folder");
    assert.ok(written.some((p) => p.startsWith("skills/") && p.endsWith(".css")), "the design system did not come along");
    const texts = written.filter((p) => /\.(html|css|js|mjs|json|svg|webmanifest)$/.test(p))
      .map((p) => ({ path: p, text: fs.readFileSync(path.join(outStore, p), "utf8") }));
    for (const f of texts) {
      for (const trace of ["<!--gv-", "window.__GV_", "/__review/", "/__canvas/", "/__publish/", "/piti.js"]) {
        assert.equal(f.text.includes(trace), false, `${f.path} still carries ${trace}`);
      }
      assert.equal(f.text.includes("127.0.0.1"), false, `${f.path} links back to the instance it came from`);
    }

    // 3. Every reference resolves inside the folder — the command's own verdict, re-run
    //    here over what actually landed on disk.
    const findings = residualFindings(texts, new Set(written), { sourceHost: new URL(origin).host });
    assert.deepEqual(findings.filter((f) => f.level !== "external").map((f) => `${f.path}:${f.line} ${f.ref}`), []);

    // 4. PARITY. The same prototype, graduated out of the repo it was published from, is
    //    byte-identical. Two sources, two code paths, one answer.
    fs.rmSync(outTree, { recursive: true, force: true });
    const runTree = spawnSync(process.execPath, [path.join(ENGINE, "scripts", "clone.mjs"), "--prototype", name, "--from", path.join(root, "fulla"), "--out", outTree], {
      cwd: root, encoding: "utf8", env: { ...process.env, AUGUR_CLONE_MODE: "clone" },
    });
    assert.equal(runTree.status, 0, `graduating from the tree failed:\n${runTree.stdout}\n${runTree.stderr}`);
    assert.deepEqual(walk(outTree).sort(), written.sort(), "the two sources produced different file lists");
    for (const p of written) {
      assert.deepEqual(fs.readFileSync(path.join(outTree, p)), fs.readFileSync(path.join(outStore, p)),
        `${p} differs between the repo-graduated and store-graduated copies`);
    }
  } finally {
    if (store) store.child.kill();
    for (const d of [root, dist, outStore, outTree]) fs.rmSync(d, { recursive: true, force: true });
  }
});
