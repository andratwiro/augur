// merge3.mjs — line diff and three-way merge, for `augur sync`.
//
// The server never merges (docs/drafts-that-land.md). What the CLI may do, on the agent's
// own disk and for the agent to check, is fold a landing on main into a draft where the two
// sets of changes touch DIFFERENT lines. Where they touch the same lines it stops and says
// so — both versions are handed over, nothing is guessed.
//
// Plain Node, no dependencies. The diff trims the common prefix and suffix first — an
// agent's edit is a few hunks in a mostly identical file — and runs a plain longest-common-
// subsequence table over what is left. A middle region too large for the table (a rewrite,
// not an edit) becomes ONE hunk: coarser, so it conflicts more readily, and never wrong.

/** Cells the LCS table may hold before the middle is treated as one hunk (2000 × 2000). */
export const LCS_CELLS = 4_000_000;

/** Replace hunks turning `a` into `b`, both arrays of lines. */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  return hunksLCS(A, B).map((h) => ({ aStart: h.aStart + pre, aEnd: h.aEnd + pre, bStart: h.bStart + pre, bEnd: h.bEnd + pre }));
}

function hunksLCS(a, b) {
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N) return [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: M }];
  if (!M) return [{ aStart: 0, aEnd: N, bStart: 0, bEnd: 0 }];
  if (N * M > LCS_CELLS) return [{ aStart: 0, aEnd: N, bStart: 0, bEnd: M }];
  // dp[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const dp = new Array(N + 1);
  for (let i = 0; i <= N; i++) dp[i] = new Uint32Array(M + 1);
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, open = null;
  const close = () => { if (open) { open.aEnd = i; open.bEnd = j; hunks.push(open); open = null; } };
  while (i < N || j < M) {
    if (i < N && j < M && a[i] === b[j]) { close(); i++; j++; continue; }
    if (!open) open = { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (j < M && (i >= N || dp[i][j + 1] >= dp[i + 1][j])) j++; // a line of b is inserted
    else i++;                                                    // a line of a is deleted
  }
  close();
  return hunks;
}

const split = (s) => {
  const lines = String(s).split("\n");
  const trailing = lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, trailing };
};

/** Three-way merge of strings. Overlaps are conflicts, never guesses. */
export function merge3(base, mine, theirs) {
  const B = split(base), A = split(mine), C = split(theirs);
  const ha = diffLines(B.lines, A.lines).map((h) => ({ ...h, side: "mine", lines: A.lines.slice(h.bStart, h.bEnd) }));
  const hc = diffLines(B.lines, C.lines).map((h) => ({ ...h, side: "theirs", lines: C.lines.slice(h.bStart, h.bEnd) }));
  const out = [];
  const conflicts = [];
  let pos = 0;
  let i = 0, j = 0;
  const overlaps = (p, q) => p.aStart < q.aEnd && q.aStart < p.aEnd || (p.aStart === p.aEnd && q.aStart === q.aEnd && p.aStart === q.aStart);
  const same = (p, q) => p.aStart === q.aStart && p.aEnd === q.aEnd && p.lines.length === q.lines.length && p.lines.every((l, k) => l === q.lines[k]);
  while (i < ha.length || j < hc.length) {
    const p = ha[i], q = hc[j];
    let take, region;
    if (p && q && overlaps(p, q)) {
      // Grow the region until neither side overlaps it any further.
      let start = Math.min(p.aStart, q.aStart), end = Math.max(p.aEnd, q.aEnd);
      let ii = i + 1, jj = j + 1;
      for (;;) {
        let grew = false;
        while (ii < ha.length && ha[ii].aStart < end) { end = Math.max(end, ha[ii].aEnd); ii++; grew = true; }
        while (jj < hc.length && hc[jj].aStart < end) { end = Math.max(end, hc[jj].aEnd); jj++; grew = true; }
        if (!grew) break;
      }
      const mineLines = applyHunks(B.lines, ha.slice(i, ii), start, end);
      const theirLines = applyHunks(B.lines, hc.slice(j, jj), start, end);
      const identical = mineLines.length === theirLines.length && mineLines.every((l, k) => l === theirLines[k]);
      if (!identical) conflicts.push({ baseStart: start, baseEnd: end, mine: mineLines, theirs: theirLines });
      take = mineLines; region = { aStart: start, aEnd: end };
      i = ii; j = jj;
    } else if (!q || (p && p.aStart <= q.aStart)) {
      take = p.lines; region = p; i++;
    } else {
      take = q.lines; region = q; j++;
    }
    out.push(...B.lines.slice(pos, region.aStart), ...take);
    pos = region.aEnd;
  }
  out.push(...B.lines.slice(pos));
  const trailing = A.trailing || C.trailing;
  return { ok: conflicts.length === 0, text: out.join("\n") + (trailing ? "\n" : ""), conflicts };
}

/** The lines `base[start..end)` become after applying `hunks` (all inside that range). */
function applyHunks(base, hunks, start, end) {
  const out = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.aStart), ...h.lines);
    pos = h.aEnd;
  }
  out.push(...base.slice(pos, end));
  return out;
}
