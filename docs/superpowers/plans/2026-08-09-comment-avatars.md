# Faces on comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A comment written by someone with an Augur account renders as their photo (or their initials) on the pin, the hover card, each thread message and the reply bar; a comment with no account behind it keeps today's numbered blue pin.

**Architecture:** The worker stamps a one-way `personId(email)` onto every message it already authenticates, and a new ungated `GET /__people?ids=…&names=…` resolves those ids to `{name, initials, color, avatar}` without ever exposing an email or allowing roster enumeration. The overlay fetches the people it needs once per page, caches them, and renders one shared avatar element across all four surfaces.

**Tech Stack:** Vanilla ES5-style JS in a single IIFE (`src/review/comments.js`), a Cloudflare Worker (`src/_worker.js`), `node --test` + `node:assert/strict` for unit tests, `npm run offline` (wrangler running the real worker locally) for visual verification. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-comment-avatars-design.md`

## Global Constraints

- **`src/review/comments.js` is ES5-flavoured:** `var`, `function`, no arrow functions, no template literals, no `const`/`let`. Match the surrounding code exactly.
- **Never `innerHTML` user-supplied text.** Author names, initials and bodies go through `textContent` or built nodes (`comments.js:549`).
- **All overlay UI stays inside the shadow root** (`comments.js:208`). No styles leak to the host page.
- **No new dependencies.** No CDN, no npm package, no external asset. The overlay ships as one self-contained file.
- **Every new message field round-trips through both** `mutate`/`apiCall` **and** `applyLocal` (`comments.js:88–108`).
- **White chrome only.** No `prefers-color-scheme: dark` variant.
- **Node >= 18.** Unit tests run with `npm test` (`node --test "test/*.test.mjs"`).
- **The cat annotation pin (`.pin.anno`) is out of scope** and must not change behaviour.
- **Anonymous comments must look exactly as they do today:** a blue numbered `.pin`.

> ⚠️ **Before running `npm run offline`:** if `.env.deploy` holds Cloudflare credentials, the local worker reads and writes **production KV** — test comments you leave will be live for everyone. Rename `.env.deploy` first for a local-only KV sandbox (the script then logs `KV: local`). See the header of `scripts/offline.mjs`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/_worker.js` | `personId`, the `by` stamp, the `/__people` endpoint, its public-path bypass, `id` on the profile projections | Modify |
| `test/worker.test.mjs` | Unit tests for all of the above | Modify |
| `src/review/comments.js` | People cache, resolution chain, `avatarEl()`, the three rendered states, sidebar rows | Modify |
| `src/review/COMMENTING-UX.md` | Mark the "no avatars" decisions superseded | Modify |

Tasks 1–2 are server-side and fully unit-tested. Tasks 3–6 are overlay changes; **this repo has no unit-test harness for `comments.js`** — it is a static IIFE, not an importable module — so those tasks are verified in `npm run offline` against exact, checkable observations, which is how the rest of the overlay is verified today. Do not invent a test harness for it.

---

### Task 1: `personId` and the `by` stamp

**Files:**
- Modify: `src/_worker.js` (near `colorFor`, ~line 380; `publicUser` ~line 420; `sanitizeMsg` ~line 1983; `__testables` ~line 3036)
- Test: `test/worker.test.mjs`

**Interfaces:**
- Produces: `personId(email) -> string` (base36, stable per lowercased address, independent of the avatar). `sanitizeMsg(m, me)` now returns `{author, verified, by, body, at}` where `by` is `personId(me.email)` or `null`. `publicUser(u)` gains `id`.
- Consumes: existing `lcEmail(email)` and `avatarKey(u)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```js
test("personId is stable per address and independent of the photo", () => {
  const a = W.personId("rob@example.test");
  assert.equal(a, W.personId("  ROB@Example.Test  "), "case- and space-insensitive");
  assert.match(a, /^[a-z0-9]+$/, "base36");
  assert.notEqual(a, W.personId("ana@example.test"));
  // avatarKey hashes email + photo length; personId must not, or a new photo
  // would orphan every past comment.
  const u1 = { email: "rob@example.test", avatar: "data:image/png;base64,AAAA" };
  const u2 = { email: "rob@example.test", avatar: "data:image/png;base64,AAAAAAAA" };
  assert.notEqual(W.avatarKey(u1), W.avatarKey(u2), "avatarKey changes with the photo");
  assert.equal(W.personId(u1.email), W.personId(u2.email), "personId does not");
});

test("sanitizeMsg stamps `by` from the session, never from the request body", () => {
  const me = { email: "rob@example.test", name: "Rob" };
  const signed = W.sanitizeMsg({ author: "Someone Else", body: "hi", by: "forged" }, me);
  assert.equal(signed.author, "Rob");
  assert.equal(signed.verified, true);
  assert.equal(signed.by, W.personId("rob@example.test"));

  const anon = W.sanitizeMsg({ author: "Marta", body: "hi", by: "forged", verified: true }, null);
  assert.equal(anon.author, "Marta");
  assert.equal(anon.verified, false);
  assert.equal(anon.by, null, "an unauthenticated write can never carry an identity");
});

test("publicUser exposes the person id but never a password", () => {
  const u = { email: "rob@example.test", name: "Rob", pass: "secret", role: "admin" };
  const p = W.publicUser(u);
  assert.equal(p.id, W.personId("rob@example.test"));
  assert.equal(p.pass, undefined);
  assert.equal(W.publicUser(null), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Documents/delta-designs/augur && npm test`
Expected: FAIL — `W.personId is not a function` (and `W.sanitizeMsg`, `W.avatarKey`, `W.publicUser` undefined).

- [ ] **Step 3: Add `personId`**

In `src/_worker.js`, immediately after the `colorFor` function (~line 385):

```js
// A stable, one-way id for a person, used to attribute comments to a face without
// putting an address in KV or on the wire. Deliberately NOT avatarKey(): that hashes
// email + photo length so a changed photo yields a fresh immutable URL, which would
// orphan every past comment. This is a display-resolution key, never a credential.
function personId(email) {
  const s = lcEmail(email);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
```

- [ ] **Step 4: Stamp `by` in `sanitizeMsg`**

Replace the body of `sanitizeMsg` (~line 1983):

```js
function sanitizeMsg(m, me) {
  const { author, verified } = stampAuthor(m && m.author, me);
  return {
    author,
    verified,
    // Stamped from the session like `author` above — a `by` in the request body is
    // discarded with the rest of the caller's object.
    by: me ? personId(me.email) : null,
    body: clamp(m && m.body, 4000),
    at: clamp(m && m.at, 40) || new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Add `id` to `publicUser`**

In `publicUser` (~line 420), add `id` as the first field so `/__me` can tell the overlay who it is:

```js
function publicUser(u) {
  return u ? {
    id: personId(u.email),
    email: u.email, name: u.name,
    initials: u.initials || "", color: u.color || "#4f46e5",
    avatar: avatarUrl(u), admin: u.role === "admin",
  } : null;
}
```

- [ ] **Step 6: Export the new testables**

In the `__testables` object (~line 3036), add to the first line:

```js
  hashPassword, verifyPassword, isPassHash, safeEqual, userByEmail,
  personId, avatarKey, publicUser, stampAuthor, sanitizeMsg, applyOp,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all three new tests green, and every pre-existing test still green.

- [ ] **Step 8: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Comments carry a person id, stamped from the session"
```

---

### Task 2: `GET /__people` — resolve, never enumerate

**Files:**
- Modify: `src/_worker.js` (`isPublicPath` ~line 115; a new `peopleApi` near `publicUser`; the route table near `/__me` ~line 2826; `_instance/profiles` ~line 1114; `__testables`)
- Test: `test/worker.test.mjs`

**Interfaces:**
- Consumes: `personId` and `publicUser` from Task 1.
- Produces: `peopleApi(url, users) -> Response` with JSON body `{ people: [{id, name, initials, color, avatar}] }`. Route: `GET /__people?ids=a,b&names=Rob,Ana`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker.test.mjs`:

```js
const PEOPLE = [
  { email: "rob@example.test", name: "Rob", initials: "RA", color: "#4f46e5",
    avatar: "data:image/png;base64,AAAA" },
  { email: "ana@example.test", name: "Ana", initials: "AB", color: "#15803d" },
];
const peopleFor = async (qs) =>
  (await W.peopleApi(new URL("https://x.test/__people" + qs), PEOPLE).json()).people;

test("peopleApi answers only the ids it was asked for", async () => {
  const got = await peopleFor("?ids=" + W.personId("rob@example.test"));
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "Rob");
  assert.equal(got[0].id, W.personId("rob@example.test"));
  assert.equal(got[0].avatar, "/__avatar/" + W.avatarKey(PEOPLE[0]));
  assert.equal(got[0].email, undefined, "an address never leaves the server");
});

test("peopleApi has no enumeration mode", async () => {
  assert.deepEqual(await peopleFor(""), []);
  assert.deepEqual(await peopleFor("?ids="), []);
  assert.deepEqual(await peopleFor("?ids=nosuchid"), [], "unknown ids are omitted, not an error");
});

test("peopleApi resolves exact names for pre-`by` comments", async () => {
  const got = await peopleFor("?names=Ana");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, W.personId("ana@example.test"));
  assert.equal(got[0].avatar, null, "no photo on file");
  assert.deepEqual(await peopleFor("?names=an"), [], "exact match only, no prefix search");
});

test("peopleApi caps a request at 50 lookups", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => "id" + i)
    .concat(W.personId("rob@example.test")).join(",");
  const res = W.peopleApi(new URL("https://x.test/__people?ids=" + ids), PEOPLE);
  assert.equal(res.status, 400);
});

```

> **Corrected during execution.** A sixth test asserting `W.isPublicPath("/__people")`
> was originally listed here and has been removed: it exercised a dead branch (see
> Step 4) and gave false confidence that `isPublicPath` was what made the endpoint
> reachable. What actually makes it reachable is the route's placement above the auth
> gate in `fetch()`, which `isPublicPath` never sees.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `W.peopleApi is not a function`.

- [ ] **Step 3: Implement `peopleApi`**

In `src/_worker.js`, immediately after `publicUser` (~line 426):

```js
// GET /__people?ids=a,b&names=Rob,Ana — resolve comment authors to a face.
//
// Answers ONLY what it is asked for. There is deliberately no "list everyone" mode:
// the overlay is embedded in PUBLIC prototypes, so an enumerable roster here would
// hand the team list to anyone with a prototype link. Ids are one-way hashes, so they
// cannot be reversed to an address or guessed from one. `names` exists for comments
// written before messages carried `by`; stampAuthor guarantees a verified message's
// name belongs to a real account, so an exact-name lookup is safe for those.
//
// Ungated for the same reason /__avatar/ is: a gated fetch from a public prototype
// would return the login page instead of the data.
const PEOPLE_LOOKUP_MAX = 50;
function peopleApi(url, users = USERS) {
  const csv = (k) => (url.searchParams.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = csv("ids"), names = csv("names");
  if (ids.length + names.length > PEOPLE_LOOKUP_MAX) {
    return jsonResponse({ error: "too-many" }, 400);
  }
  const wantId = new Set(ids), wantName = new Set(names);
  const people = users
    .filter((u) => wantId.has(personId(u.email)) || wantName.has(u.name))
    .map((u) => ({
      id: personId(u.email),
      name: u.name,
      initials: u.initials || initialsFor(u.name || nameFromEmail(u.email)),
      color: u.color || colorFor(u.email),
      avatar: avatarUrl(u),
    }));
  return jsonResponse({ people }, 200, {
    // Long enough to spare a fetch per navigation, short enough that an admin-panel
    // photo swap lands within the minute.
    "Cache-Control": "private, max-age=60",
  });
}
```

`jsonResponse` currently takes `(obj, status = 200)` and hard-codes `Cache-Control: no-store`. Extend it to accept overrides rather than hand-rolling a `Response` here — every existing call site keeps working, because the new argument defaults to empty:

```js
function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
```

- [ ] **Step 4: Register the route**

> **Corrected during execution.** This step originally also added a `/__people` entry to
> `isPublicPath`. That would be **dead code**: the route below returns from `fetch()`
> long before `isPublicPath` is consulted, and that gate only serves static assets — it
> would never dispatch to an API handler. `src/_worker.js` already documents this exact
> trap for `/__invite` ("an entry would be unreachable code that reads as a safety net
> it is not"), and `/__me` and `/__avatar/` follow the early-return pattern with no
> entry. Do not add one; what makes this endpoint reachable without a session is its
> placement above the auth gate. Add a comment at the route saying so.

In `fetch()`, immediately after the `/__me` route (~line 2829):

```js
    if (url.pathname === "/__people") return peopleApi(url);
```

- [ ] **Step 5: Add `id` to the build-time profile projection**

In the `_instance` / `profiles` branch (~line 1114), so build-time editor chips and the runtime overlay speak the same id:

```js
    const profiles = USERS.map((u) => ({
      id: personId(u.email),
      email: u.email, emails: u.emails || [],
      name: u.name, initials: u.initials || "", color: u.color || "#4f46e5",
      avatar: avatarUrl(u), role: u.role === "admin" ? "admin" : "user",
    }));
```

- [ ] **Step 6: Export the new testables**

Add `peopleApi, isPublicPath, PEOPLE_LOOKUP_MAX,` to `__testables`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all five new tests green, every earlier test still green.

- [ ] **Step 8: Commit**

```bash
git add src/_worker.js test/worker.test.mjs
git commit -m "Add /__people: resolve comment authors to a face without enumeration"
```

---

### Task 3: Overlay resolution layer

**Files:**
- Modify: `src/review/comments.js` (identity block ~line 216–226; new helpers before `renderPins` ~line 532)

**Interfaces:**
- Consumes: `GET /__me` (now returns `user.id`) and `GET /__people?ids=&names=` from Tasks 1–2.
- Produces, for later tasks:
  - `personFor(msg) -> {id,name,initials,color,avatar} | null` — null means "render the anonymous numbered pin".
  - `avatarEl(person, size) -> HTMLElement` — an `<img>` disc when the person has a photo, a coloured initials `<span>` when not.
  - `loadPeople()` — fills the cache from the threads currently in `state`, then calls `render()`.
  - `ME` — the signed-in person (`{id,name,initials,color,avatar}`) or `null`.

- [ ] **Step 1: Extend the identity fetch to keep the whole profile**

Replace the `/__me` block (`comments.js:216–226`) with:

```js
  function getName() { try { return localStorage.getItem(LS_NAME) || ""; } catch (e) { return ""; } }
  function setName(n) { try { localStorage.setItem(LS_NAME, n); } catch (e) {} }

  // Who we are, if signed in. Used for the author name (as before), for the reply
  // bar's own avatar, and to attribute a comment written while the API is unreachable
  // — the localStorage path has no server to stamp `by` for it. The server rebuilds
  // every message from the session regardless, so this can't forge anything.
  var ME = null;
  var PEOPLE = {};   // id -> person
  var BYNAME = {};   // name -> person (back-compat for messages with no `by`)

  function loadMe() {
    return fetch("/__me", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.user) return;
        ME = { id: d.user.id, name: d.user.name, initials: d.user.initials,
               color: d.user.color, avatar: d.user.avatar };
        if (ME.name) setName(ME.name);
        if (ME.id) { PEOPLE[ME.id] = ME; BYNAME[ME.name] = ME; }
      })
      .catch(function () {});
  }
```

Update the existing call site so it still runs on start-up, now via `loadMe()`.

- [ ] **Step 2: Add the people cache**

Immediately after `loadMe`:

```js
  // One request for every author on this page we don't already hold. Ids come from
  // the threads themselves, so we never ask for — and can never receive — the roster.
  var peoplePending = false;
  function loadPeople() {
    var ids = {}, names = {};
    state.threads.forEach(function (t) {
      (t.messages || []).forEach(function (m) {
        if (m.by && !PEOPLE[m.by]) ids[m.by] = 1;
        // Pre-`by` comments: a verified name is guaranteed by the server to belong to
        // a real account, so it is safe to resolve. An unverified name is just a
        // string someone typed — never look it up.
        else if (!m.by && m.verified && m.author && !BYNAME[m.author]) names[m.author] = 1;
      });
    });
    var idList = Object.keys(ids), nameList = Object.keys(names);
    if (peoplePending || (!idList.length && !nameList.length)) return;
    var q = [];
    if (idList.length) q.push("ids=" + encodeURIComponent(idList.slice(0, 50).join(",")));
    if (nameList.length) q.push("names=" + encodeURIComponent(nameList.slice(0, 50).join(",")));
    peoplePending = true;
    fetch("/__people?" + q.join("&"), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        peoplePending = false;
        if (!d || !d.people) return;
        d.people.forEach(function (p) { PEOPLE[p.id] = p; BYNAME[p.name] = p; });
        render();
      })
      .catch(function () { peoplePending = false; });
  }
```

Call `loadPeople()` at the end of the function that loads threads from the API, and again after `mutate()` resolves, so a new author resolves without a reload.

- [ ] **Step 3: Add the resolution chain and the avatar element**

```js
  // Initials + a stable colour from a name alone, for a verified author we could not
  // resolve — /__people unreachable, or the localStorage fallback path with no server
  // at all. A known person must never collapse back to an anonymous number.
  var AV_COLORS = ["#4f46e5", "#0e7490", "#b45309", "#be123c", "#15803d", "#7c3aed", "#0369a1", "#a21caf"];
  function fromName(name) {
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    var ini = !parts.length ? "?"
      : (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    var h = 0, s = String(name).trim().toLowerCase();
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return { id: null, name: name, initials: ini, color: AV_COLORS[h % AV_COLORS.length], avatar: null };
  }

  // null → this comment gets today's numbered blue pin. Order matters: an id beats a
  // name, and an UNVERIFIED name resolves to nothing at all — an anonymous commenter
  // never earns a face, however they signed themselves.
  function personFor(m) {
    if (!m) return null;
    if (m.by && PEOPLE[m.by]) return PEOPLE[m.by];
    if (!m.verified || !m.author) return null;
    if (BYNAME[m.author]) return BYNAME[m.author];
    // Verified, but the roster is unavailable or hasn't answered yet.
    return fromName(m.author);
  }
  function authorOf(t) { return personFor(t && t.messages && t.messages[0]); }

  // The one avatar implementation every surface uses: photo when there is one,
  // initials on the person's colour when there isn't. Never a silhouette.
  function avatarEl(p, size) {
    var e;
    if (p && p.avatar) {
      e = document.createElement("img");
      e.src = p.avatar;
      e.alt = "";
      // A dead photo URL must degrade to initials, not a broken-image glyph.
      e.addEventListener("error", function () {
        var f = initialsEl(p, size);
        if (e.parentNode) e.parentNode.replaceChild(f, e);
      });
    } else {
      e = initialsEl(p, size);
    }
    e.className = "av";
    e.style.width = size + "px";
    e.style.height = size + "px";
    return e;
  }
  function initialsEl(p, size) {
    var s = document.createElement("span");
    s.className = "av ini";
    s.textContent = (p && p.initials) || "?";
    s.style.background = (p && p.color) || "#6b7280";
    s.style.fontSize = Math.max(9, Math.round(size * 0.4)) + "px";
    s.style.width = size + "px";
    s.style.height = size + "px";
    return s;
  }
```

- [ ] **Step 4: Attribute offline comments**

In `composeNew`'s submit (`comments.js:~1050`) and the reply handler (`:1096`), add the optimistic identity to the message object so the localStorage fallback can render a face. Reply handler becomes:

```js
      mutate({ op: "reply", id: id, message: { author: getName() || "Anonymous",
        by: ME && ME.id, verified: !!ME, body: text, at: nowIso() } })
```

Apply the same two fields to the `add` op's first message.

- [ ] **Step 5: Add the shared avatar styles**

In the stylesheet block, after the `.pin` rules (~line 252):

```js
    '.av{flex:0 0 auto;border-radius:50%;object-fit:cover;display:block;}' +
    '.av.ini{display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;line-height:1;letter-spacing:.02em;}' +
```

- [ ] **Step 6: Verify the plumbing in offline mode**

Rename `.env.deploy` first (see the warning in Global Constraints), then run `npm run offline`, sign in, and open a prototype with at least one comment.

In the browser console:

```js
document.querySelector("div").shadowRoot   // sanity: the overlay's shadow root exists
```

Expected observations:
- The network tab shows exactly **one** `/__people?ids=…` request for the page, not one per pin.
- Its response contains your profile with an `avatar` path under `/__avatar/`, and **no `email` field**.
- Nothing has changed visually yet — pins are still numbered. That is correct for this task.

- [ ] **Step 7: Commit**

```bash
git add src/review/comments.js
git commit -m "Overlay resolves comment authors to people (no rendering yet)"
```

---

### Task 4: Normal state — the pin

**Files:**
- Modify: `src/review/comments.js` (`renderPins` ~line 532; stylesheet ~line 242)

**Interfaces:**
- Consumes: `authorOf(t)`, `avatarEl(p, size)` from Task 3.

- [ ] **Step 1: Add the `.pin.who` styles**

After the `.pin.resolved` rule (~line 243):

```js
    /* a pin that knows who wrote it: the face fills the teardrop, keeping the notch */
    '.pin.who{width:28px;height:28px;background:#fff;padding:0;overflow:hidden;}' +
    '.pin.who .av{width:100%;height:100%;border-radius:50% 50% 50% 2px;}' +
    /* resolved keeps its green as a ring, not a fill — a filled disc would hide the face */
    '.pin.who.resolved{background:#fff;border-color:#16a34a;}' +
```

- [ ] **Step 2: Render the face in `renderPins`**

In the `else` branch of `renderPins` (`comments.js:551`), replace `b.textContent = String(nums[t.id] || "");` with:

```js
        var who = authorOf(t);
        if (who) {
          b.classList.add("who");
          b.appendChild(avatarEl(who, 28));
          b.title = who.name;
        } else {
          b.textContent = String(nums[t.id] || "");
        }
```

Leave the numbering loop above untouched — `nums` still drives the sidebar and every anonymous pin.

- [ ] **Step 3: Verify in offline mode**

Run `npm run offline`, sign in, open a prototype, leave a comment.

Expected:
- Your new pin shows **your photo** in a teardrop with a white ring, no number.
- An older comment from someone with no photo on file shows **their initials** on their colour.
- A comment left while signed out still shows a **blue numbered pin**, unchanged.
- On load, a face may appear as initials for a moment before the photo lands — that is `fromName` covering the gap until `/__people` answers, not a bug. It must never flash a *number* first.
- Resolving your comment turns the ring green and keeps the face visible.
- The cat annotation pins are untouched — same size, same tilt, same hover.

- [ ] **Step 4: Commit**

```bash
git add src/review/comments.js
git commit -m "Comment pins wear their author's face"
```

---

### Task 5: Hover state — the preview card

**Files:**
- Modify: `src/review/comments.js` (`showPreview` ~line 1117; `.preview` styles ~line 356; `renderPins` hover wiring ~line 553)

**Interfaces:**
- Consumes: `personFor(m)`, `avatarEl(p, size)` from Task 3.

The reference reads as the pin *becoming* the card's avatar. Achieve that by placing the card so its avatar circle lands on the pin's centre and hiding the pin while the card is up. The existing `transform-origin:left center` + `scaleX(.2→1)` spring already makes the card grow out of that point.

- [ ] **Step 1: Restructure the preview markup**

In `showPreview`, replace the `previewEl.innerHTML = …` line and the two lines that fill `.who` / `.when` with:

```js
    var who = personFor(m);
    previewEl.innerHTML = '<div class="pav"></div><div class="pbody">' +
      '<div class="phead"><span class="who"></span><span class="when" data-iso=""></span></div>' +
      '<div class="body"></div></div>';
    var pav = previewEl.querySelector(".pav");
    if (who) pav.appendChild(avatarEl(who, 28)); else pav.remove();
    previewEl.querySelector(".who").textContent = m.author || "";
```

Keep the following `.when` and `renderBody` lines exactly as they are.

- [ ] **Step 2: Lay the avatar column out**

In the `.preview` styles (~line 356):

```js
    '.preview{display:flex;gap:10px;align-items:flex-start;}' +   /* merge into the existing rule */
    '.preview .pav{flex:0 0 auto;}' +
    '.preview .pbody{min-width:0;flex:1;}' +
    '.preview.left{flex-direction:row-reverse;}' +
```

Add the `display:flex` and `gap` to the existing `.preview{…}` declaration rather than emitting a second conflicting rule.

- [ ] **Step 3: Land the avatar on the pin**

At the end of `showPreview`, after the existing `left`/`top` assignment, offset the card so its avatar sits over the pin, and hide the pin:

```js
    // The card's avatar should occupy the pin's spot, so the disc appears to stay put
    // while the body unfurls out from behind it. 15px = the card's 13px padding plus
    // half the 2px ring; the flipped card mirrors it.
    var padLead = 15;
    var cardLeft = useLeft ? (r.left - pw - gap) + (pw - padLead - 28) : r.left - padLead;
    previewEl.style.left = Math.max(m2, Math.min(cardLeft, vw - pw - m2)) + "px";
    previewEl.style.top = Math.max(m2, Math.min(r.top + r.height / 2 - 27, vh - ph - m2)) + "px";
    if (btn) btn.classList.add("under");
```

Add `'.pin.under{visibility:hidden;}'` to the stylesheet, and in `hidePreview` clear it:

```js
  function hidePreview() {
    clearTimeout(previewTimer);
    previewEl.classList.remove("show");
    var u = pinsEl.querySelector(".pin.under");
    if (u) u.classList.remove("under");
  }
```

Only hide the pin when the thread actually has an avatar — an anonymous numbered pin should stay visible beside its card, since there is no disc for it to become. Guard the `btn.classList.add("under")` with `if (who && btn)`.

- [ ] **Step 4: Verify in offline mode**

Expected, hovering a pin with a face:
- The card grows left→right out of the pin, and the pin's disc *is* the card's avatar — no jump, no doubled face.
- Moving the pointer away restores the pin, every time. Sweep quickly across several pins and confirm none is left invisible.
- Near the right edge the card flips left, the avatar moves to its trailing edge, and it still lands on the pin.
- Hovering an anonymous pin shows the card with no avatar column and the numbered pin still visible beside it.
- Opening a thread and closing it leaves no pin hidden.

- [ ] **Step 5: Commit**

```bash
git add src/review/comments.js
git commit -m "Hover card unfurls out of the author's face"
```

---

### Task 6: Click state — thread, reply bar and sidebar

**Files:**
- Modify: `src/review/comments.js` (`openThread` ~line 1085–1094 and the reply bar ~line 1081; `renderList` ~line 515–521; `.msg` / `.replybar` / sidebar styles ~line 341, 271)

**Interfaces:**
- Consumes: `personFor(m)`, `authorOf(t)`, `avatarEl(p, size)`, `ME` from Task 3.

- [ ] **Step 1: Give each message an avatar**

In `openThread`'s `t.messages.forEach`, replace the `d.innerHTML = …` line and add the avatar before the head row:

```js
      var d = document.createElement("div"); d.className = "msg";
      d.innerHTML = '<div class="mav"></div><div class="mbody">' +
        '<div class="mhead"><span class="who"></span><span class="when" data-iso=""></span>' +
        '<button class="mdel" title="Delete">' + SVG.dots + '</button></div>' +
        '<div class="body"></div></div>';
      var mp = personFor(m);
      var mav = d.querySelector(".mav");
      if (mp) mav.appendChild(avatarEl(mp, 28)); else mav.remove();
```

The four lines below it (`.who`, `.when`, `renderBody`, `.mdel` listener) stay exactly as they are — the selectors still resolve inside `.mbody`.

- [ ] **Step 2: Put your own face on the reply bar**

In the card's `innerHTML`, change the reply bar to:

```js
      '<div class="replybar"><div class="rav"></div><div class="cfield idle">' +
      '<textarea class="tx" rows="1" placeholder="Reply"></textarea>' +
      '<button class="send" title="Send">' + SVG.send + '</button></div></div>';
```

And after `var msgs = card.querySelector(".msgs");`:

```js
    var rav = card.querySelector(".replybar .rav");
    if (ME) rav.appendChild(avatarEl(ME, 28)); else rav.remove();
```

- [ ] **Step 3: Lay out both rows**

```js
    '.msg{display:flex;gap:10px;align-items:flex-start;}' +   /* merge into the existing .msg rule */
    '.msg .mav{flex:0 0 auto;}' +
    '.msg .mbody{min-width:0;flex:1;}' +
    '.replybar{display:flex;gap:10px;align-items:center;}' +
    '.replybar .rav{flex:0 0 auto;}' +
    '.replybar .cfield{flex:1;min-width:0;}' +
```

Merge the `display:flex` into the existing `.msg{…}` declaration (~line 292) rather than adding a competing rule. Check the existing `.msgs .msg` padding rules still read correctly with the new flex layout and adjust the padding, not the structure, if they don't.

- [ ] **Step 4: Swap the sidebar's number for the disc**

In `renderList` (~line 515–521), the annotation branch already replaces `.num` with an image. Extend it:

```js
      var lp = authorOf(t);
      if (anno) {
        var n = li.querySelector(".num"); n.textContent = ""; n.appendChild(av);
      } else if (lp) {
        var n2 = li.querySelector(".num");
        n2.textContent = ""; n2.className = "num face";
        n2.appendChild(avatarEl(lp, 20));
      } else {
        li.querySelector(".num").textContent = String(i + 1);
      }
```

Keep the existing annotation branch's variable (`av`) as it is; only add the new middle branch. Add `'.sb .it .num.face{background:0;padding:0;overflow:hidden;}'` to the stylesheet so the blue disc doesn't show behind the face.

- [ ] **Step 5: Verify in offline mode**

Expected:
- Clicking a pin opens the thread: the pin returns with its blue ring, and each message shows its author's face left of the bold name.
- The reply pill has **your** face outside it, on the left.
- A thread mixing a signed-in author and an anonymous reply shows a face on one row and no face on the other, with both bodies aligned to the same left edge.
- Sidebar rows show the same faces at 20px; anonymous rows keep their number; annotation rows keep the cat.
- Per-message ⋯ delete, resolve, close, and the cat toggle all still work.
- Reply, then confirm the new message appears with your face without a reload.

- [ ] **Step 6: Commit**

```bash
git add src/review/comments.js
git commit -m "Thread, reply bar and sidebar show who is talking"
```

---

### Task 7: Retire the "no avatars" decision

**Files:**
- Modify: `src/review/COMMENTING-UX.md` (§6 blockquote ~line 207; §7 item 1 ~line 266)

- [ ] **Step 1: Mark §6 superseded**

In the §6 blockquote, replace `**No avatars** (we have no users) — drop the avatar circles; the author is just the bold name.` with:

```markdown
> ~~**No avatars** (we have no users) — drop the avatar circles; the author is just the
> bold name.~~ **Superseded 2026-08-09** by
> `docs/superpowers/specs/2026-08-09-comment-avatars-design.md`: a signed-in author
> renders as their photo or initials; an anonymous one keeps the bold name and a
> numbered pin.
```

- [ ] **Step 2: Mark §7.1 superseded**

Replace item 1 under "Open questions / decisions before building" with:

```markdown
1. **Avatars / identity — ~~DECIDED: none~~ SUPERSEDED 2026-08-09.** There are users
   now (invite-only accounts, an admin people table, per-person photo/initials/colour),
   so comments carry a `by` id stamped from the session and resolve to a face via
   `/__people`. See `docs/superpowers/specs/2026-08-09-comment-avatars-design.md`.
   Anonymous comments keep the numbered pin.
```

- [ ] **Step 3: Run the full test suite one last time**

Run: `npm test`
Expected: PASS, every test.

- [ ] **Step 4: Commit**

```bash
git add src/review/COMMENTING-UX.md
git commit -m "COMMENTING-UX: the no-avatars decision is superseded"
```

---

## Deploy note

Do **not** push as part of implementation. Pushing this engine repo fires
`deploy-trigger.yml`, which dispatches to the govocal shell only (`SHELL_REPO`) — so a
push ships these changes to *that* instance immediately, while `augur.deltastudio.io`
picks them up on its weekly Monday 06:17 UTC engine-bump cron or a manual
`workflow_dispatch`. Leave the push, and the choice of which instance gets it first, to
Rob.
