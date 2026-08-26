# space.json — a workspace's contract with the build

A directory is a workspace because it has a `space.json` at its root. This file is
the single source of truth for the schema; docs elsewhere should link here, not
restate it.

## ⚠️ THE FILE IS STILL CALLED `space.json`, AND IT STAYS THAT WAY

The word for the thing is **workspace** — one workspace per instance, served at
the root, the tier a person is a member of. Everywhere a doc talks about the
concept it says workspace. The FILE keeps its old name, and that is a decision
rather than an oversight:

- **A filename is a compatibility surface, not prose.** Every workspace repo in
  existence has a `space.json`, including the public starter people are told to
  clone. Renaming it makes any clone taken before the rename build as "no
  workspace found" — silently, because a directory with no `space.json` is simply
  not a workspace.
- **Reading both names would be worse than either.** Two spellings for one file,
  forever, and every new reader has to learn they are the same thing. That is
  precisely the disagreement this section exists to prevent.
- **Nothing is bought.** `package.json` describes a "project" and nobody renames
  it. The name is an identifier the build matches on; the noun is what a person
  calls the thing.

The same rule holds for every OTHER identifier here: `GV_SPACES_ROOT`, the
`spaces/` folder, the `SPACES` key in the config, `/__publish/<space>/…`, and the
`--space` flag. They are spellings on the wire and in a path, and renaming them
breaks live deployments to gain a word. This doc keeps the name `space-json.md`
for the same reason the file does.

```jsonc
{
  "id": "my-space",          // REQUIRED. The workspace's identity everywhere: its URL
                             // prefix, its manifest in the store, its key in
                             // /_build.json (lowercase [a-z0-9-]). The repo name is
                             // a free label.
  "name": "My Workspace",    // display name in the switcher / landing
  "description": "…",        // one line for the site's link preview (the og:description
                             // an unfurl shows). Read from the DEFAULT
                             // workspace only; empty ⇒ the engine's own tagline
  "default": true,           // the workspace that builds at the site ROOT. An
                             // instance serves exactly ONE; the /<id>/ path mount for
                             // additional ones is RETIRED and nothing routes to it
  "badge": "current",        // optional label rendered beside the name
  "adminOnly": true,         // INERT — parsed and carried, but it seals nothing. It
                             // only ever sealed a NON-default /<id>/ mount, and those
                             // are gone. Do not use it to make a workspace private:
                             // that is what membership does. Kept only so an existing
                             // space.json keeps parsing.
  "projectsLabel": "Projects", // what the UI calls top-level prototype folders
                             // (rail section + landing). Internal code keeps the
                             // historical identifiers; only user-facing strings change.
  "help": [                  // this workspace's own sections in the Help drawer,
    { "title": "Skills",     // rendered after the engine's under the Building tab.
      "items": ["…", "…"] }  // The engine documents the engine; how THIS workspace
  ],                         // works — its skills, conventions, URL tricks — is
                             // yours to say, and this is where. Plain text, escaped
                             // (a config file is not a place to author markup); a
                             // section needs both a title and at least one item or
                             // it is dropped. Absent ⇒ nothing renders.
  "pendingPages": ["…"],     // pages badged "pending" in the gallery — a roadmap
                             // badge, NOT absence; the pages may exist
  "designSystem": { "skill": "<dir>" },  // override the auto-detected UI skill
                             // (default: the dir under skills/ named <prefix>-ui
                             // containing <dirname>.css; every canonical asset name
                             // derives from that prefix). What the skill ships is
                             // the skill's own call: see ui-skill.md (skill.json)
  "ignore": ["big-exports"], // extra top-level dirs the build must never treat
                             // as project folders
  "mcpAllowlists": ["path/to/mcp-allowlist.json"],  // hosts AND paths this
                             // workspace's prototypes may reach through the
                             // /__mcp/ proxy (union at build time) — see
                             // "The MCP proxy allowlist" below
  "publishTracks": true,     // ship the workspace's tracks/ session music. Default
                             // false: music plays in local preview (`augur dev` /
                             // offline) and never leaves the machine. Published
                             // tracks are served to instance ADMINS only, never
                             // publicly — set this for audio you hold the right
                             // to put on someone else's server.
  "siteOrigin": "https://your-site.pages.dev"  // where this workspace publishes;
                             // lets login/publish work from a bare clone with
                             // no shell around
}
```

Only `id` is required. A design system is optional — plain self-contained HTML
builds fine. The parse lives in `build.js` (`discoverSpaces()`); if you add a
field there, document it here in the same commit.

## The MCP proxy allowlist

`mcpAllowlists` names JSON files this workspace ships. Each is shaped:

```json
{
  "hosts": ["platform.example.com", "city.example.org"],
  "paths": ["/api/v1/configuration"]
}
```

Either key may be omitted; a file with neither is an error. `/__mcp/<host>/<path>`
forwards a browser call to `https://<host>/<path>` from this origin, so a prototype
can reach a platform that sends no CORS headers. Both halves have to match: the host
must be declared (here, or by the deployment's own suffix/URL knobs) and the path must
be declared or be one of the three the MCP/OAuth protocol itself speaks — `/mcp`,
`/oauth/registrations`, `/oauth/token`, which every deployment always allows.

Declare the rest yourself. A platform's own endpoints are a fact about that platform
and the prototype talking to it, not something a shared engine should know, so the
engine ships no product's API path and adding one costs you a line in your own repo
rather than a change to everybody's. Paths are compared whole and exactly against the
request's pathname — no prefixes, no query strings — and must be absolute, with no
`..` and no `//`. A missing or malformed file fails the build rather than degrading.

⏳ **One migration caveat, and it expires on its own.** The declaration is written into
your manifest AT PUBLISH TIME, so a workspace whose LIVE manifest was published before
path declarations existed carries no `mcpPaths` key at all — and the serving side hands
that vintage the four-path floor the older engine had, so an instance does not lose an
endpoint merely by moving its engine pin. It is dated on the manifest, not on who
published it. Publishing once from a clone of the current engine writes the key (`[]` if
you declare none) and ends it for your workspace: from then on the list is exactly what
you declared, and an endpoint you have not declared is a 403. If your prototypes call a
platform endpoint, put it in `paths` and publish — do not rely on the floor.

**Retired: `methodPages`.** It named `pages/<name>` entries for one group of the
Pages tab's front-office / method / back-office / upsell taxonomy. That taxonomy is
gone — the Pages tab is one flat grid, because the engine's contract is the TIER
(`base/ components/ patterns/ pages/`) and how a workspace subdivides a tier is the
workspace's own vocabulary. A `space.json` that still carries the key parses fine and
the key is simply not read; the same goes for `<meta name="gv-surface">` tags left in
page HTML. Nothing to migrate, nothing to remove.
