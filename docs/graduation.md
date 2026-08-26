# Graduation — taking one tool out

A prototyping workspace is where a thing gets **found**. It is not where a thing that has
been found should live forever. This is the doorway for the moment those two stop being
the same place, for one artifact rather than for the whole workspace.

It is a doorway, not a policy. Nothing here asks permission, nothing here is reversible in
the direction that matters, and nothing is taken away from the workspace by using it.

---

## When

**The moment a tool has a stable audience that is not the team.**

That is the whole test, and it is deliberately about the audience rather than about the
tool. Some signals that it has already happened:

- People outside the team have the URL, and reach for it without being reminded.
- Someone would notice, and mind, if it broke on a Tuesday.
- Changing it now needs a heads-up rather than a nudge.
- The questions it gets are about what it *does*, not about what it is *trying out*.

If those are true, the tool has customers. A workspace built for prototypes is doing
several things a tool with customers should not be subject to, and each of them is correct
for prototypes and wrong here:

- The engine moves under it. Instances take engine updates by pin bump, on a schedule
  nobody clears with the tool's users.
- URLs are folder names. A rename is a good idea on a Wednesday afternoon and a dead link
  to everyone who bookmarked it.
- It sits behind the workspace's sign-in and the workspace's roster.
- A publish from any collaborator's tree is the whole workspace's public surface.

**The alternative being declined is not "leaving".** It is a research workspace quietly
becoming the production host for somebody's customer-facing tool — which nobody ever
decides, and everybody discovers at the worst possible moment.

## What it costs, and what it does not

Graduating **copies**. The workspace keeps everything: the prototype, its history, the
comments pinned to it, the board it sits on. Nothing is removed and nothing is moved.
Removing it later is a separate, deliberate act — see [After](#after).

What the graduated copy no longer has, because none of it is part of a static page:
comments and annotations, the canvas, the galleries and index pages, the sign-in gate,
and `augur ship`. Updating it becomes a file copy to whatever serves it.

## Taking it out

One command, in two forms. The only difference is where the bytes come from — a workspace
that is a git repository, or a hosted one that never had one.

```sh
# a workspace you have a clone of — no credentials, no network
augur clone --prototype <name> --from <space-dir> --out <dir>

# a workspace with no repo — reads the live publish; needs `augur login` once
augur clone --prototype <name> --space <id> --out <dir>
```

`<name>` is whatever you know it by: the URL (`/garden/seed-swap/`), the repo path
(`garden/prototypes/seed-swap`), or the bare name (`seed-swap`). An ambiguous bare name
lists the candidates instead of picking one. Add `--dry-run` to get the entire verdict —
file list, design system, every finding below — without writing anything.

**What lands in `<dir>`:**

- `index.html` at the root. What was served at `/<project>/<name>/` is now what a domain
  serves at `/`.
- The prototype's own assets, at the same relative paths.
- `skills/<design-system>/` — the design-system folders the page references, whole. A
  prototype is self-contained HTML apart from the one thing it deliberately shares, and
  without it the graduated copy is an unstyled page.

**What gets rewritten:** the depth of every design-system reference (a prototype sits
three levels down in a repo and at the root of a domain), and the engine's decorations come
off — the review-overlay tag, the companion tag, social meta, the linked-assets stamp, and
the emoji stamped on the `<title>`.

## The proof is part of the command

"No dependency on the engine" is not something to establish by reading the diff. Every file
that is about to be written is scanned first, and the command reports three things:

| | what it means | what to do |
|---|---|---|
| `engine` | An injected marker, an engine route (`/__…`), a page global, or an absolute link back to the instance survived. | **Stop.** The copy would call home from somebody else's domain. This is a bug — report it with the file and line printed. |
| `dangling` | A reference that resolves to nothing in the folder. Links to sibling prototypes are the usual cause: they did not come along. | Decide per link — point it at the old site, bring the sibling too, or delete it. |
| `external` | A request to another origin. | Nothing, unless you did not know it was there. It will follow this copy wherever it goes. |

Exit codes: `0` clean · `1` an engine reference remains, so the copy is not standalone ·
`3` clean of the engine, with dangling references listed.

## Serving it on its own domain

There is no build step and no runtime. It is a folder of files.

1. **Look at it locally.** Any static file server:
   ```sh
   cd <dir> && python3 -m http.server 8080
   ```
   Open `http://localhost:8080`. This is already the real thing — nothing about it changes
   between here and a domain.
2. **Put the folder on a host.** Object storage behind a CDN, a static-site host, or a
   plain web server's document root. What it needs is what a folder of files needs: serve
   `index.html` for a directory, and serve the rest verbatim.
3. **Point the name at it.** An `A`/`AAAA` record or a `CNAME`, per the host's
   instructions, and a certificate — most hosts issue one for you.
4. **Check it from outside.** Load it on a device that has never seen the old site, with
   the network panel open. Every request should go to the new host and every one should be
   a `200`. The command above already proved this against the folder; the browser is the
   last word on it.

Budget under an hour, and expect most of that to be DNS.

## Leftovers you may want to delete

Harmless — they do nothing without the engine — but they are not yours and you may prefer
them gone:

- `data-gv-screen` on `<body>`: the comment overlay's screen contract.
- `preview.webp`, `og.jpg`: poster shots the galleries and link previews used.

## After

The old URL is still live and still serving a copy that will now drift. Pick one, out loud:

- **Leave it**, and say on the page that the tool moved, with the new link.
- **Redirect it**: replace the prototype's `index.html` with a one-line meta refresh to the
  new domain, and publish that. The URL keeps working for everyone who bookmarked it.
- **Remove it**: delete the folder, commit the deletion, and
  `augur publish --allow-unpublish`. The flag is required precisely because taking a public
  URL down is the thing a stale checkout must never do by accident.

The workspace still has the history either way. That is the point of doing this as a copy.

## Related

- `docs/store-recovery.md` — taking a copy of the whole store, and putting it back.
- `docs/migration-freeze.md` — moving a whole workspace to another instance, which is the
  same idea at workspace granularity.
