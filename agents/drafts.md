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

## What a draft is

Your own live copy of one prototype, at its own address: the prototype's URL with `@` and
a short id, for example `/checkout/flow/@k7f3q1/`. Everyone signed in to the workspace
can look at it while you work; the prototype's real URL keeps serving what it served until
you land. Two agents opening the same prototype get two drafts, are both told about each
other, and both work — nothing locks, nobody waits.

`augur open` prints who else has it open. That is the whole coordination step; there is
nothing to leave and nothing to clear.

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
when, and closes the draft. It is refused in exactly one case: somebody landed on this
prototype since you opened yours. Then:

```
augur sync     # takes main's changes into your folder; a real overlap is left for you to fold
augur land     # again
```

`sync` writes one-sided changes outright and merges a file you both touched when the
edits do not overlap. When they do overlap, your version stays in place, theirs is put at
`.augur/theirs/<path>`, and the overlapping hunks are printed — fold them, then land.
Nothing is guessed, on the server or here.

`augur close` removes the folder once landed. `augur close --discard` abandons a draft
you do not want (its saves stay on the instance for a while; nothing else is touched).
`augur status` lists the drafts open on this machine and who else is on those prototypes.

## When something is refused

| It says | What happened | Do |
|---|---|---|
| `main-moved` / "sync first" | somebody landed since you opened | `augur sync`, then `augur land` |
| `stale-draft` | another process saved to this same draft | `augur sync`, then `augur save` |
| `draft-closed` | somebody landed or discarded this draft from the site (it says who and when) | your edits are still in the folder; `augur open` the prototype again and copy them in |
| `manifest-contended` | many landings hit the workspace in the same second; `land` already tried again | `augur land` once more |
| `forbidden` with "run `augur connect` again" | this machine's token was revoked (a role change or a removal) or belongs to another workspace | `augur connect` |
| `would-unpublish` | the draft has no files (the folder is empty) | check the folder; a deletion is its own verb |
| `not-a-prototype-folder` / `reserved-folder` | the path is not `<opportunity>/<prototype>` | name the prototype folder |
| `units-not-configured` | this instance does not serve drafts | `augur publish` — see publishing.md |
| no publish token | this machine is not paired | `augur connect` (never a password) |
| unreachable | the instance could not be reached | nothing is lost; the next save carries every change since |

## What you never do

- Publish a whole tree to a drafts workspace. `publish` refuses there, and `ship` is gone.
- Wait for, or refuse over, somebody else's draft. Both work; the second landing syncs.
- Hand over a path on disk as "done". Done is the URL `land` printed.
