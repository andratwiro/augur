// Runtime chrome composition — the shared rail renderer + the worker's serve-time
// composer. See src/chrome/appchrome.mjs and composeChrome in src/_worker.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAppChrome, renderSpaceContextScript } from "../src/chrome/appchrome.mjs";

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
