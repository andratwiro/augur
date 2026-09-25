# Drafts — how a prototype is changed on a workspace that serves them

**Does this apply here?** Ask the instance: `GET /.well-known/augur.json` carries
`drafts.enabled`. `true` → this document; `augur publish` refuses there and points here.
`false` → [publishing.md](./publishing.md), which publishes a whole tree.

## The whole day, in four lines

```
augur open <opportunity>/<prototype>     # a folder of its own, live at once at its draft address
…edit the folder…                        # every save is live at that address before your next step
augur land [-m "what changed"]           # the real URL moves; the LAST LINE of stdout is the live URL
augur sync                               # only when land was refused: fold main into your draft, land again
```

That is it. There is no commit, no push, no build. The URL `land` prints is what you hand
the person you are working for — never a localhost, never a `file://` path.

A prototype that does not exist yet: `augur open --new <opportunity>/<name>` gives you an
empty folder and an empty draft; write its `index.html` and land. The same works for a
library demo (`components/<name>`, `base/…`, `patterns/…`, `pages/…`) and for the
workspace's design system (`skills/<prefix>-ui`), which is one unit like any other.
Without `--new`, a name that does not exist is refused rather than guessed at.

## Undoing a landing

```
augur revert <opportunity>/<prototype> --list     # its landings, newest first
augur revert <opportunity>/<prototype>            # put back the landing before the newest
augur revert <opportunity>/<prototype> --to 12    # or a named one
```

A revert is itself a landing: the history keeps the one you undid and says what put it
back. Tell the person which landing you reverted and why.

## What is already here

```
augur ls                  # the opportunities, one per line, with a prototype count
augur ls <opportunity>    # its prototypes, one per line, as <opportunity>/<name>
```

Read from the LIVE manifest, so it is never stale and never a guess. Run it before you
create anything. Asked to "put it under Broad Listening", `augur ls` is how you find that
the folder is called `broad-listening` — rather than inventing a second top-level folder
beside it, or naming one with a capital letter and a space in it.

`augur ls <opportunity>` on a name that is not there is refused, and says to run
`augur ls`.

## Naming a new one

`--new` refuses two things before anything reaches the workspace, so a guessed name never
opens even an empty draft:

- **`unslugged-unit`** — a path segment that is not lowercase letters, digits and dashes.
  The refusal names the slug it would accept, so the fix is the message:
  `augur open --new "Broad Listening/New Idea"` comes back with
  `try \`augur open --new broad-listening/new-idea\``.
- **`unknown-opportunity`** — the first segment names no opportunity this workspace has.
  `augur ls` lists them; `--new-opportunity` is how you say you meant to start one. A
  workspace with nothing published yet has no opportunities to compare against, so a new
  unit there is allowed straight through.

A prototype is exactly two segments, `<opportunity>/<prototype>`. One segment, three, or a
folder the engine reserves is `not-a-prototype-folder` / `reserved-folder` — see the table
below.

## What a draft is

Your own live copy of one prototype, at its own address: the prototype's URL with `@` and
a short id on its last segment, for example `/checkout/flow@k7f3q1/` for `/checkout/flow/`.
It sits at the same depth as the prototype, so every relative link in the page resolves to
the same URL it resolves to on the real page. Everyone signed in to the workspace
can look at it while you work; the prototype's real URL keeps serving what it served until
you land. Two agents opening the same prototype get two drafts, are both told about each
other, and both work — nothing locks, nobody waits.

`augur open` prints who else has it open. That is the whole coordination step; there is
nothing to leave and nothing to clear.

The draft address answers to a signed-in browser, and to a request that carries this
terminal's token as `Authorization: Bearer …` — so a headless browser given that header
(the token is in `~/.config/augur/tokens.json`, under the host) loads the draft as its
member would see it, cookie-free, for a DOM check before landing. Main and the galleries
still want a session; the header opens the draft and nothing else.

## Editing

Edit the files in the folder `open` created. That folder holds that prototype and
nothing else. Your editor's hooks — installed the first time `augur open` ran on this
machine — save every edit to the draft before your next tool call, so the draft address
is always what your files are. A refused save comes back in your next tool result with
the reason; read it, it says what to do.

The hooks also refuse two kinds of write, with the reason:

- a file under a prototype in a **shared checkout** (a clone of the workspace) — open the
  prototype instead; that is what the refusal tells you to run;
- a file in a **read-only copy** (`augur read <unit>` puts one under `_read/`, for
  context) — open the prototype if you mean to change it.

Everything else — the workspace's design system, its docs, other projects — is untouched.
If you are editing by hand in an editor with no hooks, `augur watch` inside the folder
saves on every burst of changes; `augur save` saves once.

## Landing

`augur land` replaces the prototype's real URL with your draft, records who landed it and
when — and whose draft it was, when a member lands somebody else's from the site — and
closes the draft. It is refused in exactly one case: somebody landed on this
prototype since you opened yours. Then:

```
augur sync     # takes main's changes into your folder; a real overlap is left for you to fold
augur land     # again
```

A prototype that carries **criteria** (an `oracle/` folder) is checked before it lands,
when this machine has their runner: `land` refuses while a criterion that held at the last
landing fails now, and says which. That is the prototype's owner speaking, not a fault to
work around — fix what broke it, or tell the person it conflicts. See
[criteria.md](./criteria.md).

`sync` writes one-sided changes outright and merges a file you both touched when the
edits do not overlap. When they do overlap, your version stays in place, theirs is put at
`.augur/theirs/<path>`, and the overlapping hunks are printed. Fold their lines into your
file, then DELETE `.augur/theirs/<path>` — that is how you say it is folded — and land.
Until every one is gone the draft cannot land, from the terminal or from the site: `land`
answers `overlaps-open` and names them. Nothing is guessed, on the server or here.

**Picking a draft up again.** A draft outlives the folder it was opened in. When that
folder is gone — a new session, another machine — `augur open <opportunity>/<prototype>
--draft <id>` (the id is the part after `@` in the draft's address; the gallery card and
`augur status` show the drafts that are open) puts that draft's saved files in a fresh
folder, on the base it was opened on. Then `augur land`, and `augur sync` if it says main
moved. Never start a new draft and copy an old folder's files over it: the new draft is
based on what is live now, so every file copied over quietly undoes whatever landed since,
and nothing can tell.

`augur close <folder>` removes the folder once landed — from the parent, so the shell is
not left standing in a directory that no longer exists (run inside the folder, it works and
ends with `cd ..`). `augur close --discard` abandons a draft you do not want (its saves stay
on the instance for a while; nothing else is touched). `augur status` lists the drafts open
on this machine and who else is on those prototypes.

Every verb takes `--origin <url>`, the way `connect` does; without it a verb uses the
origin this machine paired with last (or `AUGUR_ORIGIN`).

## When something is refused

| It says | What happened | Do |
|---|---|---|
| `main-moved` / "sync first" | somebody landed since you opened | `augur sync`, then `augur land` |
| `stale-draft` | another process saved to this same draft | `augur sync`, then `augur save` |
| `overlaps-open` | the last `sync` left files where both sides changed the same lines (it names them) | fold each into yours, delete its `.augur/theirs/` copy, `augur land` again |
| `draft-closed` | somebody landed or discarded this draft from the site (it says who and when) | what you saved is in that landing; `augur open` the prototype again and redo in it only what you had not saved — copying whole files over undoes anything landed since |
| `manifest-contended` | many landings hit the workspace in the same second; `land` already tried again | `augur land` once more |
| `forbidden` with "run `augur connect` again" | this machine's token was revoked (a role change or a removal) or belongs to another workspace | nothing: `open` and `land` pair afresh on the spot — a tab opens for the person, they press Approve. Only where that cannot happen (CI, a machine token) does the refusal print what to run |
| `would-unpublish` | the draft has no files (the folder is empty) | check the folder; a deletion is its own verb |
| `not-a-prototype-folder` / `reserved-folder` | the path is not `<opportunity>/<prototype>` (exactly two segments, and not a folder the engine generates) | name the prototype folder |
| `unslugged-unit` | `--new` with a name that is not lowercase letters, digits and dashes | run the slug the refusal prints |
| `unknown-opportunity` | `--new` under a top-level folder this workspace does not have | `augur ls`; `--new-opportunity` to start one on purpose |
| `units-not-configured` | this instance does not serve drafts | `augur publish` — see publishing.md |
| no publish token | this machine is not paired | nothing: the verb pairs this machine itself — a tab opens for the person with the code filled in, they press Approve, the verb carries on. Tell them that one sentence. `augur connect` by hand is for CI or a machine with no browser (never a password) |
| unreachable | the instance could not be reached | nothing is lost; the next save carries every change since |

## What you never do

- Publish a whole tree to a drafts workspace. `publish` refuses there, and `ship` is gone.
- Wait for, or refuse over, somebody else's draft. Both work; the second landing syncs.
- Delete a `.augur/theirs/` file you have not folded, to get a landing through. It is the
  other person's work.
- Copy an old folder's files into a new draft. Pick the old draft up with `--draft`.
- Hand over a path on disk as "done". Done is the URL `land` printed.
