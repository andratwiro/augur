// The canon schema and the seed workspace are ONE format, and this is where that is
// proved rather than promised.
//
// The whole point of `augur canon` is that a design system extracted from a team's live
// product lands in the same shape a workspace is born with — so the screens a workspace
// already has keep working, the page that teaches the system keeps teaching it, and a
// prototype written against one design system works against another. Two formats that
// merely resemble each other would give none of that, and nothing about the diff would
// look wrong on the day they diverged: a role added here and not there simply produces a
// token nobody reads, which renders as `unset` and looks like a styling opinion.
//
// So: the seed's own token file must fill exactly the schema's roles, and every token the
// seed's pages READ must be one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROLES, ROLE_NAMES, ROLE_BY_NAME, OBSERVED_ROLES,
  validateCanon, deriveTokens, parseTokensCss, blankCanon,
  toHex, toPx, contrast, readableOn,
} from "../src/canon/schema.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEED = path.join(ROOT, "seed");
const SEED_TOKENS = path.join(SEED, "skills", "starter-ui", "starter-tokens.css");

test("the seed's design system fills exactly the schema's roles — no more, no fewer", () => {
  const { prefix, tokens, extras } = parseTokensCss(fs.readFileSync(SEED_TOKENS, "utf8"));
  assert.equal(prefix, "starter");
  const missing = ROLE_NAMES.filter((r) => !(r in tokens));
  assert.deepEqual(missing, [], `the seed does not define: ${missing.join(", ")} — add them to the seed, or drop the role`);
  assert.deepEqual(Object.keys(extras), [],
    `the seed defines tokens the schema has no role for: ${Object.keys(extras).join(", ")} — a workspace born with a token the extractor never fills is a second format`);
});

test("the seed's own design system passes the grader", () => {
  const { tokens } = parseTokensCss(fs.readFileSync(SEED_TOKENS, "utf8"));
  const graded = validateCanon({ canonVersion: 1, prefix: "starter", classPrefix: "s", tokens, components: [], source: { url: "seed" } });
  assert.deepEqual(graded.errors, []);
  // Nothing was computed: the seed answers every role itself.
  assert.deepEqual(graded.derived, []);
});

test("every token the seed READS is a role — including the ones its pages read live", () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|html|js|md)$/.test(e.name)) files.push(p);
    }
  };
  walk(SEED);
  const unknown = new Map();
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/--starter-([a-z0-9-]+)/g)) {
      const role = m[1];
      // `"--starter-s" + i` in the design-system page builds s1…s8 at runtime.
      if (role === "s") continue;
      if (!ROLE_BY_NAME.has(role)) unknown.set(role, path.relative(ROOT, f));
    }
  }
  assert.deepEqual([...unknown.entries()], [],
    "a seed page reads a token the schema does not name, so an extracted canon would not fill it");
});

test("the page that teaches the system reads only roles the extractor guarantees", () => {
  // The design-system page is the one screen whose whole content IS the token file. If
  // it reads a name an extracted canon does not emit, the first thing a team sees after
  // extraction is a page of blanks.
  const page = fs.readFileSync(path.join(SEED, "start-here", "prototypes", "set-up-your-design-system", "index.html"), "utf8");
  const read = new Set([...page.matchAll(/css\("(--starter-[a-z0-9-]+)"\)|"(--starter-[a-z0-9-]+)"/g)]
    .map((m) => (m[1] || m[2]).slice("--starter-".length)));
  read.add("s1"); // built by concatenation
  for (const role of read) {
    if (role === "s") continue;
    assert.ok(ROLE_BY_NAME.has(role), `the design-system page reads --starter-${role}, which is not a role`);
  }
  // And the three it WRITES when a person picks a new hot ink are the three the
  // extractor computes from `mark`, so a live pick and an extraction agree.
  for (const role of ["mark", "mark-ink", "wash"]) assert.ok(ROLE_BY_NAME.has(role));
  assert.equal(ROLE_BY_NAME.get("mark-ink").derived, "mark-ink");
  assert.equal(ROLE_BY_NAME.get("wash").derived, "wash");
});

test("a computed mark-ink is legible by construction, wherever the mark starts", () => {
  const sheet = "#fbfaf6";
  for (const mark of ["#cf4224", "#2f4bd8", "#3d7a4a", "#7b3fa0", "#c98a0e", "#ffee00", "#111111", "#f0f0f0"]) {
    const { tokens } = deriveTokens({ sheet, ink: "#1d1b24", mark });
    assert.ok(contrast(toHex(tokens["mark-ink"]), sheet) >= 4.5,
      `mark ${mark} computed a mark-ink that fails contrast — a picked colour may fail, a computed one may not`);
  }
});

test("computing fills every optional role from the four a product always shows you", () => {
  const observed = {
    paper: "#f4f4f5", sheet: "#ffffff", ink: "#18181b", rule: "#e4e4e7", mark: "#2563eb",
    "font-display": "Inter, sans-serif",
    "text-xs": "11px", "text-sm": "13px", "text-md": "15px", "text-lg": "18px",
    "text-xl": "24px", "text-2xl": "32px", "text-3xl": "44px",
    s1: "4px", s2: "8px", s3: "12px", s4: "16px", s5: "24px", s6: "32px", s7: "48px", s8: "64px",
    "radius-1": "4px",
  };
  const { tokens, derived } = deriveTokens(observed);
  for (const r of ROLE_NAMES) assert.ok(tokens[r], `${r} is still empty after deriving`);
  assert.deepEqual(derived.sort(), ROLE_NAMES.filter((r) => !(r in observed)).sort());
  assert.deepEqual(Object.keys(observed).sort(), [...OBSERVED_ROLES].sort(),
    "the fixture answers exactly the observed roles — if this fails, the required set changed and the brief's table is stale");
});

test("a scale that does not climb is refused", () => {
  const base = seedAnswer();
  base.tokens["text-lg"] = "10px";
  const graded = validateCanon(base);
  assert.ok(graded.errors.some((e) => /text-lg/.test(e) && /climb/.test(e)), graded.errors.join("\n"));
});

test("illegible body text is refused, not warned about", () => {
  const base = seedAnswer();
  base.tokens.ink = "#cccccc";
  const graded = validateCanon(base);
  assert.ok(graded.errors.some((e) => /ink on sheet/.test(e)), graded.errors.join("\n"));
});

test("a component that hard-codes a colour is refused", () => {
  const base = seedAnswer();
  base.components = [{
    name: "btn", type: "primitive", label: "Button", description: "A control.",
    classes: ["s-btn"], css: ".s-btn { background: #ff0000; color: var(--starter-sheet); }",
  }];
  const graded = validateCanon(base);
  assert.ok(graded.errors.some((e) => /hard-codes a colour/.test(e)), graded.errors.join("\n"));
});

test("a component that invents a token is refused", () => {
  const base = seedAnswer();
  base.components = [{
    name: "btn", type: "primitive", label: "Button", description: "A control.",
    classes: ["s-btn"], css: ".s-btn { background: var(--starter-brand); }",
  }];
  const graded = validateCanon(base);
  assert.ok(graded.errors.some((e) => /--starter-brand/.test(e)), graded.errors.join("\n"));
});

test("an x- token the canon declares IS available to a component", () => {
  const base = seedAnswer();
  base.tokens["x-brand-navy"] = "#0b2545";
  base.components = [{
    name: "btn", type: "primitive", label: "Button", description: "A control.",
    classes: ["s-btn"], css: ".s-btn { background: var(--starter-brand-navy); }",
  }];
  const graded = validateCanon(base);
  assert.deepEqual(graded.errors, []);
});

test("a var() fallback may name a colour without that counting as hard-coding", () => {
  const base = seedAnswer();
  base.components = [{
    name: "btn", type: "primitive", label: "Button", description: "A control.",
    classes: ["s-btn"], css: ".s-btn { background: var(--starter-mark, #cf4224); }",
  }];
  assert.deepEqual(validateCanon(base).errors, []);
});

test("classes may use a different prefix from tokens, because a real skill does", () => {
  const base = seedAnswer(); // prefix starter, classPrefix s — exactly the seed's shape
  base.components = [{
    name: "btn", type: "primitive", label: "Button", description: "A control.",
    classes: ["s-btn"], css: ".s-btn { color: var(--starter-ink); }",
  }];
  assert.deepEqual(validateCanon(base).errors, []);
  base.classPrefix = "acme";
  assert.ok(validateCanon(base).errors.some((e) => /does not start with "acme-"/.test(e)));
});

test("the skeleton names every role a person has to answer, and nothing else", () => {
  const blank = blankCanon({ url: "https://example.test/app", prefix: "acme" });
  assert.deepEqual(Object.keys(blank.tokens).sort(), [...OBSERVED_ROLES].sort());
  assert.ok(Object.values(blank.tokens).every((v) => v === null));
  const graded = validateCanon(blank);
  assert.ok(!graded.ok);
  // One finding for the lot, not one per role: a wall of identical failures is a wall.
  const unanswered = graded.errors.filter((e) => /unanswered/.test(e));
  assert.equal(unanswered.length, 1);
  assert.equal(graded.errors.length, 1, graded.errors.join("\n"));
});

test("colour and length arithmetic", () => {
  assert.equal(toHex("#FFF"), "#ffffff");
  assert.equal(toHex("rgb(255, 0, 0)"), "#ff0000");
  assert.equal(toHex("rgba(0, 0, 0, 0.5)"), "#000000");
  assert.equal(toHex("hsl(0, 100%, 50%)"), "#ff0000");
  assert.equal(toHex("not a colour"), null);
  assert.equal(toPx("1rem"), 16);
  assert.equal(toPx("12px"), 12);
  assert.equal(toPx("66ch"), null);
  assert.ok(contrast("#000000", "#ffffff") > 20);
  assert.ok(contrast(readableOn("#ffee00", "#ffffff"), "#ffffff") >= 4.5);
  // A dark product: readable means LIGHTER, not darker.
  const onDark = readableOn("#333366", "#111111");
  assert.ok(contrast(onDark, "#111111") >= 4.5);
});

function seedAnswer() {
  const { tokens } = parseTokensCss(fs.readFileSync(SEED_TOKENS, "utf8"));
  return { canonVersion: 1, prefix: "starter", classPrefix: "s", tokens: { ...tokens }, components: [], source: { url: "seed" } };
}
