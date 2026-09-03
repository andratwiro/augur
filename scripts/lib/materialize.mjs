// Live URL → source path. The reverse of what build.js does one way.
//
// `C-clone-pull-materializer`. A published manifest is a map of URLs to content hashes.
// Turning it back into an editable tree means undoing build.js's mapping, and that mapping
// is LOSSY in one specific place: `/<folder>/<name>/` is a prototype whose source lives at
// `<folder>/prototypes/<name>/`, while `/base/<name>/` is a gallery tier whose source is
// the URL verbatim. Nothing in the path itself distinguishes them.
//
// SO IT DOES NOT GUESS. The manifest carries `routing.publicPrefixes`, which is exactly
// the list of prototype folders — the same list the unpublish guard is built on. A URL
// under one of those is a prototype; a URL under a tier name is a tier; everything else is
// either verbatim or generated. Reading the answer out of the manifest is what makes this
// correct rather than a heuristic that works until somebody names a project "base".
//
// WHAT IS GENERATED AND MUST NOT BE WRITTEN. A publish ships build OUTPUT as well as
// source: the landing page, each project's index, each tier's index, the whole /tokens/
// page and the search index. Writing those into a source tree would produce a tree that
// rebuilds into something different from what it came from — a clone that cannot be
// published back. They are skipped, and `skipped` reports what and why, because a silent
// omission in a tool whose whole promise is "leaving is free" is the wrong kind of quiet.

/** Gallery tiers: authored folders whose URL is their source path. */
export const TIERS = Object.freeze(["base", "components", "pages", "patterns"]);

/**
 * Files at the root of a space that are real source.
 *
 * `registry.json` is the overlay catalog — the design system's contract, which the build
 * REQUIRES beside a skill and refuses to build without — and `prototype-status.json` is
 * the dev-status baseline every project index is rendered from. Both ship with the publish
 * for exactly this reason (`C-clone-publish-roundtrip`): a clone that came back without them
 * was a tree that could not be published again — the build said so only after the clone had
 * said everything was fine — or one that rebuilt into a different site. The rule is the
 * build's own: what it READS to reproduce a space travels; what it WRITES is skipped here.
 */
const ROOT_SOURCE = new Set(["space-icon.png", "space-icon.svg", "registry.json", "prototype-status.json"]);

/** Generated pages a publish carries that no source tree contains. */
const GENERATED_EXACT = new Set(["/index.html", "/__search.json"]);

/**
 * Decide what one published URL is.
 * Returns { kind: "source", path } | { kind: "generated", why }.
 *
 * `prefixes` is the manifest's routing.publicPrefixes.
 */
export function classify(url, prefixes = []) {
  if (!url || url[0] !== "/") return { kind: "generated", why: "not a rooted URL" };
  if (GENERATED_EXACT.has(url)) return { kind: "generated", why: "the built landing page or search index" };

  const rel = url.slice(1);
  const parts = rel.split("/");

  // Root-level source files.
  if (parts.length === 1) {
    return ROOT_SOURCE.has(parts[0])
      ? { kind: "source", path: parts[0] }
      : { kind: "generated", why: "a built file at the site root" };
  }

  // The design system's own assets ship verbatim under their declared prefix — with one
  // exception build.js writes INTO the skill folder rather than beside it: graph.js, the
  // composition graph parsed from the very stylesheets sitting next to it. It lives there
  // because it is space content rather than shared chrome, and it is derived, so a clone
  // that wrote it back would put build output into a source tree.
  if (parts[0] === "skills") {
    if (parts[parts.length - 1] === "graph.js") {
      return { kind: "generated", why: "the composition graph, parsed from the stylesheets beside it" };
    }
    return { kind: "source", path: rel };
  }

  // The tokens page is generated FROM the stylesheet; the stylesheet itself lives under
  // skills/ and is caught above.
  if (parts[0] === "tokens") return { kind: "generated", why: "the tokens page is derived from the stylesheet" };

  // A tier: /base/<name>/… is source at the same path. /base/index.html is the tier index,
  // which build.js writes.
  if (TIERS.includes(parts[0])) {
    if (parts.length === 2 && parts[1] === "index.html") return { kind: "generated", why: `the ${parts[0]} tier index` };
    return { kind: "source", path: rel };
  }

  // Playground ships verbatim; its folder index is generated.
  if (parts[0] === "playground") {
    if (parts.length === 2 && parts[1] === "index.html") return { kind: "generated", why: "the playground index" };
    return { kind: "source", path: rel };
  }

  // Anything else is a project folder. A file directly inside it is that project's
  // generated index; a file inside a NAMED sub-folder is a prototype — but only if the
  // manifest says so, which is the whole point of consulting publicPrefixes.
  if (parts.length === 2) return { kind: "generated", why: `the ${parts[0]} project index` };
  const prefix = `/${parts[0]}/${parts[1]}/`;
  if (prefixes.includes(prefix)) {
    return { kind: "source", path: [parts[0], "prototypes", ...parts.slice(1)].join("/") };
  }
  return { kind: "generated", why: `not a published prototype (${prefix} is not in publicPrefixes)` };
}

/**
 * Classify a whole manifest. Returns { files: [{url, path, h, s}], skipped: [{url, why}] }.
 * Deterministic order, so two runs produce the same plan and a diff of the plan is readable.
 */
export function materializePlan(manifest) {
  const prefixes = (manifest && manifest.routing && manifest.routing.publicPrefixes) || [];
  const files = [], skipped = [];
  for (const [url, meta] of Object.entries((manifest && manifest.files) || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const c = classify(url, prefixes);
    if (c.kind === "source") files.push({ url, path: c.path, h: meta && meta.h, s: (meta && meta.s) || 0 });
    else skipped.push({ url, why: c.why });
  }
  return { files, skipped };
}

/**
 * A space.json for a cloned tree. space.json is not a served asset and is in no manifest
 * as a file, so it has to be synthesized — and it is deliberately minimal: anything
 * INFERRED rather than known would be a guess written into the file that decides how the
 * space builds.
 *
 * What the manifest does KNOW is carried (`C-clone-publish-roundtrip`): the build records
 * the space's own record on every manifest (`manifest.space` — name, badge, description,
 * projects label, help sections), and each of those is baked into the generated pages, so
 * a tree without them rebuilds into a site with a different name on it. They are copied
 * only when the record actually carries them; an empty value is the build's default, not
 * a fact about the space. `siteOrigin` is always the origin this clone was taken from —
 * the address the workspace answers at now — never one recorded before a move.
 */
export function synthesizeSpaceJson(id, origin, space = null) {
  const out = { id, default: true, siteOrigin: origin };
  const s = space && typeof space === "object" ? space : {};
  for (const k of ["name", "badge", "description", "projectsLabel"]) {
    if (typeof s[k] === "string" && s[k].trim()) out[k] = s[k];
  }
  if (Array.isArray(s.help) && s.help.length) out.help = s.help;
  return out;
}
