// Which store a local preview talks to, and whether its canvas joins the real rooms.
//
// WHY THIS IS ITS OWN FILE. It used to be twenty lines in the middle of offline.mjs with
// no coverage at all, and it decides the one thing about local development that can hurt
// somebody else: whether `npm run offline` reads and writes the LIVE KV namespace — real
// comments, real pins, real rosters, real canvas boards — or a local sandbox.
//
// Getting it backwards is silent in both directions. A run that thinks it is live but is
// not shows an empty site and wastes an afternoon. A run that thinks it is a sandbox but
// is not writes a stranger's comment thread from a half-finished branch. Neither prints
// a warning, because both are working exactly as the code says.
//
// A refactor of exactly this code is how the second one ships green, which is why it is
// now a pure function with a table of cases under it.
//
// THE RULE, and it is one rule with two halves that must agree:
//
//   LIVE     the credentials for the real namespace are all present, so the worker talks
//            to production KV through the REST shim. If the instance's realtime secret is
//            there too, the canvas joins the real rooms; without it the realtime worker
//            answers 403 and the canvas degrades to solo, which is correct but worth
//            knowing.
//   SANDBOX  no credentials, so KV is local — AND realtime is disabled outright. A
//            "sandbox" whose boards still broadcast into the shared production rooms is
//            not a sandbox, and that half is the one somebody would drop by accident.

/** Parse a KEY=value env file. Tolerant by design: a missing file is an empty posture. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Decide the posture from a parsed env file.
 *
 * Returns {live, realtime, reason, kv, secrets} where `secrets` is a name→value map the
 * caller turns into bindings. `reason` is a sentence for a human: this is the value that
 * gets printed, and a posture nobody prints is a posture nobody checks.
 */
export function derivePosture(envFile = {}, opts = {}) {
  const e = envFile || {};
  const wanted = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GV_KV_NS"];
  const present = wanted.filter((k) => e[k]);
  const live = present.length === wanted.length;

  // An explicit sandbox request beats credentials that happen to be lying around. There
  // is deliberately no inverse flag: nothing may turn a sandbox into a live run except
  // the credentials themselves being present.
  if (opts.forceSandbox) {
    return {
      live: false, realtime: "disabled",
      reason: "sandbox (forced): local KV, realtime disabled",
      kv: "local", secrets: { GV_RT_DISABLE: "1" },
    };
  }

  if (!live) {
    // PARTIAL credentials are the case worth naming. Two of three present means somebody
    // is halfway through configuring, and silently running as a sandbox reads as "the
    // credentials do not work".
    const partial = present.length > 0;
    return {
      live: false, realtime: "disabled",
      reason: partial
        ? `sandbox: local KV, realtime disabled — ${wanted.filter((k) => !e[k]).join(", ")} missing from .env.deploy`
        : "sandbox: local KV, realtime disabled",
      kv: "local", secrets: { GV_RT_DISABLE: "1" },
      missing: wanted.filter((k) => !e[k]),
    };
  }

  const secrets = {
    GV_KV_TOKEN: e.CLOUDFLARE_API_TOKEN,
    GV_KV_ACCOUNT: e.CLOUDFLARE_ACCOUNT_ID,
    GV_KV_NS: e.GV_KV_NS,
  };
  if (e.RT_SHARED_SECRET) {
    secrets.RT_SHARED_SECRET = e.RT_SHARED_SECRET;
    return {
      live: true, realtime: "joined",
      reason: "LIVE production KV, and the canvas joins the real rooms",
      kv: "live", secrets,
    };
  }
  return {
    live: true, realtime: "solo",
    reason: "LIVE production KV; no RT_SHARED_SECRET, so boards run solo (the realtime worker will 403)",
    kv: "live", secrets,
  };
}

/**
 * The wrangler argv a posture implies: `--var K:V` per secret.
 *
 * ON ARGV RATHER THAN IN THE GENERATED CONFIG. These values are a Cloudflare API token and
 * the shared realtime secret, read out of `.env.deploy`. Putting them in the wrangler.toml
 * the offline server writes would be a SECOND copy of a live credential on disk, in a file
 * nobody edits and everybody forgets — the first copy at least announces itself by name.
 *
 * `--var K:V` splits on the FIRST colon and keeps the rest, so a secret containing colons
 * survives (verified against the wrangler this repo spawns). `--var K=V` is silently
 * ignored — it binds nothing and reports nothing, which is why this is one function with a
 * test rather than a string built at the call site.
 */
export function postureVars(posture) {
  return Object.entries(posture.secrets || {}).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
}

/**
 * The line a human reads before deciding whether to type anything. It must never carry a
 * credential — the whole point is that it is printed on every run, and a token echoed on
 * every local start ends up in a screen recording.
 */
export function postureBanner(posture) {
  return `[offline] KV: ${posture.kv} — ${posture.reason}`;
}
