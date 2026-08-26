# The canon — how canonical screens and parts are named

The canon is the part of a workspace that is meant to be **pulled by name**: "build it
the way `invoice-detail` is built", "pull `invoice-list`, `invoice-detail` and
`invoice-empty` and wire them together". That instruction is the whole return on having a
design system, and it presumes `invoice-detail` names something an agent can find COLD —
no human pointing, in a session that has never seen this workspace before.

Names decide whether that works, and names drift the moment they are only a habit. One
screen lands as `checkout-v2`, the next as `new_Checkout`, a third as a scratch folder
wearing the same name as a canonical page, and the instruction stops resolving. Renaming
everything afterwards works and costs a day. This file is the scheme that makes the day
unnecessary, and `augur canon` is that scheme as a command.

**Resolving a name is one line, and it needs nothing else read first:**

```bash
augur canon find invoice-detail    # → the tier, the folder, the entry page, what it links
augur canon list                   # → every canonical name with its one-line description
```

Both read the tree at the moment they are asked. There is no index file, so there is
nothing to regenerate and nothing that can be stale — the directory names ARE the index.
That holds only while they obey the scheme below, which is what `augur canon check` is
for.

## Where the canon lives

Four directories at the workspace root. Each is published and gets its own tab on the
site, and the build reads them directly — this is the engine's existing contract, not a
new layout.

| Where | What it holds | Pull it when |
| --- | --- | --- |
| `base/<name>/` | one atom, every state on one page | you need the button, the input, the badge |
| `components/<name>/` | one composed component | you need the thing itself |
| `patterns/<name>/` | an arrangement several screens repeat | you need the layout, not the parts |
| `pages/<name>/` | a whole screen | somebody said "pull screens X, Y, Z" |

Everything else in a workspace is **not** the canon, and a bare name never means one of
them. A folder under `<project>/prototypes/` is a working prototype — an exploration,
kept as the record of one. `playground/` is scratch. Both can be promoted; see
[Growing the canon](#growing-the-canon).

## The name

**A canonical name is a directory name, and there is no second name.** The live site can
rename what a card DISPLAYS (that override lives in KV, not in the repo) and it never
changes what a name resolves to. If the two disagree, the folder is right.

**Form.** Lowercase ASCII letters, digits and single hyphens — `^[a-z0-9]+(-[a-z0-9]+)*$`.
No underscores, no spaces, no capitals, forty characters and four words at the outside.

**Subject first, qualifier last.** `invoice-list`, `invoice-detail`, `invoice-empty` —
never `list-of-invoices`, never `empty-invoice`. This is the rule that does the work:
A→Z sorts a subject's screens together, so a directory listing reads as a table of
contents and "pull the invoice screens" is one glance instead of a search. It is also
what lets somebody who knows one name in a family guess the rest.

**The qualifier comes from a closed set**, so the same idea is spelled the same way in
every workspace and an agent told "the empty state of the invoice list" can write down
`invoice-empty` without asking:

`-list` · `-detail` · `-new` · `-edit` · `-empty` · `-error` · `-loading` · `-confirm` · `-success`

Anything else at the end of a name is a second subject word, not a state. `-index`,
`-view`, `-show`, `-create`, `-add`, `-blank`, `-none`, `-fail`, `-done` and `-ok` are
the near misses — every one means a word already on the list, and `augur canon check`
names them rather than renaming anything, because which of two words a team says is
theirs to settle.

**A name says WHAT, never WHEN.** `-v2`, `-final`, `-copy`, `-old`, `-wip`, `-draft`,
`-tmp`, `-test`, a date, a ticket id — all refused. Every one encodes a moment in
somebody's afternoon, and a name carrying one cannot be guessed by the person who has to
pull it tomorrow. The version of a canon entry is its git history. (`-new` is on the
allowed list because it is a state — the create screen; `-new2` is not.)

**One name, one thing.** A name resolves in exactly one tier. Two tiers holding the same
name fails `check`; a prototype or playground folder holding a canonical name is reported
as a shadow, because the canon wins and that copy is one nobody will ever be sent to.

**Every entry says what it shows**, in one sentence in `<meta name="description">` — the
same tag the gallery card, the link preview and the canvas insert-picker already read
(see [prototype-contract.md](./prototype-contract.md)). `augur canon list` prints it, and
it is the only way a name is found by somebody who does not know it yet. An entry without
one fails `check`, and `augur canon save` refuses to create one.

## Growing the canon

A canon that only grows when somebody schedules an afternoon for it does not grow. The
promotion is therefore one command, run at the moment the screen is finished and still
in front of you:

```bash
augur canon save orders/prototypes/order-detail        # → pages/order-detail/
augur canon save playground/filter-bar --tier components
augur canon save . --as invoice-detail --dry-run
```

What it does, and what each part of it exists to prevent:

- **Copies, never moves.** The prototype stays where it is: comment pins are keyed to the
  URL a screen was reviewed at, and the prototype is the record of the exploration. The
  canon entry is the thing to copy from. When the two later disagree, `check` reports the
  shadow rather than guessing which is current.
- **Applies the naming rules, and says so.** A source folder called `order-detail-v2`
  promotes as `order-detail`, with the change printed. `--as <name>` overrides.
- **Repoints the design-system references for the new depth.** A prototype three levels
  down references `../../../skills/<prefix>-ui/…`; a canon entry two levels down
  references `../../skills/<prefix>-ui/…`. Getting that wrong produces a page that looks
  correct on the site (the build rewrites the reference anyway) and opens unstyled from
  disk — which is the failure that made promotion feel like a chore, because it is
  invisible until somebody opens the file. This is the hand-edit the command exists to
  remove.
- **Refuses rather than half-doing it.** No description and no `--desc` → refused. A name
  already used in another tier → refused. An entry already there → refused unless
  `--replace`. `--dry-run` prints the identical plan and writes nothing.
- **Writes `CANON.md` at the workspace root** the first time, so an agent arriving cold
  finds the scheme by looking at the workspace rather than by being told.

Promotion is also how a planned page becomes a real one: a slug listed in `space.json`
`pendingPages` shows on the site as a roadmap entry and drops off by itself the moment
`pages/<slug>/` exists.

## Checking it

```bash
augur canon check
```

Fails on the things that make a name un-findable: a name that is not lowercase-hyphen, a
name carrying a version or a date, two tiers holding one name, an entry with no
`index.html`, an entry with no description, and a skill reference that does not resolve
from where the entry sits. Reports as advice: a near-miss qualifier, a name over four
words, a prototype shadowing a canonical name, a missing `CANON.md`.

A green run says the names are findable. It cannot say they are the right names for the
things — whether `invoice-detail` is the screen a person would ask for by that name is a
review question, and no lint has ever been able to answer it.
