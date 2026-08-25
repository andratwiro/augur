// Runtime chrome composition — the shared rail renderer + the worker's serve-time
// composer. See src/chrome/appchrome.mjs and composeChrome in src/_worker.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAppChrome, renderSpaceContextScript } from "../src/chrome/appchrome.mjs";
import { __testables as W } from "../src/_worker.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Build a one-space site into a temp dist, optionally with GV_RUNTIME_CHROME set and
// extra space.json keys.
function buildSite(extraEnv = {}, spaceMeta = {}) {
  const spacesRoot = mkdtempSync(path.join(tmpdir(), "rc-space-"));
  writeFileSync(path.join(spacesRoot, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true, ...spaceMeta }));
  const proto = path.join(spacesRoot, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const out = mkdtempSync(path.join(tmpdir(), "rc-dist-"));
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out, ...extraEnv }, stdio: "pipe",
  });
  const routing = JSON.parse(readFileSync(path.join(out, "__config", "routing.json"), "utf8"));
  return { out, routing, cleanup: () => { rmSync(spacesRoot, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

const STATE = {
  spaces: [{ id: "demo", name: "Demo", default: true, base: "" }],
  activeSpace: "demo", opportunities: [], hasPlayground: true,
};

test("renderAppChrome yields a rail with the projects item and version foot", () => {
  const html = renderAppChrome("prototypes", STATE, {});
  assert.match(html, /class="gvtop"/);
  assert.match(html, /gvside__ver">v[\d.]+/);
  assert.match(html, /data-pinned-list/);
});

test("admin active renders the admin rail", () => {
  const html = renderAppChrome("admin", STATE, {});
  assert.match(html, /aria-label="Workspace settings"/);
  assert.match(html, /data-admin-back/);
});

test("renderSpaceContextScript emits the space base for the pins filter", () => {
  assert.match(renderSpaceContextScript(STATE), /window\.__GV_SPACE=/);
});

test("routing.runtimeChrome is false by default and reflects GV_RUNTIME_CHROME", () => {
  const off = buildSite();
  try { assert.equal(off.routing.runtimeChrome, false, "off by default"); } finally { off.cleanup(); }
  const on = buildSite({ GV_RUNTIME_CHROME: "1" });
  try { assert.equal(on.routing.runtimeChrome, true, "on when the flag is set"); } finally { on.cleanup(); }
});

test("non-default active space scopes rail links to its base", () => {
  const state = {
    spaces: [
      { id: "demo", name: "Demo", default: true, base: "" },
      { id: "beta", name: "Beta", default: false, base: "/beta" },
    ],
    activeSpace: "beta", opportunities: [], hasPlayground: false,
  };
  const html = renderAppChrome("prototypes", state, {});
  assert.match(html, /data-search-base="\/beta\/"/);
  assert.match(html, /href="\/beta\/"/); // the Projects rail item is base-scoped
});

// ---- composeChrome (worker serve-time composer) ------------------------------

const OLD_PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/_chrome.1.11.deadbeef.css">
</head><body>
<!--gv-chrome-start data-space="" data-active="prototypes" data-ui="1.11"-->OLDRAIL<!--gv-chrome-end-->
<script defer src="/_chrome.1.11.deadbeef.js"></script>
</body></html>`;

test("composeChrome swaps bundle refs and re-renders the rail", async () => {
  W.__setChromeTestState(
    { css: "_chrome.1.14.abc12345.css", js: "_chrome.1.14.abc12345.js", ui: "1.14" },
    [{ id: "demo", name: "Demo", default: true, base: "" }], true);
  const res = new Response(OLD_PAGE, { headers: { "Content-Type": "text/html", "ETag": '"stale"', "Content-Length": "999" } });
  const out = await W.composeChrome(res, new URL("https://x/"));
  const body = await out.text();
  assert.match(body, /_chrome\.1\.14\.abc12345\.css/);
  assert.match(body, /_chrome\.1\.14\.abc12345\.js/);
  assert.doesNotMatch(body, /1\.11\.deadbeef/);
  assert.doesNotMatch(body, /OLDRAIL/);
  assert.match(body, /gvside__ver">v1\.14/);
  assert.match(body, /<!--gv-chrome-start [^>]*data-active="prototypes"[^>]*-->/, "markers preserved");
  assert.equal(out.headers.get("ETag"), null, "stale ETag dropped");
  assert.equal(out.headers.get("Content-Length"), null, "stale Content-Length dropped");
});

test("composeChrome is a no-op when the flag is off", async () => {
  W.__setChromeTestState({ css: "x.css", js: "x.js", ui: "1.14" }, [], false);
  const res = new Response("<body>hi</body>", { headers: { "Content-Type": "text/html" } });
  assert.equal(await (await W.composeChrome(res, new URL("https://x/"))).text(), "<body>hi</body>");
});

test("composeChrome leaves ?raw and non-HTML untouched even when on", async () => {
  W.__setChromeTestState({ css: "c.css", js: "c.js", ui: "1.14" }, [], true);
  const raw = new Response(OLD_PAGE, { headers: { "Content-Type": "text/html" } });
  assert.match(await (await W.composeChrome(raw, new URL("https://x/?raw"))).text(), /OLDRAIL/);
  const json = new Response('{"a":1}', { headers: { "Content-Type": "application/json" } });
  assert.equal(await (await W.composeChrome(json, new URL("https://x/"))).text(), '{"a":1}');
});

// ---- space.json "help" — the workspace's own Help-drawer sections -------------
// The engine documents the engine. A workspace says the rest itself, through the same
// space-entry channel projectsLabel already rides, so build and serve worker agree.

test("no help declared: the drawer is the engine's own sections and nothing else", () => {
  const html = renderAppChrome("prototypes", STATE, {});
  assert.match(html, /data-help-track="build"/);
  assert.match(html, /Comment loop/);
  // The last thing in the Building track is the engine's own final bullet.
  assert.match(html, /Not automated\. You steer it\.<\/li>\s*<\/ul>\s*<\/section>/);
});

test("declared help renders after the engine's sections, in the Building track", () => {
  const state = {
    ...STATE,
    spaces: [{ id: "demo", name: "Demo", default: true, base: "",
      help: [{ title: "Skills", items: ["The a11y skill: contrast, zoom, target size."] }] }],
  };
  const html = renderAppChrome("prototypes", state, {});
  const track = html.slice(html.indexOf('data-help-track="build"'));
  const section = track.slice(0, track.indexOf("</section>"));
  assert.ok(section.includes("<h4>Skills</h4>"), "the workspace's heading is in the Building track");
  assert.ok(section.indexOf("Comment loop") < section.indexOf("<h4>Skills</h4>"),
    "it comes AFTER the engine's own sections");
  assert.match(section, /<li>The a11y skill: contrast, zoom, target size\.<\/li>/);
});

test("help is plain text: a workspace cannot inject markup into every page", () => {
  const state = {
    ...STATE,
    spaces: [{ id: "demo", name: "Demo", default: true, base: "",
      help: [{ title: "<script>x</script>", items: ["<img src=x onerror=alert(1)>"] }] }],
  };
  const html = renderAppChrome("prototypes", state, {});
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test("a section missing a title or its items renders nothing", () => {
  const state = {
    ...STATE,
    spaces: [{ id: "demo", name: "Demo", default: true, base: "",
      help: [{ title: "", items: ["orphan"] }, { title: "Empty", items: [] }] }],
  };
  const html = renderAppChrome("prototypes", state, {});
  assert.doesNotMatch(html, /orphan/);
  assert.doesNotMatch(html, /<h4>Empty<\/h4>/);
});

test("the build normalises space.json help and ships it to the worker in routing.json", () => {
  const b = buildSite({}, {
    help: [
      { title: "  Conventions  ", items: ["  one  ", "", 7, "two"] },
      { title: "Dropped", items: [] },
      "not a section",
    ],
  });
  try {
    const acme = b.routing.spaces.find((s) => s.id === "acme");
    assert.deepEqual(acme.help, [{ title: "Conventions", items: ["one", "two"] }]);
    const page = readFileSync(path.join(b.out, "index.html"), "utf8");
    assert.ok(page.includes("<h4>Conventions</h4>"), "baked into the page's drawer too");
  } finally { b.cleanup(); }
});

test("a space that declares no help ships an empty list, not a missing key", () => {
  const b = buildSite();
  try {
    assert.deepEqual(b.routing.spaces.find((s) => s.id === "acme").help, []);
    assert.ok(!readFileSync(path.join(b.out, "index.html"), "utf8").includes("<h4>Conventions</h4>"));
  } finally { b.cleanup(); }
});
