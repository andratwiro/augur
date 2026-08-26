// Applying a canon to a workspace that already has screens in it. The failure mode this
// guards against is the expensive one: an extractor that "works" by replacing a
// workspace's design system wholesale takes every prototype down with it, and the damage
// is not visible in the diff — it is visible when somebody opens a page.
//
// So the rules are: the tokens file is regenerated (that is the re-skin, and it is safe
// precisely because the roles are fixed), the workspace's own component stylesheet is
// never touched, and a class name that already exists is a refusal rather than a second
// rule for the same selector in a second file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planApply, mergeRegistry, mergeSkillJson, renderTokensCss } from "../src/canon/emit.mjs";
import { parseTokensCss, ROLE_NAMES, validateCanon } from "../src/canon/schema.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEED = path.join(ROOT, "seed");
const CLI = path.join(ROOT, "scripts", "canon.mjs");

function seedTokens() {
  return parseTokensCss(fs.readFileSync(path.join(SEED, "skills", "starter-ui", "starter-tokens.css"), "utf8")).tokens;
}

/** A complete answer against a made-up product, in the seed workspace's prefixes. */
function answer(over = {}) {
  return {
    canonVersion: 1,
    prefix: "starter",
    classPrefix: "s",
    source: { url: "https://app.example.test/board", collectedAt: "2001-01-01T00:00:00.000Z", how: "browser" },
    tokens: {
      paper: "#eef1f5", sheet: "#ffffff", ink: "#101828", rule: "#e3e8ef", mark: "#1e5eff",
      "font-display": '"Some Face", system-ui, sans-serif',
      "text-xs": "11px", "text-sm": "13px", "text-md": "15px", "text-lg": "18px",
      "text-xl": "24px", "text-2xl": "32px", "text-3xl": "44px",
      s1: "4px", s2: "8px", s3: "12px", s4: "16px", s5: "24px", s6: "32px", s7: "48px", s8: "64px",
      "radius-1": "6px",
      ...(over.tokens || {}),
    },
    components: over.components || [{
      name: "pill", type: "primitive", label: "Pill", description: "A rounded status tag.",
      classes: ["s-pill"],
      css: ".s-pill { padding: var(--starter-s1) var(--starter-s3); border-radius: var(--starter-radius-pill); background: var(--starter-wash); color: var(--starter-mark-ink); }",
    }],
    ...(over.top || {}),
  };
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-emit-"));
  fs.cpSync(SEED, dir, { recursive: true });
  return dir;
}

test("apply regenerates the tokens file, and every role survives the round trip", () => {
  const ws = workspace();
  const plan = planApply({
    canon: answer(), skillDir: "skills/starter-ui", skillPrefix: "starter",
    existingSkillJson: JSON.parse(fs.readFileSync(path.join(ws, "skills/starter-ui/skill.json"), "utf8")),
    existingRegistry: JSON.parse(fs.readFileSync(path.join(ws, "registry.json"), "utf8")),
    existingComponentCss: fs.readFileSync(path.join(ws, "skills/starter-ui/starter-ui.css"), "utf8"),
  });
  assert.deepEqual(plan.errors, []);
  const tokensWrite = plan.writes.find((w) => w.path.endsWith("starter-tokens.css"));
  const { prefix, tokens, extras } = parseTokensCss(tokensWrite.text);
  assert.equal(prefix, "starter");
  assert.deepEqual(ROLE_NAMES.filter((r) => !(r in tokens)), []);
  assert.deepEqual(Object.keys(extras), []);
  assert.equal(tokens.mark, "#1e5eff");
  // And the regenerated file is itself a valid canon — the format is closed under apply.
  assert.deepEqual(validateCanon({ prefix: "starter", classPrefix: "s", tokens, components: [], source: { url: "x" } }).errors, []);
});

test("an x- token emits as a real token the components may read", () => {
  const canon = answer({ tokens: { "x-brand-navy": "#0b2545" } });
  canon.components = [{
    name: "banner", type: "component", label: "Banner", description: "The product's dark strip.",
    classes: ["s-banner"], css: ".s-banner { background: var(--starter-brand-navy); color: var(--starter-sheet); }",
  }];
  const plan = planApply({ canon, skillDir: "skills/starter-ui", skillPrefix: "starter", existingSkillJson: {}, existingRegistry: null, existingComponentCss: "" });
  assert.deepEqual(plan.errors, []);
  const tokensText = plan.writes.find((w) => w.path.endsWith("starter-tokens.css")).text;
  assert.match(tokensText, /--starter-brand-navy:\s*#0b2545;/);
});

test("a class the workspace already defines is a refusal, not a second rule", () => {
  const ws = workspace();
  const canon = answer();
  canon.components[0].classes = ["s-btn"];
  canon.components[0].css = ".s-btn { color: var(--starter-ink); }";
  const plan = planApply({
    canon, skillDir: "skills/starter-ui", skillPrefix: "starter",
    existingSkillJson: {}, existingRegistry: null,
    existingComponentCss: fs.readFileSync(path.join(ws, "skills/starter-ui/starter-ui.css"), "utf8"),
  });
  assert.ok(!plan.ok);
  assert.ok(plan.errors.some((e) => /s-btn is already defined/.test(e)), plan.errors.join("\n"));
});

test("apply never writes the workspace's own component stylesheet", () => {
  const plan = planApply({ canon: answer(), skillDir: "skills/starter-ui", skillPrefix: "starter", existingSkillJson: {}, existingRegistry: null, existingComponentCss: "" });
  assert.deepEqual(plan.writes.filter((w) => w.path.endsWith("starter-ui.css")), []);
  assert.deepEqual(plan.writes.map((w) => w.path).sort(), [
    "registry.json",
    "skills/starter-ui/CANON.md",
    "skills/starter-ui/skill.json",
    "skills/starter-ui/starter-canon.css",
    "skills/starter-ui/starter-tokens.css",
  ]);
});

test("the registry keeps the workspace's own words and only adds what is new", () => {
  const existing = { items: [{ name: "card", type: "component", classes: ["s-card"], label: "Card", description: "The workspace's own sentence." }] };
  const { registry, added } = mergeRegistry(existing, [
    { name: "card", type: "component", classes: ["s-card", "s-card--mark"], label: "CARD", description: "an extractor's sentence" },
    { name: "pill", type: "primitive", classes: ["s-pill"], label: "Pill", description: "A rounded tag." },
  ]);
  const card = registry.items.find((i) => i.name === "card");
  assert.equal(card.description, "The workspace's own sentence.");
  assert.deepEqual(card.classes, ["s-card", "s-card--mark"]);
  assert.deepEqual(added, ["pill"]);
});

test("the skill manifest gains the generated files and both prefixes, losing nothing", () => {
  const skill = mergeSkillJson({ assets: ["starter-tokens.css", "starter-ui.css", "starter-ui.js"], cssPrefixes: ["s", "starter"] },
    { prefix: "starter", classPrefix: "s", files: ["starter-tokens.css", "starter-canon.css"] });
  assert.deepEqual(skill.assets, ["starter-tokens.css", "starter-ui.css", "starter-ui.js", "starter-canon.css"]);
  assert.deepEqual(skill.cssPrefixes.sort(), ["s", "starter"]);
});

test("a canon that calls itself something else still emits under the workspace's prefix", () => {
  // Renaming a workspace's tokens orphans every prototype that reads them, so the
  // workspace's name wins and the mismatch is reported rather than obeyed.
  const canon = answer({ top: { prefix: "acme" } });
  canon.components = [];
  const plan = planApply({ canon, skillDir: "skills/starter-ui", skillPrefix: "starter", existingSkillJson: {}, existingRegistry: null, existingComponentCss: "" });
  assert.equal(plan.prefix, "starter");
  assert.ok(plan.notes.some((n) => /keep working/.test(n)), plan.notes.join("\n"));
  assert.match(plan.writes.find((w) => w.path.endsWith("-tokens.css")).text, /--starter-mark:/);
});

test("end to end through the CLI: start → answer → check → apply, in a copy of the seed", () => {
  const ws = workspace();
  const node = process.execPath;
  const run = (...args) => execFileSync(node, [CLI, ...args], { cwd: ws, encoding: "utf8" });

  const started = run("start", "https://app.example.test/board");
  assert.match(started, /design system "starter-ui"/);
  assert.ok(fs.existsSync(path.join(ws, "canon", "BRIEF.md")));
  assert.ok(fs.existsSync(path.join(ws, "canon", "collect-in-browser.js")));

  // check refuses the skeleton
  assert.throws(() => run("check"), /Command failed/);

  fs.writeFileSync(path.join(ws, "canon", "canon.json"), JSON.stringify(answer(), null, 2));
  assert.match(run("check"), /PASS/);

  const applied = run("apply");
  assert.match(applied, /rewrite.*starter-tokens\.css/);
  assert.match(applied, /create.*starter-canon\.css/);

  // The tokens file on disk now carries the product's mark, and the workspace's own
  // component stylesheet is byte-identical to the seed's.
  const onDisk = fs.readFileSync(path.join(ws, "skills/starter-ui/starter-tokens.css"), "utf8");
  assert.match(onDisk, /--starter-mark:\s*#1e5eff;/);
  assert.equal(
    fs.readFileSync(path.join(ws, "skills/starter-ui/starter-ui.css"), "utf8"),
    fs.readFileSync(path.join(SEED, "skills/starter-ui/starter-ui.css"), "utf8"));

  // And the workspace's design system still grades clean, read back off disk.
  assert.match(run("check", "--space", "."), /PASS/);

  // The registry gained the extracted component, so the comment overlay can label it.
  const reg = JSON.parse(fs.readFileSync(path.join(ws, "registry.json"), "utf8"));
  assert.ok(reg.items.some((i) => i.name === "pill"));
  assert.ok(reg.items.some((i) => i.name === "card"), "the seed's own entries survived");
});

test("the emitted tokens file is stable — applying the same canon twice writes nothing", () => {
  const canon = answer();
  const once = renderTokensCss({ prefix: "starter", tokens: validateCanon(canon).tokens, derived: validateCanon(canon).derived, source: canon.source });
  const twice = renderTokensCss({ prefix: "starter", tokens: validateCanon(canon).tokens, derived: validateCanon(canon).derived, source: canon.source });
  assert.equal(once, twice);
});

test("the seed workspace still builds after a canon lands on it", () => {
  // The point of one format: a re-skin is not a migration. If a real build cannot
  // compose the workspace after apply, "same shape" was a claim and not a fact.
  const ws = workspace();
  fs.mkdirSync(path.join(ws, "canon"), { recursive: true });
  fs.writeFileSync(path.join(ws, "canon", "canon.json"), JSON.stringify(answer(), null, 2));
  execFileSync(process.execPath, [CLI, "apply"], { cwd: ws, encoding: "utf8" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "canon-build-"));
  execFileSync(process.execPath, [path.join(ROOT, "build.js")], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, GV_SPACES_ROOT: ws, GV_DIST: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // And the extracted values actually SHIPPED — the skill's declared inventory carries
  // both generated files to the served tree, which is the only thing a browser sees.
  const shipped = path.join(out, "skills", "starter-ui");
  assert.match(fs.readFileSync(path.join(shipped, "starter-tokens.css"), "utf8"), /--starter-mark:\s*#1e5eff;/);
  assert.match(fs.readFileSync(path.join(shipped, "starter-canon.css"), "utf8"), /\.s-pill/);
});
