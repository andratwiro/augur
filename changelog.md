# Augur changelog

Big, notice-worthy updates to Augur (the prototyping tool itself) — not every
tweak inside a single prototype. Newest goes on top.

**Format (one entry):**

```
## 2026-06-20 — Short title
One or two short sentences a 15-year-old could read. Say what changed and why
it's nice, no jargon.
```

The date is the day the update went live. The page works out "Today / 3 days ago /
2 weeks ago…" by itself, so you never have to touch old entries.

---

## 2026-08-08 — Invite-only auth
Passwords are PBKDF2 hashes, sessions are HMACs, and the admin panel issues
single-use invite links instead of setting passwords. Operators no longer know
anyone's password. See CLAUDE.md for how the roster and reset flow work.

## 2026-08-07 — New canvases are shareable right away
A canvas made with the "＋ New canvas" button now opens for anyone with the link,
just like a published prototype — no sign-in needed. Before, only signed-in
teammates could see it.

## 2026-08-06 — Cards show whose work it is
The little face on a card is now the person who has worked on it most, not whoever
happened to save it last, so a project someone else built carries their photo. The
status dot opens a small menu when you hover it, so you pick the state you want
instead of clicking through the others, and the cards only re-shuffle once you move
away, so nothing jumps around while you are setting them. Three more annoyances are
gone: a list no longer opens scrolled halfway down, you can right-click anything
pinned in the sidebar to remove it, and a board's music can no longer play out of a
card preview.

## 2026-07-03 — Spaces are their own worlds now
The workspace grew into **spaces**: the original space (everything you know, same
links) and a new sandbox space, each living in its own repo and switchable from the
menu next to your profile (the sandbox is visible to admins only for now). Pushing a space's
repo still puts it live in about a minute, and there's a new public
`/_build.json` address that tells you exactly which version is live. The admin page
now shows **when each person last connected**, sorted by most recent. And the cards'
"edited X days ago" labels — which had quietly broken and showed "just now" for
everything — tell the truth again.

## 2026-06-22 — Your own account, with your own pins
Augur now has real logins. Sign in with your email and password instead of one
shared site password, and you get your own profile in the top-left corner — your
name, your avatar, and your own set of pinned prototypes (they no longer get mixed
up with everyone else's). Status chips, renames and comments stay shared, because
those are team decisions, and renaming a prototype now also updates its name in the
pinned list. The admin account gets an "Admin settings" page to manage everyone's
passwords. The risky "Delete" option was removed from the card menu to be safe.
Pinned items that point to a prototype that's since been moved or deleted now
quietly clean themselves out of your list, so you never click a dead link.

## 2026-06-21 — See what research backs each opportunity
Every opportunity now shows a little chip with how many research notes it has
(e.g. "4"). Click it on the opportunity's page to see the list of file names —
handy for remembering what context exists before you dig in. It only shows the
names, never the contents, and only to people who've passed the password.

## 2026-06-21 — Prototypes now borrow blocks instead of copying them
Every prototype now points at the one master copy of each building block, instead
of keeping its own. So when a block gets better, every prototype gets it for free —
no more stale duplicates quietly drifting apart. If you ever want to change a block
for just one prototype, you can "detach" it: that makes a private copy you can edit
freely, and Augur flags that it no longer follows the master.

## 2026-06-21 — Components are live copies now
Every building block is now a real instance of one master.
Change the master and every copy updates itself. Each one also shows a little
health badge — green if it still matches the master, a warning if someone pulled
it out of line or off the spacing grid — so it's obvious at a glance what's tidy
and what has drifted.

## 2026-06-20 — One settings sheet builds any page
You now fill in a single list of settings and Augur builds the whole page from it
— a project page or a homepage. Before, you had to edit two things and keep them
matching by hand. Now there's one source of truth, so pages can't drift apart.

## 2026-06-19 — One builder for every page
All the prototypes share the same page-building engine and the same set of
building blocks now. Fix or improve a block once and it updates everywhere it's
used, instead of having to fix five copies.

## 2026-06-19 — New name and look: Augur
The prototyping tool got a proper name and identity — Augur — with the
eye-and-sparkle logo you see in the top-left corner.

## 2026-06-18 — Links show a preview card
When you paste an Augur link into a chat or doc, it now shows a little picture and
title card instead of a bare blue link, so people can tell what they're about to
open.

## 2026-06-14 — Try any city's colours
Prototypes can be re-skinned in a real city's colours, fonts, and logo just by
adding `?theme=` to the link (Copenhagen, Vienna, and more). Same prototype,
different city's look.
