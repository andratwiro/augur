# The welcome flow — who is owed it, and what lifts it

The five-step page a person meets once, between redeeming their invitation and the
workspace: connect an agent in a terminal, change one line on a page of their own, see it
live. `src/welcome-page.mjs` is the page, `src/_worker.js` is the gate, and
`test/welcome-page.test.mjs` and `test/onboarding-me.test.mjs` are what hold both to the
rules below.

## The rule, in plain words

A person is owed the welcome **because they redeemed an invitation as an editor or an
admin**, and for no other reason.

- **Never by being on the roster already.** The flow's conditions were once "editor or
  admin, and neither flag set", which is true of every member a workspace already has —
  deployed onto a real team it held all of them at a door none of them asked for, with
  nothing on their row that could ever have said otherwise. Being owed it is an EVENT,
  stamped on the member when the invitation is redeemed (`members.welcome_owed_at`), and a
  row's silence means not owed.
- **Never by a password reset.** A reset mints the same link and redeems it through the
  same door, but it readmits somebody who is already here. The invite record carries WHY it
  was minted (`invites.kind`, `invite` or `reset`), and only `invite` owes anything. A
  record with no kind at all — one minted before the column existed — is no answer, and is
  treated as not an invitation.
- **Never a viewer.** A viewer publishes nothing, so there is nothing in the flow for them:
  they are never stamped, never gated, and never handed a page to make.
- **A viewer later promoted is not owed it.** The stamp is written at the redemption, and a
  role change does not write one. Somebody who arrives as a viewer and becomes an editor
  next month meets the workspace, not the welcome.
- **Only where device pairing is on.** Two of the flow's steps depend on approving a
  terminal, so on a deployment with pairing off the flow's middle cannot be finished. There
  the gate does not exist at all: no redirect, no page, and `/__onboarding/me` answers
  `gated: false` however owed somebody is.
- **`later` and `done` lift it, for good.** "Do this later" and "Open the workspace" write
  one flag each on the member's own row, and the gate stops for that person on every device.
  Nothing in the flow may become a wall in front of somebody's own workspace: the page
  navigates away only when the flag it wrote comes back true, and a write that did not land
  keeps the person on the page with one sentence rather than bouncing them into the gate
  that would send them straight back.

The gate is one definition (`welcomeGated`), read by both callers — the redirect on `/` and
the `gated` field of `/__onboarding/me` the page itself polls. Two formulas would disagree
exactly once: on the tick a person clicks past.

Every degradation fails the same way, towards the workspace and never towards the door: no
member row, an unreadable store, a failed stamp, a deployment with no workspace object —
all of them are "not gated". A member who is not shown the welcome has lost a page; a member
wrongly gated cannot reach their own work.

## The page the flow hands them

Step three needs a real published URL to change, and the person has not published anything
yet — that is the fact the onboarding signal is waiting for. So the PLATFORM lands one:
`/start-here/<member-id>/`, one unit per member, made from their display name.

- **It is not the workspace's first publish, and cannot be.** The landing is stamped with
  the seed sentinel and the platform actor, and `noteFirstPublish` is never on that path —
  it is called from the publish `commit` handler alone. The workspace still reads as
  unconnected until a person publishes something themselves.
- **It is served, and it is not listed** — including after the member's own landings. The
  unit's stamp carries `kind: "welcome"`, and the derived gallery skips it (`isWelcomeUnit`,
  `src/galleries.mjs`): a team of twenty would otherwise put twenty hash-named cards on the
  first page the workspace shows. `writeUnitLanding` carries the stamp's `kind` forward on
  every ordinary landing, so the page the welcome flow requires the member to land on (step
  3) does not reappear on the gallery the moment they finish it. `augur ls` reads the same
  stamp and agrees. The URL keeps working — the welcome page's own preview and the person's
  link both fetch it.
- **The folder is the member id, not the local part of an address.** Two local parts collide
  across domains, a non-ASCII one collapses to a literal, and a guessable URL on a gated
  workspace confirms membership to anyone who tries it.
- **It is landed once, judged on the live manifest** rather than on the member's flag: a
  member whose row was lost must not get a second version landed on top of the one already
  serving.
