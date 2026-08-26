/**
 * canon/emit — a graded canon becomes the workspace's design system.
 *
 * Everything here is deterministic text generation from `canon.json`. The judgement was
 * spent upstream, by the user's own agent, deciding which of a product's colours is the
 * hairline; this file only writes it down in the one shape the rest of the engine reads
 * (agents/ui-skill.md): a tokens stylesheet whose custom properties are the roles, a
 * components stylesheet that names nothing but those tokens, the skill manifest, and the
 * workspace registry the comment overlay labels components from.
 *
 * TWO RULES MAKE IT SAFE TO RUN ON A WORKSPACE THAT ALREADY HAS SCREENS IN IT.
 *
 *   1. It REPLACES the tokens file and never touches the components file. The roles are
 *      the contract; a workspace born from the seed already links `<prefix>-tokens.css`
 *      from every prototype, so replacing values re-skins every screen at once and
 *      breaks none of them. `<prefix>-ui.css` is the workspace's own writing and is not
 *      the extractor's to rewrite.
 *   2. Extracted components go in their OWN file, `<prefix>-canon.css`, and a class that
 *      already exists in the workspace is a refusal, not a silent redefinition — two
 *      rules for `.x-card` in two files is a bug that only shows up on one screen.
 */

import { ROLES, ROLE_BY_NAME, validateCanon } from "./schema.mjs";

const GROUP_TITLES = {
  paper: ["Paper", "the surfaces, from the desk up"],
  ink: ["Ink", "everything written on the paper"],
  mark: ["The one hot ink", "reserve it for the thing a person is meant to act on"],
  state: ["States", ""],
  type: ["Type", ""],
  space: ["Space", "every gap in the workspace is one of these"],
  shape: ["Shape", ""],
  measure: ["Measure", ""],
  motion: ["Motion", ""],
};

const rule = (title, sub) => {
  const head = `  /* ── ${title} ${"─".repeat(Math.max(3, 66 - title.length))} */`;
  return sub ? `${head}\n  /* ${sub} */` : head;
};

/** The tokens stylesheet: one custom property per role, in schema order. */
export function renderTokensCss({ prefix, tokens, extras = {}, derived = [], source = {} }) {
  const out = [];
  out.push(`/* Design tokens — every colour, size and rhythm this workspace uses, in one file.`);
  out.push(`   Change a value here and every screen that links this stylesheet moves with it.`);
  out.push(``);
  if (source.url) out.push(`   Extracted from ${source.url}${source.collectedAt ? ` on ${String(source.collectedAt).slice(0, 10)}` : ""}.`);
  out.push(`   The names are roles, not descriptions: the same list every workspace fills, so a`);
  out.push(`   prototype written against one design system works against another. Edit the`);
  out.push(`   values freely — it is yours the moment you change it. */`);
  out.push(``);
  out.push(`:root {`);
  let group = null;
  const width = Math.max(...ROLES.map((r) => r.role.length)) + prefix.length + 5;
  for (const r of ROLES) {
    if (r.group !== group) { if (group) out.push(""); out.push(rule(...GROUP_TITLES[r.group])); group = r.group; }
    const name = `  --${prefix}-${r.role}:`;
    const value = String(tokens[r.role]);
    const note = derived.includes(r.role) ? `   /* computed from what was observed */` : `   /* ${r.what} */`;
    out.push(`${name.padEnd(width)} ${value};${value.length + name.length < 96 ? note : ""}`);
  }
  const extraNames = Object.keys(extras);
  if (extraNames.length) {
    out.push("");
    out.push(rule("This product's own", "values the roles above do not have a slot for"));
    for (const n of extraNames) out.push(`  --${prefix}-${n}: ${extras[n]};`);
  }
  out.push(`}`);
  out.push(``);
  return out.join("\n");
}

/** The extracted components, one block each, in the order the canon lists them. */
export function renderCanonCss({ prefix, classPrefix, components, source = {} }) {
  const out = [];
  out.push(`/* Components extracted from the product itself.`);
  if (source.url) out.push(`   Source: ${source.url}${source.collectedAt ? `, ${String(source.collectedAt).slice(0, 10)}` : ""}.`);
  out.push(``);
  out.push(`   Every rule below reads a token and hard-codes nothing, which is what lets one`);
  out.push(`   edit in the tokens file move all of them. Add to this file by hand freely; the`);
  out.push(`   extractor only rewrites it when you run it again. */`);
  out.push(``);
  for (const c of components) {
    out.push(`/* ── ${c.label} — ${c.description} */`);
    out.push(String(c.css).trim());
    out.push(``);
  }
  if (!components.length) out.push(`/* Nothing named yet — the canon was tokens only. */`);
  return out.join("\n");
}

/**
 * Merge the extracted components into a workspace's `registry.json` BY NAME, keeping
 * every entry the workspace already had. The registry is the workspace's, not the
 * extractor's: an entry a person wrote a better description for stays written.
 */
export function mergeRegistry(existing, components) {
  const items = Array.isArray(existing?.items) ? existing.items.slice() : [];
  const at = new Map(items.map((it, i) => [it.name, i]));
  const added = [], updated = [];
  for (const c of components) {
    const entry = { name: c.name, type: c.type, classes: c.classes, label: c.label, description: c.description };
    if (at.has(c.name)) {
      const i = at.get(c.name);
      // Keep the workspace's own words; only fold in classes it does not know about.
      const classes = [...new Set([...(items[i].classes || []), ...c.classes])];
      if (classes.length !== (items[i].classes || []).length) { items[i] = { ...items[i], classes }; updated.push(c.name); }
    } else { items.push(entry); added.push(c.name); }
  }
  return { registry: { ...(existing || {}), items }, added, updated };
}

/** Add the generated files to the skill's declared inventory, and the prefixes to it. */
export function mergeSkillJson(existing, { prefix, classPrefix, files }) {
  const skill = { ...(existing || {}) };
  const assets = new Set(Array.isArray(skill.assets) ? skill.assets : []);
  for (const f of files) assets.add(f);
  skill.assets = [...assets];
  const prefixes = new Set(Array.isArray(skill.cssPrefixes) ? skill.cssPrefixes : []);
  prefixes.add(prefix);
  if (classPrefix) prefixes.add(classPrefix);
  skill.cssPrefixes = [...prefixes];
  return skill;
}

/** The canon's own record: where it came from, what it names, what was computed. */
export function renderCanonMd({ prefix, classPrefix, tokens, derived, components, source, observation }) {
  const out = [];
  out.push(`# The canon`);
  out.push(``);
  out.push(`This workspace's design system, ${source?.url ? `extracted from ${source.url}` : "extracted from the product"}${source?.collectedAt ? ` on ${String(source.collectedAt).slice(0, 10)}` : ""}.`);
  out.push(``);
  out.push(`- Tokens: \`${prefix}-tokens.css\` — ${ROLES.length} roles, all filled.`);
  if (derived?.length) out.push(`- ${derived.length} of them were COMPUTED from the ones observed, not seen in the product: ${derived.join(", ")}. Change any of them by hand if the product does have its own.`);
  out.push(`- Components: \`${prefix}-canon.css\` — ${components.length} named, classed \`.${classPrefix}-*\`.`);
  if (observation) {
    out.push(`- Evidence: ${observation.source?.pages?.length || 1} page(s), ${observation.stats?.elements || 0} elements, ${(observation.colors || []).length} distinct colours seen. Collected ${observation.source?.how === "browser" ? "in the browser, signed in" : "over HTTP"}.`);
  }
  out.push(``);
  out.push(`## Pulling from it`);
  out.push(``);
  out.push(`Reference the skill by its canonical relative path, exactly as every other`);
  out.push(`prototype does — the build rewrites it so the page works on disk and on the site:`);
  out.push(``);
  out.push("```html");
  out.push(`<link rel="stylesheet" href="../../../skills/${prefix}-ui/${prefix}-tokens.css">`);
  out.push(`<link rel="stylesheet" href="../../../skills/${prefix}-ui/${prefix}-canon.css">`);
  out.push("```");
  out.push(``);
  if (components.length) {
    out.push(`## The vocabulary`);
    out.push(``);
    out.push(`| Name | Class | What it is |`);
    out.push(`| --- | --- | --- |`);
    for (const c of components) out.push(`| ${c.name} | \`.${c.classes[0]}\` | ${c.description} |`);
    out.push(``);
  }
  out.push(`## Re-running it`);
  out.push(``);
  out.push(`Collect again, re-map, \`augur canon apply\`. The tokens file is regenerated and`);
  out.push(`the components file is rewritten; nothing else in the skill is touched, so a`);
  out.push(`component you wrote by hand in the workspace's own stylesheet survives.`);
  out.push(``);
  return out.join("\n");
}

/**
 * Everything `augur canon apply` would write, as `{path, text}` — plus the refusals.
 * Pure: the caller does the IO, which is what lets `--dry-run` be the same code path.
 *
 * @param {object} a
 * @param {object} a.canon         the graded answer
 * @param {string} a.skillDir      relative path of the skill directory, e.g. `skills/x-ui`
 * @param {string} a.skillPrefix   the workspace's existing token prefix
 * @param {object} a.existingSkillJson
 * @param {object} a.existingRegistry
 * @param {string} a.existingComponentCss  the workspace's own `<prefix>-ui.css`, for collisions
 * @param {object} [a.observation]
 */
export function planApply({ canon, skillDir, skillPrefix, existingSkillJson, existingRegistry, existingComponentCss = "", observation = null }) {
  const graded = validateCanon(canon);
  const errors = [...graded.errors];
  const notes = [];
  const prefix = skillPrefix || graded.prefix;

  if (skillPrefix && graded.prefix !== skillPrefix) {
    // Renaming a workspace's tokens would orphan every prototype that reads them.
    notes.push(`the canon calls itself "${graded.prefix}" and this workspace's design system is "${skillPrefix}" — emitting as "${skillPrefix}" so the screens that already read these tokens keep working`);
  }

  const components = Array.isArray(canon.components) ? canon.components : [];
  const taken = new Set([...String(existingComponentCss).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  for (const c of components) {
    for (const cl of c.classes || []) {
      if (taken.has(cl)) errors.push(`components (${c.name}): .${cl} is already defined in this workspace's own stylesheet — rename it, or the two rules will fight on one screen`);
    }
  }

  const extras = {};
  for (const [k, v] of Object.entries(canon.tokens || {})) if (k.startsWith("x-") && v) extras[k.slice(2)] = v;

  const files = [`${prefix}-tokens.css`, `${prefix}-canon.css`];
  const { registry, added, updated } = mergeRegistry(existingRegistry, components);
  const writes = [
    { path: `${skillDir}/${prefix}-tokens.css`, text: renderTokensCss({ prefix, tokens: graded.tokens, extras, derived: graded.derived, source: canon.source }) },
    { path: `${skillDir}/${prefix}-canon.css`, text: renderCanonCss({ prefix, classPrefix: graded.classPrefix, components, source: canon.source }) },
    { path: `${skillDir}/skill.json`, text: JSON.stringify(mergeSkillJson(existingSkillJson, { prefix, classPrefix: graded.classPrefix, files }), null, 2) + "\n" },
    { path: `registry.json`, text: JSON.stringify(registry, null, 2) + "\n" },
    { path: `${skillDir}/CANON.md`, text: renderCanonMd({ prefix, classPrefix: graded.classPrefix, tokens: graded.tokens, derived: graded.derived, components, source: canon.source, observation }) },
  ];

  if (added.length) notes.push(`registry: added ${added.join(", ")}`);
  if (updated.length) notes.push(`registry: widened ${updated.join(", ")}`);
  if (graded.derived.length) notes.push(`${graded.derived.length} role(s) computed rather than observed: ${graded.derived.join(", ")}`);

  return { ok: errors.length === 0, errors, warnings: graded.warnings, writes, notes, prefix, graded };
}
