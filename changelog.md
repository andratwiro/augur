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

## 2026-08-25 — Invites can arrive by email
Inviting someone used to mean copying a link out of the Admin panel and sending it
yourself. Now the site can email it for you, if whoever runs it has set that up.
The link is still right there either way — and if the email doesn't go out, the
panel says so instead of leaving you guessing.

## 2026-08-25 — One Augur, one workspace
An Augur site used to be able to hold several workspaces at once, each tucked
under its own piece of the address. Nobody ran one that way, so it's gone and a
lot of code went with it. Running your own copy with more than one workspace in
it? Run them as separate copies. One setting disappears with it: `adminOnly` no
longer does anything. Who can see a workspace is decided by who you invite to
it, which is the honest answer anyway.

## 2026-08-24 — Publishing can't quietly undo someone else's work
Publishing used to send your whole folder, so an out-of-date copy could roll
back things other people had changed while you weren't looking. Now a publish
only claims the pieces you actually edited and leaves everything else exactly as
it is. If two people really did change the same thing, yours gets published
next to theirs instead of on top of it.

## 2026-08-20 — Cards stop crediting the wrong person after a publish rescue
When a publish has to rescue someone else's live work into your folder, that
rescue is now filed away on its own, clearly labeled as machine housekeeping.
Before, it could end up inside your next normal save — and then every card it
touched showed your face and "edited just now", even though you never worked
there.

## 2026-08-19 — Cards show everyone who worked on something
A card used to show one face, whoever touched it last. Now it shows all of them.

## 2026-08-19 — Links to your site look like your site
Paste an Augur link into Slack, Notion or a message and the preview now carries
your own name, description and picture — including the sign-in page, which used
to unfurl as nothing at all. A link to a canvas shows a picture of the board.

## 2026-08-18 — Pages open instantly
The furniture every page shares — the sidebar, the header — is now fetched once
and reused, and your browser keeps a copy of it. Moving around is close to
instant, and a page weighs a small fraction of what it used to.

## 2026-08-17 — Augur on your phone
Augur has a real mobile layout now: a bottom tab bar you can reach with your
thumb, a header that says where you are and how to get back, and Pinned and
Profile as sheets that slide up from the bottom. Search moved into the tab bar.

## 2026-08-16 — Augur has no AI inside it
The one place Augur could call an AI model — a document summarizer — is gone.
Augur now ships with no model, no key, and no way to spend your money on one.
Your agent, your machine, your key.

## 2026-08-16 — Workspace settings, and a sidebar that says what it is
The gear that used to sit under your own face is gone. Admin is now its own place
in the sidebar, and it opens onto your workspace: the people in it, what's live,
and its settings — including a workspace icon you can change like a profile photo.
The Library is now called the Design system, because that's what it is.

## 2026-08-16 — Roles you can change from the table
Change someone's role right where you see it, from a dropdown on their row. Each
role has its own mark, so admin, editor and viewer read apart at a glance.

## 2026-08-16 — A viewer really can only look
A viewer could rename a prototype, change its status, start a canvas and upload
images. Now it can't do any of those. It reads and it comments — that's the role.

## 2026-08-16 — The admin panel works again
For a few hours the whole people panel silently did nothing: it never finished
loading, and invites, role changes and removals all failed without saying so.
Fixed, with a check that catches this kind of break before it ships.

## 2026-08-16 — Your galleries use the whole window
Prototype and project grids stopped at a fixed width and left a wide screen half
empty. They now add columns as the window grows, so a big screen shows more work
rather than more background.

## 2026-08-16 — Instances keep themselves up to date
Every Augur checks for engine updates every six hours instead of once a week, so
fixes reach a site nobody is watching. If you're running your own copy and would
rather stay put, you still can — it's a switch you flip, not the default.

## 2026-08-14 — Faces stay right after you change your photo
Change your photo and it now updates everywhere at once — on cards, comments and
canvases, on pages that were published long before. Until now those pages kept
pointing at your old picture and quietly showed your initials instead.

## 2026-08-14 — A viewer role
You can now invite someone who signs in, reads, comments and drives boards, but
can never publish. Handy for a client or a colleague you want in the conversation
without handing them the keys.

## 2026-08-12 — Change ten things at once on a canvas
Select a pile of stickies and pick a colour: they all change. Same for text size,
bold, italic and alignment — whatever you pick lands on everything you selected.
The toolbar shows the controls only when everything you picked is the same kind of
thing, so a click never does something different to each one.

## 2026-08-12 — Arrow keys move things on a canvas
Select anything on a board — a sticky, a prototype, a bit of text, a whole
section — and the arrow keys move it one step at a time. Hold Shift to move it
ten steps. It's the nudge you want when something is nearly, but not quite,
lined up. Also fixed: a big text box no longer paints a giant ghost copy of
itself across the board when you drag inside it while typing.

## 2026-08-12 — A prototype on a canvas stays where you left it
Scroll a prototype tile while you're driving it and the board keeps that view:
the part of the page you scrolled to is what everyone sees from then on, and
what you see when you come back tomorrow. It stays that way until the next
person scrolls it somewhere else.

## 2026-08-12 — Set your own profile photo
Open the menu under your name and pick "Add photo". Your face shows up on your
chip, on your comments, and next to your cursor when you're on a canvas with
someone. Change it or remove it whenever you like — it's yours, not something
an admin has to set for you.

## 2026-08-11 — Comment pins open on hover, stickers are crisper
Point at a comment pin and it opens itself: the pin grows into the card around
its own face, so nothing jumps and you don't have to click first. Move onto the
card to read it, click it to open the thread, or drag it to move the comment.
On canvases, stamps land smaller and their white edge is sharp instead of a
blurry halo.

## 2026-08-09 — Security hardening + bring-your-own AI key
A pass over the login, publishing, and sharing paths: brute-force throttling on
sign-in, publishes locked to their own space, admin-only spaces sealed on every
API, and the invite page now shows whose account a link sets. The Project
Builder's AI no longer runs on a built-in key — connect your own to get real AI
summaries, otherwise it falls back to its simpler local draft.

## 2026-08-09 — Invite and remove people from the Admin page
The user list is now a table: who they are, whether they're an admin, and when
they were last here (most recent first). "Invite" at the top right adds an email
and gives you a single-use link to send them. Click anyone to reset their
password or remove them.

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
