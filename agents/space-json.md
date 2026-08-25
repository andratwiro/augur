# space.json — the space's contract with the build

A directory is a space because it has a `space.json` at its root. This file is
the single source of truth for the schema; docs elsewhere should link here,
not restate it.

```jsonc
{
  "id": "my-space",          // REQUIRED. The space's identity everywhere: its URL
                             // prefix, its manifest in the store, its key in
                             // /_build.json (lowercase [a-z0-9-]). The repo name is
                             // a free label.
  "name": "My Space",        // display name in the switcher / landing
  "description": "…",        // one line for the site's link preview (the og:description
                             // a Notion/Slack unfurl shows). Read from the DEFAULT
                             // space only; empty ⇒ the engine's own tagline
  "default": true,           // the space that builds at the site ROOT. An instance
                             // serves exactly ONE space; the /<id>/ path mount for
                             // additional spaces is RETIRED and nothing routes to it
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
  "methodPages": ["…"],      // pages/<name> entries surfaced as method exemplars
  "pendingPages": ["…"],     // pages badged "pending" in the gallery — a roadmap
                             // badge, NOT absence; the pages may exist
  "designSystem": { "skill": "<dir>" },  // override the auto-detected UI skill
                             // (default: the dir under skills/ named <prefix>-ui
                             // containing <dirname>.css; every canonical asset name
                             // derives from that prefix). What the skill ships is
                             // the skill's own call: see ui-skill.md (skill.json)
  "ignore": ["big-exports"], // extra top-level dirs the build must never treat
                             // as project folders
  "mcpAllowlists": ["path/to/mcp-allowlist.json"],  // hosts this space's
                             // prototypes may reach through the /__mcp/ proxy
                             // (union across spaces at build time)
  "publishTracks": true,     // ship the space's tracks/ session music. Default false:
                             // music plays in local preview (`augur dev` / offline) and
                             // never leaves the machine. Published tracks are served to
                             // instance ADMINS only, never publicly — set this for audio
                             // you hold the right to put on someone else's server.
  "siteOrigin": "https://your-site.pages.dev"  // where this space publishes;
                             // lets login/publish work from a bare clone with
                             // no shell around
}
```

Only `id` is required. A design system is optional — plain self-contained HTML
builds fine. The parse lives in `build.js` (`discoverSpaces()`); if you add a
field there, document it here in the same commit.
