// Which store a local preview talks to.
//
// This logic had ZERO coverage and decides the one thing about local development that can
// hurt somebody else: whether `npm run offline` reads and writes the LIVE KV namespace —
// real comments, real pins, real rosters, real boards — or a local sandbox.
//
// Getting it backwards is silent in both directions. A run that thinks it is live but is
// not shows an empty site and wastes an afternoon. A run that thinks it is a sandbox but
// is not writes a stranger's comment thread from a half-finished branch. Neither prints a
// warning, because both are working exactly as the code says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, derivePosture, postureVars, postureBanner } from "../scripts/lib/offline-posture.mjs";

const FULL = {
  CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct", GV_KV_NS: "ns",
};

test("all three credentials present means LIVE", () => {
  const p = derivePosture(FULL);
  assert.equal(p.live, true);
  assert.equal(p.kv, "live");
  assert.deepEqual(p.secrets, { GV_KV_TOKEN: "tok", GV_KV_ACCOUNT: "acct", GV_KV_NS: "ns" });
});

test("no credentials means SANDBOX, and realtime is disabled with it", () => {
  // The half somebody would drop by accident. A sandbox whose boards still broadcast into
  // the shared production rooms is not a sandbox — the two halves have to agree or a
  // board's persistence diverges silently between its KV doc and its live room.
  const p = derivePosture({});
  assert.equal(p.live, false);
  assert.equal(p.kv, "local");
  assert.equal(p.realtime, "disabled");
  assert.equal(p.secrets.GV_RT_DISABLE, "1", "a sandbox must disable realtime outright");
});

test("EVERY partial credential set is a sandbox, never a live run", () => {
  // The direction this is allowed to be wrong in. Two of three present must never be
  // resolved optimistically.
  const keys = Object.keys(FULL);
  for (const missing of keys) {
    const partial = { ...FULL };
    delete partial[missing];
    const p = derivePosture(partial);
    assert.equal(p.live, false, `missing ${missing} still produced a LIVE posture`);
    assert.equal(p.secrets.GV_RT_DISABLE, "1");
  }
  // And every pair-only case, for completeness.
  for (const only of keys) {
    const p = derivePosture({ [only]: FULL[only] });
    assert.equal(p.live, false, `only ${only} produced a LIVE posture`);
  }
});

test("a partial set SAYS what is missing, instead of looking like broken credentials", () => {
  const p = derivePosture({ CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" });
  assert.match(p.reason, /GV_KV_NS/);
  assert.deepEqual(p.missing, ["GV_KV_NS"]);
});

test("realtime follows KV: live without the secret runs solo, live with it joins", () => {
  assert.equal(derivePosture(FULL).realtime, "solo");
  assert.match(derivePosture(FULL).reason, /solo/);
  const joined = derivePosture({ ...FULL, RT_SHARED_SECRET: "s" });
  assert.equal(joined.realtime, "joined");
  assert.equal(joined.secrets.RT_SHARED_SECRET, "s");
});

test("a realtime secret WITHOUT KV credentials never produces a live posture", () => {
  // Otherwise a stray secret in .env.deploy joins the shared production rooms from a
  // sandbox — boards broadcasting into other people's sessions with local storage behind
  // them, which is the worst of both.
  const p = derivePosture({ RT_SHARED_SECRET: "s" });
  assert.equal(p.live, false);
  assert.equal(p.realtime, "disabled");
  assert.equal(p.secrets.RT_SHARED_SECRET, undefined);
});

test("forceSandbox beats credentials, and there is no inverse flag", () => {
  const p = derivePosture({ ...FULL, RT_SHARED_SECRET: "s" }, { forceSandbox: true });
  assert.equal(p.live, false);
  assert.equal(p.secrets.GV_RT_DISABLE, "1");
  assert.equal(p.secrets.GV_KV_TOKEN, undefined, "a forced sandbox still handed out the live token");
  // Nothing may turn a sandbox into a live run except the credentials themselves.
  const src = parseEnvFile("");
  assert.equal(derivePosture(src, { forceLive: true }).live, false, "a forceLive option must not exist");
});

test("THE BANNER NEVER CARRIES A CREDENTIAL", () => {
  // It prints on every run, and a token echoed on every local start ends up in a screen
  // recording. This is also why the banner takes the posture rather than the env file.
  const banner = postureBanner(derivePosture({ ...FULL, RT_SHARED_SECRET: "supersecret" }));
  for (const v of ["tok", "acct", "supersecret"]) {
    assert.ok(!banner.includes(v), `the banner leaked ${v}: ${banner}`);
  }
  assert.match(banner, /KV: live/);
  assert.match(postureBanner(derivePosture({})), /KV: local/);
});

test("the vars argv matches the posture's secrets exactly", () => {
  const argv = postureVars(derivePosture(FULL));
  assert.deepEqual(argv, [
    "--var", "GV_KV_TOKEN:tok",
    "--var", "GV_KV_ACCOUNT:acct",
    "--var", "GV_KV_NS:ns",
  ]);
  assert.deepEqual(postureVars(derivePosture({})), ["--var", "GV_RT_DISABLE:1"]);
});

test("a secret containing a colon survives the argv form", () => {
  // `wrangler dev --var K:V` splits on the FIRST colon and keeps the rest. The separator
  // is a colon and not an `=` because `--var K=V` binds nothing AND reports nothing — the
  // worker just sees an absent value, which for GV_KV_TOKEN reads as "no live KV" and for
  // RT_SHARED_SECRET as "the realtime worker is refusing me".
  const argv = postureVars(derivePosture({ ...FULL, RT_SHARED_SECRET: "a:b:c" }));
  assert.ok(argv.includes("RT_SHARED_SECRET:a:b:c"));
  assert.ok(argv.every((a, i) => i % 2 === 1 ? !a.startsWith("-") : a === "--var"));
});

test("parseEnvFile tolerates comments, blanks and a missing file", () => {
  const e = parseEnvFile("# a comment\n\nCLOUDFLARE_API_TOKEN=abc\n  GV_KV_NS = ns \nnot a line\n");
  assert.equal(e.CLOUDFLARE_API_TOKEN, "abc");
  assert.equal(e.GV_KV_NS, "ns");
  assert.deepEqual(parseEnvFile(""), {});
  assert.deepEqual(parseEnvFile(undefined), {});
});

test("a value containing a # is kept whole", () => {
  // An unquoted # starting a comment truncated a 24-character password to 6 elsewhere in
  // this project and produced a 401 that looked like a wrong credential.
  assert.equal(parseEnvFile("CLOUDFLARE_API_TOKEN=abc#def\n").CLOUDFLARE_API_TOKEN, "abc#def");
});
