// A workspace's address changed, and the old one is gone.
//
// `F-subdomain-rename-delete-ux`. A workspace address is the FIRST LABEL of the Host header
// and the resolver turns that label straight into the workspace object's name, with no
// lookup in between — so a workspace cannot hold two addresses at once and a rename is a
// CUT-OVER rather than a redirect. This file pins the cut-over half: what the old address
// answers afterwards, and that it answers nothing else.
//
// ── ⚠️ THE PROMISE THIS FILE ENFORCES, IN THE WORDS IT IS MADE IN ───────────────────
//
// The confirmation an admin sees before pressing the button says:
//
//     The current address stops working immediately. There is no forwarding and no
//     redirect: anyone who follows an old link gets a plain "not found", with nothing on
//     it — not this workspace's name, not its new address, not a word about either.
//     Nobody else will ever be given the old address, and nobody will be sent on to the
//     new one, so telling the people who need it is yours to do.
//
// Every sentence there is a test below. If the copy changes, these change the same day; if
// these change, the copy is wrong and somebody was told something untrue at the moment they
// were deciding.
//
// ── ⚠️ WHAT THE COPY DELIBERATELY DOES NOT SAY, AND WHY ─────────────────────────────
//
// An earlier draft promised "the same not-found a made-up address gets". That is FALSE, and
// the end-to-end rehearsal is what said so: a well-formed hostname nobody ever claimed
// resolves perfectly well — existence is not the resolver's question, on purpose — and is
// answered further down the handler, where an unreadable config is a 503. So the three
// classes are not one answer:
//
//     reserved / malformed hostname   → 404 "Not found\n"   (the resolver refuses)
//     an address renamed away from    → 404 "Not found\n"   (this file)
//     a name nobody ever claimed      → whatever the store answers, today a 503
//
// A moved address is therefore indistinguishable from a reserved one and distinguishable
// from a never-claimed one, which is a smaller tell than a redirect and is still a tell.
// Closing it means changing what a never-claimed hostname answers, which is the resolver's
// question and not this item's. The copy is written to be true of what is served rather
// than of what it resembles.
//
// ── WHY NOT A REDIRECT, WHICH IS THE OBVIOUS OTHER ANSWER ───────────────────────────
//
// The item leaves the choice open ("a clean redirect-then-404, or immediate 404 — pick one
// and say which"). Immediate 404, because an address here is GENERATED and unguessable, so
// the honest reason to change one is that it reached somebody it should not have — and a
// forwarder hands that person the new address, which undoes the change for the only person
// it was made for. The second reason is smaller and still real: "redirect now, 404 later" is
// two promises and the second is kept by a deploy nobody has scheduled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TenantStore, CONTROL_VERBS } from "../src/tenant-do.js";
import worker, { __testables as W } from "../src/_worker.js";

// ── the object half ─────────────────────────────────────────────────────────────────

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
  await w.store.provision({ workspaceId: "amber-heron-204", adminEmail: ADMIN });
  return w;
};
const control = (store, verb, body, method = "POST") =>
  store.fetch(new Request(`https://tenant.invalid/__control/${verb}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  }));

test("rename is a control verb, so the control plane can reach it at all", () => {
  assert.ok(CONTROL_VERBS.includes("rename"));
});

test("RENAMING AWAY DOES NOT CREATE A WORKSPACE — the property every verb shares", async () => {
  const { db, store } = workspace();
  const res = await control(store, "rename", { at: "2026-08-27T09:00:00.000Z" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, error: "not-provisioned" });
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ).all();
  assert.deepEqual(tables, [], "rename created storage on a name nobody provisioned");
});

test("a live workspace's address goes dark, and the object says when", async () => {
  const { store } = await provisioned();
  const res = await control(store, "rename", { at: "2026-08-27T09:00:00.000Z" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: true, movedAt: "2026-08-27T09:00:00.000Z" });
  assert.equal(store.suspension().moved, true);
  assert.equal(store.status().moved, true);
  assert.equal(store.status().movedAt, "2026-08-27T09:00:00.000Z");
});

test("it is IDEMPOTENT — a retried step cannot restate when the address went dark", async () => {
  const { store } = await provisioned();
  await control(store, "rename", { at: "2026-08-27T09:00:00.000Z" });
  const again = await control(store, "rename", { at: "2026-09-01T09:00:00.000Z" });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), {
    ok: true, changed: false, movedAt: "2026-08-27T09:00:00.000Z",
  });
});

test("⚠️ A TOMBSTONE CANNOT BE RENAMED AWAY — the grace page belongs to its members", async () => {
  // A deleted workspace shows its members a page with the erasure date on it for thirty
  // days. A bare 404 in its place takes that page away from exactly the people the grace
  // window exists for, and it is the page somebody notices a mistaken delete on.
  const { store } = await provisioned();
  await control(store, "delete", { at: "2026-08-27T09:00:00.000Z" });
  const res = await control(store, "rename", { at: "2026-08-27T10:00:00.000Z" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, error: "deleted" });
  assert.equal(store.suspension().moved, false, "a refused rename still marked the address");
});

test("⚠️ IT REVOKES NOTHING — this object still holds the only copy of the workspace", async () => {
  // Taking away the credential an export runs on at the moment the address goes dark is the
  // trap SUSPENDED_ALLOWED exists to avoid, one step worse: here the data has not moved yet.
  const { db, store } = await provisioned();
  db.prepare(`INSERT INTO publish_tokens (token_hash, label, created_at, expires_at)
              VALUES (?, ?, ?, ?)`).run("hash-1", "ci", "2026-08-01T00:00:00.000Z", null);
  await control(store, "rename", { at: "2026-08-27T09:00:00.000Z" });
  const left = db.prepare(`SELECT COUNT(*) AS n FROM publish_tokens`).get();
  assert.equal(Number(left.n), 1, "the rename revoked a publish token");
  assert.equal(store.status().members, 1, "the rename touched the roster");
});

test("⚠️ THE OLD OBJECT DOES NOT RECORD WHERE THE WORKSPACE WENT", async () => {
  // The point of the whole design. A forwarding pointer stored here is one field away from
  // being served, and the day it is served the change has undone itself for the person it
  // was made to get away from. A caller that sends one is not obeyed and is not humoured.
  const { db, store } = await provisioned();
  await control(store, "rename", { at: "2026-08-27T09:00:00.000Z", to: "silver-otter-771" });
  const meta = db.prepare(`SELECT k, v FROM meta`).all();
  const dump = JSON.stringify(meta) + JSON.stringify(store.status()) + JSON.stringify(store.suspension());
  assert.ok(!dump.includes("silver-otter-771"), "the new address is stored on the old object");
});

// ── the front-door half ─────────────────────────────────────────────────────────────

const SUFFIX = ".example.com";

/**
 * A namespace whose objects answer `/suspension` from a table keyed by label. Everything the
 * front door needs from a workspace object before the config load is that one answer.
 */
function namespace(answers) {
  const asked = [];
  return {
    asked,
    idFromName(name) { asked.push(name); return { name, toString: () => `id:${name}` }; },
    get(id) {
      return {
        async fetch(url) {
          if (String(url).endsWith("/suspension")) {
            const a = answers[id.name] || { suspended: false, deleted: false, moved: false };
            return new Response(JSON.stringify(a), {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      };
    },
  };
}

const hostReq = (host, path = "/", init = {}) =>
  new Request(`https://ignored.test${path}`, { ...init, headers: { host, ...(init.headers || {}) } });

const quietly = async (f) => {
  const log = console.log; console.log = () => {};
  try { return await f(); } finally { console.log = log; }
};

test("THE OLD ADDRESS GETS THE RESOLVER'S OWN REFUSAL — byte for byte, not a shape of its own", async () => {
  // "a plain 'not found', with nothing on it". Compared against the refusal a RESERVED
  // hostname gets, because a 404 of its own shape — a different body, a different header, a
  // Retry-After — would be a signature a prober could learn to read as "this one was real".
  let reads = 0;
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: namespace({ "amber-heron-204": { suspended: false, moved: true } }),
    ASSETS: { fetch: async () => { reads++; return new Response("{}", { headers: { "content-type": "application/json" } }); } },
  };
  await quietly(async () => {
    const moved = await worker.fetch(hostReq("amber-heron-204.example.com", "/"), env, {});
    // `www` is RESERVED, so this is the resolver's own refusal — the one answer on the
    // platform that is already given to a hostname naming no workspace.
    const nobody = await worker.fetch(hostReq("www.example.com", "/"), env, {});
    assert.equal(moved.status, 404);
    assert.equal(moved.status, nobody.status);
    assert.equal(await moved.clone().text(), "Not found\n");
    assert.equal(await moved.text(), await nobody.text());
    for (const h of ["content-type", "cache-control", "x-robots-tag"]) {
      assert.equal(moved.headers.get(h), nobody.headers.get(h), h);
    }
  });
  assert.equal(reads, 0, "a moved address read config, which is a hint that it exists");
});

test("THERE IS NO FORWARDING — no Location, and the new address is nowhere in the answer", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: namespace({
      "amber-heron-204": { suspended: false, moved: true },
      "silver-otter-771": { suspended: false, moved: false },
    }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  await quietly(async () => {
    const res = await worker.fetch(hostReq("amber-heron-204.example.com", "/deep/link/"), env, {});
    assert.equal(res.status, 404, "a redirect was served where the copy promised a 404");
    assert.equal(res.headers.get("location"), null);
    const body = await res.text();
    assert.ok(!body.includes("silver-otter-771"));
    assert.ok(!/moved|renamed|new address|redirect/i.test(body),
      "the refusal hints that the workspace moved");
  });
});

test("⚠️ NOTHING IS ALLOWED THROUGH — not sign-in, not the export, unlike a pause", async () => {
  // A suspension keeps four routes open because the workspace is still there and its members
  // may need to leave with their work. A moved address is not a pause: the workspace IS
  // still there, at its own address, and that is where its members sign in and export.
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: namespace({ "amber-heron-204": { suspended: false, moved: true } }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  await quietly(async () => {
    for (const [path, init] of [
      ["/__auth", { method: "POST" }],
      ["/__logout", { method: "POST" }],
      ["/__publish/_login/token", { method: "POST" }],
      ["/__publish/_state/export", {}],
      ["/__publish/acme/manifest", {}],
      ["/_build.json", {}],
    ]) {
      const res = await worker.fetch(hostReq("amber-heron-204.example.com", path, init), env, {});
      assert.equal(res.status, 404, `${path} still answered at a moved address`);
      assert.equal(await res.text(), "Not found\n", path);
    }
  });
});

test("the workspace's OWN address is untouched — the branch is about one label", async () => {
  const env = {
    TENANT_HOST_SUFFIX: SUFFIX,
    TENANTS: namespace({
      "amber-heron-204": { suspended: false, moved: true },
      "silver-otter-771": { suspended: false, moved: false },
    }),
    ASSETS: { fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) },
  };
  await quietly(async () => {
    const res = await worker.fetch(hostReq("silver-otter-771.example.com", "/"), env, {});
    assert.notEqual(res.status, 404, "the surviving address was refused too");
  });
});

test("a moved answer is CACHED, so the front door does not re-ask on every request", async () => {
  // `readSuspension` used to drop any doc that was not a suspension, which would have cached
  // "fine" for an address that is gone and re-read the object on every single request.
  let calls = 0;
  const env = {
    TENANTS: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify({ suspended: false, moved: true }));
        },
      }),
    },
  };
  const t0 = 1_700_000_000_000;
  const first = await W.readSuspension("moved-1", env, t0);
  assert.equal(first.moved, true);
  const second = await W.readSuspension("moved-1", env, t0 + W.SUSPENSION_TTL_MS - 1);
  assert.equal(second.moved, true);
  assert.equal(calls, 1, "the moved flag was re-read inside its TTL");
});
