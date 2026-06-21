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

## 2026-06-21 — Prototypes now borrow blocks instead of copying them
Every prototype now points at the one master copy of each building block, instead
of keeping its own. So when a block gets better, every prototype gets it for free —
no more stale duplicates quietly drifting apart. If you ever want to change a block
for just one prototype, you can "detach" it: that makes a private copy you can edit
freely, and Augur flags that it no longer follows the master.

## 2026-06-21 — Components are live copies now (like Figma)
Every building block is now a real instance of one master, the way Figma works.
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
