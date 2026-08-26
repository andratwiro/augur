// A publish token minted for a PERSON runs out.
//
// `B-publish-token-ttl`. A publish token overwrites everything a workspace has published.
// It was written to KV with no expiry at all, so one copied into a CI variable, an agent
// transcript or a laptop that later changed hands stayed good forever, and the only way to
// end it was for somebody to remember it existed.
//
// TWO DOORS MINT ONE CREDENTIAL, so they read one number. `augur login` (a password) and
// `augur connect` (a browser approval) both go through mintPublishToken now; they did not
// before, and the copy would have been the door still handing out immortal tokens after
// the other one stopped.
//
// WHAT IS DELIBERATELY NOT COVERED BY THE CLOCK: a token an admin mints by hand for a
// machine — "ci", "backup", "uptime-probe". Nothing re-runs a login for a nightly backup,
// so an expiry there is an outage at 4am with nobody to fix it. Those end on the revoke
// list or not at all, which is the honest arrangement rather than the tidy one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";

function memKV(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const ADMIN = { email: "boss@example.test", name: "Boss", role: "admin" };
const EDITOR = { email: "ed@example.test", name: "Ed", role: "editor" };
// SPACES comes from routing, not from the instance document, so a fixture that only
// applies an instance has no default space and mintPublishToken correctly refuses.
const ctxWith = (over = {}) => Object.freeze({
  ...W.applyInstance({ users: [ADMIN, EDITOR] }),
  SPACES: [{ id: "alpha", default: true }],
  ...over,
});

const bearer = (t) => new Request("https://x.test/__publish/alpha/check", { headers: { Authorization: "Bearer " + t } });

/** Whether a token gets past publishAuth, through the one caller that exposes its verdict. */
async function publishes(ctx, env, token) {
  const url = new URL("https://x.test/__publish/alpha/check");
  const quiet = console.log; console.log = () => {};
  try {
    const res = await W.publishApi(ctx, bearer(token), url, env);
    if (res.status !== 403) return true;
    // Two codes mean "publishAuth refused", not one: expiry got its own so the CLI can
    // print the fix. Any other 403 came from further down the route.
    const { error } = await res.json();
    return error !== "forbidden" && error !== "token-expired";
  } finally { console.log = quiet; }
}

// ── the number ───────────────────────────────────────────────────────────────

test("the default is 30 days, and both doors read the same one", () => {
  const days = 30 * 24 * 60 * 60 * 1000;
  assert.equal(W.publishTokenTtlMs(ctxWith()), days);
  assert.equal(W.publishTokenTtlMs(undefined), days, "a missing context still expires the token");
  assert.equal(W.publishTokenTtlMs({}), days);
});

test("an instance can set its own, and 0 means no expiry", () => {
  assert.equal(W.publishTokenTtlMs(ctxWith({ PUBLISH_TOKEN_TTL_DAYS: 7 })), 7 * 86400000);
  assert.equal(W.publishTokenTtlMs(ctxWith({ PUBLISH_TOKEN_TTL_DAYS: 0 })), 0,
    "an explicit 0 must turn expiry off — it is a decision somebody can legitimately make");
});

test("A TYPO FALLS BACK TO THE DEFAULT, never to 'forever'", async () => {
  // The direction this is allowed to be wrong in. A config mistake must not be the thing
  // that quietly returns publish tokens to living forever.
  const { applyInstance } = W;
  for (const bad of ["30", null, -1, NaN, {}, [], undefined]) {
    const ctx = applyInstance({ users: [ADMIN], publishTokenTtlDays: bad });
    assert.equal(ctx.PUBLISH_TOKEN_TTL_DAYS, 30, `publishTokenTtlDays: ${JSON.stringify(bad)}`);
  }
  applyInstance({ users: [] });
});

// ── the mint ─────────────────────────────────────────────────────────────────

test("a minted token carries an expiry, and it is the configured one", async () => {
  const kv = memKV();
  const before = Date.now();
  const minted = await W.mintPublishToken(kv, ctxWith({ PUBLISH_TOKEN_TTL_DAYS: 14 }), EDITOR);
  const map = JSON.parse(kv.store.get("publish:tokens"));
  const rec = Object.values(map)[0];
  assert.ok(rec.expiresAt, "the token was minted with no expiry");
  assert.equal(rec.expiresAt, minted.expiresAt, "the caller was told a different date from the one stored");
  const ms = Date.parse(rec.expiresAt) - before;
  assert.ok(ms > 13.9 * 86400000 && ms < 14.1 * 86400000, `expiry is ${ms}ms away, not ~14 days`);
});

test("a zero TTL mints a token with no expiry field at all", async () => {
  // Not `expiresAt: null` — publishAuth reads the field's PRESENCE, and a null that
  // stringifies into KV would be one more shape for it to have to know about.
  const kv = memKV();
  const minted = await W.mintPublishToken(kv, ctxWith({ PUBLISH_TOKEN_TTL_DAYS: 0 }), EDITOR);
  const rec = Object.values(JSON.parse(kv.store.get("publish:tokens")))[0];
  assert.ok(!("expiresAt" in rec));
  assert.equal(minted.expiresAt, null);
});

// ── the enforcement ──────────────────────────────────────────────────────────

test("PUBLISHAUTH REFUSES AN EXPIRED TOKEN, and accepts the same one a day earlier", async () => {
  // The VERIFY. No clock to fast-forward: the expiry is stored as a date, so a token whose
  // stored date is in the past IS an expired token — writing one is the fast-forward.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const ctx = ctxWith();

  const live = await W.mintPublishToken(kv, ctx, EDITOR);
  assert.equal(await publishes(ctx, env, live.token), true, "a fresh token was refused");

  // Age it past its own expiry, in place.
  const map = JSON.parse(kv.store.get("publish:tokens"));
  for (const h in map) map[h].expiresAt = new Date(Date.now() - 60_000).toISOString();
  kv.store.set("publish:tokens", JSON.stringify(map));
  assert.equal(await publishes(ctx, env, live.token), false, "an expired token still published");

  // And one second the other side of the line still works, so the check is a comparison
  // rather than "has an expiresAt at all".
  for (const h in map) map[h].expiresAt = new Date(Date.now() + 60_000).toISOString();
  kv.store.set("publish:tokens", JSON.stringify(map));
  assert.equal(await publishes(ctx, env, live.token), true);
});

test("a fresh login after expiry mints a token that works", async () => {
  // The second half of the VERIFY: expiry must be recoverable by the one command the
  // holder already knows, not by an admin.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const ctx = ctxWith();
  const old = await W.mintPublishToken(kv, ctx, EDITOR);
  const map = JSON.parse(kv.store.get("publish:tokens"));
  for (const h in map) map[h].expiresAt = new Date(Date.now() - 1).toISOString();
  kv.store.set("publish:tokens", JSON.stringify(map));
  assert.equal(await publishes(ctx, env, old.token), false);

  const fresh = await W.mintPublishToken(kv, ctx, EDITOR);
  assert.equal(await publishes(ctx, env, fresh.token), true, "re-logging in did not restore publishing");
  assert.notEqual(fresh.token, old.token);
});

test("A TOKEN MINTED BEFORE EXPIRY EXISTED KEEPS WORKING", async () => {
  // Strictly additive, and it has to stay that way: every token on every live instance
  // today has no expiresAt, including the ones a nightly backup and an uptime probe hold.
  // A check that treated "no expiry" as "expired" would take those out on the deploy.
  const kv = memKV();
  const env = { COMMENTS: kv, BUNDLES: {} };
  const token = "legacy-token";
  kv.store.set("publish:tokens", JSON.stringify({
    [await W.tokenFor("pub:" + token)]: { space: "alpha", label: "ci", createdAt: "2026-01-01T00:00:00.000Z" },
  }));
  assert.equal(await publishes(ctxWith(), env, token), true);
});

test("THE HAND-MINTED MACHINE TOKEN GETS NO CLOCK", async () => {
  // /__admin/tokens writes its own record on purpose. A nightly backup and an uptime probe
  // hold tokens with no login to re-run, so an expiry there is an outage at 4am with
  // nobody to fix it. Driven rather than grepped: what matters is what the route WRITES.
  const kv = memKV();
  const env = { COMMENTS: kv };
  const res = await W.adminTokensApi(
    new Request("https://x.test/__admin/tokens", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "alpha", label: "nightly-backup" }),
    }),
    env, ADMIN,
  );
  assert.equal(res.status, 200);
  const rec = Object.values(JSON.parse(kv.store.get("publish:tokens")))[0];
  assert.equal(rec.label, "nightly-backup");
  assert.ok(!("expiresAt" in rec), "a machine token grew an expiry");

  // And that token keeps publishing however long it sits there.
  const { token } = await res.json();
  const map = JSON.parse(kv.store.get("publish:tokens"));
  assert.equal(await publishes(ctxWith(), { COMMENTS: kv, BUNDLES: {} }, token), true);
  assert.deepEqual(JSON.parse(kv.store.get("publish:tokens")), map, "a publish rewrote the token map");
});
