# Augur — the engine (conventions)

**Augur** is a build + deploy platform for prototyping sites. This repo is the ENGINE
only: `build.js`, the overlay worker (`src/_worker.js`), the comment/canvas layers, and
the platform scripts. It carries **no secrets, no user list, no product content** — a
raw clone builds an empty, open-gated site. Everything deployment-specific lives in a
separate private **deploy shell** repo (name yours anything), which pins this engine
plus one repo per space and holds `identity.json`, `deploy.config.json`, the CI
workflows and every secret.

```
augur/
├── build.js            # composes spaces → /dist (landing, galleries, tokens, worker stamping)
├── src/_worker.js      # Cloudflare worker: login gate, comments/pins/status KV, canvas, MCP proxy
├── src/canvas/         # infinite-canvas engine (see CANVAS.md)
├── src/review/         # comment/annotation overlay
├── pitis/              # optional cursor-companion build addon (site builds identically without it)
├── scripts/            # offline preview, poster shots, og cards, review CLI
├── agents/             # engine contract docs for SPACE-collaborator agents (publish,
│                       #   review feedback, prototype contract, space.json, identity)
├── realtime/           # canvas multiplayer worker (Durable Objects; deployed separately)
└── brand/              # the engine's own marks + fonts
```

## The spaces model

A **space** is a separate git repo: a self-contained design system + prototypes bundle.
`build.js` enumerates every dir with a `space.json` under `GV_SPACES_ROOT` (default:
`./spaces`). **One instance serves exactly one space, at the site root.** The
path-mount tier — several spaces in one deploy, the default at `/` and the rest under
`/<id>/` — is RETIRED (Phase A). A build still discovers siblings so a local workspace
can preview any of them, but nothing routes to a non-default space: name the one you
mean with `GV_SPACES_ROOT` or `GV_ONLY_SPACE`. Serving several workspaces from one
deploy is Phase B's job, resolved by Host, not by path.

**Which workspace a request is for is decided in exactly one place**:
`resolveTenant(request, env)` in `src/_worker.js`, called once at the top of `fetch()`
before any config is read. `scripts/one-tenant-resolver.mjs` runs in `check` and fails the
deploy if a second call site appears or the one call drifts below the config load — a
second caller returns the same answer while there is one workspace, so nothing else would
notice.

**It has two bodies now, and the deployment picks one by its shape.** Unset
`TENANT_HOST_SUFFIX` (every self-hosted instance) → the `tenantId` the build stamped into
`instance.json`, read once per isolate. Set it → the workspace is the first label of the
Host header (`acme.example.com` with suffix `.example.com` is `acme`), parsed by
`src/tenant-host.mjs`, plus that workspace's Durable Object stub via `tenantStub()` — the
one place in the engine a workspace address is computed, and where `TENANT_JURISDICTION`
is applied if the deployment sets one (see the env reference; a jurisdiction is part of
the address, so a second addressing site would agree with this one right up until the day
somebody set it). The suffix is LITERAL, so `-team.example.com` keeps every
workspace on a first-level hostname a universal certificate already covers.
**The dynamic branch never falls back to the static one**: a hostname that names no
workspace — the apex, a deeper name, a malformed label, or one of the RESERVED_LABELS
(`www`, `admin`, `login`, `postmaster` …) — gets a bare 404 before any config read, because
a fallback there would answer with somebody else's workspace. Reserved and malformed are
refused in identical words on purpose. The resolver does NOT check whether a workspace
exists: that answer lives inside the object it would have to reach anyway, and asking here
would put a round trip in front of every request.
**One addition rides the miss path: the ALIAS TABLE** (`B-claim-platform-subdomain`).
When the literal label names nobody, `aliasTenantId` makes ONE KV lookup —
`host:alias:<full hostname>` → `{workspace}` — written only by the workspace object's
`claim` verb, which itself refuses any hostname the literal resolver resolves, so the two
tables are disjoint by construction and a request the literal resolver can answer never
pays for a lookup. A miss (or an unreadable store, or a corrupt row naming a reserved or
malformed target) stays the bare 404. Keyed by FULL hostname so a customer's own hostname
(`B-custom-hostname-alias`, no suffix at all) lands in the same table later — one lookup,
not two. A claimed workspace's GENERATED address keeps working: the suspension read also
carries `canonicalHost`, and the front door 302s GET/HEAD requests whose path is not under
`/_` to the canonical hostname, path and query preserved — the machine surface (`/__*`,
`/_build.json`) answers in place so publish tokens, probes and CI keep working against the
origin their config names. A suspension outranks the redirect. `test/tenant-claim.test.mjs`
pins all of it.

**What can be done TO a workspace from outside it is one list**: `CONTROL_VERBS` in
`src/tenant-do.js` — `provision`, `status`, `suspend`, `resume`, `rotate`, `delete`,
`purge`, `rename`, `claim` — served
under `/__control/<verb>` on the workspace object and reachable only by code holding the
namespace binding. Two properties hold across all of them. **Only `provision` may create
anything**: every other verb reads `meta` and refuses `not-provisioned` before `init()`,
because each takes its workspace name from a URL an operator typed and a typo that
provisioned would leave a workspace nobody knows exists. And **a refusal is a 4xx**, never
an `ok: false` inside a 200 — the control plane logs a verb's verdict from the status line,
so a refusal wearing a 200 is a suspension written into the audit log as having happened.
`delete` is a TOMBSTONE (`DELETE_GRACE_MS`, the 30 days the hosted lifecycle page promises
customers) and erases nothing; `destroy()` is the separate primitive that does.
**WHICH PUBLISHED CONTENT AN ERASURE MAY TAKE IS NOT A QUESTION THE STORE CAN ANSWER.**
`spaces/<spaceId>/…` names a SPACE and carries no workspace segment, so `deleteWorkspace`
asks `workspaceSpaces` instead of matching a prefix: with no workspace objects bound the
deployment serves one workspace and every authored space is its own (`legacyIsOurs`, the
same reading the KV overlay makes of an unprefixed key), and with them bound the answer is
the workspace's own `publish_versions` — the counter every commit goes through, in storage
that belongs to the object's id and so cannot name a neighbour's space. It is authoritative
and NOT provably complete (a publish predating the binding left no row), so a workspace
that can account for NOTHING while the store holds authored spaces is a refusal
(`nothing-attributable`) rather than a clean delete of nothing. `_engine` is declined under
both shapes: one build's chrome serves the whole deployment. This replaced a filter that
matched SPACE ids against the WORKSPACE id — a prefix no key has ever carried — which
deleted zero objects and answered `ok` on every deployment where the two names differ. It is also
the one verb with a READ on it: `GET /__control/delete` is the CONFIRMATION a person is
shown first — the export-before-you-confirm step, what the workspace holds as counts, and
the retention window, every number of it DERIVED from `DELETE_GRACE_MS` by
`src/delete-confirmation.mjs` rather than typed. That derivation is the whole item
(`F-tenant-delete-ux`): a confirmation screen is the last surface anyone re-checks when the
constant moves, and the two things that render one — a workspace's settings and an operator
console in the other repo — cannot import this module, so the copy crosses the wire instead
of being written twice. The backup half of the promise is NOT invented: the deployment
declares its rotation in `BACKUP_RETENTION_DAYS` and, with none declared, the copy says a
backup copy outlives the erasure without naming a period. `rotate`
really revokes publish tokens and ⏳ does NOT yet end sessions, because `userToken()` still
HMACs on the Worker-wide `SESSION_SECRET` rather than the workspace's own signing key —
`test/tenant-verbs.test.mjs` pins that gap so the day the read swaps over, a failing test
says so. `purge` erases ONE PERSON from a workspace's record of itself — the same sweep
`src/purge.mjs` gives the admin route, reachable as a verb because an erasure has to happen
in every workspace an account belongs to and only the control plane knows which those are;
it REFUSES on an author-id collision rather than over-redacting, checking every member ever
and not only the active ones. `rename` is the CUT-OVER and not a move: a workspace's address
is the first Host label and the resolver turns that label straight into this object's name,
so a workspace cannot hold two addresses and moving to one means moving its state to the
object behind it (`augur migrate`). The verb marks THIS address dead — `moved_at`, refused on
a tombstone, idempotent — and **records nowhere it went**, because a forwarding pointer is one
field away from being served and the usual reason to change an unguessable address is that it
reached the wrong person. It revokes nothing: this object still holds the only copy until
something moves it. `claim` is the OPPOSITE decision for the opposite case
(`B-claim-platform-subdomain`): a SECOND, chosen hostname beside the generated one — it
writes the resolver's `host:alias:` KV row and its own `canonical_host` meta, refuses any
hostname the literal resolver resolves (so a generated-shape label is never claimable and
the alias table cannot shadow anybody), refuses a hostname another workspace's alias row
holds rather than re-pointing it, and allows ONE canonical hostname per workspace. Where a
rename hides the destination, a claim advertises it: the generated address 302s browsers to
the canonical one and keeps the machine surface answering in place. The list is written
twice, here and as `TENANT_RPC` in the
control plane, because the repos cannot import each other; both suites assert the other's
copy.

**A freshly provisioned workspace is FURNISHED, not empty, and the content lands BEFORE the
commit that creates the workspace** (`F-seed-pack-at-provision`, `src/seed-pack.mjs`). The
content is `seed/` — the three start-here prototypes, the worked examples, the starter design
system, `threads.json` — built ONCE PER ENGINE PIN by every engine-only build into one sealed
document, `dist/__seed/pack.json` (`scripts/lib/seed-pack-build.mjs`; a child build of
`seed/`, exactly what a publish of a clone would compose, with the git author stamp STRIPPED
so the engine author is not the author of every workspace's welcome content). `provision
{seedPack: true}` makes the workspace object write that pack into its own segment of the
bundle store — blobs, `versions/1.json`, `manifest.json`, version 1 of the workspace's space,
the connect page's `CONNECT_COMMAND` slot filled with the workspace's real `npx augur connect
--origin …` line — and THEN commit the admin, the restamped threads and the `publish_versions`
row in one transaction. The control plane asks and carries nothing: no content, no store name,
one boolean on the one verb it already had. Every seed version reads as the platform's
(`seedSource()`, `SEED_ACTOR` as `publishedBy`, the sentinel in `unitSources`, no per-file
`by`), and the write REFUSES over a manifest with real provenance. **What makes content-first
safe is the front door**: `suspension()` now answers `provisioned`, `readSuspension` keeps a
`false`, and the router gives an unprovisioned workspace `unknownHostResponse()` — the bare
answer a hostname naming nobody gets — so a provisioning that dies between the content and the
commit leaves bytes at keys no request can reach, never a half-furnished site, and the next
provisioning of that object writes its own pack over them. A deployment asked for the pack
with none in its bundle refuses the create (`seed-pack-unavailable`, 503) rather than opening
an empty room; `wrangler-preflight` refuses a hosted deploy whose built dist lacks the pack.
⚠️ The gate means a TENANTS-bound deployment serves ONLY provisioned workspaces — the order
the migration runbook already mandates (provision, then move content in), and what
`test/migrate-kv-to-workspace.test.mjs`'s target now does. `bundleKey`/`bundleStore` moved
to `src/bundle-keys.mjs` so the object writes exactly where the front door reads; the worker
re-exports them. `test/seed-pack.test.mjs` pins all of it.
**And the seed YIELDS** (`F-seed-yields-to-real-publish`): a unit whose live copy answers to
`isSeedSource()` is nobody's work, so a real publish replaces it outright — no flag, no git
history, from a plain copy of the tree — while a unit a person has republished keeps every
rule above. The decision is ONE line in `composePublish` (`src/publish-compose.mjs`) and
deliberately not in either caller's evidence: the store runs the same composer to resolve a
repo-less publisher's stale base, and a rule in the CLI's git evidence alone would leave the
store deciding by byte identity against the base, which agrees only until a re-seed changes
bytes under a seed marker. "Changed" is judged on `sh`, the pre-decoration source hash the
commit handler already stamps provenance on, so the five pages a person did not touch keep
the seed's bytes AND its marker however differently their engine decorated them. A seeded
page the tree LACKS is an evidenced deletion needing no git — still gated by
`--allow-unpublish`, named (`removalBlocked`) rather than silently kept without it.
`test/seed-yields-to-real-publish.test.mjs` runs both ends against the real pack.

**A suspension is enforced at the front door, once, before the config load** —
`readSuspension` + `SUSPENDED_ALLOWED` in `src/_worker.js`, checked right after the resolve
so a paused workspace never reads its own store to find out it is paused. **What it stops is
not "everything"**: the hosted lifecycle page promises customers that signing in and a full
export both keep working on a suspended workspace ("if your reason for coming back is to
leave, you can"), so `SUSPENDED_ALLOWED` is that promise as a list — `/__auth`, `/__logout`,
`/__publish/_login/token`, `/__publish/_state/export`, plus the four READ verbs of the bundle
store an export walks. Nothing that writes. **It fails CLOSED**, unlike every other
degradation here: an isolate that has never managed to read the flag refuses, because a
workspace can be paused for serving a phishing page and "the store blinked" is not a reason
to serve it again. A stale answer is kept, exactly like the freeze. A visitor gets a plain
`noindex` 503 that names nothing — not the workspace, not the reason — because a suspension
can be a takedown and the reason belongs to the people who can act on it. **A MEMBER gets a
different page**: the reason as the operator recorded it, when it started, and for a
tombstone the erasure date, plus the one thing true in every case — `augur export --full`
still runs. It invents no procedure for coming back, because how a workspace returns depends
on why it went. Proving membership costs a config read, so it is paid ONLY when a session
cookie is actually present, and the check fails to "stranger" on anything at all: it unlocks
nothing, and a wrong answer costs a member a sentence.
**A single-workspace instance pays nothing**: no `TENANTS` binding, no question asked.
**One kind of suspension lifts itself.** The lifecycle page promises a workspace paused for
DORMANCY comes back on the first successful sign-in by an admin, and `resumeAfterDormancy`
(inside the `/__auth` success branch) offers the workspace that chance. **The whole of it is
the discriminator, not the resume**: the reason is decided by `resumeOnSignIn` in the workspace
object against an ALLOWLIST — `DORMANCY_SUSPENSION_REASONS`, one word — never a denylist, so a
suspension kind invented later is inert here until somebody adds it on purpose instead of
resuming on the day it ships. An acceptable-use takedown and a tombstone both survive their own
admin signing in, and that is the case to read `test/dormancy-resume.test.mjs` for. The split is
deliberate: the WORKER knows who signed in (the roster is its, and an editor or a viewer never
gets as far as a call), the OBJECT knows the reason — the worker's copy is cached, and a
workspace re-suspended seconds ago still reads as its old reason from there. The resume is
RECORDED (`resumedAt`/`resumedFrom`/`resumedBy` in `status()`, the person as a one-way id)
because resuming clears the suspension row. Fire-and-forget on `waitUntil`, like the activity
stamp: a sign-in never waits on it and never fails over it. **It is wired into `/__auth` and
nowhere else, and that is complete rather than partial**: this engine mints a session in two
places, and the other (`/__invite`) is not on `SUSPENDED_ALLOWED`, so a paused workspace's
gate answers before that handler ever runs. `test/dormancy-resume.test.mjs` pins the list from
this side — if it fails, the question is not "widen the array" but "does the new path have to
resume too". `/__publish/_login/token` is on the list and deliberately does NOT resume: it
mints a publish token, not a session, carries no role, and a backup script must not un-pause
anything. ⏳ Nothing writes that reason yet — the 90-day sweep is not built, and when it is it
must suspend with exactly that word.
**An address a workspace has been renamed away from is not a pause and has no allow-list**:
the same front-door read reports `moved`, and every request to it — sign-in and export
included — gets `unknownHostResponse()`, byte-identical to the refusal a reserved hostname
gets. Nothing is forwarded and the answer never names the workspace or its new address; the
switcher is how a member finds it, and the confirmation copy says so before the button.

**Nothing an isolate keeps may be shared between workspaces, and the proof of that is a
TEST, not a lint.** `test/tenant-route-sweep.test.mjs` drives the real worker in BUNDLE
mode — what every live instance serves — with two workspaces over a table of routes,
ungated ones first, sequentially inside every TTL and concurrently with several requests
in flight. Each route asserts its workspace's OWN answer (never merely that the two
differ) and that its own store was read, so a green result cannot be vacuous; adding a
route is one line. `scripts/no-tenant-globals.mjs` still runs in `check` and is worth
keeping, but it is a cheap first filter over module-scope BINDINGS: its own header lists
the shapes it provably misses (a memo on a function object, a field on the default
export, a write into a value nested inside a frozen table). Three cross-tenant leaks
shipped past it green. Extend the sweep, not the lint.

`space.json` contract: **single source = [agents/space-json.md](agents/space-json.md)**
(all fields incl. `siteOrigin` + `mcpAllowlists`, with semantics). Load-bearing
highlights: `id` is the only required field (mount name + URL prefix; repo name is a
free label); **`adminOnly` no longer seals anything** — it only ever sealed a
NON-default mount, and there are no non-default mounts, so `RESTRICTED_BASES` is
permanently empty and the field is still parsed but inert (who may see a workspace is a
membership question, not a path one); the UI skill is auto-detected from
`skills/<prefix>-ui/` and every
canonical asset name derives from that prefix (`designSystem.skill` overrides). If you
change what `discoverSpaces()` parses, update agents/space-json.md in the same commit.

**Publishing is whitelist-driven (critical guardrail).** Only the contents of
`prototypes/` folders, the gallery tiers (`base/ components/ pages/ patterns/`,
rebuilt), the `playground/`, and the skill assets the skill declares in its
`skill.json` ship (see [agents/ui-skill.md](agents/ui-skill.md); skills without
a manifest get a fixed default inventory). `research.md`, `context.md`, anything
outside `prototypes/` — internal, never copied to `/dist`.
**Plus the three documents the build READS to compose a space** — `registry.json`
(the overlay catalog), `prototype-status.json` (the status baseline) and the skill's
`skill.json` itself — verbatim, at the path the build reads them from
(`C-clone-publish-roundtrip`). They are what makes `augur clone` produce a tree that
publishes again rather than one whose build dies asking for the catalog; a clone of a
hosted workspace did exactly that. The rule they draw: what the build reads travels,
what it writes (indexes, graph, search) does not, research never does.

## Deploys — this repo ships nothing

**Engine pushes auto-deploy; space content publishes directly.** A push here fires
`.github/workflows/deploy-trigger.yml` (an `engine-updated` dispatch); the shell
moves the engine pin and its `deploy.yml` ships worker code + engine chrome
(~1 min). **Space content does NOT ship on push, and cannot** — spaces publish via
`augur publish` (seconds, atomic; token from `augur connect` or `augur login`).

**One source of content, structurally.** A shell builds with `GV_ENGINE_ONLY=1`:
space discovery is skipped, no space is on disk, and the manifest writer THROWS if
the build emitted anything that isn't engine chrome (`ENGINE_CHROME` in `build.js`).
So a redeploy cannot overwrite a publish however stale its checkout — not by
convention, by construction. Shells therefore mount no space submodules at all;
they keep a `spaces` roster in `deploy.config.json` for repo-side automation.
The assertion is what makes this hold: anything space-derived that merely LOOKS
like chrome (a composition graph, a space icon, a cross-space aggregate) fails
the build rather than shipping. Chrome is what `ENGINE_CHROME` names, and
nothing else.

Deploy verification is the public **`/_build.json`** stamp:
`{builtAt, engine:{…}, spaces:{<id>:{sha, dirty?, version, publishedAt, publishedBy}}}`.
It means one thing — the last thing published. `augur status` puts it next to your
clones and `origin/main`; the admin panel renders the same table. **`dirty` is the
one to watch**: a publish from an uncommitted tree serves bytes held in no
repository, so it is the only state that cannot be reproduced from git.

**Cross-space aggregates are synthesized, never shipped.** `/__canvas/catalog.json`
(the insert picker) and `/__canvas/tracks.json` span every space, so no single
publisher can write them — one space publishing would blank the others. Each space
carries its slice in its routing fragment and the worker merges them
(`canvasAggregate`). Adding a site-wide aggregate means adding a fragment field,
never a file.

**Runtime config (no build-time worker stamping).** `src/_worker.js` ships VERBATIM;
build.js emits `dist/__config/instance.json` (users from `GV_IDENTITY_PATH`; from
`GV_DEPLOY_CONFIG_PATH`: `mcpHostSuffixes`, `mcpHostAllowlistUrl`, `vanityRedirects`,
`rtOrigin`, `sentinels`, plus a `tenantId` — the deploy config's if it sets one,
otherwise the id of the space mounted at the root) and
`dist/__config/routing.json` (public prefixes,
version map, restricted bases, space list, the mcp host + path allowlist union spaces
declare via `space.json "mcpAllowlists"` — the engine's own path floor is the three
paths the MCP/OAuth protocol speaks, and no platform's API endpoint is named in it —
except ⏳ `LEGACY_MCP_PATH_FLOOR`, the pre-declaration floor handed to a routing fragment
that carries no `mcpPaths` KEY at all, since such a manifest was published before
declarations existed and cannot grow one by taking a newer engine; `mcpPaths: []` is a
real declaration meaning none and gets nothing, and one publish by a current clone
retires the shim for that workspace).
The worker fills these via `loadConfig()` (~1.5s
per-isolate cache) and seals `/__config/*` from external requests. Build.js also
emits `dist/__manifests/<id>.json` per space (+ pseudo-space `_engine` for shared
chrome): `{files: {path → {sha256, mime, size}}}` + the space's routing fragment.

**Per-file provenance is RECORDED at commit, not derived from git.** The commit
handler stamps `{by, editedAt}` on every file whose SOURCE changed and carries the
previous stamp forward untouched for every file that did not — so a publish
touching one page cannot restamp the other five hundred. "Source" is `sh`, the hash
build.js records of a page's bytes BEFORE it decorates them (verbatim copies carry
none and compare `h`), because every authored page leaves with the engine's
fingerprint in it and a stamp keyed on the served bytes called every engine change
one person's work (2026-09-02: every card "Edited 8 hours ago" by the CI token). A
publish whose source commit IS live's, clean on both sides — a re-bake — changes
nothing a person wrote, and a live entry that predates `sh` keeps its stamp once
rather than being judged on bytes it cannot explain. **And the stamp records the
EDIT, not the publish**: build.js sends git's answer per file — author id and
commit time of the last real change, guards applied — and a changed file adopts
it; `{publisher, now}` is only the fallback for a file git cannot vouch for
(untracked, or edited and not yet committed). Otherwise a publisher shipping a
colleague's pushed commits, or a restore, put the wrong person and the wrong day
on every card. `by` is `personId(email)`,
the same one-way hash messages carry, and **never an address**: a manifest is read
by more things than a comment thread is. This replaces a class of bug rather than
adding a feature — provenance used to come from `git log` and publishing keeps
disturbing that evidence (a mass commit, a shallow clone's graft author, a
reconcile-adoption; each needed its own build.js guard, and every guard was a
tell). **The gallery renders it, from the live manifest at serve time.** build.js
still bakes a git-derived date, because a card cannot read a stamp assigned AFTER
the build that draws it — that line is the baseline, and `CURRENCY_JS` replaces it
with the recorded one from `/__currency` on load. A file that predates the field
stays UNSTAMPED — absent is the honest answer, and inventing one would tell the
same lie the derivation told, so a unit with no record simply keeps the baked line.

**What is current, and what has been left behind** (`src/currency.mjs`). The same
read answers a gallery card and an agent, because two reads become two definitions
of current: `/__currency` for a session, `/__publish/<space>/currency` for a publish
token (`?since=14d` is the whole of "what changed here lately" — see
[agents/currency.md](agents/currency.md)). A card carries its status as a WORD next
to the date, and a unit untouched past `STALE_AFTER_DAYS` says so — "Untouched for
7 months", with the colour drained out of its poster. **Staleness is DERIVED and must
stay derived**: it is computed from `editedAt` and a clock, stores nothing, and adds
no field. The obvious "improvement" — an `archived` flag — is accurate only for the
units somebody came back to mark, which are exactly the units that were never the
problem. Nothing baked at build time carries the stale treatment either: a git date
is good enough to caption a card and not good enough to accuse one.

**Direct publish (the bundle store).** With `GV_ASSET_SOURCE=r2` + a `BUNDLES` R2
binding, the worker serves those manifests from content-addressed R2 blobs and takes
publishes over `/__publish/<space>/{check,blob,commit,rollback}` (per-space bearer
tokens, minted at `/__admin/tokens`; instance config pushed via
`/__publish/_instance/config`). Reads mirror the writes for backup —
`GET /__publish/<space>/{manifest,versions,version/<n>,blob/<h>}`, same bearer auth.
Routing then derives from the LIVE manifests, so `routing.json` is read only when
serving from `ASSETS`. **A deployed instance runs in bundle mode**: its CI ships
chrome and worker code, never content, so `ASSETS` alone is a site with nothing in
it. Assets mode is the local path (`augur dev`, `npm run offline`, a raw engine
build), not a fallback a live instance can drop back to. Undoing a bad publish is
`rollback` against the store's version history, not a serving-mode switch.

**⏳ The store's keys carry the WORKSPACE on a deployment that resolves one from the
Host.** `bundleKey` in `src/bundle-keys.mjs` (imported by the worker and by the workspace
object) — `t/<workspace>/spaces/…`,
`t/<workspace>/config/instance.json`, `t/<workspace>/assets/…`. It exists because not one
`BUNDLES` key used to name a workspace: `config/instance.json` was one document for the
whole bucket and `spaces/<id>/` named a SPACE, so two workspaces publishing a space under
the same id wrote the same object and the commit CAS, the unpublish guard and the
stale-base check all evaluated against a stranger's document. A gate cannot un-collide a
key. **⚠️ `blobs/` and `spaces/_engine/` stay GLOBAL and SHARED, deliberately** — every blob
write verifies the digest against the key, so a workspace can only write bytes that hash to
the name it used and dedup is worth keeping; and one worker build serves every workspace, so
one chrome bundle is correct rather than a leak. Prefix either by accident and you either
break `blobGc` (which is written for a shared namespace on purpose) or take the chrome off
every workspace on the deploy that does it.
**⚠️ SHARED TO SERVE IS NOT SHARED TO WRITE, and that gap was a live cross-workspace hole.**
The credential that can write `spaces/_engine/` is minted per workspace, from that
workspace's own Settings panel against its own roster — so the authority was scoped to one
workspace while its effect was scoped to the deployment, and any hosted workspace's admin
could rewrite `/admin/index.html` and `/sw.js` for every other customer on it.
`sharedChromeRefusal` in `src/_worker.js` now refuses `_engine` WRITES wherever the chrome is
actually shared, at the same chokepoint `capabilityRefusal` uses, to **every** credential —
there is no capability that satisfies it, because a capability nothing can mint is a comment
rather than a lock. Its discriminator is `bundleWorkspaceSegment(...).workspace`, the fact the
sharing itself depends on, and NOT `env.TENANTS`: the preflight refuses a suffix with no
binding and deliberately allows a binding with no suffix, which serves one workspace and
shares its chrome with nobody. The op list names the READS (`manifest`, `versions`, `version`,
`blob` GET, `currency`) so a publishing verb added later is closed by default, and `rollback`
counts as a WRITE — it bypasses the engine-downgrade guard by design, so leaving it open
would let any admin re-arm a superseded chrome for everyone. Reads are untouched, because a
403 there is a backup that skips the chrome and reports success; `restore.mjs` skips a space
the target declines for that reason, loudly, since a copy from a single-workspace instance
always carries `_engine` and `augur migrate` is what moves one onto a shared deployment.
**A shared deployment's chrome now has exactly one way to be updated, and it is not any
workspace's own credential.** The control plane's `chrome` operator verb — grant-gated,
expiring, and audit-logged like every other operator verb — mints the ONE token that may: a
star-scope publish token capped to `caps: ["chrome"]`. `sharedChromeRefusal` admits it by
`capabilityGrantsRoute`'s POSITIVE check, not by scope, so a workspace's own plain star token
(no `caps` at all) is still refused `chrome-not-writable-here` — the same door, the same
regression this closes. It cannot touch `config/instance.json`: `CAP_ROUTES.chrome` names the
`_engine` write/preflight trio plus the manifest and version reads its own base-version CAS
needs, and no `_instance` op at all, so the credential that may refresh the rail cannot also
push the roster. **Unset `TENANT_HOST_SUFFIX` — every instance
running today — writes NO segment at all**: `bundleStore` returns the binding itself, so
there is no new code between the worker and R2 and the keys are byte-for-byte the ones they
have always been. **Which families take the segment is `BUNDLE_TENANCY`, one word each**,
the same shape as `KV_CUTOVER`. ⚠️ **A segmented write reaches the segmented key and
NOTHING ELSE** — it used to straddle the bare key too, "so a flag flip is a revert", and on a
shared bucket that bought no revert (the bare key is unattributable and unread there; a flip
reads the collision, not yesterday) while copying every workspace's roster and blob index to
where every workspace shares. Flipping a family's flag back on a shared bucket is therefore
a ROLLBACK to what predates the segment, and the rehearsal's `reverted` phase says so. **There
is NO read-through fallback where the workspace comes from the Host** — an unprefixed key
there belongs to whichever workspace the deployment served before the segment existed and
nothing in the key says which — so a live workspace has to be MOVED:
`augur bundle-rekey` → `POST /__publish/_state/rekey`, a server-side copy that is
idempotent, dry-runnable, paged, and **never deletes the source**. It refuses outright once a
second workspace holds a prefix. `test/bundle-tenancy.test.mjs` is the cheap filter;
`scripts/bundle-tenancy-rehearsal.mjs` is the proof — real workerd, a real R2 bucket, two
workspaces publishing the SAME space id over HTTP, the migration run, the disclosure probes
re-run against invented labels, and the per-family revert run against a modified copy of the
worker. Reach for the rehearsal before trusting a green suite about a key shape.

**A publish may not silently unpublish.** The tree that publishes defines the
whole space, so a checkout missing a folder REMOVES its public URLs for everyone —
invisibly, because the gate answers a now-unknown path with the login page and
"gone" reads as "locked" (it took an opportunity's links, and the embeds pasted
into third-party sites, down for an hour). `commit` therefore refuses a manifest
whose `routing.publicPrefixes` drops anything the live one has, unless the body
carries `allowUnpublish` (`augur publish|ship --allow-unpublish`) — the
INSTANCE_SENTINELS rule widened from a path list to the whole public surface.
Star-scope tokens included: a maintainer's stale tree removes as much as anyone's.

**A publish may not silently REVERT either — and since protocol 5 that is
structural, not policed.** A publish COMPOSES on top of the live manifest
(`publish.mjs` + `scripts/lib/publish-{compose,evidence,conflict}.mjs`): per
authored unit (a unit = a prototype/playground folder = a `publicPrefixes`
entry), the publisher's build lands only when live's recorded unit source
(`routing.unitSources`, falling back to the space-level `source`) is a clean
commit in their history — a per-unit fast-forward, like `git push` — or when git
evidences a local edit (porcelain, or commits since a provable ancestor base).
Everything else keeps live's bytes verbatim, so a stale checkout cannot revert,
unpublish, adopt, or fork what it never edited, by construction. The working
tree is NEVER written to: a genuinely concurrent same-unit edit keeps theirs at
the URL and publishes mine at `<name>-conflict-<who>` + CONFLICT.md in the
MANIFEST only. Shared skill files are per-file: mine ships with evidence, theirs
is never implicitly dropped. Removals require the deletion committed AND
`--allow-unpublish`; `--takeover` ships the whole tree (repo surgery only).
Hard rule: tree folders named `*-conflict-*` never publish implicitly, and
ship's auto-commit leaves untracked ones unstaged — fork litter cannot re-enter
live or ride into a person's commit (the 2026-08-19/22 laundering + cascade
class, closed). Generated pages (galleries, indexes) stay last-writer-wins.
`stripVolatileHead` remains the tolerant comparator (og/twitter meta, marker
chrome, title emoji) so a contested verdict is only reached on real content.
Server side, `baseVersion` CAS (`stale-base` 409) still guards the race between
check and commit, and the one-round-trip fast path rides only when live is
exactly the publisher's own last publish. **The STORE can resolve a stale base
too** (`forkOnConflict: true` on the commit body — OPT-IN, so a publisher that
does not ask gets today's 409 unchanged): it loads
`spaces/<id>/versions/<baseVersion>.json` and runs the SAME `composePublish` the
CLI runs, substituting the base manifest for git as the evidence — `editedUnits`
is "units whose bytes differ from the base", `ffUnits` is "units live has not
touched since the base". A contested unit forks exactly as it does client-side
and the response carries `forks`. That exists because **a hosted workspace may
have no repo at all**, so a repo-less publisher has nothing to recompose FROM and
a 409 is a dead end rather than a retry. A change OUTSIDE every unit on both
sides is still a hard 409 (`conflict-outside-prototype`) — a stylesheet is not
safe to fork. The unit vocabulary and the composer live in `src/publish-units.mjs`
and `src/publish-compose.mjs` precisely so there is one definition: the CLI
re-exports both, and the worker imports them. `_engine` is exempt (no authored
units). `ship` still fetch+merges before publishing, so the common stale case
ships the union without composition ever holding anything back.

**Forking is a VERB, and it moves no bytes.** `POST /__publish/<space>/fork {from, to}`
(`augur fork <from> <to>`) makes the unit at `from` also serve at `to`, by writing new
manifest KEYS that point at hashes the store already holds — so a hundred-file prototype
forks without uploading, downloading or hashing one blob, and `bytesReferenced` (which
deduplicates by hash) does not move. It is the same aliasing the conflict fork above already
does; a second mechanism would give the two forks two definitions of what a copy is. It is a
PUBLISH — same bearer token, same freeze/suspension gates, same version counter, same
append-only history, so it rolls back and exports like any other. And it is the one
publishing verb that needs **no tree at all**, which is the point for a workspace that has
never had a repo. The copy is stamped with the FORKER as the new unit's owner rather than
inheriting the original's acl (else "fork it to get an editable copy" hands the fork the
restriction it was forked to escape), and remembers its parent: `routing.forkedFrom[unit] =
{path, version}` beside `routing.unitOwners[unit]`, both unit-keyed maps in the shape
`unitSources` already has. **Both are additive and OPTIONAL** — a manifest carrying neither
means exactly what it meant before they existed, and
`test/manifest-lineage-compat.test.mjs` proves it against a baseline generated by the code
that predates them rather than asserting it. **Both are stamped and CARRIED by the server,
never read from a request body**: a publisher's tree has never heard of somebody else's
fork, so a commit taking `routing` verbatim would leave the fork's files serving while
dropping its parentage and its owner — and an owner a request could assert would be an acl
anybody can type. People are `personId` here and everywhere else a manifest names one;
`publishedBy` remains the single address-bearing field, with `redactProvenance` as its
erasure path. Aliased files keep the SOURCE's per-file `{by, editedAt}` — the bytes did not
change, so neither did who last changed them; restamping a hundred files with the forker is
the mass-commit failure per-file provenance exists to retire. ⏳ **Nothing renders lineage
yet** — 'forked from' and 'forks of this' chips ride `C-manifest-provenance`'s client-side
manifest read when it lands, not a second one.

**The first REAL publish is the onboarding completion signal, and the server is the only
thing that may say it happened** (`C-first-publish-signal`). On every successful `commit`
the worker asks `isSeedSource(out.source)` — the ONE predicate in `src/provenance.mjs`,
never a string compare — and for a version that is not the platform's seed write it stamps
the workspace object once (`meta.first_publish_at`, `DO NOTHING` on conflict, so a second
publish neither resets nor duplicates it) and the publishing member once
(`members.first_publish_at`, keyed by the publish token's resolved actor — a CI token with
no address stamps the workspace and nobody). The role-change verb bumps
`meta.viewers_became_editors` when a viewer becomes an editor or an admin, and nothing
else counts. Three numbers a launch retro can read: workspaces connected, members
converted, viewers become editors. `_engine` never counts (chrome is the deployment's,
shipped by CI); `fork`, `rollback` and `delete` never count either — only `commit` adds
something a person made. The commit response carries `firstPublish: true` on exactly the
publish that connected the workspace. **`GET /__onboarding/status`** →
`{connected, firstPublishAt, members: {converted, active}, viewersBecameEditors, me:
{firstPublishAt}, backing}` — what the browser-side connect step and the seeded start-here
page poll. Its auth is A SIGNED-IN MEMBER, ANY ROLE: a stranger gets 401 and no field,
because whether a gated workspace is in use is a fact about it they were not given; `me` is
the caller's own conversion, with no email parameter, the rule every `/__me/*` route
follows. **It degrades by saying so**: a deployment with no `TENANTS` binding — every
self-hosted instance — keeps no such record (the onboarding it serves does not exist there,
and a KV copy would be a second definition of "connected" nothing reads) and answers
`backing: "none"` rather than a `false` that looks like it looked; an unreadable object is
a 503, never `connected: false`, because a poller reading that would tell the person their
publish did not land. The stamp is AWAITED on the commit path, not fire-and-forget, and can
never fail the publish — the version is already written when it runs. ⏳ Neither stamp nor
the counter travels with `augur migrate` / `restore --state`: they are operational meta,
like `last_activity_at`, and a moved workspace reads as unconnected until its next real
publish. `test/first-publish-signal.test.mjs` drives all of it over the real routes.

**Durability.** The store is the only copy of live content, and R2 has no
point-in-time restore. In-store: manifest versions are never pruned and blobs are
never garbage-collected, so `rollback` reaches any past publish. Off-Cloudflare:
`augur export --out <dir> [--history]` walks the read endpoints with a publish
token (no account credentials) into an incremental, content-addressed directory;
`augur restore <dir>` puts it back as a normal publish, preserving `source`
provenance and refusing to bury newer live content without `--force`. Walkthrough:
`docs/store-recovery.md`.

**⚠️ Without `--full` that is a copy of PUBLISHED CONTENT AND NOTHING ELSE** — not
who could publish it, who had been invited, what anybody had said about it, or what
had been pasted onto a board. `augur export --full` adds all of it, from
`/__publish/_state/export`, which walks `src/state-inventory.mjs` so the account of
what exists and the account of what a backup covers are one account. It needs a
STAR-SCOPE token, because the answer carries the roster and the publish-token hashes,
and it can never carry the password hashes: a credential is account-level, so the
route cannot reach one. `augur restore <dir> --state` replays it — opt-in, because
putting the roster back changes who can get in, which is a larger act than putting
content back. A copy records `full: true|false` so a restore can never mistake one
for the other, and each command nudges when the copy and the flags disagree.

**Shipping a change** — `augur ship` is the default and what agents should run:
commit (everything, untracked included) → publish (the live URL, in seconds) →
push (retried). **A folder with no `.git` ships too** — a hosted workspace may never
have a repo, and `augur clone` produces exactly that folder. There, steps 1 and 3
have nothing to do, publishing is the whole of it, and the guarantee git was
providing does not vanish: the concurrent-edit decision moves to the STORE
(`--fork-on-conflict`), then the folder pulls live back three-way so it cannot
diverge. Same event, same words, one path. That order is deliberate: the commit makes losing work
impossible, and the publish must not wait on the network. A rejected push
reconciles automatically — different prototypes merge silently, a genuine
same-prototype conflict keeps THEIR version at the real path and forks yours to
`<name>-conflict-<who>` with a note, because prototype HTML must never be
textually merged. Conflicts outside a prototype folder abort the merge for a
human.

**Local commands** (`augur <cmd>` via the bin entry, or `node scripts/<cmd>.mjs`):
`augur init [--id] [--name] [--origin] [--project] [--prototype]` (scaffold a new
space in the current dir: `space.json` + one starter prototype at
`<project>/prototypes/<name>/`, the nesting `discoverSpaces()` actually looks in;
refuses to overwrite) ·
`augur dev` (standalone shell — single space folder, dev identity fallback) ·
`npm run offline` (multi-space workspace) · `augur connect` (pair a terminal with a
signed-in browser for a publish token, no password; `publish` runs it itself when it
has no token) · `augur login` (trade web credentials for a publish token: CI, scripts,
instances without pairing) · `npm run deploy` (build + direct upload to Pages;
`--check`, `--preview`) — in bundle mode this ships CHROME, so reserve it for
engine/worker verification; content goes out with `ship`/`publish` ·
`augur ship [-m msg] [--no-push]` (the default path) ·
`augur publish [--space <id>|--all] [--dry-run] [--allow-unpublish]`
(publish only; `AUGUR_TOKEN` + `AUGUR_ORIGIN`) ·
`augur fork <from> <to> [--space <id>]` (your own copy of a published artifact at a new
URL — see Forking below; the one publishing verb that needs no tree at all) · `augur status`
(live vs clones vs `origin/main`; exit 1 on drift) ·
`augur refine [--gate 0.99] [--base <origin>] [--only …] [--restart] [--audit]`
(is a rebuilt component actually finished? render it, photograph it, measure it against
the original, and report a pass-rate per component — resumable across nights, and with
no way for the thing being measured to assert its own result. See
`docs/canon-refine.md`.) ·
`augur mark [<path>] [--ttl <s>] [--clear]` (say what you are about to work on, read
what everyone else is — a TTL'd note that refuses nothing; see
[agents/working-marks.md](agents/working-marks.md)) ·
`augur canon <list|find|save|check|start|collect|snippet|grade|apply>` — ONE surface over
two scripts, because it is one job. `list|find|save|check` are the canon you HAVE:
resolve a canonical name to files cold, and promote a working screen into the canon so it
grows as a side effect of working ([agents/canon.md](agents/canon.md), `scripts/canon.mjs`).
`start|collect|snippet|grade|apply` are the canon you do not have YET: copy it out of a
live product you have a login for ([agents/canon-extract.md](agents/canon-extract.md),
`scripts/canon-extract.mjs`, which the first script spawns). The evidence collector runs
in the browser the person is already signed in to, and **the engine does none of the
deciding**: the user's own agent maps evidence onto the roles in `src/canon/schema.mjs`,
which are exactly the tokens the seed workspace is born with, so an extracted canon and a
day-one one are one format. No inference dependency, held shut by
`test/canon-no-inference.test.mjs`. ⚠️ The extractor's grade verb is `grade`, not `check` —
both halves arrived with a `check` meaning different things, and `check` stayed with the
NAMES because `agents/canon.md` documents it and `init.mjs` bakes it into the `CANON.md`
every scaffolded space is born with. ·
`augur export --out <dir> [--full]` / `augur restore <dir> [--state] [--force] [--allow-unpublish]`
(store backup; `--full`/`--state` cover everything that is not published content) ·
`augur freeze [--reason …] [--status]` / `augur thaw` (read-only while a workspace is
being moved — writes refused with a 503 that says why, reads and sign-in unaffected;
`thaw` prints the duration a migration has to publish) ·
`augur migrate --from <origin> --to <origin> [--freeze]` (freeze → export → restore →
VERIFY the far side family by family; safe to re-run after any failure, and it touches
neither DNS nor the thaw, which both need a person). See `docs/migration-freeze.md` ·
`augur clone --space <id>` / `augur pull` (a live publish back into an editable tree; a
clone is the SOURCE, `export` is the backup).

**Leaving is free at two granularities, and the second one is the one usage asks for.**
`migrate` moves a whole workspace between instances; `augur clone --prototype <name>
[--from <space-dir> | --space <id>]` takes ONE artifact out and leaves the engine behind
entirely — the prototype re-rooted so its index is a domain's index, the design-system
folders it references beside it, and nothing else. The peel is the same
`stripBuildDecorations` the adopt path uses, aimed at the standalone folder instead of at
a repo. **The claim is verified, not asserted**: every file about to be written is
scanned, and an injected marker, an engine `/__…` route, a page global or an absolute
link back to the instance FAILS the command rather than shipping a copy that phones home
from somebody else's domain (`scripts/lib/graduate.mjs`; exit `1` engine trace, `3`
dangling reference). Both sources produce byte-identical output — a workspace with a repo
and a hosted one that never had one get the same folder, which
`test/graduate.test.mjs` pins against a real build. WHEN to use it is the harder half and
lives in `docs/graduation.md`: the moment a tool has a stable audience that is not the
team. The alternative being declined is a research workspace quietly becoming the
production host for somebody's customer-facing tool.

Env reference: `GV_SPACES_ROOT` (spaces location) · `GV_ENGINE_ONLY` (=1: chrome
only, no space discovery — what a shell's CI runs) · `GV_ONLY_SPACE` (build one
space) · `GV_IDENTITY_PATH` (user list) · `GV_DEPLOY_CONFIG_PATH` (deploy config) ·
`OFFLINE_PORT` (offline preview).
Runtime worker env (per-instance Cloudflare project settings, not build-time):
`TENANT_HOST_SUFFIX` — unset (the default, and every self-hosted instance) means one
workspace named by the build; set means the workspace comes from the Host header. Set it
only together with a `TENANTS` Durable Object binding — `scripts/wrangler-preflight.mjs`
refuses a config with one half and not the other, and refuses an empty-string suffix,
which reads as multi-workspace to a person and single-workspace to the resolver.
`TENANT_JURISDICTION` — the jurisdictional restriction those workspace objects are
addressed in (`eu`, `fedramp`, `fedramp-high`, `us`), or unset for none, which is what
every deployment does today and the only default the engine may have: where a
self-hoster's data lives is theirs to choose. **It is part of the ADDRESS, not a setting
on the binding** — there is no config key for it, `idFromName(x)` and
`jurisdiction("eu").idFromName(x)` are two different objects, and a Durable Object's
storage belongs to its id, so it cannot be changed once a workspace exists. Anything else
holding the same namespace binding has to be given the same value or it resolves a
different object and finds it empty. `tenantNamespace()` in `src/_worker.js` applies it,
`tenantStub()` is the ONE place a workspace address is computed
(`test/tenant-jurisdiction.test.mjs` reads the source and fails on a second site), and the
value goes to the platform verbatim: an unaccepted one throws rather than falling back to
an unrestricted address, since a silent fall-back is the exact failure this exists to
remove. The list of accepted values lives only in `scripts/wrangler-preflight.mjs`, which
refuses a typo, an empty string and a jurisdiction with no binding before the deploy —
in the request path the platform is the only authority, so a second copy there could only
go stale.
`DELETE_DISPATCH_URL` + `DELETE_DISPATCH_TOKEN` — the shell-dispatch channel
(`shellDispatch`): the one way a worker action changes a REPO rather than only live
state. Two event types ride it: `prototype-delete` (the admin-only `/__delete` route;
the shell workflow `git rm`s the folder in the space repo) and `roster-update` (Admin
invite/remove; the shell's `roster-update.yml` — see `templates/shell/` — commits the
person to `identity.json`, so the file stays the one durable roster record). Unset →
`/__delete` answers 501 and reports deletion unconfigured; invites still work but
answer `fileSync: "unconfigured"` and the person lives in the KV overlay only.
`BACKUP_RETENTION_DAYS` — how long this deployment's off-site backup copies live after the
day they are taken, in whole days. Read ONLY by the delete confirmation, which adds the
grace to it to say when the last copy anywhere expires. Unset (and anything that is not a
non-negative number) means "not declared", and the confirmation then states that a backup
copy outlives the erasure without naming a period — never a default, because a default here
is a retention promise nothing is running.
`MAIL_PROVIDER` + `MAIL_FROM` + `MAIL_API_KEY` (+ `MAIL_REGION`/`MAIL_PROJECT_ID`, or
`MAIL_API_URL`) — the mail transport (`src/mail.mjs`, see Email below). The local
deploy scripts read `.env.deploy` for the rest (`PAGES_PROJECT`, `REALTIME_CONFIG`, the
Cloudflare creds) — see `.env.deploy.example`. **No account id, project, worker name or
shell repo name is hardcoded in this repo's code or scripts — they resolve the instance
through `scripts/lib/instance.mjs` or fail loudly (docs name example repos
illustratively).**

## Offline mode (local live preview)

`npm run offline` (`scripts/offline.mjs`) builds `dist`, runs the real worker via
`wrangler dev`, and watches every build input with ~1s reload. **It runs the same front
door a deployed instance does** — `main = src/entry.js`, `[assets] run_worker_first =
true` — against a config it generates into `.wrangler/offline.toml` on every start
(`scripts/lib/offline-wrangler.mjs`; generated, not committed, so a stray `npx wrangler`
cannot pick it up and a local edit cannot lose the gate line). It used to be `wrangler
pages dev dist`, and the difference is the whole point: a Worker serves a matching static
asset BEFORE the worker runs unless the config says otherwise, and `dist/__config/
instance.json` carries the roster with seed passwords — so running the deployed front door
locally is how that inversion gets found by a person. The posture secrets stay on argv
(`--var K:V`), never in the generated file. It points
`GV_SPACES_ROOT` at the PARENT folder and picks out sibling space clones by their
`space.json` — so edits in any sibling clone preview instantly, no commit or pin bump.
It auto-detects a sibling deploy shell's `identity.json` (login gate ON, same as live);
without one the gate is open. **⚠️ If `.env.deploy` holds real KV credentials, the
offline worker reads/writes the PRODUCTION KV** (comments/pins/statuses are live for
everyone); rename `.env.deploy` for a local-only sandbox (logs `KV: local`). Canvas
realtime follows the same split: live KV **plus `RT_SHARED_SECRET` in `.env.deploy`**
joins the instance's real rooms (without the secret the realtime worker refuses the
join and boards silently run solo — saves still land in prod KV); sandbox mode
disables realtime outright (`GV_RT_DISABLE`), so sandbox boards never broadcast into
shared rooms. The wrangler child is supervised — a workerd crash respawns it (loop
cutoff in `scripts/lib/offline-respawn.mjs`) instead of killing the server. Only one
offline server needs to run regardless of how many agents edit.

## Worker gate rules (list public overlay assets in `isPublicPath()`)

Any file the overlay loads from a public page (e.g. `/__review/*`, images embedded in
public prototypes) **must be listed in `isPublicPath()`** in `src/_worker.js`, or the
gate serves the login HTML in place of the asset and an `<img>` fails silently. Avoid
inline `data:` images for overlay UI — serve a real same-origin file.

**Screen contract (SPA prototypes):** the comment overlay scopes to
`<body data-gv-screen>`. Multi-page prototypes need nothing (URL fallback); a prototype
that swaps screens without changing the URL must publish its visible state there, or
comments bleed across screens.

## Conventions

- Commit directly to `main`, small logical units, push often. **Stage only the paths
  you changed — never `git add -A`** (shared checkout, concurrent agents).
- Never commit secrets. `.env*`, `dist/`, `node_modules/` are gitignored.
- `UI_VERSION` in build.js versions the SITE shell (rail, indexes, overlays). Bump it
  only for shell changes, never for edits inside individual prototypes.
- Prototypes are self-contained static HTML (no build step); they live in the space
  repos, not here. Edit spaces in their own clones — the `spaces/` mounts in a deploy
  shell are read-only build mirrors.
- **The engine is a pinned dependency of every instance — never fork-and-patch it.**
  Engine gaps get fixed HERE on `main` (generic, zero product words); every instance
  takes them by pin bump (the reference instance automatically, others via their
  shell's `engine-bump.yml`). Instance values live in the shell's `deploy.config.json`,
  space values in `space.json`. Outside contributors go through PRs (CONTRIBUTING.md) —
  fork to PR, not to deploy; maintainer review holds PRs to the same bar: generic,
  config-driven, minimal-instance-safe.
- **No workspace's private vocabulary in the engine.** `check` runs two guards, and they
  work differently on purpose. The word scan is a denylist of instance/product/personal
  words — it catches a name someone already wrote down. `scripts/no-foreign-vocabulary.mjs`
  catches the one nobody has: it names nothing, and fails on SHAPES only a foreign
  vocabulary has — a colour stored as a quoted value under a proper noun (a brand table),
  a regex anchored on a literal `--<prefix>-` (the token vocabulary is the skill's
  `cssPrefixes`, carried out on the graph — interpolate it), and a `<meta name>` the
  engine reads that is neither standard web vocabulary nor `augur-*`. Its own header
  states the two gaps it does NOT cover (a workspace's slug prefixes, and a private word
  smuggled into a general-vocabulary list) — both are the same shape as the engine's own
  names, so they are review questions, not lint ones. Read that before assuming cover.
- The canvas layer is documented in `CANVAS.md`; the pet layer in `pitis/README.md`.

## Authentication

Invite-only. `identity.json` is a roster of **who exists**, not what they know — email,
name, initials, colour and role. Passwords live in KV as PBKDF2 hashes under
`users:secrets`; invite tokens under `users:invites`.

- Admins **cannot set or read passwords.** Reset clears a user's hash and mints a
  single-use invite link, in one action — there is never a live password alongside a
  pending invite.
- **⚠️ Reset writes a tombstone, never a deletion.** The reset handler sets
  `ov[u.email] = null` — a key that is *present* holding `null` — rather than deleting
  it. `effectiveSecret` falls back to the roster's seeded `passHash` only when the key is
  *absent*, and changing the `null` to a `delete` reopens that exact fallback — every
  roster user has a `users:secrets` entry (a hash if redeemed, a tombstone if reset), so
  nothing today should ever hit that fallback, but "tidying" a tombstone into an absent
  key would put the reset password right back in service.
- **⚠️ No effective BINDING ⇒ no session — and which value is the binding depends on
  `SESSION_KEYS`.** With the flag OFF (the default), `identify()` refuses any user whose
  `effectiveSecret` is empty (pending invite, or just reset), *before* deriving the
  session token — unchanged in every respect. With it ON, the same invariant is asked of
  the value the cookie is actually bound to: `sessionBinding` (stored per-person session
  key, falling back to the credential), which fails closed exactly as `effectiveSecret`
  does — no stored key and no credential is refused, an unreadable store is refused, a
  present-and-falsy entry is a revocation and is refused. The reason is the same in both
  modes: `userToken()`'s no-`SESSION_SECRET` fallback degrades to a publicly computable
  `SHA-256("gv:<email>:")` when the bound value is empty, so without the guard anyone who
  knows an email could forge a cookie for that account — including a reset admin, which
  hands over the admin API and admin-only spaces. **In no combination may an empty value
  reach the derivation, and that must survive any future refactor.** It signs no
  legitimate user out: the two cookie issuers, `/__auth` and `invitePost`, both establish
  a truthy binding before issuing one — a verified credential, or (flag on, invite
  redemption) the fresh session key `rotateSessionKey` just wrote, bound by value so a
  stale store read cannot mint a dead cookie.
  (`/__publish/_login/token` runs the same credential check but mints a publish token,
  not a session.)
- **⚠️ With `SESSION_KEYS` on, redeeming an invite link IS the sign-in.** `/__invite`
  renders a one-click confirmation instead of the set-password form, and its POST
  consumes the token, rotates the person's session key and issues the cookie — no
  password exists at any point, and `users:secrets` is not written. The GET never
  consumes in either mode (mail scanners follow links with a GET; a consuming GET would
  burn every scanned invite unread). Password sign-in on `/__auth` keeps working
  unchanged for anyone who has one — the flag ADDS a way in, it removes none. Flag off:
  the invite flow is byte-for-byte what predates it.
- **⚠️ `FIRST_RUN` moves where a successful redemption LANDS, once per person, ever.**
  With the instance flag on (`firstRun: true`, explicit true only), the first invite a
  person ever redeems 303s to `/__welcome` — a deliberately placeholder surface whose
  words live in `FIRST_RUN_COPY` and nowhere else — and every redemption after lands on
  `/` as always. The once-only record is the WORKSPACE'S (`users:firstrun`, segmented
  like every identity document), never a cookie: a second device and a sign-out agree
  about it. It is written BEFORE the redirect is issued, and every degraded case — flag
  off, no store, unreadable store, failed write — lands on `/`: nothing is SHOWN that
  could not first be RECORDED, and the surface must never cost anybody a sign-in.
  `/__auth` never routes there, so an existing member's sign-in is untouched; removal
  and purge both clear the record (a re-invited address is a new person). Flag off: the
  path answers exactly what it answered before the flag existed, and no read or write
  happens at all.
- **⚠️ `identify()` resolves the effective secret ONCE and passes it to the token
  derivation.** Re-resolving inside `userToken` is not atomic with the guard above: a
  truthy first read passes the guard while a later read returns `""`, and the
  derivation then collapses to the publicly computable `tokenFor("<email>:")` —
  reopening exactly the forgery the guard exists to stop. The `resolved` parameter on
  `userToken` is optional; every other caller resolves its own.
- **⚠️ `effectiveSecret` fails closed on a KV error.** No KV binding at all (offline and
  raw engine builds) falls back to the roster, as it must. But if KV *is* bound and the
  read or the JSON parse throws — or the stored value is not a plain object (an array
  passes `typeof x === "object"`, hence the explicit `Array.isArray` rejection) — the
  answer is `""`, never the roster. Restoring a blanket `catch` that falls through would
  make every tombstone evaporate at once on one transient KV blip and put every reset
  password back in service.
  - **⛔ Do NOT unbind the `COMMENTS` KV namespace to recover from a KV outage.** The
    fail-closed trade is deliberate and it has no in-app escape hatch: while KV is down
    nobody — admins included — can log in, and there is no recovery path in the product.
    The one thing a locked-out operator would naturally reach for is unbinding KV, and
    that does not fail closed: "no binding at all" is the *offline build* case, which
    falls straight through to whatever the roster seeds. Wait the outage out, or fix the
    binding — never remove it.
- **⚠️ The session cookie is `__Host-augur_user`, and the prefix is load-bearing.** `__Host-`
  is a name prefix the BROWSER enforces: it stores a cookie so named only when the cookie
  is `Secure`, has `Path=/`, and carries **no `Domain` attribute**. That last rule is the
  point — several workspaces share one apex host, so a page published on one of them can
  otherwise set `Domain=.<apex>` and have the browser send that cookie to a sibling
  workspace too. It could never forge a session (the token HMACs on `SESSION_SECRET` plus
  the user's effective secret), but it could *shadow* the real one and break login next
  door. Issue this cookie without all three attributes and the browser silently drops
  every session the deployment hands out, so never add a `Domain`, never narrow the
  `Path`, never drop `Secure`. One workspace host therefore cannot share a session with
  another by cookie, on purpose; spanning them is a central sign-in minting a separate
  session per host, never a weaker cookie.
  - **⏳ Migration window — the read set is THREE names, the write set is one.**
    `LEGACY_USER_COOKIES` in `src/_worker.js` lists the two names this cookie used to be
    issued under (`__Host-gv_user`, then the pre-prefix `gv_user`). Both are READ by
    `identify()` — always AFTER `USER_COOKIE`, so a stale name can never shadow a live
    session — and CLEARED by `/__logout`, and neither is ever ISSUED, so each drains away
    within `MAX_AGE` (a week) once the last instance issuing it has moved off it.
    **Adding a name to the read set is free; removing one signs people out**, so an entry
    goes only after checking what a live instance actually SETS — an instance whose engine
    pin is frozen can still be minting the oldest name, and its week has not started. The
    constant's comment carries the per-entry condition; `test/host-cookie-prefix.test.mjs`
    covers all three, and its ⏳ cases retire name by name with the list.
- Sessions are HMACs keyed on the runtime `SESSION_SECRET`, bound to the user's effective
  secret, so changing or clearing a password invalidates that user's cookies for free.
  This holds only when `SESSION_SECRET` is actually set on the project — `userToken()`
  falls back to an unkeyed SHA-256 when it's absent, so the secret must be configured for
  sessions to be HMAC-backed at all.
- **Profile photos are the one overlay that beats the config file.** A photo set from
  the profile menu (`POST /__me/avatar`, signed-in users only, always their own row)
  lands in KV — the image under `avatar:<hash>`, a pointer per person in
  `users:avatars` — and `applyAvatars()` stamps it over whatever `identity.json`
  carried. An `avatar` data-URI in the config is therefore a SEED: shown until that
  person changes it, restored if they remove it. That inversion is deliberate (a face
  is the person's, not the deployment's) and it's what lets an instance with baked
  photos take the feature by pin bump with nothing to migrate. `applyAvatars` copies
  the user objects rather than stamping `avatar` onto them — mutating in place would
  outlive the overlay and make removal un-undoable. Uploads are validated against
  their magic bytes, not their declared mime, because `/__avatar/` is ungated and
  echoes that mime back.
- **The roster has two layers, and the second drains into the first.** `identity.json`
  (injected at build time) is the durable record; KV `users:roster`
  (`{add:{…}, remove:[…]}`) makes an Admin-panel invite/removal live INSTANTLY, without
  waiting on a commit. The overlay is transitional by design, not a second record: the
  invite/remove handlers fire a `roster-update` shell dispatch so a workflow commits
  the same change to `identity.json`, and when the deploy that follows pushes the new
  config back (`/__publish/_instance/config`), the worker drains every overlay entry
  the config now supersedes — an `add` the file names, a `remove` for someone the file
  no longer names. Left un-drained, the two records diverge visibly: builds bake
  people-derived state into every generated page, an identity-file build and a
  live-roster build disagree about who exists, and each publish flips ~hundreds of
  gallery pages between the two renderings. `mergeRoster` precedence is unchanged
  (config wins over `add`; `remove` hides both), and none of this touches
  `users:secrets` — the tombstone stays the security boundary.
  - **⚠️ THE DRAIN MIRRORS THE CONFIG BEING WRITTEN, NEVER `tctx.CONFIG_USERS`.** On a
    deployment that binds a workspace object, `rosterWrite` decides each row's `source`
    from the `configUsers` list it is handed and THEN tombstones every row still marked
    `'overlay'` that the incoming `add` no longer carries. The request was loaded with the
    config this push REPLACES, so handing that one over means the pass does not name the
    person being promoted, their row stays `'overlay'`, and this loop deletes them —
    permanently, because the un-tombstone clause revives only `'config'` rows and the drain
    that would re-run it is gated on a KV read an object-only tombstone cannot move.
    `mirrorRosterDocs` takes the list as a fourth argument for that one caller.
    **Widening the un-tombstone clause is not the alternative**: it would undo the orphan
    tombstones that clause exists to write, and a removed person coming back is the worse
    failure. `test/roster-promotion.test.mjs` drives both directions over the real routes;
    clauses 11–12 of `scripts/tenant-do-rehearsal.mjs` run the same ordering inside a real
    Durable Object transaction on workerd, where the defect reproduces.
  - **⚠️ A WORKSPACE BORN IN THE OBJECT HAS NO FILE, AND ITS FIRST ADMIN IS AN OVERLAY ROW.**
    `rosterRead` emits `'overlay'` rows into `add` and nothing else — a `'config'` row is the
    MIRROR of a config file and the file is what serves it. `applyProvisioning` therefore
    writes the first admin `'overlay'`, stamped with the same name/initials/colour an invite
    stamps (`src/roster-chip.mjs`, the one definition both writers import). Written `'config'`,
    as it once was, the admin existed in the table and nowhere the serving path looks: a fresh
    signup's admin did not resolve through `/__people`, the people list was empty, and their
    own invite link answered "no longer valid". The row is not special afterwards — a config
    push naming them promotes it, a drain drains it, exactly as any invite. The alternative
    (emitting `'config'` rows from the object) was rejected on evidence: those rows carry no
    tombstone when a file stops naming somebody, so serving them keeps a person the config
    dropped — the property "the push AFTER it" in `test/roster-promotion.test.mjs` pins.
    **AND THE WRITE'S BASE COMES FROM WHEREVER THE SERVING READ COMES FROM.** Every roster
    write is a read-modify-write of the whole document followed by the orphan clause, so
    `readRoster` — the base of invite, remove, role change and the drain — answers from the
    object wherever it is `seeded`, as `readRosterDocs` already did for the read. It used to
    read KV unconditionally, and on a provisioned workspace (no KV era) the first invite the
    admin ever sent read an EMPTY document, wrote `{add: {invitee}}`, and the mirror
    tombstoned the admin who sent it. An unreadable object REFUSES the write rather than
    falling through to KV, for the same reason GATE 4 refuses the read: a base missing
    everybody KV never saw is a roster to orphan them from, one write later. KV still takes
    every write, so the copy behind the flag only grows more complete.
    `test/first-admin-roster.test.mjs` drives the signup shape — no config document at all,
    the admin's only way in an object-minted invite — over the real routes. ⚠️ **The revert is
    not a revert for a workspace born here**: flip `KV_CUTOVER.roster` off and a provisioned
    admin who has never been written to KV by a later roster write is not in KV to fall back to.
- **⚠️ The overlay is a convenience; the tombstone is the security boundary.** A failed
  KV read leaves the roster as the config list, which would put a removed CONFIG user
  back in it — so removal ALSO writes the `users:secrets` tombstone, and that read fails
  closed. Never reduce removal to the list alone.
- **⏳ Four identity families now answer from the WORKSPACE OBJECT, and the list is one
  constant.** `KV_CUTOVER` in `src/_worker.js` — `invites`, `lastseen`, `publishTokens` and
  `roster` today — is the cut-over, family by family, with the KV path still live underneath.
  Reads take the object
  first and KV as a FALLBACK, which is what carries an invite link somebody is already
  holding across the cut; **writes go to BOTH stores**, which is what makes flipping one word
  back a revert rather than a rollback (and what keeps `augur export --full`, which walks KV,
  a complete copy). A deployment with no `TENANTS` binding — every self-hosted instance —
  has no object, so `identityFor` answers null and nothing changes for it.
  **An unreadable object is a REFUSAL and does not reach the fallback**: an ANSWER of "no
  such invite" is a fact and an ERROR is the absence of one, and falling through on the
  second would make a broken store fail OPEN onto KV, which is the shape the whole gate
  design exists to avoid. `test/kv-read-cutover.test.mjs` drives both backings over the same
  HTTP endpoints, breaks the object's read and asserts the refusal, and RUNS the revert
  against a modified copy of the worker rather than asserting about the diff.
  **⚠️ THE SUITE'S STORE IS `node:sqlite` BEHIND A STUB, AND THAT IS NOT THE RUNTIME.**
  `scripts/tenant-do-rehearsal.mjs` is the same clauses on real workerd, under `wrangler dev
  --local`: the real deploy entry, a `new_sqlite_classes` `TENANTS` binding, a local KV, a
  local R2 (so the publish routes reach their AUTH check instead of answering 501 before it),
  and FIVE deployments over one persisted store — bound, unbound, and one reverted tree per
  family, differing only in the binding and in one word — so bound-versus-unbound, the
  refusal, and each family's revert are RUN rather than simulated. It is also the only place
  the column migration is exercised at all: every object elsewhere is BUILT in today's shape,
  so a column is dropped from a cold object and a real request is what puts it back. The
  break is a real one (the `invites` table renamed away, so the real SELECT throws inside the
  real object), and it is what a stub cannot stage. Reach for it before moving another family:
  the run found that `stampMs`'s tolerance for a pre-fix copy's expiry matched a shape only a
  hand-written fixture produces — SQLite stores a BOUND number through TEXT affinity as a
  double, `"…092.0"`, not `"…092"` — so the accommodation covered none of the rows it exists
  for. It needs no account and must never be given one.
  **⛔ `users:secrets` is not in that list and must never be**: a credential is
  account-level, so `effectiveSecret` moving belongs with cross-workspace sign-in, and the
  two land independently — whichever is second reads the other's straddle.
  **The roster read is FOUR KV documents becoming one round trip, and the object answers with
  those documents rather than with a roster** — so `mergeRoster`/`applyRoles`/`applyNames`/
  `applyAvatars` are one pipeline fed from either store instead of two that have to be kept
  in agreement. That needed two schema changes, both in `TENANT_SCHEMA_VERSION` 2:
  `publish_tokens.scope` carries KV's `space` VERBATIM (`*` stays `*`, a space id stays that
  space id — it is the authorization `publishAuthDetailed` refuses `wrong-space` on, and a
  row whose scope is NULL, written by a copy that predates the column, is treated as NO
  ANSWER and falls through to KV rather than being guessed at); and `members` keeps the
  durable half and the overlay half in SEPARATE columns (`name`/`role`/`initials`/`colour`
  against `name_overlay`/`role_overlay`/`avatar_*`, plus `source`), because `applyNames`
  drops a config-set `initials` when there is a name override and keeps it when there is
  not, and one merged column cannot answer both.
  **⚠️ `publish_tokens.caps` IS THE SECOND HALF OF THAT RECORD, and it is
  `TENANT_SCHEMA_VERSION` 3.** `capabilityRefusal` is deny-by-default over a `caps` field,
  and it is what lets the control plane hold a purge-only bearer instead of a star token
  that could publish over every workspace's content — but the object had no column for it,
  so a COPY of a KV record (a `restore --state`, an `augur migrate`, an operator adding the
  field to a token the object already held) landed here as an ordinary row and the narrow
  credential came back out of the read as a FULL star token, because this read answers
  before KV does. The column holds the JSON of KV's value — `null` is "carries none", a
  list is a restriction — and SQL NULL is NEITHER: it means a copy wrote the row before the
  column existed, and it is NO ANSWER, exactly as a null scope is. ⛔ Never "default it to
  unrestricted": that is the bug, spelled as a convenience. The cost of the straddle is one
  KV get per publish for tokens minted before the column, and it heals per token on the next
  mint. **`CREATE TABLE IF NOT EXISTS` is not a
  migration**: `TENANT_SCHEMA_ADDITIONS` + `applySchemaAdditions` add the new columns to
  tables an older object already built, and they ask by ATTEMPTING the `ALTER` rather than by
  reading `PRAGMA table_info`, because a PRAGMA is neither a SELECT nor a plain statement and
  a harness that routes by keyword answers it with no rows — which reads as "no columns" and
  skips every addition.
  ⏳ **The roster tick still spends TWO KV gets, down from six, and both are named in the
  constant**: `users:spaces` is inventoried `to: drop` rather than migrated, and answering
  `{}` for it from the object would widen a per-space restriction into somebody's global
  role; `spaces:icons` has no copy into the object's `settings` table yet. Neither is a
  blocker on this item — they are the next two, and `AN OBJECT THAT WAS NEVER GIVEN THE
  ROSTER DEFERS TO KV` in `test/kv-read-cutover.test.mjs` is why a workspace whose copy has
  not run does not read the object's empty answer as an emptied overlay.
- **⏳ The identity KV documents carry the WORKSPACE too, on the WRITE path.** `identityKey`
  in `src/_worker.js` — `t/<workspace>/users:roster` and the rest, the same segment
  `board:<workspace>:<path>` already carried and the same `t/` the bundle store uses. It
  exists because the reads moving to the object left the WRITES landing in one
  deployment-wide document each: a full `restore --state` into a second workspace overwrote
  the first one's `publish:tokens`, roster, roles, names, avatars and icons, and a nightly
  reset that CLEARS those families cleared them for every workspace at once, with no
  migration involved. **Which families take the segment is `IDENTITY_TENANCY`, one word
  each** — the same shape and the same per-family revert as `KV_CUTOVER` and
  `BUNDLE_TENANCY`, and the three share family names on purpose, so a source edit that
  reverts one must name the table (`test/kv-read-cutover.test.mjs`'s `revertedWorker` does).
  **Which DOCUMENTS each family owns is `IDENTITY_KV_FAMILIES`**, and it is checked against
  `src/state-inventory.mjs` in BOTH directions: every `to: "workspace"` KV family is either
  an overlay family (which on a `TENANTS`-bound deployment lives in the workspace object and
  never touches KV at all) or segmented here. **⛔ `users:secrets` is not segmented and must
  not be** — a credential is account-level, `to: "account"`, and it moves with
  `B-cross-workspace-signin`. **⚠️ `avatar:` and `spaceicon:` ARE segmented although they are
  content-addressed**, unlike R2's `blobs/`: a reset clears them by PREFIX, so one
  workspace's housekeeping would delete every workspace's photos. **Unset
  `TENANT_HOST_SUFFIX` — every instance running today — writes no segment at all**:
  `identityKvView` returns the binding itself, so there is no new code between the worker
  and KV. ⚠️ A segmented write reaches the segmented key and NOTHING ELSE — the bare key on a shared
  namespace is unattributable, so a flag flipped back there is a rollback to what predates the
  segment, never a revert (the straddle that once wrote both is what a `restore --state` leaked
  through), **and deletes do not reach it either**, which is what keeps one workspace's reset
  out of a neighbour's documents. There is **no read-through fallback** where the workspace comes from the Host,
  so a live workspace has to be MOVED: `augur identity-rekey` →
  `POST /__publish/_state/identity-rekey`, a copy that is idempotent, dry-runnable, paged,
  never deletes the source, and refuses `not-the-only-workspace`. It is a SEPARATE command
  from `augur bundle-rekey` on purpose — moving content must not silently move the login
  gate's documents. `test/identity-kv-tenancy.test.mjs` drives two workspaces on one
  deployment over the real routes; ⚠️ **a `kv.get` through the worker is cached up to sixty
  seconds**, so a live check of a freshly written key can answer missing for that long, and
  a "nothing changed" read of a neighbour is only evidence if the read is fresh.
- **⏳ A workspace may also be entered by a CENTRAL sign-in, and the split is deliberate:
  the control plane proves WHO, the workspace decides WHAT.** A magic-link sign-in on the
  control plane authenticates an email against ITS account store — that is the whole of
  WHO — and hands the browser a one-time hand-off token for the workspace the person
  picked. `GET /__enter?handoff=<token>` is where a workspace redeems it: it `POST`s
  `${ACCOUNT_ORIGIN}/__account/handoff` with `Authorization: Bearer <this workspace's own
  account-store bearer>` and `{token}`, gets back `{email}`, and only THEN asks the
  question the control plane cannot answer for it — is that email on ITS OWN roster. A
  hand-off proving a real, authenticated email that this workspace does not carry gets the
  identical `unknownHostResponse()` a stranger with no hand-off at all gets, at every step
  (no key delivered, no `ACCOUNT_ORIGIN` configured, an expired or already-redeemed token,
  a non-member) — no membership oracle, so nobody can learn "that email exists, just not
  here" from the reply. A proven member's session is minted the same way
  `inviteRedeemSession` mints one: `rotateSessionKey` writes a fresh per-person session key
  and `userToken` binds the cookie to the value JUST WRITTEN, never a re-read.
  - **The workspace's own account-store bearer lives in `meta`, not KV** — durable, never
    cleared by a reset, and never exposed on any external/public route. The control plane
    delivers it with the `account-key` control verb (`CONTROL_VERBS` in `src/tenant-do.js`);
    `accountKey()` reads it back for the object's own `/account-key` route, which
    `/__enter` reaches through a stub fetch (a Durable Object stub only speaks HTTP). No key
    delivered yet — including every self-hosted, single-workspace instance, which has no
    `TENANTS` binding and so no object to ask — makes `/__enter` inert, refusing with the
    same answer a stranger gets.
  - **The relationship runs the other way too, best-effort.** A roster invite or removal
    fires `noteMembershipUpstream`: a fire-and-forget `POST` to
    `${ACCOUNT_ORIGIN}/__account/index` (`{verb: "joined"|"left", email, at, label}`,
    bearer = the same account-store key) so the control plane's cross-workspace switcher
    lists the right workspaces for that person. It is PRESENTATION-ONLY — nothing in
    `/__enter` or anywhere else ever consults it for authorization — so a missed or failed
    notify costs a stale switcher row and nothing else, and it is handed to `ctx.waitUntil`
    so neither the key read nor the POST sits on the admin operation that triggered it. The
    `reconcile-membership` admin op backfills every current member with one `joined` each,
    for a workspace whose memberships predate this existing at all; the account store's own
    CAS on `at` makes a repeat notify a no-op, so it is safe to re-run.
  - **Three flags, and all are unset/off on every deployment today — byte-for-byte prior
    behavior.** `SESSION_KEYS` (this repo, `deploy.config.json` `sessionKeys`) is what lets
    a session bind to a rotated per-person key instead of a password — required for
    `/__enter` to hold a session at all, since a hand-off proves an email, never a
    credential. `ACCOUNT_ORIGIN` (this repo, `deploy.config.json` `accountOrigin`) is the
    control-plane origin this workspace redeems hand-offs against and reports membership
    to; unset, both directions are inert before any network call. `SIGNIN_OPEN` gates
    central sign-in itself and lives on the CONTROL PLANE, the separate repo neither side
    can import — it is independent of this workspace's own password sign-in, which keeps
    working unchanged whatever `SIGNIN_OPEN` is.
  - **The switcher is a dropdown on the workspace icon, fed by `GET /__me/workspaces`.**
    That route asks the control plane (over this workspace's own account-store bearer, for
    the caller's OWN email only) which workspaces the account belongs to, and stamps each
    row a server-built `href` to `${ACCOUNT_ORIGIN}/enter?workspace=<id>` — so the browser
    never learns the control-plane origin and a switch always routes THROUGH central
    sign-in (which holds the account session and mints the hand-off), never workspace to
    workspace. Unwired, or an account in one workspace, shows no dropdown — byte-for-byte
    the current chrome. `GET /enter` is deliberately a GET (the dropdown link is inherently
    cross-site, `*.augur.page` → the control plane, where only a top-level GET carries the
    Lax session cookie); its CSRF ceiling is bounded to bouncing an already-signed-in
    account into a workspace it already belongs to — no escalation, no oracle.

## Email

`src/mail.mjs` — `sendMail(env, {to, template, vars})` over a provider's **HTTP API**
(a Worker has no outbound sockets, so SMTP is not an option). Three templates:
`signup-verify`, `roster-invite`, `credential-reset`, each rendering text and HTML.

**Mail is an addition to the link, never a replacement for it, and that is the whole
design.** An invite has always been a single-use link the Admin panel hands back for a
human to send. It still is: `sendMail` returns a VERDICT and never throws, the admin API
returns `url` in every case and puts the verdict beside it as `mail`, and the panel shows
the link whatever happened. The four ways it does not send are all reported, never
swallowed — `unconfigured` (no provider; the panel reads exactly as it did before mail
existed), `misconfigured` (names the env var that is missing), `rate-limited`, `failed`
(the provider's own words). A provider outage costs the convenience of the send and
nothing else.

- **A driver is a shape of HTTP request, selected by `MAIL_PROVIDER`.** Endpoint, key,
  sending address and region are runtime env, so no deployment's domain, account or key
  is in the engine. `http` — a bearer-authenticated JSON POST to a URL you name — is the
  escape hatch, so an unsupported provider is a small relay rather than a fork.
- **The two templates a stranger can trigger are capped per recipient address**
  (`MAIL_RATE`), because a reset or signup form otherwise aims a mail cannon at whoever
  the caller types. The cap is on the MAIL, not on the action: a capped call still
  returns a live link, so nothing an admin was doing is refused. `roster-invite` is
  uncapped on purpose — only an authenticated admin reaches it, and a cap there blocks
  re-sending a lost invite while protecting nobody.
- Send from a domain the operator controls the DNS for, and **not** the domain
  prototypes are published on: published content is arbitrary user JavaScript, and the
  first phishing page harms that domain's sending reputation. SPF, DKIM and DMARC have
  to pass or the mail is spam, which is indistinguishable from an invite that never came.
- The provider call goes through an injectable `fetch`, so the suite drives every verdict
  — including a dead provider — with no network and no account. **Never send live mail
  from the test suite.**
