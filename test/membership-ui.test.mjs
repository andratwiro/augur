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
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");

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

test("the workspace row carries a cog linking to that space's admin", () => {
  const html = makeSwitcher(TWO, "alpha");
  assert.match(html, /gvspace__cog/);
  assert.match(html, /data-space-admin/);
  assert.match(html, /href="\/admin\/\?space=alpha"/,
    "the cog names the space it administers, so the page opens already scoped");
});

test("the cog survives a one-space instance, even though the switcher does not", () => {
  // A self-hosted Augur is one workspace. It has nothing to switch to, but it still
  // has a workspace to administer — so the row renders and only the dropdown drops.
  const html = makeSwitcher(ONE, "alpha");
  assert.notEqual(html, "", "the row must not vanish with the switcher");
  assert.match(html, /gvspace__cog/);
  assert.equal(/data-space-toggle/.test(html), false, "nothing to switch to, so no chevron");
  assert.equal(/data-space-menu/.test(html), false);
});

test("with two spaces the dropdown is back", () => {
  const html = makeSwitcher(TWO, "alpha");
  assert.match(html, /data-space-toggle/);
  assert.match(html, /data-space-menu/);
});

test("every switcher row ships hidden — the build cannot know the viewer", () => {
  const html = makeSwitcher(TWO, "alpha");
  const rows = html.match(/<a class="gvspace__item[^>]*>/g) || [];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /data-space-row/);
    assert.match(row, /hidden/, "a row visible before /__me answers leaks the site's structure");
  }
});

test("each row names its space, so the client can match it against /__me", () => {
  const html = makeSwitcher(TWO, "alpha");
  assert.match(html, /data-space-row="alpha"/);
  assert.match(html, /data-space-row="beta"/);
});

test("Create new stays the maintainer-only stub it already was", () => {
  assert.match(makeSwitcher(TWO, "alpha"), /data-space-create/);
});
