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
