/**
 * canon/observe — turn a real product's pages into EVIDENCE, and stop there.
 *
 * This is the half of extraction a machine can do honestly: count what a product
 * actually uses. Which of the eleven greys is the hairline, and which single colour is
 * the one a person is meant to act on, is judgement — that belongs to the user's own
 * agent, working from this file's output. Nothing here decides anything.
 *
 * TWO DOORS, ONE SHAPE. A public page can be read over plain HTTP, which is what this
 * module does. A product behind a login cannot, and that is the case that matters — the
 * person holding the login is a designer or a PM, not someone with repo access. For them
 * the collector runs INSIDE their own already-signed-in browser
 * (`collect-in-browser.js`) and emits this same object, so everything downstream is
 * identical whichever door was used. The browser door is also the better evidence:
 * computed styles are what the product actually renders, after cascade, media queries
 * and whatever the framework did at runtime.
 *
 * The output is `observation.json`, version 1. Every list is ranked most-used first,
 * and every entry keeps its count so a reader can see how thin the tail is.
 */

export const OBSERVATION_VERSION = 1;

const COLOR_PROPS = new Set([
  "color", "background", "background-color", "border-color", "border-top-color",
  "border-right-color", "border-bottom-color", "border-left-color", "outline-color",
  "fill", "stroke", "caret-color", "text-decoration-color", "accent-color",
]);
const SPACE_PROPS = new Set([
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap", "grid-gap",
]);

/**
 * @param {{url?:string, html?:string, sheets?:Array<{href?:string,text:string}>}} input
 * @returns {object} observation
 */
export function observe({ url = "", html = "", sheets = [], collectedAt = new Date().toISOString() } = {}) {
  const colors = new Tally();
  const fontStacks = new Tally();
  const fontSizes = new Tally();
  const lineHeights = new Tally();
  const fontWeights = new Tally();
  const spacings = new Tally();
  const radii = new Tally();
  const shadows = new Tally();
  const motions = new Tally();
  const vars = new Map();
  let rules = 0, declarations = 0;

  const eat = (prop, value, where) => {
    declarations++;
    const p = prop.toLowerCase();
    const v = value.trim();
    if (!v || v.startsWith("var(")) { if (p.startsWith("--")) vars.set(p, v); return; }
    if (p.startsWith("--")) { vars.set(p, v); return; }
    if (COLOR_PROPS.has(p)) for (const c of colorsIn(v)) colors.add(c, where, p);
    else if (p === "font" || p === "font-family") { const f = familyOf(v); if (f) fontStacks.add(f, where, p); }
    if (p === "font-size" || p === "font") { const s = sizeOf(v); if (s) fontSizes.add(s, where, p); }
    if (p === "line-height") lineHeights.add(v, where, p);
    if (p === "font-weight" && /^\d+$|^(bold|normal|lighter|bolder)$/.test(v)) fontWeights.add(v, where, p);
    if (SPACE_PROPS.has(p)) for (const l of lengthsIn(v)) spacings.add(l, where, p);
    if (p === "border-radius" || p.startsWith("border-") && p.endsWith("-radius")) for (const l of lengthsIn(v)) radii.add(l, where, p);
    if (p === "box-shadow" && v !== "none") shadows.add(v, where, p);
    if (p === "transition" || p === "transition-duration" || p === "animation-duration") motions.add(v, where, p);
  };

  for (const sheet of sheets) {
    for (const rule of cssRules(sheet.text || "")) {
      rules++;
      for (const [prop, value] of declsOf(rule.body)) eat(prop, value, rule.selector);
    }
  }
  // Inline style attributes: a product's most load-bearing colours are often here.
  for (const m of String(html).matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    for (const [prop, value] of declsOf(m[1])) eat(prop, value, "[inline]");
  }

  return {
    observationVersion: OBSERVATION_VERSION,
    source: { url, collectedAt, how: "fetch", pages: url ? [url] : [] },
    stats: { sheets: sheets.length, rules, declarations, elements: 0 },
    colors: colors.ranked(colorEntry),
    fontStacks: fontStacks.ranked(),
    fontSizes: fontSizes.ranked(sizeEntry),
    lineHeights: lineHeights.ranked(),
    fontWeights: fontWeights.ranked(),
    spacings: spacings.ranked(sizeEntry),
    radii: radii.ranked(sizeEntry),
    shadows: shadows.ranked(),
    motions: motions.ranked(),
    customProperties: [...vars.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)),
    classFamilies: classFamilies(html),
  };
}

/* ── Tally ─────────────────────────────────────────────────────────────────── */

class Tally {
  constructor() { this.m = new Map(); }
  add(value, where, prop) {
    let e = this.m.get(value);
    if (!e) this.m.set(value, (e = { value, count: 0, props: new Set(), where: [] }));
    e.count++;
    e.props.add(prop);
    if (e.where.length < 4 && where && !e.where.includes(where)) e.where.push(where.slice(0, 90));
  }
  ranked(decorate) {
    return [...this.m.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, 60)
      .map((e) => {
        const out = { value: e.value, count: e.count, props: [...e.props].slice(0, 6), where: e.where };
        return decorate ? decorate(out) : out;
      });
  }
}

function colorEntry(e) {
  // Deliberately NOT normalised away: the agent should see the product's own spelling.
  return e;
}
function sizeEntry(e) { return e; }

/* ── A tolerant CSS reader ─────────────────────────────────────────────────── */

/**
 * Split a stylesheet into `{selector, body}` rules. Handles nesting (`@media`, `@supports`,
 * `@layer`) by recursing, skips at-rules with no block, and never throws on malformed
 * input — a real product's CSS is minified, vendored and occasionally broken, and a
 * parser that gives up on the first surprise reads nothing at all.
 */
export function cssRules(text) {
  const out = [];
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const parse = (from, to) => {
    let start = from;
    for (let j = from; j < to; j++) {
      const ch = src[j];
      if (ch === "{") {
        let depth = 1, k = j + 1;
        while (k < to && depth) { if (src[k] === "{") depth++; else if (src[k] === "}") depth--; k++; }
        const selector = src.slice(start, j).trim();
        const body = src.slice(j + 1, k - 1);
        if (/^@(media|supports|layer|container|scope|document)/i.test(selector)) parse(j + 1, k - 1);
        else if (/^@(keyframes|font-face|property|page|counter-style)/i.test(selector)) out.push({ selector, body });
        else if (selector) out.push({ selector, body });
        j = k - 1;
        start = k;
      } else if (ch === ";" && start === j) start = j + 1;
    }
  };
  parse(i, src.length);
  return out;
}

/** Split a declaration block into `[prop, value]` pairs, respecting parens and strings. */
export function declsOf(body) {
  const out = [];
  let buf = "", depth = 0, quote = "";
  const flush = () => {
    const s = buf.trim(); buf = "";
    if (!s) return;
    const c = s.indexOf(":");
    if (c < 1) return;
    const prop = s.slice(0, c).trim();
    const value = s.slice(c + 1).trim();
    if (prop && value && !prop.includes("{")) out.push([prop, value]);
  };
  for (const ch of String(body)) {
    if (quote) { buf += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && !depth) { flush(); continue; }
    if (ch === "{" || ch === "}") { buf = ""; depth = 0; continue; }
    buf += ch;
  }
  flush();
  return out;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|\b(?:black|white|red|green|blue|gray|grey|silver|maroon|navy|olive|purple|teal|aqua|fuchsia|lime|yellow|orange)\b/g;
export function colorsIn(value) { return [...String(value).matchAll(COLOR_RE)].map((m) => m[0]); }

const LEN_RE = /(?<![\w.#-])(-?[\d.]+)(px|rem|em|ch|vh|vw|%)/g;
export function lengthsIn(value) {
  return [...String(value).matchAll(LEN_RE)].map((m) => m[1] + m[2]).filter((v) => !v.startsWith("-"));
}
function sizeOf(value) { return lengthsIn(value)[0] || null; }
function familyOf(value) {
  const v = String(value).replace(/^[^a-zA-Z"']*/, "").trim();
  return v && !v.startsWith("var(") ? v.slice(0, 160) : null;
}

/**
 * Class-name families in the markup: the candidate component list. A family is the first
 * one or two hyphen-segments of a class, ranked by how many distinct classes share it —
 * so a design system's own namespace surfaces above one-off utility classes.
 */
export function classFamilies(html) {
  const fams = new Map();
  for (const m of String(html).matchAll(/\sclass\s*=\s*"([^"]*)"/gi)) {
    for (const cl of m[1].split(/\s+/)) {
      if (!/^[a-zA-Z][\w-]{2,}$/.test(cl)) continue;
      const parts = cl.split(/[-_]/);
      if (parts.length < 2) continue;
      const root = parts.slice(0, 2).join("-");
      let e = fams.get(root);
      if (!e) fams.set(root, (e = { root, members: new Set(), uses: 0 }));
      e.members.add(cl);
      e.uses++;
    }
  }
  return [...fams.values()]
    .filter((e) => e.uses > 1)
    .sort((a, b) => b.members.size - a.members.size || b.uses - a.uses)
    .slice(0, 40)
    .map((e) => ({ root: e.root, uses: e.uses, members: [...e.members].slice(0, 10) }));
}

/* ── Merging several pages ─────────────────────────────────────────────────── */

/** Fold observations of several pages into one. One page is never a design system. */
export function mergeObservations(list) {
  const [first, ...rest] = list;
  if (!first) throw new Error("nothing to merge");
  if (!rest.length) return first;
  const out = JSON.parse(JSON.stringify(first));
  const LISTS = ["colors", "fontStacks", "fontSizes", "lineHeights", "fontWeights", "spacings", "radii", "shadows", "motions"];
  for (const o of rest) {
    out.source.pages = [...new Set([...(out.source.pages || []), ...(o.source?.pages || [])])];
    for (const k of ["sheets", "rules", "declarations", "elements"]) out.stats[k] = (out.stats[k] || 0) + (o.stats?.[k] || 0);
    for (const key of LISTS) {
      const by = new Map((out[key] || []).map((e) => [e.value, e]));
      for (const e of o[key] || []) {
        const hit = by.get(e.value);
        if (hit) {
          hit.count += e.count;
          if (e.area != null) hit.area = (hit.area || 0) + e.area;
          hit.props = [...new Set([...(hit.props || []), ...(e.props || [])])].slice(0, 6);
        } else { by.set(e.value, { ...e }); }
      }
      out[key] = [...by.values()].sort((a, b) => (b.area || 0) - (a.area || 0) || b.count - a.count).slice(0, 60);
    }
    const props = new Map((out.customProperties || []).map((p) => [p.name, p]));
    for (const p of o.customProperties || []) if (!props.has(p.name)) props.set(p.name, p);
    out.customProperties = [...props.values()].sort((a, b) => a.name.localeCompare(b.name));
    const fams = new Map((out.classFamilies || []).map((f) => [f.root, f]));
    for (const f of o.classFamilies || []) {
      const hit = fams.get(f.root);
      if (hit) { hit.uses += f.uses; hit.members = [...new Set([...hit.members, ...f.members])].slice(0, 10); }
      else fams.set(f.root, { ...f });
    }
    out.classFamilies = [...fams.values()].sort((a, b) => b.members.length - a.members.length || b.uses - a.uses).slice(0, 40);
  }
  return out;
}
