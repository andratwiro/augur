# Drafts that land — collaboration as a first-class engine concern

Status: approved design, 4 September 2026. Supersedes the publish/ship/compose model for
space content. Engine chrome and worker code keep their own deploy path; this document is
about the content people and their agents edit.

## 1. Why

Several agents at once is the default way a workspace is worked on: one person runs
several agent sessions on one machine, several people do so on several machines, and
they all edit prototypes on one shared site. The current pipeline was built for one
checkout per instance. Its client publishes "this working tree as the space", so on a
machine where sessions share a folder, one session's publish carries another session's
half-done files live, the ship command stages everyone's work under one name, a dirty
flag computed over the whole repository marks every publish from that machine, all
sessions build into one output folder and need a lock to do it, and the machine-wide
publish cache lets two checkouts believe live is each one's own last publish. The store
already composes per prototype and never merges, so people on different machines are
fine; agents on one machine are not, and that is the common case.

The fix is not another rule on top. It is to make the unit of collaboration the same
thing everywhere: on the server, on disk, in the URL, in presence and in history.

## 2. Decisions

These were settled with the product owner before the design and are not reopened here.

| Question | Decision |
| --- | --- |
| When does the team see an agent's change? | At once, at the agent's own draft address. The prototype's real URL moves when the draft is landed. |
| What does an agent's folder contain? | One prototype it has opened, plus read-only context on request. The rest of the workspace stays readable, never writable. |
| Two agents in one prototype? | Both are told, both work, each in its own draft. No locks. |
| A collision that still happens? | The second to land is refused, syncs main's changes into its draft with a local merge it reviews, and lands again. The server never merges. |
| The shared design system? | A unit like any other: opened to write, presence shown, changes live everywhere on land. |
| Identity across a person's sessions? | Person plus session label. Badges and stamps name the session. |
| Git? | The store is the truth and keeps its own history. Git is an optional export. |

The visibility decision was revised once, on evidence: every studied platform that serves
a URL to several editors ended with "live for the author, pinned for everyone else", by
drafts, branches or a viewer pin, and the ones that started fully live retrofitted one.
Pure design canvases stay live to anyone with a link and their users complain about it.

## 3. Vocabulary

- **Unit.** A prototype folder, or the design system. A unit has a **main** version,
  which is what its real URL serves, a history of every landing, and any number of open
  drafts. Unit paths are the ones `src/publish-units.mjs` already defines.
- **Draft.** One session's live working copy of one unit. Created by opening the unit.
  Live at once at its own address. Every save is a version of the draft.
- **Draft address.** The unit's URL followed by `@` and the draft id, for example
  `/checkout/flow/@k7f3q/`. The id is a short random token; the session label rides in
  presence, not in the address.
- **Session.** A person plus a label. The label is the agent session's own name when the
  agent tool exposes one, else a short generated one. A badge reads "Ana · checkout pass".
- **Save.** A batch of file changes reaching a draft. Automatic after every edit.
- **Land.** Replace the unit's main with the draft. The real URL moves, the draft closes,
  history gains an entry. This replaces ship for content.
- **Sync.** Bring into a draft whatever landed on main since the draft's base. Merged
  locally, reviewed by the agent.
- **Revision.** A monotonic integer per unit for main, and per draft for its saves.

## 4. The agent's day

```
augur open <opportunity>/<prototype>        # draft + folder; prints the draft address and who else is drafting
…edit…                                        # each edit is saved and live at the draft address before the next tool call
augur land [-m "what changed"]                # real URL moves; last line of stdout is the live URL
augur sync                                    # only when land was refused: pull main's changes into the draft
augur read <unit>                             # read-only copy of another unit, for context
augur close [--discard]                       # drop the local folder; --discard also abandons the draft
augur status                                  # drafts open on this machine, presence on their units
```

Rules of the day:

- Open creates the draft server-side first, then the folder. The folder holds only that
  unit's files and a `.augur/draft.json` with origin, unit, draft id, base main revision,
  draft revision and the per-file hashes last saved.
- Every edit is saved. The save is synchronous from the agent's point of view: a refused
  save fails the edit tool's hook with the reason, so the agent reads it in the next tool
  result. A successful save is silent.
- Land is refused when main's revision is not the draft's base. The refusal names each
  file that changed on main, with who landed it and when, and says to sync.
- Sync writes one-sided changes outright. A file changed on both sides is merged locally
  with a three-way merge against the base bytes, fetched by hash. A clean merge is written
  and saved. An overlap keeps the agent's version in place, writes main's version to
  `.augur/theirs/<path>`, prints the overlapping hunks, and leaves the folding to the
  agent. Nothing is guessed on the server.
- A session may open several units; each gets its own folder and draft.
- Writes outside opened folders are refused by the agent tool's hook. Read-only copies
  are also file-mode read-only.
- Nothing on a machine is shared between sessions: no build output, no lock, no publish
  cache. The one machine-wide file is `~/.config/augur/drafts.json`, a registry of open
  draft folders that the deny hook reads, written by atomic rename.

## 5. What a person sees

- **Gallery card.** Main's preview, plus one chip per open draft: face, session label,
  time since last save. Clicking the chip opens the draft address.
- **Prototype page.** Serves main. A thin bar lists open drafts. On a draft address the
  bar names whose draft it is and when it last saved, with **Land** and **Discard** for
  members, so a person can accept an agent's draft after looking at it.
- **History.** Per unit: every landing, who, when, the note. Restore lands an earlier
  revision as a new one. History is never rewritten.
- **Live tabs.** A tab on a draft reloads on each save. A tab on main reloads on land.
  The chrome script subscribes to the unit's object over a socket.
- **Design system.** Same card, same bar. In addition, any prototype page accepts a
  `?ds=<draft-id>` query (kept in a cookie while navigating) that resolves design-system
  files from that draft, so a shared change can be checked across prototypes before it
  lands.
- **Presence is derived.** A draft saved within the last five minutes is *active*; older
  is *idle* and the chip says so. Nothing heartbeats and nothing is trusted to clear
  itself.

## 6. The server

### 6.1 One Durable Object per unit

Class `UnitObject`, id derived from `<workspace>:<unit path>`. It is the authority on:

- `main`: revision, file table `{path → {hash, size, by, at}}`, and the landing history
  `{revision → {table, by, session, at, note, restoredFrom?}}`.
- `drafts`: `{draftId → {owner, session, openedAt, lastSaveAt, baseRevision, revision,
  table, closedAt?, discarded?}}`, with per-draft save history for the retention window.
- socket sessions for live reload, using hibernation so an idle unit costs nothing.

Storage is the object's SQLite. File bodies are never stored in the object: they are
content-addressed blobs in the bundle store under the workspace's own prefix, exactly as
today. A table row references a hash; a save uploads the missing bodies first (the
existing check/blob endpoints, scoped to the unit), then commits the table change.

The object is single-threaded, so compare-and-set on land and on save is a comparison
inside one method. There is no second consistency domain.

### 6.2 Endpoints

All under `/__unit/<unit path>/…`, bearer auth with the existing person token, session
label in a header. Space-scoped publish tokens map onto the units under that space.

| Verb | Body | Answer |
| --- | --- | --- |
| `open` | session label | `{draftId, baseRevision, table, presence}` |
| `save` | `{draftId, draftRevision, changes: [{path, hash?, baseHash?, delete?}]}` | `{draftRevision}` or `409 {stale: [{path, hash, by, at}]}` |
| `land` | `{draftId, baseRevision, note}` | `{revision, url}` or `409 {changed: [{path, hash, by, session, at}], mainRevision}` |
| `sync` | `{draftId}` | `{mainRevision, changed: [...]}`; the client merges, then its next `save` carries `baseRevision: mainRevision`, which advances the draft's base |
| `discard` | `{draftId}` | `{closed: true}` |
| `history` | – | landings, newest first |
| `restore` | `{revision, note}` | a landing whose table is that revision's |
| `presence` | – | open drafts with owner, session, last save |
| `delete`, `rename` | the existing confirmation shape | – |

A save's `baseHash` per file is the hash the draft last recorded for it. Inside a draft
there is one writer, so a stale base means a second process wrote to the same draft, and
the answer is the same sync procedure at draft level. Land's compare is on main's
revision only; per-file detail in the refusal is for the message, not the decision.

### 6.3 Serving

The worker resolves `/<unit>/…` to main's table and `/<unit>/@<id>/…` to the draft's
table, then fetches the body by hash through the existing cache. Tables are cached in the
tenant cache keyed by `(unit, revision)`; the object bumps a workspace-level revision
counter on every land, and the gallery cache keys on that.

Engine routes stay under `/__*`. A draft address is a content path, so the gate applies
to it exactly as to main: members see drafts, viewers with a share link see main.

### 6.4 Derived pages

The workspace object keeps a units index: unit → main revision, title, status, last land,
open-draft count. The gallery, opportunity indexes, playground index and component index
render at serve time from that index and the unit tables, cached per workspace revision.
Dates and contributor chips come from landing history. Previews and posters render in a
queue after a landing, as live-shot posters do now. Nothing that a visitor sees is built
on a client machine any more.

## 7. The local tool

Verbs: `open`, `land`, `sync`, `read`, `close`, `status`, `save` (explicit, for editors
without hooks), `watch` (a debounced save loop for people editing by hand).

- **Open** resolves the unit, calls `open`, materialises the table into the folder,
  writes `.augur/draft.json`, appends to the machine registry, prints presence, and
  ensures the agent tool adapters are installed for this machine (once).
- **Save** diffs the folder against `draft.json`, uploads missing bodies, commits the
  batch, updates `draft.json`. Files are sent as they are. There is no build.
- **Land** calls `land`; on refusal prints the changed files and the sync hint and exits
  non-zero. On success prints the live URL as the last line of stdout and closes the draft
  locally (the folder stays until `close`).
- **Sync** calls `sync`, merges as in section 4, saves the result, advances the base.
- **Read** materialises a unit read-only into `_read/<unit>/` beside the draft folders.
- **Adapters.** A small table maps a detected agent tool to two hooks: *deny writes
  outside registered draft folders* before an edit, and *save the edited file* after it,
  failing with the server's reason when refused. The first adapter targets the tool the
  engine's own sessions run in; its hook payload provides the file path, the working
  directory and a session id, and its session name is the label. Adding a tool is adding
  a row.
- **Identity.** The person token from `augur connect`. The session label from the agent
  tool when present, else generated at open and kept in `draft.json`.

## 8. The shared design system

The design system is one unit. Open, save, land and sync work unchanged. Two additions:

- Preview across prototypes with `?ds=<draft-id>` (section 5).
- Generators. A space may declare `augur:generate` as today. Land runs it for the
  design-system unit before committing, and its output is part of the landing. Lint
  stays space-local and advisory: the server refuses nothing but a stale base.

## 9. Edge cases

- **Killed session.** The draft is on the server with every save. Opening the same
  folder resumes it. Drafts idle for fourteen days close on their own, bytes kept thirty
  days more, then swept with the blob garbage collection.
- **Offline.** A save fails and the hook says so. The next save carries everything
  changed since. A draft is never lost to a network problem.
- **Two landings at once.** The object serialises them; the second is refused.
- **Repeated refusal.** A draft keeps its bytes whatever happens. Discard is the only
  way to lose them, and it is explicit.
- **Large files.** Bodies go to the store with the existing size caps. The object holds
  hashes only, well under its row limits.
- **New unit.** `augur open --new <opportunity>/<name>` opens an empty draft. A new unit is
  exactly `/<opportunity>/<prototype>/` or `/playground/<name>/`, never under a folder the
  engine reserves (the design-system tiers, `skills`, `admin`, anything starting with `_`);
  an existing unit is opened whatever its path. Landing it
  creates the unit and it appears in the gallery.
- **Delete and rename** are explicit verbs with the existing confirmation. A folder
  vanishing from a machine never removes anything. A deleted unit's URL answers gone;
  its history stays.
- **Retention.** Main history is kept for the life of the unit. Draft saves are kept for
  the retention window above.

## 10. Rollout

1. **Engine.** `UnitObject`, the endpoints, serving of main and draft tables, the
   history panel, presence chips, live reload. Import: each live unit's current files
   become main revision one, carrying the recorded stamps. The old publish endpoints
   keep answering during the transition.
2. **Tool.** The verbs and the adapters. `ship` becomes an alias that prints the open
   and land instructions and exits non-zero, for one release, then goes.
3. **Contracts.** Each space's agent contract, the machine front door (`/llms.txt`, the
   well-known file, the machine 401) and the CLI's own messages say open and land.
4. **Derivation.** Gallery, indexes, previews and posters move server-side. The content
   half of the build is retired. Space repositories become export mirrors: `augur clone`
   still yields a plain folder; a git mirror job is a later addition.
5. **Retire.** The publish client, ship, the composition, evidence and fork modules, the
   presence marks, the dirty flag, the machine-wide publish cache and every space-side
   ship lock.

## 11. Testing

- **Object.** Compare-and-set on save and land, land and sync deltas, restore, presence
  derivation at the five-minute boundary, idle close and retention sweep.
- **Serving.** Main and draft addresses resolve the right tables; the `?ds=` overlay
  resolves design-system files from a draft and nothing else from it.
- **Tool.** Open materialises exactly the unit; save sends only changed files; land's
  last line is the URL; sync writes one-sided changes, merges clean overlaps, and leaves
  real overlaps to the agent with the theirs copy in place.
- **Drill.** Two sessions in separate terminals told to edit the same prototype: both
  see each other at open, both land, the second is refused, syncs, lands. A session
  killed mid-edit resumes from its folder. The deny hook refuses a write outside a draft.
- **Migration.** A workspace imported from live manifests serves byte-identical pages at
  every URL before and after.
