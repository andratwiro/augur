# test/live — the drafts engine against a real hosted workspace

Everything under this folder runs against production and is deliberately not part of
`npm test`. It proves what the fixture-backed suites cannot: the gate, the mail, the roles
and the tokens are real. Nothing here names an instance, a domain, a person or a
credential — every one arrives as a `LIVE_*` variable from a runner outside this repo.

## What is here

| File | What it is |
| --- | --- |
| `env.mjs` | the one reading of `LIVE_*`; the five personas (owner, editor, editor2, viewer, invitee) as plus-addresses on one readable mailbox — `ROSTER_PERSONAS` is the four `roster.mjs` provisions directly; `invitee` is deliberately excluded, since arriving only through a real admin invite is the point of the `invited` variant |
| `inbox.mjs` | a tiny IMAP client: wait for the newest mail in a folder, pull the six-digit code or an invite link |
| `human.mjs` | a person at a browser, scripted: passwordless code sign-in, invite redemption (`acceptInvite`), approve a pairing, admin ops, Land/Discard from the bar |
| `persona.mjs` | one identity's terminal and browser kept apart from every other: cached cookie, cached token (re-paired when refused), `cli()` runner with its own registry |
| `roster.mjs add\|remove\|show` | the personas onto the roster through `/__publish/_state/import` (star token). ⚠️ `remove` writes the overlay only; on an object-backed workspace it removes nobody — see "Leaving" |
| `drills/*.live.mjs` | A–M, `node --test`; each names the units it touches by index into `LIVE_UNITS` |
| `restore-all.mjs` | every `LIVE_UNIT` back to its first landing, open drafts discarded |
| `revoke-personas.mjs`, `remove-owner.mjs`, `demote-owner.mjs` | the real cleanup (admin routes); `revoke-personas.mjs` also admin-removes the `invited` variant's invitee and takes their start-here page out of the live manifest |
| `probe-roles.mjs`, `probe-me.mjs`, `probe-tokens.mjs`, `probe-signin.mjs` | what the workspace thinks each persona is, what `/__me` and the KV overlays say, the tokens it holds, and two fresh sign-ins for one person without mail — for after an interrupted drill |
| `pin-dns.mjs` | `LIVE_PIN=host=ip`, loaded with `node --import`: every fetch connects to that edge with the hostname unchanged, for a network that drops one CDN range; the cold container gets it as a hosts entry |
| `first-experience/run.mjs` | a fresh agent (`claude -p`) and a scripted clueless person, relayed; `--cold` runs the agent in the container from `first-experience/cold/Dockerfile`; variants `new`, `change`, `collide`, and `invited` (a real invite mail, `invitee` starting with no session at all) |

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
2. Drills. Each touches its own units; A, B, D, G, J, K, L, M can run in two or three
   parallel chains. C and H change ROLES, and a demotion reaches every drill using that
   person at the time — run them alone, after the chains. I uses the first eight units, so
   it runs alone too.
3. `first-experience/run.mjs <change|new|collide> --cold`. The agent container needs a
   Claude credential that outlives the run: a long-lived token from `claude setup-token`
   (the host's short-lived access token is revoked the moment the host refreshes).
   `invited --cold --turns 10` runs on its own — it mints the invitee itself (a real
   admin invite, not the roster overlay), so run it separately from a `roster.mjs add`
   session rather than folded into the drills above.
4. Leaving, in this order: `restore-all.mjs`; `revoke-personas.mjs` (revokes every token the
   suite minted through the admin route, removes three people through the admin
   operation, and — if `invited` ran — admin-removes the invitee and takes their
   start-here page out of the live manifest); the owner cannot remove themself —
   `demote-owner.mjs`, then a real admin removes that account in the people panel.

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
- The scripted PERSON is a model and can say "done" without running a command; the relay
  counts their tool calls (`humanEvents`) and sends an invented action back once. Read them
  before blaming the pairing for an approval that never happened.
- A cautious agent vets the door before it runs anything: a package published that day, a
  small repository, and any wording that sounds like "skip the check" each cost a run. The
  door names the engine's source and says what the approval is; the transcripts say the rest.
- `status` exits 1 when a sibling space clone reads as unpublished; assert on its output.
- A demotion reaches every isolate within about a minute; a probe right after it can
  answer from the old roster.
- `invited`'s person holds no cookie until `./browser <link> --accept` redeems the mailed
  invite (`Human.acceptInvite`, `POST /__invite` — form-encoded `token`, not JSON, and not
  the GET's `t` query param). Until then `human("invitee", {noSignIn:true})` is the only
  legal way to ask for them — a plain `human("invitee")` would try to mail a sign-in code
  to someone the invite flow, not the mailer, is supposed to bring in.
- `invitee` is in `PERSONAS` (for `addressOf`/`folderOf`) but deliberately NOT in
  `ROSTER_PERSONAS` — a `roster.mjs add` that pre-created their membership would make the
  variant's own admin invite answer `already-a-user` and there would be nothing left to
  test.
