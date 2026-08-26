#!/usr/bin/env node
/**
 * augur canon — copy the design system out of a product you already have a login for.
 *
 *   augur canon start <url>     make the working folder and the brief for your agent
 *   augur canon collect <url>   read a PUBLIC page over HTTP into observation.json
 *   augur canon snippet         print the collector to paste into your own browser
 *   augur canon check           grade canon.json — what is still unanswered, and why
 *   augur canon apply           write it into this workspace's design system
 *
 * WHAT THIS IS FOR. A team's fourth week is faster than its first only if the workspace
 * accumulates a canon — named, pullable building blocks that every new screen is made
 * of. Building one by hand takes weeks. Every team that would benefit already HAS one:
 * it is their live product. This turns "copy the design system from this URL" into a
 * flow with a working folder, a schema, and a grader.
 *
 * THE ENGINE DOES NOT THINK, AND THAT IS THE DESIGN. Deciding which of a product's
 * eleven greys is its hairline is judgement. Augur ships the harness — the working
 * folder, the token roles, the evidence collector, the grader, the emitter — and your
 * own agent, with your own account at whatever provider you like, does the judging.
 * There is no model call anywhere in this repository, no API key, no endpoint, and this
 * command adds no dependency. `test/canon-no-inference.test.mjs` holds that shut.
 *
 * WHY A URL AND NOT A REPO. Extraction from a codebase already exists elsewhere and is
 * the wrong door for the person who needs this: a PM or a designer holds a login to the
 * product, not commit rights to it. So the collector runs in the browser they are
 * already signed in to, and nothing it produces ever leaves their machine.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observe, mergeObservations } from "../src/canon/observe.mjs";
import {
  ROLES, ROLE_BY_NAME, OBSERVED_ROLES, COMPONENT_TYPES, CANON_VERSION,
  blankCanon, validateCanon, parseTokensCss,
} from "../src/canon/schema.mjs";
import { planApply } from "../src/canon/emit.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const sub = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : (i >= 0 ? true : fallback);
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] || "").startsWith("--"));

const say = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(`augur canon: ${msg}`); process.exit(code); };

const USAGE = `usage: augur canon <start|collect|snippet|check|apply> [options]

  start <url> [--dir <folder>] [--prefix <name>]
        Make the working folder: the brief your agent reads, the schema, the
        skeleton answer, and the browser collector. Prints what to do next.

  collect <url> [--dir <folder>] [--out <file>]
        Read a PUBLIC page and its stylesheets over HTTP into evidence. For a
        product behind a login use "snippet" instead — that is the real door.
  collect --html <file.html> [--css <file.css>]...
        Same, from files you already have.
  collect --merge
        Fold every observation-*.json in the folder into one. Do this after
        collecting three or four different screens.

  snippet [--dir <folder>]
        Write and print the collector to paste into your own browser's console,
        on a page of your product, while you are signed in.

  check [--dir <folder>] [--strict] [--space <workspace>]
        Grade the answer. With --space, grade the design system a workspace is
        actually carrying instead.

  apply [--dir <folder>] [--space <workspace>] [--dry-run]
        Write the canon into the workspace's design system.`;

if (!sub || has("help") || sub === "help") { say(USAGE); process.exit(sub ? 0 : 1); }

const dir = path.resolve(String(flag("dir", "canon")));
const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const rel = (p) => path.relative(process.cwd(), p) || ".";

/* ── The workspace this canon is for ───────────────────────────────────────── */

/** Walk up for a `space.json`, the same marker `discoverSpaces()` looks for. */
function findWorkspace(from) {
  let d = path.resolve(from || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, "space.json"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** The workspace's UI skill, detected exactly as build.js detects it. */
function findSkill(root) {
  const space = readJson(path.join(root, "space.json"), {}) || {};
  const declared = space.designSystem && space.designSystem.skill;
  const skills = path.join(root, "skills");
  let dirName = declared || null;
  if (!dirName && fs.existsSync(skills)) {
    dirName = fs.readdirSync(skills)
      .filter((d) => d.endsWith("-ui") && fs.existsSync(path.join(skills, d, `${d}.css`)))
      .sort()[0] || null;
  }
  if (!dirName) return null;
  return { dirName, prefix: dirName.replace(/-ui$/, ""), abs: path.join(skills, dirName), relPath: `skills/${dirName}` };
}

/* ── start ─────────────────────────────────────────────────────────────────── */

async function cmdStart() {
  const url = positional[0];
  if (!url) die("start needs the URL of a page in your product:\n  augur canon start https://app.example.com/dashboard");
  const ws = findWorkspace(process.cwd());
  const skill = ws ? findSkill(ws) : null;
  const prefix = String(flag("prefix", skill?.prefix || guessPrefix(url)));
  const classPrefix = String(flag("class-prefix", skill ? skillClassPrefix(skill) : prefix));

  if (fs.existsSync(path.join(dir, "canon.json")) && !has("force"))
    die(`${rel(path.join(dir, "canon.json"))} already exists — pass --force to start over, or just keep working in it`);

  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, "canon.json"), JSON.stringify(blankCanon({ url, prefix, classPrefix }), null, 2) + "\n");
  write(path.join(dir, "schema.json"), JSON.stringify(schemaDoc(), null, 2) + "\n");
  write(path.join(dir, "collect-in-browser.js"), fs.readFileSync(path.join(ENGINE, "src/canon/collect-in-browser.js"), "utf8"));
  write(path.join(dir, "BRIEF.md"), brief({ url, prefix, classPrefix, dir, workspace: ws, skill }));

  say(`canon: working folder ready at ${rel(dir)}`);
  say(`  BRIEF.md              what your agent does, start to finish`);
  say(`  schema.json           the ${ROLES.length} token roles, machine-readable`);
  say(`  canon.json            the answer — every observed role still null`);
  say(`  collect-in-browser.js paste into your browser, signed in`);
  say(``);
  if (ws) say(`Workspace: ${rel(ws)}${skill ? ` (design system "${skill.dirName}", tokens --${skill.prefix}-*)` : " (no design system yet)"}`);
  else say(`No space.json above ${rel(process.cwd())} — you can still build the canon here and apply it with --space later.`);
  say(``);
  say(`Next: hand ${rel(path.join(dir, "BRIEF.md"))} to your agent. It is written for one.`);
}

const guessPrefix = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    return /^[a-z][a-z0-9-]*$/.test(host) ? host : "canon";
  } catch { return "canon"; }
};
const skillClassPrefix = (skill) => {
  const manifest = readJson(path.join(skill.abs, "skill.json"), {}) || {};
  const list = Array.isArray(manifest.cssPrefixes) ? manifest.cssPrefixes : [];
  return list.find((p) => p !== skill.prefix) || skill.prefix;
};

function schemaDoc() {
  return {
    canonVersion: CANON_VERSION,
    componentTypes: COMPONENT_TYPES,
    observedRoles: OBSERVED_ROLES,
    roles: ROLES.map((r) => ({
      role: r.role, group: r.group, kind: r.kind, what: r.what,
      answer: r.derived ? "optional — computed from the observed roles when you leave it out" : "required",
      ...(r.scale ? { scale: r.scale } : {}),
    })),
  };
}

/* ── The brief the user's own agent reads ──────────────────────────────────── */

function brief({ url, prefix, classPrefix, dir, workspace, skill }) {
  const here = path.basename(dir);
  const roleTable = ROLES.map((r) => `| \`${r.role}\` | ${r.kind} | ${r.derived ? "computed if omitted" : "**you answer**"} | ${r.what} |`).join("\n");
  return `# Extract this product's design system

You are doing this for the person who owns ${url}. They have a login to it; they do not
have its source. Your job is to turn what that product LOOKS like into a design system
this workspace can build screens from — the same shape a workspace is born with, so the
screens already here keep working and the next ones are made of the product's own parts.

Augur does none of the deciding. It gives you a folder, a list of roles, a grader and an
emitter. Which of the eleven greys is the hairline is your call, and it is the only part
that needs a mind.

## 1 — Collect the evidence

Two doors. Use the one that fits, and use **three or four different screens** either way:
a login page is not a design system, and neither is one dashboard.

**Signed in (the usual case).** Open the product in a browser you are signed in to. Open
the developer console. Paste the whole of \`${here}/collect-in-browser.js\` and press
enter. It reads what the page actually renders — no request, no credential, nothing
leaves the page — and downloads an \`observation-*.json\`. Move each one into
\`${here}/\`. If you can drive a browser yourself, navigate and evaluate that file's
contents in the page instead; the result is the same object.

**Public page.** \`augur canon collect <url> --dir ${here}\` reads the page and its
stylesheets over HTTP. No login, so it only sees what a signed-out visitor sees.

Then fold them together:

    augur canon collect --merge --dir ${here}

You now have \`${here}/observation.json\`: ranked colours (weighted by how much of the
screen they cover), font stacks, the sizes and gaps in use, radii, shadows, whatever
custom properties the product already declares, and the class families that are
candidate components. It is evidence. It is not an answer.

## 2 — Map the evidence onto the roles

Open \`${here}/canon.json\`. Every role below that says **you answer** is \`null\`. Fill
it in with a value from the evidence — a real one, spelled the way the product spells it.

${roleTable}

Reading the evidence:

- **\`sheet\` and \`paper\`** are the two most-covering background colours. \`sheet\` is
  the one text sits on; \`paper\` is what is behind the sheet. On a product with no
  distinction, make \`paper\` a hair darker than \`sheet\` and say so in \`notes\`.
- **\`ink\`** is the highest-area \`color\` value, near-black on light products.
- **\`rule\`** is the colour that appears on \`borderColor\` far more than on anything
  else. It is usually a grey that is nearly invisible, and it is easy to mistake for
  \`ink-3\`; the tell is the property it was seen on.
- **\`mark\` is the single most important decision here.** It is the colour the product
  uses for the thing you are meant to act on: the primary button, the active tab, the
  link. It is almost never the most COMMON colour — it is the most SATURATED one with a
  meaningful count. If two candidates tie, take the one seen on a button.
- **The type scale** is the distinct \`font-size\` values, largest to smallest, thinned
  to seven. Products carry more than seven; pick the ones that carry real weight and drop
  near-duplicates (15px and 15.5px are one step). It has to climb — the grader checks.
- **The space ramp** is the distinct paddings and gaps, thinned to eight, climbing.
- **If the product already declares custom properties** (\`customProperties\` in the
  observation), read them first. A product with \`--brand-primary\` has already done half
  of this job and you should take its answer, not re-derive one.
- Leave a **computed** role \`null\` unless the product genuinely has its own. The
  computed ones are derived from what you did answer, and they are derived to be legible
  — a \`mark-ink\` computed from \`mark\` is guaranteed to pass contrast as text, which a
  colour picked by eye often does not.
- A value the roles have no slot for goes under an \`x-\` name (\`"x-brand-navy": "#0b2545"\`).
  It emits as a real token and components may use it.

## 3 — Name the components

Fill \`components\` with the parts the product is actually made of — the button, the
card, the field, the table row, the nav item. Take the class families from the evidence
as your candidates and take the sizes and colours from the roles you just filled.

    {
      "name": "button",
      "type": "primitive",
      "label": "Button",
      "description": "One hot-ink button per screen; everything else is quiet.",
      "classes": ["${classPrefix}-btn"],
      "css": ".${classPrefix}-btn { font: var(--${prefix}-text-md)/1 var(--${prefix}-font-display); padding: var(--${prefix}-s2) var(--${prefix}-s4); border: var(--${prefix}-hair); border-radius: var(--${prefix}-radius-1); background: var(--${prefix}-sheet); color: var(--${prefix}-ink); }\\n.${classPrefix}-btn--mark { background: var(--${prefix}-mark); color: var(--${prefix}-sheet); border-color: transparent; }"
    }

Three rules the grader enforces, all for the same reason — a component that hard-codes a
value stops moving when a token changes, and then the design system is decoration:

1. **No literal colours in \`css\`.** Every colour is \`var(--${prefix}-…)\`. If you need
   one the roles do not name, add an \`x-\` token and use that.
2. **Every \`var()\` must name a token this canon defines.** Inventing one fails.
3. **Every class starts \`${classPrefix}-\`**, and the CSS defines every class it lists.

Six to twelve components is a design system. Forty is a copy of a stylesheet.

## 4 — Grade it, and fix what it says

    augur canon check --dir ${here}

It names every unanswered role, every scale that does not climb, every component that
hard-codes a colour, and it computes the contrast ratios. **Do not stop until it passes.**
It is arithmetic, not taste, and it is the same check the person will run.

## 5 — Apply it${workspace ? "" : " (needs a workspace)"}

    augur canon apply --dir ${here}${workspace ? "" : " --space <folder with space.json>"}

That writes${skill ? ` into \`${skill.relPath}/\`` : " the workspace's design system"}:

- \`${prefix}-tokens.css\` — regenerated, every role filled. Every screen in the
  workspace already links this file, so they all re-skin at once.
- \`${prefix}-canon.css\` — your components. A new file; the workspace's own component
  stylesheet is never touched, and a class name that already exists is a refusal.
- \`skill.json\`, \`registry.json\`, \`CANON.md\` — the manifest, the overlay's labels,
  and the canon's own record of where it came from.

## 6 — Prove it, do not claim it

Open a prototype in this workspace and LOOK at it — \`npm run offline\` from the
workspace's parent folder, or just open a prototype's \`index.html\` from disk. The
screens should be wearing the product's colours. If they are not, the prototype is not
linking the tokens file, and nothing you write in a report changes that.

Then write one new screen using only \`.${classPrefix}-*\` classes and the tokens. If you
reach for a value that is not a token, that is the canon telling you it is missing a
role — add an \`x-\` token, re-apply, and carry on.
`;
}

/* ── collect ───────────────────────────────────────────────────────────────── */

async function cmdCollect() {
  const out = String(flag("out", path.join(dir, "observation.json")));

  if (has("merge")) {
    if (!fs.existsSync(dir)) die(`no folder at ${rel(dir)} — run \`augur canon start <url>\` first`);
    const files = fs.readdirSync(dir).filter((f) => /^observation.*\.json$/.test(f) && f !== "observation.json");
    const all = files.map((f) => readJson(path.join(dir, f))).filter(Boolean);
    if (fs.existsSync(path.join(dir, "observation.json")) && has("keep")) all.unshift(readJson(path.join(dir, "observation.json")));
    if (!all.length) die(`no observation-*.json files in ${rel(dir)} — collect some first (see BRIEF.md)`);
    const merged = mergeObservations(all);
    merged.source.how = all.some((o) => o.source?.how === "browser") ? "browser" : "fetch";
    write(path.join(dir, "observation.json"), JSON.stringify(merged, null, 2) + "\n");
    say(`canon: merged ${all.length} observation(s) → ${rel(path.join(dir, "observation.json"))}`);
    return summarise(merged);
  }

  const htmlFile = flag("html");
  let observation;
  if (typeof htmlFile === "string") {
    const html = fs.readFileSync(htmlFile, "utf8");
    const cssFiles = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === "--css" && argv[i + 1]) cssFiles.push(argv[++i]);
    const sheets = cssFiles.map((f) => ({ href: f, text: fs.readFileSync(f, "utf8") }));
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) sheets.push({ href: "[inline]", text: m[1] });
    observation = observe({ url: `file://${path.resolve(htmlFile)}`, html, sheets });
  } else {
    const url = positional[0];
    if (!url) die("collect needs a URL, or --html <file>, or --merge");
    observation = await collectUrl(url);
  }

  write(out, JSON.stringify(observation, null, 2) + "\n");
  say(`canon: ${rel(out)}`);
  summarise(observation);
  if (observation.source.how === "fetch") {
    say(``);
    say(`This is what a signed-OUT visitor sees. If the product's real screens are behind`);
    say(`the login, run the browser collector instead: augur canon snippet`);
  }
}

async function collectUrl(url) {
  const page = await fetchText(url);
  const sheets = [];
  for (const m of page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) sheets.push({ href: "[inline]", text: m[1] });
  const links = [...page.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /rel\s*=\s*["']?stylesheet/i.test(m[0]))
    .map((m) => (/href\s*=\s*["']([^"']+)["']/i.exec(m[0]) || [])[1])
    .filter(Boolean);
  for (const href of links.slice(0, 25)) {
    try {
      const abs = new URL(href, url).href;
      sheets.push({ href: abs, text: await fetchText(abs) });
    } catch (e) { say(`  (skipped ${href}: ${e.message})`); }
  }
  return observe({ url, html: page, sheets });
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "augur-canon/1 (design-system extraction; +local)" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

function summarise(o) {
  const top = (list, n = 6) => (list || []).slice(0, n).map((e) => e.value).join("  ");
  say(`  pages       ${(o.source?.pages || []).length}   elements ${o.stats?.elements || 0}   stylesheets ${o.stats?.sheets || 0}`);
  say(`  colours     ${top(o.colors)}`);
  say(`  type        ${top(o.fontSizes, 8)}`);
  say(`  space       ${top(o.spacings, 8)}`);
  say(`  radii       ${top(o.radii, 5)}`);
  if ((o.customProperties || []).length) say(`  the product already declares ${o.customProperties.length} custom properties — read those first`);
  say(`  families    ${(o.classFamilies || []).slice(0, 8).map((f) => f.root).join("  ")}`);
}

/* ── snippet ───────────────────────────────────────────────────────────────── */

function cmdSnippet() {
  const src = fs.readFileSync(path.join(ENGINE, "src/canon/collect-in-browser.js"), "utf8");
  const target = path.join(dir, "collect-in-browser.js");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, src);
  say(`canon: ${rel(target)}`);
  say(``);
  say(`  1. Open your product in a browser, signed in, on a screen that matters.`);
  say(`  2. Open the developer console.`);
  say(`  3. Paste the whole file and press enter.`);
  say(`  4. It downloads observation-<host>-<time>.json. Move it into ${rel(dir)}.`);
  say(`  5. Repeat on three or four different screens, then: augur canon collect --merge --dir ${rel(dir)}`);
  say(``);
  say(`It makes no request, reads no credential and touches no cookie — read it first if you like.`);
}

/* ── check ─────────────────────────────────────────────────────────────────── */

function cmdCheck() {
  const spaceFlag = flag("space");
  if (spaceFlag) {
    const root = path.resolve(String(spaceFlag));
    const skill = findSkill(root);
    if (!skill) die(`no design system under ${rel(root)}/skills — nothing to grade`);
    const tokensFile = path.join(skill.abs, `${skill.prefix}-tokens.css`);
    if (!fs.existsSync(tokensFile)) die(`${rel(tokensFile)} does not exist`);
    const { tokens, extras } = parseTokensCss(fs.readFileSync(tokensFile, "utf8"), skill.prefix);
    const canon = { canonVersion: CANON_VERSION, prefix: skill.prefix, tokens, components: [], source: { url: `${skill.relPath}` } };
    for (const [k, v] of Object.entries(extras)) canon.tokens[`x-${k}`] = v;
    report(validateCanon(canon, { strict: has("strict") }), `${rel(tokensFile)}`);
    return;
  }
  const file = path.join(dir, "canon.json");
  const canon = readJson(file);
  if (!canon) die(`no ${rel(file)} — run \`augur canon start <url>\` first`);
  report(validateCanon(canon, { strict: has("strict") }), rel(file));
}

function report(graded, what) {
  const answered = OBSERVED_ROLES.length - graded.errors.filter((e) => e.startsWith("tokens: ") && e.includes("unanswered")).length;
  say(`canon: ${what}`);
  say(`  roles      ${ROLES.length} total, ${OBSERVED_ROLES.length} to answer, ${graded.derived.length} computed`);
  say(`  components ${graded.componentCount || 0}`);
  if (graded.warnings.length) { say(``); for (const w of graded.warnings) say(`  note   ${w}`); }
  if (graded.errors.length) {
    say(``);
    for (const e of graded.errors) say(`  FAIL   ${e}`);
    say(``);
    say(`${graded.errors.length} thing(s) to fix. Every one of them is arithmetic — see BRIEF.md step 2.`);
    process.exit(1);
  }
  say(``);
  say(`  PASS — complete, legible, and every component drinks from a token.`);
  say(`  Next: augur canon apply --dir ${rel(dir)}`);
}

/* ── apply ─────────────────────────────────────────────────────────────────── */

function cmdApply() {
  const file = path.join(dir, "canon.json");
  const canon = readJson(file);
  if (!canon) die(`no ${rel(file)} — run \`augur canon start <url>\` first`);

  const root = flag("space") ? path.resolve(String(flag("space"))) : findWorkspace(process.cwd());
  if (!root) die(`no space.json above ${rel(process.cwd())} — name the workspace with --space <folder>`);
  let skill = findSkill(root);
  if (!skill) {
    // A workspace with no design system gets one named after the canon.
    const dirName = `${canon.prefix}-ui`;
    skill = { dirName, prefix: canon.prefix, abs: path.join(root, "skills", dirName), relPath: `skills/${dirName}` };
    say(`canon: this workspace has no design system — creating ${skill.relPath}/`);
  }

  const plan = planApply({
    canon,
    skillDir: skill.relPath,
    skillPrefix: skill.prefix,
    existingSkillJson: readJson(path.join(skill.abs, "skill.json"), null),
    existingRegistry: readJson(path.join(root, "registry.json"), null),
    existingComponentCss: readSafe(path.join(skill.abs, `${skill.dirName}.css`)),
    observation: readJson(path.join(dir, "observation.json"), null),
  });

  for (const n of plan.notes) say(`  note   ${n}`);
  for (const w of plan.warnings) say(`  note   ${w}`);
  if (!plan.ok) {
    for (const e of plan.errors) say(`  FAIL   ${e}`);
    die(`${plan.errors.length} thing(s) to fix before this can be written. Nothing was changed.`);
  }

  const dry = has("dry-run");
  for (const w of plan.writes) {
    const target = path.join(root, w.path);
    const before = readSafe(target);
    const verb = before === "" ? "create" : before === w.text ? "unchanged" : "rewrite";
    say(`  ${dry ? "would " : ""}${verb.padEnd(9)} ${rel(target)}${verb === "rewrite" ? `  (${before.split("\n").length} → ${w.text.split("\n").length} lines)` : ""}`);
    if (!dry && verb !== "unchanged") write(target, w.text);
  }
  say(``);
  if (dry) { say(`Dry run — nothing written.`); return; }
  say(`canon: ${skill.relPath}/ now carries the canon.`);
  say(`  Every screen that links ${skill.prefix}-tokens.css is wearing it. Go and LOOK at one:`);
  say(`  open a prototype's index.html, or run \`npm run offline\` from the folder above this one.`);
}

const readSafe = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

/* ── router ────────────────────────────────────────────────────────────────── */

const run = { start: cmdStart, collect: cmdCollect, snippet: cmdSnippet, check: cmdCheck, apply: cmdApply }[sub];
if (!run) { console.error(USAGE); process.exit(1); }
await run();
