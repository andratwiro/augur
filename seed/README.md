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
├── CANON.md                  how a canonical screen is named, for the agent that arrives cold
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

It is built ONCE PER ENGINE PIN, not composed per signup. Every engine-only build
(what a deploy shell runs) composes this tree with the real build — a child
`build.js` over `seed/`, exactly what `augur publish` would run over a clone of it —
and folds the result into one document, `dist/__seed/pack.json`, which ships inside
the worker's own asset bundle and is sealed from the outside like `/__config/`
(`scripts/lib/seed-pack-build.mjs`; `node scripts/build-seed-pack.mjs --print` shows
what is in it).

At provisioning, the workspace object writes that pack into its own segment of the
bundle store FIRST — every blob, then `versions/1.json`, then `manifest.json`, as
version 1 of the workspace's space — and only then commits the first admin, the
threads and the version row in one transaction (`src/seed-pack.mjs`; the control
plane asks for it with `seedPack: true` on `provision` and carries none of the
content). Published content and the workspace's own rows live in two stores with no
transaction between them, so the order is what makes it safe: a workspace the front
door will serve is one whose commit landed, and an object left unprovisioned by a
crash in between resolves to nobody, content or no content. There is no state where a
workspace exists with an admin and no content.

Every seed version is stamped as the platform's, never as a person's: `source` is
the seed sentinel (`src/provenance.mjs`), `publishedBy` is the seed actor, each
unit's `routing.unitSources` entry is the sentinel too, and no file carries an author
id — the pack builder strips the git-derived stamp, so the engine's author is not the
author of every workspace's welcome content.

Three things are substituted on the way in:

| What | Where | Substituted with |
| --- | --- | --- |
| The connect command | `CONNECT_COMMAND` in `start-here/prototypes/connect-your-terminal/index.html` | `npx augur connect --origin https://<label><suffix>`, the workspace's real address, filled the moment the page is published |
| Comment timestamps | `at` in `threads.json` | the provisioning time, so day-one threads do not read as months old |
| File timestamps | `editedAt` on every file in the manifest | the same provisioning time, all of them |

The space id and name are the pack's own (`space.json` here): the workspace IS the
space, and a workspace's label is its address, not its space id. The connect page
falls back to deriving the command from the URL it is served on, so with no
substitution it is never wrong, only less specific.

**Start Here has to be the first card.** The gallery orders projects
most-recently-worked-on first and falls back to A→Z, which is why the second
folder is named `worked-examples` rather than `examples`: with one timestamp
across the whole seed — what a single atomic write produces — Start Here leads
and the examples follow. Provisioning stamps every file with the one provisioning
instant, which is that single timestamp.

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
- **`CANON.md` is written by the tool, not by hand.** It is byte-for-byte the
  `NOTE` string in `scripts/canon.mjs` — the same one `augur init` scaffolds and
  `augur canon save` writes into a workspace that has none, so a hosted workspace
  and a self-hosted one describe their names identically.
  `test/canon-naming.test.mjs` fails when any of the three drift. Edit the string
  and regenerate this copy; the rules it summarises live in `agents/canon.md`.
- **The four canon tiers are ABSENT here, not empty.** There is no `base/`,
  `components/`, `patterns/` or `pages/` in this tree, and adding one would be
  wrong: a workspace's canon is what its own work promoted into it, so a seeded
  canon would be six screens nobody chose claiming to be the ones worth copying.
  `augur canon save` creates the tier directory on the first promotion. What the
  seed ships instead is the SCHEME — `CANON.md` — so the canon a workspace grows
  is named the same way as every other workspace's.

## Working on it locally

From this directory, with a raw engine clone around it:

```bash
GV_SPACES_ROOT="$PWD" node ../build.js
```

That composes the workspace into the engine's `dist/`, exactly as an instance
would serve it — the galleries, the library tier derived from the skill, and the
six prototypes. Each prototype also opens on its own by double-clicking its
`index.html`.
