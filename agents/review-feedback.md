# Review feedback — reading and resolving comments on your prototypes

Reviewers drop pins directly on the live site: **Shift+C** on any deployed page
opens the comment overlay, click an element, type. Acting on that feedback is
the most common recurring agent task — here is the loop.

## Read the threads for a page

```
GET https://<your-site>/__review/api?path=/<opportunity>/<prototype>/
```

Open by design (no auth — public prototypes are obscure share links, and devs
without a login must be able to comment). Response: `{ "threads": [...] }`,
each thread:

```
{ id, sel,            // CSS selector the pin anchors to
  fx, fy, px, py,     // anchor fractions + page position
  view,               // viewport label the pin was dropped in
  screen,             // <body data-gv-screen> value, if the prototype sets one
  resolved, annotation,
  messages: [{ author, body, at }] }
```

`messages[0]` is the original comment; later entries are replies.

## Act on them

`POST` the same URL with one op per request:

```
{ "op": "reply",   "id": "<thread>", "message": { "author": "Claude", "body": "…" } }
{ "op": "resolve", "id": "<thread>", "resolved": true }    // "resolved": false re-opens
{ "op": "delete",  "id": "<thread>" }
```

**The resolve convention:** when you fix what a comment asked for, resolve it
AND post a very brief reply saying *how* it was fixed (author "Claude" is the
convention) — the reviewer sees the resolution inline instead of wondering.
Fix → publish → then resolve, in that order, so the reviewer who clicks through
sees the fixed page.

## The loop, end to end

1. GET the page's threads; take the unresolved ones (`resolved: false`).
2. Fix each in the working tree.
3. Publish (see [publishing.md](./publishing.md)).
4. For each addressed thread: reply with a one-liner, then resolve.
5. Anything you deliberately did NOT address: reply saying why, leave it open.

Maintainers additionally have `scripts/review.mjs` (cross-page export +
moderation; needs `REVIEW_SITE_URL` + `REVIEW_EXPORT_KEY` in `.env.deploy`) —
not needed for the per-page loop above.
