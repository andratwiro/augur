// Putting a prototype back to an earlier landing. The server already keeps every landing
// and restores one as a NEW landing (`restoredFrom`), so a revert is never a rewrite: the
// bad landing stays in the history, with the revert above it. This is the piece a person —
// or the on-call agent at 3am — reaches for when a landing broke something.

/**
 * Which landing to put back. With `to`, that revision (it must exist and not be the one
 * already live). Without it, the landing before the newest one: "undo the last landing".
 * @returns {{ok:true, revision:number, current:number}|{ok:false, error:string}}
 */
export function pickRevertTarget(history, to) {
  const landings = (history && Array.isArray(history.landings)) ? history.landings : [];
  if (!landings.length) return { ok: false, error: "no-landings" };
  const current = Number(landings[0].revision);
  if (to != null && to !== "") {
    const want = Number(to);
    if (!Number.isInteger(want) || want < 1) return { ok: false, error: "bad-revision" };
    if (want === current) return { ok: false, error: "already-live" };
    if (!landings.some((l) => Number(l.revision) === want)) return { ok: false, error: "unknown-revision" };
    return { ok: true, revision: want, current };
  }
  if (landings.length < 2) return { ok: false, error: "nothing-before" };
  return { ok: true, revision: Number(landings[1].revision), current };
}

/** One line per landing, newest first, for `augur revert --list`. */
export function historyLines(history) {
  return ((history && history.landings) || []).map((l, i) => {
    const who = l.name || l.by || "someone";
    const from = l.restoredFrom != null ? `  (revert to ${l.restoredFrom})` : "";
    const note = l.note ? `  — ${l.note}` : "";
    return `${i === 0 ? "*" : " "} ${String(l.revision).padStart(4)}  ${l.at}  ${who}${from}${note}`;
  });
}

export async function doRevert({ client, unit, to, note }) {
  let history;
  try { history = await client.history(unit); } catch (e) { return { ok: false, error: "network", message: e.message }; }
  if (history.status) return { ok: false, ...history };
  const pick = pickRevertTarget(history, to);
  if (!pick.ok) return pick;
  let r;
  try {
    r = await client.restore({ unit, revision: pick.revision, note: note || `revert to revision ${pick.revision}` });
  } catch (e) { return { ok: false, error: "network", message: e.message }; }
  if (r.status) return { ok: false, ...r };
  return { ok: true, from: pick.current, to: pick.revision, revision: r.revision, recorded: r.recorded, url: r.url };
}
