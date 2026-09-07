// test/galleries.test.mjs — the derived pages: a site model from a live manifest, and card
// markup that keeps the contract the chrome bundle's scripts read.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  siteModel, unitHome, derivedPathKind, renderRootIndex, renderOpportunityIndex, renderPlaygroundIndex,
  renderTierIndex, renderComponentsIndex, searchIndex, catalogFrom, shell, TIERS, isWelcomeUnit,
} from "../src/galleries.mjs";
import { seedSource } from "../src/provenance.mjs";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const f = (h, extra = {}) => ({ h: h.repeat(64).slice(0, 64), ct: "text/html", s: 10, ...extra });
const manifest = {
  version: 9,
  files: {
    "/checkout/flow/index.html": f("a", { by: "p1", editedAt: "2026-09-05T10:00:00.000Z" }),
    "/checkout/flow/preview.webp": f("b", { ct: "image/webp" }),
    "/checkout/flow/css/a.css": f("c", { by: "p2", editedAt: "2026-09-01T10:00:00.000Z" }),
    "/checkout/old/index.html": f("d", { by: "p2", editedAt: "2026-06-01T10:00:00.000Z" }),
    "/onboarding/welcome/welcome.html": f("e"),
    "/playground/scratch/index.html": f("g", { by: "p1", editedAt: "2026-09-06T09:00:00.000Z" }),
    "/base/button/index.html": f("h"),
    "/components/card/index.html": f("i", { editedAt: "2026-08-01T00:00:00.000Z" }),
    "/index.html": f("z"),
  },
  routing: { publicPrefixes: ["/checkout/flow/", "/checkout/old/", "/onboarding/welcome/", "/playground/scratch/", "/base/button/", "/components/card/"] },
};
const people = (id) => ({ p1: { id: "p1", name: "Ada", initials: "AD", color: "#111111" }, p2: { id: "p2", name: "Ben", initials: "BE", color: "#222222" } }[id] || null);
const ctx = { spaces: [{ id: "alpha", default: true, name: "Alpha", base: "" }], activeSpace: "alpha", chrome: { css: "_chrome.1.16.abcdef01.css", js: "_chrome.1.16.abcdef01.js" }, projectsLabel: "Projects", now: NOW };

test("unitHome sorts a unit into its list from its path alone", () => {
  assert.deepEqual(unitHome("/checkout/flow/"), { kind: "opportunity", opp: "checkout", name: "flow" });
  assert.deepEqual(unitHome("/playground/scratch/"), { kind: "playground", name: "scratch" });
  assert.deepEqual(unitHome("/components/card/"), { kind: "tier", tier: "components", name: "card" });
  assert.equal(unitHome("/skills/starter-ui/"), null, "the design system is a unit but not a card");
  assert.equal(unitHome("/checkout/"), null);
  assert.equal(unitHome("/a/b/c/"), null);
  assert.deepEqual(TIERS, ["base", "components", "patterns", "pages"]);
});

test("the site model groups units, orders by status then recency, and resolves faces from the stamps", () => {
  const m = siteModel({ manifest, statuses: { "checkout/old": "dev-ready" }, baseline: { "checkout/flow": "in-progress" }, people, now: NOW });
  assert.deepEqual(m.opportunities.map((o) => o.name), ["checkout", "onboarding"], "most recently edited folder first");
  const checkout = m.opportunities[0];
  assert.deepEqual(checkout.prototypes.map((p) => p.name), ["old", "flow"], "dev-ready sorts before in-progress");
  const flow = checkout.prototypes[1];
  assert.equal(flow.href, "/checkout/flow/");
  assert.equal(flow.file, "/checkout/flow/index.html");
  assert.equal(flow.poster, true);
  assert.equal(flow.editedAt, "2026-09-05T10:00:00.000Z", "the newest stamp in the folder");
  assert.equal(flow.status, "in-progress", "the baseline stands where the overlay says nothing");
  assert.deepEqual(flow.editors.map((u) => u.id).sort(), ["p1", "p2"]);
  assert.equal(checkout.prototypes[0].status, "dev-ready", "the overlay wins");
  assert.deepEqual(checkout.people.map((u) => u.id).sort(), ["p1", "p2"]);
  const welcome = m.opportunities[1].prototypes[0];
  assert.equal(welcome.file, "/onboarding/welcome/welcome.html", "no index: the first html file");
  assert.equal(welcome.status, null);
  assert.equal(welcome.editedAt, null, "unstamped stays unstamped");
  assert.equal(m.hasPlayground, true);
  assert.equal(m.playground[0].status, "in-progress", "a playground project is presumed active");
  assert.deepEqual(m.tiers.base.map((p) => p.name), ["button"]);
  assert.deepEqual(m.tiers.components.map((p) => p.name), ["card"]);
  assert.deepEqual(m.tiers.pages, []);
});

test("the folder card's cover is the first prototype in order that HAS a poster, not the first prototype", () => {
  // A unit landed from a machine without the shooting tools has no poster. It sorts first
  // (newest), and it must not blank a folder whose other prototypes were all shot.
  const m2 = {
    version: 9,
    files: {
      "/checkout/newest/index.html": f("a", { by: "p1", editedAt: "2026-09-06T10:00:00.000Z" }),
      "/checkout/shot/index.html": f("b", { by: "p1", editedAt: "2026-09-01T10:00:00.000Z" }),
      "/checkout/shot/preview.webp": f("c", { ct: "image/webp" }),
      "/checkout/older/index.html": f("d", { by: "p1", editedAt: "2026-08-01T10:00:00.000Z" }),
      "/checkout/older/preview.webp": f("e", { ct: "image/webp" }),
      "/bare/one/index.html": f("g", { by: "p1", editedAt: "2026-09-05T10:00:00.000Z" }),
      "/index.html": f("z"),
    },
    routing: { publicPrefixes: ["/checkout/newest/", "/checkout/shot/", "/checkout/older/", "/bare/one/"] },
  };
  const m = siteModel({ manifest: m2, people, now: NOW });
  assert.deepEqual(m.opportunities[0].prototypes.map((p) => p.name), ["newest", "shot", "older"], "order is untouched");
  const html = renderRootIndex(m, ctx);
  assert.match(html, /src="\/checkout\/shot\/preview\.webp"/, "the newest prototype WITH a poster is the cover");
  assert.doesNotMatch(html, /\/checkout\/newest\/preview\.webp/);
  // A folder with no poster anywhere still renders the placeholder, never a broken image.
  assert.match(html, /data-fkey="Bare">[\s\S]*?<div class="preview preview--ph">/, "no poster at all → placeholder tile");
  assert.doesNotMatch(html, /\/bare\/one\/preview\.webp/);
});

test("derivedPathKind names the derived surfaces and nothing else", () => {
  const m = siteModel({ manifest, people, now: NOW });
  assert.deepEqual(derivedPathKind("/", m), { kind: "root" });
  assert.deepEqual(derivedPathKind("/index.html", m), { kind: "root" });
  assert.deepEqual(derivedPathKind("/checkout/", m), { kind: "opportunity", name: "checkout", slash: true });
  assert.deepEqual(derivedPathKind("/checkout", m), { kind: "opportunity", name: "checkout", slash: false });
  assert.deepEqual(derivedPathKind("/playground/", m), { kind: "playground" });
  assert.deepEqual(derivedPathKind("/base/", m), { kind: "tier", tier: "base" });
  assert.deepEqual(derivedPathKind("/components/", m), { kind: "components", tier: "components" });
  assert.deepEqual(derivedPathKind("/__search.json", m), { kind: "search" });
  assert.equal(derivedPathKind("/checkout/flow/", m), null, "a unit is served from its table");
  assert.equal(derivedPathKind("/nowhere/", m), null);
  assert.equal(derivedPathKind("/tokens/", m), null, "tokens stay whatever the store holds");
  assert.equal(derivedPathKind("/checkout/flow/index.html", m), null);
});

test("the root page: one folder card per opportunity, with the cover, the faces and the count", () => {
  const m = siteModel({ manifest, people, now: NOW });
  const html = renderRootIndex(m, ctx);
  assert.match(html, /<!--gv-chrome-start data-space="alpha" data-active="prototypes" data-playground="1"/);
  assert.match(html, /<link rel="stylesheet" href="\/_chrome\.1\.16\.abcdef01\.css" \/>/);
  assert.match(html, /<script defer src="\/_chrome\.1\.16\.abcdef01\.js"><\/script>/);
  assert.equal((html.match(/class="card-opp"/g) || []).length, 2);
  assert.match(html, /<span class="folderbar__count">2<\/span>/);
  assert.match(html, /href="checkout\/"/);
  assert.match(html, /src="\/checkout\/flow\/preview\.webp"/, "the cover is the newest prototype's poster");
  assert.match(html, /data-person="p1"/);
  assert.match(html, /2 prototypes/);
  assert.match(html, /data-currency-folder="checkout"/);
  assert.match(html, /window\.__GV_SPACE=/);
  const empty = renderRootIndex(siteModel({ manifest: { files: {}, routing: { publicPrefixes: [] } } }), ctx);
  assert.match(empty, /class="ghosts"/);
  assert.match(empty, /Ask your agent for a clickable prototype/);
});

test("an opportunity page: prototype cards carry every hook the chrome scripts read", () => {
  const m = siteModel({ manifest, statuses: { "checkout/flow": "dev-ready" }, people, now: NOW });
  const html = renderOpportunityIndex(m, "checkout", ctx);
  assert.equal((html.match(/class="card-proto"/g) || []).length, 2);
  for (const must of [
    'data-rename-key="checkout/flow"', 'data-del-path="checkout/prototypes/flow"', 'data-del-space="alpha"',
    'data-status-key="checkout/flow"', 'data-status="dev-ready"', 'data-currency="checkout/flow"',
    'data-pin-key="/checkout/flow/"', 'href="/checkout/flow/"', 'data-dl="/checkout/flow/index.html"',
    'data-new-canvas="/checkout/"', 'data-filter-empty', "Dev ready</span> &middot;", 'data-person="p2"',
    '<!--gv-chrome-start data-space="alpha" data-active="checkout"',
  ]) assert.ok(html.includes(must), must);
  assert.equal(renderOpportunityIndex(m, "nowhere", ctx), null);
});

test("the playground, the tiers and the components table", () => {
  const m = siteModel({ manifest, people, now: NOW });
  const pg = renderPlaygroundIndex(m, ctx);
  assert.match(pg, /data-rename-key="playground\/scratch"/);
  assert.match(pg, /data-status="in-progress"/);
  assert.match(pg, /data-new-canvas="\/playground\/"/);
  const base = renderTierIndex(m, "base", ctx);
  assert.match(base, /data-rename-key="base\/button"/);
  assert.match(base, /class="tier-hint"/);
  assert.match(base, /data-active="base"/);
  const pages = renderTierIndex(m, "pages", ctx);
  assert.match(pages, /class="ghosts"/, "no pages: the ghost grid");
  assert.equal(renderTierIndex(m, "tokens", ctx), null);
  const catalog = catalogFrom({ items: [{ name: "card", type: "component", classes: ["s-card"], label: "Card", description: "A panel.", meta: { category: "layout", status: "canonical", tags: ["x"] } }, { name: "home", type: "page" }] });
  assert.deepEqual(Object.keys(catalog), ["card"]);
  const comps = renderComponentsIndex(m, catalog, ctx);
  assert.match(comps, /<span class="proto-name">Card<\/span><code>\.s-card<\/code>/);
  assert.match(comps, /cbadge--cat">layout</);
  assert.match(comps, /#x</);
  assert.match(comps, /data-comp-status-key="components\/card"/);
  assert.match(comps, /data-desc-key="components\/card#desc">A panel\./);
  const none = renderComponentsIndex(siteModel({ manifest: { files: {}, routing: { publicPrefixes: [] } } }), {}, ctx);
  assert.match(none, /comp-table/);
  assert.match(none, /search field/);
});

test("the search index lists every navigable thing in the shape the finder reads", () => {
  const m = siteModel({ manifest, people, now: NOW });
  const idx = searchIndex(m, ctx);
  assert.deepEqual(idx[0], { t: "Projects", y: "Index", u: "/" });
  assert.ok(idx.some((e) => e.y === "Folder" && e.u === "/checkout/" && e.th === "/checkout/flow/preview.webp"));
  assert.ok(idx.some((e) => e.y === "Prototype" && e.k === "checkout/flow" && e.g === "Checkout" && e.th));
  assert.ok(idx.some((e) => e.y === "Playground" && e.k === "playground/scratch"));
  assert.ok(idx.some((e) => e.y === "Component" && e.k === "components/card"));
  assert.ok(idx.some((e) => e.y === "Index" && e.u === "/base/"));
  assert.ok(!idx.some((e) => e.u === "/pages/"), "an empty tier is not an index entry");
});

test("the shell renders without a chrome pointer too", () => {
  const html = shell({ title: "T", body: "<p>x</p>", ctx: { spaces: [], activeSpace: "" } });
  assert.doesNotMatch(html, /_chrome\./);
  assert.match(html, /<p>x<\/p>/);
});

// ── the member's own welcome page is served, never listed ──────────────────────────────
//
// `onboardingMeApi` lands one unit PER MEMBER, under a folder named by an opaque member
// id. Listed, a team of twenty puts twenty hash-named cards on the first page the
// workspace shows — so the derived surface skips them, on the `kind` the landing stamps
// into `routing.unitSources` and not on the path (a person may publish into `/start-here/`
// like any other folder, and hiding their work would be the worse failure).
const withWelcome = {
  version: 12,
  files: {
    "/checkout/flow/index.html": f("a", { by: "p1", editedAt: "2026-09-05T10:00:00.000Z" }),
    "/start-here/k3f9x2/index.html": f("w", { editedAt: "2026-09-06T11:00:00.000Z" }),
  },
  routing: {
    publicPrefixes: ["/checkout/flow/", "/start-here/k3f9x2/"],
    unitSources: {
      "/start-here/k3f9x2/": seedSource({ kind: "welcome", sha: null, dirty: false }),
    },
  },
};

test("isWelcomeUnit reads the stamp and nothing else", () => {
  assert.equal(isWelcomeUnit(seedSource({ kind: "welcome" })), true);
  assert.equal(isWelcomeUnit(seedSource({ sha: null, dirty: false })), false, "the seed pack's own content still lists");
  assert.equal(isWelcomeUnit({ sha: "abc", dirty: false }), false);
  assert.equal(isWelcomeUnit(undefined), false);
  assert.equal(isWelcomeUnit(null), false);
});

test("a welcome-kind unit is not listed anywhere derived, and an ordinary unit still is", () => {
  const m = siteModel({ manifest: withWelcome, people, now: NOW });
  assert.deepEqual(m.opportunities.map((o) => o.name), ["checkout"], "no `start-here` folder appears");
  assert.deepEqual(m.units.map((u) => u.unit), ["/checkout/flow/"]);
  const html = renderRootIndex(m, ctx);
  assert.ok(html.includes("checkout"), "the ordinary opportunity is still on the page");
  assert.ok(!html.includes("start-here"), "the member's page is not");
  assert.ok(!html.includes("k3f9x2"), "and neither is their id");
  assert.ok(!searchIndex(m, ctx).some((e) => String(e.href || "").includes("start-here")), "nor in the finder");

  // Same manifest, same unit, WITHOUT the stamp: it lists like anything else — so the
  // assertions above are about the stamp and not about the path.
  const plain = { ...withWelcome, routing: { ...withWelcome.routing, unitSources: {} } };
  const m2 = siteModel({ manifest: plain, people, now: NOW });
  assert.deepEqual(m2.opportunities.map((o) => o.name).sort(), ["checkout", "start-here"]);
});

test("two stamps under two of one person's addresses are ONE face on the card", () => {
  // `people` answers the person's canonical id for an alias id, the way the worker does.
  const fold = (id) => (id === "p1b" ? { id: "p1", name: "Ada", initials: "AD", color: "#111111" } : people(id));
  const m = {
    version: 1,
    files: {
      "/checkout/flow/index.html": f("a", { by: "p1", editedAt: "2026-09-05T10:00:00.000Z" }),
      "/checkout/flow/notes.md": f("b", { by: "p1b", editedAt: "2026-09-04T10:00:00.000Z" }),
      "/checkout/flow/css/a.css": f("c", { by: "p2", editedAt: "2026-09-01T10:00:00.000Z" }),
    },
    routing: { publicPrefixes: ["/checkout/flow/"] },
  };
  const model = siteModel({ manifest: m, people: fold, now: NOW });
  const flow = model.opportunities[0].prototypes[0];
  assert.deepEqual(flow.editors.map((e) => e.name), ["Ada", "Ben"]);
  assert.deepEqual(model.opportunities[0].people.map((e) => e.id), ["p1", "p2"]);
});
