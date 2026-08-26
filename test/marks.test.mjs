// Working marks — coordination WITHOUT locks.
//
// The property under test is mostly a NEGATIVE one, which is why it needs a file of its
// own: a mark must never refuse anything. Every other write route in this engine can say
// no — the gate, the freeze, the unpublish guard, the composed publish — so the natural
// gravity of the codebase is towards "and this one checks too", and a mark that refused
// would be a lock with a friendlier name and every one of a lock's failure modes.
//
// The three things pinned here, in the order they matter:
//
//   1. A MARK REFUSES NOTHING. Marking a path somebody else already marked succeeds, and
//      hands back their mark so the caller can decide. Nothing branches on it.
//   2. IT EXPIRES BY ITSELF, as a READ-TIME FILTER and not a cleanup job. The process that
//      leaves a mark can be killed; a claim that outlives the claimant is worse than no
//      claim, so a lapsed row must be invisible to every reader with nothing having run.
//   3. AUTHORSHIP COMES FROM THE CREDENTIAL. `personId` is resolved from the token, never
//      from the body, exactly like a comment's — otherwise a caller could mark a path as
//      somebody else and the byproduct badge would name the wrong person.
//
// Driven through `publishApi` rather than the helpers wherever the answer is observable
// there: the route sits AHEAD of the bundle-store guard on purpose (an assets-mode
// instance is exactly where two agents most need to stay out of each other's way), and
// only the real handler proves that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables as W } from "../src/_worker.js";
import { normalizeMarkPath as clientNorm, markPathFor, marksOverlap, othersOverlapping, since, forAnother } from "../scripts/lib/marks.mjs";

function memKV(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor };
    },
  };
}

const ALEX = { email: "alex@example.test", name: "Alex Ruiz", role: "editor", initials: "AR", color: "#4f46e5" };
const BEN = { email: "ben@example.test", name: "Ben Otto", role: "editor", initials: "BO", color: "#0e7490" };
const USERS = [ALEX, BEN];

/** A publish token in the store, the shape /__admin/tokens writes. `augur login` labels it with an address. */
async function mint(kv, label, space = "alpha") {
  const raw = "tok-" + label;
  const map = JSON.parse((await kv.get("publish:tokens")) || "{}");
  map[await W.tokenFor("pub:" + raw)] = { space, label };
  await kv.put("publish:tokens", JSON.stringify(map));
  return raw;
}

/** One agent's terminal: a token, and the three things `augur mark` can do with it. */
function agent(ctx, env, token) {
  const call = async (op, method, body) => {
    const url = new URL(`https://x.test/__publish/_marks/${op}`);
    const res = await W.publishApi(ctx, new Request(url, {
      method,
      headers: { Authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), url, env);
    return { status: res.status, body: await res.json() };
  };
  return {
    list: () => call("list", "GET"),
    mark: (path, ttl) => call("set", "POST", ttl === undefined ? { path } : { path, ttl }),
    clear: (path) => call("clear", "POST", { path }),
  };
}

const marksDoc = (kv) => JSON.parse(kv.store.get("marks") || "{}");
const setMarksDoc = (kv, doc) => kv.store.set("marks", JSON.stringify(doc));

// ── the whole point: two agents coordinate, and nothing is ever refused ───────

test("TWO AGENTS SERIALIZE THEMSELVES: the second reads the mark and takes another path", async () => {
  const kv = memKV();
  // No BUNDLES on purpose — the marks route sits ahead of the bundle-store guard, and an
  // instance serving from ASSETS is exactly where two agents most need this.
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));
  const ben = agent(ctx, env, await mint(kv, BEN.email));

  // Terminal 1. Read first — that is the protocol — then start.
  const before = await alex.list();
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.marks, [], "nobody is working on anything yet");
  const a = await alex.mark("/checkout/flow/");
  assert.equal(a.status, 200);
  assert.equal(a.body.mark.path, "/checkout/flow/");
  assert.equal(a.body.mark.by, "Alex Ruiz", "the badge's name is resolved from the roster");

  // Terminal 2, told to improve the same thing. It reads BEFORE it edits, and the answer
  // is the only human word exchanged.
  const seen = await ben.list();
  assert.deepEqual(seen.body.marks.map((m) => [m.path, m.by]), [["/checkout/flow/", "Alex Ruiz"]]);

  // …so it takes a different path. Both marks stand; neither agent was refused anything.
  const b = await ben.mark("/checkout/pricing/");
  assert.equal(b.status, 200);
  const both = (await ben.list()).body.marks.map((m) => m.path).sort();
  assert.deepEqual(both, ["/checkout/flow/", "/checkout/pricing/"]);
});

test("A MARK REFUSES NOTHING — marking a path somebody else holds SUCCEEDS", async () => {
  // The failure this file exists to catch: somebody adds "and if it is already marked,
  // say no". A mark that could refuse is a lock, and a lock that can be lost (see the KV
  // same-window note on writeMark) hands two writers the same exclusive claim.
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));
  const ben = agent(ctx, env, await mint(kv, BEN.email));

  await alex.mark("/checkout/flow/");
  const b = await ben.mark("/checkout/flow/");
  assert.equal(b.status, 200, "the second agent is not refused");
  assert.equal(b.body.error, undefined);
  assert.equal(b.body.mark.by, "Ben Otto", "and the mark is now theirs");
  // The path is one row, so the later mark REPLACES the earlier one rather than queueing
  // behind it. That is the honest shape of a note: the last person to say "I am in here"
  // is the one whose name a reader should see.
  assert.deepEqual((await ben.list()).body.marks.map((m) => m.by), ["Ben Otto"]);
});

test("a mark grants nothing either: clearing somebody else's leaves it standing", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));
  const ben = agent(ctx, env, await mint(kv, BEN.email));

  await alex.mark("/checkout/flow/");
  const taken = await ben.clear("/checkout/flow/");
  assert.equal(taken.status, 200, "refusing to clear is not an error — it is an answer");
  assert.equal(taken.body.cleared, false);
  assert.equal(taken.body.reason, "not-yours");
  assert.deepEqual((await ben.list()).body.marks.map((m) => m.by), ["Alex Ruiz"]);

  const own = await alex.clear("/checkout/flow/");
  assert.equal(own.body.cleared, true);
  assert.deepEqual((await alex.list()).body.marks, []);
});

// ── expiry: the guarantee, and the reason there is no cleanup path ───────────

test("A MARK LEFT BY A KILLED PROCESS DISAPPEARS ON TTL, with nothing having run", async () => {
  // The scenario in full: a tool marks a path and is killed — Ctrl-C, an OOM, a closed
  // lid — so `clear` is never reached, no sweep runs, no cron fires, and the isolate that
  // wrote it is long gone. The next reader must see nothing.
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));

  await alex.mark("/checkout/flow/", 5_000); // the shortest a caller may ask for
  assert.deepEqual((await alex.list()).body.marks.map((m) => m.path), ["/checkout/flow/"]);

  // The kill: nothing is called. Time is the only thing that happens, applied by aging the
  // stored row rather than by sleeping — the expiry rule reads `startedAt + ttl`, so this
  // is the same arithmetic a real six minutes performs.
  const doc = marksDoc(kv);
  doc["/checkout/flow/"].startedAt = new Date(Date.now() - 6_000).toISOString();
  setMarksDoc(kv, doc);

  assert.deepEqual((await alex.list()).body.marks, [], "the CLI's read reports nothing");
  const gallery = await W.marksApi(ctx, new Request("https://x.test/__marks"), new URL("https://x.test/__marks"), env);
  assert.deepEqual((await gallery.json()).marks, [], "and so does the gallery's");

  // AND THE ROW IS STILL THERE. Expiry is a read-time filter, not a deletion — which is
  // exactly why no cleanup path can be forgotten, and why `sweepExpired` reclaiming bytes
  // later cannot change any answer above.
  assert.ok(Object.prototype.hasOwnProperty.call(marksDoc(kv), "/checkout/flow/"),
    "the lapsed row is still in the store — nothing had to run to make it stop counting");
});

test("every reader goes through the one expiry rule, so no surface can disagree", () => {
  const now = Date.now();
  const live = { path: "/a/", personId: "x", startedAt: new Date(now - 1_000).toISOString(), ttl: 60_000 };
  const dead = { path: "/b/", personId: "x", startedAt: new Date(now - 60_000).toISOString(), ttl: 10_000 };
  assert.deepEqual(W.liveMarks({ "/a/": live, "/b/": dead }, now).map((m) => m.path), ["/a/"]);
  // A row with no usable `startedAt` is expired, never immortal: an unparseable date is
  // the shape a corrupt or hand-edited row takes, and the safe reading of "I cannot tell
  // when this started" is "it is over".
  assert.equal(W.markExpiresAt({ startedAt: "not-a-date", ttl: 60_000 }), 0);
  assert.deepEqual(W.liveMarks({ "/c/": { path: "/c/", startedAt: "whenever" } }, now), []);
  // Newest first, so the CLI's list reads as a timeline.
  const older = { path: "/d/", personId: "x", startedAt: new Date(now - 5_000).toISOString(), ttl: 60_000 };
  assert.deepEqual(W.liveMarks({ "/d/": older, "/a/": live }, now).map((m) => m.path), ["/a/", "/d/"]);
});

test("the TTL a caller may ask for is clamped at both ends", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));

  // An agent asking for four hours is describing a lock. It gets an hour and no error —
  // the answer to a lock is a shorter mark re-written as the work continues.
  const long = await alex.mark("/a/", 4 * 60 * 60_000);
  assert.equal(long.body.mark.ttl, W.MARK_TTL_MAX_MS);
  // `--ttl 0` must not write a mark that is already dead, which would be a row that reads
  // as "nobody is here" the instant it lands.
  const zero = await alex.mark("/b/", 0);
  assert.equal(zero.body.mark.ttl, W.MARK_TTL_MS, "a falsy ttl means 'unspecified', so the default stands");
  const tiny = await alex.mark("/c/", 1);
  assert.equal(tiny.body.mark.ttl, W.MARK_TTL_MIN_MS);
  const plain = await alex.mark("/d/");
  assert.equal(plain.body.mark.ttl, W.MARK_TTL_MS);
});

// ── authorship, and what the row is allowed to hold ──────────────────────────

test("AUTHORSHIP COMES FROM THE CREDENTIAL, never from the body", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  await mint(kv, BEN.email);

  // Hand-rolled rather than through `agent()`, because the whole point is a body carrying
  // fields the CLI never sends.
  const url = new URL("https://x.test/__publish/_marks/set");
  const res = await W.publishApi(ctx, new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer tok-" + BEN.email, "content-type": "application/json" },
    // The attempt: name somebody else in the body.
    body: JSON.stringify({ path: "/checkout/flow/", personId: W.personId(ALEX.email), by: ALEX.name }),
  }), url, env);
  const body = await res.json();
  assert.equal(body.mark.by, BEN.name, "the token's holder, not the body's claim");
  assert.equal(body.mark.personId, W.personId(BEN.email));
});

test("the stored row holds a one-way id and no address", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  await agent(ctx, env, await mint(kv, ALEX.email)).mark("/checkout/flow/");

  const row = marksDoc(kv)["/checkout/flow/"];
  assert.deepEqual(Object.keys(row).sort(), ["path", "personId", "startedAt", "ttl"].sort());
  assert.equal(row.personId, W.personId(ALEX.email));
  assert.ok(!JSON.stringify(row).includes("@"), "a mark is read by more things than a comment thread is");
});

test("a name that answers to nobody on the roster resolves to nobody, not to a guess", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  // A token an admin labelled by hand — "ci", "backup" — matches no roster user.
  const ci = agent(ctx, env, await mint(kv, "ci"));
  const r = await ci.mark("/nightly/");
  assert.equal(r.body.mark.by, null);
  assert.equal(r.body.mark.initials, null);
  assert.ok(r.body.mark.personId, "it still has a stable id, so two runs are one author");
});

test("a rename shows through, because the name is resolved and never stored", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  await agent(W.applyInstance({ users: USERS }), env, await mint(kv, ALEX.email)).mark("/a/");
  const renamed = W.applyInstance({ users: [{ ...ALEX, name: "Alex Ruiz-Moreno" }, BEN] });
  const out = await W.readMarks(renamed, env);
  assert.equal(out.marks[0].by, "Alex Ruiz-Moreno");
});

// ── one spelling of a path, on both sides of the wire ────────────────────────

test("THE CLI AND THE WORKER SPELL A PATH IDENTICALLY", () => {
  // Two tools naming the same folder two ways would write two rows and read past each
  // other — the exact failure this feature exists to prevent, arriving through the tool
  // meant to prevent it. `scripts/lib/marks.mjs` mirrors `normalizeMarkPath` by hand
  // because a CLI cannot import the worker; this table is what keeps the copy honest.
  for (const input of [
    "/checkout/flow/", "checkout/flow", "/checkout/flow", "checkout/flow/",
    "./checkout/flow", "//checkout//flow//", "/", "", "   /checkout/flow/   ",
    "/Checkout/Flow/", "/a", "a/b/c",
  ]) {
    assert.equal(clientNorm(input), W.normalizeMarkPath(input), `spelling of ${JSON.stringify(input)}`);
  }
});

test("a repo folder marks the URL it publishes to", () => {
  // An agent has just been editing `checkout/prototypes/flow`, so that is what it will
  // type. Marking it verbatim would name a path no card and no published unit can match.
  assert.equal(markPathFor("checkout/prototypes/flow"), "/checkout/flow/");
  assert.equal(markPathFor("/checkout/prototypes/flow/"), "/checkout/flow/");
  assert.equal(markPathFor("/checkout/flow/"), "/checkout/flow/", "a URL path is already right");
});

test("overlap is containment in either direction, and the same on both sides", () => {
  const cases = [
    ["/checkout/", "/checkout/flow/", true],   // a folder mark covers what is inside it
    ["/checkout/flow/", "/checkout/", true],   // and is worth showing to whoever takes the folder
    ["/checkout/flow/", "/checkout/flow/", true],
    ["/checkout/flow/", "/checkout/flowchart/", false], // the trailing slash is what stops this
    ["/checkout/", "/pricing/", false],
    ["", "/checkout/", false],
    // A FILE under a marked folder. `augur clone`/`pull` tests each file it is about to
    // write against the marks, and a manifest url is a file — so if this were false the
    // pull warning would be a silent no-op that always looked like "nobody is here".
    ["/checkout/flow/index.html", "/checkout/flow/", true],
    ["/checkout/flowchart/index.html", "/checkout/flow/", false],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(W.markPathsOverlap(a, b), want, `worker: ${a} vs ${b}`);
    assert.equal(marksOverlap(a, b), want, `client: ${a} vs ${b}`);
  }
});

test("⚠️ THE EXACT COLLISION IS THE ONE THE CLI MUST WARN ABOUT", () => {
  // The regression, in the form it actually shipped: `augur mark` excluded the exact path
  // from its "somebody is already working here" list — an honest-looking way to stop your
  // own renewal warning at you — and so printed NOTHING when a second agent marked the very
  // prototype a first agent was in. Silence there is worse than no feature, because it
  // reads as an all-clear. "Somebody else" is decided by WHO, never by WHERE.
  const alexId = W.personId(ALEX.email), benId = W.personId(BEN.email);
  const before = [
    { path: "/checkout/flow/", personId: alexId, by: ALEX.name, expiresIn: 60_000 },
    { path: "/pricing/", personId: benId, by: BEN.name, expiresIn: 60_000 },
  ];
  assert.deepEqual(
    othersOverlapping(before, "/checkout/flow/", benId).map((m) => m.by), [ALEX.name],
    "the same prototype, by somebody else — the case the whole feature exists for");
  assert.deepEqual(
    othersOverlapping(before, "/checkout/flow/", alexId).map((m) => m.by), [],
    "renewing your OWN mark warns you about nothing");
  assert.deepEqual(
    othersOverlapping(before, "/checkout/", benId).map((m) => m.by), [ALEX.name],
    "taking the folder above surfaces what is inside it");
  assert.deepEqual(
    othersOverlapping(before, "/settings/", benId).map((m) => m.by), [],
    "and an unrelated path is quiet");
  assert.deepEqual(othersOverlapping(null, "/a/", alexId), [], "no marks at all is not a crash");
});

test("a path that is not a path is refused, and that is the only bad-input refusal", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));
  const r = await alex.mark("");
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad-input");
});

// ── the byproduct: what a gallery card is allowed to ask for ─────────────────

test("the browser's read is GET-only — a tab is not a work-start step", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const url = new URL("https://x.test/__marks");
  const res = await W.marksApi(ctx, new Request(url, { method: "POST" }), url, env);
  assert.equal(res.status, 405, "the write side is a publish token, deliberately");
});

test("the gallery read carries what a badge needs and nothing more", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  await agent(ctx, env, await mint(kv, ALEX.email)).mark("/checkout/flow/");
  const url = new URL("https://x.test/__marks");
  const body = await (await W.marksApi(ctx, new Request(url), url, env)).json();
  const m = body.marks[0];
  assert.equal(m.by, "Alex Ruiz");
  assert.equal(m.initials, "AR");
  assert.equal(m.color, "#4f46e5");
  assert.ok(m.expiresIn > 0 && m.expiresIn <= W.MARK_TTL_MS, "so the badge can take itself off");
  assert.ok(!JSON.stringify(body).includes("@"), "no address reaches a page a badge is drawn on");
});

test("a deployment with no store at all answers with nothing, not an error", async () => {
  // A raw engine build has no KV binding. "Nobody is working on anything" is the right
  // answer there, because on that deployment nobody can be.
  const ctx = W.applyInstance({ users: USERS });
  const out = await W.readMarks(ctx, {});
  assert.deepEqual(out.marks, []);
  assert.equal(out.warning, "no-kv-binding");
});

// ── the guards that ARE allowed, and their bounds ────────────────────────────

test("the only refusal on the write path is a runaway-loop guard", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));

  const now = Date.now();
  const doc = {};
  for (let i = 0; i < W.MARK_MAX_ROWS; i++) {
    doc[`/p${i}/`] = { path: `/p${i}/`, personId: "z", startedAt: new Date(now).toISOString(), ttl: 60_000 };
  }
  setMarksDoc(kv, doc);

  const overflow = await alex.mark("/one-more/");
  assert.equal(overflow.body.error, "too-many-marks", "this many at once in one workspace is a script, not a team");
  // RE-MARKING one that already exists still works: the guard is about growth, and a
  // long-running agent renewing its own mark must never be the thing it stops.
  const renew = await alex.mark("/p7/");
  assert.equal(renew.status, 200);
  assert.equal(renew.body.error, undefined);
});

test("the byte sweep is bounded, opportunistic, and changes no answer", async () => {
  const kv = memKV();
  const store = W.overlayFor({ COMMENTS: kv }, W.applyInstance({ users: USERS }));
  const old = new Date(Date.now() - 3600_000).toISOString();
  const doc = {};
  for (let i = 0; i < 20; i++) doc[`/dead${i}/`] = { path: `/dead${i}/`, personId: "z", startedAt: old, ttl: 10_000 };
  doc["/live/"] = { path: "/live/", personId: "z", startedAt: new Date().toISOString(), ttl: 60_000 };
  setMarksDoc(kv, doc);

  const swept = await W.sweepExpired(store, doc, Date.now(), "/keep/");
  assert.equal(swept, W.MARK_SWEEP_MAX, "one write may not turn into a hundred");
  assert.ok(Object.keys(marksDoc(kv)).length > 1, "so lapsed rows outlive one sweep, which is fine");
  assert.ok(marksDoc(kv)["/live/"], "and a live row is never swept");
});

test("a sweep that fails is not a failure — the mark it was announcing is already written", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));
  const old = new Date(Date.now() - 3600_000).toISOString();
  setMarksDoc(kv, { "/dead/": { path: "/dead/", personId: "z", startedAt: old, ttl: 10_000 } });

  // The store starts refusing writes the moment the mark itself has landed.
  let puts = 0;
  const put = kv.put.bind(kv);
  kv.put = async (k, v) => { if (++puts > 1) throw new Error("KV is having a day"); return put(k, v); };

  const r = await alex.mark("/checkout/flow/");
  assert.equal(r.status, 200, "reclaiming bytes may never be the reason a work-start step reports a failure");
  assert.equal(r.body.mark.path, "/checkout/flow/");
});

test("the answer is computed from what was written, never re-read", async () => {
  // A second read costs a round trip to say what the handler already knows, and on KV it
  // can come back STALER than the write it was meant to confirm — a work-start step that
  // printed "your mark is not there" right after writing it would teach people to
  // distrust the tool. So: a store whose reads are frozen at empty still answers correctly.
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, env, await mint(kv, ALEX.email));
  await alex.mark("/first/");

  const get = kv.get.bind(kv);
  kv.get = async (k) => (k === "marks" ? null : get(k)); // every read of the family is stale-empty
  const r = await alex.mark("/second/");
  assert.equal(r.body.mark.path, "/second/");
  assert.deepEqual(r.body.marks.map((m) => m.path), ["/second/"], "it reports what it wrote");
});

// ── the routes around it ─────────────────────────────────────────────────────

test("marks work with no bundle store bound, because that is where they are needed", async () => {
  // The guard `publishApi` opens with is `if (!env.BUNDLES) return 501`. The marks branch
  // sits AHEAD of it: `augur dev`, `npm run offline` and a raw engine build all serve from
  // ASSETS, and 501 there would be an accident of where a check sits.
  const kv = memKV();
  const ctx = W.applyInstance({ users: USERS });
  const alex = agent(ctx, { COMMENTS: kv }, await mint(kv, ALEX.email));
  assert.equal((await alex.mark("/checkout/flow/")).status, 200);

  // …and the very next path in the same handler still answers 501 without one, so nothing
  // was widened by moving the branch up.
  const url = new URL("https://x.test/__publish/alpha/check");
  const res = await W.publishApi(ctx, new Request(url, { headers: { Authorization: "Bearer tok-" + ALEX.email } }), url, { COMMENTS: kv });
  assert.equal(res.status, 501);
});

test("no token, no mark — and a restricted credential reaches this no further than anything else", async () => {
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });

  const url = new URL("https://x.test/__publish/_marks/list");
  const anon = await W.publishApi(ctx, new Request(url), url, env);
  assert.equal(anon.status, 403);

  // A capability-scoped credential (the kind minted for one job, e.g. a cache purge) names
  // the routes it may use. `_marks` is not among them, and a mark is not an exception.
  const raw = "tok-capped";
  const map = JSON.parse((await kv.get("publish:tokens")) || "{}");
  map[await W.tokenFor("pub:" + raw)] = { space: "*", label: "purge-bot", caps: ["purge"] };
  await kv.put("publish:tokens", JSON.stringify(map));
  const capped = await W.publishApi(ctx, new Request(url, { headers: { Authorization: "Bearer " + raw } }), url, env);
  assert.equal(capped.status, 403);
  assert.equal((await capped.json()).reason, "capability-not-granted");
});

test("a space-scoped token may mark, because a mark names a path and not a space", async () => {
  // The person whose work-start is most worth announcing is the one editing one workspace.
  const kv = memKV();
  const env = { COMMENTS: kv };
  const ctx = W.applyInstance({ users: USERS });
  const scoped = agent(ctx, env, await mint(kv, ALEX.email, "alpha"));
  assert.equal((await scoped.mark("/checkout/flow/")).status, 200);
});

test("⚠️ a FROZEN workspace refuses the write and still serves the read", () => {
  // A freeze makes a workspace read-only while it is being moved, and a mark is a write —
  // so `augur mark <path>` fails during one, by design and not by accident. Reading who is
  // working stays available, because a GET is never a frozen write. Pinned here because
  // the marks route is self-authed and sits after the freeze gate: anyone moving it
  // earlier would silently write claims into a workspace that is mid-migration.
  const frozen = (method, p) => W.isFrozenWrite(new Request("https://x.test" + p, { method }), new URL("https://x.test" + p));
  assert.equal(frozen("POST", "/__publish/_marks/set"), true);
  assert.equal(frozen("POST", "/__publish/_marks/clear"), true);
  assert.equal(frozen("GET", "/__publish/_marks/list"), false);
  assert.equal(frozen("GET", "/__marks"), false);
});

// ── the words the CLI prints ─────────────────────────────────────────────────

test("the phrasing rounds the way a person reads a clock", () => {
  assert.equal(since(0), "just now");
  assert.equal(since(44_000), "just now");
  assert.equal(since(120_000), "2 minutes ago");
  assert.equal(since(60_000), "1 minute ago", "singular, not '1 minutes'");
  assert.equal(since(7200_000), "2 hours ago");
  assert.equal(forAnother(30_000), "for another 30 seconds");
  assert.equal(forAnother(600_000), "for another 10 minutes");
  // The ceiling reads as an hour rather than as "60 minutes" — the longest mark anybody
  // can ask for is the one this phrasing gets asked about most.
  assert.equal(forAnother(3600_000), "for another 1 hour");
  assert.equal(forAnother(-5), "for another 0 seconds", "a lapsed mark never reads as time remaining");
});
