// What somebody can do TO a workspace from outside it.
//
// `B-control-plane-verbs`. Four verbs — suspend, resume, rotate, delete — plus the door they
// arrive through. They share one property that matters more than any of them individually:
//
//   ⚠️ NONE OF THEM MAY CREATE A WORKSPACE.
//
// Each takes its workspace name from a URL path an operator typed. `idFromName` is not a
// lookup, it is an address, so a typo reaches a perfectly good empty object — and a verb
// that initialised before refusing would leave a workspace nobody knows exists, holding a
// signing key and a quota row, absent from every list, discoverable only by someone
// repeating the typo. So every verb below reads `meta` the way `status()` does and refuses
// before `init()` is anywhere near the call.
//
// ── THE SEAM THIS FILE ALSO CLOSES ──────────────────────────────────────────────────
//
// The control plane's `callTenant` has always POSTed `/__control/<verb>`. This object routed
// `/status`, `/activity`, `/destroy`, `/state/import`, `/publish-version` and `/quota/bump`,
// and nothing else — so every control-plane call was a 404 into a handler that had no idea
// it was being addressed, and nothing on either side was watching for it. The two repos
// cannot import each other, so the verb list is written twice; the test at the bottom of
// this file is what keeps the two copies the same list.
//
// ── VERIFIED UNDER A REAL RUNTIME ───────────────────────────────────────────────────
//
// The storage stub here has real transaction semantics. What was run under `wrangler dev
// --local` against a real Durable Object namespace, verb by verb, before this file was
// written:
//
//   · all four verbs on a name nobody provisioned → 404 `not-provisioned`, and `status()`
//     afterwards answered `hasStoredData: false`. Nothing was created. That is the one claim
//     a stub genuinely cannot make, because a real DO's storage carries its own bookkeeping
//     rows and an earlier version of `status()` read those as "this workspace exists".
//   · provision → suspend → re-suspend → resume → delete → resume: 200, 200 unchanged with
//     the first reason and date kept, 200 with `suspendedMs: 5400000`, 200 with a
//     `purgeAfter` thirty days out, then 409 `deleted`.
//   · an unknown verb → 404 `tenant-verb-not-allowed`; a GET on a write verb → 405.
//   · two rotates in a row, each answering `sessionsEnded: false`.
//
// The transaction ROLLBACK is covered here rather than there — injecting a throw needs a
// hook a real runtime does not offer — and `transactionSync`'s rollback was itself verified
// under real workerd when provisioning was built (test/tenant-provisioning.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { TenantStore, CONTROL_VERBS, DELETE_GRACE_MS } from "../src/tenant-do.js";

const readSource = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

/** A DO storage stub with REAL transaction semantics, so rollback is tested and not mimed. */
function storage(db) {
  const sql = {
    exec(stmt, ...params) {
      if (params.length) {
        const s = db.prepare(stmt);
        return /^\s*SELECT/i.test(stmt) ? s.all(...params) : (s.run(...params), []);
      }
      if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
      db.exec(stmt);
      return [];
    },
  };
  return {
    sql,
    transactionSync(cb) {
      db.exec("BEGIN");
      try { const out = cb(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

function workspace() {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: storage(db), blockConcurrencyWhile: async (f) => f() };
  return { db, store: new TenantStore(ctx, {}) };
}

const ADMIN = "first@example.test";
const provisioned = async () => {
  const w = workspace();
  await w.store.provision({ workspaceId: "acme", adminEmail: ADMIN });
  return w;
};
const control = (store, verb, body, method = "POST") =>
  store.fetch(new Request(`https://tenant.invalid/__control/${verb}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  }));

// ── the property every verb shares ──────────────────────────────────────────────────

test("NO VERB CREATES A WORKSPACE — a typo'd name leaves an object with nothing in it", async () => {
  for (const verb of ["suspend", "resume", "rotate", "delete"]) {
    const { db, store } = workspace();
    const res = await control(store, verb, { reason: "typo" });
    assert.equal(res.status, 404, verb);
    assert.deepEqual(await res.json(), { ok: false, error: "not-provisioned" }, verb);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all();
    assert.deepEqual(tables, [], `${verb} created ${tables.length} table(s) on a name nobody provisioned`);
  }
});

test("a workspace whose tables exist but was never provisioned is still refused", async () => {
  // The other half: `init()` creates tables without provisioning, so "has a meta table" is
  // not the same question as "exists". Both have to answer no.
  const { store } = workspace();
  await store.init("acme");
  for (const verb of ["suspend", "resume", "rotate", "delete"]) {
    const res = await control(store, verb, {});
    assert.equal(res.status, 404, verb);
  }
});

test("A REFUSAL IS A 4xx, never an ok:false wearing a 200", async () => {
  // The control plane writes a verb's verdict into its audit log from the status line. A
  // refusal in a 200 is a suspension recorded as having happened.
  const { store } = workspace();
  const res = await control(store, "suspend", {});
  assert.ok(res.status >= 400, `a refusal answered ${res.status}`);
});

// ── suspend / resume ────────────────────────────────────────────────────────────────

test("SUSPEND RECORDS THE REASON A PERSON WROTE, and status reports it", async () => {
  const { store } = await provisioned();
  const out = await (await control(store, "suspend", { reason: "aup: phishing page", at: "2026-08-26T10:00:00.000Z" })).json();
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  const s = store.status();
  assert.equal(s.suspended, true);
  assert.equal(s.suspendedReason, "aup: phishing page");
  assert.equal(s.suspendedAt, "2026-08-26T10:00:00.000Z");
});

test("re-suspending does NOT restart the clock or replace the reason", async () => {
  // A retrying script must not lose why the suspension started or when — same rule as
  // re-freezing, and for the same reason.
  const { store } = await provisioned();
  await control(store, "suspend", { reason: "aup", at: "2026-08-26T10:00:00.000Z" });
  const again = await (await control(store, "suspend", { reason: "something else", at: "2026-08-26T11:00:00.000Z" })).json();
  assert.equal(again.changed, false);
  assert.equal(again.since, "2026-08-26T10:00:00.000Z");
  assert.equal(store.status().suspendedReason, "aup");
});

test("RESUME SAYS HOW LONG IT WAS DOWN, because somebody planned around that number", async () => {
  const { store } = await provisioned();
  await control(store, "suspend", { reason: "aup", at: "2026-08-26T10:00:00.000Z" });
  const out = await (await control(store, "resume", { at: "2026-08-26T11:30:00.000Z" })).json();
  assert.equal(out.changed, true);
  assert.equal(out.suspendedMs, 90 * 60 * 1000);
  assert.equal(store.status().suspended, false);
  assert.equal(store.status().suspendedReason, null);
});

test("resuming something that is not suspended is a no-op, not an error", async () => {
  const { store } = await provisioned();
  const out = await (await control(store, "resume", {})).json();
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
});

test("⚠️ SETTING THE FLAG IS NOT THE ENFORCEMENT, and the source says so", () => {
  // Nothing consults `suspended` on the request path yet — that is B-suspend-check-in-resolver.
  // An operator who reads "suspended" and concludes the site is dark is wrong today, so the
  // claim lives in the file rather than only in a plan item.
  const src = readSource("../src/tenant-do.js");
  assert.match(src, /SETTING THE FLAG IS NOT THE ENFORCEMENT/);
  assert.match(src, /B-suspend-check-in-resolver/);
});

// ── rotate ──────────────────────────────────────────────────────────────────────────

test("ROTATE REALLY REVOKES PUBLISH TOKENS — a bearer is only ever a row", async () => {
  const { db, store } = await provisioned();
  const before = store.sessionKey();
  db.prepare(`INSERT INTO publish_tokens (token_hash, label, created_at) VALUES (?,?,?)`)
    .run("aaa", "ci", "2026-01-01T00:00:00.000Z");
  db.prepare(`INSERT INTO publish_tokens (token_hash, label, created_at) VALUES (?,?,?)`)
    .run("bbb", "laptop", "2026-01-01T00:00:00.000Z");

  const out = await (await control(store, "rotate", { at: "2026-08-26T12:00:00.000Z" })).json();
  assert.equal(out.ok, true);
  assert.equal(out.publishTokensRevoked, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM publish_tokens`).get().n, 0);
  assert.match(store.sessionKey(), /^[0-9a-f]{64}$/);
  assert.notEqual(store.sessionKey(), before, "the signing key did not change");
  assert.equal(db.prepare(`SELECT rotated_at FROM signing_keys WHERE purpose='session'`).get().rotated_at,
    "2026-08-26T12:00:00.000Z");
});

test("⏳ ROTATE IS NOT A SESSION KILL YET, and this test is what will tell you it became one", () => {
  // A session cookie HMACs on the Worker-wide env.SESSION_SECRET, not on the workspace's own
  // key, so rotating the key invalidates nothing a browser is holding. The key has existed
  // per workspace since provisioning precisely so the swap is a read change rather than a
  // migration of every live session; making it belongs with putting this object on the
  // request path (B-cross-workspace-signin).
  //
  // ⚠️ WHEN THIS TEST FAILS, DO NOT DELETE IT — change it to assert the opposite, and change
  // `sessionsEnded: false` in rotate() at the same time. A rotate that silently starts or
  // stops ending sessions is the one an operator gets wrong under pressure.
  const worker = readSource("../src/_worker.js");
  const fn = worker.slice(worker.indexOf("async function userToken("));
  const bodyEnd = fn.indexOf("\n}");
  assert.match(fn.slice(0, bodyEnd), /env\.SESSION_SECRET/,
    "userToken no longer reads the Worker-wide secret — rotate may now be a session kill");
  assert.doesNotMatch(fn.slice(0, bodyEnd), /sessionKey|signing_keys/,
    "userToken reads the workspace's own key now");
});

test("rotate reports sessionsEnded: false rather than staying quiet about it", async () => {
  const { store } = await provisioned();
  const out = await (await control(store, "rotate", {})).json();
  assert.equal(out.sessionsEnded, false,
    "an operator responding to a compromise has to know the browsers are still signed in");
});

test("rotate is one transaction: a failure leaves BOTH halves untouched", async () => {
  const { db, store } = await provisioned();
  const key = store.sessionKey();
  db.prepare(`INSERT INTO publish_tokens (token_hash, label, created_at) VALUES ('aaa','ci','x')`).run();
  // Break the second half of the body and assert the first half rolled back with it.
  const realExec = store.sql.exec.bind(store.sql);
  let calls = 0;
  store.sql.exec = (stmt, ...p) => {
    if (/INSERT INTO signing_keys/i.test(stmt) && ++calls === 1) throw new Error("boom");
    return realExec(stmt, ...p);
  };
  assert.throws(() => store.rotate("2026-08-26T12:00:00.000Z"), /boom/);
  store.sql.exec = realExec;
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM publish_tokens`).get().n, 1,
    "the tokens were deleted by a rotate that did not finish");
  assert.equal(store.sessionKey(), key);
});

// ── delete ──────────────────────────────────────────────────────────────────────────

test("DELETE IS A TOMBSTONE — it erases nothing, and it says when it will", async () => {
  const { db, store } = await provisioned();
  const at = "2026-08-26T10:00:00.000Z";
  const out = await (await control(store, "delete", { at })).json();
  assert.equal(out.ok, true);
  assert.equal(out.deletedAt, at);
  assert.equal(out.purgeAfter, new Date(Date.parse(at) + DELETE_GRACE_MS).toISOString());

  // Everything is still here. That is what makes a regretted delete a support mail.
  assert.deepEqual(store.members().map((m) => m.email), [ADMIN]);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM quotas`).get().n > 0);
  const s = store.status();
  assert.equal(s.deleted, true);
  assert.equal(s.purgeAfter, out.purgeAfter);
  assert.equal(s.members, 1, "a tombstone erased the roster");
});

test("THE GRACE WINDOW IS THE ONE THE LIFECYCLE PAGE PROMISES CUSTOMERS", () => {
  // "gone from the service in 30 days, gone from the backups within 70". Three things carry
  // that number and they change on the same day or the platform is promising something it
  // does not do.
  assert.equal(DELETE_GRACE_MS, 30 * 24 * 60 * 60 * 1000);
  const src = readSource("../src/tenant-do.js");
  assert.match(src, /THIS NUMBER IS PUBLISHED/);
  assert.match(src, /F-tenant-delete-ux/);
  assert.match(src, /D-2-nightly-backup-worm/);
});

test("A DELETE SUSPENDS TOO, using the SAME flag rather than a second one", async () => {
  // Otherwise everything that must refuse a dead workspace needs two checks, and the second
  // check is the one somebody forgets.
  const { store } = await provisioned();
  await control(store, "delete", { at: "2026-08-26T10:00:00.000Z" });
  const s = store.status();
  assert.equal(s.suspended, true);
  assert.equal(s.suspendedReason, "deleted", "an operator cannot tell a tombstone from a suspension");
});

test("a delete revokes publish tokens, so a tombstoned workspace cannot be published to", async () => {
  const { db, store } = await provisioned();
  db.prepare(`INSERT INTO publish_tokens (token_hash, label, created_at) VALUES ('aaa','ci','x')`).run();
  await control(store, "delete", {});
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM publish_tokens`).get().n, 0);
});

test("RESUME REFUSES TO UNDELETE — a served workspace with a purge date behind it", async () => {
  const { store } = await provisioned();
  await control(store, "delete", {});
  const res = await control(store, "resume", {});
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, error: "deleted" });
  assert.equal(store.status().suspended, true);
});

test("deleting twice keeps the FIRST purge date, so a retry cannot extend the window", async () => {
  const { store } = await provisioned();
  const first = await (await control(store, "delete", { at: "2026-08-26T10:00:00.000Z" })).json();
  const again = await (await control(store, "delete", { at: "2026-09-26T10:00:00.000Z" })).json();
  assert.equal(again.changed, false);
  assert.equal(again.purgeAfter, first.purgeAfter);
});

// ── the door ────────────────────────────────────────────────────────────────────────

test("THE VERB LIST IS THE WHOLE SURFACE — anything else is a 404 that names itself", async () => {
  const { store } = await provisioned();
  for (const verb of ["readStorage", "sql", "members", "destroy", "state/import"]) {
    const res = await control(store, verb, {});
    assert.equal(res.status, 404, verb);
    const body = await res.json();
    assert.equal(body.error, "tenant-verb-not-allowed");
  }
});

test("⚠️ THE ENGINE'S VERB LIST AND THE CONTROL PLANE'S ARE THE SAME LIST", async () => {
  // Written twice because the repos cannot import each other. The seam was open: the control
  // plane POSTed /__control/<verb> and this object routed nothing of the sort, so every call
  // was a 404 nothing was watching for. This is what keeps the two copies in step from THIS
  // side; the control plane's own suite has the mirror of it.
  const cp = new URL("../../augur-control-plane/src/provisioning.js", import.meta.url);
  let theirs = null;
  try {
    const src = await import("node:fs").then((fs) => fs.readFileSync(cp, "utf8"));
    const block = src.slice(src.indexOf("TENANT_RPC = Object.freeze(["));
    theirs = [...block.slice(0, block.indexOf("]);")).matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  } catch {
    // The control plane is a separate repo and is not always checked out beside this one.
    // Skipping is correct; failing would make a clone of the engine alone fail its own suite.
    return;
  }
  assert.deepEqual([...CONTROL_VERBS].sort(), theirs.sort(),
    "the two verb lists have drifted — a control-plane call would 404 into this handler");
});

test("provision is the ONE verb allowed to create, and it needs both halves of an identity", async () => {
  const { store } = workspace();
  assert.equal((await control(store, "provision", { workspaceId: "acme" })).status, 400);
  assert.equal((await control(store, "provision", { adminEmail: ADMIN })).status, 400);
  const out = await (await control(store, "provision", { workspaceId: "acme", adminEmail: ADMIN })).json();
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(store.status().provisioned, true);
});

test("status is a GET's worth of work and needs no body", async () => {
  const { store } = await provisioned();
  const res = await control(store, "status", null, "GET");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).provisioned, true);
});

test("a verb sent with the wrong method is refused, not silently treated as a POST", async () => {
  const { store } = await provisioned();
  const res = await control(store, "suspend", null, "GET");
  assert.equal(res.status, 405);
});
