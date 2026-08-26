// The local-dev publish bypass is dead on a deployed instance.
//
// `B-assert-no-bootstrap-token`. PUBLISH_BOOTSTRAP_TOKEN is a plaintext string compared
// with `===`, answering with `space: "*"` — every workspace's published content,
// overwritable, with no KV read, no roster check and no expiry. It exists so `wrangler
// dev` can publish into a local store before any real token has been minted, and the
// comment above publishAuth has always said "never configure it on a deployed instance".
//
// A comment is not a guard. This one is: bundle mode is the engine's own name for "a real
// deployment", so the bypass refuses there and refusing costs local development nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/_worker.js";

const TOKEN = "bootstrap-secret-value";

/** POST a publish check with a bearer token, and collect anything logged. */
async function publish(env, token = TOKEN) {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    const res = await worker.fetch(new Request("https://x.example/__publish/delta/check", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }), env, {});
    return { res, lines };
  } finally { console.log = orig; }
}

const ASSETS = { fetch: async () => new Response("nf", { status: 404 }) };
const R2 = { get: async () => null, put: async () => {}, head: async () => null };
const KV = { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) };

/** A live instance: bundle mode, which is GV_ASSET_SOURCE=r2 AND a BUNDLES binding. */
const deployed = () => ({ ASSETS, BUNDLES: R2, COMMENTS: KV, GV_ASSET_SOURCE: "r2", PUBLISH_BOOTSTRAP_TOKEN: TOKEN });
/** Local dev: assets mode, no bundle store. */
const local = () => ({ ASSETS, COMMENTS: KV, PUBLISH_BOOTSTRAP_TOKEN: TOKEN });

test("a DEPLOYED instance refuses the bootstrap token", async () => {
  const { res } = await publish(deployed());
  assert.notEqual(res.status, 200, "a deployed instance accepted the star-scope bypass");
  assert.ok(res.status === 401 || res.status === 403, `expected an auth refusal, got ${res.status}`);
});

test("the refusal raises an alarm naming the variable and what to do", async () => {
  // The one event here worth waking someone for: the variable is set somewhere it should
  // not be, or somebody is guessing at it.
  const { lines } = await publish(deployed());
  const alarm = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((l) => l && l.level === "alarm");
  assert.ok(alarm, `no alarm was logged: ${lines.join(" | ")}`);
  assert.equal(alarm.event, "bootstrap-token-refused");
  assert.match(alarm.detail, /PUBLISH_BOOTSTRAP_TOKEN/);
  assert.match(alarm.detail, /rotate|unset/i, "the alarm does not say what to do about it");
});

test("THE ALARM CARRIES NO PART OF THE TOKEN", async () => {
  // Not even a prefix. The alarm is that an attempt happened; the value is the thing an
  // attacker is trying to learn, and logs travel.
  const { lines } = await publish(deployed());
  assert.ok(!lines.join("\n").includes(TOKEN), "the token appears in the log output");
});

test("LOCAL DEVELOPMENT IS UNAFFECTED — the bypass still works in assets mode", async () => {
  // The guard is worth nothing if it makes `wrangler dev` unable to publish, because the
  // next person will simply widen it back.
  const { res } = await publish(local());
  assert.notEqual(res.status, 401, "the bypass was refused in assets mode, where it is the point");
  assert.notEqual(res.status, 403, "the bypass was refused in assets mode, where it is the point");
});

test("an instance with the variable UNSET is unaffected either way", async () => {
  for (const env of [deployed(), local()]) {
    delete env.PUBLISH_BOOTSTRAP_TOKEN;
    const { res, lines } = await publish(env);
    // 401/403 on a deployed instance; 501 in assets mode, which has no publish API at
    // all. What matters is that neither grants anything and neither alarms.
    assert.ok([401, 403, 501].includes(res.status), `expected a refusal, got ${res.status}`);
    assert.ok(!lines.some((l) => l.includes("bootstrap-token-refused")),
      "an alarm fired on an instance that has no bootstrap token at all");
  }
});

test("a WRONG token on a deployed instance is refused without an alarm", async () => {
  // The alarm means "the variable is set and somebody presented exactly it". An ordinary
  // bad bearer must not raise it, or the alarm becomes noise and stops being read.
  const { res, lines } = await publish(deployed(), "not-the-bootstrap-token");
  assert.ok(res.status === 401 || res.status === 403);
  assert.ok(!lines.some((l) => l.includes("bootstrap-token-refused")),
    "an ordinary wrong token raised the bootstrap alarm");
});
