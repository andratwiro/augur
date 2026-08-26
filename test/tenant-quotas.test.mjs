// What one workspace is allowed, seeded into the workspace and read from there.
//
// `B-quota-schema`. Four enforcement points are coming — asset uploads, board writes,
// realtime rooms, signup invites. The failure this schema prevents is not a wrong limit;
// it is nobody being able to say what the limit IS, because each point declared its own.
// So the tests below are mostly about ONE HOME: that the defaults live in exactly one
// table, that changing a value there is the whole change, and that no enforcement point
// can end up reading an absent ceiling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  applyTenantSchema, seedQuotas, setWorkspacePlan, TenantStore,
} from "../src/tenant-do.js";
import { PLANS, DEFAULT_PLAN, QUOTA_FIELDS, quotasForPlan } from "../src/tenant-quotas.mjs";

function sqlHandle(db) {
  return {
    exec(stmt, ...params) {
      if (params.length) { db.prepare(stmt).run(...params); return []; }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
}
function workspace() {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f() };
  return { db, store: new TenantStore(ctx, {}) };
}
const quotaRows = (db) =>
  Object.fromEntries(db.prepare("SELECT k, n FROM quotas").all().map((r) => [r.k, r.n]));

// ── the table ────────────────────────────────────────────────────────────────

test("every plan defines every field — a partial plan is a missing ceiling", () => {
  // The failure this catches: a plan added later that forgets one field, so one
  // enforcement point reads nothing and the workspace has no limit on exactly that thing.
  for (const [name, plan] of Object.entries(PLANS)) {
    for (const field of QUOTA_FIELDS) {
      assert.ok(field in plan, `plan "${name}" does not define ${field}`);
      assert.equal(typeof plan[field], "number", `${name}.${field} is not a number`);
      assert.ok(Number.isFinite(plan[field]) && plan[field] > 0, `${name}.${field} is ${plan[field]}`);
    }
    // And nothing EXTRA, so a field somebody adds to a plan without adding it to
    // QUOTA_FIELDS is caught here rather than by never being seeded.
    for (const k of Object.keys(plan)) {
      assert.ok(QUOTA_FIELDS.includes(k), `plan "${name}" defines ${k}, which is not in QUOTA_FIELDS`);
    }
  }
});

test("NOTHING IS NULL, because unlimited has to compare the same way everywhere", () => {
  // An absent ceiling written as null reads as "no limit" at one call site and "not
  // configured, refuse" at another, and both readings are defensible — which is the
  // problem. Unlimited is a large number.
  for (const plan of Object.values(PLANS)) {
    for (const v of Object.values(plan)) assert.notEqual(v, null);
  }
});

test("the paid plan is not smaller than the free one anywhere", () => {
  // A paying workspace refused something a free one gets is the single worst bug this
  // table can have, and a plausible one: the numbers are edited by hand.
  for (const field of QUOTA_FIELDS) {
    assert.ok(PLANS.paid[field] >= PLANS.free[field],
      `paid.${field} (${PLANS.paid[field]}) is below free.${field} (${PLANS.free[field]})`);
  }
});

test("the free tier is ONE editor, because the paywall is the second one", () => {
  // Not a tuning knob. Everything else on the list is a cost ceiling; this is the
  // business model, so it is pinned rather than left to drift with the others.
  assert.equal(PLANS.free.editorSeatLimit, 1);
});

test("an unknown plan name resolves to the free tier, never to no limits", () => {
  // A typo in a billing webhook must not be how somebody gets an unlimited workspace.
  for (const bogus of ["enterprise", "", null, undefined, "FREE"]) {
    assert.equal(quotasForPlan(bogus).plan, DEFAULT_PLAN, `${bogus}`);
    assert.equal(quotasForPlan(bogus).editorSeatLimit, PLANS.free.editorSeatLimit);
  }
});

// ── the seed ─────────────────────────────────────────────────────────────────

test("A NEW WORKSPACE'S QUOTA ROW MATCHES THE DEFAULTS EXACTLY", async () => {
  // The VERIFY, first half.
  const { db, store } = workspace();
  await store.init("acme");
  assert.deepEqual(quotaRows(db), Object.fromEntries(QUOTA_FIELDS.map((f) => [f, PLANS.free[f]])));
  assert.deepEqual(store.quotas(), { plan: "free", ...Object.fromEntries(QUOTA_FIELDS.map((f) => [f, PLANS.free[f]])) });
});

test("CHANGING A DEFAULT AND PROVISIONING AGAIN GIVES THE NEW VALUE, with no other change", async () => {
  // The VERIFY, second half. The `plans` parameter is what makes this checkable: it proves
  // the value flows from that one table into the workspace with nothing else to keep in
  // step. In production there is one table and this is the only thing anyone edits.
  const raised = { ...PLANS, free: { ...PLANS.free, editorSeatLimit: 7 } };
  const db = new DatabaseSync(":memory:");
  const sql = sqlHandle(db);
  applyTenantSchema(sql, "acme");
  seedQuotas(sql, "free", raised);
  assert.equal(quotaRows(db).editorSeatLimit, 7);
  // And every other ceiling is untouched by that edit.
  for (const field of QUOTA_FIELDS.filter((f) => f !== "editorSeatLimit")) {
    assert.equal(quotaRows(db)[field], PLANS.free[field], field);
  }
});

test("seeding again does not undo a raise given to one customer", async () => {
  // Support raises a limit for somebody; the next deploy, restart or cold object must not
  // put it back. INSERT ... DO NOTHING is what makes that true, and it is easy to
  // "simplify" into an upsert that silently reverses every support decision ever made.
  const { db, store } = workspace();
  await store.init("acme");
  db.prepare("UPDATE quotas SET n = ? WHERE k = 'storageBytesCap'").run(999);
  seedQuotas(sqlHandle(db), "free");
  assert.equal(quotaRows(db).storageBytesCap, 999);
});

test("a workspace seeded on the paid plan says so, in meta and in every ceiling", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = sqlHandle(db);
  applyTenantSchema(sql, "acme");
  seedQuotas(sql, "paid");
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='plan'").get().v, "paid");
  assert.deepEqual(quotaRows(db), Object.fromEntries(QUOTA_FIELDS.map((f) => [f, PLANS.paid[f]])));
});

// ── the plan change ──────────────────────────────────────────────────────────

test("MOVING A WORKSPACE TO PAID MOVES THE CEILINGS, not just the label", async () => {
  // The failure that would otherwise ship: a plan change that writes the name and leaves
  // the numbers behind is a workspace that has paid and is still refused, and every
  // enforcement point would be reading the old row and be correct to.
  const { db, store } = workspace();
  await store.init("acme");
  assert.equal(store.quotas().plan, "free");
  setWorkspacePlan(sqlHandle(db), "paid");
  const after = store.quotas();
  assert.equal(after.plan, "paid");
  for (const field of QUOTA_FIELDS) assert.equal(after[field], PLANS.paid[field], field);
});

test("a downgrade is a real downgrade, and it discards a per-customer raise", async () => {
  // Stated because it is the one place the two write paths deliberately disagree: seeding
  // preserves a raise, a plan change overwrites it. "Put this workspace on the free plan"
  // has to mean the free plan.
  const { db, store } = workspace();
  await store.init("acme");
  setWorkspacePlan(sqlHandle(db), "paid");
  db.prepare("UPDATE quotas SET n = ? WHERE k = 'rtConcurrentRooms'").run(500);
  setWorkspacePlan(sqlHandle(db), "free");
  assert.equal(store.quotas().plan, "free");
  assert.equal(store.quotas().rtConcurrentRooms, PLANS.free.rtConcurrentRooms);
});

test("an unknown plan name lands the workspace on free rather than on nothing", async () => {
  const { db, store } = workspace();
  await store.init("acme");
  assert.equal(setWorkspacePlan(sqlHandle(db), "enterprise-plus"), "free");
  assert.equal(store.quotas().plan, "free");
});

// ── the shape enforcement points depend on ───────────────────────────────────

test("a workspace can never be read as having no ceilings", async () => {
  // Every enforcement point reads this. A workspace that reached one with an empty quota
  // table would have no limit on that one thing, which is the wrong direction to fail in —
  // so init() seeds as well as provisioning, and quotas() answers from the plan default
  // for anything absent.
  const { store } = workspace();
  await store.init("acme");
  const q = store.quotas();
  for (const field of QUOTA_FIELDS) {
    assert.equal(typeof q[field], "number", `${field} is not a number on a fresh workspace`);
  }
});
