// What a person is shown before a workspace is deleted, and whether the window it states is
// the window the platform actually keeps.
//
// `F-tenant-delete-ux`. Two halves, and they are the item's two acceptance clauses.
//
// THE COPY. Every number on the confirmation is derived from `DELETE_GRACE_MS` — the grace
// the tombstone really uses — rather than typed beside it. A typed number is right on the
// day somebody types it and silently wrong from the next time the constant moves, and a
// confirmation screen is the last surface anyone thinks to check. So the tests below change
// the grace and assert the copy moves with it, which is the only way to tell a derived
// number from a coincidence.
//
// THE WINDOW. A stated window is worth exactly what the erasure honours. So the second half
// drives the real lifecycle: delete, then try to erase INSIDE the window (refused, and the
// data is still all there and still restorable), then move past the date and try again
// (erased, and every attempt to get it back afterwards fails by name rather than by crash).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __testables as W } from "../src/_worker.js";
import { TenantStore, DELETE_GRACE_MS } from "../src/tenant-do.js";
import {
  deleteConfirmation, retentionWindow, retentionClause,
  backupRetentionFromEnv, EXPORT_COMMAND,
} from "../src/delete-confirmation.mjs";

const DAY = 24 * 60 * 60 * 1000;

// The rotation the published policy is written against: thirty days tombstoned, forty more
// before the last backup holding it expires.
const BACKUP_TAIL_MS = 40 * DAY;

function memR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async head(k) { return store.has(k) ? { etag: "e" } : null; },
    async get(k) {
      if (!store.has(k)) return null;
      const o = store.get(k);
      return { body: o, etag: "e", text: async () => o };
    },
    async put(k, v) { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", delimiter, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const prefixes = new Set();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
        }
        return { objects: [], delimitedPrefixes: [...prefixes], truncated: false };
      }
      return { objects: keys.map((key) => ({ key })), truncated: false, cursor };
    },
  };
}

function namespace(env = {}) {
  const objects = new Map();
  return {
    objects,
    idFromName(name) { return { name }; },
    get(id) {
      if (!objects.has(id.name)) {
        const db = new DatabaseSync(":memory:");
        const sql = {
          exec(stmt, ...params) {
            if (params.length) return db.prepare(stmt).all(...params);
            if (/^\s*SELECT/i.test(stmt)) return db.prepare(stmt).all();
            db.exec(stmt);
            return [];
          },
        };
        objects.set(id.name, new TenantStore({
          storage: {
            sql,
            transactionSync(cb) {
              db.exec("BEGIN");
              try { const o = cb(); db.exec("COMMIT"); return o; }
              catch (e) { db.exec("ROLLBACK"); throw e; }
            },
          },
          blockConcurrencyWhile: async (f) => f(),
        }, env));
      }
      const store = objects.get(id.name);
      return { id, store, fetch: (u, init) => store.fetch(new Request(u, init)) };
    },
  };
}

const manifest = (id, version = 3) => JSON.stringify({
  id, version, format: 1,
  files: { "/p/0.html": { h: "a".repeat(64), ct: "text/html", s: 10 } },
  routing: { publicPrefixes: ["/p/"], unitSources: { "/p/": { sha: "abc", dirty: false } } },
  publishedAt: "2026-08-20T00:00:00.000Z",
});

const ctxFor = (id) => Object.freeze({ ...W.applyInstance({ users: [] }), tenantId: id });

function instance({ doEnv = {} } = {}) {
  return {
    BUNDLES: memR2({
      "spaces/a/manifest.json": manifest("a"),
      "spaces/a/versions/3.json": manifest("a"),
      [`blobs/${"a".repeat(64)}`]: "page",
    }),
    TENANTS: namespace(doEnv),
  };
}

const control = (env, id, verb, init) =>
  env.TENANTS.get(env.TENANTS.idFromName(id)).fetch(`https://workspace/__control/${verb}`, init);

// ── the copy ────────────────────────────────────────────────────────────────────────

test("THE WINDOW THE SCREEN STATES IS THE WINDOW THE TOMBSTONE WRITES", async () => {
  // One arithmetic, one instant. A screen with its own clock agrees with the delete every
  // day but the one where the two readings straddle midnight, and that is the day somebody
  // is told the wrong date for an erasure that cannot be undone.
  const env = instance();
  const at = "2026-08-26T23:59:30.000Z";
  await env.TENANTS.get(env.TENANTS.idFromName("a")).store
    .provision({ workspaceId: "a", adminEmail: "a@x.test" });

  const shown = await (await control(env, "a", `delete?at=${encodeURIComponent(at)}`)).json();
  const done = await (await control(env, "a", "delete", {
    method: "POST", body: JSON.stringify({ at }),
  })).json();

  assert.equal(shown.retention.erasedOn, done.purgeAfter);
  assert.equal(done.purgeAfter, new Date(Date.parse(at) + DELETE_GRACE_MS).toISOString());
});

test("BYTE-IDENTICAL TO THE PUBLISHED PROMISE, once a backup rotation is declared", () => {
  // The lifecycle policy's own sentence: "gone from the service in 30 days, gone from the
  // backups within 70". A confirmation that paraphrases it is a second policy, and the
  // second one is the one nobody updates. Rebuilt from the live numbers instead.
  const w = retentionWindow({ graceMs: DELETE_GRACE_MS, backupRetentionMs: BACKUP_TAIL_MS });
  assert.equal(retentionClause(w), "gone from the service in 30 days, gone from the backups within 70");
  const c = deleteConfirmation({
    workspaceId: "a", graceMs: DELETE_GRACE_MS, backupRetentionMs: BACKUP_TAIL_MS,
  });
  assert.equal(c.retention.summary, "Gone from the service in 30 days, gone from the backups within 70.");
  assert.equal(c.retention.serviceDays, 30);
  assert.equal(c.retention.backupDays, 70);
});

test("THE NUMBERS ARE DERIVED, NOT TYPED — move the grace and the whole screen moves", () => {
  // The only way to tell a derived number from a lucky literal: change the input and look
  // for the old one anywhere in the output.
  const c = deleteConfirmation({
    workspaceId: "a", graceMs: 3 * DAY, backupRetentionMs: 4 * DAY,
    // A fixed instant whose erasure date carries neither number, so the sweep below reads
    // the copy rather than the calendar.
    at: Date.parse("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(c.retention.erasedOn, "2026-01-04T00:00:00.000Z");
  assert.equal(c.retention.serviceDays, 3);
  assert.equal(c.retention.backupDays, 7);
  assert.equal(c.retention.clause, "gone from the service in 3 days, gone from the backups within 7");
  // And the timeline says it too, not just the summary line.
  assert.equal(c.timeline[1].when, "For 3 days");
  assert.equal(c.timeline[3].when, "Within 4 further days");
  // Every WORD on the screen, swept for the number that would have been typed. The machine
  // fields are excluded on purpose and only those two: `graceMs` is the input, and a
  // calendar date is allowed to contain any digits it likes — an erasure that falls on the
  // 30th is not a hard-coded 30, and asserting over the ISO string would fail on the
  // calendar rather than on the copy.
  const prose = [
    c.title, c.holdsLine || "", c.retention.clause, c.retention.summary,
    ...c.steps.flatMap((s) => [s.title, s.body]),
    ...c.timeline.flatMap((t) => [t.when, t.what]),
  ].join(" | ");
  assert.ok(!/\b30\b/.test(prose), `a hard-coded 30 survived: ${prose}`);
  assert.ok(!/\b70\b/.test(prose), `a hard-coded 70 survived: ${prose}`);
});

test("IT NEVER INVENTS THE BACKUP NUMBER — an undeclared rotation is stated, not guessed", () => {
  // The engine writes the tombstone date itself, so it knows that half exactly. It cannot
  // know a deployment's off-site rotation. Inventing one promises a schedule nothing runs;
  // omitting the backups entirely tells a customer their data is gone everywhere while a
  // copy still holds it. Absent is a fact and the copy states it as one.
  const c = deleteConfirmation({ workspaceId: "a", graceMs: DELETE_GRACE_MS });
  assert.equal(c.retention.backupDays, null);
  assert.equal(c.retention.clause, "gone from the service in 30 days");
  const tail = c.timeline[3];
  assert.match(tail.what, /backup copy can outlive the erasure/);
  assert.ok(!/\d/.test(tail.what), `a period was invented for an undeclared rotation: ${tail.what}`);
});

test("THE EXPORT NUDGE COMES BEFORE THE CONFIRM, and it is the whole first step", () => {
  // The only copy that survives a delete is the one somebody took first. A nudge sharing a
  // row with the button that deletes is a nudge nobody reads, so the order is the feature.
  const c = deleteConfirmation({ workspaceId: "acme", graceMs: DELETE_GRACE_MS });
  assert.deepEqual(c.steps.map((s) => s.id), ["export", "confirm"]);
  assert.equal(c.steps[0].command, EXPORT_COMMAND);
  assert.equal(c.steps[0].command, "augur export --full");
  assert.equal(c.steps[0].path, "/__publish/_state/export");
  assert.match(c.steps[0].body, /before you confirm/);
  assert.equal(c.steps[1].confirmWith, "acme", "the confirm does not name the workspace to type");
});

test("a declared rotation is read from the deployment, and every wrong shape reads as absent", () => {
  // ⚠️ Fails to null, never to a number: a default here is the invented promise this module
  // exists to refuse.
  assert.equal(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: "40" }), 40 * DAY);
  assert.equal(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: 40 }), 40 * DAY);
  assert.equal(backupRetentionFromEnv({}), null);
  assert.equal(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: "" }), null);
  assert.equal(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: "soon" }), null);
  assert.equal(backupRetentionFromEnv({ BACKUP_RETENTION_DAYS: "-1" }), null);
  assert.equal(backupRetentionFromEnv(null), null);
});

test("a confirmation states no window it cannot compute", () => {
  assert.throws(() => deleteConfirmation({ workspaceId: "a" }), /graceMs is required/);
  assert.throws(() => retentionWindow({ graceMs: "30" }), /graceMs is required/);
});

// ── the confirmation as a read on the verb ──────────────────────────────────────────

test("THE DEPLOYMENT'S OWN ROTATION REACHES THE SCREEN THROUGH THE OBJECT", async () => {
  const env = instance({ doEnv: { BACKUP_RETENTION_DAYS: "40" } });
  await env.TENANTS.get(env.TENANTS.idFromName("a")).store
    .provision({ workspaceId: "a", adminEmail: "a@x.test" });
  const c = await (await control(env, "a", "delete")).json();
  assert.equal(c.retention.clause, "gone from the service in 30 days, gone from the backups within 70");
  assert.equal(c.workspace, "a");
});

test("ASKING WHAT A DELETE WOULD COST MUST NOT BRING A WORKSPACE INTO BEING", async () => {
  // `status()`'s rule, and for its reason: the name comes from a URL somebody typed.
  const env = instance();
  const res = await control(env, "typo", "delete");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, error: "not-provisioned" });
  assert.deepEqual(env.TENANTS.get(env.TENANTS.idFromName("typo")).store.status(),
    { provisioned: false, hasStoredData: false });
});

test("a second look at an ALREADY-DELETED workspace does not offer a fresh window", async () => {
  // Re-deleting does not restart the clock, so a screen showing a new date would be lying
  // about arithmetic that has already happened.
  const env = instance();
  await env.TENANTS.get(env.TENANTS.idFromName("a")).store
    .provision({ workspaceId: "a", adminEmail: "a@x.test" });
  const at = "2026-08-26T10:00:00.000Z";
  const done = await (await control(env, "a", "delete", {
    method: "POST", body: JSON.stringify({ at }),
  })).json();

  const c = await (await control(env, "a", "delete")).json();
  assert.equal(c.alreadyDeleted, true);
  assert.equal(c.retention.erasedOn, done.purgeAfter, "the window restarted on a second look");
  assert.equal(c.steps[1].confirmWith, null);
  assert.match(c.steps[0].body, /still runs on a deleted workspace/);
});

test("the confirmation names what is there, in counts and never in content", async () => {
  const env = instance();
  await env.TENANTS.get(env.TENANTS.idFromName("a")).store
    .provision({ workspaceId: "a", adminEmail: "a@x.test" });
  const c = await (await control(env, "a", "delete")).json();
  assert.deepEqual(c.holds, ["1 person"]);
  assert.equal(c.holdsLine, "1 person");
  assert.ok(!JSON.stringify(c).includes("a@x.test"), "an address reached an operator-facing screen");
});

// ── the window, honoured ────────────────────────────────────────────────────────────

test("INSIDE THE STATED WINDOW: the erasure refuses, and the workspace is still restorable", async () => {
  const env = instance();
  const ns = env.TENANTS;
  await ns.get(ns.idFromName("a")).store.provision({ workspaceId: "a", adminEmail: "a@x.test" });
  await ns.get(ns.idFromName("spare")).store.provision({ workspaceId: "spare", adminEmail: "s@x.test" });
  // Something a person made, so "restorable" is a claim about work rather than about an
  // empty schema.
  await W.importState(ctxFor("a"), env, {
    format: 1,
    families: { statuses: { "/p/": "reviewed" }, "c:": { "/p/": [{ id: "t1", msgs: [{ id: "m1", text: "hi" }] }] } },
  });

  // Delete now, so the purge date is a real DELETE_GRACE_MS in the future.
  const done = await (await control(env, "a", "delete", { method: "POST", body: "{}" })).json();
  assert.equal(done.ok, true);
  const shown = await (await control(env, "a", "delete")).json();
  assert.equal(shown.retention.erasedOn, done.purgeAfter);
  assert.ok(Date.parse(done.purgeAfter) > Date.now());

  // The erasure asks the workspace whether it agrees it is due. It does not.
  const erase = await W.deleteWorkspace(ctxFor("a"), env, { confirm: "a", dryRun: false });
  assert.equal(erase.ok, false);
  assert.equal(erase.reason, "grace-window");
  assert.equal(erase.purgeAfter, done.purgeAfter);

  // Nothing was taken: the published prefix and the object's own record are both intact.
  assert.ok(env.BUNDLES.store.has("spaces/a/manifest.json"));
  assert.ok(env.BUNDLES.store.has("spaces/a/versions/3.json"));
  assert.equal(ns.get(ns.idFromName("a")).store.status().members, 1);

  // And a copy taken inside the window puts the workspace back. This is what "recoverable
  // for the stated window" has to mean to be worth stating.
  const copy = await W.exportState(ctxFor("a"), env);
  assert.deepEqual(copy.failed, [], "the export of a tombstoned workspace was incomplete");
  assert.deepEqual(copy.families["c:"], { "/p/": [{ id: "t1", msgs: [{ id: "m1", text: "hi" }] }] });
  assert.deepEqual(copy.families.statuses, { "/p/": "reviewed" });

  const back = await W.importState(ctxFor("spare"), env, copy);
  assert.equal(back.ok, true, JSON.stringify(back));
  const recovered = await W.exportState(ctxFor("spare"), env);
  assert.deepEqual(recovered.families["c:"], copy.families["c:"]);
  assert.deepEqual(recovered.families.statuses, copy.families.statuses);
});

test("PAST THE STATED DATE: the erasure runs, and every way back fails by name", async () => {
  const env = instance();
  const ns = env.TENANTS;
  await ns.get(ns.idFromName("a")).store.provision({ workspaceId: "a", adminEmail: "a@x.test" });
  await W.importState(ctxFor("a"), env, {
    format: 1,
    families: { statuses: { "/p/": "reviewed" }, "c:": { "/p/": [{ id: "t1", msgs: [{ id: "m1", text: "hi" }] }] } },
  });

  // The same delete, read from the far side of its own window. `graceMs: 0` on a past
  // instant puts the purge date behind us without touching the clock — the object still
  // wrote the date, which is the half of the two-key check the caller cannot forge.
  ns.get(ns.idFromName("a")).store.deleteWorkspace("2026-01-01T00:00:00.000Z", 0);

  const erase = await W.deleteWorkspace(ctxFor("a"), env, { confirm: "a", dryRun: false });
  assert.equal(erase.ok, true, JSON.stringify(erase));
  assert.deepEqual([...env.BUNDLES.store.keys()].filter((k) => k.startsWith("spaces/a/")), []);
  assert.deepEqual(ns.get(ns.idFromName("a")).store.status(),
    { provisioned: false, hasStoredData: false });

  // Every route back is a NAMED refusal, not a crash and not an empty success. An erasure
  // that answered 200-with-nothing would read to a restore script as "restored".
  const again = await control(env, "a", "delete");
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { ok: false, error: "not-provisioned" });

  const resume = await control(env, "a", "resume", { method: "POST", body: "{}" });
  assert.equal(resume.status, 404);
  assert.deepEqual(await resume.json(), { ok: false, error: "not-provisioned" });

  const retry = await W.deleteWorkspace(ctxFor("a"), env, { confirm: "a", dryRun: false });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "not-tombstoned");

  // And there is nothing left to take a copy of, so a restore has no source.
  //
  // ⚠️ NOTE THE SHAPE OF THIS ONE. The read path does not refuse — it answers a WELL-FORMED
  // EMPTY document, because an erased workspace genuinely holds nothing and the export has
  // no "does this workspace exist" question to ask. That is safe as long as a restore stays
  // additive: putting an empty copy back writes nothing, since `clear` and `prune` are both
  // opt-in. It is worth knowing anyway, because a nightly backup taken the hour after an
  // erasure is a valid-looking copy of nothing.
  const copy = await W.exportState(ctxFor("a"), env);
  assert.deepEqual(copy.families["c:"], {}, "an erased workspace still handed back its comments");
  assert.deepEqual(copy.families.statuses, {}, "an erased workspace still handed back its statuses");
});
