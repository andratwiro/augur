// A paused workspace stops serving, and keeps exactly two promises.
//
// `B-suspend-check-in-resolver`. `B-control-plane-verbs` put the flag in the workspace
// object; until this existed it was a fact recorded in a database that changed nothing
// anybody could see.
//
// ── ⚠️ THE PLAN ITEM'S VERIFY IS REFUTED BY WHAT WE PUBLISH TO CUSTOMERS ────────────
//
// The item says "confirm EVERY endpoint (page serving, /__publish/*, /__board, /__rt,
// /__asset) refuses". The hosted lifecycle page — later, more considered, and the thing
// customers are actually told — says under "What a suspension actually means":
//
//     What stops: the public site stops being served.
//     What keeps working: SIGNING IN — the owner and admins can always sign in.
//                         EXPORTING — a full export runs normally on a suspended workspace.
//                         "If your reason for coming back is to leave, you can."
//
// A suspension that closed the export would make that sentence false, and it is the sentence
// that makes a suspension a pause rather than a hostage-taking. So the allow list is the
// promise in code, and these tests are what keeps the two the same thing. The item's "EVERY
// endpoint" reading is deliberately NOT implemented, and this file is where that is recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
const { default: worker, __testables: W } = await import("../src/_worker.js");

const req = (path, { method = "GET", accept = "text/html" } = {}) =>
  new Request(`https://acme.example.com${path}`, { method, headers: { Accept: accept } });
const url = (path) => new URL(`https://acme.example.com${path}`);
const allowed = (path, opts) => W.isAllowedWhileSuspended(req(path, opts), url(path));

// ── what a suspension stops ─────────────────────────────────────────────────────────

test("THE PUBLIC SITE STOPS — pages, boards, assets, realtime, comments, publishing", () => {
  for (const path of [
    "/", "/some/prototype/", "/index.html",
    "/__board", "/__asset", "/__rt", "/__review/api", "/__status", "/__pins",
    "/__admin/tokens", "/__me/avatar", "/__canvases", "/__piti", "/__delete",
  ]) {
    assert.equal(allowed(path), false, `${path} still answered on a paused workspace`);
    assert.equal(allowed(path, { method: "POST" }), false, `POST ${path} still answered`);
  }
});

test("A WRITE TO THE BUNDLE STORE IS STOPPED even though reads are not", () => {
  // Taking your work out is not the same act as putting more in, and the second is what the
  // pause is for.
  for (const verb of ["commit", "check", "blob", "rollback"]) {
    assert.equal(allowed(`/__publish/delta/${verb}`, { method: "POST" }), false, verb);
  }
  // A read verb sent as a write is still a write.
  assert.equal(allowed("/__publish/delta/manifest", { method: "POST" }), false);
  assert.equal(allowed("/__publish/delta/blob/abc123", { method: "PUT" }), false);
});

test("the instance config push is stopped — it is how a deployment changes its own roster", () => {
  assert.equal(allowed("/__publish/_instance/config", { method: "POST" }), false);
});

// ── what a suspension keeps ─────────────────────────────────────────────────────────

test("SIGNING IN ALWAYS WORKS, because an admin has to be able to get in", () => {
  assert.equal(allowed("/__auth", { method: "POST" }), true);
  assert.equal(allowed("/__logout", { method: "POST" }), true);
});

test("A FULL EXPORT RUNS — the sentence that makes a pause a pause and not a hostage", () => {
  assert.equal(allowed("/__publish/_state/export"), true);
  for (const verb of ["manifest", "versions", "blob", "version"]) {
    assert.equal(allowed(`/__publish/delta/${verb}`), true, verb);
  }
  assert.equal(allowed("/__publish/delta/blob/deadbeef"), true, "the export walks blobs by hash");
  assert.equal(allowed("/__publish/delta/version/7"), true);
});

test("MINTING A PUBLISH TOKEN WORKS, or an admin who lost theirs cannot run the export", () => {
  // The export runs from the CLI on a publish token. Without this, "you can always leave"
  // holds only for somebody who still has the token they made before the pause.
  assert.equal(allowed("/__publish/_login/token", { method: "POST" }), true);
});

test("the allow list is short, and every entry is one of the two published promises", () => {
  assert.deepEqual([...W.SUSPENDED_ALLOWED], [
    "/__auth", "/__logout", "/__publish/_login/token", "/__publish/_state/export",
  ]);
  assert.deepEqual([...W.SUSPENDED_ALLOWED_READS], ["manifest", "versions", "version", "blob"]);
});

test("⚠️ THE STATE IMPORT IS NOT ON THE LIST — a restore INTO a paused workspace is a write", () => {
  // `/__publish/_state/export` and `/__publish/_state/import` differ by one word and by
  // everything else. The export is the promise; the import puts a whole roster back.
  assert.equal(allowed("/__publish/_state/import", { method: "POST" }), false);
  assert.equal(allowed("/__publish/_state/import"), false);
});

// ── the page ────────────────────────────────────────────────────────────────────────

test("A VISITOR GETS A PLAIN PAGE, not a 404 and not the last published content", () => {
  // Both wrong answers are named in the promise. A 404 says the address is wrong and sends
  // the wrong person hunting for a typo; the last published content is the thing a
  // suspension exists to stop serving.
  const res = W.suspensionPage();
  assert.equal(res.status, 503);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("Retry-After"), "3600");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("⚠️ THE STRANGER'S PAGE NAMES NOTHING — not the workspace, not the reason", async () => {
  // A suspension can be an acceptable-use takedown. "Paused for breaking the rules" on a
  // public page is a punishment nobody decided to hand out.
  const paused = { suspended: true, reason: "aup: phishing page", at: "2026-08-26T10:00:00.000Z" };
  const body = await W.suspensionPage(paused, false).text();
  for (const word of ["aup", "phishing", "abuse", "violation", "breach", "payment", "unpaid", "@", "2026"]) {
    assert.ok(!body.toLowerCase().includes(word), `the stranger's page says "${word}"`);
  }
  assert.match(body, /noindex/);
  assert.match(body, /paused/i);
  assert.match(body, /not gone/i);
});

test("⚠️ AND IT PROMISES NOTHING — the first version told strangers it was coming back", async () => {
  // "An admin can sign in and bring it back" is true of a dormancy pause and FALSE of an
  // acceptable-use one and of a tombstone. A stranger was being told a workspace was
  // returning when nobody had decided that. What is left is the one thing true in every
  // case: it is paused, and it is not gone.
  const t = await W.suspensionPage({ suspended: true, reason: "deleted", deleted: true }, false).text();
  assert.ok(!/bring it back/i.test(t), "the stranger's page promises a return");
  assert.ok(!/sign in/i.test(t), "the stranger's page tells a stranger to sign in");
  // "Nothing has been deleted" is the one use of the word that is allowed, and it is true
  // for the whole grace window. What must not appear is that this one IS a deletion.
  assert.ok(!/is deleted|was deleted|erased/i.test(t), "the stranger's page reveals a tombstone");
  assert.match(t, /nothing has been deleted/i);
});

// ── what a MEMBER sees ──────────────────────────────────────────────────────────────

test("A MEMBER SEES THE REASON, the date, and the one thing that is true in every case", async () => {
  // `F-suspended-instance-page`. Somebody who can prove they belong here is the person the
  // reason is for.
  const body = await W.suspensionPage({
    suspended: true, reason: "aup: phishing page", at: "2026-08-26T10:00:00.000Z", deleted: false,
  }, true).text();
  assert.match(body, /aup: phishing page/);
  assert.match(body, /2026-08-26/);
  assert.match(body, /augur export --full/, "the export promise has no other surface");
  assert.match(body, /nothing has been erased/i);
  // It does not invent a procedure: how a workspace comes back depends on why it went, and
  // only whoever paused it can say.
  assert.ok(!/support@|contact us|write to us/i.test(body));
});

test("a MEMBER of a tombstoned workspace is told the erasure date, which a stranger is not", async () => {
  const p = {
    suspended: true, reason: "deleted", at: "2026-08-26T10:00:00.000Z",
    deleted: true, purgeAfter: "2026-09-25T12:00:00.000Z",
  };
  const mine = await W.suspensionPage(p, true).text();
  assert.match(mine, /deleted/i);
  assert.match(mine, /2026-09-25/, "the erasure date is the number that matters");
  assert.match(mine, /augur export --full/, "you can still leave with your work");
  const theirs = await W.suspensionPage(p, false).text();
  assert.ok(!theirs.includes("2026-09-25"));
});

test("the operator's reason is ESCAPED — it is not a stranger's input, and that is not the test", async () => {
  const body = await W.suspensionPage({
    suspended: true, reason: `<img src=x onerror="alert(1)">`, at: "2026-08-26T10:00:00.000Z",
  }, true).text();
  assert.ok(!body.includes("<img"), "operator text was interpolated raw");
  assert.match(body, /&lt;img/);
});

test("a member page with no reason recorded still renders, without an empty row", async () => {
  const body = await W.suspensionPage({ suspended: true }, true).text();
  assert.match(body, /paused/i);
  assert.ok(!body.includes("<dt>Reason</dt>"));
});

test("THE MEMBER CHECK IS NOT AN AUTHORIZATION DECISION, and the cookie gate is cheap", () => {
  // Nothing is unlocked by answering yes; the only difference is whether a 503 states a
  // reason. So the expensive question is asked only when a cookie is actually present, and
  // a stranger, a crawler and a link in a chat cost a paused workspace nothing.
  const withCookie = new Request("https://x.test/", {
    headers: { Cookie: "__Host-augur_user=someone.abc" },
  });
  assert.equal(W.hasSessionCookie(withCookie), true);
  assert.equal(W.hasSessionCookie(new Request("https://x.test/")), false);
  assert.equal(W.hasSessionCookie(new Request("https://x.test/", { headers: { Cookie: "theme=dark" } })), false);
  // ⏳ A legacy cookie name still counts — a member mid-rename is still a member.
  assert.equal(W.hasSessionCookie(new Request("https://x.test/", { headers: { Cookie: "gv_user=x.y" } })), true);
});

test("a machine caller gets JSON, because a CLI reading a holding page as a manifest is worse", async () => {
  assert.equal(W.wantsJson(req("/__publish/delta/manifest", { accept: "*/*" }), url("/__publish/delta/manifest")), true);
  assert.equal(W.wantsJson(req("/", { accept: "*/*" }), url("/")), true);
  assert.equal(W.wantsJson(req("/", { accept: "text/html,application/xhtml+xml" }), url("/")), false);
  // Every /__ route is machinery, whatever it says it accepts.
  assert.equal(W.wantsJson(req("/__board", { accept: "text/html" }), url("/__board")), true);
  const body = await W.suspensionRefusal().json();
  assert.equal(body.error, "suspended");
  assert.match(body.message, /export/);
});

// ── reading the flag ────────────────────────────────────────────────────────────────

const stubEnv = (answer, { throws = false } = {}) => {
  let calls = 0;
  return {
    calls: () => calls,
    env: {
      TENANTS: {
        idFromName: (n) => n,
        get: () => ({
          fetch: async () => {
            calls++;
            if (throws) throw new Error("do unreachable");
            return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
          },
        }),
      },
    },
  };
};

test("A SINGLE-WORKSPACE INSTANCE PAYS NOTHING — no binding, no question", async () => {
  assert.equal(await W.readSuspension("delta", {}), null);
  assert.equal(await W.readSuspension("delta", { TENANTS: null }), null);
});

test("a live workspace reads as null, and the answer is cached rather than re-asked", async () => {
  const s = stubEnv({ suspended: false });
  const t0 = 1_700_000_000_000;
  assert.equal(await W.readSuspension("live-1", s.env, t0), null);
  assert.equal(await W.readSuspension("live-1", s.env, t0 + W.SUSPENSION_TTL_MS - 1), null);
  assert.equal(s.calls(), 1, "the flag was re-read inside its TTL");
});

test("a suspended workspace reads back with its reason", async () => {
  const s = stubEnv({ suspended: true, reason: "aup", at: "2026-08-26T10:00:00.000Z", deleted: false });
  const out = await W.readSuspension("paused-1", s.env);
  assert.equal(out.suspended, true);
  assert.equal(out.reason, "aup");
});

test("⚠️ IT FAILS CLOSED — an isolate that has NEVER read the flag refuses", async () => {
  // The opposite of every other degradation in the worker, and deliberately. A workspace can
  // be paused because it is serving a phishing page; "the store was unreachable for a
  // moment" is not a reason to serve it again. `undefined` is the never-read answer, and the
  // router treats it exactly like a suspension.
  const s = stubEnv(null, { throws: true });
  assert.equal(await W.readSuspension("cold-1", s.env), undefined,
    "an unreadable flag answered 'not suspended'");
});

test("A STALE ANSWER IS KEPT — a resume one tick late costs nothing, a gap does not", async () => {
  let calls = 0;
  const env = {
    TENANTS: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => {
          calls++;
          if (calls === 1) return new Response(JSON.stringify({ suspended: true, reason: "aup" }));
          throw new Error("do unreachable");
        },
      }),
    },
  };
  const t0 = 1_700_000_000_000;
  assert.equal((await W.readSuspension("stale-1", env, t0)).suspended, true);
  // PAST the TTL, so the refresh really is attempted — and it throws. Without the clock this
  // test passes without ever making a second call, which is the shape of a test that proves
  // nothing.
  const again = await W.readSuspension("stale-1", env, t0 + W.SUSPENSION_TTL_MS + 1);
  assert.equal(calls, 2, "the refresh was never attempted, so nothing was proved");
  assert.equal(again.suspended, true, "a failed refresh un-paused the workspace");
});

test("and a resume is picked up once the TTL is past", async () => {
  let calls = 0;
  const env = {
    TENANTS: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => new Response(JSON.stringify(
          ++calls === 1 ? { suspended: true, reason: "aup" } : { suspended: false })),
      }),
    },
  };
  const t0 = 1_700_000_000_000;
  assert.equal((await W.readSuspension("resume-1", env, t0)).suspended, true);
  // Inside the TTL the cached suspension stands, even though the object has already resumed.
  assert.equal((await W.readSuspension("resume-1", env, t0 + 1)).suspended, true);
  assert.equal(calls, 1);
  // Past it, the resume lands. That bound — SUSPENSION_TTL_MS — is how long "within the
  // resolver's cache TTL" is, and it is the number to quote to anybody who has just resumed
  // a workspace and is refreshing the page.
  assert.equal(await W.readSuspension("resume-1", env, t0 + W.SUSPENSION_TTL_MS + 1), null);
  assert.equal(calls, 2);
});

test("one workspace's suspension is not another's", async () => {
  const env = {
    TENANTS: {
      idFromName: (n) => n,
      get: (n) => ({
        fetch: async () => new Response(JSON.stringify(
          n === "paused-2" ? { suspended: true, reason: "aup" } : { suspended: false })),
      }),
    },
  };
  assert.ok((await W.readSuspension("paused-2", env)).suspended);
  assert.equal(await W.readSuspension("live-2", env), null);
});

// ── through the real worker ─────────────────────────────────────────────────────────
//
// The unit tests above prove the list and the reader. This proves the WIRING: that the
// check runs where it is supposed to, which is before the config load, so a paused
// workspace does not read its own store to find out it is paused.

const suspendedEnv = (answer) => ({
  TENANTS: {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => new Response(JSON.stringify(answer)) }),
  },
  // Deliberately NOTHING else. A request that reached the config load would fail here
  // rather than quietly succeeding, which is how this test knows the check runs first.
});

test("THE ROUTER REFUSES A PAUSED WORKSPACE BEFORE IT READS ANY CONFIG AT ALL", async () => {
  const env = suspendedEnv({ suspended: true, reason: "aup", at: "2026-08-26T10:00:00.000Z" });
  for (const path of ["/", "/some/prototype/", "/__board"]) {
    W.__setTenantTestState({ memo: { at: Date.now(), tenantId: `wired-${path.length}` } });
    const res = await worker.fetch(new Request(`https://x.test${path}`, {
      headers: { Accept: "text/html" },
    }), env, { waitUntil() {} });
    assert.equal(res.status, 503, path);
    const body = await res.text();
    if (path.startsWith("/__")) {
      assert.match(body, /"error":"suspended"/, path);
    } else {
      assert.match(body, /paused/i, path);
      assert.match(body, /noindex/, path);
    }
  }
});

test("A COOKIE THAT PROVES NOTHING GETS THE STRANGER'S PAGE — the check fails to no", async () => {
  // Nothing is unlocked by the member check, so every uncertainty resolves to "stranger":
  // no config, no roster, an unreadable store, a cookie that names nobody. This fixture has
  // a TENANTS binding and no store at all, and the page must still render rather than throw.
  const env = suspendedEnv({ suspended: true, reason: "aup", at: "2026-08-26T10:00:00.000Z" });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: "wired-cookie" } });
  const res = await worker.fetch(new Request("https://x.test/", {
    headers: { Accept: "text/html", Cookie: "__Host-augur_user=nobody@example.test.deadbeef" },
  }), env, { waitUntil() {} });
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.ok(!body.includes("aup"), "an unverified cookie was shown the reason");
  assert.match(body, /paused/i);
});

test("A LIVE WORKSPACE IS NOT AFFECTED — the check answers no and the request carries on", async () => {
  const env = suspendedEnv({ suspended: false });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: "wired-live" } });
  // This env has a TENANTS binding and NOTHING ELSE, so a request that gets past the
  // suspension check dies in the config load. That failure IS the assertion: the workspace
  // was not paused, so the request carried on into machinery this fixture does not provide.
  const out = await worker.fetch(new Request("https://x.test/", {
    headers: { Accept: "text/html" },
  }), env, { waitUntil() {} }).catch((e) => e);
  assert.ok(out instanceof Error, `a live workspace was answered with ${out.status}`);
});

test("⚠️ AN UNREADABLE FLAG REFUSES — the fail-closed path, through the router", async () => {
  const env = {
    TENANTS: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => { throw new Error("do unreachable"); } }),
    },
  };
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: "wired-cold" } });
  const res = await worker.fetch(new Request("https://x.test/", {
    headers: { Accept: "text/html" },
  }), env, { waitUntil() {} });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /paused/i);
});

test("and a single-workspace instance never takes the branch at all", async () => {
  // No TENANTS binding — every self-hosted instance and both live ones. Same shape as
  // above: it goes straight past into the config load, so nothing was asked and nothing
  // was cached.
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: "wired-static" } });
  const out = await worker.fetch(new Request("https://x.test/", {
    headers: { Accept: "text/html" },
  }), {}, { waitUntil() {} }).catch((e) => e);
  assert.ok(out instanceof Error, `a static instance was answered with ${out.status}`);
});
