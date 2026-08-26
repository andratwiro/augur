# Publishing — how work in a workspace goes live

**One command, every time:**

```
node ../augur/scripts/ship.mjs            # commit + publish + push, then print the live URL
node ../augur/scripts/ship.mjs -m "…"     # with your own commit message
```

`augur ship` is the same thing, and only works if someone ran `npm link` in the
engine clone on this machine. The `node …` form always works — prefer it in
instructions, or an agent following them hits "command not found" and improvises.

Agents: this is the default, and it runs every time you finish a piece of work —
not once at the end of a session. Hand the human the URL it prints: the live
site, never localhost, never a `file://` path. A local path shows them something
nobody else can see. Everyone works
against the same live URL, so what you show is what everyone else sees.

## The engine is yours to maintain, not theirs

The person you are working for has no reason to know the engine is a git
checkout, and telling them to run `git pull` is a support ticket you created.
Assume **none of them know what git is** — that is the design target, not a
worst case.

So: keep the engine clone current yourself. `publish` fast-forwards it
automatically when the instance speaks a newer publish protocol (clean tree,
`--ff-only`, once per run), and re-runs itself — you will see
`engine updated <a> → <b>`. When it cannot (uncommitted changes in the engine
clone, no upstream, diverged, offline), the message is addressed to **you**:
bring the clone up to date and re-run. Do not pass that instruction on.

The same holds for the workspace repo. `ship` commits and pushes for them. If a
publish is refused because the tree is missing folders, reconcile the tree —
that is your job, not a git lesson for them.

Shipping is never a question to put to the human. Don't ask "should I publish
this?" and don't offer "local or deployed?" as if they were equally valid —
the moment something works, it ships, full stop. Hesitating is the bug, not a
courtesy: "done" means live, not "working, pending a decision." This is safe
to do without asking, because nothing is at risk in doing it — a bad publish
is undone by another publish, never by having avoided the first one.

If publishing is genuinely impossible right now (no credentials, a rejected
token, no network), do not fall back to opening a file and calling it done. The
only acceptable meanwhile is the real local shell — see "Local preview" below —
and only labeled out loud as exactly that: local only, not shipped, nobody else
can see this. A bare `file://` path has no login, no chrome, no canvas; it is
strictly worse than the shell and is never a hand-off, working credentials or not.

It does three things in one step, in this order and for this reason:

1. **Commits** everything, including untracked files. Local, instant, cannot
   fail. This is the step that makes losing work impossible — two prototypes
   once reached the live site while existing in no repository at all, one
   `git clean` from gone.
2. **Publishes**, so the live URL is true within seconds. Before the push, on
   purpose: a network problem must never stand between you and seeing your work.
   (When the remote is reachable it quickly fetches and merges first, so a stale
   checkout ships the union of everyone's work instead of briefly reverting it.)
3. **Pushes**, so everyone else and their agents know what changed. Retried. If
   it ultimately fails, your work is still committed and still live — re-run
   `augur ship` to catch GitHub up.

`augur publish` still exists for publishing alone. Prefer `ship`.

## When two people edit the same thing

Handled, not blocked. If someone shipped while you were working, `ship` fetches
and merges — silently when your changes are in different prototypes, telling you
when they overlapped in the same one.

If the same prototype was edited in ways that genuinely conflict, it is NOT
merged: prototype HTML interleaved by a text merge renders wrong and nobody
notices until a demo. Instead **their** version keeps the real path — so any
shared link still resolves — and **yours** forks to a sibling folder,
`<name>-conflict-<you>`, with a `CONFLICT.md` explaining what happened. Both are
live, both are cards in the UI, nothing is lost, and a human folds them together
later.

A conflict outside a prototype folder (a design-system file, `space.json`) stops
the merge instead — it isn't safe to resolve mechanically. Your work stays
committed; resolve it and ship again.

The same protection exists **against the live store itself**, and since publish
protocol 5 it is structural: a publish COMPOSES on top of the live manifest and
only writes, per prototype, what it can ship safely. Your build lands on a unit
when live's recorded source is a clean commit in your history (a fast-forward,
like `git push`) or when git shows you edited it; everything else keeps live's
bytes verbatim. Your working tree is **never touched** — nothing is adopted,
nothing is written, no mechanical commits exist. A stale checkout therefore
cannot revert, unpublish, or fork anything it never edited, by construction.

A prototype you **both** changed keeps **theirs** at the real URL — any shared
link still resolves — and publishes **yours** at `<name>-conflict-<you>` with a
`CONFLICT.md`, in the live manifest only: your tree still has your copy at its
real folder. Fold what should survive, then ship — the next fast-forward publish
retires the fork URL. A shared design-system file you both changed keeps theirs
live and warns you; merge and ship again. A committed edit whose live base can't
be proven (its publisher never pushed) stays local with a note — pull/merge,
then ship, and it goes out as the union. Nothing asks a question, nothing is
silently reverted, and a publish that lands between your check and your commit
is caught by the store (`stale-base`) and recomposed automatically.

Two hard rules replace the old cleanup discipline: a tree folder named
`*-conflict-*` NEVER publishes implicitly (fold what matters into the real
folder, then delete it), and ship's auto-commit leaves untracked `*-conflict-*`
folders unstaged. Removing a live prototype needs the deletion committed AND
`--allow-unpublish`. `augur publish --takeover` ships the whole tree under the
old semantics — repo surgery and migrations only, never routine.

## The URL is the contract — mechanics are yours, not the user's

When someone asks for a change, they expect it live at the URL you hand back, with
**zero decisions on their side.** Imagine they have no idea what a commit, a branch,
a lint rule, or a token is — because most people asking don't. Engineering mechanics
are YOURS to resolve, silently: `ship`'s commit *cannot fail* (a developer-time gate
like a prototype-lint ratchet, a git reconcile, or a hook degrades to advisory under
ship and is printed for the AGENT, never raised as a question), publish makes the URL
true, push makes it durable. The only thing you ever put in front of the user is a
**product or content** decision they alone can make — what a flow does, which copy,
which direction. Never "should I commit past the lint gate?", "which branch?",
"proceed?". A mechanic dressed as "two options, which do you want?" is a bug in how
you're working: choose the right one and do it. Debt the ratchet flags in shipped
work is a follow-up you own, not a wall you stop at.

## Push ≠ deploy

`git push` saves and shares your work; it does not change the
live site. That is why `ship` exists.

Publishing is the only path. The site's CI builds engine chrome and worker code with no
workspace on disk at all, so there is no rebuild, redeploy, or pin bump that can put
your work live — and equally, none that can silently overwrite it. If the live
site doesn't show your change, the answer is always the same: it wasn't published.

## The command

From the workspace repo's root (the engine clone must sit next to it):

```
node ../augur/scripts/publish.mjs        # or: augur publish
```

- Infers the workspace from the working directory; `--dry-run` and `--engine`
  (maintainers: chrome + worker) are available. `--space <id>` and `--all` are
  LEGACY spellings: one deployment served several workspaces by path once, and does
  not any more — an instance serves exactly one, at its root.
- Builds the workspace, uploads **only what changed** (content-addressed), and flips
  the live site atomically — typically a few seconds. A deployed site
  self-refreshes to the new version; no need to tell a reviewer to hard-refresh.
- It ships the **working tree** (uncommitted work included). Such publishes are
  flagged `"dirty": true` in the public `/_build.json` stamp, so nothing is
  hidden.
- It **refuses shallow clones** (`--depth 1` collapses git history, and
  edited-dates + contributor chips are derived from it) — the error tells you
  the unshallow one-liner.

## Your tree is the whole workspace (and the guard that follows from it)

A publish sends **your** working tree as the **entire** workspace, routing included —
not a patch of the prototype you touched. So a checkout that is missing a folder,
or carrying it somewhere else, doesn't merely fail to add: it takes every public
URL it can't see off the site, for everybody.

You would not notice. Your own preview is right by construction, and the site
answers a path it no longer knows with the **login page** — so a page that is
*gone* looks *locked*, and the people who report it ask you for a password rather
than telling you it disappeared. Links already pasted elsewhere (an embed in a
customer's page, a link in a doc) show a password form.

So publish refuses to remove live public pages unless you say you meant it:

```
[publish] my-workspace: this publish would REMOVE 7 public page(s) that are live right now:
    /toolkit/embed-builder/
    /toolkit/map-embed/
    …
  Nothing was shipped.
```

Nearly always this means your checkout is behind or rearranged, not that those
pages should go. Check `git status`, `git pull`, look at where the named folders
actually are, and publish again — it goes through the moment your tree can see
them.

**When you really are taking something down** (you deleted a prototype on
purpose), say so:

```
node ../augur/scripts/ship.mjs --allow-unpublish
```

Adding pages is never blocked; only losing them is.

## One-time sign-in

The first publish says it has no token:

```
node ../augur/scripts/login.mjs          # or: augur login
```

Enter the **web email + password** for the site — the password you chose when you
opened your invite link (the maintainer sends a single-use `/__invite?t=…` link;
there are no issued passwords). Agents: ask your human to run it — never have a
password pasted into chat. It saves a publish token to `~/.config/augur/`, and
prints the date it stops working.

**⚠️ A PUBLISH TOKEN EXPIRES.** It used to last forever, which meant a laptop
lost two years ago could still publish. Thirty days is the default and the
instance sets it, so the token in your config is not a permanent credential and
a publish that has worked for weeks can stop. Run `augur login` again — that is
the whole fix, and it is the fix for most of these:

| The refusal says | What happened | What to do |
|---|---|---|
| **EXPIRED** | the token aged out | `augur login` |
| no longer a member of this workspace | the account was removed | ask an admin |
| no publish token for `<host>` — you have one for `<other>` | the workspace moved to a new hostname | `augur login --origin https://<host>` |
| no publish token, and you have none at all | you have not signed in on this machine | `augur login` |

The messages name which one it is; a bare `403` means the instance is running an
engine too old to say, and `augur login` is still the first thing to try.

## Verifying

The publish command prints the live URL and new version on success — exit code
is truth, there is no CI tab.

```
augur status
```

is the whole check: it puts what the store is serving next to what
your clone has and what `origin/main` has, and tells you which one is behind. Exit
code 1 means something is out of step, so it works in a script too.

The underlying data is the public stamp, if you want it raw:

```
curl 'https://<your-site>/_build.json?t=1'
```

Compare your workspace's `sha` to `git rev-parse HEAD`; `version` is the store's
publish counter, and `dirty: true` means that publish came from an uncommitted
working tree. Cache-bust it — the CDN serves this stale for a minute or two, and a
stale read is how you "confirm" the state you just replaced.

Bundle-store publishes flip atomically; **engine** deploys (Pages) can serve mixed
old/new assets for a couple of minutes after a ship — poll until consecutive
responses agree before declaring a chrome bug.

## Local preview (no publish involved)

`node ../augur/scripts/dev.mjs` from the workspace root runs the full site shell
locally — login, rail, overlays, canvas, the same experience the live site
gives (login `dev@local` / `dev` when no identity file is around). This is the
**only** acceptable stand-in when you genuinely cannot publish, and always say
so out loud when you point someone at it: "local only, not shipped, nobody else
can see this." It is a meanwhile, never a hand-off.

Prototypes are self-contained static HTML, so `index.html` also opens directly
via `file://` — fine for your own quick sanity check while editing, never for
showing anyone else anything. It has no login, no chrome, no canvas: strictly
worse than the shell above, and never an acceptable substitute for it.

## If something's wrong

Network/upload errors → nothing shipped, the live site is untouched, retry.
A refused token → read the table under "One-time sign-in"; the message names which
of the four it is. Anything else → ping the instance maintainer.

Either way, `publish`/`ship` fail loud and refuse to build until they've
confirmed the token actually works — so there is never a half-finished local
build lying around to mistake for a completed hand-off. If you need to show
someone something while you sort it out, that's what the local shell above is
for — clearly labeled as local, never a `file://` path.
