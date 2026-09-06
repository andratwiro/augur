# Drafts That Land — Slice 5 (Derived Pages and Retirement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing a visitor sees on a workspace that serves drafts is built on a client machine any more: the galleries, the library tiers and the search index render at serve time from the live store, so a landing appears at once; every folder a person edits is a unit (a new prototype, a library demo, the design system); and the client publish path is retired where drafts are served.

**Architecture:** One pure module, `src/galleries.mjs`, turns a live manifest plus the overlays the worker already holds (statuses, the roster, the design-system catalog) into a site model and renders the same card markup the build used to bake, inside the same chrome shell. The worker serves those pages instead of the stored copies wherever drafts are served, caching the two store reads a render needs per manifest version. Unit creation widens from prototypes to the four library tiers and the declared design-system skill folder, and `?ds=<draft>` swaps design-system files in from a draft for the whole site. `augur ship`, working marks, the ship lock and the machine-wide publish cache go; `augur publish` refuses content where drafts are served and stays for the rest.

**Tech Stack:** Plain Node, `node:test`, the existing worker fixtures (`test/fixtures/unit-env.mjs`).

## Decisions this slice makes (the spec left them open)

- **The design system is one unit: the space's declared skill folder** (`/skills/<prefix>-ui/`, what `PUBLIC_SKILL_PREFIXES` names). It is a single prefix, every prototype references it by absolute path, and the four gallery tiers are *generated* from it. `?ds=<draft-id>` therefore means: resolve any path under the skill prefix from that draft's table. The tier index pages (`/tokens/`, `/base/`, …) are derived, never units.
- **Library demos are units** (`/base|components|patterns|pages/<name>/`). A landing replaces one demo folder; the tier's index is a sibling file the derived renderer owns, so nothing a landing can carry shadows it.
- **What stays built.** `/tokens/` and `/primitives/` come from the skill's composition graph and its `gallery.html`; the space's `augur:generate` produces those at land of the design-system unit (spec §8). Until a space declares one, the worker serves whatever those paths hold. The changelog is engine chrome. Posters (`preview.webp`) are whatever the unit holds; the reshoot job is a later addition.
- **What the build keeps.** `build.js` still composes a space for `augur dev`, the offline preview and the seed pack. What goes is *publishing* a built tree from a client where drafts are served.
- **`augur publish` is not deleted.** It refuses content publishes where drafts are served (same door as `ship`) and stays for `_engine`, for `restore`/`migrate`, and for instances without a unit store. The commit endpoint stays; `forkOnConflict` stays for the same callers.

## Global Constraints

- Spec §5, §6.3, §6.4, §8, §10. **Zero product words**; `npm run check` green. Plain Node.
- **Where drafts are not served, nothing changes** — every derived page and every refusal is gated on `draftsServedHere(env)` / `draftsServed(origin)`.
- **The card contract is the chrome's.** Class names and `data-*` attributes the chrome bundle scripts read (`.card-opp`, `.card-proto`, `.preview`, `.preview-link`, `.status-chip[data-status-key]`, `.proto-when`, `[data-currency]`, `[data-rename-key]`, `[data-pin-key]`, `[data-fitem][data-fkey]`, `[data-person]`, `[data-del-path]`, `[data-new-canvas]`, `[data-filter-empty]`) are kept exactly.
- **Derived pages are gated like the stored ones were** (members only); a derived page is never public.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `npm test` before every commit; `npm run check` before the last commit of each task.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/galleries.mjs` (new) | `siteModel`, `renderRootIndex`, `renderOpportunityIndex`, `renderPlaygroundIndex`, `renderTierIndex`, `renderComponentsIndex`, `searchIndex`, `derivedPathKind`. Pure. |
| `src/_worker.js` (modify) | `derivedPage(tctx, env, url)` before `assetFetch` in the authed branch; the two cached store reads; `?ds=` cookie + overlay in `assetFetch`; unit-creation rules; status writes bust the cache. |
| `scripts/open.mjs`, `scripts/lib/draft.mjs` (modify) | `--new`; refuse an unknown unit without it. |
| `scripts/publish.mjs` (modify) | The drafts refusal (content only). |
| Removed: `scripts/ship.mjs`, `scripts/mark.mjs`, `scripts/lib/marks.mjs`, the marks API/route/store family, `MARKS_JS` + `.mark-badge` CSS, `agents/working-marks.md`, the publish cache and ship lock in `scripts/lib/`. `cli.mjs`: `ship` prints where it went, exits 1. |
| `test/galleries.test.mjs`, `test/derived-serve.test.mjs`, `test/ds-overlay.test.mjs` (new); `test/unit-api.test.mjs`, `test/draft-cli.test.mjs`, `test/ship-drafts-refusal.test.mjs` → `test/publish-drafts-refusal.test.mjs` (modify) | Model and markup; serving prefers derived where drafts are served; the overlay; unit rules; `--new`; the refusals; nothing left references marks. |

---

### Task 1: The site model and the renderers (`src/galleries.mjs`)

- `siteModel({ manifest, statuses, baseline, people, now }) → { opportunities, playground, tiers, hasPlayground, units }`. Units come from `authoredUnits(manifest)`; a unit's home decides which list it joins (`/playground/<n>/`, `/<tier>/<n>/`, `/<opp>/<n>/`). Per unit: `name`, `href` (the unit path), `file` (`index.html` if the table holds it, else the first `.html`), `poster` (`<unit>preview.webp` present), `editedAt`/`mtimeMs` (`unitProvenance`), `status` (overlay, then baseline, else null / `in-progress` for playground), `editors` (distinct `by` ids in the unit's files, resolved through `people(id)`), `desc` null.
- `renderRootIndex(model, ctx)`, `renderOpportunityIndex(model, opp, ctx)`, `renderPlaygroundIndex(model, ctx)`, `renderTierIndex(model, tier, ctx)`, `renderComponentsIndex(model, catalog, ctx)`, `searchIndex(model, ctx)`; `ctx = { spaces, activeSpace, chrome: {css, js}, projectsLabel }`. The shell is `renderAppChrome` between the chrome markers plus the same head the build emits, minus the companion addon.
- `derivedPathKind(pathname, model) → { kind: "root"|"opportunity"|"playground"|"tier"|"components"|"search", name? } | null`.
- Tests: a manifest with two opportunities, a playground unit, a base demo and a component; assert grouping, ordering (status then recency), the card attributes above, faces from `by`, the folder count, the empty states, the search entries, and `derivedPathKind` for each path plus `/checkout` (redirect case is the worker's).

### Task 2: The worker serves derived pages where drafts are served

- `derivedPage(tctx, env, url)`: only when `draftsServedHere(env)`; kind from the live manifest's model; reads `statuses` (overlay), the baseline `prototype-status.json` and `registry.json` blobs (cached per manifest version in a `tenantCache("derived")`), renders, answers `text/html; no-cache` (or JSON for search). `/<opp>` without a slash → 308 to `/<opp>/` when it is an opportunity.
- In the authed branch: `const derived = await derivedPage(tctx, env, url); if (derived) return serveContent(tctx, derived, url, me, env);`.
- `statusApi` POST busts the derived cache for the workspace (the baseline is cached; the overlay is read fresh).
- Tests over the unit fixture (`W.derivedPage` with a bundle-mode env holding `UNITS`): the root lists folders derived from units, a landing of a NEW unit shows on the next render with no publish, the stored `/index.html` is ignored where drafts are served and served where they are not, `/__search.json` is derived.

### Task 3: Every folder a person edits is a unit, and `open --new`

- Worker: `isNewUnitPath` accepts `/<tier>/<name>/` for the four demo tiers; `isReservedUnitFolder` keeps `_*`, `__*`, `fonts`, `tokens`, `primitives`, `admin`, `changelog`, `search`, `tracks`, `skills`; **exception:** a unit equal to one of `tctx.PUBLIC_SKILL_PREFIXES` (the declared design system) may be opened.
- CLI: `augur open --new <unit>` — without `--new`, an answer with an empty table is refused: *"<unit> does not exist here; `augur open --new <unit>` creates it"*; with it, an existing unit is refused: *"exists already; open it without --new"*. `doOpen` gains `{ isNew }` in its answer.
- Tests: unit-api (tiers openable, `/tokens/x/` refused, the skill prefix openable, `/skills/other/` refused); draft-lib (`--new` semantics); the browser drill gains "a new unit landed appears in the derived root".

### Task 4: `?ds=<draft>` — a design-system draft across the site

- `assetFetch(tenantId, env, request, { dsDraft })`: for a path under a skill prefix, when `dsDraft` is set, resolve the file from that draft's table first (the unit is the skill prefix). The request handler reads `?ds=` (sets the `augur_ds` cookie, `Path=/`, `SameSite=Lax`, session) or the cookie; `?ds=` empty clears it. Members only — the cookie is ignored for a signed-out request.
- Tests: a draft on the skill unit changes `tokens.css` for a prototype page requested with the cookie, not without; `?ds=` sets the cookie; `?ds=` empty clears it.

### Task 5: Retirement

- Delete `scripts/ship.mjs`, `scripts/mark.mjs`, `scripts/lib/marks.mjs`, `agents/working-marks.md`; `cli.mjs` answers `ship` and `mark` with one sentence each and exit 1. Remove the `_marks` branch, `/__marks`, `readMarks`/`writeMark`/`clearMark`/`sweepExpired`, the `marks` overlay family and its inventory entry, `MARKS_JS`, `.mark-badge` CSS, the marks lines in `status.mjs` and `open.mjs` (`markPathFor` → a local helper), and the `publish cache` / ship lock helpers in `scripts/lib/` (find them: `grep -rn "publish-cache\|ship.lock\|\.augur-publish" scripts/`). `publish.mjs` refuses a content publish where `draftsServed(origin)` with the open/land words; `--engine` and `_engine` untouched.
- Docs: `agents/README.md` table row for marks goes; `publishing.md` says publish refuses there; `docs/drafts-that-land.md` §10 steps 4–5 marked done in the base text (a snapshot, not a diary).
- Tests: the front-door, chrome-drafts and dist baselines; `test/marks.test.mjs` deleted; a grep test that no source names `augur ship` or `augur mark` outside docs history.

## Manual verify (hosted, after the pin bump)

1. `augur open --new demo/hello-world`, write an `index.html`, `augur land`: the folder card and the prototype card appear on the gallery within one reload, no publish.
2. `augur open skills/starter-ui`, change a token, `augur save`; open any prototype with `?ds=<id>`: the change shows; drop the query, it does not; `augur land`: it shows everywhere.
3. `augur ship` and `augur mark`: one sentence each. `augur publish` from a clone: refused with the open/land words.
