# agents/ — engine docs for agents working in a space

These files are the engine's contract for the everyday things a **space
collaborator's agent** does with Augur: shipping work, reading review feedback,
what the engine expects of a prototype folder, the `space.json` schema, users
and avatars.

They ship WITH the engine so every instance gets the same, current contract —
when an engine change alters behavior, the same commit updates the doc here.
Space repos should link to these files (the engine clone sits next to every
space clone that publishes), never copy them: a copied contract drifts.

Read them by trigger, not up front:

| When you are… | Read |
|---|---|
| shipping / going live | [publishing.md](./publishing.md) |
| acting on review comments | [review-feedback.md](./review-feedback.md) |
| building a prototype folder | [prototype-contract.md](./prototype-contract.md) |
| editing `space.json` | [space-json.md](./space-json.md) |
| building or forking a design system (`skills/<x>-ui/`) | [ui-skill.md](./ui-skill.md) |
| adding users / avatars / login questions | [identity.md](./identity.md) |
| a board-shaped ask (brainstorm, compare, map a flow) or canvas work | [canvas.md](./canvas.md) — includes WHEN to suggest a canvas |

Engine *development* (build.js, worker, overlays) is a different audience:
see [../CLAUDE.md](../CLAUDE.md) and [../CONTRIBUTING.md](../CONTRIBUTING.md).
