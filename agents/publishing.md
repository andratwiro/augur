# Publishing — how space work goes live

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

The same protection exists **against the live store itself**, because live can
hold work git has never seen (someone published an uncommitted tree). Before
committing, `publish` proves your tree contains what is live — live is your own
last publish, or a clean commit in your history. When it can't prove that, it
reconciles instead of overwriting: a prototype **they** changed and you didn't is
**adopted** — their files are written into your tree (so your next build carries
them) and ship's commit records it; a prototype you **both** changed forks
exactly like the git case (theirs at the real URL, yours at
`<name>-conflict-<you>` with a `CONFLICT.md`); a shared design-system file you
both changed keeps **theirs** live and warns you loudly — your version stays in
your tree and git, merge it and ship again. Their store-only *deletions* are not
adopted: your publish puts the folder back and says whose removal it undid.
Nothing in any of this asks a question, and nothing is ever silently reverted.
A publish that lands between your check and your commit is caught by the store
(`stale-base`) and re-evaluated automatically.

## Push ≠ deploy

`git push` saves and shares your work; it does not change the
live site. That is why `ship` exists.

Publishing is the only path. The site's CI builds engine chrome and worker code with no
space on disk at all, so there is no rebuild, redeploy, or pin bump that can put
your work live — and equally, none that can silently overwrite it. If the live
site doesn't show your change, the answer is always the same: it wasn't published.

## The command

From the space repo's root (the engine clone must sit next to it):

```
node ../augur/scripts/publish.mjs        # or: augur publish
```

- Infers the space from the working directory; `--space <id>` / `--all` /
  `--dry-run` / `--engine` (maintainers: chrome + worker) are available.
- Builds the space, uploads **only what changed** (content-addressed), and flips
  the live site atomically — typically a few seconds. A deployed site
  self-refreshes to the new version; no need to tell a reviewer to hard-refresh.
- It ships the **working tree** (uncommitted work included). Such publishes are
  flagged `"dirty": true` in the public `/_build.json` stamp, so nothing is
  hidden.
- It **refuses shallow clones** (`--depth 1` collapses git history, and
  edited-dates + contributor chips are derived from it) — the error tells you
  the unshallow one-liner.

## Your tree is the whole space (and the guard that follows from it)

A publish sends **your** working tree as the **entire** space, routing included —
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
[publish] my-space: this publish would REMOVE 7 public page(s) that are live right now:
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
password pasted into chat. It saves a publish token to `~/.config/augur/` and
every later publish just works. A 403 on publish means your password was reset
(a new invite was issued) — redeem it and run login again.

## Verifying

The publish command prints the live URL and new version on success — exit code
is truth, there is no CI tab.

```
augur status
```

is the whole check: for every space it puts what the store is serving next to what
your clone has and what `origin/main` has, and tells you which one is behind. Exit
code 1 means something is out of step, so it works in a script too.

The underlying data is the public stamp, if you want it raw:

```
curl 'https://<your-site>/_build.json?t=1'
```

Compare your space's `sha` to `git rev-parse HEAD`; `version` is the store's
publish counter, and `dirty: true` means that publish came from an uncommitted
working tree. Cache-bust it — the CDN serves this stale for a minute or two, and a
stale read is how you "confirm" the state you just replaced.

Bundle-store publishes flip atomically; **engine** deploys (Pages) can serve mixed
old/new assets for a couple of minutes after a ship — poll until consecutive
responses agree before declaring a chrome bug.

## Local preview (no publish involved)

`node ../augur/scripts/dev.mjs` from the space root runs the full site shell
locally (login `dev@local` / `dev` when no identity file is around); prototypes
are static HTML, so opening `index.html` directly (`file://`) also works.

## If something's wrong

Network/upload errors → nothing shipped, the live site is untouched, retry.
403 → re-login. Anything else → ping the instance maintainer.
