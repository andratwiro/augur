# Publishing — how space work goes live

**One command, every time:**

```
augur ship            # commit + publish + push, then print the live URL
augur ship -m "…"     # with your own commit message
```

Agents: this is the default. Finish a change, run it, and hand the human the URL
it prints — the live site, not localhost, not a `file://` path. Everyone works
against the same live URL, so what you show is what everyone else sees.

It does three things that used to be three separate decisions, each silently
skippable:

1. **Commits** everything, including untracked files. Local, instant, cannot
   fail. This is the step that makes losing work impossible — two prototypes
   once reached the live site while existing in no repository at all, one
   `git clean` from gone.
2. **Publishes**, so the live URL is true within seconds. Before the push, on
   purpose: a network problem must never stand between you and seeing your work.
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
committed and live; resolve it and ship again.

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
