# Criteria — what a prototype must keep true

A prototype may carry **criteria**: short sentences its owner wrote about what it must keep
true, each backed by a check. They live on a page at `<prototype>/oracle/`, which is a
three-line loader for the engine's `/__oracle/oracle.js` (the way a canvas loads
`/__canvas/`), so every criteria page on every workspace is drawn by the same code.

## What is where

| | |
|---|---|
| The sentences, sign-offs, accepted and rejected visual changes | `/__board?path=/<opportunity>/<prototype>/oracle/` — edited on the page |
| What the checks last found | `/__board?path=/<opportunity>/<prototype>/oracle/results` — written by the runner |
| The checks | `<prototype>/oracle/checks/<ID>.mjs` in the prototype folder |
| The runner | not the engine: a command named `oracle` that a person installs and trusts on their own machine |

A criterion **holds** when its check passes, or, for one judged by eye, when the owner has
signed it off. A check counts only after it has been shown failing on a deliberate break.

## What it means for you, editing a prototype that has them

- Read `<prototype>/oracle/CRITERIA.md` (the page, mirrored) before you change anything.
- `augur land` asks the runner first, when this machine has one, and is refused while a
  criterion that held at the last landing fails. What was already failing when you arrived
  never blocks you; it is not yours unless you were asked.
- **Never edit `<prototype>/oracle/checks/`, `<prototype>/oracle/bindings.json` or `<prototype>/oracle/oracle.json`** to get past a
  refusal. A check you can rewrite is a check that passes. If what you were asked for
  conflicts with a criterion, say so to the person, plainly, and let them decide.
- A visible change the owner rejects on the page is one to undo.

## Adding the page to a prototype

The page is one file, `<prototype>/oracle/index.html`:

```html
<link rel="stylesheet" href="/__oracle/oracle.css" />
<script>window.ORACLE = { prototype: "Name of the prototype" };</script>
<div id="oracle"></div>
<script src="/__oracle/oracle.js" defer></script>
```

It lands with the prototype like any other file. An empty page offers `/` → Criterion.
