# Publishing — how space work goes live

**Push ≠ deploy.** `git push` saves and shares your work; it does not change the
live site. The habit: **finish → publish → push.**

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
is truth, there is no CI tab. Public stamp:

```
curl https://<your-site>/_build.json
```

compare your space's `sha` to `git rev-parse HEAD` (plus `dirty` if you shipped
uncommitted work). Bundle-store publishes flip atomically; **engine** deploys
(Pages) can serve mixed old/new assets for a couple of minutes after a ship —
poll until consecutive responses agree before declaring a chrome bug.

## Local preview (no publish involved)

`node ../augur/scripts/dev.mjs` from the space root runs the full site shell
locally (login `dev@local` / `dev` when no identity file is around); prototypes
are static HTML, so opening `index.html` directly (`file://`) also works.

## If something's wrong

Network/upload errors → nothing shipped, the live site is untouched, retry.
403 → re-login. Anything else → ping the instance maintainer.
