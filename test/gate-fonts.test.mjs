// The auth gate must not depend on an external font host.
//
// The login gate, invite page and 404 are the first bytes a user sees; render-blocking
// on fonts.googleapis.com + fonts.gstatic.com made first paint wait on a third party,
// even though the app already ships Inter locally at /fonts/. This holds the swap:
// no external font request, and the local @font-face is present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

// An empty workspace context: these pages must self-host their font whatever a
// deployment publishes, so the fixture deliberately carries no config at all.
const CTX = W.__setChromeTestState(null, [], false);

const pages = {
  loginPage: W.loginPage(CTX, "/", false),
  invitePage: typeof W.invitePage === "function" ? W.invitePage(CTX, { email: "a@b.co", token: "t" }) : null,
};

for (const [name, html] of Object.entries(pages)) {
  if (html == null) continue;
  test(`${name} makes no external font request`, () => {
    // Match an actual URL/host usage, not a passing mention in a comment.
    assert.ok(!/https:\/\/fonts\.googleapis/.test(html), `${name} still links fonts.googleapis`);
    assert.ok(!/https:\/\/fonts\.gstatic/.test(html), `${name} still preconnects fonts.gstatic`);
  });
  test(`${name} self-hosts Inter from /fonts/`, () => {
    assert.match(html, /@font-face[\s\S]*inter-latin-wght-normal\.woff2/, `${name} lacks the local @font-face`);
  });
}
