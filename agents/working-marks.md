# Working marks — say what you are about to touch, read what everyone else is

Nothing in a workspace used to say what was already being worked on. Two people's
agents, on two machines, both told to improve "the checkout flow", would each open
the same folder, each edit it, and find out at publish time — where the answer is a
fork, a conflict file and an afternoon nobody planned.

A **mark** is a note on a path saying *something is editing here right now*. It
carries the path, a one-way id for who left it, when it started, and how long it is
good for. That is all it is.

## ⚠️ It is not a lock, and you must not treat it as one

A mark **grants nothing and refuses nothing**. A marked path can still be opened,
edited, published and shipped by anybody, including you. Nothing in the engine asks
a mark for permission — not the gate, not the publish handler, not the commit.
`augur mark` exits 0 whatever it finds.

So do not write a script that blocks on a mark, retries until one clears, or treats
one as a failure. When coordination genuinely fails, the composed publish settles it
on evidence after the fact (see [publishing.md](./publishing.md)) — that is the part
that is allowed to refuse, and it is the only part.

## The protocol, in one line

**Read the marks before you start. Leave one when you do.**

```
augur mark                              what is being worked on right now
augur mark <path> [--ttl <seconds>]     leave a mark on it, then start
augur mark <path> --clear               take yours down early
augur mark … --json                     the same answer, for a tool to read
```

A path is a URL path (`/checkout/flow/`). The repo folder is accepted and
translated, so `checkout/prototypes/flow` — the folder you were just editing —
marks the URL it publishes to. The line printed back is always the instance's own
spelling; do not assume yours won.

Marking a path that somebody else already marked **still works**, and prints their
mark next to yours. That is the whole design: you now know, and you choose. Pick a
different path, wait it out, or carry on knowing you will be merging.

## It expires by itself

A mark is good for ten minutes by default and an hour at the most. The instance
stops reporting it the moment that passes, whether or not anything ever clears it.

That is the point rather than a detail. The thing leaving marks is a process that
can be killed — an interrupt, an out-of-memory, a closed laptop — and a claim that
outlives the claimant is worse than no claim at all, because the next reader
believes it. **`--clear` is a courtesy, never the guarantee.** There is no cleanup
job to run and none to forget.

If the work is genuinely still going when the mark lapses, mark it again. An agent
that wants a four-hour mark is describing a lock, and the answer to a lock is a
short mark re-written as the work continues.

## Where marks show up without being asked for

- `augur status` prints what is being worked on, under the live-vs-clone table.
- `augur clone` and `augur pull` print the marks on the paths they are about to
  write, before the first byte lands — and write anyway, with the same exit code
  as always.
- A gallery card carries a small badge (*"… is working on this"*) while a mark on
  that exact URL is live, and drops it when the mark lapses.

The badge is the **byproduct**, not the point. As an agent's edit shrinks toward
seconds, a mark is felt almost never and read always — which is why the write side
is the CLI and the browser side only ever reads.

## What is stored

`{path, personId, startedAt, ttl}` — and `personId` is the same one-way fingerprint
a comment carries, so a mark holds **no address**. The display name beside it is
resolved from the roster at read time, never stored, so a rename shows through and
somebody who has left resolves to "Someone".

Marks are workspace state, not published content: they are covered by
`augur export --full`, and a restore deliberately drops them (see
`src/state-inventory.mjs`) rather than reinstating a claim about a moment that has
passed.
