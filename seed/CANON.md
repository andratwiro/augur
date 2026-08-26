# The canon

The screens and parts in this workspace that are meant to be **pulled by name** —
"build it the way `invoice-detail` is built", "pull `invoice-list`,
`invoice-detail` and `invoice-empty` and wire them together".

A canonical name is a directory name, in one of four places at this root:

| Where | What it holds |
| --- | --- |
| `base/<name>/` | one atom, every state on one page |
| `components/<name>/` | one composed component |
| `patterns/<name>/` | an arrangement several screens repeat |
| `pages/<name>/` | a whole screen |

Anything else is not the canon and is never what a bare name means: a folder under
`<project>/prototypes/` is a working prototype, `playground/` is scratch.

Names are lowercase and hyphenated, **subject first and qualifier last** —
`invoice-list`, `invoice-detail`, `invoice-empty`, never `list-of-invoices` — so
a directory listing sorts a subject's screens together and reads as a table of
contents. The qualifier comes from one closed set:

`-list` · `-detail` · `-new` · `-edit` · `-empty` · `-error` · `-loading` · `-confirm` · `-success`

A name never carries a version, a date or a ticket id: it says what, never when.
Every entry carries one sentence in `<meta name="description">` saying what it
shows.

**To pull `<name>`, look for `<name>/` in those four directories.** The entry
page is `<tier>/<name>/index.html` and it opens on its own, from disk, with the
workspace's design system already on it. That is the whole resolution rule, and
it needs no tool.

With the engine's CLI on hand, the same thing plus the description and the
design-system assets each entry links:

    augur canon find <name>      # → the tier, the folder, the entry, what it links
    augur canon list             # → every canonical name and its description
    augur canon save <path>      # → promote a working screen into the canon
    augur canon check            # → names that will not be found the same way twice

The full rules, with the reasoning, are the engine's `agents/canon.md`.
