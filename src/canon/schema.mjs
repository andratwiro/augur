/**
 * canon/schema — the roles a design system has to fill, and the grader for an answer.
 *
 * A workspace's design system is a skill folder (agents/ui-skill.md): a tokens
 * stylesheet, a components stylesheet, a manifest. This module is the part of that
 * shape a MACHINE can check — the list of token ROLES, what each one is for, which
 * ones are observed and which are computed from the observed ones, and the rules a
 * set of components has to obey to be worth shipping.
 *
 * IT IS ONE LIST, DELIBERATELY. The seed workspace's design system fills exactly
 * these roles (`test/canon-schema.test.mjs` proves it against the seed's own token
 * file, and against the token names the seed's design-system page reads live). So a
 * canon extracted from a team's real product and the canon a workspace is born with
 * are the same document with different values — a prototype written against one
 * works against the other, and the page that teaches the system keeps teaching it.
 * Adding a role here without adding it to the seed fails that test, which is what
 * stops the two drifting into two formats.
 *
 * THERE IS NO MODEL IN HERE AND THERE MUST NEVER BE ONE. Deciding that a product's
 * fourth-most-common grey is its hairline colour is judgement, and judgement is the
 * user's own agent's job — this file only says what the slots are and refuses an
 * answer that does not fill them. Everything below is arithmetic: contrast ratios,
 * monotonic scales, and a check that a component's CSS names a token that exists.
 */

export const CANON_VERSION = 1;

/** Roles, in emission order. `derived` roles are computed when the answer omits them. */
export const ROLES = [
  // ── Paper: the surfaces, from the desk up ──────────────────────────────────
  { role: "paper", group: "paper", kind: "color", what: "the desk a sheet lies on — the page background behind everything" },
  { role: "sheet", group: "paper", kind: "color", what: "the sheet itself: cards, panels, the surface text sits on" },
  { role: "inset", group: "paper", kind: "color", what: "a pressed, quieter fill — table stripes, wells, disabled surfaces", derived: "inset" },
  { role: "stage", group: "paper", kind: "color", what: "the dark inset media sits in: video, 3D, a terminal", derived: "stage" },

  // ── Ink: everything written on the paper ───────────────────────────────────
  { role: "ink", group: "ink", kind: "color", what: "every word that matters — body and heading text on the sheet" },
  { role: "ink-2", group: "ink", kind: "color", what: "secondary text: captions, metadata, help", derived: "ink-2" },
  { role: "ink-3", group: "ink", kind: "color", what: "placeholders and disabled text", derived: "ink-3" },
  { role: "rule", group: "ink", kind: "color", what: "hairlines: borders, dividers, table rules" },

  // ── The one hot ink ────────────────────────────────────────────────────────
  { role: "mark", group: "mark", kind: "color", what: "the one colour that marks the thing a person is meant to act on — primary buttons, the current step, a pin" },
  { role: "mark-ink", group: "mark", kind: "color", what: "the mark, darkened until it is readable as TEXT on the sheet", derived: "mark-ink" },
  { role: "wash", group: "mark", kind: "color", what: "the mark's quietest form: highlights, selected rows, chips", derived: "wash" },

  // ── States ─────────────────────────────────────────────────────────────────
  { role: "ok", group: "state", kind: "color", what: "the success/positive colour", derived: "ok" },
  { role: "ok-wash", group: "state", kind: "color", what: "the success colour's quiet fill", derived: "ok-wash" },

  // ── Type ───────────────────────────────────────────────────────────────────
  { role: "font-display", group: "type", kind: "font-stack", what: "the face headings and UI chrome are set in, as a full CSS font stack ending in a generic family" },
  { role: "font-body", group: "type", kind: "font-stack", what: "the face running text is set in, as a full CSS font stack ending in a generic family", derived: "font-body" },
  { role: "text-xs", group: "type", kind: "length", what: "the smallest step: labels, plate numbers", scale: "type" },
  { role: "text-sm", group: "type", kind: "length", what: "captions and chips", scale: "type" },
  { role: "text-md", group: "type", kind: "length", what: "body copy — most of everything", scale: "type" },
  { role: "text-lg", group: "type", kind: "length", what: "lede and step titles", scale: "type" },
  { role: "text-xl", group: "type", kind: "length", what: "section titles", scale: "type" },
  { role: "text-2xl", group: "type", kind: "length", what: "page titles", scale: "type" },
  { role: "text-3xl", group: "type", kind: "length", what: "the one big thing on a page", scale: "type" },

  // ── Space ──────────────────────────────────────────────────────────────────
  { role: "s1", group: "space", kind: "length", what: "the tightest gap on the ramp", scale: "space" },
  { role: "s2", group: "space", kind: "length", what: "space step 2", scale: "space" },
  { role: "s3", group: "space", kind: "length", what: "space step 3", scale: "space" },
  { role: "s4", group: "space", kind: "length", what: "space step 4 — the one most gaps land on", scale: "space" },
  { role: "s5", group: "space", kind: "length", what: "space step 5", scale: "space" },
  { role: "s6", group: "space", kind: "length", what: "space step 6", scale: "space" },
  { role: "s7", group: "space", kind: "length", what: "space step 7", scale: "space" },
  { role: "s8", group: "space", kind: "length", what: "the widest gap on the ramp — separates whole sections", scale: "space" },

  // ── Shape ──────────────────────────────────────────────────────────────────
  { role: "radius-1", group: "shape", kind: "length", what: "the small corner radius: fields, chips, buttons" },
  { role: "radius-2", group: "shape", kind: "length", what: "the large corner radius: cards, panels, sheets", derived: "radius-2" },
  { role: "radius-pill", group: "shape", kind: "length", what: "a fully rounded end — pills and avatars", derived: "radius-pill" },
  { role: "hair", group: "shape", kind: "border", what: "the hairline as a whole border shorthand", derived: "hair" },
  { role: "lift", group: "shape", kind: "shadow", what: "the one elevation in the system, as a box-shadow", derived: "lift" },

  // ── Measure ────────────────────────────────────────────────────────────────
  { role: "sheet-w", group: "measure", kind: "length", what: "how wide the sheet gets before it stops growing", derived: "sheet-w" },
  { role: "rail-w", group: "measure", kind: "length", what: "the margin rail beside a block", derived: "rail-w" },
  { role: "measure", group: "measure", kind: "length", what: "the longest comfortable line of prose, in ch", derived: "measure" },

  // ── Motion ─────────────────────────────────────────────────────────────────
  { role: "fast", group: "motion", kind: "motion", what: "the quick transition: hovers, presses", derived: "fast" },
  { role: "slow", group: "motion", kind: "motion", what: "the considered transition: panels, sheets", derived: "slow" },
];

export const ROLE_NAMES = ROLES.map((r) => r.role);
export const ROLE_BY_NAME = new Map(ROLES.map((r) => [r.role, r]));
/** The roles an answer must actually OBSERVE. Everything else has a computable default. */
export const OBSERVED_ROLES = ROLES.filter((r) => !r.derived).map((r) => r.role);
export const COMPONENT_TYPES = ["primitive", "component", "pattern", "page"];

/* ── Colour arithmetic (no dependencies, no judgement) ─────────────────────── */

const NAMED = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", navy: "#000080",
  olive: "#808000", purple: "#800080", teal: "#008080", aqua: "#00ffff", fuchsia: "#ff00ff",
  lime: "#00ff00", yellow: "#ffff00", orange: "#ffa500",
};

/** A CSS colour → `#rrggbb`, or null when this module cannot resolve it arithmetically. */
export function toHex(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6) return null;
    return "#" + h;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map((n) =>
      n.endsWith("%") ? Math.round(parseFloat(n) * 2.55) : Math.round(parseFloat(n)));
    if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
    return rgbToHex(p);
  }
  m = /^hsla?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3);
    const h = parseFloat(p[0]), s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    if (![h, s, l].every(Number.isFinite)) return null;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = l - c / 2;
    const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(((h % 360) + 360) % 360 / 60)];
    return rgbToHex(seg.map((n) => (n + mm) * 255));
  }
  return null;
}

function rgbToHex(c) {
  return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  const h = toHex(hex) || "#000000";
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
/** Blend `a` toward `b` by `t` (0→a, 1→b). */
export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t));
}
export function luminance(hex) {
  return hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }).reduce((l, v, i) => l + v * [0.2126, 0.7152, 0.0722][i], 0);
}
/** WCAG contrast ratio, 1–21. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Darken (or lighten) `hex` until it clears `ratio` against `on`. Same maths the seed's
 *  design-system page uses when a person picks a new hot ink, so a canon and a live pick
 *  land on the same value. */
export function readableOn(hex, on, ratio = 4.5) {
  const towards = luminance(on) > 0.5 ? "#000000" : "#ffffff";
  let out = mix(hex, towards, 0.18);
  for (let t = 0.18; t <= 0.95 && contrast(out, on) < ratio; t += 0.04) out = mix(hex, towards, t);
  return out;
}

/* ── Lengths ───────────────────────────────────────────────────────────────── */

const ROOT_PX = 16;
/** A CSS length → px, for ordering a scale. `ch`/`%`/`vw` return null (not comparable). */
export function toPx(value) {
  if (typeof value !== "string") return null;
  const m = /^(-?[\d.]+)\s*(px|rem|em|pt)?$/.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case undefined: return n === 0 ? 0 : null;
    case "px": return n;
    case "rem": case "em": return n * ROOT_PX;
    case "pt": return n * (96 / 72);
    default: return null;
  }
}

/* ── Deriving the roles an answer may leave out ────────────────────────────── */

/**
 * Fill every `derived` role the answer omitted, from the ones it did give.
 * Pure arithmetic on the observed values — a canon that supplies only the roles it
 * actually saw in the product still emits a complete, legible system.
 * Returns `{ tokens, derived }`; `derived` names what this function supplied.
 */
export function deriveTokens(given) {
  const t = { ...given };
  const derived = [];
  const need = (role, fn) => {
    if (t[role] == null || t[role] === "") { const v = fn(); if (v != null) { t[role] = v; derived.push(role); } }
  };
  const sheet = toHex(t.sheet) || "#ffffff";
  const ink = toHex(t.ink) || "#000000";
  const paperDark = luminance(sheet) < 0.5;

  need("inset", () => mix(sheet, ink, 0.05));
  need("stage", () => (paperDark ? mix(sheet, "#000000", 0.4) : mix(ink, "#000000", 0.15)));
  need("ink-2", () => readableOn(mix(ink, sheet, 0.35), sheet, 4.5));
  need("ink-3", () => readableOn(mix(ink, sheet, 0.55), sheet, 3));
  need("mark-ink", () => (t.mark ? readableOn(toHex(t.mark) || ink, sheet, 4.5) : null));
  need("wash", () => (t.mark ? mix(toHex(t.mark) || ink, sheet, 0.86) : null));
  need("ok", () => readableOn("#2e7d51", sheet, 4.5));
  need("ok-wash", () => mix(toHex(t.ok) || "#2e7d51", sheet, 0.86));
  need("font-body", () => t["font-display"] || null);
  need("radius-2", () => scaleLength(t["radius-1"], 2.2));
  need("radius-pill", () => "999px");
  need("hair", () => (t.rule ? `1px solid ${t.rule}` : null));
  need("lift", () => {
    const rgb = hexToRgb(ink).join(", ");
    return `0 1px 2px rgba(${rgb}, .05), 0 14px 34px rgba(${rgb}, .07)`;
  });
  need("sheet-w", () => "62rem");
  need("rail-w", () => "5rem");
  need("measure", () => "66ch");
  need("fast", () => "120ms ease");
  need("slow", () => "320ms cubic-bezier(.2, .7, .3, 1)");
  return { tokens: t, derived };
}

function scaleLength(value, factor) {
  if (typeof value !== "string") return null;
  const m = /^(-?[\d.]+)\s*([a-z%]*)$/.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]) * factor;
  return `${Math.round(n * 100) / 100}${m[2] || ""}`;
}

/* ── Grading an answer ─────────────────────────────────────────────────────── */

const IDENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Colour keywords a component stylesheet may name without owning a token for it. */
const COLOR_KEYWORDS = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "none", "revert"]);
const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|color|lab|lch|oklab|oklch)\s*\(/;

/**
 * Grade a canon. Returns `{ ok, errors, warnings, tokens, derived, prefix }`.
 * Errors are things that would ship a broken or illegible design system; warnings are
 * things a person should look at. `strict` promotes warnings to errors.
 */
export function validateCanon(canon, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => (strict ? errors : warnings).push(m);

  if (!canon || typeof canon !== "object") return { ok: false, errors: ["canon is not an object"], warnings, tokens: {}, derived: [], prefix: "" };

  const prefix = String(canon.prefix || "").trim();
  if (!IDENT.test(prefix)) err(`prefix: "${canon.prefix}" is not a css-safe name (lowercase, digits, single hyphens)`);
  // Tokens and classes may use different prefixes — `skill.json` `cssPrefixes` is a list
  // for exactly that reason, and a workspace whose tokens are `--acme-` and whose classes
  // are `.a-` is not doing anything wrong. Default them to the same word.
  const classPrefix = String(canon.classPrefix || canon.prefix || "").trim();
  if (!IDENT.test(classPrefix)) err(`classPrefix: "${canon.classPrefix}" is not a css-safe name`);

  const given = canon.tokens && typeof canon.tokens === "object" ? canon.tokens : {};
  // A skeleton ships every role as null; naming them is the whole job, so say which.
  const missing = OBSERVED_ROLES.filter((r) => given[r] == null || given[r] === "");
  if (missing.length) err(`tokens: ${missing.length} observed role${missing.length > 1 ? "s" : ""} still unanswered — ${missing.join(", ")}`);

  const unknown = Object.keys(given).filter((k) => !ROLE_BY_NAME.has(k) && !k.startsWith("x-"));
  if (unknown.length) err(`tokens: ${unknown.join(", ")} — not a role. A value the product has and the roles do not name goes under an "x-" name (x-brand-blue), which emits as an extra token.`);

  const { tokens, derived } = deriveTokens(given);

  for (const r of ROLES) {
    const v = tokens[r.role];
    if (v == null || v === "") { if (!missing.includes(r.role)) err(`tokens.${r.role}: empty`); continue; }
    if (typeof v !== "string") { err(`tokens.${r.role}: must be a string`); continue; }
    if (r.kind === "color" && !toHex(v)) err(`tokens.${r.role}: "${v}" is not a colour this can read (hex, rgb(), hsl(), or a basic keyword)`);
    if (r.kind === "length" && toPx(v) == null && !/^[\d.]+\s*(ch|ex|vw|vh|vmin|vmax|%)$/.test(v.trim())) err(`tokens.${r.role}: "${v}" is not a length`);
    if (r.kind === "font-stack" && !/,|\b(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-monospace|ui-sans-serif|ui-serif)\b/.test(v)) warn(`tokens.${r.role}: "${v}" has no fallback — a font stack should end in a generic family so a screen still renders when the face does not load`);
  }

  // Scales must climb. A type ramp that is not ordered is not a ramp, and every page
  // that uses it inherits the disorder.
  for (const scale of ["type", "space"]) {
    const steps = ROLES.filter((r) => r.scale === scale);
    let prev = null, prevName = "";
    for (const s of steps) {
      const px = toPx(tokens[s.role]);
      if (px == null) continue;
      if (prev != null && px <= prev) err(`tokens.${s.role}: ${tokens[s.role]} is not larger than ${prevName} (${tokens[prevName]}) — the ${scale} scale has to climb`);
      prev = px; prevName = s.role;
    }
  }

  // Legibility. These are the two ratios that decide whether the extracted system is
  // usable at all, so they are errors, not notes.
  const sheet = toHex(tokens.sheet), ink = toHex(tokens.ink);
  if (sheet && ink) {
    const c = contrast(ink, sheet);
    if (c < 4.5) err(`contrast: ink on sheet is ${c.toFixed(2)}:1 — under 4.5:1 body text is not readable`);
  }
  if (sheet && toHex(tokens["mark-ink"])) {
    const c = contrast(toHex(tokens["mark-ink"]), sheet);
    if (c < 4.5) err(`contrast: mark-ink on sheet is ${c.toFixed(2)}:1 — leave mark-ink out and it is computed from mark to clear 4.5:1`);
  }
  if (sheet && toHex(tokens["ink-2"]) && contrast(toHex(tokens["ink-2"]), sheet) < 4.5)
    warn(`contrast: ink-2 on sheet is ${contrast(toHex(tokens["ink-2"]), sheet).toFixed(2)}:1 — secondary text under 4.5:1`);
  if (sheet && toHex(tokens.mark) && contrast(toHex(tokens.mark), sheet) < 1.6)
    warn(`contrast: mark barely separates from sheet (${contrast(toHex(tokens.mark), sheet).toFixed(2)}:1) — the hot ink has to be visible as a fill`);
  if (toHex(tokens.mark) && toHex(tokens.ink) && contrast(toHex(tokens.mark), toHex(tokens.ink)) < 1.35)
    warn(`mark and ink are nearly the same colour — nothing on a screen will read as "act on this"`);

  // Components.
  const comps = Array.isArray(canon.components) ? canon.components : [];
  const seen = new Set();
  const known = new Set([...ROLE_NAMES.map((r) => `--${prefix}-${r}`),
    ...Object.keys(given).filter((k) => k.startsWith("x-")).map((k) => `--${prefix}-${k.slice(2)}`)]);
  for (const [i, c] of comps.entries()) {
    const at = `components[${i}]${c && c.name ? ` (${c.name})` : ""}`;
    if (!c || typeof c !== "object") { err(`${at}: not an object`); continue; }
    if (!IDENT.test(String(c.name || ""))) { err(`${at}: name must be a css-safe word`); continue; }
    if (seen.has(c.name)) err(`${at}: two components named ${c.name}`);
    seen.add(c.name);
    if (!COMPONENT_TYPES.includes(c.type)) err(`${at}: type must be one of ${COMPONENT_TYPES.join(", ")}`);
    if (!c.label || !c.description) err(`${at}: needs a label and a one-line description — the overlay and the gallery print them`);
    const classes = Array.isArray(c.classes) ? c.classes : [];
    if (!classes.length) err(`${at}: no classes`);
    for (const cl of classes) if (!String(cl).startsWith(`${classPrefix}-`)) err(`${at}: class "${cl}" does not start with "${classPrefix}-" — the overlay finds a family by its prefix`);
    const css = typeof c.css === "string" ? c.css : "";
    if (!css.trim()) { err(`${at}: no css`); continue; }
    for (const cl of classes) if (!css.includes(`.${cl}`)) err(`${at}: css never defines .${cl}`);
    const lit = LITERAL_COLOR.exec(stripVarFallbacks(css));
    if (lit) err(`${at}: css hard-codes a colour (${lit[0]}) — a component drinks from tokens, or the whole system stops moving when a token changes. Add an x- token and use var(--${prefix}-…).`);
    for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!known.has(m[1])) err(`${at}: css reads ${m[1]}, which this canon does not define`);
    }
    for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      if (!m[1].startsWith(`${classPrefix}-`) && !classes.includes(m[1])) warn(`${at}: css styles .${m[1]}, outside its own family`);
    }
  }
  if (!comps.length) warn("components: none — the canon is tokens only. A prototype can wear it, but nothing is named yet.");

  const src = canon.source && typeof canon.source === "object" ? canon.source : {};
  if (!src.url) warn("source.url: not recorded — a canon should say what it was taken from");

  return { ok: errors.length === 0, errors, warnings, tokens, derived, prefix, classPrefix, componentCount: comps.length };
}

/** `rgba(…)` inside a var() fallback is the one honest place a literal colour appears. */
function stripVarFallbacks(css) {
  return css.replace(/var\(\s*--[a-zA-Z0-9-]+\s*,[^)]*\)/g, "var(--x)");
}

/* ── Reading a token stylesheet back ───────────────────────────────────────── */

/**
 * Parse a `<prefix>-tokens.css` into `{prefix, tokens, extras}`.
 * Used by `augur canon check --space` (grade the design system a workspace is actually
 * carrying) and by the test that holds the seed to this schema.
 */
export function parseTokensCss(text, prefixHint = "") {
  const decls = [...String(text).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g)]
    .map((m) => [m[1], m[2].trim()]);
  let prefix = prefixHint;
  if (!prefix) {
    // The prefix is the first hyphen-segment shared by the most declarations.
    const tally = new Map();
    for (const [name] of decls) {
      const head = name.split("-")[0];
      if (head) tally.set(head, (tally.get(head) || 0) + 1);
    }
    prefix = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }
  const tokens = {}, extras = {};
  for (const [name, value] of decls) {
    if (prefix && !name.startsWith(`${prefix}-`)) continue;
    const role = prefix ? name.slice(prefix.length + 1) : name;
    if (ROLE_BY_NAME.has(role)) tokens[role] = value;
    else extras[role] = value;
  }
  return { prefix, tokens, extras };
}

/** The skeleton `augur canon start` writes: every observed role, unanswered. */
export function blankCanon({ url = "", prefix = "canon", classPrefix = "" } = {}) {
  const tokens = {};
  for (const r of OBSERVED_ROLES) tokens[r] = null;
  return {
    canonVersion: CANON_VERSION,
    prefix,
    classPrefix: classPrefix || prefix,
    source: { url, collectedAt: null, how: "" },
    tokens,
    components: [],
    notes: "",
  };
}
