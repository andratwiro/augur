# The seed workspace

What a brand-new hosted workspace contains on the day it is created. It is a
complete, buildable space — a design system, six prototypes, a comment thread or
two — copied wholesale into a tenant at provisioning, so the first thing a person
sees is a working workspace rather than an empty one.

The three prototypes under `start-here/` **are** the onboarding. There is no
wizard to write instead: they teach the loop by being it, and the person who
finishes them has a connected terminal, a design system they have already
changed, and a comment they have already replied to.

```
seed/
├── space.json                the workspace's contract with the build
├── registry.json             the design system's overlay catalog
├── prototype-status.json     the dev-status chips
├── threads.json              the comment threads that ship with the content
├── skills/starter-ui/        the design system: tokens, components, one behaviour
├── start-here/prototypes/
│   ├── connect-your-terminal        the fork: one command, or fifteen minutes
│   ├── set-up-your-design-system    the tokens, live, and how to make them yours
│   └── sample-with-comments         a real screen with real pins on it
└── worked-examples/prototypes/
    ├── specimen-viewer              3D, from a pinned CDN script
    ├── slide-deck                   a keyboard-driven deck
    └── field-readings               charts with no chart library
```

## How it reaches a workspace

Provisioning copies this tree into the new tenant in the same write that creates
the first admin, and writes each entry in `threads.json` under the comment key for
its page. There is no intermediate state where a workspace exists with an admin and
no content.

Three things are substituted on the way in:

| What | Where | Substituted with |
| --- | --- | --- |
| Workspace id and name | `space.json` | the tenant's own |
| The connect command | `CONNECT_COMMAND` in `start-here/prototypes/connect-your-terminal/index.html` | the real one-line command for that workspace |
| Comment timestamps | `at` in `threads.json` | the provisioning time, so day-one threads do not read as months old |

Nothing else needs rewriting. The connect page falls back to deriving the
workspace name from the URL it is served on, so it is never wrong, only less
specific.

**Start Here has to be the first card.** The gallery orders projects
most-recently-worked-on first and falls back to A→Z, which is why the second
folder is named `worked-examples` rather than `examples`: with one timestamp
across the whole seed — what a single atomic write produces — Start Here leads
and the examples follow. Provisioning that stamps files as it writes them should
give them all the same time, or write Start Here last.

## Rules for editing it

- **Generic, always.** This ships from the engine to every workspace on every
  instance. No instance, product, or personal names — CI scans this tree along
  with the rest of the repo.
- **The prototype contract holds** (`../agents/prototype-contract.md`):
  self-contained static HTML, no build step, opens straight from disk, and a
  one-line `<meta name="description">` that says what the page shows.
- **Link the design system, do not copy it.** The canonical relative path
  (`../../../skills/starter-ui/…`) resolves on disk and the build rewrites it for
  the site, which is what keeps six prototypes wearing one system.
- **A CDN script must be pinned to an exact version.** `specimen-viewer` is the
  worked example: an immutable versioned URL, never a moving tag, and a visible
  fallback when the network is not there.
- **Copy is instruction, not decoration.** Every step says what you should see
  when it worked, and every step that can fail carries its own way out.

## Working on it locally

From this directory, with a raw engine clone around it:

```bash
GV_SPACES_ROOT="$PWD" node ../build.js
```

That composes the workspace into the engine's `dist/`, exactly as an instance
would serve it — the galleries, the library tier derived from the skill, and the
six prototypes. Each prototype also opens on its own by double-clicking its
`index.html`.
