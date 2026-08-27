// The evidence collector reads a real product's CSS, and real product CSS is minified,
// vendored, nested and occasionally broken. A parser that gives up on the first surprise
// reads nothing at all — and reads nothing SILENTLY, producing an empty observation that
// looks exactly like a product with no styling. So the cases below are all "the shapes a
// shipped stylesheet actually has", not "well-formed CSS".
import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, cssRules, declsOf, colorsIn, lengthsIn, classFamilies, mergeObservations } from "../src/canon/observe.mjs";

const valueOf = (list, v) => list.find((e) => e.value === v);

test("a minified, nested, at-ruled stylesheet still yields declarations", () => {
  const css = `
    /* a comment { with a brace */
    @media (min-width:40em){.a-card{background:#fff;padding:16px}}
    @supports (display:grid){.a-grid{gap:8px}}
    @font-face{font-family:X;src:url(x.woff2)}
    .a-btn{color:rgb(20,20,20);border:1px solid #e5e5e5;border-radius:4px}
    .broken{color:
  `;
  const rules = cssRules(css);
  const selectors = rules.map((r) => r.selector);
  assert.ok(selectors.includes(".a-card"), selectors.join(" | "));
  assert.ok(selectors.includes(".a-grid"));
  assert.ok(selectors.includes(".a-btn"));
  const o = observe({ url: "https://example.test/", html: "", sheets: [{ text: css }] });
  assert.ok(valueOf(o.colors, "#fff"));
  assert.ok(valueOf(o.colors, "rgb(20,20,20)"));
  assert.ok(valueOf(o.spacings, "16px"));
  assert.ok(valueOf(o.radii, "4px"));
});

test("a declaration value may contain semicolons-in-parens and quotes", () => {
  const pairs = declsOf(`background:url("a;b.png");font-family:"Some Face", serif;transition:color .2s ease`);
  assert.deepEqual(pairs.map((p) => p[0]), ["background", "font-family", "transition"]);
  assert.equal(pairs[1][1], `"Some Face", serif`);
});

test("colours are kept in the product's own spelling, not normalised away", () => {
  // The agent has to recognise the value when it goes looking in the product, so the
  // evidence shows what the product wrote, not what a converter would prefer.
  assert.deepEqual(colorsIn("linear-gradient(#ff0000, rgba(0,0,0,.4))"), ["#ff0000", "rgba(0,0,0,.4)"]);
  assert.deepEqual(lengthsIn("8px 16px"), ["8px", "16px"]);
  assert.deepEqual(lengthsIn("-4px 8px"), ["8px"], "negative margins are not a space ramp step");
});

test("custom properties the product already declares are surfaced whole", () => {
  // The biggest single shortcut in the whole flow: a product that already has tokens has
  // done half this job, and the brief tells the agent to read these first.
  const o = observe({ sheets: [{ text: ":root{--brand-primary:#2563eb;--brand-radius:6px}" }] });
  assert.deepEqual(o.customProperties, [
    { name: "--brand-primary", value: "#2563eb" },
    { name: "--brand-radius", value: "6px" },
  ]);
});

test("inline style attributes count — a product's loudest colour is often one", () => {
  const o = observe({ html: `<div style="background-color:#0b2545">x</div>`, sheets: [] });
  assert.ok(valueOf(o.colors, "#0b2545"));
  assert.deepEqual(valueOf(o.colors, "#0b2545").where, ["[inline]"]);
});

test("class families rank a design system's namespace above one-off classes", () => {
  const html = `<div class="ds-card ds-card--tight"><span class="ds-chip">a</span>
                <span class="ds-chip ds-chip--ok">b</span><i class="mt-2">x</i><i class="mt-2">y</i></div>`;
  const fams = classFamilies(html);
  const roots = fams.map((f) => f.root);
  assert.ok(roots.includes("ds-card") && roots.includes("ds-chip"), roots.join(" | "));
  // A family with two distinct members outranks a utility class used twice: the signal
  // wanted is "a namespace with variants", not "a class that appears a lot".
  assert.ok(roots.indexOf("ds-chip") < roots.indexOf("mt-2"), roots.join(" | "));
});

test("merging several pages adds counts and keeps every page's URL", () => {
  const a = observe({ url: "https://example.test/one", sheets: [{ text: ".x{color:#111}" }] });
  const b = observe({ url: "https://example.test/two", sheets: [{ text: ".y{color:#111;background:#fff}" }] });
  const m = mergeObservations([a, b]);
  assert.deepEqual(m.source.pages, ["https://example.test/one", "https://example.test/two"]);
  assert.equal(valueOf(m.colors, "#111").count, 2);
  assert.ok(valueOf(m.colors, "#fff"));
});

test("an empty stylesheet produces an empty observation, not a crash", () => {
  const o = observe({});
  assert.equal(o.observationVersion, 1);
  assert.deepEqual(o.colors, []);
});

test("the browser collector emits the same shape as the fetch door", async () => {
  // Both doors feed one downstream, so their agreement is a contract. The file is read as
  // TEXT here rather than imported: it is written to be pasted into a console, and a test
  // that imported it would be testing a different file from the one people paste.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(root, "src", "canon", "collect-in-browser.js"), "utf8");
  const fetched = observe({});
  for (const key of Object.keys(fetched)) {
    assert.ok(new RegExp(`\\b${key}:`).test(src), `the browser collector never emits "${key}", which the fetch door does`);
  }
  assert.ok(/observationVersion: 1/.test(src));
  // It must not phone home. The whole promise of pasting it into your own product is
  // that nothing leaves the page.
  for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /new\s+WebSocket/, /import\s*\(/]) {
    assert.ok(!forbidden.test(src), `the browser collector contains ${forbidden} — it must make no request of any kind`);
  }
});
