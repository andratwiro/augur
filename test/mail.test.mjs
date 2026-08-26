// The mail transport, and above all the three ways it is allowed to fail.
//
// An invite has always been a link an admin copies and sends themselves. Mail rides on
// top of that, so the bar every test here holds is: sendMail returns a verdict, it never
// throws, and no verdict it can return costs the caller its link. The provider is behind
// an injected fetch — this suite never opens a socket and never needs an account.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendMail, renderMail, mailConfig, mailConfigured, mailNotice, parseAddress,
  TEMPLATES, DRIVERS, MAIL_RATE, mailRateKey, mailRateCheck,
} from "../src/mail.mjs";

function memKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

// Records every call and answers with whatever the test asked for.
function stubFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (typeof responder === "function") return responder(url, init);
    return new Response(JSON.stringify({ emails: [{ id: "msg-1" }], id: "msg-1" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  fn.calls = calls;
  return fn;
}

const SCW_ENV = {
  MAIL_PROVIDER: "scaleway",
  MAIL_FROM: "Example <noreply@example.org>",
  MAIL_API_KEY: "k-secret",
  MAIL_PROJECT_ID: "proj-123",
  MAIL_REGION: "eu-west",
};
const HTTP_ENV = {
  MAIL_PROVIDER: "http",
  MAIL_FROM: "noreply@example.org",
  MAIL_API_KEY: "k-secret",
  MAIL_API_URL: "https://relay.example.org/send",
};
const INVITE = {
  to: "new@example.test",
  template: "roster-invite",
  vars: { workspace: "example.org", link: "https://example.org/__invite?t=abc", inviter: "Ada", expiresHours: 72 },
};

// ---- the no-provider default --------------------------------------------------------

test("no provider configured: nothing is sent, nothing is fetched, and it says so", async () => {
  const f = stubFetch();
  const res = await sendMail({}, INVITE, { fetchImpl: f, kv: memKV() });
  assert.deepEqual(res, { ok: false, reason: "unconfigured" });
  assert.equal(f.calls.length, 0);
  assert.equal(mailConfigured({}), false);
  // "no silent swallow": the reason is a value the caller can show, and mailNotice
  // deliberately says nothing — the panel must look exactly as it did before mail existed.
  assert.equal(mailNotice(res, INVITE.to), "");
});

test("an empty MAIL_PROVIDER is the same as no provider at all", async () => {
  const f = stubFetch();
  const res = await sendMail({ MAIL_PROVIDER: "  ", MAIL_API_KEY: "k" }, INVITE, { fetchImpl: f });
  assert.equal(res.reason, "unconfigured");
  assert.equal(f.calls.length, 0);
});

// ---- half-configured ----------------------------------------------------------------

test("a provider with settings missing names the settings, and sends nothing", async () => {
  const f = stubFetch();
  const res = await sendMail({ MAIL_PROVIDER: "scaleway", MAIL_FROM: "" }, INVITE, { fetchImpl: f });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "misconfigured");
  for (const k of ["MAIL_API_KEY", "MAIL_PROJECT_ID", "MAIL_REGION", "MAIL_FROM"]) {
    assert.ok(res.detail.includes(k), `${k} should be named in "${res.detail}"`);
  }
  assert.equal(f.calls.length, 0);
  assert.match(mailNotice(res, INVITE.to), /Send the link yourself/);
});

test("an unknown driver name is reported with the ones that exist", async () => {
  const res = await sendMail({ ...SCW_ENV, MAIL_PROVIDER: "carrier-pigeon" }, INVITE, { fetchImpl: stubFetch() });
  assert.equal(res.reason, "misconfigured");
  assert.match(res.detail, /carrier-pigeon/);
  for (const name of Object.keys(DRIVERS)) assert.ok(res.detail.includes(name));
});

test("MAIL_FROM must parse as an address — a name with no address is misconfigured", async () => {
  const res = await sendMail({ ...SCW_ENV, MAIL_FROM: "Example" }, INVITE, { fetchImpl: stubFetch() });
  assert.equal(res.reason, "misconfigured");
  assert.match(res.detail, /MAIL_FROM/);
});

// ---- the drivers --------------------------------------------------------------------

test("the scaleway driver posts the documented shape to a region endpoint", async () => {
  const f = stubFetch();
  const res = await sendMail(SCW_ENV, INVITE, { fetchImpl: f, kv: memKV() });
  assert.deepEqual({ ok: res.ok, reason: res.reason, id: res.id }, { ok: true, reason: "sent", id: "msg-1" });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "https://api.scaleway.com/transactional-email/v1alpha1/regions/eu-west/emails");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-Auth-Token"], "k-secret");
  const body = JSON.parse(init.body);
  assert.deepEqual(body.from, { email: "noreply@example.org", name: "Example" });
  assert.deepEqual(body.to, [{ email: "new@example.test" }]);
  assert.equal(body.project_id, "proj-123");
  assert.ok(body.subject && body.text && body.html, "subject and both bodies are always sent");
});

test("MAIL_API_URL overrides the derived endpoint, so a region move is a setting", async () => {
  const f = stubFetch();
  await sendMail({ ...SCW_ENV, MAIL_API_URL: "https://mail.internal/send" }, INVITE, { fetchImpl: f, kv: memKV() });
  assert.equal(f.calls[0].url, "https://mail.internal/send");
});

test("the http driver is a bearer-authenticated JSON POST anyone can put a relay behind", async () => {
  const f = stubFetch();
  const res = await sendMail(HTTP_ENV, INVITE, { fetchImpl: f, kv: memKV() });
  assert.equal(res.ok, true);
  const { url, init } = f.calls[0];
  assert.equal(url, "https://relay.example.org/send");
  assert.equal(init.headers.Authorization, "Bearer k-secret");
  const body = JSON.parse(init.body);
  assert.equal(body.to, "new@example.test");
  assert.equal(body.from, "noreply@example.org");
  assert.equal(body.template, "roster-invite");
  assert.ok(body.text.includes(INVITE.vars.link));
});

// ---- a provider that is down ---------------------------------------------------------

test("a provider that refuses the send reports its own words and never throws", async () => {
  const f = stubFetch(() => new Response('{"message":"quota exceeded"}', { status: 429 }));
  const res = await sendMail(SCW_ENV, INVITE, { fetchImpl: f, kv: memKV() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "failed");
  assert.match(res.detail, /429/);
  assert.match(res.detail, /quota exceeded/);
  assert.match(mailNotice(res, INVITE.to), /Send the link yourself/);
});

test("a provider that is unreachable is a verdict, not an exception", async () => {
  const f = stubFetch(() => { throw new Error("connect ECONNREFUSED"); });
  const res = await sendMail(SCW_ENV, INVITE, { fetchImpl: f, kv: memKV() });
  assert.equal(res.reason, "failed");
  assert.match(res.detail, /ECONNREFUSED/);
});

test("a 200 with a body the driver cannot read is still a send", async () => {
  const f = stubFetch(() => new Response("okay", { status: 200 }));
  const res = await sendMail(SCW_ENV, INVITE, { fetchImpl: f, kv: memKV() });
  assert.equal(res.ok, true);
  assert.equal(res.id, "");
});

// ---- caller mistakes -------------------------------------------------------------------

test("a recipient that is not an address is refused before the provider is called", async () => {
  const f = stubFetch();
  const res = await sendMail(SCW_ENV, { ...INVITE, to: "not-an-address" }, { fetchImpl: f, kv: memKV() });
  assert.equal(res.reason, "bad-recipient");
  assert.equal(f.calls.length, 0);
});

test("an unknown template is refused before the provider is called", async () => {
  const f = stubFetch();
  const res = await sendMail(SCW_ENV, { ...INVITE, template: "nope" }, { fetchImpl: f, kv: memKV() });
  assert.equal(res.reason, "unknown-template");
  assert.equal(f.calls.length, 0);
});

// ---- the rate limit ---------------------------------------------------------------------

test("the reset template is capped per address — the cap is on the mail, not the action", async () => {
  const kv = memKV();
  const f = stubFetch();
  const msg = {
    to: "target@example.test",
    template: "credential-reset",
    vars: { workspace: "example.org", link: "https://example.org/__invite?t=x", expiresHours: 24 },
  };
  const rule = MAIL_RATE["credential-reset"];
  const max = rule.max;
  // Spaced past the FLOOR, which is a different guard with its own test below. Without
  // the spacing this measures the floor and calls it the ceiling.
  const t = (i) => 1_700_000_000_000 + i * (rule.minGapMs + 1);
  for (let i = 0; i < max; i++) {
    const r = await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: t(i) });
    assert.equal(r.ok, true, `send ${i + 1} of ${max} should go out`);
  }
  const blocked = await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: t(max) });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "rate-limited");
  assert.equal(blocked.layer, "recipient", "the ceiling must name itself, not the floor");
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(f.calls.length, max, "the capped attempt never reaches the provider");
  assert.match(mailNotice(blocked, msg.to), /Send the link yourself/);
});

test("the cap is per address — a second recipient is unaffected", async () => {
  const kv = memKV();
  const f = stubFetch();
  const base = { template: "credential-reset", vars: { workspace: "w", link: "https://x.test/l" } };
  for (let i = 0; i <= MAIL_RATE["credential-reset"].max; i++) {
    await sendMail(SCW_ENV, { ...base, to: "one@example.test" }, { fetchImpl: f, kv });
  }
  const other = await sendMail(SCW_ENV, { ...base, to: "two@example.test" }, { fetchImpl: f, kv });
  assert.equal(other.ok, true);
});

test("the cap counts attempts, so a failing provider is not a way around it", async () => {
  const kv = memKV();
  const f = stubFetch(() => new Response("nope", { status: 500 }));
  const msg = { to: "target@example.test", template: "credential-reset", vars: { workspace: "w", link: "https://x.test/l" } };
  const rule = MAIL_RATE["credential-reset"];
  const t = (i) => 1_700_000_000_000 + i * (rule.minGapMs + 1);
  for (let i = 0; i < rule.max; i++) {
    const r = await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: t(i) });
    assert.equal(r.reason, "failed");
  }
  const blocked = await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: t(rule.max) });
  assert.equal(blocked.reason, "rate-limited");
});

test("the window expires — the same address is sendable again after it passes", async () => {
  const kv = memKV();
  const f = stubFetch();
  const msg = { to: "target@example.test", template: "credential-reset", vars: { workspace: "w", link: "https://x.test/l" } };
  const t0 = 1_700_000_000_000;
  const gap = MAIL_RATE["credential-reset"].minGapMs + 1;
  for (let i = 0; i < MAIL_RATE["credential-reset"].max; i++) {
    await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: t0 + i * gap });
  }
  assert.equal((await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: t0 + MAIL_RATE["credential-reset"].max * gap })).reason, "rate-limited");
  const later = t0 + MAIL_RATE["credential-reset"].windowMs + 1;
  assert.equal((await sendMail(SCW_ENV, msg, { fetchImpl: f, kv, now: later })).ok, true);
});

test("an admin's roster invite IS capped now, but generously enough to re-send a lost one", async () => {
  // This test used to assert the opposite, and the reasoning was: only an authenticated
  // admin can reach this path, naming an address they are also putting on their own
  // roster. That holds right up until the admin credential is the thing that was stolen —
  // an uncapped authenticated path is still a mail cannon, it just needs a login first.
  //
  // The cap has to stay out of the way of the real workflow it protects, which is
  // re-sending an invite somebody lost.
  const kv = memKV();
  const f = stubFetch();
  const rule = MAIL_RATE["roster-invite"];
  assert.ok(rule, "roster-invite must be governed");
  assert.ok(rule.max >= 10, "a cap that blocks ordinary onboarding will be removed by the next person");
  const t = (i) => 1_700_000_000_000 + i * (rule.minGapMs + 1);
  for (let i = 0; i < 12; i++) {
    const r = await sendMail(SCW_ENV, INVITE, { fetchImpl: f, kv, now: t(i) });
    assert.equal(r.ok, true, `invite ${i + 1} should still go out`);
  }
  assert.equal(f.calls.length, 12);
});

test("with no KV the cap cannot be enforced and does not pretend to be", async () => {
  const f = stubFetch();
  const msg = { to: "target@example.test", template: "credential-reset", vars: { workspace: "w", link: "https://x.test/l" } };
  for (let i = 0; i < MAIL_RATE["credential-reset"].max + 3; i++) {
    assert.equal((await sendMail(SCW_ENV, msg, { fetchImpl: f, kv: null })).ok, true);
  }
  assert.deepEqual(await mailRateCheck(null, "credential-reset", "x@y.test"), { allowed: true, retryAfterMs: 0 });
});

test("the rate key is case-folded, so two spellings of one address share a cap", async () => {
  assert.equal(mailRateKey("credential-reset", "A@B.Test"), mailRateKey("credential-reset", "a@b.test"));
});

// ---- the templates -----------------------------------------------------------------------

test("all three templates render a subject, a text body and an HTML body carrying the link", () => {
  const vars = { workspace: "example.org", link: "https://example.org/__invite?t=a&b=c", inviter: "Ada", expiresHours: 72 };
  for (const name of Object.keys(TEMPLATES)) {
    const m = renderMail(name, vars);
    assert.ok(m.subject.length > 0 && m.subject.length < 120, `${name}: a usable subject`);
    assert.ok(m.text.includes(vars.link), `${name}: the link is in the text body`);
    assert.ok(m.html.includes("https://example.org/__invite?t=a&amp;b=c"), `${name}: the link is in the HTML body, escaped`);
    assert.ok(!/<style|src=|http:\/\//i.test(m.html), `${name}: no stylesheet, no remote asset`);
    assert.ok(m.text.includes("once"), `${name}: says the link is single-use`);
  }
});

test("the three templates are exactly the three the product sends", () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ["credential-reset", "roster-invite", "signup-verify"]);
});

test("a workspace name is escaped into the HTML, never injected", () => {
  const m = renderMail("roster-invite", { workspace: '<img onerror=alert(1)>', link: "https://x.test/l" });
  assert.ok(!m.html.includes("<img"), "the tag never reaches the markup");
  assert.ok(m.html.includes("&lt;img"));
});

test("the expiry line reads in days when the window is a round number of them", () => {
  assert.match(renderMail("roster-invite", { link: "https://x.test/l", expiresHours: 72 }).text, /3 days/);
  assert.match(renderMail("roster-invite", { link: "https://x.test/l", expiresHours: 24 }).text, /1 day\b/);
  assert.match(renderMail("roster-invite", { link: "https://x.test/l", expiresHours: 5 }).text, /5 hours/);
  assert.match(renderMail("roster-invite", { link: "https://x.test/l" }).text, /can be used once/);
});

test("the invite names the person who sent it when there is one, and does not invent one", () => {
  const withInviter = renderMail("roster-invite", { workspace: "w", link: "https://x.test/l", inviter: "ada@example.test" });
  assert.ok(withInviter.text.includes("ada@example.test"));
  const without = renderMail("roster-invite", { workspace: "w", link: "https://x.test/l" });
  assert.ok(!without.text.includes("undefined") && !without.text.includes("null"));
});

// ---- configuration parsing ----------------------------------------------------------------

test("MAIL_FROM parses both spellings of a sending identity", () => {
  assert.deepEqual(parseAddress("Some Name <a@b.test>"), { name: "Some Name", email: "a@b.test" });
  assert.deepEqual(parseAddress('"Some Name" <a@b.test>'), { name: "Some Name", email: "a@b.test" });
  assert.deepEqual(parseAddress("a@b.test"), { name: "", email: "a@b.test" });
  assert.deepEqual(parseAddress("nonsense"), { name: "", email: "" });
  assert.deepEqual(parseAddress(undefined), { name: "", email: "" });
});

test("mailConfig reads every setting off the runtime env and nothing from the engine", () => {
  const cfg = mailConfig(SCW_ENV);
  assert.equal(cfg.provider, "scaleway");
  assert.equal(cfg.apiKey, "k-secret");
  assert.equal(cfg.region, "eu-west");
  assert.deepEqual(cfg.from, { name: "Example", email: "noreply@example.org" });
  assert.equal(mailConfig({}), null);
});
