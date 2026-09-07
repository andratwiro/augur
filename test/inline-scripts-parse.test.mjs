// Every inline script the engine's own pages render has to PARSE — because a page whose
// script does not parse is a page whose buttons do nothing, and no test of the markup's
// content notices. The welcome page shipped exactly that on 7 Sep 2026: a `\"` inside the
// template literal that renders it emitted a bare quote, the browser answered "missing )
// after argument list", and "Yes, I have one" did nothing for the person who had just run
// `augur connect`. Rendering here and handing each <script> to the parser is the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderWelcomePage } from "../src/welcome-page.mjs";
import { __testables as W } from "../src/_worker.js";

function scriptsOf(html) {
  const out = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\ssrc=/.test(m[0])) out.push(m[1]);
  return out;
}
function parses(html, label) {
  const scripts = scriptsOf(html);
  assert.ok(scripts.length > 0, `${label} renders at least one inline script`);
  for (const [i, js] of scripts.entries()) {
    try { new vm.Script(js, { filename: `${label}#${i}.js` }); }
    catch (e) {
      const ln = Number((e.stack.match(/#\d+\.js:(\d+)/) || [])[1]) || 0;
      assert.fail(`${label} script ${i} does not parse: ${e.message}${ln ? ` at line ${ln}: ${js.split("\n")[ln - 1].trim()}` : ""}`);
    }
  }
  return scripts;
}

test("the welcome page's script parses, with and without a code in the link", () => {
  parses(renderWelcomePage({ origin: "https://ws.example.test", me: { email: "ana@example.test" } }), "welcome");
  parses(renderWelcomePage({ origin: "", me: null }), "welcome-bare");
  // The person's address is embedded as a JS string; an address that tries to close the
  // string or the script must still leave a page that parses.
  parses(renderWelcomePage({ origin: "https://ws.example.test", me: { email: `a"b'</script><script>x@example.test` } }), "welcome-hostile-email");
});

test("the approval page's script parses", () => {
  const tctx = W.applyInstance({ users: [{ email: "ana@example.test", name: "Ana", role: "admin" }] });
  parses(W.connectPage(tctx, tctx.USERS[0], "https://ws.example.test"), "connect");
});
