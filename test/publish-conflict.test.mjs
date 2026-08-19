// Publish-conflict classification: the pure half of the store-aware publish guard.
//
// A publish ships one tree as the whole space, so a publisher whose tree does not
// contain what is live right now would revert it — silently, because bytes
// replacing bytes trips no guard. The classifier compares MY built manifest with
// the LIVE one, unit by unit (a unit = one prototype/playground folder, the thing
// people think in), and sorts every difference into: adopt theirs (they changed
// it, I did not), drop (they deleted it), contested (we both changed it — the
// caller verifies and forks mine), or noise (generated pages, mine wins).
//
// The classifier is deliberately pure: git, the network and the store are the
// caller's problem. It receives what I changed (myChangedUnits, from git; null
// when unknowable) and answers what to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authoredUnits, unitOfPath, unitPaths, repoDirCandidates, stripVolatileHead,
  stripInjectedChrome, stripBuildDecorations, isInternalPath, classifyPublish,
} from "../scripts/lib/publish-conflict.mjs";

const entry = (h) => ({ h: String(h).repeat(64).slice(0, 64), ct: "text/html", s: 1 });
const mani = (files, prefixes, skills = []) => ({
  files,
  routing: { publicPrefixes: prefixes, versionMap: {}, publicSkillPrefixes: skills },
});

// ── unit geometry ────────────────────────────────────────────────────────────

test("authored units are exactly the public prefixes, normalized to trailing slash", () => {
  const m = mani({}, ["/toolkit/map/", "/playground/x"]);
  assert.deepEqual([...authoredUnits(m)].sort(), ["/playground/x/", "/toolkit/map/"]);
});

test("gallery versionMap keys are NOT units — only publicPrefixes make a unit", () => {
  const m = mani({}, ["/toolkit/map/"]);
  m.routing.versionMap = { "/components/button/": "1", "/toolkit/map/": "2" };
  assert.deepEqual([...authoredUnits(m)], ["/toolkit/map/"]);
});

test("unitOfPath resolves a file to its unit, decoded, and null outside any unit", () => {
  const units = new Set(["/toolkit/map/", "/playground/my%20proto/"]);
  assert.equal(unitOfPath("/toolkit/map/index.html", units), "/toolkit/map/");
  assert.equal(unitOfPath("/playground/my proto/app.js", units), "/playground/my%20proto/");
  assert.equal(unitOfPath("/components/button/index.html", units), null);
  assert.equal(unitOfPath("/toolkit/mapExtra/index.html", units), null,
    "prefix match must respect the folder boundary");
});

test("unitPaths lists every manifest file under a unit", () => {
  const m = mani({
    "/toolkit/map/index.html": entry("a"),
    "/toolkit/map/app.js": entry("b"),
    "/toolkit/other/index.html": entry("c"),
  }, ["/toolkit/map/", "/toolkit/other/"]);
  assert.deepEqual(unitPaths(m, "/toolkit/map/").sort(),
    ["/toolkit/map/app.js", "/toolkit/map/index.html"]);
});

test("repoDirCandidates inverts a unit URL to the folders it could live in", () => {
  // Default space: prototypes elide the /prototypes/ segment on the URL side.
  assert.deepEqual(repoDirCandidates("/toolkit/map/", { spaceBase: "" }),
    ["toolkit/prototypes/map", "toolkit/map"]);
  assert.deepEqual(repoDirCandidates("/playground/x/", { spaceBase: "" }), ["playground/x"]);
  // Non-default space: same shapes under /<id>/.
  assert.deepEqual(repoDirCandidates("/beta/playground/x/", { spaceBase: "/beta" }), ["playground/x"]);
  assert.deepEqual(repoDirCandidates("/beta/opp/n/", { spaceBase: "/beta" }),
    ["opp/prototypes/n", "opp/n"]);
  // URL-encoded names decode to real folder names.
  assert.deepEqual(repoDirCandidates("/toolkit/my%20proto/", { spaceBase: "" }),
    ["toolkit/prototypes/my proto", "toolkit/my proto"]);
});

// ── injection-tolerant compare ───────────────────────────────────────────────

test("stripVolatileHead makes two builds equal when only injected social meta differs", () => {
  const a = `<head>\n  <meta property="og:url" content="https://x.dev/p/" />\n  <title>t</title>\n</head><body>same</body>`;
  const b = `<head>\n  <meta property="og:url" content="/p/" />\n  <title>t</title>\n</head><body>same</body>`;
  assert.equal(stripVolatileHead(a), stripVolatileHead(b));
});

test("stripVolatileHead keeps real content differences visible", () => {
  const a = `<head><meta property="og:url" content="/p/" /></head><body>one</body>`;
  const b = `<head><meta property="og:url" content="/p/" /></head><body>two</body>`;
  assert.notEqual(stripVolatileHead(a), stripVolatileHead(b));
});

test("built pages equal their source once injected overlay blocks are stripped", () => {
  // The build injects marker-delimited chrome (review overlay, pet layer, offline
  // reload) into prototype HTML. Comparing a live blob against the git source must
  // see through all of it, or every untouched page reads as an edit.
  const source = `<html><head><title>t</title></head><body>same</body></html>`;
  const built = `<html><head><title>t</title>\n  <meta property="og:url" content="https://x.dev/p/" />\n</head>` +
    `<body>same<!--gv-review-start--><script src="/__review/comments.js?v=1.11" defer></script><!--gv-review-end-->` +
    `<!--gv-piti-start--><script src="/piti.js?v=1.11" defer></script><script>boot()</script><!--gv-piti-end-->` +
    `<!--gv-reload-start--><script>reload("tok")</script><!--gv-reload-end--></body></html>`;
  assert.equal(stripVolatileHead(built), stripVolatileHead(source));
});

test("the stamped card emoji in a built title never reads as an edit", () => {
  const source = `<html><head><title>alpha</title></head><body>x</body></html>`;
  const built = `<html><head><title>🎚️ alpha</title></head><body>x</body></html>`;
  assert.equal(stripVolatileHead(built), stripVolatileHead(source));
  const reallyRenamed = `<html><head><title>🎚️ beta</title></head><body>x</body></html>`;
  assert.notEqual(stripVolatileHead(reallyRenamed), stripVolatileHead(source));
});

test("the linked-assets stamp and the skills depth rewrite never read as edits", () => {
  // These two leaked through the comparator on 2026-08-19 — every untouched page
  // then read as "theirs newer" and a reconcile adopted 169 baked pages into git.
  const source = `<html><head><title>t</title>\n` +
    `  <link rel="stylesheet" href="../../../skills/acme-ui/acme-ui.css" />\n</head><body>x</body></html>`;
  const built = `<html><head><title>t</title>\n` +
    `  <link rel="stylesheet" href="../../skills/acme-ui/acme-ui.css" />\n` +
    `<script>window.__GV_LINKED=["acme-ui.css"];</script></head><body>x</body></html>`;
  assert.equal(stripVolatileHead(built), stripVolatileHead(source));
});

// ── the writer's peel — adopted sources are byte-shaped like authored ones ──

test("stripBuildDecorations returns a dist page to its authored shape", () => {
  const authored = `<html><head>\n  <title>Lab</title>\n` +
    `  <link rel="stylesheet" href="../../../skills/acme-ui/acme-ui.css" />\n</head>\n<body>x</body></html>`;
  const dist = `<html><head>\n  <title>🧷 Lab</title>\n` +
    `  <link rel="stylesheet" href="../../skills/acme-ui/acme-ui.css" />\n` +
    `  <meta property="og:type" content="website" />\n` +
    `  <meta property="og:url" content="https://x.dev/demo/hello/" />\n` +
    `  <meta name="twitter:card" content="summary" />\n` +
    `<script>window.__GV_LINKED=["acme-ui.css"];</script></head>\n<body>x` +
    `<!--gv-review-start--><script src="/__review/comments.js" defer></script><!--gv-review-end--></body></html>`;
  // the unit lives at demo/prototypes/hello in the repo — three levels below the space root
  assert.equal(stripBuildDecorations(dist, "demo/prototypes/hello"), authored);
});

test("isInternalPath shields what live can never testify about", () => {
  for (const p of ["demo/prototypes/x/research/notes.md", "demo/prototypes/x/context.md",
    "demo/prototypes/x/research/deep/file.png", "playground/y/context.md", "a/b/export.zip", "a/.env.local"]) {
    assert.equal(isInternalPath(p), true, `${p} is internal`);
  }
  for (const p of ["demo/prototypes/x/index.html", "demo/prototypes/x/preview.webp", "skills/acme-ui/acme-ui.css"]) {
    assert.equal(isInternalPath(p), false, `${p} ships`);
  }
});

test("full built-page shape: emoji title + og + overlay markers vs raw source", () => {
  const source = `<!doctype html><html><head><title>alpha</title></head><body>alpha v1</body></html>\n`;
  const built = `<!doctype html><html><head><title>🎚️ alpha</title>\n` +
    `  <meta property="og:type" content="website" />\n` +
    `  <meta property="og:site_name" content="Augur" />\n` +
    `  <meta property="og:title" content="alpha" />\n` +
    `  <meta property="og:description" content="Clickable design prototype · Toy" />\n` +
    `  <meta property="og:url" content="https://x.dev/demo/alpha/" />\n` +
    `  <meta name="twitter:card" content="summary" />\n` +
    `  <meta name="twitter:title" content="alpha" />\n` +
    `  <meta name="twitter:description" content="Clickable design prototype · Toy" />\n` +
    `  </head><body>alpha v1<!--gv-review-start--><script defer></script><!--gv-review-end--></body></html>\n`;
  assert.equal(stripVolatileHead(built), stripVolatileHead(source));
});

test("(shape check) marker blocks strip when only they are injected", () => {
  const source = `<html><head><title>t</title></head><body>same</body></html>`;
  const built = `<html><head><title>t</title></head>` +
    `<body>same<!--gv-review-start--><script src="/__review/comments.js?v=1.11" defer></script><!--gv-review-end-->` +
    `<!--gv-piti-start--><script src="/piti.js?v=1.11" defer></script><script>boot()</script><!--gv-piti-end-->` +
    `<!--gv-reload-start--><script>reload("tok")</script><!--gv-reload-end--></body></html>`;
  assert.equal(stripVolatileHead(built), stripVolatileHead(source));
});

test("stripInjectedChrome removes only marker blocks — og meta and content stay", () => {
  const built = `<head>\n  <meta property="og:url" content="https://x.dev/p/" />\n</head>` +
    `<body>real<!--gv-piti-start--><script>x()</script><!--gv-piti-end--></body>`;
  const cleaned = stripInjectedChrome(built);
  assert.equal(cleaned.includes("gv-piti"), false);
  assert.equal(cleaned.includes("og:url"), true, "og meta is idempotent at rebuild — keep it");
  assert.equal(cleaned.includes("real"), true);
});

// ── classification ───────────────────────────────────────────────────────────

const U = "/toolkit/map/";
const liveWith = (h) => mani({ [U + "index.html"]: entry(h) }, [U]);

test("identical manifests classify to nothing at all", () => {
  const c = classifyPublish({ mine: liveWith("a"), live: liveWith("a"), myChangedUnits: new Set() });
  assert.deepEqual(c, {
    adoptUnits: [], dropUnits: [], contestedUnits: [],
    skillAdoptPaths: [], skillContestedPaths: [], noisePaths: [],
  });
});

test("they edited a unit I did not touch → adopt theirs (the silent-revert case)", () => {
  const c = classifyPublish({ mine: liveWith("a"), live: liveWith("b"), myChangedUnits: new Set() });
  assert.deepEqual(c.adoptUnits, [U]);
  assert.deepEqual(c.contestedUnits, []);
});

test("they added a unit my tree has never seen → adopt it, files and all", () => {
  const mine = mani({}, []);
  const live = mani({ "/toolkit/new/index.html": entry("n") }, ["/toolkit/new/"]);
  const c = classifyPublish({ mine, live, myChangedUnits: new Set() });
  assert.deepEqual(c.adoptUnits, ["/toolkit/new/"]);
});

test("they deleted a unit I did not touch → adopt the deletion", () => {
  const mine = liveWith("a");
  const live = mani({}, []);
  const c = classifyPublish({ mine, live, myChangedUnits: new Set() });
  assert.deepEqual(c.dropUnits, [U]);
});

test("my brand-new unit ships — never mistaken for their deletion", () => {
  const mine = liveWith("a");
  const live = mani({}, []);
  const c = classifyPublish({ mine, live, myChangedUnits: new Set([U]) });
  assert.deepEqual(c.dropUnits, []);
  assert.deepEqual(c.adoptUnits, []);
});

test("my deliberate deletion stands — a unit I changed is never adopted back", () => {
  const mine = mani({}, []);
  const live = liveWith("a");
  const c = classifyPublish({ mine, live, myChangedUnits: new Set([U]) });
  assert.deepEqual(c.adoptUnits, [], "the unpublish guard owns deletions, not adoption");
});

test("both changed the same unit → contested, for the caller to verify and fork", () => {
  const c = classifyPublish({ mine: liveWith("a"), live: liveWith("b"), myChangedUnits: new Set([U]) });
  assert.deepEqual(c.contestedUnits, [U]);
  assert.deepEqual(c.adoptUnits, []);
});

test("unknown base (myChangedUnits null) adopts their differing units, keeps my new ones, drops nothing", () => {
  const mine = mani({ [U + "index.html"]: entry("a"), "/toolkit/fresh/index.html": entry("f") }, [U, "/toolkit/fresh/"]);
  const live = mani({ [U + "index.html"]: entry("b"), "/toolkit/gone/index.html": entry("g") }, [U, "/toolkit/gone/"]);
  const c = classifyPublish({ mine, live, myChangedUnits: null });
  assert.deepEqual(c.adoptUnits.sort(), [U, "/toolkit/gone/"].sort());
  assert.deepEqual(c.dropUnits, [], "never adopt a deletion without a base to prove it");
  assert.deepEqual(c.contestedUnits, []);
});

test("generated pages differing outside any unit are noise — mine wins, recorded only", () => {
  const mine = mani({ "/components/button/index.html": entry("a"), [U + "index.html"]: entry("s") }, [U]);
  const live = mani({ "/components/button/index.html": entry("b"), [U + "index.html"]: entry("s") }, [U]);
  const c = classifyPublish({ mine, live, myChangedUnits: new Set() });
  assert.deepEqual(c.noisePaths, ["/components/button/index.html"]);
  assert.deepEqual(c.adoptUnits, []);
});

test("shared skill assets: theirs adopted when I did not touch them, contested when I did", () => {
  const skills = ["/skills/ui/"];
  const mine = mani({ "/skills/ui/ui.css": entry("a"), "/skills/ui/ui.js": entry("x") }, [], skills);
  const live = mani({ "/skills/ui/ui.css": entry("b"), "/skills/ui/ui.js": entry("y") }, [], skills);
  const c = classifyPublish({
    mine, live, myChangedUnits: new Set(),
    myChangedPaths: new Set(["/skills/ui/ui.js"]),
  });
  assert.deepEqual(c.skillAdoptPaths, ["/skills/ui/ui.css"]);
  assert.deepEqual(c.skillContestedPaths, ["/skills/ui/ui.js"]);
});

test("a skill asset only live has → adopted; only mine has → ships silently", () => {
  const skills = ["/skills/ui/"];
  const mine = mani({ "/skills/ui/new.css": entry("n") }, [], skills);
  const live = mani({ "/skills/ui/old.css": entry("o") }, [], skills);
  const c = classifyPublish({ mine, live, myChangedUnits: new Set(), myChangedPaths: new Set() });
  assert.deepEqual(c.skillAdoptPaths, ["/skills/ui/old.css"]);
  assert.deepEqual(c.skillContestedPaths, []);
});
