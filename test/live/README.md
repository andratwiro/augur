# test/live — the drafts engine against a real hosted workspace

Everything under this folder runs against production and is deliberately not part of
`npm test`. It proves what the fixture-backed suites cannot: the gate, the mail, the roles
and the tokens are real. Nothing here names an instance, a domain, a person or a
credential — every one arrives as a `LIVE_*` variable from a runner outside this repo.

## What is here

| File | What it is |
| --- | --- |
| `env.mjs` | the one reading of `LIVE_*`; the four personas (owner, editor, editor2, viewer) as plus-addresses on one readable mailbox |
| `inbox.mjs` | a tiny IMAP client: wait for the newest mail in a folder, pull the six-digit code |
| `human.mjs` | a person at a browser, scripted: passwordless code sign-in, approve a pairing, admin ops, Land/Discard from the bar |
| `persona.mjs` | one identity's terminal and browser kept apart from every other: cached cookie, cached token (re-paired when refused), `cli()` runner with its own registry |
| `roster.mjs add\|remove\|show` | the personas onto the roster through `/__publish/_state/import` (star token). ⚠️ `remove` writes the overlay only; on an object-backed workspace it removes nobody — see "Leaving" |
| `drills/*.live.mjs` | A–M, `node --test`; each names the units it touches by index into `LIVE_UNITS` |
| `restore-all.mjs` | every `LIVE_UNIT` back to its first landing, open drafts discarded |
| `revoke-personas.mjs`, `remove-owner.mjs`, `demote-owner.mjs` | the real cleanup (admin routes) |
| `first-experience/run.mjs` | a fresh agent (`claude -p`) and a scripted clueless person, relayed; `--cold` runs the agent in the container from `first-experience/cold/Dockerfile` |

## Environment

```
LIVE_ORIGIN         the CANONICAL workspace host (a claimed workspace's generated host 302s content paths)
LIVE_SPACE          the space id
LIVE_STAR_TOKEN     a star-scope publish token (state export/import, roster)
LIVE_FOREIGN_TOKEN  a token from another workspace, for the refusal drill
LIVE_MAILBOX        an address whose mailbox the suite reads; personas are local+tag@domain
LIVE_IMAP_HOST/USER/PASS
LIVE_UNITS          comma-separated unit paths the drills may edit — old prototypes only
LIVE_WORK           a folder for checkouts, registries, cached cookies and tokens
LIVE_ACCOUNT_ORIGIN (optional) the hosted account origin; with LIVE_WORKSPACE, a person who
LIVE_WORKSPACE      signed in once is signed in again through their account session, not a
                    second mailed code — the mailer withholds one for 15 minutes per address
LIVE_MAIL_COOLDOWN_MS (optional) that window, when an account store's differs
```

## Order

1. `roster.mjs add` — once. Then `proof.mjs` to see one sign-in, one pairing, one read.
2. Drills. Each touches its own units; A–D, G–M can run in two or three parallel chains;
   I uses the first eight units, so run it alone.
3. `first-experience/run.mjs <change|new|collide> --cold`. The agent container needs a
   Claude credential that outlives the run: a long-lived token from `claude setup-token`
   (the host's short-lived access token is revoked the moment the host refreshes).
4. Leaving, in this order: `restore-all.mjs`; `revoke-personas.mjs` (revokes every token the
   suite minted through the admin route and removes three people through the admin
   operation); the owner cannot remove themself — `demote-owner.mjs`, then a real admin
   removes that account in the people panel.

## Traps met on the way

- A plus-tagged mail is filed into a FOLDER named after the tag by the provider; the
  inbox reader searches that folder.
- A role change or a removal revokes the person's tokens and their session. The suite
  re-pairs and re-signs-in on a 401/403; a drill that changes roles must expect it.
- One mailed code per address per fifteen minutes: a second request inside the window
  gets a 200 and no mail. The suite keeps the ACCOUNT session the first code opened and
  signs in again through it (`LIVE_ACCOUNT_ORIGIN`); when it must mail, it waits the
  window out and says so, rather than timing out on a mail that was never sent.
- A "fresh agent" on the machine that runs this suite is not fresh: it will find the
  cached tokens under `LIVE_WORK` and the engine clone. That is what `--cold` is for.
- `status` exits 1 when a sibling space clone reads as unpublished; assert on its output.
- A demotion reaches every isolate within about a minute; a probe right after it can
  answer from the old roster.
