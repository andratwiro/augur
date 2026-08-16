// The rail's half of membership.
//
// The load-bearing constraint here is that spaceSwitcher() runs at BUILD time, when it
// cannot know who will be looking. So every row ships hidden and /__me reveals the ones
// you belong to — the same mechanism the profile chip already uses. A test that let a
// row ship visible would be letting the build leak the site's structure to strangers.
//
// build.js exports nothing, so these lift the functions out of the source and run them
// for real (same technique as face-chip.test.mjs and publish-filter.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");
const DIST = new URL("../dist", import.meta.url).pathname;

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was found in build.js`);
  return SRC.slice(start, SRC.indexOf("\n}", start) + 2);
}

// Icon constants are inert markup here; stubbing them keeps the lift small.
const STUBS = `const IC_SLIDERS = "", IC_GEAR = "<svg data-gear></svg>", IC_SIGNOUT = "";`;

const makeSwitcher = (spaces, activeSpace) =>
  new Function(
    `${STUBS}
     const NAV_STATE = { spaces: ${JSON.stringify(spaces)}, activeSpace: ${JSON.stringify(activeSpace)} };
     ${lift("escAttr")}
     ${lift("spaceSwitcher")}
     return spaceSwitcher();`,
  )();

const profileChip = new Function(`${STUBS}\n${lift("profileChip")}\nreturn profileChip();`)();

const TWO = [
  { id: "alpha", name: "Alpha", default: true, base: "", badge: "" },
  { id: "beta", name: "Beta", default: false, base: "/beta", badge: "new" },
];
const ONE = [TWO[0]];

// ---- the profile menu is "me", not the workspace -----------------------------

test("the profile menu no longer offers Admin settings", () => {
  assert.equal(/Admin settings/.test(profileChip), false,
    "workspace config does not belong under someone's own face");
  assert.equal(/data-prof-admin/.test(profileChip), false);
});

test("the profile menu keeps the things that ARE personal", () => {
  assert.match(profileChip, /data-prof-settings/);
  assert.match(profileChip, /data-prof-signout/);
});

// ---- the workspace row -------------------------------------------------------

test("the workspace row is a nameplate only — Admin lives in the rail", () => {
  const html = makeSwitcher(TWO, "alpha");
  assert.equal(/gvspace__cog|data-space-admin/.test(html), false,
    "admin is a place you go, so it belongs with the rail's other destinations");
  assert.match(html, /data-space-active="alpha"/,
    "the row still names the active workspace so SPACE_JS can scope the Admin link");
});

test("there is no dropdown — nobody can belong to more than one workspace yet", () => {
  // A chevron opening a list of one is furniture, and a list built at BUILD time could
  // only ever name spaces the viewer may not enter. It returns with per-workspace
  // origins + central sign-in, rendered from /__me rather than baked in.
  const html = makeSwitcher(TWO, "alpha");
  for (const gone of ["data-space-toggle", "data-space-menu", "data-space-row",
                      "gvspace__chk", "gvspace__cv", "Create new", "data-space-create"]) {
    assert.equal(html.includes(gone), false, `${gone} should be gone`);
  }
});

test("the row names only the ACTIVE workspace — never the others", () => {
  const html = makeSwitcher(TWO, "alpha");
  assert.match(html, /Alpha/);
  assert.equal(html.includes("Beta"), false,
    "listing a workspace the viewer may not enter is exactly the leak the rows caused");
});

test("no badge — it labelled which space was current back when there were several", () => {
  assert.equal(/gvspace__badge/.test(makeSwitcher(TWO, "alpha")), false);
});

test("the icon is addressable so the client can swap it after an upload", () => {
  assert.match(makeSwitcher(TWO, "alpha"), /data-space-icon/);
});

test("a one-space instance renders exactly the same row", () => {
  const html = makeSwitcher(ONE, "alpha");
  assert.notEqual(html, "");
  assert.match(html, /Alpha/);
  assert.match(html, /data-space-active="alpha"/);
});

test("the rail carries Admin, hidden until you administer this workspace", () => {
  // Asserted against the BUILT page rather than a lifted function: sideRail pulls in
  // most of the module, and what ships is the thing worth checking.
  const home = join(DIST, "index.html");
  if (!existsSync(home)) return;
  const html = readFileSync(home, "utf8");
  assert.match(html, /gvside__admin/);
  assert.match(html, /data-space-admin/);
  assert.match(html, />Admin</);
  assert.ok(html.indexOf("Playground") < html.indexOf(">Admin<"), "Admin comes after Playground");
  // Revealed only by the per-space class — never shipped visible.
  assert.match(html, /html\.gv-space-admin \.gvside__admin/);
});

// ---- the workspace admin surface --------------------------------------------

const adminPage = new Function(
  `${STUBS}
   const NAV_STATE = { spaces: ${JSON.stringify(TWO)}, activeSpace: "alpha" };
   ${lift("escAttr")}
   ${lift("adminSections")}
   return adminSections();`,
)();

// The nav lives in the RAIL, not inside the content — workspace settings replaces the
// sidebar rather than adding a second nav column beside it (Figma's shape). So the
// sections markup must carry no nav of its own.
const adminRail = new Function(
  `${STUBS}
   ${lift("profileChip")}
   ${lift("adminRail")}
   return adminRail();`,
)();

test("the rail becomes the workspace-settings nav — People, Content, Settings", () => {
  assert.match(adminRail, /data-admin-nav/);
  for (const s of ["People", "Content", "Settings"]) {
    assert.match(adminRail, new RegExp(`data-admin-tab="${s.toLowerCase()}"`), `${s} tab`);
  }
});

test("the sections carry no nav of their own", () => {
  assert.equal(/data-admin-nav|data-admin-tab=/.test(adminPage), false,
    "two nav columns side by side read as two levels of hierarchy when there is one");
});

test("the rail offers a way back to the workspace", () => {
  assert.match(adminRail, /data-admin-back/);
  assert.match(adminRail, /data-admin-space-name/);
});

test("the profile chip stays in the admin rail — it is yours, everywhere", () => {
  assert.match(adminRail, /data-prof/);
});

test("the admin rail drops content navigation entirely", () => {
  for (const gone of ["data-pinned-list", "Library", "Changelog"]) {
    assert.equal(adminRail.includes(gone), false, `${gone} has no place in workspace settings`);
  }
});

test("Settings offers a custom URL field that is visibly a stub", () => {
  assert.match(adminPage, /data-custom-url/);
  const row = adminPage.slice(adminPage.indexOf("data-custom-url"));
  assert.match(row.slice(0, 600), /disabled/, "the field must not look operable");
});

test("there is no delete-workspace action", () => {
  assert.equal(/Delete workspace|data-space-delete/.test(adminPage), false,
    "creation is a maintainer act, so deletion is too — it is a control-plane verb");
});

test("Content and Settings ship hidden; People is the landing section", () => {
  assert.match(adminPage, /data-admin-sec="people"(?![^>]*hidden)/);
  assert.match(adminPage, /data-admin-sec="content"[^>]*hidden/);
  assert.match(adminPage, /data-admin-sec="settings"[^>]*hidden/);
});

// ---- workspace icon ----------------------------------------------------------

test("Settings offers a workspace icon with upload and remove", () => {
  assert.match(adminPage, /data-set-icon-pick/);
  assert.match(adminPage, /data-set-icon-file/);
  assert.match(adminPage, /data-set-icon-img/);
  assert.match(adminPage, /data-set-icon-clear/);
});

test("the icon picker accepts only the raster formats the worker will serve", () => {
  const input = /<input[^>]*data-set-icon-file[^>]*>/.exec(adminPage);
  assert.ok(input, "the file input exists");
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    assert.ok(input[0].includes(mime), `${mime} accepted`);
  }
  assert.equal(/image\/svg/.test(input[0]), false, "SVG is script-bearing — never accepted");
});

test("the design system is named for what it is, not called a Library", () => {
  // "Library" was ambiguous next to Projects — a library of what? The engine already
  // calls this a design system (space.json's `designSystem`, the package description),
  // so the rail uses the same word. The internal key stays `library`.
  const home = join(DIST, "index.html");
  if (!existsSync(home)) return;
  const html = readFileSync(home, "utf8");
  assert.match(html, />Design system</);
  assert.equal(/>Library</.test(html), false, "the old label is gone from the rail");
});
