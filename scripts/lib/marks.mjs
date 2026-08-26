// Working marks, client side — one definition of the path spelling and one of the phrasing.
//
// `F-presence-marks`. Three commands surface marks (`mark`, `status`, `pull`) and a fourth
// will. If each spelled a path its own way, two agents naming the same folder would write
// two rows and read past each other — which is the exact failure the feature exists to
// prevent, arriving through the tool that was supposed to prevent it. So the normalization
// here MIRRORS `normalizeMarkPath` in src/_worker.js on purpose, and the server's answer is
// always the one printed back: the client never assumes its own spelling won.
//
// ⚠️ A MARK REFUSES NOTHING. Nothing in this file returns a verdict, sets an exit code, or
// gives a caller something to branch on that would let it block. It reads, and it prints.

/** Leading and trailing slash. Same rule as the worker, for the same containment reason. */
export function normalizeMarkPath(p) {
  const s = String(p == null ? "" : p).trim().slice(0, 300);
  if (!s) return "";
  const t = s.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!t || t === "/") return "/";
  return `/${t.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

/**
 * A REPO folder, as the URL it publishes to.
 *
 * `<project>/prototypes/<name>` is the nesting `discoverSpaces()` looks in, and it is
 * served at `/<project>/<name>/`. An agent has just been editing the folder, so it is the
 * folder it will type; taking it without translation would mark a path no card and no
 * published unit will ever match.
 */
export function markPathFor(input) {
  return normalizeMarkPath(String(input == null ? "" : input).replace(/\/prototypes\//g, "/"));
}

/** Does either path contain the other? The whole overlap test. */
export function marksOverlap(a, b) {
  const x = normalizeMarkPath(a), y = normalizeMarkPath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * Of the marks that were there before you wrote yours, whose are worth telling you about.
 *
 * ⚠️ "SOMEBODY ELSE" IS DECIDED BY WHO, NEVER BY WHERE, and this function exists so that
 * decision has somewhere to be tested. The obvious way to stop your own renewal warning at
 * you is to drop the exact path from the list — and that silently drops the ONE case the
 * whole feature exists to surface: two agents on the same prototype. It shipped that way
 * once and printed nothing at all for an exact collision, which is worse than not having
 * the warning, because it reads as an all-clear.
 *
 * `mine` is the id the INSTANCE resolved from the credential and handed back, never one the
 * client worked out for itself — the same rule the row's authorship follows.
 */
export function othersOverlapping(before, path, mine) {
  return (before || []).filter((m) => m && m.personId !== mine && marksOverlap(m.path, path));
}

/**
 * Every live mark at an instance. NEVER THROWS: a `status` or a `pull` that died because
 * the coordination note could not be fetched would make the note the most fragile thing in
 * the toolchain. An older instance answers 404 and gets an empty list, which reads exactly
 * like "nobody is working on anything" — and is the right answer there, because on that
 * instance nobody can be.
 */
export async function fetchMarks(req) {
  try {
    const r = await req("_marks/list");
    const body = await r.json();
    return Array.isArray(body.marks) ? body.marks : [];
  } catch (e) { return []; }
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "4 minutes ago" / "just now", from a millisecond age. */
export function since(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "just now";
  if (s < 5400) return `${plural(Math.round(s / 60), "minute")} ago`;
  return `${plural(Math.round(s / 3600), "hour")} ago`;
}

/**
 * "for another 6 minutes", from a millisecond remainder.
 *
 * Switches to hours at exactly 3600s rather than at the 90 minutes `since` uses, because
 * a mark's ceiling IS an hour: at the other threshold the longest mark anybody can ask
 * for would read "for another 60 minutes", and the hours branch could never fire at all.
 */
export function forAnother(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `for another ${plural(s, "second")}`;
  if (s < 3600) return `for another ${plural(Math.round(s / 60), "minute")}`;
  return `for another ${plural(Math.round(s / 3600), "hour")}`;
}

/**
 * One line per mark. `by` is null when the id behind the mark resolves to nobody on the
 * roster — a token an admin labelled by hand, or somebody who has since left — and
 * "Someone" is the honest rendering of that, never a guess.
 */
export function markLine(m) {
  const who = m.by || "Someone";
  const started = Date.parse(m.startedAt);
  const age = Number.isFinite(started) ? since(Date.now() - started) : "";
  return `${m.path}  ${who}${age ? ` · started ${age}` : ""} · ${forAnother(m.expiresIn)}`;
}
