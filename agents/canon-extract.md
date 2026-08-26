# Extracting a design system from a live product

`augur canon` turns "copy the design system from this URL" into a flow: a working folder,
a fixed list of token roles, an evidence collector that runs where the login already is, a
grader that is arithmetic rather than taste, and an emitter that writes the result into the
workspace's design system.

**Augur does none of the deciding.** Which of a product's eleven greys is its hairline, and
which single colour means "act on this", is judgement. This engine ships the harness; the
user's own agent, on the user's own account with whatever provider they like, does the
judging. There is no model call in this repository, no API key, no endpoint, no inference
dependency, and `augur canon` added none — `../test/canon-no-inference.test.mjs` fails the
build on the commit that changes that.

## Why a URL and not a repository

Extracting a design system from a codebase is a solved problem and it is the wrong door for
the person who needs this one. The people who feel the cost of not having a canon are
product managers and designers: they hold a **login** to the product, not commit rights to
it. So the collector runs inside the browser they are already signed in to, sees the real
screens behind the login, and makes no request of its own.

## The flow

```
augur canon start <url>     the working folder, the brief, the skeleton answer
augur canon snippet         the collector to paste into your own browser
augur canon collect <url>   or: read a PUBLIC page over HTTP
augur canon collect --merge fold several screens into one observation
augur canon check           grade the answer
augur canon apply           write it into the workspace's design system
```

`start` writes a `BRIEF.md` into the folder that names the actual URL, prefix and
workspace, with the role table inline. **That file is written for an agent to follow start
to finish**; hand it over rather than paraphrasing it.

## The three files

| File | What it is | Who writes it |
| --- | --- | --- |
| `observation.json` | evidence: ranked colours, type sizes, gaps, radii, shadows, the product's own custom properties, candidate class families | the collector |
| `canon.json` | the answer: a value for each token role, plus named components | **the user's agent** |
| the skill folder | `<prefix>-tokens.css`, `<prefix>-canon.css`, `skill.json`, `registry.json`, `CANON.md` | `apply` |

The observation is ranked by how much of the screen a value actually covers, not by how
many times it appears in a stylesheet — which is why the browser door is the better
evidence as well as the only one that gets past a login. Text colour is weighted by the ink
it puts on the page rather than by the box, so a full-height container inheriting a colour
it never paints does not outrank the body.

## One format, not two

The roles in `../src/canon/schema.mjs` are exactly the tokens a workspace is born with (see
`../seed/README.md`). That is enforced: `../test/canon-schema.test.mjs` fails if the seed
grows a token the schema does not name, or reads one the extractor would not emit.

It buys three things, and they are the reason the list is fixed rather than discovered per
product:

- **The screens a workspace already has re-skin instead of breaking.** Every prototype
  links `<prefix>-tokens.css`; replacing the values moves all of them at once.
- **The page that teaches the design system keeps teaching it.** `set-up-your-design-system`
  reads the token file live, so after an extraction it shows the team their own product.
- **A prototype written against one design system works against another.** Pulling a screen
  from an example workspace into a real one is a copy, not a port.

Roles marked *computed* may be left out; they are derived from the ones that were observed,
and derived to be legible — a `mark-ink` computed from `mark` is guaranteed to clear 4.5:1
as text on the sheet, which a colour picked by eye frequently does not. A value the roles
have no slot for goes under an `x-` name and emits as a real token.

## What `apply` will and will not do

- **Regenerates** `<prefix>-tokens.css`. Safe because the roles are fixed.
- **Creates** `<prefix>-canon.css` with the extracted components. Its own file.
- **Never touches** the workspace's own component stylesheet (`<prefix>-ui.css`). That is
  the workspace's writing, not the extractor's.
- **Refuses** a class name the workspace already defines. Two rules for one selector in two
  files is a bug that shows up on one screen and nowhere else.
- **Merges** `registry.json` by name, keeping the workspace's own labels and descriptions.
- Emits under the **workspace's** prefix even when the canon calls itself something else —
  renaming a workspace's tokens orphans every prototype that reads them.

## What the grader enforces

Arithmetic only, and each rule exists because the failure it catches is invisible in a diff:

- every observed role answered, every value the right kind;
- the type scale and the space ramp climb;
- body text clears 4.5:1 on the sheet, and so does the mark used as text;
- **no component hard-codes a colour** — a component that does stops moving when a token
  changes, and then the design system is decoration;
- every `var()` a component reads is a token the canon defines;
- every class carries the skill's class prefix, and the CSS defines every class it lists.

`augur canon check --space <workspace>` grades the design system a workspace is actually
carrying, read back off disk. A workspace that has never been near the extractor should
pass it.

## Where it stops

- The collector sees **rendered** values, so a colour that only exists in a state nobody
  triggered — an error toast, a disabled row — is not in the evidence. Collect the screens
  that matter, including the ugly ones.
- It reads no images. A logo, an illustration style and a photographic treatment are design
  system and none of them are in here.
- Dark mode is a second canon, not a second column: collect it separately.
- A cross-origin stylesheet cannot be read for custom properties. Computed styles still
  count, and the observation says how many sheets were unreadable.
