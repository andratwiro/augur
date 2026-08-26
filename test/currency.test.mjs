// What is current here, and what has been left behind.
//
// `F-currency-default`. Divergence is cheap in a workspace — a second version of a screen
// costs a folder — so the shelf fills with abandoned paths fast, and a repository where the
// live thing and the dead thing look identical has stopped being a repository. It fails
// quietly: nothing breaks, nothing 404s, the gallery just slowly stops meaning anything.
//
// The acceptance test this file is written against is three sentences, and each is a
// section below:
//
//   1. a visitor can tell current from abandoned WITHOUT OPENING ANYTHING;
//   2. an agent can answer "what changed here in the last two weeks" from ONE CALL;
//   3. NOTHING NEW has to be maintained for staleness to show.
//
// The third is the one worth having a guard for, because it is the one a future change
// breaks by accident. The obvious "improvement" here is an `archived` flag on a unit, and
// it is the bug wearing the fix's clothes: the person who abandons a prototype is by
// definition not coming back to tick a box, so the flag would be accurate only for the
// units that were never the problem. `test/manifest-provenance.test.mjs` guards the stamp
// this derives from; this guards that nothing was added beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STALE_AFTER_DAYS, STATUS_LABELS, currencyRows, freshness, whenWords,
  parseSince, unitKey, unitProvenance, isGeneratedAsset,
} from "../src/currency.mjs";
import { relTime, spanWords } from "../src/chrome/appchrome.mjs";
import { __testables as W } from "../src/_worker.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAY = 86400000;
// A STATED clock, so every sentence below is exact rather than "about right today". The
// pure functions all take `now`, which is the whole reason they can be asserted at all.
const NOW = Date.parse("2026-06-01T00:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();
// The ROUTE reads the wall clock — it is answering a live question — so its fixtures are
// dated from the same clock, a moment before it looks.
const agoLive = (days) => new Date(Date.now() - days * DAY).toISOString();

// ── 1. the decision itself: derived from a stamp and a clock, and nothing else ────────

test("staleness is DERIVED — the same record answers differently as the clock moves", () => {
  // The whole of the feature's memory is one ISO string the publish handler already wrote.
  // Nothing here is stored, so nothing here can go stale in the other sense: unmaintained.
  const editedAt = ago(STALE_AFTER_DAYS + 1);
  assert.equal(freshness(editedAt, NOW).stale, true);
  // The very same value, read one threshold earlier: fresh. No write happened in between.
  assert.equal(freshness(editedAt, NOW - (STALE_AFTER_DAYS + 1) * DAY + DAY).stale, false);
});

test("the threshold is a full planning quarter, and it is ONE number", () => {
  // A judgement, so it is pinned: the failure directions are not symmetrical. A false
  // stale mark accuses live work and costs the signal its credibility the first time
  // somebody sees it on the thing they shipped yesterday; a late one costs a few weeks of
  // an ordinary-looking card. So it sits above any ordinary working rhythm — a holiday, a
  // re-org, a quarter spent elsewhere — not at the earliest defensible point.
  assert.equal(STALE_AFTER_DAYS, 90);
  assert.equal(freshness(ago(89), NOW).stale, false, "89 days is inside a quarter");
  assert.equal(freshness(ago(90), NOW).stale, true, "the threshold is inclusive");
});

test("⚠️ ABSENT IS AN ANSWER, AND IT IS NOT FRESH", () => {
  // A file published before the stamp existed carries no editedAt. Defaulting the unknown
  // to either end invents the exact fact the stamp exists to stop being invented:
  // false-stale accuses somebody's live work, false-fresh is the junk drawer with a clean
  // bill of health. So `stale` is THREE-valued and the treatment simply does not turn on.
  assert.deepEqual(freshness(null, NOW), { ageDays: null, stale: null });
  assert.deepEqual(freshness("not a date", NOW), { ageDays: null, stale: null });
  assert.equal(whenWords(null, NOW), null, "an unknown unit gets no sentence to replace the baked one");
});

test("an abandoned unit gets the FINDING, not the same sentence in a colour", () => {
  // "Edited 7 months ago" asks the reader to do the arithmetic and know the threshold, and
  // most will do neither. "Untouched for 7 months" is the finding, stated.
  const old = ago(220);
  assert.equal(whenWords(old, NOW), "Untouched for 7 months");
  assert.equal(whenWords(ago(3), NOW), "Edited 3 days ago");
});

test("ONE COUNTER — the two sentences a card can carry cannot disagree about the number", () => {
  // A second unit table is how one card ends up saying two different ages of the same file.
  for (const days of [1, 3, 29, 45, 89, 90, 200, 400]) {
    const t = NOW - days * DAY;
    const span = spanWords(t, NOW);
    const line = whenWords(new Date(t).toISOString(), NOW);
    assert.ok(line.includes(span), `"${line}" does not carry the counter's own "${span}"`);
    if (!freshness(new Date(t).toISOString(), NOW).stale) assert.equal(line, relTime(t, NOW));
  }
});

test("a poster reshoot is not an edit", () => {
  // A poster is a build output committed back into the folder, and one reshoot touches
  // every folder at once — counting it moved 76 cards to "edited now" in a single commit.
  // build.js imports THIS test rather than keeping its own, so the git-derived pass and
  // the stamp-derived one cannot come to disagree about what a person wrote.
  assert.equal(isGeneratedAsset("/a/preview.webp"), true);
  assert.equal(isGeneratedAsset("/a/og.jpg"), true);
  assert.equal(isGeneratedAsset("/a/assets/img/hero.webp"), false, "prototype content images are authored");
  const manifest = {
    files: {
      "/a/index.html": { editedAt: ago(200) },
      "/a/preview.webp": { editedAt: ago(1) },
    },
  };
  assert.equal(unitProvenance(manifest, "/a/").editedAt, ago(200),
    "a reshoot made an abandoned prototype look current");
});

test("the newest stamp in the folder wins, and an unstamped file is skipped not counted", () => {
  const manifest = {
    files: {
      "/a/index.html": { editedAt: ago(200), by: "old" },
      "/a/second.html": { editedAt: ago(4), by: "recent" },
      "/a/third.html": {},
    },
  };
  assert.deepEqual(unitProvenance(manifest, "/a/"), { editedAt: ago(4), by: "recent" });
  assert.deepEqual(unitProvenance({ files: { "/a/x.html": {} } }, "/a/"), { editedAt: null, by: null });
});

test("the unit path and the status key are the same unit, spelled two ways", () => {
  // `/checkout/flow/` is the unit; `checkout/flow` is what the status chip has always
  // written under. If these stop meeting, every card silently loses its status word.
  assert.equal(unitKey("/checkout/flow/"), "checkout/flow");
  assert.equal(unitKey("/check%20out/flow/"), "check out/flow");
});

// ── 2. one call, and an agent's "what changed here in the last two weeks" ─────────────

test("a since window is a number and h, d or w — and an unreadable one is REFUSED", () => {
  assert.equal(parseSince("14d"), 14 * DAY);
  assert.equal(parseSince("2w"), 14 * DAY);
  assert.equal(parseSince("36h"), 36 * 3600000);
  assert.equal(parseSince("14"), 14 * DAY, "a bare number means days");
  // Zero is the refusal signal the route turns into a 400. Answering a different question
  // than the one asked is how an agent reports a dead workspace as busy.
  for (const bad of ["", "soon", "-3d", "14 days", "d", "0d", null]) assert.equal(parseSince(bad), 0, `${bad}`);
});

const spacesWith = (files) => ({
  demo: { routing: { publicPrefixes: Object.keys(files) }, files: filesOf(files) },
});
function filesOf(units) {
  const out = {};
  for (const [unit, editedAt] of Object.entries(units)) {
    out[`${unit}index.html`] = editedAt ? { editedAt, by: "someone" } : {};
  }
  return out;
}

test("ONE READ answers both audiences — every unit, with status and freshness on it", () => {
  const rows = currencyRows(
    spacesWith({ "/a/live/": ago(2), "/a/dead/": ago(300), "/a/unknown/": null }),
    { "a/live": "dev-ready" },
    { now: NOW },
  );
  assert.deepEqual(rows.map((r) => r.key), ["a/live", "a/dead", "a/unknown"], "newest first, unstamped last");
  assert.deepEqual(
    rows.map((r) => [r.status, r.statusLabel, r.stale, r.when]),
    [
      ["dev-ready", "Dev ready", false, "Edited 2 days ago"],
      [null, null, true, "Untouched for 10 months"],
      [null, null, null, null],
    ],
  );
});

test("a since window lists what CHANGED, and a unit with no record did not answer", () => {
  const rows = currencyRows(
    spacesWith({ "/a/live/": ago(2), "/a/older/": ago(20), "/a/unknown/": null }),
    {},
    { now: NOW, sinceMs: 14 * DAY },
  );
  assert.deepEqual(rows.map((r) => r.key), ["a/live"],
    "listing an unknown unit puts \"we don't know\" in a list of things that happened");
});

test("shared chrome is not somebody's work — _engine is skipped", () => {
  // A deploy rewrites every chrome file at once. Counting it would make the whole site
  // look freshly edited by whoever last bumped the engine pin.
  const rows = currencyRows(
    { _engine: { routing: { publicPrefixes: ["/_engine/"] }, files: { "/_engine/x.css": { editedAt: ago(1) } } } },
    {}, { now: NOW },
  );
  assert.deepEqual(rows, []);
});

test("the author is the recorded one-way id, never an address", () => {
  // A manifest is read by more things than a comment thread is, and this read hands its
  // rows to an agent. Resolving `by` to a name and a face belongs at the render.
  const rows = currencyRows(spacesWith({ "/a/live/": ago(2) }), {}, { now: NOW });
  assert.equal(rows[0].by, "someone");
  assert.ok(!/@/.test(String(rows[0].by)));
});

// ── the route, driven for real ───────────────────────────────────────────────────────

const sha = (s) => createHash("sha256").update(s).digest("hex");

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k), body: store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async head(k) { return store.has(k) ? {} : null; },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const out = { objects: keys.map((k) => ({ key: k })), truncated: false };
      if (delimiter) {
        out.delimitedPrefixes = [...new Set(keys.map((k) => {
          const i = k.indexOf(delimiter, prefix.length);
          return i === -1 ? null : k.slice(0, i + 1);
        }).filter(Boolean))];
      }
      return out;
    },
  };
}

function memKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

const file = (body, editedAt) => ({ h: sha(body), ct: "text/html; charset=utf-8", s: body.length, by: "pub", editedAt });
const liveManifest = (units) => ({
  id: "demo", format: 1, space: { id: "demo", default: true },
  source: { sha: "abc", dirty: false },
  files: Object.fromEntries(Object.entries(units).map(([u, at]) => [`${u}index.html`, file(u, at)])),
  routing: { publicPrefixes: Object.keys(units), versionMap: {} },
});

// The manifest cache is keyed by workspace and holds a view for a tick, so every case
// below asks about a workspace of its own — a shared name would answer the second test
// out of the first one's manifests.
let seq = 0;
function envWith(units, statuses = {}) {
  const tenantId = `ws${++seq}`;
  return {
    tctx: { tenantId },
    env: {
      BUNDLES: memR2({ "spaces/demo/manifest.json": JSON.stringify(liveManifest(units)) }),
      COMMENTS: memKV({ statuses: JSON.stringify(statuses) }),
    },
  };
}

const call = (tctx, env, qs = "", method = "GET") => {
  const url = new URL(`https://x.test/__currency${qs}`);
  return W.currencyApi(tctx, new Request(url, { method }), url, env);
};

test("ONE CALL: an agent asks what changed in the last two weeks and gets the answer", async () => {
  const { tctx, env } = envWith({ "/a/live/": agoLive(2), "/a/older/": agoLive(40), "/a/dead/": agoLive(300) });
  const res = await call(tctx, env, "?since=14d");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.deepEqual(body.units.map((u) => u.key), ["a/live"]);
  assert.equal(body.since, "14d");
  // Echoed, never assumed: a client that hardcoded 90 would keep saying "untouched"
  // against a threshold the instance had moved.
  assert.equal(body.staleAfterDays, STALE_AFTER_DAYS);
});

test("the same call, unwindowed, is what the gallery paints from", async () => {
  const { tctx, env } = envWith({ "/a/live/": agoLive(2), "/a/dead/": agoLive(300) }, { "a/dead": "in-progress" });
  const body = await (await call(tctx, env)).json();
  assert.equal(body.count, 2);
  const dead = body.units.find((u) => u.key === "a/dead");
  assert.equal(dead.stale, true);
  assert.equal(dead.ageDays, 300);
  assert.equal(dead.when, "Untouched for 10 months", "the finding, stated — not the same sentence in a colour");
  assert.equal(dead.statusLabel, "In progress", "status and freshness arrive together or it is two calls");
});

test("an unreadable window is REFUSED, never quietly widened to everything", async () => {
  const { tctx, env } = envWith({ "/a/live/": agoLive(2), "/a/dead/": agoLive(300) });
  const res = await call(tctx, env, "?since=soon");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "bad-since");
});

test("there is nothing to POST — the read stores nothing, so it accepts nothing", async () => {
  const { tctx, env } = envWith({ "/a/live/": agoLive(2) });
  assert.equal((await call(tctx, env, "", "POST")).status, 405);
});

// ── 3. nothing new is maintained: the stamp a publish already wrote is the whole record ──

const CTX = W.applyInstance({ users: [{ email: "someone@example.test", name: "Someone" }] });

test("A REAL PUBLISH IS THE ONLY MAINTENANCE — and it writes no currency field", async () => {
  // Drive the actual commit handler, then read the actual route. If staleness ever needs a
  // second field, it appears here as a key nobody asked for.
  const env = { BUNDLES: memR2(), COMMENTS: memKV(), PUBLISH_BOOTSTRAP_TOKEN: "tok" };
  const body = liveManifest({ "/a/live/": undefined });
  for (const f of Object.values(body.files)) { delete f.by; delete f.editedAt; env.BUNDLES.store.set(`blobs/${f.h}`, "x"); }
  const url = new URL("https://x.test/__publish/demo/commit");
  const res = await W.publishApi(CTX, new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), url, env);
  assert.equal(res.status, 200);

  const stored = JSON.parse(env.BUNDLES.store.get("spaces/demo/manifest.json"));
  const entry = stored.files["/a/live/index.html"];
  assert.deepEqual(Object.keys(entry).sort(), ["by", "ct", "editedAt", "h", "s"],
    "a field appeared beside the stamp — staleness must stay derived, or the junk drawer is back");
  for (const banned of ["stale", "archived", "currency", "lastSeenAt", "abandoned"]) {
    assert.ok(!JSON.stringify(stored).includes(`"${banned}"`), `the manifest grew a \`${banned}\` field`);
  }

  // The route answers off exactly that manifest, with no second read and no second store.
  const tctx = { tenantId: `ws${++seq}` };
  const answered = await (await call(tctx, env)).json();
  assert.deepEqual(answered.units.map((u) => u.key), ["a/live"]);
  assert.equal(answered.units[0].stale, false, "a unit published a moment ago is current");
  assert.ok(answered.units[0].editedAt, "the row carries the stamp the publish wrote");
});

test("THE SAME RECORD, LEFT ALONE, GOES STALE BY ITSELF", async () => {
  // The proof that nothing has to be maintained: take the manifest a publish wrote, change
  // nothing but the calendar, and the answer flips. No republish, no flag, no sweep.
  const { tctx, env } = envWith({ "/a/left-alone/": agoLive(STALE_AFTER_DAYS + 30) });
  const body = await (await call(tctx, env)).json();
  assert.equal(body.units[0].stale, true);
  assert.equal(body.units[0].ageDays, STALE_AFTER_DAYS + 30);
});

// ── 2 (continued). the door an agent can actually walk through ───────────────────────
//
// `/__currency` is gated on a SESSION COOKIE, and no agent has one: `augur login` mints a
// publish token, not a session. A read exposed only to browsers is half the item, so the
// same answer is served under the publish routes, where the credential an agent already
// holds is the credential.

const publishCall = (env, space, qs = "") => {
  const url = new URL(`https://x.test/__publish/${space}/currency${qs}`);
  return W.publishApi({ tenantId: `ws${++seq}`, ...W.applyInstance({ users: [] }) },
    new Request(url, { headers: { Authorization: "Bearer tok" } }), url, env);
};

function publishEnv(bySpace) {
  const objects = {};
  for (const [id, units] of Object.entries(bySpace)) {
    const m = liveManifest(units);
    m.id = id;
    m.space = { id, default: id === "demo" };
    objects[`spaces/${id}/manifest.json`] = JSON.stringify(m);
  }
  return { BUNDLES: memR2(objects), COMMENTS: memKV(), PUBLISH_BOOTSTRAP_TOKEN: "tok" };
}

test("AN AGENT'S ONE CALL — the credential it holds is a publish token, not a cookie", async () => {
  const env = publishEnv({ demo: { "/a/live/": agoLive(2), "/a/dead/": agoLive(300) } });
  const res = await publishCall(env, "demo", "?since=14d");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.units.map((u) => u.key), ["a/live"]);
  assert.equal(body.staleAfterDays, STALE_AFTER_DAYS);
});

test("the two doors are ONE answer, not two definitions of current", async () => {
  const units = { "/a/live/": agoLive(2), "/a/dead/": agoLive(300) };
  const viaToken = await (await publishCall(publishEnv({ demo: units }), "demo")).json();
  const { tctx, env } = envWith(units);
  const viaCookie = await (await call(tctx, env)).json();
  assert.deepEqual(
    viaToken.units.map((u) => [u.key, u.stale, u.when]),
    viaCookie.units.map((u) => [u.key, u.stale, u.when]),
  );
});

test("the token door answers about the token's OWN workspace and no other", async () => {
  const env = publishEnv({
    demo: { "/a/mine/": agoLive(2) },
    other: { "/a/theirs/": agoLive(2) },
  });
  const body = await (await publishCall(env, "demo")).json();
  assert.deepEqual(body.units.map((u) => u.key), ["a/mine"],
    "a workspace-scoped credential was answered with another workspace's shelf");
});

test("no credential, no answer — the read is not public", async () => {
  const env = publishEnv({ demo: { "/a/live/": agoLive(2) } });
  const url = new URL("https://x.test/__publish/demo/currency");
  const res = await W.publishApi({ tenantId: `ws${++seq}` }, new Request(url), url, env);
  assert.equal(res.status, 403);
});

test("the status vocabulary is ONE table — what the gallery prints, the route accepts", () => {
  // A status the gallery can print but the write route rejects, or the reverse, is a word
  // that exists on one surface only, which is the failure this item is about.
  assert.deepEqual(Object.keys(W.VALID_STATUS).sort(), Object.keys(STATUS_LABELS).sort());
  assert.equal(W.STATUS_LABELS, STATUS_LABELS, "the worker took a copy instead of the table");
});

// ── 1 (continued). the gallery: current and abandoned, without opening anything ───────
//
// build.js exports nothing, so this drives the real binary against a real space and reads
// what a visitor's browser gets. The keys asserted here are the join between the two
// halves: the card's `data-currency` has to be the key the route answers under, or every
// card silently keeps the baked line forever and nothing is ever marked.

function buildSpace() {
  const ws = mkdtempSync(path.join(tmpdir(), "currency-ws-"));
  const dir = path.join(ws, "acme");
  const skill = path.join(dir, "skills", "acme-ui");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "acme-ui.css"), ":root{--acme:1}\n");
  writeFileSync(path.join(skill, "skill.json"), JSON.stringify({ assets: ["acme-ui.css"], cssPrefixes: ["acme"] }));
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify({
    items: [{ name: "stat", type: "primitive", classes: ["acme-stat"], label: "Stat", description: "A number." }],
  }));
  writeFileSync(path.join(dir, "space.json"), JSON.stringify({ id: "acme", name: "acme", default: true }));
  for (const name of ["hello", "world"]) {
    const proto = path.join(dir, "demo", "prototypes", name);
    mkdirSync(proto, { recursive: true });
    writeFileSync(path.join(proto, "index.html"), `<!doctype html><title>${name}</title><p>hi</p>\n`);
  }
  // A status somebody actually set, so the baked word has something to say.
  writeFileSync(path.join(dir, "prototype-status.json"), JSON.stringify({ "demo/hello": "dev-ready" }));
  const out = path.join(ws, "__dist");
  execFileSync(process.execPath, ["build.js"], {
    cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: ws, GV_DIST: out }, stdio: ["ignore", "pipe", "pipe"],
  });
  return { ws, out };
}

test("A CARD SAYS ITS STATE AND ITS AGE — on the gallery, with nothing opened", () => {
  const { ws, out } = buildSpace();
  try {
    const html = readFileSync(path.join(out, "demo", "index.html"), "utf8");
    const routing = JSON.parse(readFileSync(path.join(out, "__config", "routing.json"), "utf8"));

    // The state, as a WORD, next to the date — not a 20px glyph you have to know to hover.
    assert.match(html, /<span class="proto-state is-ready">Dev ready<\/span>/,
      "the card does not say its state in words");
    assert.match(html, /<span class="proto-when"[^>]*>Edited [^<]+<\/span>/,
      "the card does not say when it was last touched");

    // No word for `ignore`: it is the default every unit starts at, so printing it would
    // put a word on every card and a signal on none. The dim already says it.
    const worldCard = html.slice(html.indexOf('data-currency="demo/world"'));
    assert.ok(!worldCard.slice(0, 200).includes("proto-state"),
      "the default state got a word, which puts a label on every card and a signal on none");

    // THE JOIN. Every unit the routing publishes has a card keyed the way the route
    // answers, or the served truth never reaches the card it belongs to.
    for (const prefix of routing.publicPrefixes) {
      assert.ok(html.includes(`data-currency="${unitKey(prefix)}"`)
        || readFileSync(path.join(out, "playground", "index.html"), "utf8").includes(`data-currency="${unitKey(prefix)}"`),
        `no card is keyed ${unitKey(prefix)} — the paint would never find this unit`);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("ABANDONED LOOKS DIFFERENT — and on a different axis from ignored", () => {
  const { ws, out } = buildSpace();
  try {
    const css = readFileSync(path.join(out, readdirSync(out).find((f) => /^_chrome\..*\.css$/.test(f))), "utf8");
    const js = readFileSync(path.join(out, readdirSync(out).find((f) => /^_chrome\..*\.js$/.test(f))), "utf8");

    // Colour drains out of the poster — the archive-photo idiom — while the meta text
    // stays at full contrast, because dimming the words would hide the part that says why.
    assert.match(css, /\.card-proto\.is-stale[^{]*\{[^}]*grayscale\(1\)/,
      "an abandoned card's poster is not treated at all");
    // A DIFFERENT axis from the ignore dim on purpose: ignore is "nobody is tracking
    // this", stale is "nobody has touched this", and a card can be either, both, neither.
    assert.match(css, /:has\(\.status-chip\.is-ignore\)[^{]*\{[^}]*opacity/,
      "the ignore dim went away, so the two states now share one treatment");
    assert.match(css, /\.proto-when--stale\s*\{[^}]*font-weight/,
      "the stale sentence is carried by colour alone — it must survive a greyscale screen");

    // And the paint is wired to the one read, keyed the way the cards are.
    assert.ok(js.includes("/__currency"), "the gallery never asks what is current");
    for (const hook of ["[data-currency]", "[data-currency-folder]", "[data-status-key]", "proto-when", "is-stale"]) {
      assert.ok(js.includes(hook), `the paint lost its hook on ${hook}`);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
