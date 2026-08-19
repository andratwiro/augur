// Respawn policy for the offline server's wrangler child. Pure on purpose: the
// decision ("respawn in N ms" / "give up") is the part worth testing, and importing
// this must never spawn anything. See test/offline-sandbox.test.mjs.
//
// A crash LOOP (the port is taken, the built worker doesn't parse) must not turn
// into an infinite restart storm: five crashes inside a minute means retrying won't
// help and a human needs the log.
const LOOP_WINDOW_MS = 60_000;
const LOOP_LIMIT = 5;

// crashTimes: ms timestamps of previous unexpected exits (any monotonic clock).
// Returns the delay in ms before the next spawn, or null to give up.
export function respawnDelay(crashTimes, now) {
  const recent = crashTimes.filter((t) => now - t < LOOP_WINDOW_MS).length;
  if (recent >= LOOP_LIMIT) return null;
  // 1s, 2s, 4s, 8s… per recent crash — quick after a one-off, calmer under repeats.
  return 1000 * Math.pow(2, recent);
}
