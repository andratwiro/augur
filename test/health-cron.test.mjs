// The checks an instance runs on itself, and — mostly — the ones it refuses to run.
//
// `A-degithub-runtime`. The item's acceptance test is "Actions minutes consumed by normal
// operation: zero", and this is the half of the canary that can move inside the worker.
//
// The tests that matter here are the NEGATIVES. A health check is worth having only if
// "healthy" and "nobody looked" produce different answers, so most of what follows is about
// the ways this can fail to know something and has to say so rather than pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runHealth, checkDirtyPublishes, checkBakeDrift, checkEngineStaleness, HEALTH_GRACE,
} from "../src/health-cron.mjs";
import { __testables as W } from "../src/_worker.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

const stamp = (over = {}) => ({
  builtAt: ago(60),
  engine: { sha: "eeee1111", version: "0.15.0", publishedAt: ago(60), ...(over.engine || {}) },
  spaces: over.spaces || { delta: { sha: "aaaa1111", version: 9, publishedAt: ago(60), builtWithEngine: "eeee1111" } },
});
const find = (checks, name) => checks.find((c) => c.name === name);

// ── a working-tree publish, which is the one nobody was looking at ───────────

test("a clean publish passes and a fresh dirty one passes, because a session is allowed to be dirty", () => {
  const clean = checkDirtyPublishes(stamp(), NOW);
  assert.equal(find(clean, "clean delta").ok, true);

  const fresh = checkDirtyPublishes(stamp({ spaces: { delta: { sha: "a1", dirty: true, publishedAt: ago(60) } } }), NOW);
  assert.equal(find(fresh, "dirty delta").ok, true);
});

test("A DIRTY PUBLISH THAT OUTLIVED ITS WINDOW IS A FAILURE, and says the bytes exist nowhere", () => {
  const c = checkDirtyPublishes(stamp({ spaces: { delta: { sha: "a1", dirty: true, publishedAt: ago(HEALTH_GRACE.dirty + 60) } } }), NOW);
  const r = find(c, "dirty delta");
  assert.equal(r.ok, false);
  assert.match(r.detail, /exist in no repository/);
});

test("A DIRTY PUBLISH WITH NO TIMESTAMP IS A FAILURE, NOT A PASS", () => {
  // The shape that would otherwise slip through: unknown age is not young age. Reading it
  // as "inside the window" would hide precisely the publishes nothing recorded properly.
  const c = checkDirtyPublishes(stamp({ spaces: { delta: { sha: "a1", dirty: true } } }), NOW);
  assert.equal(find(c, "dirty delta").ok, false);
});

// ── chrome baked by an older engine ──────────────────────────────────────────

test("bake drift inside the self-heal window is not yet a finding", () => {
  const c = checkBakeDrift(stamp({
    engine: { sha: "new2222", publishedAt: ago(60) },
    spaces: { delta: { builtWithEngine: "old1111", publishedAt: ago(9000) } },
  }), NOW);
  assert.equal(find(c, "bake delta").ok, true);
});

test("BAKE DRIFT THAT OUTLIVED THE SELF-HEAL WINDOW IS A FAILURE", () => {
  const c = checkBakeDrift(stamp({
    engine: { sha: "new2222", publishedAt: ago(HEALTH_GRACE.rebake + 600) },
    spaces: { delta: { builtWithEngine: "old1111", publishedAt: ago(99999) } },
  }), NOW);
  const r = find(c, "bake delta");
  assert.equal(r.ok, false);
  assert.match(r.detail, /re-bake was missed/);
});

test("a space published before the bake stamp existed is SKIPPED, not failed", () => {
  const c = checkBakeDrift(stamp({ spaces: { delta: { publishedAt: ago(99999) } } }), NOW);
  assert.equal(find(c, "bake delta").skip, true);
});

// ── engine staleness, which is the check the whole item is for ───────────────

const release = (tag, publishedAt) => ({
  ok: true, status: 200, async json() { return { tag_name: tag, published_at: publishedAt }; },
});

test("running the newest RELEASE passes", async () => {
  const r = await checkEngineStaleness(stamp(), { now: NOW, fetchImpl: async () => release("v0.15.0", ago(3600)) });
  assert.equal(r.ok, true);
  assert.match(r.detail, /newest release/);
});

test("BEHIND THE NEWEST RELEASE, AND IT IS OLD, IS A FAILURE — the point of the whole item", async () => {
  // "If your own CI is broken this is the only place that will say so" is the sentence this
  // test exists to keep true.
  const r = await checkEngineStaleness(stamp(), {
    now: NOW, fetchImpl: async () => release("v0.99.0", ago(45 * 86400)),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /0\.15\.0/);
  assert.match(r.detail, /v0\.99\.0/);
});

test("behind a release that is only days old is NOT a failure — every instance is briefly behind", async () => {
  const r = await checkEngineStaleness(stamp(), {
    now: NOW, fetchImpl: async () => release("v0.16.0", ago(2 * 86400)),
  });
  assert.equal(r.ok, true);
});

test("GITHUB BEING DOWN IS A SKIP, NEVER A FAILURE", async () => {
  // GitHub is not this instance. Reporting its outage as our ill health would train an
  // operator to ignore the one check that tells them their engine is months old.
  const thrown = await checkEngineStaleness(stamp(), { now: NOW, fetchImpl: async () => { throw new Error("network"); } });
  assert.equal(thrown.skip, true);
  const rate = await checkEngineStaleness(stamp(), { now: NOW, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(rate.skip, true);
  assert.equal(rate.ok, undefined, "a rate-limited answer must not read as a pass");
});

test("a build that stamped no engine version is SKIPPED — there is nothing to compare", async () => {
  const r = await checkEngineStaleness(stamp({ engine: { sha: "x", version: null } }), { now: NOW, fetchImpl: async () => release("v9.9.9", ago(0)) });
  assert.equal(r.skip, true);
});

// ── the report as a whole ────────────────────────────────────────────────────

test("NO BUILD STAMP IS A FAILING REPORT, not an empty passing one", async () => {
  // The failure that would matter most. An instance that cannot compose its own stamp
  // knows nothing about itself, and a report saying so is the only honest answer — an
  // empty `checks: []` with `ok: true` reads as a clean bill of health.
  const r = await runHealth({ stamp: null, now: NOW, fetchImpl: async () => release("v0.15.0", ago(0)) });
  assert.equal(r.ok, false);
  assert.equal(r.failures, 1);
  assert.match(find(r.checks, "build stamp").detail, /could not compose/);
});

test("the report lists PASSING checks too, so it cannot be confused with one that ran nothing", async () => {
  const r = await runHealth({ stamp: stamp(), now: NOW, fetchImpl: async () => release("v0.15.0", ago(0)) });
  assert.equal(r.ok, true);
  assert.ok(r.checks.length >= 3, `only ${r.checks.length} checks in a passing report`);
  assert.ok(r.checks.some((c) => c.ok === true));
});

test("a check that throws is caught and reported, rather than losing the whole run", async () => {
  const r = await runHealth({
    stamp: stamp(), now: NOW,
    fetchImpl: () => { throw new Error("boom"); },
  });
  // The staleness check swallows its own fetch error as a skip, so the run still completes
  // and the other checks still ran. That is the property: one broken check is not silence.
  assert.ok(r.checks.length >= 3);
  assert.equal(typeof r.at, "string");
});

// ── the worker's scheduled handler ───────────────────────────────────────────

function memKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}

test("A MULTI-WORKSPACE DEPLOYMENT DECLINES, and says why, rather than checking one at random", async () => {
  // A cron has no Host, so on a deployment that tells workspaces apart BY Host there is no
  // single workspace to check. Inventing one would be a second answer to the question the
  // whole isolation model is keyed on — and `scripts/one-tenant-resolver.mjs` fails the
  // build over exactly that.
  const out = await W.runScheduledHealth({ TENANT_HOST_SUFFIX: ".example.com", COMMENTS: memKv() });
  assert.equal(out.failures, 0);
  assert.equal(out.stored, false);
  assert.equal(out.checks[0].skip, true);
  assert.match(out.checks[0].detail, /no hostname/);
});

test("with nowhere to write, the cron says so instead of throwing", async () => {
  // A thrown scheduled handler retries and re-runs every check, and the thing that could
  // not be written still cannot be. Saying so once is the useful behaviour.
  const out = await W.runScheduledHealth({});
  assert.equal(out.stored, false);
  assert.match(out.why, /no store/);
});

// ── the admin read ───────────────────────────────────────────────────────────

const ADMIN = { email: "a@x.test", role: "admin" };

test("the health endpoint is admin-only", async () => {
  for (const who of [null, { email: "e@x.test", role: "editor" }, { email: "v@x.test", role: "viewer" }]) {
    const res = await W.adminHealthApi({ COMMENTS: memKv() }, who);
    assert.equal(res.status, 403, `role ${who && who.role} reached the health report`);
  }
});

test("AN ABSENT REPORT SAYS SO IN WORDS — it never 404s, and it never reads as healthy", async () => {
  // The state this endpoint exists to make visible is "the cron is not running". A 404, or
  // an empty object, or `ok: true` with no checks would all be read as fine.
  const res = await W.adminHealthApi({ COMMENTS: memKv() }, ADMIN);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.report, null);
  assert.match(body.why, /not a healthy one/);
});

test("a stored report comes back WITH ITS AGE, because a stale report is how a dead cron looks", async () => {
  const kv = memKv({ [W.HEALTH_REPORT_KEY]: JSON.stringify({ at: new Date(Date.now() - 90000).toISOString(), ok: true, failures: 0, checks: [] }) });
  const res = await W.adminHealthApi({ COMMENTS: kv }, ADMIN);
  const body = await res.json();
  assert.equal(body.report.ok, true);
  assert.ok(body.ageSeconds >= 89 && body.ageSeconds <= 120, `ageSeconds was ${body.ageSeconds}`);
});

test("READING THE REPORT NEVER RUNS THE CHECKS", async () => {
  // If it did, "the cron is dead" and "nobody opened this page" would be the same green
  // answer — and the first is the condition this whole item exists to surface.
  const kv = memKv();
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return release("v9.9.9", ago(0)); };
  try {
    await W.adminHealthApi({ COMMENTS: kv }, ADMIN);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, false, "the admin read reached out to GitHub, so it ran a check");
  assert.equal(kv.m.size, 0, "the admin read wrote a report, so it ran the cron");
});
