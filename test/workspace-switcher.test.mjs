// The cross-workspace switcher dropdown (`B-cross-workspace-signin`, Task 11).
//
// spaceSwitcher() cannot know at build time how many workspaces the eventual viewer
// belongs to, so the dropdown is ENTIRELY a runtime addition: WORKSPACES_JS fetches
// /__me/workspaces and, only when it gets back more than one usable row, builds the
// menu and wires the toggle into the existing `.gvspace` chip. Fewer than two rows
// (0, 1, or malformed entries that filter down below 2) must leave the chip touched
// not at all — that is the "no regression for a non-wired deployment" guarantee, and
// it is what these tests hold the line on.
//
// Two layers, same split as membership-ui.test.mjs / face-retry.test.mjs:
//  - spaceSwitcher() is lifted and asserted to emit NO dropdown markup of its own
//    (the container/menu only ever exist because WORKSPACES_JS created them).
//  - WORKSPACES_JS is lifted and run for real against a minimal fake DOM, so the
//    degrade-to-nothing path and the open/close/escape/outside-click behaviour are
//    exercised end to end, not just pattern-matched as strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../build.js", import.meta.url), "utf8");
const MOD = readFileSync(new URL("../src/chrome/appchrome.mjs", import.meta.url), "utf8");

function liftFrom(src, name, where) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was found in ${where}`);
  return src.slice(start, src.indexOf("\n}", start) + 2);
}

function constBody(src, name) {
  const open = `const ${name} = \``;
  const at = src.indexOf(open);
  assert.notEqual(at, -1, `${name} was found in build.js`);
  const start = at + open.length;
  const end = src.indexOf("\n`;", start);
  assert.notEqual(end, -1, `${name}'s closing backtick was found`);
  return src.slice(start, end);
}

// ── build-time output carries no dropdown ──────────────────────────────────────────

const STUBS = `const IC_SLIDERS = "", IC_GEAR = "<svg data-gear></svg>", IC_SIGNOUT = "";`;
const makeSwitcher = (spaces, activeSpace) =>
  new Function(
    `${STUBS}
     ${liftFrom(SRC, "escAttr", "build.js")}
     ${liftFrom(MOD, "spaceSwitcher", "appchrome.mjs")}
     return spaceSwitcher({ spaces: ${JSON.stringify(spaces)}, activeSpace: ${JSON.stringify(activeSpace)} });`,
  )();

const ONE_SPACE = [{ id: "alpha", name: "Alpha", default: true, base: "", badge: "" }];

test("spaceSwitcher() itself never emits dropdown markup — that is WORKSPACES_JS's job at runtime", () => {
  const html = makeSwitcher(ONE_SPACE, "alpha");
  for (const gone of ["data-space-toggle", "data-space-menu", "gvspace__menu", "gvspace__item"]) {
    assert.equal(html.includes(gone), false,
      `${gone} must not be baked in — a build has no viewer to ask, so it cannot know the workspace list`);
  }
});

// ── the workspace's own icon rides the first paint, not just the /__me swap ────────────

import { renderAppChrome } from "../src/chrome/appchrome.mjs";

test("spaceSwitcher renders the admin-set workspace icon when the space carries one", () => {
  const withIcon = [{ ...ONE_SPACE[0], icon: "/__space-icon/cafe" }];
  assert.match(makeSwitcher(withIcon, "alpha"), /src="\/__space-icon\/cafe"/,
    "the override is on first paint, so no flash before WORKSPACES_JS/SPACE_JS runs");
  assert.match(makeSwitcher(ONE_SPACE, "alpha"), /src="\/space-icon\.png"/,
    "no override ⇒ the baked seed");
});

test("the mobile top bar home mark follows the workspace icon (it has no client swap)", () => {
  const withIcon = { spaces: [{ id: "alpha", name: "Alpha", default: true, base: "", icon: "/__space-icon/beef" }], activeSpace: "alpha" };
  const seedOnly = { spaces: [{ id: "alpha", name: "Alpha", default: true, base: "" }], activeSpace: "alpha" };
  assert.match(renderAppChrome("prototypes", withIcon), /class="gvtop__logo" src="\/__space-icon\/beef"/,
    "signed-in mobile header wears the override, not the engine mark");
  assert.match(renderAppChrome("prototypes", seedOnly), /class="gvtop__logo" src="\/space-icon\.png"/,
    "no override ⇒ the baked seed");
});

// ── the client script exists, is wired into both bundling points, and asks the right route ──

test("build.js defines WORKSPACES_JS and it fetches /__me/workspaces", () => {
  const body = constBody(SRC, "WORKSPACES_JS");
  assert.match(body, /fetch\('\/__me\/workspaces'/);
  assert.match(body, /\.catch\(function\(\)\{\}\)/, "best-effort degrade, same style as SPACE_JS");
});

test("WORKSPACES_JS ships in the shared chrome bundle and in injectNav's inline list", () => {
  assert.match(SRC, /CHROME_JS_BODY = \[[^\]]*\bWORKSPACES_JS\b[^\]]*\]/s,
    "must ride the shared, content-hashed chrome bundle every page loads");
  assert.match(SRC, /<script>\$\{WORKSPACES_JS\}<\/script>/,
    "must also be wired into injectNav's inline sequence (the Primitives gallery path)");
});

test("UI_VERSION was bumped for this shell change", () => {
  const m = /export const UI_VERSION = "([\d.]+)";/.exec(MOD);
  assert.ok(m, "UI_VERSION is declared");
  assert.notEqual(m[1], "1.14", "must move off the pre-Task-11 value");
});

// ── run the real script against a minimal fake DOM ──────────────────────────────────

// A tiny fake element sufficient for what WORKSPACES_JS actually touches: attributes,
// one level of children, event listeners, and `contains` for the outside-click check.
class FakeEl {
  constructor(tag) {
    this.tagName = (tag || "").toUpperCase();
    this._attrs = {};
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.className = "";
    this.textContent = "";
    this._innerHTML = "";
    this._listeners = {};
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  hasAttribute(k) { return k in this._attrs; }
  removeAttribute(k) { delete this._attrs[k]; }
  set innerHTML(v) { this._innerHTML = v; }
  get innerHTML() { return this._innerHTML; }
  // Real HTMLAnchorElement reflects `.href` to the `href` attribute; the source sets
  // it as a property (`a.href = w.href`), so the fake must reflect it the same way.
  set href(v) { this._attrs.href = v; }
  get href() { return this._attrs.href; }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  focus() { this._focused = true; }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  fire(type, evt) { (this._listeners[type] || []).forEach((fn) => fn(evt || { preventDefault() {} })); }
  querySelector(sel) {
    // Only what the script actually asks for: a class lookup among direct children.
    const cls = sel.replace(/^\./, "");
    return this.children.find((c) => (c.className || "").split(/\s+/).includes(cls)) || null;
  }
}

function makeFakeEvent(target) {
  return { preventDefault() {}, target: target || null, key: undefined };
}

// Builds the box exactly as spaceSwitcher()'s markup shapes it: `[data-space]`
// containing a `.gvspace__btn`.
function makeBox() {
  const box = new FakeEl("div");
  box._attrs["data-space"] = "";
  const btn = new FakeEl("span");
  btn.className = "gvspace__btn";
  box.appendChild(btn);
  return { box, btn };
}

function runWorkspacesJs({ box, fetchResult, fetchReject }) {
  const documentListeners = {};
  const documentFake = {
    querySelector(sel) { return sel === "[data-space]" ? box : null; },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener(type, fn, capture) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
  };
  const fetchFake = () => fetchReject
    ? Promise.reject(new Error("network down"))
    : Promise.resolve({ ok: true, json: () => Promise.resolve(fetchResult) });
  const run = new Function("document", "fetch", constBody(SRC, "WORKSPACES_JS"));
  run(documentFake, fetchFake);
  return documentListeners;
}

const settle = () => new Promise((r) => setImmediate(r));

test("fewer than two workspaces: the chip is left completely untouched", async () => {
  const { box, btn } = makeBox();
  runWorkspacesJs({ box, fetchResult: { workspaces: [{ workspace: "solo", current: true }] } });
  await settle(); await settle();
  assert.equal(box.children.length, 1, "no menu should have been appended");
  assert.equal(btn.hasAttribute("data-space-toggle"), false, "the chip must not become a toggle");
});

test("an empty workspaces list: same as fewer than two — nothing changes", async () => {
  const { box, btn } = makeBox();
  runWorkspacesJs({ box, fetchResult: { workspaces: [] } });
  await settle(); await settle();
  assert.equal(box.children.length, 1);
  assert.equal(btn.hasAttribute("data-space-toggle"), false);
});

test("a network error reaching /__me/workspaces: no throw, no DOM change", async () => {
  const { box, btn } = makeBox();
  assert.doesNotThrow(() => runWorkspacesJs({ box, fetchReject: true }));
  await settle(); await settle();
  assert.equal(box.children.length, 1);
  assert.equal(btn.hasAttribute("data-space-toggle"), false);
});

test("two or more workspaces: builds the menu, marks current, links the rest by href", async () => {
  const { box, btn } = makeBox();
  runWorkspacesJs({
    box,
    fetchResult: {
      workspaces: [
        { workspace: "here", label: "Here", current: true },
        { workspace: "there", label: "There", current: false, href: "https://accounts.example/enter?workspace=there" },
      ],
    },
  });
  await settle(); await settle();

  assert.equal(box.children.length, 2, "the menu should have been appended alongside the button");
  const menu = box.children[1];
  assert.equal(menu.getAttribute("data-space-menu"), "");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(menu.hidden, true, "starts closed");
  assert.equal(menu.children.length, 2);

  const [current, other] = menu.children;
  assert.equal(current.getAttribute("role"), "menuitem");
  assert.equal(current.getAttribute("aria-current"), "true");
  assert.equal(current.tagName, "DIV", "the current row is not a link — it names where you already are");

  assert.equal(other.tagName, "A");
  assert.equal(other.getAttribute("href"), "https://accounts.example/enter?workspace=there");
  assert.equal(other.textContent, "There");

  assert.equal(btn.getAttribute("data-space-toggle"), "");
  assert.equal(btn.getAttribute("aria-haspopup"), "true");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
});

test("click toggles the menu open and closed; aria-expanded tracks it", async () => {
  const { box, btn } = makeBox();
  runWorkspacesJs({
    box,
    fetchResult: {
      workspaces: [
        { workspace: "here", current: true },
        { workspace: "there", current: false, href: "https://x/enter?workspace=there" },
      ],
    },
  });
  await settle(); await settle();
  const menu = box.children[1];

  btn.fire("click", makeFakeEvent());
  assert.equal(menu.hidden, false);
  assert.equal(btn.getAttribute("aria-expanded"), "true");

  btn.fire("click", makeFakeEvent());
  assert.equal(menu.hidden, true);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
});

test("Escape closes the open menu; an outside mousedown also closes it", async () => {
  const { box, btn } = makeBox();
  const documentListeners = runWorkspacesJs({
    box,
    fetchResult: {
      workspaces: [
        { workspace: "here", current: true },
        { workspace: "there", current: false, href: "https://x/enter?workspace=there" },
      ],
    },
  });
  await settle(); await settle();
  const menu = box.children[1];

  btn.fire("click", makeFakeEvent());
  assert.equal(menu.hidden, false);

  (documentListeners.keydown || []).forEach((fn) => fn({ key: "Escape" }));
  assert.equal(menu.hidden, true, "Escape must close the open menu");

  btn.fire("click", makeFakeEvent());
  assert.equal(menu.hidden, false);
  const strangerEl = new FakeEl("body"); // not inside box
  (documentListeners.mousedown || []).forEach((fn) => fn({ target: strangerEl }));
  assert.equal(menu.hidden, true, "a mousedown outside the chip must close the menu");
});

test("a malformed row (no href, not current) is dropped; if that leaves fewer than two, no dropdown appears", async () => {
  const { box, btn } = makeBox();
  runWorkspacesJs({
    box,
    fetchResult: {
      workspaces: [
        { workspace: "here", current: true },
        { workspace: "broken", current: false }, // no href — cannot be a switch target
      ],
    },
  });
  await settle(); await settle();
  assert.equal(box.children.length, 1, "one usable row is the same as zero: no dropdown");
  assert.equal(btn.hasAttribute("data-space-toggle"), false);
});
