/**
 * The health checks an instance can run ON ITSELF, from a cron inside its own worker.
 *
 * `A-degithub-runtime`. The acceptance test on that item is "Actions minutes consumed by
 * normal operation: zero", and the canary is the last scheduled job standing between an
 * instance and that number. Today it is `health.yml`, which needs a GitHub runner, a PAT
 * with read on every space repo, and an org whose billing is current — and the 23 August
 * billing outage killed all three for two days while the instances themselves carried on
 * publishing and serving, which is the evidence this item was written from.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ⛔ WHAT THIS DELIBERATELY DOES NOT CHECK, and why the omission is the design.
 *
 * `health.yml` step (g) asks whether a gated path is actually gated. THIS FILE MUST NEVER
 * ASK THAT. A worker probing its own front door is a detector living inside the thing it
 * detects: the request re-enters this same deployment, so a misconfiguration that makes
 * the platform serve assets before the worker is exactly the condition under which the
 * worker's own answer stops being worth anything. This codebase has already paid for that
 * lesson once — the account store's rewind detector was built and DELETED because it tried
 * to detect a rewind using state inside the thing that was rewound, and a detector whose
 * "all clear" is indistinguishable from "detector broken" is worse than none.
 *
 * So the split is by WHO CAN ANSWER HONESTLY:
 *   · Is my content current, and is my engine current?   ← this file. The worker holds
 *     every input directly, and a wrong answer is a wrong answer, not a false all-clear.
 *   · Am I gated?                                         ← `scripts/frontdoor-parity.mjs`,
 *     run from outside, and it stays outside.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Everything here is a PURE FUNCTION of a build stamp, a config and a clock, plus at most
 * one outbound fetch. No storage, no bindings, no request. That is what makes it testable
 * without workerd and what keeps the scheduled handler in _worker.js three lines long.
 */

/** Grace windows, in seconds, matching `templates/shell/health.yml` so the two agree. */
export const HEALTH_GRACE = Object.freeze({
  /** A working-tree publish is fine during a session and not fine left standing. */
  dirty: 21600,      // 6h
  /** Longer than the space self-heal poll (6h), so (f) only fires on a genuine miss. */
  rebake: 28800,     // 8h
  /** A release older than this, with the instance behind it, is worth saying out loud. */
  staleEngineDays: 30,
});

const secondsSince = (iso, now) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.round((now - t) / 1000) : null;
};

const ok = (name, detail) => ({ name, ok: true, detail });
const bad = (name, detail) => ({ name, ok: false, detail });
const skip = (name, detail) => ({ name, skip: true, detail });

/**
 * A working-tree publish that has outlived its window.
 *
 * The bytes a dirty publish serves exist in NO repository, so they cannot be rebuilt,
 * reviewed or rolled forward. That is fine for an hour of active work and not fine left
 * standing, and it is invisible to everyone whose own clone looks right.
 */
export function checkDirtyPublishes(stamp, now, grace = HEALTH_GRACE.dirty) {
  const out = [];
  for (const [id, s] of Object.entries((stamp && stamp.spaces) || {})) {
    if (!s.dirty) { out.push(ok(`clean ${id}`, `published from ${String(s.sha || "?").slice(0, 12)}`)); continue; }
    const age = secondsSince(s.publishedAt, now);
    if (age === null) { out.push(bad(`dirty ${id}`, "serving a working-tree publish with no timestamp, so its age cannot be judged")); continue; }
    if (age <= grace) { out.push(ok(`dirty ${id}`, `working-tree publish ${age}s ago — inside the ${grace}s window`)); continue; }
    out.push(bad(`dirty ${id}`,
      `serving a working-tree publish (base ${String(s.sha || "?").slice(0, 12)}) for ${age}s — those exact bytes exist in no repository. Commit the work and publish again from the ${id} clone.`));
  }
  return out;
}

/**
 * Chrome-bake drift: a space still serving page furniture from an older engine.
 *
 * `engine.sha` moves on every engine deploy; a space's `builtWithEngine` moves only when
 * that space republishes. The gap is invisible from the top-level number alone, which is
 * why the stamp publishes both.
 */
export function checkBakeDrift(stamp, now, grace = HEALTH_GRACE.rebake) {
  const engineSha = stamp && stamp.engine && stamp.engine.sha;
  if (!engineSha) return [skip("bake drift", "no engine sha in the stamp — nothing to compare against")];
  const engineAge = secondsSince(stamp.engine.publishedAt, now);
  const out = [];
  for (const [id, s] of Object.entries((stamp.spaces) || {})) {
    if (!s.builtWithEngine) { out.push(skip(`bake ${id}`, "published before the bake stamp existed")); continue; }
    if (s.builtWithEngine === engineSha) { out.push(ok(`bake ${id}`, "chrome is current")); continue; }
    // The drift is only a FINDING once the self-heal has had its chance. Before that it is
    // the ordinary state of the minutes after an engine bump.
    if (engineAge !== null && engineAge <= grace) {
      out.push(ok(`bake ${id}`, `chrome is ${String(s.builtWithEngine).slice(0, 12)} against engine ${String(engineSha).slice(0, 12)}, and the bump is only ${engineAge}s old`));
      continue;
    }
    out.push(bad(`bake ${id}`,
      `serving chrome baked with ${String(s.builtWithEngine).slice(0, 12)} while the engine is ${String(engineSha).slice(0, 12)} — the re-bake was missed. Republish ${id}.`));
  }
  return out;
}

/**
 * ⚠️ THE ONE CHECK THAT ASKS SOMETHING OUTSIDE, and it asks for a RELEASE, not a tag.
 *
 * `release-drift.mjs` exists because this distinction already cost a release: engine-bump
 * in release mode reads `releases/latest`, so a tag with no release behind it moves
 * nobody. An instance comparing itself against tags would report itself current while
 * every self-hoster was being offered something months older.
 *
 * Unauthenticated on purpose — the engine repo is public, this runs at most a few times a
 * day, and a token here would be a credential an instance holds for GitHub, which is the
 * dependency the whole item exists to remove. A rate-limited or unreachable answer is a
 * SKIP, never a failure: GitHub being down is not this instance being unhealthy.
 */
export async function checkEngineStaleness(stamp, { fetchImpl = fetch, now = Date.now(), repo = "andratwiro/augur", maxAgeDays = HEALTH_GRACE.staleEngineDays } = {}) {
  const mine = stamp && stamp.engine && stamp.engine.version;
  if (!mine) return skip("engine staleness", "this build stamped no engine version, so there is nothing to compare");
  let latest, publishedAt;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "augur-health-cron" },
    });
    if (!res.ok) return skip("engine staleness", `GitHub answered ${res.status} — not asking again until the next run`);
    const doc = await res.json();
    latest = doc && doc.tag_name;
    publishedAt = doc && doc.published_at;
    if (!latest) return skip("engine staleness", "no tag_name on the latest release");
  } catch (e) {
    return skip("engine staleness", `could not reach GitHub (${String((e && e.message) || e).slice(0, 80)})`);
  }
  const norm = (v) => String(v || "").replace(/^v/, "");
  if (norm(latest) === norm(mine)) return ok("engine staleness", `running ${mine}, which is the newest release`);
  const age = secondsSince(publishedAt, now);
  const days = age === null ? null : Math.floor(age / 86400);
  // Behind, but only recently. Naming that as a failure would make every instance red for
  // the hours between a release and its own bump, which is the normal state.
  if (days !== null && days < maxAgeDays) {
    return ok("engine staleness", `running ${mine}; ${latest} is ${days}d old and the bump has not arrived yet`);
  }
  return bad("engine staleness",
    `running ${mine} while ${latest}${days === null ? "" : ` (${days}d old)`} is the newest release. If your own CI is broken this is the only place that will say so.`);
}

/**
 * The whole report. `checks` is a flat list so a caller never has to know the shape of
 * each family, and `failures` is derived rather than counted by hand.
 *
 * ⚠️ IT RETURNS A REPORT EVEN WHEN IT FAILS TO PRODUCE ONE. A cron that threw would leave
 * the last report standing and reading as current, which is the failure this whole file
 * exists to avoid — "healthy" and "nobody looked" must never be the same answer.
 */
export async function runHealth({ stamp, now = Date.now(), fetchImpl = fetch, repo, grace = HEALTH_GRACE } = {}) {
  const checks = [];
  try {
    if (!stamp) {
      checks.push(bad("build stamp", "the instance could not compose its own build stamp — nothing below could be computed"));
    } else {
      checks.push(...checkDirtyPublishes(stamp, now, grace.dirty));
      checks.push(...checkBakeDrift(stamp, now, grace.rebake));
      checks.push(await checkEngineStaleness(stamp, { fetchImpl, now, repo, maxAgeDays: grace.staleEngineDays }));
    }
  } catch (e) {
    checks.push(bad("health cron", `the run itself threw: ${String((e && e.message) || e).slice(0, 200)}`));
  }
  const failures = checks.filter((c) => c.ok === false).length;
  return {
    at: new Date(now).toISOString(),
    ok: failures === 0,
    failures,
    // Every check, passing ones included. A report that listed only failures could not be
    // told apart from a report that ran nothing.
    checks,
  };
}
