# Drafts That Land — Slice 2 (Browser Surfaces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person in a browser can see who has drafts open (chips on gallery cards), look at a draft at its address with a bar naming whose it is and when it last saved, land or discard it from that bar, browse and restore the unit's landing history, and have their tab reload on each save (draft) or landing (main) without polling.

**Architecture:** Slice 1 left one credential (a bearer token) and no browser. This slice teaches `/__unit/<verb>` a second credential — the member's session cookie — so the draft bar lands with the same handler the CLI does; adds three read verbs (`drafts`, `draft`, `socket`); gives `UnitObject` a hibernating WebSocket it broadcasts `open`/`save`/`land`/`discard` on; keeps a workspace-wide *hint* of which units have open drafts in the existing overlay store so the gallery asks only the objects that matter; injects one script tag into a unit's HTML at serve time for signed-in members (`withDraftUi`); and ships two small client scripts — `DRAFTS_JS` in the chrome bundle for gallery chips, `src/drafts/drafts.js` served at `/__drafts/drafts.js` for the bar. The service worker learns that a draft address is never cached and that a page may ask it to evict one URL before reloading.

**Tech Stack:** Plain Node (no dependencies), Cloudflare Workers + Durable Objects (WebSocket Hibernation API), `node:test` + `node:sqlite`, the repo's existing build (`build.js`) for the chrome bundle and `sw.js`.

## Global Constraints

- Spec: `docs/drafts-that-land.md`. Read sections 3, 5, 6.2 and 6.3 before any task. Slice 1's plan (`docs/superpowers/plans/2026-09-04-drafts-that-land-slice-1.md`) established every file this slice modifies; read its File Structure table.
- **Zero product words.** The engine may not name another company's product or any workspace's private vocabulary. `npm run check` runs `scripts/no-product-names.mjs` and `scripts/no-foreign-vocabulary.mjs`; both must stay green. UI copy: no third-party product names, no pasteable agent prompts on screen.
- **Plain Node, no dependencies.** No new `package.json` dependencies.
- **Never `git add -A`.** Stage the paths you changed.
- **Unit paths** are URL prefixes with leading and trailing slash: `/checkout/flow/`. **Draft ids** are six lowercase base-36 characters (`DRAFT_ID_RE` in `src/unit-core.mjs`). A draft address is `<unit>@<id>/`.
- **The server never merges.** Nothing in this slice changes a save or a landing's decision; it only adds readers, a second credential and notifications.
- **Presence is derived** (`presenceOf`, active within five minutes). Chips show idle, never hide it.
- **A viewer may read and may not write.** Presence, history, the draft card and the socket are open to any signed-in member; land, discard and restore refuse the `viewer` role.
- **A socket carries no authority.** The worker authenticates before forwarding an Upgrade; the object stores nothing about a socket but its attachment and never waits on one.
- **`src/sw-logic.mjs` stays pure and import-free** — `build.js` concatenates its source into `sw.js` verbatim (minus `export`).
- **Module-scope state lint:** `scripts/no-tenant-globals.mjs` (run by `npm run check`) refuses a new module-scope binding in the worker's graph unless it is a primitive, a function, a keyed cache or an allowlisted frozen table. A new `Object.freeze([...])` needs one allowlist line with a reason, as `RESERVED_UNIT_FOLDERS` has.
- **Every overlay family is inventoried:** `test/identity-kv-tenancy.test.mjs` pins `OVERLAY_KV_KEYS` against `src/state-inventory.mjs`. A new family needs an inventory entry.
- **Node cannot build a 101 response.** `new Response(null, {status: 101})` throws in Node, so socket tests assert on `acceptWebSocket` having been reached (as `test/room-tickets.test.mjs` does), never on the 101.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test` before every commit; run `npm run check` before the last commit of each task.

## What this slice deliberately leaves out

- **The `?ds=<draft-id>` design-system overlay (spec §5, §8).** The spec calls the design system "one unit", but on disk and in the store it is several top-level folders (`tokens`, `base`, `components`, `patterns`, …), each currently in `RESERVED_UNIT_FOLDERS` so that no draft can be opened on it, and `unitApi` refuses any unit the manifest does not already declare in `publicPrefixes` — which the design system is not. Whether the design system becomes one unit spelled by a declared path set, or one unit per tier, is a product decision the design does not settle and this plan does not make. It is its own slice, after the product owner decides. Nothing here blocks it: the overlay is a serve-time table swap the same shape as draft-address serving.
- **Live updating of gallery chips over a socket.** Chips refresh on load, on visibility and once a minute. The spec asks for a socket on the *unit's* page, not the gallery.
- **Retiring working marks.** `MARKS_JS`, `/__marks` and the mark badge stay beside the new chips until slice 4 retires the whole publish path.
- **Tool adapters, contracts, derived pages, retirement** — slices 3–5 as listed in slice 1.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/sw-logic.mjs` (modify) | A draft address is `passthrough`, never stale-while-revalidate. |
| `src/unit-object.mjs` (modify) | `/socket` route (hibernating WebSocket), `emit` on `open`/`save`/`landed`/`discard`, the three hibernation handlers. |
| `src/_worker.js` (modify) | `unitCaller` (bearer **or** session cookie, viewer refused on writes); `personFace`/`decorateDrafts`/`decorateLandings`; verbs `drafts`, `draft`, `socket`; the `drafts` overlay family, `noteUnitDrafts`, `draftsIndexApi`; `withDraftUi` + `serveContent`; `/__drafts/` in `ENGINE_CHROME_PATHS`. |
| `src/state-inventory.mjs` (modify) | The `drafts` key entry. |
| `src/drafts/drafts.js` (new) | The draft bar: presence, Land, Discard, History + Restore, the socket, SW eviction. Self-contained, no chrome dependency. |
| `build.js` (modify) | Copy `src/drafts/drafts.js` → `dist/__drafts/drafts.js`; `ENGINE_CHROME` entry; `DRAFTS_JS` + `.draft-chip` CSS in the chrome bundle; `window.__gvFacesWire` export; the SW `evict` message handler. |
| `docs/drafts-that-land.md` (modify) | §6.2: the real route shape, the cookie credential, the three new verbs. |
| `test/sw-logic.test.mjs`, `test/unit-object.test.mjs`, `test/unit-api.test.mjs` (modify) | One test per behaviour above. |
| `test/unit-ui.test.mjs`, `test/chrome-drafts.test.mjs`, `test/drafts-browser-drill.test.mjs` (new) | Bar injection; bundle/dist/sw contents; the member's browser over the real worker. |
| `test/fixtures/unit-env.mjs`, `test/fixtures/unit-server.mjs` (modify) | Members with a signable secret, `cookieFor`, per-object socket lists, the bar on served content. |

---

### Task 1: A draft address is never cached by the service worker

**Files:**
- Modify: `src/sw-logic.mjs`
- Test: `test/sw-logic.test.mjs`

**Interfaces:**
- Produces: `swDecision({method, sameOrigin, mode, path})` answers `"passthrough"` for any path containing a draft segment `/@<six base-36 chars>` followed by `/` or end of string.

- [ ] **Step 1: Write the failing test**

Append to `test/sw-logic.test.mjs`:

```js
test("a draft address is network-only: every save must show on the next load", () => {
  for (const p of ["/checkout/flow/@k7f3q1/", "/checkout/flow/@k7f3q1", "/checkout/flow/@k7f3q1/css/a.css"]) {
    assert.equal(swDecision({ ...NAV, path: p }), "passthrough", p);
    assert.equal(swDecision({ ...NAV, mode: "no-cors", path: p }), "passthrough", p + " (asset)");
  }
  assert.equal(swDecision({ ...NAV, path: "/checkout/flow/" }), "swr", "main keeps the instant paint");
  assert.equal(swDecision({ ...NAV, path: "/a@b/" }), "swr", "an @ that is not a draft segment is left alone");
  assert.equal(swDecision({ ...NAV, path: "/checkout/flow/@TOOLONG/" }), "swr", "not a draft id");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sw-logic.test.mjs`
Expected: FAIL — `"swr"` for `/checkout/flow/@k7f3q1/`.

- [ ] **Step 3: Write the implementation**

In `src/sw-logic.mjs`, add above `swDecision`:

```js
// A DRAFT ADDRESS — `<unit>@<six chars>/…`, the shape src/unit-core.mjs spells with
// DRAFT_ID_RE — changes on every save, and stale-while-revalidate would paint the previous
// save first on exactly the reload the live socket just asked for. Network only. Spelled
// inline because this file is concatenated into sw.js verbatim and cannot import.
const DRAFT_SEGMENT_RE = /\/@[a-z0-9]{6}(?:\/|$)/;
```

and inside `swDecision`, after the `/__` check and before the `navigate` check:

```js
  if (DRAFT_SEGMENT_RE.test(path)) return "passthrough";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sw-logic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sw-logic.mjs test/sw-logic.test.mjs
git commit -m "sw: a draft address is network-only, so a reload shows the save that asked for it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The unit object tells its tabs what happened

**Files:**
- Modify: `src/unit-object.mjs`
- Test: `test/unit-object.test.mjs`

**Interfaces:**
- Produces, on the object:
  - `GET /socket?draft=<id>` with `Upgrade: websocket` → accepts the socket (hibernation API), attachment `{draft: id|null, since}`; `426 {error:"expected-websocket"}` without the Upgrade; `400 {error:"bad-draft"}` for a malformed id; `501 {error:"sockets-unavailable"}` where `WebSocketPair` does not exist.
  - Every socket receives, as JSON text: `{t:"open", draftId, at}`, `{t:"save", draftId, revision, at}`, `{t:"land", revision, draftId, at}`, `{t:"discard", draftId, at}` — only for verbs that answered 200.
  - `webSocketMessage(ws, "ping")` answers `"pong"`; anything else is ignored.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit-object.test.mjs`:

```js
// ── live tabs ─────────────────────────────────────────────────────────────────
// Node has no WebSocketPair and cannot build a 101; the shim records what the object did
// with the server half, and the tests assert on that (the same approach as room-tickets).
globalThis.WebSocketPair = globalThis.WebSocketPair || function WebSocketPair() {
  const mk = () => ({
    sent: [], attachment: null, closed: false,
    serializeAttachment(a) { this.attachment = a; },
    deserializeAttachment() { return this.attachment; },
    send(m) { this.sent.push(m); },
    close() { this.closed = true; },
  });
  this[0] = mk(); this[1] = mk();
};
function socketObject() {
  const db = new DatabaseSync(":memory:");
  const sockets = [];
  const ctx = {
    storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f(),
    acceptWebSocket: (ws) => sockets.push(ws), getWebSockets: () => sockets,
  };
  return { obj: new UnitObject(ctx, {}), sockets };
}
const upgrade = (query) => new Request(`https://unit/socket${query}`, { headers: { Upgrade: "websocket" } });
const events = (ws) => ws.sent.filter((m) => m !== "pong").map((m) => JSON.parse(m)).map((m) => [m.t, m.draftId || null, m.revision || null]);

test("a socket is accepted with its draft in the attachment; a plain GET is told to upgrade", async () => {
  const { obj, sockets } = socketObject();
  assert.equal((await obj.fetch(new Request("https://unit/socket?draft=k7f3q1"))).status, 426);
  assert.equal((await obj.fetch(upgrade("?draft=TOOLONG"))).status, 400);
  await obj.fetch(upgrade("?draft=k7f3q1")).catch(() => null); // Node cannot represent the 101
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].deserializeAttachment().draft, "k7f3q1");
  await obj.fetch(upgrade("")).catch(() => null);
  assert.equal(sockets[1].deserializeAttachment().draft, null, "a main tab names no draft");
});

test("open, save, landing and discard each reach every open socket, in order", async () => {
  const { obj, sockets } = socketObject();
  await call(obj, "/sync-main", { workspace: "acme", unit: U, table: main1, at: T0 });
  await obj.fetch(upgrade("?draft=zzzzzz")).catch(() => null);
  await obj.fetch(upgrade("")).catch(() => null);
  const o = (await call(obj, "/open", { owner: "p1", session: "s", at: T0 })).body;
  const s = await call(obj, "/save", { draftId: o.draftId, draftRevision: 0, at: later(1),
    changes: [{ path: `${U}index.html`, h: "b".repeat(64), ct: "text/html", s: 11, baseHash: "a".repeat(64) }] });
  assert.equal(s.status, 200);
  const l = await call(obj, "/land", { draftId: o.draftId, baseRevision: 1, at: later(2) });
  assert.equal(l.status, 200);
  assert.equal((await call(obj, "/landed", { lease: l.body.lease, draftId: o.draftId, by: "p1", session: "s", at: later(3) })).status, 200);
  const o2 = (await call(obj, "/open", { owner: "p2", session: "t", at: later(4) })).body;
  assert.equal((await call(obj, "/discard", { draftId: o2.draftId, at: later(5) })).status, 200);
  const want = [["open", o.draftId, null], ["save", o.draftId, 1], ["land", o.draftId, 2], ["open", o2.draftId, null], ["discard", o2.draftId, null]];
  assert.deepEqual(events(sockets[0]), want, "the draft tab hears everything");
  assert.deepEqual(events(sockets[1]), want, "so does the main tab; which to act on is the client's rule");
});

test("a refused verb reaches nobody, a ping is answered, and a dead socket is closed without failing the verb", async () => {
  const { obj, sockets } = socketObject();
  await call(obj, "/sync-main", { workspace: "acme", unit: U, table: main1, at: T0 });
  await obj.fetch(upgrade("")).catch(() => null);
  await obj.fetch(upgrade("")).catch(() => null);
  const o = (await call(obj, "/open", { owner: "p1", session: "s", at: T0 })).body;
  assert.equal((await call(obj, "/save", { draftId: o.draftId, draftRevision: 7, changes: [], at: later(1) })).status, 409);
  assert.deepEqual(events(sockets[0]), [["open", o.draftId, null]], "the refused save was not announced");
  obj.webSocketMessage(sockets[1], "ping");
  assert.equal(sockets[1].sent[sockets[1].sent.length - 1], "pong");
  obj.webSocketMessage(sockets[1], "{\"t\":\"anything\"}"); // ignored, never thrown
  sockets[0].send = () => { throw new Error("gone"); };
  assert.equal((await call(obj, "/save", { draftId: o.draftId, draftRevision: 0, changes: [], at: later(2) })).status, 200);
  assert.equal(sockets[0].closed, true, "a socket that cannot be sent to is closed");
  assert.equal(events(sockets[1]).length, 2, "the live one still heard the save");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit-object.test.mjs`
Expected: 3 new failures — `/socket` answers `404 unknown-route`.

- [ ] **Step 3: Write the implementation**

In `src/unit-object.mjs`, change the import to include `DRAFT_ID_RE`:

```js
import {
  newDraftId, unitTable, sameTable, applyChanges, tableDelta, presenceOf, DRAFT_ID_RE,
} from "./unit-core.mjs";
```

Add these methods to the class, after `history()` and before `// ── router`:

```js
  // ── live tabs ─────────────────────────────────────────────────────────────
  // One socket per open tab, accepted with the Hibernation API so an idle unit with tabs
  // on it costs nothing. A SOCKET CARRIES NO AUTHORITY: the worker authenticated the
  // person before forwarding the Upgrade, and every message sent here is a fact any member
  // may read anyway — a draft saved, a landing happened. Nothing about a socket is stored
  // beyond its attachment, nothing waits for one, and a verb's answer never depends on a
  // send having worked: `emit` is fire-and-forget and closes what it cannot reach.
  socket(request, url) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return json({ error: "expected-websocket" }, 426);
    const draft = url.searchParams.get("draft") || null;
    if (draft && !DRAFT_ID_RE.test(draft)) return json({ error: "bad-draft" }, 400);
    if (typeof WebSocketPair !== "function" || !this.ctx.acceptWebSocket) return json({ error: "sockets-unavailable" }, 501);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ draft, since: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }
  emit(msg) {
    if (!this.ctx.getWebSockets) return;
    const raw = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(raw); } catch (e) { try { ws.close(1011, "send failed"); } catch (e2) { /* already gone */ } }
    }
  }
  webSocketMessage(ws, raw) {
    if (raw === "ping") { try { ws.send("pong"); } catch (e) { /* closing */ } }
  }
  webSocketClose() { /* the runtime owns the socket list; nothing to clean up */ }
  webSocketError() { /* same */ }
```

In `fetch`, right after the `/sync-main` branch and before `await this.init(null, null);`, add:

```js
    if (route === "/socket") return this.socket(request, url);
```

Replace the last three lines of `fetch`:

```js
    if (!verbs[route]) return json({ error: "unknown-route" }, 404);
    const [status, out] = verbs[route]();
    return json(out, status);
```

with:

```js
    if (!verbs[route]) return json({ error: "unknown-route" }, 404);
    const [status, out] = verbs[route]();
    if (status === 200) {
      if (route === "/open") this.emit({ t: "open", draftId: out.draftId, at });
      else if (route === "/save") this.emit({ t: "save", draftId: body.draftId, revision: out.draftRevision, at });
      else if (route === "/landed") this.emit({ t: "land", revision: out.revision, draftId: body.draftId || null, at });
      else if (route === "/discard") this.emit({ t: "discard", draftId: body.draftId, at });
    }
    return json(out, status);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit-object.test.mjs`
Expected: PASS, all tests (the earlier ones untouched).

- [ ] **Step 5: Commit**

```bash
git add src/unit-object.mjs test/unit-object.test.mjs
git commit -m "units: the object tells its open tabs about opens, saves, landings and discards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: A member's browser is a caller too

**Files:**
- Modify: `src/_worker.js` (the auth block of `unitApi`)
- Modify: `test/fixtures/unit-env.mjs`
- Test: `test/unit-api.test.mjs`

**Interfaces:**
- Produces: `unitCaller(tctx, request, env, spaceId) → {who: {personId, label}, session} | {refusal: Response}`.
  - Bearer token present → exactly slice 1's behaviour (token entry, capability check).
  - No bearer, no roster (`tctx.USERS.length === 0`) → `{personId: "local", label: ""}`, session `"browser"`.
  - No bearer, session cookie names a member → `{personId: personId(email), label: email}`, session from `X-Augur-Session` or `"browser"`; a non-member → `404 {error:"not-found"}`; no cookie → `401 {error:"unauthorized"}`; a `viewer` on a non-GET → `403 {error:"viewer-role"}`.
- Fixture produces: `ADA_MEMBER`, `VERA` (viewer), `ctxFor(tenantId, users = [ADA])`, `cookieFor(env, user)`.

- [ ] **Step 1: Extend the fixture**

In `test/fixtures/unit-env.mjs`, replace the `ctxFor` line with:

```js
// Members for the browser side. `identify` compares an HMAC over the roster's secret and
// never verifies a password, so any non-empty `passHash` makes an account a test can sign
// in as (the same trick test/gate-rt-board.test.mjs uses).
const HASH = "pbkdf2$100000$dGVzdHNhbHQ$dGVzdGhhc2g";
export const ADA_MEMBER = { ...ADA, passHash: HASH };
export const VERA = { email: "vera@example.test", name: "Vera", initials: "VE", role: "viewer", passHash: HASH };
export const ctxFor = (tenantId, users = [ADA]) => ({ ...W.applyInstance({ users }), tenantId });
/** The session cookie a signed-in `user` carries. */
export async function cookieFor(env, user) {
  return `${W.USER_COOKIE}=${user.email}.${await W.userToken(env, user, user.passHash)}`;
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/unit-api.test.mjs` (and add `ADA_MEMBER, VERA, cookieFor` to the fixture import):

```js
// The browser side: a session cookie instead of a bearer token, the same handler.
const browser = (ctx, env, verb, body, cookie, method = "POST") => {
  const url = method === "GET"
    ? `https://x.test/__unit/${verb}?${new URLSearchParams(body)}`
    : `https://x.test/__unit/${verb}`;
  const headers = { "content-type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return json(W.unitApi(ctx, new Request(url, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), new URL(url), env));
};

test("a member's browser lands with a cookie; a viewer may look but not land; a stranger is refused", async () => {
  const t = tenant(), ctx = ctxFor(t, [ADA_MEMBER, VERA]);
  const env = await makeEnv({ live: manifestOf(7, { [U]: { "index.html": INDEX } }) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body; // the CLI opens
  assert.equal((await browser(ctx, env, "presence", { unit: U }, "", "GET")).status, 401, "no cookie, no answer");
  const viewerLooks = await browser(ctx, env, "presence", { unit: U }, await cookieFor(env, VERA), "GET");
  assert.equal(viewerLooks.status, 200);
  assert.equal(viewerLooks.body.drafts.length, 1);
  const viewerLands = await browser(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: o.baseRevision }, await cookieFor(env, VERA));
  assert.equal(viewerLands.status, 403);
  assert.equal(viewerLands.body.error, "viewer-role");
  const landed = await browser(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: o.baseRevision, note: "from the bar" }, await cookieFor(env, ADA_MEMBER));
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  const h = (await json(await call(ctx, env, "history", { unit: U }, { method: "GET" }))).body;
  assert.equal(h.landings[0].by, W.personId(ADA.email), "credited to the person behind the cookie");
  assert.equal(h.landings[0].session, "browser");
  assert.equal(h.landings[0].note, "from the bar");
});

test("an instance with no roster answers its operator's browser without any credential", async () => {
  const t = tenant(), ctx = ctxFor(t, []);
  const env = await makeEnv({ live: manifestOf(7, { [U]: { "index.html": INDEX } }) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const p = await browser(ctx, env, "presence", { unit: U }, "", "GET");
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.drafts, []);
});
```

Also change the existing `call` helper so a GET carries every body field as a query parameter (later tasks need `draft=`):

```js
const call = (ctx, env, verb, body, { method = "POST", session = "pass one", token = "tok" } = {}) => {
  const url = method === "GET"
    ? `https://x.test/__unit/${verb}?${new URLSearchParams(body)}`
    : `https://x.test/__unit/${verb}`;
  return W.unitApi(ctx, new Request(url, {
    method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "X-Augur-Session": session },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }), new URL(url), env);
};
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/unit-api.test.mjs`
Expected: the two new tests FAIL with `403` where `401`/`200` is expected (no bearer → `no-token` refusal).

- [ ] **Step 4: Write the implementation**

In `src/_worker.js`, above `async function unitApi`, add:

```js
/**
 * Who is calling /__unit — from a bearer token (the CLI) or from a session cookie (a
 * member's browser). ONE answer for both, so a landing made from the draft bar is recorded
 * exactly as one made from the terminal: same person id, same history row. A viewer may
 * read — presence, history, the draft card, the socket — and may not write; a signed-in
 * non-member gets the 404 the gate gives them; an instance with no roster has one
 * operator, and this is them.
 */
async function unitCaller(tctx, request, env, spaceId) {
  const session = shortText(request.headers.get("X-Augur-Session"), 40);
  const a = await publishAuthDetailed(tctx, request, env, spaceId, false);
  if (a.entry) {
    if (capabilityRefusal(a.entry, spaceId, "commit")) {
      return { refusal: jsonResponse({ error: "forbidden", reason: "capability-not-granted" }, 403) };
    }
    return { who: { personId: personId(a.entry.label || ""), label: a.entry.label || "" }, session };
  }
  if (a.refusal !== "no-token") return { refusal: jsonResponse(publishRefusalBody(a.refusal), 403) };
  if (!tctx.USERS.length) return { who: { personId: "local", label: "" }, session: session || "browser" };
  const me = await identify(request, env, tctx.USERS, { sessionKeys: tctx.SESSION_KEYS, tctx });
  if (!me) return { refusal: jsonResponse({ error: "unauthorized" }, 401) };
  if (!isMemberOf(me, spaceId)) return { refusal: jsonResponse({ error: "not-found" }, 404) };
  if (request.method !== "GET" && roleIn(me, spaceId) === "viewer") {
    return { refusal: jsonResponse({ error: "viewer-role", message: "This account can look around but not land or discard drafts." }, 403) };
  }
  return { who: { personId: personId(me.email), label: me.email }, session: session || "browser" };
}
```

In `unitApi`, replace:

```js
  const a = await publishAuthDetailed(tctx, request, env, spaceId, false);
  if (!a.entry) return jsonResponse(publishRefusalBody(a.refusal), 403);
  if (capabilityRefusal(a.entry, spaceId, "commit")) return jsonResponse({ error: "forbidden", reason: "capability-not-granted" }, 403);
  const who = { personId: personId(a.entry.label || ""), label: a.entry.label || "" };
  const session = shortText(request.headers.get("X-Augur-Session"), 40);
```

with:

```js
  const caller = await unitCaller(tctx, request, env, spaceId);
  if (caller.refusal) return caller.refusal;
  const { who, session } = caller;
```

Add `unitCaller` to `__testables`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit-api.test.mjs`
Expected: PASS. If `identify` returns null for `ADA_MEMBER`, compare the user shape with `VIEWER`/`ADMIN` in `test/gate-rt-board.test.mjs` (around lines 40–58) and match it in the fixture — the cookie is `email.userToken(env, user, user.passHash)` there too.

- [ ] **Step 6: Commit**

```bash
git add src/_worker.js test/fixtures/unit-env.mjs test/unit-api.test.mjs
git commit -m "units: a member's browser is a caller — a session cookie lands exactly as a token does

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Faces on presence and history, and one draft's card

**Files:**
- Modify: `src/_worker.js` (`unitApi` GET verbs and `open`)
- Modify: `src/unit-object.mjs` (the `/draft/<id>` answer)
- Test: `test/unit-api.test.mjs`

**Interfaces:**
- Produces:
  - `personFace(users, id) → {name, initials, color}` (all `null` when nobody on the roster answers to the id).
  - `decorateDrafts(drafts, users)` — each presence row gains `name`, `initials`, `color` from its `owner`.
  - `decorateLandings(landings, users)` — each landing gains the same from its `by`.
  - `GET /__unit/presence`, the `presence` field of `open`, and `GET /__unit/history` are decorated.
  - `GET /__unit/draft?unit=<unit>&draft=<id>` → `{draftId, owner, session, openedAt, lastSaveAt, baseRevision, revision, closedAt, name, initials, color, files}` (the table itself is not sent); `400 {error:"bad-draft"}`; the object's `404 {error:"unknown-draft"}` passes through. The object's own `/draft/<id>` answer gains `openedAt` and `lastSaveAt` for this.

- [ ] **Step 1: Write the failing test**

Append to `test/unit-api.test.mjs`:

```js
test("presence, history and a draft's card carry the face behind each id", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  assert.equal(o.presence[0].name, "Ada");
  assert.equal(o.presence[0].initials, "AD");
  const p = (await json(await call(ctx, env, "presence", { unit: U }, { method: "GET" }))).body;
  assert.equal(p.drafts[0].owner, W.personId(ADA.email));
  assert.equal(p.drafts[0].name, "Ada");
  assert.match(p.drafts[0].color, /^#[0-9a-f]{6}$/i);
  const d = (await json(await call(ctx, env, "draft", { unit: U, draft: o.draftId }, { method: "GET" }))).body;
  assert.equal(d.draftId, o.draftId);
  assert.equal(d.baseRevision, 1);
  assert.equal(d.name, "Ada");
  assert.equal(d.files, 2, "a count, never the table");
  assert.equal(d.table, undefined);
  assert.equal(typeof d.openedAt, "string", "the bar says when it was opened");
  assert.equal(d.lastSaveAt, null);
  assert.equal((await json(await call(ctx, env, "draft", { unit: U, draft: "nope" }, { method: "GET" }))).status, 400);
  assert.equal((await json(await call(ctx, env, "draft", { unit: U, draft: "zzzzzz" }, { method: "GET" }))).status, 404);
  await call(ctx, env, "land", { unit: U, draftId: o.draftId, baseRevision: o.baseRevision, note: "n" });
  const h = (await json(await call(ctx, env, "history", { unit: U }, { method: "GET" }))).body;
  assert.equal(h.landings[0].name, "Ada");
  assert.equal(h.landings[1].by, "live", "the adopted revision");
  assert.equal(h.landings[1].name, null, "no face answers to it");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit-api.test.mjs`
Expected: FAIL — `o.presence[0].name` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/unit-object.mjs`, the GET `/draft/<id>` route's answer gains the two times the bar shows:

```js
        return json({ draftId: d.id, table: d.table, owner: d.owner, session: d.session, openedAt: d.openedAt, lastSaveAt: d.lastSaveAt, baseRevision: d.baseRevision, revision: d.revision, closedAt: d.closedAt });
```

In `src/_worker.js`, extend the unit-core import:

```js
import { normUnit, splitDraftPath, unitTable, draftAddress, DRAFT_ID_RE } from "./unit-core.mjs";
```

Above `unitCaller`, add:

```js
/** The face behind a one-way person id, from the roster; nulls when nobody answers to it. */
function personFace(users, id) {
  const u = (users || []).find((x) => x && personId(x.email) === id);
  return u
    ? { name: u.name || nameFromEmail(u.email), initials: u.initials || initialsFor(u.name || u.email), color: u.color || colorFor(u.email) }
    : { name: null, initials: null, color: null };
}
const decorateDrafts = (drafts, users) => (drafts || []).map((d) => ({ ...d, ...personFace(users, d.owner) }));
const decorateLandings = (landings, users) => (landings || []).map((l) => ({ ...l, ...personFace(users, l.by) }));
```

In `unitApi`, replace the GET block:

```js
  if (request.method === "GET") {
    if (verb === "presence") return jsonResponse((await unitCall(stub, `/presence?at=${encodeURIComponent(now)}`, null, "GET")).body);
    if (verb === "history") return jsonResponse((await unitCall(stub, "/history", null, "GET")).body);
    if (verb === "main") return jsonResponse((await unitCall(stub, "/main", null, "GET")).body);
    return jsonResponse({ error: "unknown-verb" }, 404);
  }
```

with:

```js
  if (request.method === "GET") {
    if (verb === "presence") {
      const r = await unitCall(stub, `/presence?at=${encodeURIComponent(now)}`, null, "GET");
      return jsonResponse(r.status === 200 ? { ...r.body, drafts: decorateDrafts(r.body.drafts, tctx.USERS) } : r.body, r.status);
    }
    if (verb === "history") {
      const r = await unitCall(stub, "/history", null, "GET");
      return jsonResponse(r.status === 200 ? { ...r.body, landings: decorateLandings(r.body.landings, tctx.USERS) } : r.body, r.status);
    }
    if (verb === "draft") {
      // One draft's card, for the bar: who, which session, where it stands. The TABLE stays
      // in the object — a bar needs a file count, and a table can be thousands of rows.
      const id = url.searchParams.get("draft") || "";
      if (!DRAFT_ID_RE.test(id)) return jsonResponse({ error: "bad-draft" }, 400);
      const r = await unitCall(stub, `/draft/${id}`, null, "GET");
      if (r.status !== 200) return jsonResponse(r.body, r.status);
      const { table, ...rest } = r.body;
      return jsonResponse({ ...rest, ...personFace(tctx.USERS, rest.owner), files: Object.keys(table || {}).length });
    }
    if (verb === "main") return jsonResponse((await unitCall(stub, "/main", null, "GET")).body);
    return jsonResponse({ error: "unknown-verb" }, 404);
  }
```

and in the `open` branch replace:

```js
    return jsonResponse({ ...r.body, address: draftAddress(unit, r.body.draftId) });
```

with:

```js
    return jsonResponse({ ...r.body, presence: decorateDrafts(r.body.presence, tctx.USERS), address: draftAddress(unit, r.body.draftId) });
```

Add `personFace` to `__testables`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit-api.test.mjs test/draft-lib.test.mjs test/drafts-drill.test.mjs`
Expected: PASS (the CLI's `others` mapping in `doOpen` reads `session` and ignores the extra fields).

- [ ] **Step 5: Commit**

```bash
git add src/_worker.js src/unit-object.mjs test/unit-api.test.mjs
git commit -m "units: presence, history and a draft's card carry the face behind each id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Which units have drafts open — the gallery's one question

**Files:**
- Modify: `src/_worker.js` (`OVERLAY_KV_KEYS`, `unitApi`)
- Modify: `src/state-inventory.mjs`
- Test: `test/unit-api.test.mjs`

**Interfaces:**
- Produces:
  - Overlay family `drafts` (`{doc: "drafts", layout: "map"}`): key = unit path, value `{n, at}`; written by `noteUnitDrafts(tctx, env, stub, unit, now)` after `open`, after `landed` (whatever it answered) and after `discard`; a unit with nothing open has no row.
  - `GET /__unit/drafts` (no `unit`) → `{units: {"<unit>": [decorated presence rows…]}, now}`. Reads the hint, asks each named object for its live presence, drops a row the object contradicts. At most `DRAFTS_INDEX_MAX = 50` units.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit-api.test.mjs`:

```js
test("the gallery's index names every unit with an open draft, and only those", async () => {
  const V = "/checkout/other/";
  const t = tenant(), ctx = ctxFor(t);
  const env = await makeEnv({ live: manifestOf(7, { [U]: { "index.html": INDEX }, [V]: { "index.html": INDEX } }) });
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId: t } });
  const idx = async () => (await json(await call(ctx, env, "drafts", {}, { method: "GET" }))).body.units;
  assert.deepEqual(await idx(), {});
  const a = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const b = (await json(await call(ctx, env, "open", { unit: U }, { session: "pass two" }))).body;
  const c = (await json(await call(ctx, env, "open", { unit: V }))).body;
  let units = await idx();
  assert.deepEqual(Object.keys(units).sort(), [U, V].sort());
  assert.deepEqual(units[U].map((d) => d.session).sort(), ["pass one", "pass two"]);
  assert.equal(units[U][0].name, "Ada", "a chip carries the face");
  assert.equal((await json(await call(ctx, env, "discard", { unit: V, draftId: c.draftId }))).status, 200);
  assert.equal((await json(await call(ctx, env, "land", { unit: U, draftId: a.draftId, baseRevision: a.baseRevision, note: "" }))).status, 200);
  units = await idx();
  assert.deepEqual(Object.keys(units), [U]);
  assert.deepEqual(units[U].map((d) => d.id), [b.draftId]);
  const hint = JSON.parse(await env.COMMENTS.get("drafts"));
  assert.equal(Object.prototype.hasOwnProperty.call(hint, V), false, "a unit with nothing open leaves no row");
  assert.equal(hint[U].n, 1);
});

test("a stale hint is corrected on read: the objects are the truth", async () => {
  const { ctx, env } = await setup();
  await env.COMMENTS.put("drafts", JSON.stringify({
    [U]: { n: 3, at: "2026-09-01T00:00:00.000Z" },
    "/nowhere/x/": { n: 1, at: "2026-09-01T00:00:00.000Z" },
    "not a unit": { n: 1, at: "2026-09-01T00:00:00.000Z" },
  }));
  const r = await json(await call(ctx, env, "drafts", {}, { method: "GET" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.units, {});
  assert.deepEqual(JSON.parse(await env.COMMENTS.get("drafts")), { "not a unit": { n: 1, at: "2026-09-01T00:00:00.000Z" } },
    "rows the objects deny are dropped; a row that is not even a unit path is never asked about and left for the operator to see");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/unit-api.test.mjs`
Expected: FAIL — `drafts` answers `400 bad-unit` (no unit named).

- [ ] **Step 3: Write the implementation**

In `src/_worker.js`, in `OVERLAY_KV_KEYS`, after the `marks` entry add:

```js
  // WHICH UNITS HAVE OPEN DRAFTS — a hint the gallery reads so it can ask the right unit
  // objects and no others (`draftsIndexApi`). One row per unit, `{n, at}`, written from
  // the object's own presence answer after open, land and discard. NEVER THE TRUTH: the
  // objects are, and every read re-checks each row against its object and drops what it
  // contradicts. Map layout for exactly the reason marks are — one get per gallery load.
  drafts: Object.freeze({ doc: "drafts", layout: "map" }),
```

In `src/state-inventory.mjs`, after the `marks` entry add:

```js
  {
    id: "drafts", store: "kv", kind: "key", to: "drop",
    why: "The open-drafts hint: one row per unit saying how many drafts its object reports open, written after open, land and discard so the gallery knows which unit objects to ask (`draftsIndexApi` in src/_worker.js) and asks no others. Never the truth — every read re-checks the object and drops a row it contradicts. DROPPED on a copy because the unit objects it points at do not travel (see `/__unit/`), so a carried row would name drafts the destination cannot serve; the first open on the new home writes a true one.",
  },
```

Above `unitCaller` in `src/_worker.js`, add:

```js
/** How many units the gallery's index will ask about in one answer. */
const DRAFTS_INDEX_MAX = 50;
/** Refresh one unit's row in the open-drafts hint from the object's own answer. Best effort. */
async function noteUnitDrafts(tctx, env, stub, unit, now) {
  const store = overlayFor(env, tctx);
  if (!store) return;
  try {
    const p = await unitCall(stub, `/presence?at=${encodeURIComponent(now)}`, null, "GET");
    if (p.status !== 200) return;
    const n = (p.body.drafts || []).length;
    await store.set("drafts", "", unit, n ? { n, at: now } : null, null);
  } catch (e) { /* a hint that failed to write is a chip that appears one open later, not a lost draft */ }
}
/** Every open draft in the workspace, by unit — what the gallery's chips read. */
async function draftsIndexApi(tctx, env, now) {
  const store = overlayFor(env, tctx);
  let map = {};
  try { map = store ? (await store.read("drafts")) || {} : {}; } catch (e) { map = {}; }
  const units = Object.keys(map)
    .filter((u) => map[u] && Number(map[u].n) > 0 && normUnit(u) === u)
    .sort().slice(0, DRAFTS_INDEX_MAX);
  const out = {};
  for (const unit of units) {
    const stub = unitStub(env, tctx.tenantId, unit);
    if (!stub) continue;
    const p = await unitCall(stub, `/presence?at=${encodeURIComponent(now)}`, null, "GET");
    if (p.status !== 200) continue;
    const drafts = decorateDrafts(p.body.drafts, tctx.USERS);
    if (drafts.length) out[unit] = drafts;
    else if (store) { try { await store.set("drafts", "", unit, null, null); } catch (e) { /* the next read tries again */ } }
  }
  return jsonResponse({ units: out, now });
}
```

In `unitApi`, right after `const { who, session } = caller;` and before the body parse, add:

```js
  // The one verb that names no unit: every open draft in the workspace, for the gallery.
  if (request.method === "GET" && verb === "drafts") return draftsIndexApi(tctx, env, new Date().toISOString());
```

Then the three writes. In the `open` branch, after `if (r.status !== 200) return jsonResponse(r.body, r.status);` add:

```js
    await noteUnitDrafts(tctx, env, stub, unit, now);
```

In the `land`/`restore` branch, immediately after the retry line `if (done.status !== 200) done = await unitCall(stub, "/landed", record);` add:

```js
    await noteUnitDrafts(tctx, env, stub, unit, now);
```

Replace the `sync`/`discard` branch:

```js
  if (verb === "sync" || verb === "discard") {
    const r = await unitCall(stub, `/${verb}`, { draftId: body.draftId, at: now });
    return jsonResponse(r.body, r.status);
  }
```

with:

```js
  if (verb === "sync" || verb === "discard") {
    const r = await unitCall(stub, `/${verb}`, { draftId: body.draftId, at: now });
    if (verb === "discard" && r.status === 200) await noteUnitDrafts(tctx, env, stub, unit, now);
    return jsonResponse(r.body, r.status);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit-api.test.mjs test/identity-kv-tenancy.test.mjs test/state-export-absent.test.mjs`
Expected: PASS. If `identity-kv-tenancy` names the `drafts` family, the inventory entry's `id` must equal the family's `doc` (`"drafts"`) — check the spelling.

- [ ] **Step 5: Commit**

```bash
git add src/_worker.js src/state-inventory.mjs test/unit-api.test.mjs
git commit -m "units: the gallery asks one question — which units have drafts open — and the objects answer it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The socket verb, forwarded to the unit's object

**Files:**
- Modify: `src/_worker.js` (`unitApi`)
- Modify: `test/fixtures/unit-env.mjs` (`unitsNamespace`)
- Test: `test/unit-api.test.mjs`

**Interfaces:**
- Produces: `GET /__unit/socket?unit=<unit>&draft=<id>` (Upgrade: websocket) → the Upgrade is forwarded to the object as `GET https://unit/socket?draft=<id>` with the original request's headers; `400 {error:"bad-draft"}` for a malformed id before anything is forwarded. Authentication is `unitCaller`'s (bearer or cookie; a viewer may open a socket).
- Fixture produces: `unitsNamespace().get(name).sockets` — the sockets that object accepted.

- [ ] **Step 1: Extend the fixture**

In `test/fixtures/unit-env.mjs`, replace `unitsNamespace` with:

```js
/** A UNITS namespace: one real object per name, each over its own in-memory database. */
export function unitsNamespace() {
  const objects = new Map();
  return {
    objects,
    idFromName: (n) => n,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:");
        const sockets = [];
        const ctx = {
          storage: { sql: sqlHandle(db) }, blockConcurrencyWhile: async (f) => f(),
          acceptWebSocket: (ws) => sockets.push(ws), getWebSockets: () => sockets,
        };
        objects.set(name, { obj: new UnitObject(ctx, {}), sockets });
      }
      const { obj, sockets } = objects.get(name);
      return { fetch: (input, init) => obj.fetch(new Request(input, init)), sockets };
    },
  };
}
```

Then `grep -rn "UNITS.objects\|units.objects\|\.objects.get" test/` — nothing else reads the map's values (only `test/bundle-tenancy.test.mjs` uses a different `.objects`, an R2 listing). If something does, update it to `.obj`.

- [ ] **Step 2: Write the failing test**

Append to `test/unit-api.test.mjs` (add the `WebSocketPair` shim from Task 2 at the top of this file too, guarded by `globalThis.WebSocketPair = globalThis.WebSocketPair || …`):

```js
test("the socket verb forwards the upgrade to the unit's object with the draft named", async () => {
  const { ctx, env } = await setup();
  const o = (await json(await call(ctx, env, "open", { unit: U }))).body;
  const url = `https://x.test/__unit/socket?unit=${encodeURIComponent(U)}&draft=${o.draftId}`;
  await W.unitApi(ctx, new Request(url, { headers: { Authorization: "Bearer tok", Upgrade: "websocket" } }), new URL(url), env).catch(() => null);
  const sockets = env.UNITS.get(env.UNITS.idFromName(`${ctx.tenantId}:${U}`)).sockets;
  assert.equal(sockets.length, 1, "the object accepted the socket");
  assert.equal(sockets[0].deserializeAttachment().draft, o.draftId);
  const bad = `https://x.test/__unit/socket?unit=${encodeURIComponent(U)}&draft=nope`;
  const res = await W.unitApi(ctx, new Request(bad, { headers: { Authorization: "Bearer tok", Upgrade: "websocket" } }), new URL(bad), env);
  assert.equal(res.status, 400);
  assert.equal(sockets.length, 1, "a bad id never reaches the object");
  const plain = await W.unitApi(ctx, new Request(url, { headers: { Authorization: "Bearer tok" } }), new URL(url), env);
  assert.equal(plain.status, 426, "without an Upgrade the object says so");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/unit-api.test.mjs`
Expected: FAIL — `sockets.length` is 0 (`socket` answers `404 unknown-verb`).

- [ ] **Step 4: Write the implementation**

In `unitApi`, immediately after `const stub = unitStub(env, tctx.tenantId, unit);` add:

```js
  // A live tab's subscription. The Upgrade rides through to the object with the caller's
  // headers intact — the object accepts it or answers 426 — and the draft id is checked
  // here so a malformed one never reaches an object. Nothing else on this path is needed
  // for a socket: it reads no table and writes nothing.
  if (request.method === "GET" && verb === "socket") {
    const draft = url.searchParams.get("draft") || "";
    if (draft && !DRAFT_ID_RE.test(draft)) return jsonResponse({ error: "bad-draft" }, 400);
    return stub.fetch(new Request(`https://unit/socket${draft ? `?draft=${draft}` : ""}`, request));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit-api.test.mjs test/unit-serve.test.mjs test/drafts-drill.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/_worker.js test/fixtures/unit-env.mjs test/unit-api.test.mjs
git commit -m "units: /__unit/socket — a live tab subscribes to its unit's object

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The bar rides every unit page a member sees

**Files:**
- Modify: `src/_worker.js` (`ENGINE_CHROME_PATHS`, new `withDraftUi`, `serveContent`, three call sites, `__testables`)
- Test: `test/unit-ui.test.mjs` (new)

**Interfaces:**
- Produces:
  - `DRAFT_UI_SRC = "/__drafts/drafts.js"`.
  - `draftUiBoot(tctx, url, me, spaceId) → {unit, draft, me: {id, role}} | null` — `null` off a unit page.
  - `withDraftUi(tctx, res, url, me, env) → Response` — appends `<script>window.__augurDraft=…</script><script defer src="/__drafts/drafts.js"></script>` before `</body>` of a 200 HTML response at a unit path (main or draft address) when `me` is set (or the instance has no roster) and `UNITS` is bound; otherwise returns `res` untouched. Drops `Content-Length` and `ETag` when it rewrites.
  - `serveContent(tctx, asset, url, me, env)` — `withAssetCache(await withDraftUi(tctx, await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url, me, env), url)`; used at all three content-serving sites.
  - `isEngineChrome("/__drafts/drafts.js") === true`.

- [ ] **Step 1: Write the failing test**

Create `test/unit-ui.test.mjs`:

```js
// test/unit-ui.test.mjs — the draft bar's script tag rides a unit's HTML for members.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { ctxFor, ADA, unitsNamespace } from "./fixtures/unit-env.mjs";

const U = "/checkout/flow/";
const html = (body = "<h1>flow</h1>") => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"', "Content-Length": "60" },
});
const env = { UNITS: unitsNamespace() };
const me = { email: ADA.email, name: ADA.name, role: "editor" };
const tctx = () => ({ ...ctxFor("ui"), PUBLIC_PREFIXES: [U] });
const bootOf = async (res) => JSON.parse(/window\.__augurDraft=(\{.*?\})<\/script>/.exec(await res.text())[1]);

test("a member on a unit page gets the bar; the boot names the unit and the draft", async () => {
  const out = await W.withDraftUi(tctx(), html(), new URL(`https://x.test${U}@k7f3q1/`), me, env);
  const text = await out.clone().text();
  assert.match(text, /<script defer src="\/__drafts\/drafts\.js"><\/script><\/body>/);
  assert.match(text, /<h1>flow<\/h1>/, "the page is otherwise untouched");
  assert.deepEqual(await bootOf(out), { unit: U, draft: "k7f3q1", me: { id: W.personId(ADA.email), role: "editor" } });
  assert.equal(out.headers.get("ETag"), null, "the bytes are no longer the stored blob");
  assert.equal(out.headers.get("Content-Length"), null);
  const main = await bootOf(await W.withDraftUi(tctx(), html(), new URL(`https://x.test${U}pages/two.html`), me, env));
  assert.equal(main.draft, null);
  assert.equal(main.unit, U);
});

test("no bar for a stranger, off a unit, on a non-HTML answer, with ?raw, on a 404, or without UNITS", async () => {
  const untouched = async (res, url, who, e = env, t = tctx()) => (await W.withDraftUi(t, res, new URL(url), who, e)) === res;
  assert.equal(await untouched(html(), `https://x.test${U}`, null), true, "anonymous on a public prototype");
  assert.equal(await untouched(html(), "https://x.test/", me), true, "the gallery is not a unit page");
  assert.equal(await untouched(new Response("body{}", { headers: { "Content-Type": "text/css" } }), `https://x.test${U}a.css`, me), true);
  assert.equal(await untouched(html(), `https://x.test${U}?raw`, me), true);
  assert.equal(await untouched(new Response("no", { status: 404, headers: { "Content-Type": "text/html" } }), `https://x.test${U}`, me), true);
  assert.equal(await untouched(html(), `https://x.test${U}`, me, {}), true, "no UNITS binding, nothing to show");
});

test("an instance with no roster is its operator's: the bar appears for nobody in particular", async () => {
  const open = { ...tctx(), USERS: [] };
  const boot = await bootOf(await W.withDraftUi(open, html(), new URL(`https://x.test${U}`), null, env));
  assert.deepEqual(boot.me, { id: "local", role: "admin" });
});

test("a page without a body tag still gets the tag, at the end", async () => {
  const bare = new Response("<h1>bare</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
  const text = await (await W.withDraftUi(tctx(), bare, new URL(`https://x.test${U}`), me, env)).text();
  assert.match(text, /^<h1>bare<\/h1><script>window\.__augurDraft=/);
});

test("/__drafts/ is engine chrome no space may write", () => {
  assert.equal(W.isEngineChrome("/__drafts/drafts.js"), true);
  assert.equal(W.isEngineChrome("/__draftsy/x.js"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit-ui.test.mjs`
Expected: FAIL — `W.withDraftUi is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/_worker.js`, add `"/__drafts/"` to `ENGINE_CHROME_PATHS`:

```js
const ENGINE_CHROME_PATHS = Object.freeze([
  "/fonts/", "/pitis/", "/__review/", "/__canvas/", "/__drafts/", "/admin", "/changelog",
  "/piti.js", "/404.html", "/manifest.webmanifest", "/sw.js",
  "/augur-eye.svg", "/augur-icon-192.png", "/augur-icon-512.png", "/augur-mark.png",
]);
```

Directly after `composeChrome` (before the `__setChromeTestState` seam), add:

```js
// ---- The draft bar (drafts that land, §5) -------------------------------------
// A prototype is raw HTML from a space and carries no chrome; a draft has no build step
// that could bake one in. So a member looking at a unit's page — main or a draft address —
// gets ONE script tag and one line of data appended at serve time, and the script does the
// rest (src/drafts/drafts.js). An anonymous visitor on a public prototype gets the bytes as
// published: the bar names people, and a stranger is told nothing.
const DRAFT_UI_SRC = "/__drafts/drafts.js";
function draftUiBoot(tctx, url, me, spaceId) {
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch (e) { return null; }
  const d = splitDraftPath(decoded);
  const unit = d ? d.unit : unitOfPath(decoded, new Set(tctx.PUBLIC_PREFIXES || []));
  if (!unit) return null;
  const role = me ? (spaceId ? roleIn(me, spaceId) : roleOf(me)) : "admin";
  return { unit, draft: d ? d.id : null, me: { id: me ? personId(me.email) : "local", role } };
}
async function withDraftUi(tctx, res, url, me, env) {
  if (!res || res.status !== 200 || !unitNamespace(env)) return res;
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/html") || url.searchParams.has("raw")) return res;
  if (tctx.USERS.length && !me) return res;
  const boot = draftUiBoot(tctx, url, me, defaultSpaceIdFromCtx(tctx));
  if (!boot) return res;
  const tag = `<script>window.__augurDraft=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`
    + `<script defer src="${DRAFT_UI_SRC}"></script>`;
  let html = await res.text();
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + "</body>") : html + tag;
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}
/** A content response, dressed: the live-reload poll, the current chrome, the draft bar, the cache policy. */
async function serveContent(tctx, asset, url, me, env) {
  return withAssetCache(await withDraftUi(tctx, await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url, me, env), url);
}
```

Replace the three call sites in the request handler. The admin one:

```js
      const asset = await assetFetch(tctx.tenantId, env, request);
      if (asset.status === 404) return notFoundResponse(tctx);
      return withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
    }
```

becomes

```js
      const asset = await assetFetch(tctx.tenantId, env, request);
      if (asset.status === 404) return notFoundResponse(tctx);
      return serveContent(tctx, asset, url, me, env);
    }
```

The public one:

```js
      const res = withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
```

becomes

```js
      const res = await serveContent(tctx, asset, url, me, env);
```

The authed one:

```js
      return withAssetCache(await composeChrome(tctx, withLiveReload(tctx, asset, url), url), url);
```

becomes

```js
      return serveContent(tctx, asset, url, me, env);
```

Add `withDraftUi, draftUiBoot, isEngineChrome` to `__testables` (`isEngineChrome` if it is not already there).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/unit-ui.test.mjs && npm test`
Expected: PASS. `test/tenant-route-sweep.test.mjs` and `test/response-snapshot.test.mjs` exercise the three call sites through their `HTMLRewriter` shims; a failure there means `serveContent` changed an answer for a page that is not a unit page — it must not.

- [ ] **Step 5: Commit**

```bash
git add src/_worker.js test/unit-ui.test.mjs
git commit -m "units: a member's unit page carries the draft bar's script; a stranger's carries nothing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The draft bar

**Files:**
- Create: `src/drafts/drafts.js`
- Modify: `build.js` (copy step + `ENGINE_CHROME`)
- Test: `test/chrome-drafts.test.mjs` (new; Task 9 extends it)

**Interfaces:**
- Consumes: `window.__augurDraft = {unit, draft, me: {id, role}}`; `GET /__unit/presence?unit=`, `GET /__unit/draft?unit=&draft=`, `GET /__unit/history?unit=`, `POST /__unit/land|discard|restore`, `GET /__unit/socket?unit=&draft=` (Upgrade), `GET /__people?ids=`; the SW `evict` message (Task 9).
- Produces: `dist/__drafts/drafts.js`, byte-identical to the source.

- [ ] **Step 1: Write the failing test**

Create `test/chrome-drafts.test.mjs`:

```js
// test/chrome-drafts.test.mjs — what the build ships for drafts that land: the bar script
// at /__drafts/drafts.js, the chips in the chrome bundle, the evict handler in sw.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function buildMinimalSite() {
  const spacesRoot = mkdtempSync(path.join(tmpdir(), "drafts-space-"));
  writeFileSync(path.join(spacesRoot, "space.json"), JSON.stringify({ id: "acme", name: "Acme", default: true }));
  const proto = path.join(spacesRoot, "demo", "prototypes", "hello");
  mkdirSync(proto, { recursive: true });
  writeFileSync(path.join(proto, "index.html"), "<!doctype html><title>Hello</title><p>hi</p>\n");
  const out = mkdtempSync(path.join(tmpdir(), "drafts-dist-"));
  execFileSync(process.execPath, ["build.js"], { cwd: ROOT, env: { ...process.env, GV_SPACES_ROOT: spacesRoot, GV_DIST: out }, stdio: "pipe" });
  return { out, cleanup: () => { rmSync(spacesRoot, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}
const built = buildMinimalSite();
process.on("exit", built.cleanup);
const dist = built.out;
const chromeJs = () => readFileSync(path.join(dist, readdirSync(dist).find((f) => /^_chrome\..*\.js$/.test(f))), "utf8");
const chromeCss = () => readFileSync(path.join(dist, readdirSync(dist).find((f) => /^_chrome\..*\.css$/.test(f))), "utf8");

test("the bar script ships at /__drafts/drafts.js, byte-identical to its source, and parses", () => {
  const shipped = path.join(dist, "__drafts", "drafts.js");
  assert.equal(existsSync(shipped), true);
  const src = readFileSync(path.join(ROOT, "src", "drafts", "drafts.js"), "utf8");
  assert.equal(readFileSync(shipped, "utf8"), src);
  execFileSync(process.execPath, ["--check", shipped], { stdio: "pipe" });
  for (const must of ["/__unit/", "\"presence\"", "\"draft\"", "\"history\"", "\"land\"", "\"discard\"", "\"restore\"", "/__unit/socket?", "window.top !== window.self", "\"evict\""]) {
    assert.ok(src.includes(must), `drafts.js speaks ${must}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/chrome-drafts.test.mjs`
Expected: FAIL — `dist/__drafts/drafts.js` does not exist.

- [ ] **Step 3: Write the bar**

Create `src/drafts/drafts.js`:

```js
/* Augur — the draft bar (drafts that land, docs/drafts-that-land.md §5).
 *
 * Served at /__drafts/drafts.js and appended by the worker to a unit's HTML for signed-in
 * members (withDraftUi in src/_worker.js), which also leaves the boot data in
 * window.__augurDraft = { unit, draft, me: { id, role } }.
 *
 * On MAIN the bar lists the unit's open drafts (or shows nothing) and reloads the tab when
 * a landing happens. On a DRAFT ADDRESS it names whose draft this is and when it last
 * saved, offers Land and Discard to editors, and reloads on every save. History opens a
 * panel of landings with Restore. Everything shown comes from /__unit/*, never from the
 * page; the socket at /__unit/socket says WHEN to ask again. No chrome dependency, no
 * external request, and nothing here is a lock: the bar refuses nobody.
 */
(function () {
  if (window.top !== window.self) return; // gallery previews and embeds carry no bar
  var boot = window.__augurDraft;
  if (!boot || !boot.unit) return;
  var UNIT = boot.unit, DRAFT = boot.draft || null, ME = boot.me || {};
  var canWrite = ME.role !== "viewer";
  var unitQ = "unit=" + encodeURIComponent(UNIT);
  var state = { card: null, drafts: [] };

  // ── talking to the unit ──────────────────────────────────────────────────────
  function api(verb, body, extraQuery) {
    var opts = { credentials: "same-origin", headers: { Accept: "application/json" } };
    var url = "/__unit/" + verb;
    if (body) {
      opts.method = "POST";
      opts.headers["Content-Type"] = "application/json";
      body.unit = UNIT;
      opts.body = JSON.stringify(body);
    } else {
      url += "?" + unitQ + (extraQuery || "");
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; });
    });
  }

  // ── small helpers ────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ago(iso, verb) {
    var ms = Date.now() - Date.parse(iso || "");
    if (!(ms >= 0)) return "";
    var m = Math.round(ms / 60000);
    if (m < 1) return verb + " just now";
    if (m < 60) return verb + " " + m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return verb + " " + h + " h ago";
    return verb + " " + new Date(iso).toLocaleDateString();
  }
  function face(p) {
    var f = el("span", "augur-draft__face", (p.initials || "?").slice(0, 2));
    if (p.color) f.style.backgroundColor = p.color;
    var id = p.owner || p.by;
    if (id) f.setAttribute("data-person", id);
    return f;
  }
  function label(p) { return (p.name || "Someone") + (p.session ? " · " + p.session : ""); }
  function go(href) { location.href = href; }

  // Photos, laid over the initials once /__people answers. Initials stand if it does not.
  function faces(root) {
    var els = root.querySelectorAll("[data-person]"), ids = [], byId = {};
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute("data-person");
      if (!id) continue;
      (byId[id] = byId[id] || []).push(els[i]);
      if (ids.indexOf(id) < 0) ids.push(id);
    }
    if (!ids.length) return;
    fetch("/__people?ids=" + encodeURIComponent(ids.slice(0, 50).join(",")), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.people) return;
        d.people.forEach(function (p) {
          if (!p.avatar) return;
          (byId[p.id] || []).forEach(function (e) {
            e.style.backgroundImage = "url('" + p.avatar + "')";
            e.style.backgroundSize = "cover";
            e.textContent = "";
          });
        });
      })
      .catch(function () { /* initials stand */ });
  }

  // ── styles, once ─────────────────────────────────────────────────────────────
  var CSS = [
    ".augur-draftbar{position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:8px;",
    "padding:6px 10px 6px 6px;border-radius:999px;background:#101828;color:#fff;box-shadow:0 8px 24px -8px rgba(16,24,40,.6);",
    "font:600 12.5px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:-.005em;max-width:min(92vw,560px)}",
    ".augur-draftbar[hidden]{display:none}",
    ".augur-draftbar a{color:inherit;text-decoration:none}",
    ".augur-draft__face{flex:none;width:22px;height:22px;border-radius:50%;display:inline-grid;place-items:center;",
    "font-size:9px;font-weight:700;color:#fff;background:#4f46e5;background-position:center}",
    ".augur-draft__text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".augur-draft__dim{opacity:.7;font-weight:500}",
    ".augur-draftbar button{font:inherit;border:0;border-radius:999px;padding:5px 10px;cursor:pointer;color:#101828;background:#fff}",
    ".augur-draftbar button.is-quiet{background:transparent;color:#fff;opacity:.85}",
    ".augur-draftbar button:disabled{opacity:.5;cursor:default}",
    ".augur-draft__list{position:fixed;left:12px;bottom:56px;z-index:2147483000;display:flex;flex-direction:column;gap:6px}",
    ".augur-draft__row{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;border-radius:999px;background:#101828;color:#fff;",
    "font:600 12.5px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 8px 24px -8px rgba(16,24,40,.6)}",
    ".augur-draft__row.is-idle{opacity:.75}",
    ".augur-draft__panel{position:fixed;left:12px;bottom:56px;z-index:2147483001;width:min(92vw,420px);max-height:60vh;overflow:auto;",
    "background:#fff;color:#101828;border-radius:14px;box-shadow:0 20px 48px -16px rgba(16,24,40,.55),0 2px 8px rgba(16,24,40,.12);",
    "font:500 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;padding:8px}",
    ".augur-draft__panel h2{margin:4px 8px 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#667085}",
    ".augur-draft__landing{display:grid;grid-template-columns:22px 1fr auto;gap:8px;align-items:center;padding:8px;border-radius:10px}",
    ".augur-draft__landing:hover{background:#f2f4f7}",
    ".augur-draft__landing small{display:block;color:#667085;font-weight:500}",
    ".augur-draft__landing button{font:inherit;font-size:12px;border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:4px 10px;cursor:pointer}",
    ".augur-draft__note{position:fixed;left:12px;bottom:56px;z-index:2147483001;max-width:min(92vw,420px);padding:10px 12px;border-radius:12px;",
    "background:#fff;color:#101828;box-shadow:0 12px 32px -12px rgba(16,24,40,.5);font:500 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif}",
  ].join("");
  var style = el("style"); style.textContent = CSS; document.head.appendChild(style);

  // ── the bar itself ───────────────────────────────────────────────────────────
  var bar = el("div", "augur-draftbar"); bar.hidden = true;
  var list = el("div", "augur-draft__list"); list.hidden = true;
  var panel = el("div", "augur-draft__panel"); panel.hidden = true;
  var noteBox = el("div", "augur-draft__note"); noteBox.hidden = true;
  document.body.appendChild(bar); document.body.appendChild(list);
  document.body.appendChild(panel); document.body.appendChild(noteBox);

  var noteTimer = null;
  function note(text) {
    noteBox.textContent = text; noteBox.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { noteBox.hidden = true; }, 6000);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(text, cls, onClick) {
    var b = el("button", cls, text); b.type = "button"; b.addEventListener("click", onClick); return b;
  }

  function renderMain(drafts) {
    clear(bar); clear(list);
    state.drafts = drafts || [];
    if (!state.drafts.length) { bar.hidden = true; list.hidden = true; return; }
    var n = state.drafts.length;
    bar.appendChild(el("span", "augur-draft__text", n === 1 ? "1 draft open" : n + " drafts open"));
    bar.appendChild(button(list.hidden ? "Show" : "Hide", "is-quiet", function () {
      list.hidden = !list.hidden; this.textContent = list.hidden ? "Show" : "Hide";
    }));
    bar.appendChild(button("History", "is-quiet", history));
    state.drafts.forEach(function (d) {
      var row = el("a", "augur-draft__row" + (d.active ? "" : " is-idle"));
      row.href = UNIT + "@" + d.id + "/";
      row.appendChild(face(d));
      row.appendChild(el("span", "augur-draft__text", label(d)));
      row.appendChild(el("span", "augur-draft__dim", ago(d.lastSaveAt || d.openedAt, d.lastSaveAt ? "saved" : "opened")));
      list.appendChild(row);
    });
    bar.hidden = false;
    faces(list);
  }

  function renderDraft(card) {
    clear(bar); list.hidden = true;
    state.card = card;
    bar.appendChild(face(card));
    bar.appendChild(el("span", "augur-draft__text", label(card)));
    bar.appendChild(el("span", "augur-draft__dim", card.closedAt
      ? "landed"
      : ago(card.lastSaveAt || card.openedAt, card.lastSaveAt ? "saved" : "opened")));
    if (canWrite && !card.closedAt) {
      bar.appendChild(button("Land", "", land));
      bar.appendChild(button("Discard", "is-quiet", discard));
    }
    bar.appendChild(button("History", "is-quiet", history));
    var main = el("a", "augur-draft__dim", "Main"); main.href = UNIT; bar.appendChild(main);
    bar.hidden = false;
    faces(bar);
  }

  // ── the verbs ────────────────────────────────────────────────────────────────
  var busy = false;
  function land() {
    if (busy || !state.card) return;
    busy = true;
    api("land", { draftId: DRAFT, baseRevision: state.card.baseRevision, note: "" }).then(function (r) {
      busy = false;
      if (r.ok) { go(UNIT); return; }
      if (r.__status === 409 && r.error === "main-moved") {
        var n = (r.changed || []).length + (r.removed || []).length;
        note("Main has moved since this draft began (" + n + (n === 1 ? " file" : " files") + "). Sync the draft and land again.");
      } else if (r.__status === 409 && r.error === "landing-in-progress") {
        note("Another landing is in progress on this prototype. Try again in a moment.");
      } else if (r.__status === 409 && r.error === "would-unpublish") {
        note("This draft has no files, so landing it would take the prototype down. Nothing was changed.");
      } else if (r.__status === 403) {
        note(r.message || "This account cannot land drafts.");
      } else {
        note("The landing was refused: " + (r.error || r.__status) + ".");
      }
    }).catch(function () { busy = false; note("The landing could not be sent. Check the connection and try again."); });
  }
  function discard() {
    if (busy) return;
    if (!confirm("Discard this draft? Every save it holds is gone for good; the prototype's real URL is untouched.")) return;
    busy = true;
    api("discard", { draftId: DRAFT }).then(function (r) {
      busy = false;
      if (r.closed) { go(UNIT); return; }
      note(r.message || "The draft could not be discarded: " + (r.error || r.__status) + ".");
    }).catch(function () { busy = false; note("The discard could not be sent."); });
  }
  function history() {
    if (!panel.hidden) { panel.hidden = true; return; }
    api("history").then(function (h) {
      clear(panel);
      if (h.__status !== 200) { note("History is not available right now."); return; }
      panel.appendChild(el("h2", null, "Landings"));
      (h.landings || []).forEach(function (l) {
        var row = el("div", "augur-draft__landing");
        row.appendChild(face(l));
        var text = el("div");
        var who = l.by === "live" ? "Adopted from the live site" : label(l);
        text.appendChild(el("div", null, "#" + l.revision + " · " + who));
        var meta = (l.note ? l.note + " · " : "") + ago(l.at, "landed")
          + (l.restoredFrom ? " · restored from #" + l.restoredFrom : "")
          + " · " + l.files + (l.files === 1 ? " file" : " files");
        text.appendChild(el("small", null, meta));
        row.appendChild(text);
        if (canWrite && l.revision !== h.revision) {
          row.appendChild(button("Restore", "", function () { restore(l.revision); }));
        } else {
          row.appendChild(el("span", "augur-draft__dim", l.revision === h.revision ? "current" : ""));
        }
        panel.appendChild(row);
      });
      panel.hidden = false;
      faces(panel);
    }).catch(function () { note("History could not be loaded."); });
  }
  function restore(revision) {
    if (busy) return;
    if (!confirm("Land revision #" + revision + " as a new landing? Nothing is rewritten; history keeps every step.")) return;
    busy = true;
    api("restore", { revision: revision, note: "restored revision " + revision }).then(function (r) {
      busy = false;
      if (r.ok) { panel.hidden = true; reloadMain(); return; }
      note("The restore was refused: " + (r.error || r.__status) + ".");
    }).catch(function () { busy = false; note("The restore could not be sent."); });
  }

  // ── reloading, past the service worker ───────────────────────────────────────
  // Main pages are served stale-while-revalidate by the service worker, so a plain reload
  // after a landing would paint the previous landing first. Ask the worker to drop this
  // URL, wait for its answer (or half a second), then reload — after the moment the
  // engine's own manifest cache needs to notice the landing on every isolate.
  function evict(url) {
    return new Promise(function (resolve) {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) { resolve(); return; }
      var done = false, finish = function () { if (!done) { done = true; resolve(); } };
      try {
        var ch = new MessageChannel();
        ch.port1.onmessage = finish;
        sw.postMessage({ t: "evict", url: url }, [ch.port2]);
      } catch (e) { finish(); }
      setTimeout(finish, 500);
    });
  }
  function reloadMain() {
    evict(location.href).then(function () { setTimeout(function () { location.reload(); }, 1500); });
  }

  // ── the socket ───────────────────────────────────────────────────────────────
  var tries = 0, pingTimer = null;
  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var ws;
    try { ws = new WebSocket(proto + location.host + "/__unit/socket?" + unitQ + (DRAFT ? "&draft=" + DRAFT : "")); }
    catch (e) { return; }
    ws.onopen = function () {
      tries = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { try { ws.send("ping"); } catch (e) { /* closing */ } }, 25000);
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.t) return;
      if (DRAFT) {
        if (m.draftId !== DRAFT) { refresh(); return; }
        if (m.t === "save") location.reload();
        else if (m.t === "land" || m.t === "discard") go(UNIT);
      } else {
        if (m.t === "land") reloadMain();
        else refresh();
      }
    };
    ws.onclose = function () {
      clearInterval(pingTimer);
      if (tries >= 6) return; // a minute of trying is enough; the next visit connects again
      var wait = Math.min(30000, 1000 * Math.pow(2, tries++));
      setTimeout(connect, wait);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* already closed */ } };
  }

  // ── first paint ──────────────────────────────────────────────────────────────
  function refresh() {
    if (DRAFT) {
      api("draft", null, "&draft=" + DRAFT).then(function (card) {
        if (card.__status !== 200) { bar.hidden = true; return; }
        renderDraft(card);
      }).catch(function () { /* the bar simply does not appear */ });
    } else {
      api("presence").then(function (p) {
        if (p.__status !== 200) { bar.hidden = true; return; }
        renderMain(p.drafts);
      }).catch(function () { /* same */ });
    }
  }
  refresh();
  connect();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
```

- [ ] **Step 4: Ship it from the build**

In `build.js`, next to `const SRC_REVIEW = …` (line ~155) add:

```js
const SRC_DRAFTS_UI = path.join(ROOT, "src", "drafts", "drafts.js");
```

Next to `await fs.copyFile(SRC_REVIEW, path.join(DIST, "__review", "comments.js"));` (line ~7935) add:

```js
  // The draft bar (drafts that land): appended to unit pages at serve time by the worker.
  await fs.mkdir(path.join(DIST, "__drafts"), { recursive: true });
  await fs.copyFile(SRC_DRAFTS_UI, path.join(DIST, "__drafts", "drafts.js"));
```

In `ENGINE_CHROME` (line ~8082), after `"__review/comments.js", …` add the entry `"__drafts/drafts.js",` on its own line. Task 7 already added `/__drafts/` to the worker's mirror `ENGINE_CHROME_PATHS`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/chrome-drafts.test.mjs test/chrome-bundle.test.mjs`
Expected: PASS. If the engine-only build's purity check (`build.js`, "asserts this list is exhaustive") names `__drafts/drafts.js`, the `ENGINE_CHROME` entry is missing or misspelled.

- [ ] **Step 6: Commit**

```bash
git add src/drafts/drafts.js build.js test/chrome-drafts.test.mjs
git commit -m "chrome: the draft bar — whose draft, when it saved, Land, Discard, History, live reload

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Chips on the gallery, and a service worker that can be asked to forget

**Files:**
- Modify: `build.js` (`DRAFTS_JS`, `.draft-chip` CSS in `PAGE_CSS`, `CHROME_JS_BODY`, `FACE_JS` export, `SW_SRC`)
- Test: `test/chrome-drafts.test.mjs`

**Interfaces:**
- Consumes: `GET /__unit/drafts` → `{units: {unit: [{id, owner, session, active, lastSaveAt, openedAt, name, initials, color}]}}`; `window.__gvFacesWire()`.
- Produces: `.draft-chips` host + one `.draft-chip` link per open draft on a prototype card (`.card-proto`), one `.draft-chip--count` on a folder card (`.card-opp`) summing drafts beneath it; `window.__gvDraftsWire`. In `sw.js`: a `message` handler for `{t:"evict", url}` that deletes that URL from the cache and answers `{ok:true}` on the reply port.

- [ ] **Step 1: Write the failing tests**

Append to `test/chrome-drafts.test.mjs`:

```js
test("the chrome bundle carries the chips: one fetch of /__unit/drafts, a link per draft, a count per folder", () => {
  const js = chromeJs();
  assert.ok(js.includes("fetch('/__unit/drafts'"), "the chips ask the workspace-wide index");
  assert.ok(js.includes("window.__gvDraftsWire = wire"), "re-wirable like marks and faces");
  assert.ok(js.includes("'draft-chip'"), "the chip class");
  assert.ok(js.includes("draft-chip--count"), "the folder count");
  assert.ok(js.includes("window.__gvFacesWire"), "chips get faces through the shared resolver");
  assert.ok(/window\.__gvFaceWire\s*=\s*wire/.test(js), "FACE_JS exposes its wire()");
  assert.ok(js.indexOf("fetch('/__unit/drafts'") > js.indexOf("window.__gvFacesWire = wire"), "faces are defined before the chips call them");
  const css = chromeCss();
  for (const sel of [".draft-chips {", ".draft-chip {", ".draft-chip.is-idle", ".draft-chip__who", ".draft-chip__text", ".draft-chip--count"]) {
    assert.ok(css.includes(sel), `chrome css has ${sel}`);
  }
});

test("sw.js forgets a URL when a page asks, and never caches a draft address", () => {
  const sw = readFileSync(path.join(dist, "sw.js"), "utf8");
  assert.ok(sw.includes('addEventListener("message"'), "the evict handler is wired");
  assert.ok(sw.includes('d.t !== "evict"'), "it answers only evict");
  assert.ok(sw.includes("ignoreSearch: true"), "a URL is forgotten whatever its query");
  assert.ok(sw.includes("DRAFT_SEGMENT_RE"), "the tested decision logic rides along (Task 1)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chrome-drafts.test.mjs`
Expected: the two new tests FAIL (`/__unit/drafts` absent from the bundle; no `message` handler in `sw.js`).

- [ ] **Step 3: Write the chips**

In `build.js`, directly after `MARKS_JS` (before `const IC_PLUS`), add:

```js
// Draft chips — the gallery's face of drafts that land (docs/drafts-that-land.md §5).
//
// One fetch per page with cards, answered by the unit objects through the open-drafts hint
// (`GET /__unit/drafts`); then one chip per open draft on its prototype's card, and one
// count on a folder card for the drafts beneath it. A CHIP IS A LINK to the draft address:
// unlike a working mark, a draft is somewhere a person can go and look. Presence is derived
// server-side (active within five minutes) — an idle chip is dimmed, never removed, because
// the draft is still there. Re-wired on visibility and once a minute; the socket that makes
// a unit's own page live is not on the gallery, and does not need to be.
const DRAFTS_JS = `
(function(){
  function norm(p){
    var s = String(p == null ? '' : p).trim();
    if(!s) return '';
    try { s = decodeURIComponent(s); } catch(e){}
    s = s.replace(/^\\.\\//, '').replace(/\\/{2,}/g, '/');
    if(!s || s === '/') return '/';
    return '/' + s.replace(/^\\/+/, '').replace(/\\/+$/, '') + '/';
  }
  function pathOf(card){
    var a = card.querySelector('a.preview-link[href], a[href]');
    if(!a) return '';
    try { return norm(new URL(a.getAttribute('href'), location.href).pathname); } catch(e){ return ''; }
  }
  function when(iso){
    var ms = Date.now() - Date.parse(iso || '');
    if(!(ms >= 0)) return '';
    var m = Math.round(ms / 60000);
    return m < 1 ? 'saved just now' : m < 60 ? 'saved ' + m + ' min ago' : 'saved ' + Math.round(m / 60) + ' h ago';
  }
  function hostOf(card){
    var pv = card.querySelector('.preview') || card;
    var host = pv.querySelector(':scope > .draft-chips');
    if(!host){ host = document.createElement('span'); host.className = 'draft-chips'; pv.appendChild(host); }
    return host;
  }
  function chip(card, d, unit){
    var a = document.createElement('a');
    a.className = 'draft-chip' + (d.active ? '' : ' is-idle');
    a.href = unit + '@' + d.id + '/';
    a.title = (d.name || 'Someone') + (d.session ? ' \\u00b7 ' + d.session : '') + ' \\u2014 ' + when(d.lastSaveAt || d.openedAt);
    var who = document.createElement('span');
    who.className = 'draft-chip__who';
    who.textContent = d.initials || '?';
    if(d.color) who.style.backgroundColor = d.color;
    if(d.owner) who.setAttribute('data-person', d.owner);
    var t = document.createElement('span');
    t.className = 'draft-chip__text';
    t.textContent = d.session || d.name || 'draft';
    a.appendChild(who); a.appendChild(t);
    hostOf(card).appendChild(a);
  }
  function count(card, n){
    var s = document.createElement('span');
    s.className = 'draft-chip draft-chip--count';
    var t = document.createElement('span');
    t.className = 'draft-chip__text';
    t.textContent = n + (n === 1 ? ' draft open' : ' drafts open');
    s.appendChild(t);
    hostOf(card).appendChild(s);
  }
  function clear(){ [].forEach.call(document.querySelectorAll('.draft-chips'), function(h){ h.remove(); }); }
  function wire(){
    var cards = [].slice.call(document.querySelectorAll('.card-proto, .card-opp'));
    if(!cards.length) return;
    fetch('/__unit/drafts', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        clear();
        if(!d || !d.units) return;
        var units = Object.keys(d.units);
        if(!units.length) return;
        cards.forEach(function(card){
          var p = pathOf(card);
          if(!p) return;
          if(d.units[p]){ d.units[p].forEach(function(dr){ chip(card, dr, p); }); return; }
          var n = 0;
          units.forEach(function(u){ if(u.indexOf(p) === 0) n += d.units[u].length; });
          if(n) count(card, n);
        });
        if(window.__gvFacesWire) window.__gvFacesWire();
      })
      .catch(function(){ /* a chip may never be the reason a gallery looks broken */ });
  }
  window.__gvDraftsWire = wire;
  wire();
  setInterval(function(){ if(!document.hidden) wire(); }, 60000);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) wire(); });
})();`;
```

In `CHROME_JS_BODY`, append `DRAFTS_JS` after `MARKS_JS`:

```js
const CHROME_JS_BODY = [
  CAROUSEL_JS, chromeScript(), STATUS_JS, CURRENCY_JS, COMP_STATUS_JS, CARD_MENU_JS,
  PINS_JS, PROFILE_JS, SETTINGS_JS, NEWCANVAS_JS, SPACE_JS, WORKSPACES_JS, TABBAR_JS(),
  RESEARCH_JS, FACE_JS, MARKS_JS, DRAFTS_JS,
].join("\n;\n") + "\n;\n" +
```

In `FACE_JS`, find its final `wire();` call (end of the IIFE) and make it:

```js
  window.__gvFacesWire = wire;
  wire();
```

(If `FACE_JS` already exposes `window.__gvFacesWire`, leave it.)

In `PAGE_CSS`, directly after the `.mark-badge__text { … }` rule, add:

```css
    /* Draft chips — one per open draft on a prototype card, a count on a folder card.
       Bottom-left so they never fight the mark badge (top-right) or the status chip. */
    .draft-chips {
      position: absolute; left: 8px; bottom: 8px; z-index: 3;
      display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
      max-width: calc(100% - 16px);
    }
    .draft-chip {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      padding: 3px 9px 3px 4px; border-radius: 999px; text-decoration: none;
      background: #fff; box-shadow: 0 2px 8px -1px rgba(16,24,40,0.32);
      font-size: 11.5px; font-weight: 600; letter-spacing: -0.005em; color: #101828;
    }
    .draft-chip:hover { box-shadow: 0 4px 12px -2px rgba(16,24,40,0.4); }
    .draft-chip.is-idle { opacity: .72; }
    .draft-chip__who {
      flex: none; width: 16px; height: 16px; border-radius: 50%;
      display: inline-grid; place-items: center;
      font-size: 8px; font-weight: 700; letter-spacing: 0; color: #fff;
      background-color: var(--faint); background-position: center;
    }
    .draft-chip__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .draft-chip--count { pointer-events: none; padding-left: 9px; }
```

- [ ] **Step 4: Teach the service worker to forget one URL**

In `SW_SRC` (build.js), after the `activate` listener and before the `fetch` listener, add:

```js
// A page that has just learned its unit landed asks for its own cached copy to go before it
// reloads — stale-while-revalidate would otherwise paint the previous landing first. The
// reply port lets the page wait for the delete rather than guess at it.
self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.t !== "evict" || typeof d.url !== "string") return;
  const reply = () => { if (e.ports && e.ports[0]) e.ports[0].postMessage({ ok: true }); };
  const work = caches.open(CACHE).then((c) => c.delete(d.url, { ignoreSearch: true })).then(reply, reply);
  if (e.waitUntil) e.waitUntil(work);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/chrome-drafts.test.mjs test/chrome-bundle.test.mjs test/runtime-chrome-parity.test.mjs test/sw-logic.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add build.js test/chrome-drafts.test.mjs
git commit -m "chrome: draft chips on gallery cards, and a service worker a page can ask to forget one URL

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The member's browser, over the real worker

**Files:**
- Modify: `test/fixtures/unit-server.mjs`
- Test: `test/drafts-browser-drill.test.mjs` (new)

**Interfaces:**
- Fixture: `startUnitServer({ live, tenantId, users })` — content responses pass through `withDraftUi` with the cookie's identity; `/__unit/` and `/__publish/` as before.

- [ ] **Step 1: Extend the fixture**

Replace `test/fixtures/unit-server.mjs` with:

```js
// test/fixtures/unit-server.mjs — the real worker, over a socket, on the drafts env.
// Content goes through assetFetch and then the draft bar's injection, with whatever the
// cookie says about who is asking — the same two steps the request handler takes for a
// unit page, minus the chrome recomposition (RUNTIME_CHROME is off here) and the
// live-reload poll (HTMLRewriter does not exist in Node).
import http from "node:http";
import { __testables as W } from "../../src/_worker.js";
import { makeEnv, ctxFor } from "./unit-env.mjs";

export async function startUnitServer({ live, tenantId, users }) {
  const env = await makeEnv({ live });
  const ctx = users ? ctxFor(tenantId, users) : ctxFor(tenantId);
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId } });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "https://x.test");
    const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    let out;
    if (url.pathname.startsWith("/__unit/")) out = await W.unitApi(ctx, request, url, env);
    else if (url.pathname.startsWith("/__publish/")) out = await W.publishApi(ctx, request, url, env);
    else {
      const asset = await W.assetFetch(tenantId, env, request);
      const me = req.headers.cookie && ctx.USERS.length
        ? await W.identify(request, env, ctx.USERS, { sessionKeys: ctx.SESSION_KEYS, tctx: ctx })
        : null;
      out = await W.withDraftUi(ctx, asset, url, me, env);
    }
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { env, ctx, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
```

- [ ] **Step 2: Write the drill**

Create `test/drafts-browser-drill.test.mjs`:

```js
// test/drafts-browser-drill.test.mjs — docs/drafts-that-land.md §5, automated: an agent
// opens and saves from the terminal; a member's browser sees the chip, opens the draft
// address with the bar on it, lands it from the bar; the chip is gone and history says who.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUnitServer } from "./fixtures/unit-server.mjs";
import { manifestOf, remember, cookieFor, ADA_MEMBER, VERA } from "./fixtures/unit-env.mjs";
import { unitClient, doOpen, doSave, readState } from "../scripts/lib/draft.mjs";

const U = "/checkout/flow/";
const INDEX = remember("<!doctype html><html><body><h1>flow</h1>\n<p>one</p>\n</body></html>");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "augur-bdrill-"));
process.env.AUGUR_DRAFTS_REGISTRY = path.join(tmp(), "drafts.json");
const idOf = (address) => /@([a-z0-9]{6})\/$/.exec(address)[1];
const asJson = async (r) => ({ status: r.status, body: await r.json() });

test("a member's browser: chip, bar, land from the bar, history names them", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "bdrill-1", users: [ADA_MEMBER, VERA] });
  try {
    // An agent opens and saves from the terminal.
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "checkout pass" });
    const dir = tmp();
    const o = await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "checkout pass", now: new Date().toISOString() });
    assert.equal(o.ok, true, JSON.stringify(o));
    fs.writeFileSync(path.join(dir, "index.html"), INDEX.replace("<h1>flow</h1>", "<h1>Flow</h1>"));
    assert.equal((await doSave({ client: c, dir })).ok, true);
    const address = readState(dir).address, draftId = idOf(address);

    const ada = { Cookie: await cookieFor(srv.env, ADA_MEMBER) };
    const vera = { Cookie: await cookieFor(srv.env, VERA) };

    // The gallery's chip: one draft on this unit, with a face and a session label.
    const idx = await asJson(await fetch(`${srv.origin}/__unit/drafts`, { headers: ada }));
    assert.equal(idx.status, 200);
    assert.equal(idx.body.units[U].length, 1);
    assert.equal(idx.body.units[U][0].session, "checkout pass");
    assert.equal(idx.body.units[U][0].name, "Ada");
    assert.equal(idx.body.units[U][0].id, draftId);

    // A stranger at the draft address: the bytes as saved, no bar, nothing about people.
    const anon = await fetch(`${srv.origin}${address}`);
    const anonText = await anon.text();
    assert.match(anonText, /<h1>Flow<\/h1>/);
    assert.doesNotMatch(anonText, /__drafts\/drafts\.js/);

    // A member at the draft address: the same bytes, plus the bar's boot naming this draft.
    const page = await (await fetch(`${srv.origin}${address}`, { headers: ada })).text();
    assert.match(page, /<h1>Flow<\/h1>/);
    assert.match(page, /<script defer src="\/__drafts\/drafts\.js"><\/script><\/body>/);
    const boot = JSON.parse(/window\.__augurDraft=(\{.*?\})<\/script>/.exec(page)[1]);
    assert.equal(boot.unit, U);
    assert.equal(boot.draft, draftId);
    assert.equal(boot.me.id, idx.body.units[U][0].owner, "the bar knows the viewer is the draft's owner");
    assert.equal(boot.me.role, "editor");
    const main = await (await fetch(`${srv.origin}${U}`, { headers: ada })).text();
    assert.match(main, /<h1>flow<\/h1>/, "main has not moved");
    assert.match(main, /"draft":null/, "the bar on main names no draft");

    // What the bar reads: the draft's card.
    const card = await asJson(await fetch(`${srv.origin}/__unit/draft?unit=${encodeURIComponent(U)}&draft=${draftId}`, { headers: ada }));
    assert.equal(card.status, 200);
    assert.equal(card.body.baseRevision, 1);
    assert.equal(card.body.files, 1);
    assert.equal(card.body.name, "Ada");

    // A viewer may look at all of that and may not land.
    assert.equal((await fetch(`${srv.origin}/__unit/presence?unit=${encodeURIComponent(U)}`, { headers: vera })).status, 200);
    const veraLands = await asJson(await fetch(`${srv.origin}/__unit/land`, { method: "POST", headers: { ...vera, "content-type": "application/json" },
      body: JSON.stringify({ unit: U, draftId, baseRevision: card.body.baseRevision }) }));
    assert.equal(veraLands.status, 403);

    // Ada lands from the bar.
    const landed = await asJson(await fetch(`${srv.origin}/__unit/land`, { method: "POST", headers: { ...ada, "content-type": "application/json" },
      body: JSON.stringify({ unit: U, draftId, baseRevision: card.body.baseRevision, note: "looked good" }) }));
    assert.equal(landed.status, 200, JSON.stringify(landed.body));
    assert.equal(landed.body.ok, true);
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<h1>Flow<\/h1>/, "the real URL moved");

    // The chip is gone; history says who, from where, and why.
    const after = await asJson(await fetch(`${srv.origin}/__unit/drafts`, { headers: ada }));
    assert.deepEqual(after.body.units, {});
    const h = await asJson(await fetch(`${srv.origin}/__unit/history?unit=${encodeURIComponent(U)}`, { headers: ada }));
    assert.equal(h.body.landings[0].note, "looked good");
    assert.equal(h.body.landings[0].name, "Ada");
    assert.equal(h.body.landings[0].session, "browser");
    assert.equal(h.body.landings[1].by, "live");
  } finally { await srv.close(); }
});

test("restore from the history panel lands an earlier revision as a new one", async () => {
  const srv = await startUnitServer({ live: manifestOf(5, { [U]: { "index.html": INDEX } }), tenantId: "bdrill-2", users: [ADA_MEMBER] });
  try {
    const c = unitClient({ origin: srv.origin, token: "tok", space: "alpha", session: "s" });
    const dir = tmp();
    await doOpen({ client: c, unit: U, dir, origin: srv.origin, space: "alpha", session: "s", now: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, "index.html"), INDEX.replace("<p>one</p>", "<p>two</p>"));
    await doSave({ client: c, dir });
    const draftId = idOf(readState(dir).address);
    const ada = { Cookie: await cookieFor(srv.env, ADA_MEMBER), "content-type": "application/json" };
    const card = (await asJson(await fetch(`${srv.origin}/__unit/draft?unit=${encodeURIComponent(U)}&draft=${draftId}`, { headers: ada }))).body;
    assert.equal((await fetch(`${srv.origin}/__unit/land`, { method: "POST", headers: ada, body: JSON.stringify({ unit: U, draftId, baseRevision: card.baseRevision, note: "two" }) })).status, 200);
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<p>two<\/p>/);
    const restored = await asJson(await fetch(`${srv.origin}/__unit/restore`, { method: "POST", headers: ada, body: JSON.stringify({ unit: U, revision: 1, note: "restored revision 1" }) }));
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.match(await (await fetch(`${srv.origin}${U}`)).text(), /<p>one<\/p>/, "revision 1's bytes are live again");
    const h = (await asJson(await fetch(`${srv.origin}/__unit/history?unit=${encodeURIComponent(U)}`, { headers: ada }))).body;
    assert.equal(h.revision, 3, "history is never rewritten: the restore is a third landing");
    assert.equal(h.landings[0].restoredFrom, 1);
    assert.equal(h.landings[0].name, "Ada");
  } finally { await srv.close(); }
});
```

- [ ] **Step 3: Run the drill**

Run: `node --test test/drafts-browser-drill.test.mjs`
Expected: PASS, 2 tests. If the member fetch of the draft address carries no bar, check that `ctx.USERS` in the fixture holds `passHash` (see Task 3 Step 5).

- [ ] **Step 4: Run everything**

Run: `npm test && npm run check`
Expected: green. If `no-tenant-globals` names a new binding, the new module-scope values in `src/_worker.js` are `DRAFT_UI_SRC` (a string), `DRAFTS_INDEX_MAX` (a number) and four functions/arrows — none of which it should flag; if it flags one anyway, add it to the allowlist in `scripts/no-tenant-globals.mjs` with a one-line reason beside `RESERVED_UNIT_FOLDERS`.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/unit-server.mjs test/drafts-browser-drill.test.mjs
git commit -m "units: the member's browser drill — chip, bar, land from the bar, restore from history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The spec names what now exists

**Files:**
- Modify: `docs/drafts-that-land.md` (§6.2)

- [ ] **Step 1: Correct the route shape and the credential**

In §6.2, replace the paragraph:

> All under `/__unit/<unit path>/…`, bearer auth with the existing person token, session
> label in a header. Space-scoped publish tokens map onto the units under that space.

with:

```markdown
All under `/__unit/<verb>`, the unit named in the body (`unit`) or the query (`?unit=`).
Two credentials open the same verbs: a bearer publish token (the CLI, session label in the
`X-Augur-Session` header) or the member's session cookie (the browser, session `browser`).
Space-scoped publish tokens map onto the units under that space. A viewer may read and may
not write. A landing made from the browser is recorded exactly as one made from the
terminal: same person id, same history row.
```

- [ ] **Step 2: Add the three verbs to the table**

After the `presence` row, add:

```markdown
| `drafts` (GET, names no unit) | – | `{units: {"<unit>": [presence rows with `name`, `initials`, `color`]}}` — every open draft in the workspace; what the gallery's chips read |
| `draft` (GET) | `?draft=<id>` | one draft's card: owner, session, base and draft revision, file count — never the table |
| `socket` (GET, `Upgrade: websocket`) | `?draft=<id>` optional | a live tab's subscription; the object sends `{t: open\|save\|land\|discard, draftId, revision?, at}` for every verb that succeeded |
```

- [ ] **Step 3: Lint and commit**

Run: `npm run check`
Expected: green (no product words entered).

```bash
git add docs/drafts-that-land.md
git commit -m "Design: drafts that land — the route shape as built, the cookie credential, the three read verbs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Manual verify after Task 11 (on a real instance)

Prerequisite: `UNITS` bound in the hosted shell's `wrangler.toml` (the commented block in `templates/shell/wrangler.example.toml`), migration tag applied, worker deployed with this engine.

1. From a terminal: `augur open <opportunity>/<prototype>`, edit `index.html`, `augur save`.
2. In a browser signed in as an editor, open the gallery: the prototype's card shows one chip (face, session label); the folder card on the landing grid shows "1 draft open". Click the chip: the draft address opens with the bar at bottom-left naming the session and "saved N min ago".
3. In the terminal, edit and `augur save` again: the browser tab reloads on its own within a second. Open the same draft address in a second tab signed in as a viewer: the bar shows no Land or Discard.
4. Open the prototype's real URL in a third tab. In the first tab press **Land**: the first tab navigates to the real URL; the third tab reloads about two seconds later and shows the change; the gallery chip is gone on its next refresh.
5. Press **History** on the real URL's bar: two landings (the adoption and yours). Press **Restore** on the adoption: the page reloads with the old bytes; History now shows three.
6. In the terminal, `augur open` again, then in the browser press **Discard** on the new draft: the tab returns to the real URL and `augur status` no longer lists the draft (its folder can be closed with `augur close`).
7. Signed out, open the prototype's real URL (public): no bar, no chips, no request to `/__unit/`. Open the draft address signed out: the gate.
