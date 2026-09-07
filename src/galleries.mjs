// galleries.mjs — the pages a workspace DERIVES, rendered at serve time from the live store.
//
// docs/drafts-that-land.md §6.4. The gallery, each opportunity's index, the playground, the
// library tiers and the search index used to be baked by a client's build and shipped with a
// publish, so a landing could not appear on them until somebody published a tree. Here they
// are a pure function of what the store holds: the live manifest (units, files, per-file
// provenance), the status overlay, the roster (ids → faces) and the design-system catalog.
// The worker calls this where drafts are served; the markup keeps the card contract the
// chrome bundle's scripts read (class names and data-* attributes), so pins, renames, status
// clicks, currency, faces and the finder keep working on a derived page exactly as they did
// on a baked one.
//
// ⚠️ NO NODE IMPORTS, NO I/O. The worker runs this per request.
import { renderAppChrome, renderSpaceContextScript, CHROME_MARK_START, CHROME_MARK_END, UI_VERSION, escAttr, titleCase, fmtDate, relTime } from "./chrome/appchrome.mjs";
import { authoredUnits } from "./publish-units.mjs";
import { unitProvenance, unitKey, isGeneratedAsset, STATUS_LABELS } from "./currency.mjs";

export const TIERS = Object.freeze(["base", "components", "patterns", "pages"]);
const TIER_TITLE = Object.freeze({ base: "Base", components: "Components", patterns: "Patterns", pages: "Pages" });

const STATUS_META = Object.freeze({
  "in-progress": { label: STATUS_LABELS["in-progress"], cls: "is-wip" },
  "dev-ready": { label: STATUS_LABELS["dev-ready"], cls: "is-ready" },
  ignore: { label: STATUS_LABELS.ignore, cls: "is-ignore" },
});
const STATUS_ICONS = Object.freeze({
  "dev-ready": '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#17935a"/><path d="M5.8 10.4l2.7 2.7 5.7-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  "in-progress": '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="#1c1c22" stroke-width="2.2"/><path d="M10 2.8a7.2 7.2 0 0 1 0 14.4z" fill="#1c1c22"/></svg>',
  ignore: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="#aeb3bd" stroke-width="2.2"/><line x1="6.4" y1="10" x2="13.6" y2="10" stroke="#aeb3bd" stroke-width="2.2" stroke-linecap="round"/></svg>',
});
const STATUS_RANK = Object.freeze({ "dev-ready": 0, "in-progress": 1, ignore: 2 });
const IC_STAR = `<svg class="pin-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
// Spelled out rather than built with `ic()`: the module-scope lint reads a call initializer
// as state it cannot prove pure, and a literal costs nothing.
const IC_PLUS = `<svg class="gvic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
const EMOJI_POOL = Object.freeze(["🗳️", "🏛️", "📊", "🧭", "🛰️", "🧩", "🪧", "🌳", "🚲", "📣", "🗺️", "🧪", "💡", "🔭", "🪟", "🧱", "🎛️", "🛣️", "🧰", "📐", "🧮", "🗂️", "🔔", "🏘️", "🌍", "💬", "📝", "🚏", "🏙️", "🌿", "🎚️", "🧷"]);

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };
const enc = (s) => encodeURIComponent(s);
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith("y") ? word.slice(0, -1) + "ies" : word + "s"}`;
function protoEmoji(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return EMOJI_POOL[h % EMOJI_POOL.length];
}
const protoName = (slug) => `${protoEmoji(slug)} ${titleCase(slug)}`;

// ── the site model ───────────────────────────────────────────────────────────
/**
 * Is this unit a member's own welcome page — made for one person by the platform?
 *
 * ONE predicate, keyed on the `kind` the landing stamps into `routing.unitSources`
 * (`onboardingMeApi`, src/_worker.js). A path test would be the obvious alternative and is
 * wrong: `/start-here/` is an ordinary folder name a person may publish into, and hiding
 * somebody's own prototypes because of where they put them is the worse failure.
 */
export const isWelcomeUnit = (source) =>
  !!source && typeof source === "object" && source.kind === "welcome";

/** Which list a unit belongs to, from its path alone. */
export function unitHome(unit) {
  const segs = dec(unit).split("/").filter(Boolean);
  if (segs.length !== 2) return null;
  if (segs[0] === "playground") return { kind: "playground", name: segs[1] };
  if (TIERS.includes(segs[0])) return { kind: "tier", tier: segs[0], name: segs[1] };
  if (segs[0].startsWith("_") || segs[0] === "skills") return null;
  return { kind: "opportunity", opp: segs[0], name: segs[1] };
}

function unitEntry(manifest, unit, home, { statuses, baseline, people, now }) {
  const files = manifest.files || {};
  const prefix = dec(unit);
  const inUnit = Object.keys(files).filter((p) => dec(p).startsWith(prefix));
  const rel = (p) => dec(p).slice(prefix.length);
  const hasIndex = inUnit.some((p) => rel(p) === "index.html");
  const firstHtml = inUnit.map(rel).filter((r) => !r.includes("/") && r.endsWith(".html")).sort()[0] || null;
  const file = hasIndex ? `${unit}index.html` : firstHtml ? `${unit}${enc(firstHtml)}` : null;
  const { editedAt, by } = unitProvenance(manifest, unit);
  const key = unitKey(unit);
  const status = (statuses && Object.prototype.hasOwnProperty.call(statuses, key) && statuses[key])
    || (baseline && baseline[key]) || null;
  // A poster is shot by a tool and stamped with whoever landed it; it is a picture of the
  // work, not work — the same rule the date follows (unitProvenance).
  const ids = [...new Set(inUnit.filter((p) => !isGeneratedAsset(p)).map((p) => files[p] && files[p].by).filter(Boolean))];
  // One face per PERSON: `people` answers a person's canonical id, so two stamps under two
  // of their addresses (a work and a personal git identity) fold into one chip.
  const seen = new Map();
  for (const id of ids) { const u = people(id); if (u && !seen.has(u.id)) seen.set(u.id, u); }
  const editors = [...seen.values()];
  return {
    name: home.name, unit, href: unit, file,
    poster: inUnit.some((p) => rel(p) === "preview.webp"),
    editedAt: editedAt || null,
    mtimeMs: editedAt ? Date.parse(editedAt) : 0,
    status, editors, by,
  };
}

const byRecency = (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
const byStatusThenRecency = (a, b) => {
  const ra = a.status in STATUS_RANK ? STATUS_RANK[a.status] : 2;
  const rb = b.status in STATUS_RANK ? STATUS_RANK[b.status] : 2;
  return ra - rb || byRecency(a, b);
};

/**
 * Everything the derived pages need, from the live manifest and the overlays.
 * `people(id) → {id, name, initials, color} | null` resolves a recorded author id.
 */
export function siteModel({ manifest, statuses = {}, baseline = {}, people = () => null, now = Date.now() }) {
  const opps = new Map(), playground = [], tiers = { base: [], components: [], patterns: [], pages: [] };
  const units = [];
  const sources = (manifest && manifest.routing && manifest.routing.unitSources) || {};
  for (const unit of authoredUnits(manifest || {})) {
    const home = unitHome(unit);
    if (!home) continue;
    // A member's own welcome page is one unit PER PERSON, landed by the platform and named
    // by an opaque member id. A team of twenty accumulates twenty hash-named cards under
    // one folder nobody chose, on the first page the workspace shows. It stays SERVED —
    // the welcome flow's preview and the person's own link both fetch it by URL — and it
    // simply is not listed. Read from the manifest's own stamp, so the rule cannot drift
    // from what wrote the unit; anything else the platform seeds still lists, because
    // `seedSource()` is what a furnished workspace's starter content also carries.
    if (isWelcomeUnit(sources[unit])) continue;
    const e = unitEntry(manifest, unit, home, { statuses, baseline, people, now });
    units.push({ ...e, home });
    if (home.kind === "playground") { playground.push({ ...e, status: e.status || "in-progress" }); continue; }
    if (home.kind === "tier") { tiers[home.tier].push(e); continue; }
    if (!opps.has(home.opp)) opps.set(home.opp, { name: home.opp, prototypes: [] });
    opps.get(home.opp).prototypes.push(e);
  }
  const opportunities = [...opps.values()].map((o) => {
    o.prototypes.sort(byStatusThenRecency);
    const seen = new Map();
    for (const p of o.prototypes) for (const u of p.editors) if (!seen.has(u.id)) seen.set(u.id, u);
    return { ...o, people: [...seen.values()], mtimeMs: Math.max(0, ...o.prototypes.map((p) => p.mtimeMs)) };
  }).sort(byRecency);
  playground.sort(byStatusThenRecency);
  for (const t of TIERS) tiers[t].sort(byRecency);
  return { opportunities, playground, tiers, hasPlayground: playground.length > 0, units };
}

/** What a request path names on the derived surface, or null for anything else. */
export function derivedPathKind(pathname, model) {
  const p = dec(pathname);
  if (p === "/" || p === "/index.html") return { kind: "root" };
  if (p === "/__search.json") return { kind: "search" };
  const m = /^\/([^/]+)\/?(index\.html)?$/.exec(p);
  if (!m) return null;
  const seg = m[1];
  if (seg === "playground") return model.hasPlayground || p.endsWith("/") ? { kind: "playground" } : null;
  if (TIERS.includes(seg)) return { kind: seg === "components" ? "components" : "tier", tier: seg };
  if (model.opportunities.some((o) => o.name === seg)) return { kind: "opportunity", name: seg, slash: p.endsWith("/") || p.endsWith("index.html") };
  return null;
}

// ── markup ───────────────────────────────────────────────────────────────────
const media = (href, hasPoster) => hasPoster
  ? `<img class="preview-img" src="${href}preview.webp" alt="" aria-hidden="true" loading="lazy" decoding="async" width="768" height="480" />`
  : `<div class="preview-ph" aria-hidden="true"></div>`;
const preview = (href, hasPoster) => `<div class="preview${hasPoster ? "" : " preview--ph"}">${media(href, hasPoster)}</div>`;
const filterEmpty = () => `<p class="filter-empty" data-filter-empty hidden>No matches.</p>`;
const pinStar = (key, href) => `<button type="button" class="pin-btn" data-pin-key="${key}" data-pin-href="${href}" aria-pressed="false" aria-label="Pin to sidebar" title="Pin to sidebar">${IC_STAR}</button>`;
const newCanvasBtn = (dir) => `<button type="button" class="folderbar__new" data-new-canvas="${dir}" hidden>${IC_PLUS}New canvas</button>`;
const emptyState = (...paras) => paras.map((p) => `<p class="empty">${p}</p>`).join("");
const emptyHead = (title, keepOnMobile = false) =>
  `<header class="folderbar${keepOnMobile ? " folderbar--keep" : ""}"><h1 class="folderbar__title">${title}</h1><span class="folderbar__count">0</span><span class="folderbar__rule"></span></header>`;
const ghostLine = (w) => `<span class="ghost-line" style="width:${w}"></span>`;
const ghosts = (inner) => `<div class="ghosts" aria-hidden="true">${inner}</div>`;
const ghostFolderGrid = (n = 6) => ghosts(`<div class="opp-grid">${Array.from({ length: n }, () => `<div class="card-opp"><div class="preview preview--pending"></div><div class="proto-meta"><div class="proto-text">${ghostLine("58%")}${ghostLine("30%")}</div></div></div>`).join("")}</div>`);
const ghostCardGrid = (n = 8) => ghosts(`<div class="page-grid">${Array.from({ length: n }, () => `<div class="card-proto is-pending"><div class="preview preview--pending"></div><div class="proto-meta">${ghostLine("56%")}</div></div>`).join("")}</div>`);
const ghostCompTable = (n = 4) => ghosts(`<table class="comp-table"><thead><tr><th>Preview</th><th>Component</th><th>What it is</th><th class="comp-status">Status</th></tr></thead><tbody>${Array.from({ length: n }, () => `<tr><td><span class="ghost-thumb"></span></td><td><div class="comp-name">${ghostLine("110px")}</div><div class="comp-badges"><span class="ghost-chip" style="width:54px"></span><span class="ghost-chip" style="width:40px"></span></div></td><td><div class="comp-desc">${ghostLine("100%")}${ghostLine("62%")}</div></td><td class="comp-status"><span class="ghost-dot"></span></td></tr>`).join("")}</tbody></table>`);

function faceChip(u, cls) {
  const ini = escAttr((u.initials || (u.name || "?").slice(0, 2)).toUpperCase());
  const label = escAttr(u.name || "Someone");
  return `<span class="${cls}" style="background-color:${u.color || "#4f46e5"}" data-person="${escAttr(u.id)}" title="${label}" aria-label="${label}">${ini}</span>`;
}
function facePile(people, cap = 5) {
  if (!people || !people.length) return "";
  const shown = people.slice(0, cap), extra = people.length - shown.length;
  const chips = shown.map((u) => faceChip(u, "proto-editor opp-face")).join("");
  const more = extra > 0 ? `<span class="proto-editor opp-face opp-face--more" title="+${extra} more">+${extra}</span>` : "";
  return `<span class="opp-people" role="group" aria-label="Contributors">${chips}${more}</span>`;
}
function currencyLine(key, p, now) {
  const cur = STATUS_META[p.status] ? p.status : "ignore";
  const word = cur === "ignore" ? "" : `<span class="proto-state ${STATUS_META[cur].cls}">${STATUS_META[cur].label}</span> &middot; `;
  const when = p.mtimeMs ? `<span class="proto-when" title="${fmtDate(p.mtimeMs)}">${relTime(p.mtimeMs, now)}</span>` : `<span class="proto-when"></span>`;
  return `<div class="proto-date" data-currency="${escAttr(key)}">${word}${when}</div>`;
}
function statusChip(status, key) {
  const cur = STATUS_META[status] ? status : "ignore";
  const aria = `Status: ${STATUS_META[cur].label}. Click to change.`;
  return `<button type="button" class="status-chip ${STATUS_META[cur].cls}" data-status-key="${key}" data-status="${cur}" aria-label="${aria}" title="${aria}">${STATUS_ICONS[cur]}</button>`;
}
const compStatusChip = (name) => {
  const aria = "Validation: In progress. Click to mark reviewed.";
  return `<button type="button" class="status-chip is-wip" data-comp-status-key="components/${name}" data-status="in-progress" aria-label="${aria}" title="${aria}">${STATUS_ICONS["in-progress"]}</button>`;
};
function metaBadges(meta) {
  const layer = meta.layer ? `<span class="cbadge cbadge--layer-${escAttr(meta.layer)}">${escAttr(meta.layer)}</span>` : "";
  const surf = meta.surface ? `<span class="cbadge cbadge--surf">${escAttr(meta.surface)}</span>` : "";
  const cat = meta.category ? `<span class="cbadge cbadge--cat">${escAttr(meta.category)}</span>` : "";
  const stat = meta.status ? `<span class="cbadge cbadge--st-${escAttr(meta.status)}">${escAttr(meta.status)}</span>` : "";
  return `<div class="comp-badges">${layer}${surf}${cat}${stat}</div>`;
}

/** The page skeleton the build used to emit, with the CURRENT chrome. */
export function shell({ title, body, activeTab = "prototypes", wrapClass = "", ctx }) {
  const state = { spaces: ctx.spaces || [], activeSpace: ctx.activeSpace || "", opportunities: [], hasPlayground: !!ctx.hasPlayground };
  const css = ctx.chrome && ctx.chrome.css ? `/${ctx.chrome.css}` : "";
  const js = ctx.chrome && ctx.chrome.js ? `/${ctx.chrome.js}` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escAttr(title)}</title>
  <link rel="icon" type="image/png" href="/augur-mark.png?v=${UI_VERSION}" />
  <link rel="apple-touch-icon" href="/augur-mark.png?v=${UI_VERSION}" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#2C2150" />
  <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
${js ? `  <link rel="preload" href="${js}" as="script" />\n` : ""}${css ? `  <link rel="stylesheet" href="${css}" />\n` : ""}</head>
<body>
  ${CHROME_MARK_START(state.activeSpace, activeTab, state.hasPlayground)}${renderAppChrome(activeTab, state, {})}${CHROME_MARK_END}
  <div class="wrap${wrapClass ? " " + wrapClass : ""}">
    ${body}
  </div>
  <script>${renderSpaceContextScript(state)}
  </script>
${js ? `  <script defer src="${js}"></script>\n` : ""}  <script type="speculationrules">${JSON.stringify({ prefetch: [{ where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/__*" } }] }, eagerness: "moderate" }] })}</script>
</body>
</html>
`;
}

const folderbar = (title, count, extra = "") => `<header class="folderbar"><h1 class="folderbar__title">${title}</h1><span class="folderbar__count">${count}</span><span class="folderbar__rule"></span>${extra}</header>`;

export function renderRootIndex(model, ctx) {
  const label = ctx.projectsLabel || "Projects";
  if (!model.opportunities.length) {
    return shell({ title: "Augur", wrapClass: "wrap--wide", ctx: { ...ctx, hasPlayground: model.hasPlayground },
      body: emptyHead(label) + ghostFolderGrid() + emptyState("Ask your agent for a clickable prototype and it shows up here, ready to send.") });
  }
  const cards = model.opportunities.map((opp) => {
    const oppPath = `${enc(opp.name)}/`;
    // The cover is the first prototype in order that HAS a poster. A unit landed from a
    // machine without the shooting tools carries none, and it sorts first (newest) — it
    // must not blank a folder whose other prototypes were all shot.
    const cover = opp.prototypes.find((p) => p.poster) || opp.prototypes[0];
    const coverSrc = cover ? cover.href : "";
    return `
        <div class="card-opp" data-fitem data-fkey="${titleCase(opp.name)}">
          <a class="card-cover-link" href="${oppPath}" aria-label="Open ${titleCase(opp.name)}"></a>
          ${preview(coverSrc, cover && cover.poster)}
          <div class="opp-meta">
            <div class="opp-name-row"><div class="proto-name">${titleCase(opp.name)}</div>${facePile(opp.people)}</div>
            <div class="proto-date">${plural(opp.prototypes.length, "prototype")} &middot; <span class="proto-when" data-currency-folder="${escAttr(opp.name)}" title="${opp.mtimeMs ? fmtDate(opp.mtimeMs) : ""}">${opp.mtimeMs ? relTime(opp.mtimeMs, ctx.now) : ""}</span></div>
          </div>
        </div>`;
  }).join("");
  return shell({ title: "Augur", wrapClass: "wrap--wide", ctx: { ...ctx, hasPlayground: model.hasPlayground },
    body: `${folderbar(label, model.opportunities.length)}<div data-fgroup><div class="opp-grid">${cards}</div></div>${filterEmpty()}` });
}

export function renderOpportunityIndex(model, oppName, ctx) {
  const opp = model.opportunities.find((o) => o.name === oppName);
  if (!opp) return null;
  const label = (ctx.projectsLabel || "Projects").toLowerCase();
  const cards = opp.prototypes.map((p) => {
    const download = p.file ? `<button type="button" data-dl="${p.file}" data-dlname="${enc(p.name)}.html" aria-label="Download HTML" hidden></button>` : "";
    const pinKey = `/${enc(opp.name)}/${enc(p.name)}/`;
    const dname = protoName(p.name);
    const key = `${opp.name}/${p.name}`;
    return `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${key}" data-default-name="${dname}" data-del-space="${escAttr(ctx.activeSpace || "")}" data-del-path="${opp.name}/prototypes/${p.name}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
            <div class="preview-actions">
              ${download}
              ${pinStar(pinKey, pinKey)}
            </div>
            ${statusChip(p.status, key)}
          </div>
          <div class="proto-meta">
            <div class="proto-text">
              <div class="proto-name">${dname}</div>
              ${currencyLine(key, p, ctx.now)}
            </div>
            ${facePile(p.editors)}
          </div>
        </div>`;
  }).join("");
  const up = `<a class="folderbar__up" href="/" aria-label="All ${label}" title="All ${label}"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`;
  return shell({ title: titleCase(opp.name), activeTab: opp.name, wrapClass: "wrap--wide", ctx: { ...ctx, hasPlayground: model.hasPlayground },
    body: `<header class="folderbar">${up}<h1 class="folderbar__title">${titleCase(opp.name)}</h1><span class="folderbar__count">${opp.prototypes.length}</span><span class="folderbar__rule"></span>${newCanvasBtn(`/${opp.name}/`)}</header><div data-fgroup><div class="page-grid is-3up">${cards}</div></div>${filterEmpty()}` });
}

export function renderPlaygroundIndex(model, ctx) {
  const c = { ...ctx, hasPlayground: model.hasPlayground };
  if (!model.playground.length) {
    return shell({ title: "Playground", activeTab: "playground", wrapClass: "wrap--wide", ctx: c,
      body: emptyHead("Playground") + ghostFolderGrid() + emptyState("Ask your agent for something quick that doesn't need a project.") });
  }
  const cards = model.playground.map((p) => {
    const folder = `${enc(p.name)}/`;
    const pinKey = `/playground/${enc(p.name)}/`;
    const dname = protoName(p.name);
    const key = `playground/${p.name}`;
    return `
        <div class="card-opp" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${key}" data-default-name="${dname}" data-del-space="${escAttr(ctx.activeSpace || "")}" data-del-path="playground/${p.name}">
          <a class="card-cover-link" href="${folder}" aria-label="Open ${titleCase(p.name)}"></a>
          <div class="preview">
            ${media(p.href, p.poster)}
            ${statusChip(p.status, key)}
          </div>
          <div class="preview-actions">${pinStar(pinKey, pinKey)}</div>
          <div class="proto-meta">
            <div class="proto-text">
              <div class="proto-name">${dname}</div>
              ${currencyLine(key, p, ctx.now)}
            </div>
            ${facePile(p.editors)}
          </div>
        </div>`;
  }).join("");
  return shell({ title: "Playground", activeTab: "playground", wrapClass: "wrap--wide", ctx: c,
    body: `${folderbar("Playground", model.playground.length, newCanvasBtn("/playground/"))}<div data-fgroup><div class="opp-grid">${cards}</div></div>${filterEmpty()}` });
}

const TIER_COPY = Object.freeze({
  base: { addHint: 'The atoms every screen here borrows: buttons, inputs, cards, badges, modal, icons. Components and Patterns are built out of these, and all of them wear <a href="/tokens/">Tokens</a>.', empty: "Ask your agent for your buttons, inputs and cards, one page each." },
  patterns: { addHint: "Layouts that keep coming back: several Components arranged the way real screens arrange them again and again.", empty: 'Build a few <a href="/pages/">Pages</a> first, then ask your agent to pull out what repeats.' },
  pages: { addHint: "", empty: "Ask your agent to build a whole screen out of your design system." },
});

export function renderTierIndex(model, tier, ctx) {
  if (!TIER_COPY[tier]) return null;
  const items = model.tiers[tier] || [];
  const title = TIER_TITLE[tier];
  const c = { ...ctx, hasPlayground: model.hasPlayground };
  if (!items.length) {
    return shell({ title, activeTab: tier, wrapClass: "wrap--wide", ctx: c, body: emptyHead(title, true) + ghostCardGrid() + emptyState(TIER_COPY[tier].empty) });
  }
  const card = (p) => `
        <div class="card-proto" data-fitem data-fkey="${titleCase(p.name)}" data-rename-key="${tier}/${p.name}" data-default-name="${titleCase(p.name)}">
          <div class="preview">
            ${media(p.href, p.poster)}
            <a class="preview-link" href="${p.href}" aria-label="Open ${titleCase(p.name)}"></a>
          </div>
          <div class="proto-meta">
            <div class="proto-name">${titleCase(p.name)}</div>
          </div>
        </div>`;
  const hint = TIER_COPY[tier].addHint ? `<p class="tier-hint">${TIER_COPY[tier].addHint}</p>` : "";
  return shell({ title, activeTab: tier, wrapClass: "wrap--wide", ctx: c,
    body: `${folderbar(title, items.length)}${hint}<div class="page-grid">${items.map(card).join("")}</div>${filterEmpty()}` });
}

/** The catalog a components table reads: registry.json → {slug → {name, classes, desc, meta}}. */
export function catalogFrom(registry) {
  const out = {};
  for (const it of (registry && registry.items) || []) {
    if (!it || !it.name || it.type === "page") continue;
    const fams = it.classes || (it.class ? [it.class] : []);
    out[it.name] = {
      name: it.label || titleCase(it.name),
      classes: (it.cssClasses || fams).map((f) => "." + f).join(" / "),
      desc: it.description || "",
      meta: it.meta || null,
    };
  }
  return out;
}

export function renderComponentsIndex(model, catalog, ctx) {
  const items = model.tiers.components || [];
  const c = { ...ctx, hasPlayground: model.hasPlayground };
  if (!items.length) {
    return shell({ title: "Components", activeTab: "components", wrapClass: "wrap--wide", ctx: c,
      body: emptyHead("Components", true) + ghostCompTable() + emptyState("Ask your agent for a component you keep rebuilding, like a search field.") });
  }
  const rows = items.map((it) => {
    const blurb = (catalog && catalog[it.name]) || { name: "", classes: "", desc: "", meta: null };
    const dname = blurb.name || titleCase(it.name);
    const classes = blurb.classes ? `<code>${escAttr(blurb.classes)}</code>` : "";
    const badges = blurb.meta ? metaBadges(blurb.meta) : "";
    const tags = blurb.meta && blurb.meta.tags && blurb.meta.tags.length ? `<div class="comp-tags">${blurb.meta.tags.map((t) => `<span>#${escAttr(t)}</span>`).join("")}</div>` : "";
    const metaKey = blurb.meta ? [blurb.meta.surface, blurb.meta.category, blurb.meta.status, ...(blurb.meta.tags || [])].filter(Boolean).join(" ") : "";
    const fkey = `${dname} ${blurb.classes} ${blurb.desc} ${metaKey}`.replace(/<[^>]+>/g, " ").replace(/"/g, "");
    return `
        <tr data-fitem data-fkey="${escAttr(fkey)}" data-rename-key="components/${it.name}" data-default-name="${escAttr(dname)}">
          <td>
            <a class="comp-thumb" href="${it.href}" aria-label="Open ${escAttr(dname)}">
              ${media(it.href, it.poster)}
            </a>
          </td>
          <td><div class="comp-name"><span class="proto-name">${escAttr(dname)}</span>${classes}</div>${badges}${tags}</td>
          <td><div class="comp-desc" data-desc-key="components/${it.name}#desc">${escAttr(blurb.desc)}</div></td>
          <td class="comp-status">${compStatusChip(it.name)}</td>
        </tr>`;
  }).join("");
  return shell({ title: "Components", activeTab: "components", wrapClass: "wrap--wide", ctx: c,
    body: `${folderbar("Components", items.length)}<table class="comp-table">
      <thead><tr><th>Preview</th><th>Component</th><th>What it is</th><th class="comp-status">Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${filterEmpty()}` });
}

/** The rail's finder index — every navigable thing, the shape the chrome bundle reads. */
export function searchIndex(model, ctx) {
  const idx = [{ t: ctx.projectsLabel || "Projects", y: "Index", u: "/" }];
  if (model.hasPlayground) idx.push({ t: "Playground", y: "Index", u: "/playground/" });
  for (const t of ["pages", "components", "base", "patterns"]) if (model.tiers[t].length) idx.push({ t: TIER_TITLE[t], y: "Index", u: `/${t}/` });
  const thumb = (p) => (p.poster ? { th: `${p.href}preview.webp` } : {});
  for (const opp of model.opportunities) {
    const cover = opp.prototypes[0];
    idx.push({ t: titleCase(opp.name), y: "Folder", u: `/${enc(opp.name)}/`, ...(cover ? thumb(cover) : {}) });
    for (const p of opp.prototypes) idx.push({ t: titleCase(p.name), y: "Prototype", g: titleCase(opp.name), u: p.href, k: `${opp.name}/${p.name}`, ...thumb(p) });
  }
  for (const p of model.playground) idx.push({ t: titleCase(p.name), y: "Playground", u: p.href, k: `playground/${p.name}`, ...thumb(p) });
  for (const p of model.tiers.pages) idx.push({ t: titleCase(p.name), y: "Page", u: p.href, k: `pages/${p.name}`, ...thumb(p) });
  for (const p of model.tiers.components) idx.push({ t: titleCase(p.name), y: "Component", u: p.href, k: `components/${p.name}`, ...thumb(p) });
  return idx;
}
