// The four rate layers and the suppression list.
//
// `B-mail-abuse-guards`. Every limit in this module used to be keyed on the RECIPIENT,
// which stops one inbox being bombed and nothing else. One actor triggers three resets
// each at ten thousand DIFFERENT addresses, stays inside every cap, and sends thirty
// thousand messages — the shape that destroys a sending domain's reputation, and the cost
// shape too, since the plan is 300 messages a MONTH.
//
// Each test below is one line of that item's VERIFY. NOTHING HERE SENDS LIVE MAIL: the
// transport takes an injected fetch, and every test drives that.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendMail, mailNotice, mailRateCheck,
  MAIL_RATE, MAIL_ACTOR_RATE, MAIL_GLOBAL_RATE,
  mailSuppress, mailSuppressed,
} from "../src/mail.mjs";

const ENV = Object.freeze({
  MAIL_PROVIDER: "http", MAIL_API_URL: "https://mail.test/send",
  MAIL_API_KEY: "k", MAIL_FROM: "Augur <no-reply@example.test>",
});

function memKV() {
  const m = new Map();
  return {
    store: m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
  };
}
function stubFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler ? handler() : new Response('{"id":"1"}', { status: 200 }); };
  f.calls = calls;
  return f;
}
const reset = (to) => ({ to, template: "credential-reset", vars: { workspace: "w", link: "https://x.test/l" } });
const T0 = 1_700_000_000_000;

// ── layer 2: the FLOOR ───────────────────────────────────────────────────────

test("two sends a second apart: the second is refused, and the wait is stated", async () => {
  // NOT the same guard as the ceiling. 3/hour permits three instantly, so a
  // double-clicked resend button sends three. The floor is what makes a resend button
  // honest, and it is the cheapest fix in the whole item.
  const kv = memKV(); const f = stubFetch();
  assert.equal((await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv, now: T0 })).ok, true);
  const second = await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv, now: T0 + 1000 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "rate-limited");
  assert.equal(second.layer, "floor", "the floor must name itself — an operator told 'too many messages' after ONE send stops trusting the panel");
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= MAIL_RATE["credential-reset"].minGapMs);
  assert.equal(f.calls.length, 1, "the refused attempt reached the provider anyway");
  assert.match(mailNotice(second, "a@example.test"), /moments ago/);
  assert.match(mailNotice(second, "a@example.test"), /Send the link yourself/);
});

test("the floor clears once the gap has passed", async () => {
  const kv = memKV(); const f = stubFetch();
  await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv, now: T0 });
  const after = T0 + MAIL_RATE["credential-reset"].minGapMs + 1;
  assert.equal((await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv, now: after })).ok, true);
});

// ── layer 3: the PER-ACTOR ceiling, the one that was missing ─────────────────

test("one actor at 200 DISTINCT addresses is stopped well before 200", async () => {
  // The attack the original guard could not see. Every address is fresh, so the
  // per-recipient ceiling and the floor never fire even once.
  const kv = memKV(); const f = stubFetch();
  let sent = 0, stoppedAt = -1;
  for (let i = 0; i < 200; i++) {
    const r = await sendMail(ENV, reset(`victim${i}@example.test`), {
      fetchImpl: f, kv, now: T0 + i * 1000, actor: "203.0.113.9",
    });
    if (r.ok) sent++;
    else if (stoppedAt < 0) { stoppedAt = i; assert.equal(r.layer, "actor", `stopped by ${r.layer}, not the actor ceiling`); }
  }
  assert.ok(stoppedAt > 0 && stoppedAt < 200, `never stopped in 200 attempts (sent ${sent})`);
  assert.equal(sent, MAIL_ACTOR_RATE.max, "the count sent is bounded by the actor limit, not by 200");
  assert.equal(f.calls.length, MAIL_ACTOR_RATE.max, "refused attempts still reached the provider");
});

test("a different actor is unaffected by the first one's ceiling", async () => {
  // Otherwise one abuser takes everybody's mail down, which is a denial of service
  // wearing a rate limit's clothes.
  const kv = memKV(); const f = stubFetch();
  for (let i = 0; i < MAIL_ACTOR_RATE.max + 2; i++) {
    await sendMail(ENV, reset(`v${i}@example.test`), { fetchImpl: f, kv, now: T0 + i * 1000, actor: "bad-actor" });
  }
  const other = await sendMail(ENV, reset("fresh@example.test"), { fetchImpl: f, kv, now: T0, actor: "someone-else" });
  assert.equal(other.ok, true, "a second actor was caught by the first actor's ceiling");
});

test("with no actor supplied the other layers still hold", async () => {
  // A caller that forgets to pass an actor must not silently disable the rest.
  const kv = memKV(); const f = stubFetch();
  const rule = MAIL_RATE["credential-reset"];
  for (let i = 0; i < rule.max; i++) {
    await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv, now: T0 + i * (rule.minGapMs + 1) });
  }
  const blocked = await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv, now: T0 + rule.max * (rule.minGapMs + 1) });
  assert.equal(blocked.layer, "recipient");
});

// ── layer 4: the PER-INSTANCE ceiling ────────────────────────────────────────

test("the instance ceiling hard-stops, logs loudly, and still hands out a link", async () => {
  // The failure it prevents is silent quota exhaustion that breaks signup for everyone,
  // so failing quietly here would be the same bug with a limit attached.
  const kv = memKV(); const f = stubFetch();
  const lines = [];
  const orig = console.log; console.log = (s) => lines.push(s);
  let refused = null;
  try {
    for (let i = 0; i < MAIL_GLOBAL_RATE.max + 5; i++) {
      const r = await sendMail(ENV, reset(`p${i}@example.test`), {
        fetchImpl: f, kv, now: T0 + i * 1000, actor: `actor-${i}`, // fresh actor each time
      });
      if (!r.ok && r.layer === "instance") { refused = r; break; }
    }
  } finally { console.log = orig; }
  assert.ok(refused, "the instance ceiling never fired");
  assert.equal(f.calls.length, MAIL_GLOBAL_RATE.max, "more sends went out than the instance ceiling allows");
  const alarm = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((l) => l && l.level === "alarm" && l.event === "mail-instance-ceiling");
  assert.ok(alarm, `no alarm was logged: ${lines.join(" | ")}`);
  assert.match(alarm.detail, /raising MAIL_GLOBAL_RATE|loop|abusive/i, "the alarm does not say what to look at");
  assert.match(mailNotice(refused, "p@example.test"), /Send the link yourself/);
});

// ── the suppression list ─────────────────────────────────────────────────────

test("a hard-bounced address is never sent to again, with no provider round trip", async () => {
  // Learned expensively: bounces to two addresses on the sending domain got both
  // blocklisted at the provider for a MONTH, and the provider caps blocklist deletions at
  // five per rolling 24 hours — the cleanup is structurally slower than the damage.
  const kv = memKV(); const f = stubFetch();
  await mailSuppress(kv, "Bounced@Example.Test", "hard-bounce 550");
  assert.equal(await mailSuppressed(kv, "bounced@example.test"), true, "suppression must be case-folded");
  const r = await sendMail(ENV, reset("bounced@example.test"), { fetchImpl: f, kv, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "suppressed");
  assert.equal(f.calls.length, 0, "a suppressed address still reached the provider");
  assert.match(mailNotice(r, "bounced@example.test"), /bounced before/);
  assert.match(mailNotice(r, "bounced@example.test"), /Send the link yourself/);
});

test("a suppressed address costs the actor nothing", async () => {
  // Otherwise an attacker burns somebody's whole allowance on addresses that were never
  // going to be mailed.
  const kv = memKV(); const f = stubFetch();
  await mailSuppress(kv, "bounced@example.test");
  for (let i = 0; i < 5; i++) {
    await sendMail(ENV, reset("bounced@example.test"), { fetchImpl: f, kv, now: T0 + i * 1000, actor: "ip" });
  }
  const good = await sendMail(ENV, reset("fine@example.test"), { fetchImpl: f, kv, now: T0, actor: "ip" });
  assert.equal(good.ok, true, "attempts at a suppressed address consumed the actor's budget");
});

test("suppression is unaffected by a corrupt or absent list", async () => {
  const kv = memKV();
  assert.equal(await mailSuppressed(kv, "x@example.test"), false);
  await kv.put("mail:suppressed", "not json at all");
  assert.equal(await mailSuppressed(kv, "x@example.test"), false, "a corrupt list must not refuse everything");
  await kv.put("mail:suppressed", '["array","not","object"]');
  assert.equal(await mailSuppressed(kv, "x@example.test"), false);
});

// ── the degradation contract, which every layer shares ───────────────────────

test("no layer ever swallows: every refusal names itself and points at the link", async () => {
  for (const r of [
    { ok: false, reason: "rate-limited", layer: "floor", retryAfterMs: 30_000 },
    { ok: false, reason: "rate-limited", layer: "recipient", retryAfterMs: 600_000 },
    { ok: false, reason: "rate-limited", layer: "actor", retryAfterMs: 600_000 },
    { ok: false, reason: "rate-limited", layer: "instance", retryAfterMs: 3_600_000 },
    { ok: false, reason: "suppressed", detail: "x" },
  ]) {
    const notice = mailNotice(r, "a@example.test");
    assert.ok(notice, `${r.layer || r.reason} produced no notice at all`);
    assert.match(notice, /Send the link yourself|send the link yourself/,
      `${r.layer || r.reason} does not tell the operator the action still worked`);
  }
});

test("with no KV none of the layers pretend to be enforced", async () => {
  // The local-development case. A guard that fails closed with no store would make
  // `npm run offline` unable to send anything, and the next person would delete it.
  const f = stubFetch();
  for (let i = 0; i < MAIL_ACTOR_RATE.max + 5; i++) {
    assert.equal((await sendMail(ENV, reset("a@example.test"), { fetchImpl: f, kv: null, actor: "ip" })).ok, true);
  }
  assert.deepEqual(await mailRateCheck(null, "credential-reset", "a@example.test"), { allowed: true, retryAfterMs: 0 });
});
