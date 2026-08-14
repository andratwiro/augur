# How a prototype gets made — receipts and the authoring capture

**Status:** design, approved 2026-08-14
**Touches:** `README.md`, `docs/shots/authoring.gif` (new); `augur-space-fulla` (one new
prototype and its receipt)
**Engine code:** none.

## Problem

The README shows the viewer and never the making. It walks a reader through the
gallery, the boards, the comments and the library — and the reader this repo most
needs to convince, a designer deciding whether any of this matters, asks a different
question first: *where do these screens come from, and who makes them?* The answer —
a prototype is briefed to an agent, not drawn — is the strongest part of the pitch,
and the repo keeps it implicit, spread across `agents/` contracts that are written
for the agent, not the evaluator.

## Goals

- A reader with no terminal experience closes the README understanding the loop: a
  written brief, an agent working in a repo, a real page a minute later, comments on
  its real pixels.
- The brief reads as design work — tone, states, which parts of the design system to
  honor — so the reader thinks "I could write that", not "I could never type that".
- Every claim in the section is verifiable from public artifacts: the brief shown is
  a verbatim excerpt of a committed receipt, the capture shows the session that
  produced a screen that is live in the demo, and the receipt link resolves.
- Zero engine change.

## Non-goals

- No onboarding tutorial and no harness install steps. The "paste this into your own
  agent" move is deferred until it can work without assuming any harness.
- No backfilled receipts. Existing fulla screens were built iteratively; inventing
  clean prompts for them after the fact is exactly the fakery a skeptical evaluator
  sniffs out.
- No product surfacing of receipts (a "made from" layer in the gallery is later,
  product-shaped work).
- No harness-neutrality contortions in the capture: it shows the harness actually
  used, named once.

## Design

### The receipt

`<project>/prompts/<prototype>.md` in the space repo — next to the `prototypes/`
folder, not inside it. By the engine's own publish rule only the contents of
`prototypes/` ever ship, so receipts are unpublished by construction: private for a
real team's space, world-readable in fulla because that repo is public.

Contents, in order: the opening brief, verbatim; the follow-ups that shaped the
result, verbatim, each on its own; one closing line naming the harness and the date.
The follow-ups are deliberately included — they read like design direction
("warmer", "the empty state should suggest the first action"), which is what shows
the loop is directing, not coding.

The honesty rule, stated in the receipt file itself so it travels with the
convention: **a receipt is captured at authoring time, never reconstructed.** A
screen without a receipt says so by having none. Receipts spread to other
prototypes as they are next genuinely re-authored, not in a backfill.

### The featured session

One new, small screen in an existing fulla project, chosen at build time — small
enough that the capture's time-compression stays honest and the brief fits a fenced
block without elision. The session is run for real: prompts land in the receipt as
they are issued, the screen is recorded as it happens. One session produces all
three artifacts — the receipt, the capture, and the shipped screen.

### The README section

Title: **How a prototype gets made.** Placement: after the fulla intro paragraph,
before "Boards where the prototypes run" — the first feature section, because it is
the first question. Four beats, roughly ten lines of prose plus one fenced block and
one image:

1. The claim. There is no editor; a prototype is briefed, not drawn.
2. The brief. A fenced, verbatim excerpt of the receipt, linking to the full file in
   the fulla repo.
3. The capture (below).
4. The receipt line: screens in the demo space carry the session that made them —
   open the repo and read one. Claude Code named once as what the capture shows,
   "or any coding agent" once, done.

Copy claims only what is true at merge time — "screens carry", not "every screen
carries", until receipts actually cover the space.

### The capture

`docs/shots/authoring.gif`, embedded in the section with rich alt text in the
existing idiom. Side by side: the harness terminal on the left, the browser on the
dev server on the right. Beats: the brief pasted in → the agent works,
time-compressed → the one-second hot-reload flip into the finished screen → the
cursor pokes it → Shift+C pins a comment on it. Fifteen to twenty seconds, looping,
ending on pixels rather than terminal. Weight budget: match `canvas-live.gif`
(~2 MB). It will go stale like any shot; that is accepted, and it lives in
`docs/shots/` where staleness is already a tended-to condition.

## Verification

- The README's fenced brief diffs clean against the committed receipt's opening
  brief — verbatim, no elisions.
- The capture's final frame matches the screen live on the demo.
- The receipt link resolves logged-out on github.com.
- The section renders correctly on GitHub: image, fence, links, no raw HTML.

## Build order

1. Engine work branches off `main` (the current avatars line is unrelated).
   Fulla stays on its `main` — space repos ship by publish, and a lingering
   branch would read as drift to the health canary. Author the new screen in
   fulla for real, capturing the receipt and the recording in the same session.
2. Commit screen + receipt in fulla, publish, verify it live on the demo.
3. Cut the gif from the recording; commit under `docs/shots/`.
4. Write the README section and commit. README changes are repo-only — nothing
   deploys.

Each step leaves both repos shippable.
