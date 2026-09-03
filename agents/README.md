# agents/ — engine docs for agents working in a workspace

These files are the engine's contract for the everyday things a **workspace
collaborator's agent** does with Augur: shipping work, reading review feedback,
what the engine expects of a prototype folder, the `space.json` schema, users
and avatars.

The word for the thing is **workspace** — one per instance, served at its root.
The FILE is still `space.json` and every identifier keeps its old spelling; see
[space-json.md](./space-json.md) for why that is a decision and not a leftover.

They ship WITH the engine so every instance gets the same, current contract —
when an engine change alters behavior, the same commit updates the doc here.
Workspace repos should link to these files (the engine clone sits next to every
workspace clone that publishes), never copy them: a copied contract drifts.

## Getting in

A workspace is a sign-in gate. Pages need a person's session; creating and publishing
prototypes needs a **publish token**, and an agent gets one by device pairing, never by
asking anyone for a password:

```
npx augur connect --origin https://<the workspace>
```

It prints one line to relay — *ask the owner of this workspace to open `<link>` and
enter `<code>`* — and waits. The owner opens the link in a browser they are already
signed in to and types the code; the token lands in `~/.config/augur/tokens.json`, and
`augur ship` / `augur publish` use it from then on. `publish` runs the pairing itself when
it finds no token, so inside a workspace tree nothing has to be done first. To get the
tree from a hostname, pair first, then `npx augur clone --space <id>` — it reads the
origin from the pairing.

Not on npm yet? The engine clone sits next to every workspace that publishes:
`node <engine>/scripts/cli.mjs connect --origin <origin>`. The instance says all of this
itself at `GET /llms.txt` (and as data at `/.well-known/augur.json`); a signed-out
request for an engine path answers `401` with the same facts.

Two things an agent never does: type a password into a terminal (`augur login` exists
for CI, and says so), and try the `pass` field from a deploy shell's `identity.json` —
that is a first-sign-in seed for a self-hosted instance, dead on a hosted workspace, and
the gate throttles failed attempts per address and per email.

Read them by trigger, not up front:

| When you are… | Read |
|---|---|
| asking what is current here, or what changed lately | [currency.md](./currency.md) |
| starting work on a prototype somebody else might also be in | [working-marks.md](./working-marks.md) — read it BEFORE the first edit |
| shipping / going live | [publishing.md](./publishing.md) |
| acting on review comments | [review-feedback.md](./review-feedback.md) |
| building a prototype folder | [prototype-contract.md](./prototype-contract.md) |
| naming a canonical screen, or asked to "pull screens X, Y, Z" | [canon.md](./canon.md) |
| editing `space.json` | [space-json.md](./space-json.md) |
| building or forking a design system (`skills/<x>-ui/`) | [ui-skill.md](./ui-skill.md) |
| asked to copy a design system out of a live product | [canon-extract.md](./canon-extract.md) |
| adding users / avatars / login questions | [identity.md](./identity.md) |
| a board-shaped ask (brainstorm, compare, map a flow) or canvas work | [canvas.md](./canvas.md) — includes WHEN to suggest a canvas |

Engine *development* (build.js, worker, overlays) is a different audience:
see [../CLAUDE.md](../CLAUDE.md) and [../CONTRIBUTING.md](../CONTRIBUTING.md).
