# Proposal: image and tile nodes must carry a machine-readable description

Status: **proposed, not implemented.** Raised 2026-07-27 from live agent work on
`/ux-ui-audit/project-flow-audit/`. Written for an implementer who was not in that
conversation: everything needed to evaluate it is below.

## The problem

A canvas doc is almost fully self-describing to an agent. Read `GET /__board?path=…` (or the
daemon's `clawd-board.json` mirror) and every sticky, text node, section name and position
arrives verbatim, for roughly nothing. An agent can answer "what does this board argue" from
the doc alone.

Two node types break that, and they are exactly the two carrying the most expensive content:

| node | what the doc gives an agent |
|---|---|
| `image` | `src: "/ux-ui-audit/project-flow-audit/img/08-inputs.jpg"` + `name` |
| `tile` | `url: "/ux-ui-audit/input-workflow/"` + `name` |

The engine already treats these two as the special case. Every other node type derives its
`name` from its own content, so the name is never the only copy of the meaning:

```js
// src/canvas/canvas.js:571
if (node.type !== "image" && node.type !== "tile")
  node.name = (node.text || "").split("\n")[0].slice(0, 60) || autoName(node.type);
```

**`image` and `tile` are the only node types whose meaning is not recoverable from the
document.** That is the whole bug, stated structurally.

### Why "just open it" is not the answer

An agent *can* read the image or drive a browser against the prototype. Both work; both cost
real tokens and about a minute each. The problem is not capability, it is that **an agent
cannot tell whether a node is worth opening without opening it first.** Under that
uncertainty the cheap choice is to skip, and skipping is usually invisible in the output.

Observed, on this board: an agent added a fourth focus area to act 3, chose its position
relative to the existing columns, and wrote its DIRECTION and STILL OPEN copy **without ever
opening the three prototypes already on the board**. The result was coherent, because the
stickies around those tiles are unusually well written and carried the argument. That is luck,
not design. Reverse it (thin stickies, rich prototypes) and the same process produces work
that reads as informed and is not.

### Current `name` values on that board, as evidence

```
"before: input manager"          ← useful
"AFTER · Input workflow"         ← useful-ish, says what, not what it shows
"step: 05-survey.jpg"            ← the filename, echoed. zero information
"before: survey builder (…)"     ← useful
```

No rule, so quality tracks whoever happened to write the node.

## What this is not

- **Not accessibility alt text.** Describing the picture ("a screenshot of a settings panel
  with a blue button") is close to the least useful thing for this purpose. See the rubric
  question below.
- **Not content for one board.** Do not implement this by writing descriptions for the UX
  audit board's prototypes. The deliverable is a structural rule that makes the next board
  legible too. Backfilling existing boards is a separate, optional step.
- **Not a new `name`.** `name` is visible chrome and cannot absorb two sentences:
  it renders under images (`src/canvas/canvas.js:770`, `.gvc-name`), is the tile's visible
  label falling back to the URL (`:814`, `.gvc-tilename`), is inline-editable by double-click
  (`:765`), and is already spent as the `<img alt>` (`:774`, `:916`).

## The proposal

1. **A non-rendering description field on `image` and `tile` nodes.** Name TBD (`alt`,
   `desc`, `note`). Not drawn on the canvas; present in the doc, so it is free to read.
   Node objects round-trip as plain JSON, so the field should survive persistence without
   engine surgery, but the duplicate/copy paths need checking (`:235` renames tile copies).

2. **Required by convention for those two types, and observable.** An agent or a human should
   be able to ask "which nodes on this board are opaque" and get an answer. Whether that is a
   lint, a warning in the daemon's connect log, or a UI affordance is an open question.

3. **The rubric is per canvas, not global — this is the load-bearing idea.** What makes a
   description useful depends entirely on what the board is for. On an argument board, the
   useful line is the claim the node makes ("today's builder: a type palette on the left,
   questions as grey rows, no preview anywhere"). On a design-system board it might be the
   component and its states; on a research board, the finding. Hard-coding one rubric in the
   engine gets it wrong for every board but one.

   So the board itself should carry its rubric: a short instruction on the doc (e.g.
   `doc.descriptionGuide`), written by whoever owns that board, that agents follow when they
   write image and tile nodes. The engine enforces *that a description exists*; the board
   decides *what a good one says*.

4. **For tiles specifically**, the highest-value content is the part static reading cannot
   recover: what the prototype demonstrates when you interact with it, and how it differs
   from the thing it replaces.

## Open questions for whoever implements this

- **Field name and schema placement.** It becomes part of the CANVAS.md "Node schemas" table,
  which is the agent-facing write contract, so the name is load-bearing.
- **Does it surface in the UI at all?** A title attribute or an inspector field, so a human
  can author and correct it, versus purely agent-written metadata. Rob's stated preference is
  that it need not be visible.
- **Enforcement strength.** Convention documented in CANVAS.md, versus a check that reports
  undescribed nodes, versus refusing the write. Note that a refused write would break every
  existing tool that adds a tile.
- **Staleness.** A tile description is a cache of a living artifact. The prototypes on the UX
  audit board changed four times in one day; a description written last week would now be
  confidently wrong, and a wrong description is worse than none because it stops the agent
  from checking. Options: keep descriptions to the stable claim rather than volatile detail,
  regenerate on prototype change, or stamp them with the SHA they described.
- **Backfill.** Existing boards have none. Optional, and separable from the rule itself.
- **Does the canvas template seed a default rubric** for a new board, and what is it?

## Surfaces this touches

- `src/canvas/canvas.js` — node schema, add/duplicate/copy paths, any inspector UI
- `CANVAS.md` — the "Node schemas — the write-side reference" table, which is the contract
  agents are told to obey
- `.claude/skills/canvas-cowork/SKILL.md` — the agent entry point, which teaches the write rules
- `scripts/clawd-canvas.mjs` — the daemon's `upsert` path, possibly a warning on connect
- `scripts/canvas-screen.mjs` — the other out-of-band writer
- the canvas template / loader used to create new boards

## How to feel the problem before deciding

Fetch a board doc and try to answer "what is on this board and what does it argue" using only
the JSON. The stickies will carry it. Then try to answer "what do the prototypes actually
show" and notice there is no way to know which of them is worth a minute of browser time.
