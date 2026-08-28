# Moving a workspace without losing what somebody wrote during the move

Moving a workspace is three steps — copy it, check the copy, point the hostname at the new
home — and the whole problem lives in the gap between them. Anything written to the OLD
instance after the copy is taken goes into a copy nobody will ever read again. Not lost
noisily: lost the way a comment is lost when somebody posts it, watches it appear, and
comes back tomorrow to a page that never had it.

So the old instance stops accepting writes for the length of that gap, and says so.

## Only writes stop

The other way to do this is to pull the route or the DNS record. That is simpler and it
takes reads down too. On a real workspace the copy and the verification are minutes, and
minutes of dark site looks like an outage to everybody who is not migrating — including
the people whose only involvement is that they had a link open.

A freeze leaves the site up. A reader sees exactly what was there. Somebody who tries to
change something is told, with a 503 that says why and roughly when to come back, instead
of watching their comment appear and vanish overnight.

Signing in is deliberately **not** frozen: whoever is running the migration has to be able
to get in and look at what is about to move.

What a freeze closes is one list in the engine (`FROZEN_WRITES` in `src/_worker.js`), so
"what does a freeze stop" is a question you answer by reading a list rather than by
grepping for routes.

## The procedure

One command does the middle of it:

```bash
augur migrate --from https://old --to https://new --freeze
# … look at the new home, then point the hostname at it …
augur thaw                                     # prints how long the freeze lasted
```

`migrate` freezes, exports everything, restores it, and then READS THE TARGET BACK and
compares it family by family — which is the step that makes a run worth anything, because
a migration that reports success without reading the far side has reported that it sent
some requests. It is safe to run again after a failure: nothing accumulates and nothing
double-writes, so the fix for a run that died is to run it.

It deliberately does not thaw and does not touch DNS. Both need a person.

By hand, the same thing is:

```bash
augur freeze --reason "moving to <new home>"   # writes start being refused within ~10s
augur export --out <dir> --full                # content + roster + comments + boards
augur restore <dir> --state                    # into the new home, then look at it
# … point the hostname at the new home …
augur thaw                                     # prints how long the freeze lasted
```

`augur freeze --status` answers whether an instance is frozen and since when, which is the
question somebody asks when a publish fails and they were not told a migration was
happening.

**Publish the duration.** `thaw` prints it because somebody planned around that number —
an instance being moved on somebody else's behalf has people who arranged their afternoon
around "about ten minutes", and "about ten minutes" from memory is not a number. Put the
real one in whatever you told them.

## Things worth knowing before you need them

- **Nothing lifts a freeze on its own.** No timeout, no expiry. A migration that dies
  halfway leaves the workspace read-only until somebody runs `thaw`, which is the right
  way round: a freeze that expired by itself would un-freeze in the middle of a cutover
  nobody was watching.
- **Re-freezing does not restart the clock.** A migration script that retries its first
  step does not reset the number the duration is measured from.
- **A freeze does not fail open.** If the store read fails, the last answer stands. A thaw
  arriving one tick late costs nothing; a freeze evaporating for a tick is a write into a
  copy nobody will read.
- **The routes that lift a freeze can never be frozen by one.** Otherwise the only way to
  unfreeze an instance would be a request it refuses.
- **It is per instance, not per workspace.** The flag lives in the instance's own store,
  so it stops writes to everything that instance serves. On a single-workspace instance
  those are the same thing; on a shared one, freeze the workspace's own new home instead
  and move it there rather than freezing the neighbours.
- **A freeze is not a backup.** It stops new writes; it does not make the copy you already
  took any more complete. Take the copy AFTER freezing, not before.

## What the copy does not carry, and what a cutover has to do about it

`augur migrate` reports "every family matches" by reading the target back through its own
export and diffing it against the source's. That is the right check and it is not the whole
check, because three things are outside what any comparison of two exports can see. They
were found by attacking this path rather than by exercising it, and each is a step rather
than a caveat. `test/export-adversarial.test.mjs` holds the repeatable half.

**A board does not travel in the export, and the verification cannot tell.** The export
reads the `board:` documents out of KV, and KV holds a MIRROR that the room writes on a
dirty alarm. The target's export reads the copy the restore just wrote there. So the two
sides agree whether or not the mirror was current — and the normal state of a live board is
that it is not. Measured on a live instance with nobody editing: the mirror held 21 nodes,
the room held 24. `migrate` therefore moves each board over a WebSocket with
`board-snapshot move` after the family diff, and fails if one will not move. Doing it by
hand, that is one command per board, and `board-snapshot lag` first:

```bash
node scripts/board-snapshot.mjs lag  --origin https://old --path /some/board/
node scripts/board-snapshot.mjs move --from https://old --to https://new --path /some/board/
```

`lag` reports NODES OUTSTANDING, not seconds. Wait on that number reaching zero; never on a
clock, because the mirror can be much further behind than its cadence implies.

**And the board step runs AFTER the family diff, so a family diff that fails on correct data
takes the board step with it.** That is not hypothetical: a family that is empty reads as
`{}` from shared KV and, on the workspace-object backing, used to read as ABSENT — so the
diff put `{}` against nothing, called two identical empty families a mismatch, and stopped
above the one step that reads a board from the room that owns it. On a KV → workspace move,
which is the only kind this platform does, the board move could therefore never run. The
rule now, and it is per family rather than blanket:

- a **whole-document** family (`statuses`, the identity documents) is one document. Absent
  and empty are the same answer — there is no third state — so the two compare equal.
- a **set-of-documents** family (`c:`, `board:`, `pins:`) reports an empty set as `{}`.
  Absent there means that export could not ENUMERATE the family, so the run refuses rather
  than reading it as empty: the copy may well be perfect, and this run cannot say so.

Nothing with content in it is ever waved through — both sides have to hold nothing before
the kind is even consulted. Note that this is a rule for the VERIFY only: a restore still
CLEARS a family handed to it as `{}` and LEAVES one it is not given at all, which is the
asymmetry the checklist below ends on.

**A freeze does not stop canvas editing.** `isFrozenWrite` exempts GET and a WebSocket
upgrade is a GET, so `/__rt` stays open for the whole window. Somebody with a board open
can go on moving nodes and pasting images while the migration runs, into a room on the
instance being retired. The `/__board` KV rail *is* frozen, so those edits cannot even
reach the mirror the export reads. This is why the board step is allowed to refuse: a board
that reads as `unstable` is one somebody is editing right now, and the answer is to find
them, not to force it.

**Publish history does not come with it.** `augur export --history` walks every retained
version and downloads every blob any of them referenced; a restore replays none of it. The
target holds one version per space, so `augur rollback` there reaches nothing until it has
published a few times of its own. The archive is intact on disk under `versions/` and the
source keeps its live history until it is retired — so the sequence that preserves a
rollback target is to keep the old instance up, not to keep the copy.

## The adversarial checklist

Run before trusting this path with a workspace that matters. The automated half is
`node --test test/export-adversarial.test.mjs`; the rest needs two real instances.

| | What is being attacked | What must happen |
|---|---|---|
| 1 | Kill the export mid-download, then re-run it | No file on disk is short or misnamed; the resume completes the copy |
| 2 | Truncate a blob in an existing copy, re-export | It is re-fetched, loudly — never skipped as "present" |
| 3 | Corrupt a blob without changing its length, restore | The store refuses on the hash; nothing is committed |
| 4 | Restore an older copy over newer, different live content | Refused, naming `--force` |
| 5 | Restore the same copy twice | Second run succeeds, uploads nothing, changes only the version |
| 6 | Kill a restore between the content and the state, re-run | Converges; no `--force` needed and nothing to undo first |
| 7 | Restore into a target whose `/_build.json` is unreachable | Proceeds, and SAYS the bury guard is off |
| 8 | Restore a copy of an instance where a family was never written | An overlay family clears the target's; an identity family is left alone. Know which before you restore onto a workspace that already has people |
| 9 | Export and restore a PNG canvas image | It arrives still declared a PNG. A copy taken before `assets.json` existed cannot, and the restore says so |
| 10 | Export a board, then compare it with `board-snapshot read` | They differ whenever the mirror is behind — which is why 1–9 passing is not enough |

Two things this cannot exercise on a small instance, and they should be said rather than
assumed: **volume** — the instances this was exercised against hold a board KV of two
documents and a namespace of thirteen keys, so nothing here has met a KV listing that
paginates or a blob set large enough for the concurrency to matter — and **a real
interrupted network transfer**, as opposed to a killed process.
