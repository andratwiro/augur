# Drafts That Land — Slice 4 (Contracts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place an agent learns what to do — the machine front door, the engine's agent contracts, the scaffold, the seeded pages and the CLI's own words — says *open, edit, land* on an instance that serves drafts, and `augur ship` there refuses with those instructions instead of shipping a whole tree.

**Architecture:** One fact decides everything: does this instance serve drafts (a `UNITS` binding beside a bundle store). The worker knows it and publishes it in the well-known file and `/llms.txt` as a `drafts` block; the CLI reads that public file (`draftsServed(origin)`) before `ship` touches anything. Where the fact is false — every self-hosted instance today — nothing changes, not one word. The contract for agents is a new `agents/drafts.md`, and the existing contracts point at it rather than being rewritten around it.

**Tech Stack:** Plain Node, `node:test`, the existing front-door test harness (`test/agent-front-door.test.mjs`).

## Global Constraints

- Spec: `docs/drafts-that-land.md` §4, §7, §10 (steps 2 and 3). Slices 1–3 plans establish the files.
- **Zero product words** — `npm run check` (word scan, foreign-vocabulary scan, `doc-lint` for links and paths in `agents/` and root docs).
- **Nothing changes for an instance that does not serve drafts.** The front door's text, `ship`, the CLI's hints: byte-for-byte what they were, unless `drafts.enabled` is true.
- **`ship` refuses, it does not silently redirect.** On a drafts instance it prints the open/land instructions and exits 1 before committing anything; `--legacy` runs the old path for one release, and says so.
- **Plain language in contracts**: lead with what the agent does and sees, not with the object model.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `npm test` before every commit; `npm run check` before the last commit of each task.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/_worker.js` (modify) | `draftsServedHere(env)`; `doorFacts(tctx, url, env)` gains `drafts: {enabled, open, land, docs}`; `doorText` gains the drafts paragraph; `gateResponse` and the two door routes pass `env`. |
| `scripts/lib/draft.mjs` (modify) | `draftsServed(origin, {timeoutMs}) → Promise<boolean>` from the well-known file; false on any failure. |
| `scripts/ship.mjs` (modify) | The refusal before the first side effect; `--legacy`. |
| `agents/drafts.md` (new) | The agent's contract for drafts that land. |
| `agents/README.md`, `agents/publishing.md`, `agents/working-marks.md` (modify) | Point at it; say when each applies. |
| `scripts/init.mjs`, `README.md`, the two seeded pages (modify) | Say open/land beside ship. |
| `test/agent-front-door.test.mjs`, `test/ship-drafts-refusal.test.mjs` (modify/new) | The door carries the fact; ship refuses on it and only on it. |

---

### Task 1: The front door says open and land where drafts are served

- [ ] **Test** (append to `test/agent-front-door.test.mjs`; `instance()` gains `{drafts}` which adds `BUNDLES: {}` and a `UNITS` stub `{ idFromName: (n) => n, get: () => ({ fetch: async () => new Response("{}") }) }` to the env):

```js
test("where drafts are served, the door says open and land, in text, as data and on the 401", async () => {
  const { env } = instance({ drafts: true });
  const t = await get(env, "/llms.txt");
  assert.match(t.body, /augur open <opportunity>\/<prototype>/);
  assert.match(t.body, /augur land/);
  assert.match(t.body, /augur ship.*retired here|not the way here/i);
  const j = await get(env, "/.well-known/augur.json");
  assert.deepEqual(j.json.drafts, { enabled: true, open: "augur open <opportunity>/<prototype>", land: "augur land", docs: "/llms.txt" });
  const r = await get(env, "/__me", { Accept: "application/json" });
  assert.equal(r.status, 401);
  assert.equal(r.json.drafts.enabled, true);
});

test("where drafts are not served, the door says so as data and says nothing about them in text", async () => {
  const { env } = instance();
  const j = await get(env, "/.well-known/augur.json");
  assert.deepEqual(j.json.drafts, { enabled: false });
  const t = await get(env, "/llms.txt");
  assert.doesNotMatch(t.body, /augur land|augur open/);
});
```

- [ ] **Implementation** in `src/_worker.js`:

```js
/** Does this deployment serve drafts — a unit store beside a bundle store. The same two checks `unitApi` makes. */
const draftsServedHere = (env) => !!(env && env.BUNDLES && unitNamespace(env));
```

`doorFacts(tctx, url, env)` adds:

```js
    drafts: draftsServedHere(env)
      ? { enabled: true, open: "augur open <opportunity>/<prototype>", land: "augur land", docs: DOOR_DOCS }
      : { enabled: false },
```

`doorText(f)` — after the pairing `body`, before `tail`, insert:

```js
  const drafts = f.drafts && f.drafts.enabled
    ? `This workspace serves DRAFTS. To change a prototype, do not ship a tree — open it:\n\n`
      + `  ${f.drafts.open}     # a folder of its own, live at once at its draft address\n`
      + `  …edit; every save is live there before your next step…\n`
      + `  ${f.drafts.land}                          # the real URL moves; the last line printed is the live URL\n\n`
      + `Two sessions on one prototype are both told and both work; if the second landing is\n`
      + `refused, \`augur sync\` folds main into the draft and \`augur land\` again. \`augur ship\`\n`
      + `is retired here and says so. The contract: agents/drafts.md in the engine clone.\n\n`
    : "";
  return head + body + drafts + tail;
```

`gateResponse(tctx, request, url, env)` passes `env` to `doorFacts`; its three call sites in the request handler add `, env`; the `/llms.txt` and `/.well-known/augur.json` routes pass `env` too.

- [ ] Run `node --test test/agent-front-door.test.mjs test/frontdoor-parity.test.mjs`; commit — `gate: the front door says open and land where drafts are served`.

---

### Task 2: `ship` refuses on a drafts instance, with the instructions

- [ ] **Test** `test/ship-drafts-refusal.test.mjs`: start a tiny `http` server answering `/.well-known/augur.json` with `{drafts: {enabled: true, …}}` (and one answering `{drafts: {enabled: false}}`); make a temp space folder with `space.json` `{id: "alpha", siteOrigin: <origin>}` and one prototype file, no git; spawn `scripts/ship.mjs --dry-run` in it (async spawn — the server lives in the test process). Expect: drafts on → exit 1, stderr names `augur open alpha`?? — no: `augur open <opportunity>/<prototype>` and `augur land`, and does NOT contain "publish"; with `--legacy` → the refusal is absent (ship proceeds to whatever the dry run says next); drafts off → the refusal is absent. Also `draftsServed("http://127.0.0.1:1")` resolves false quickly.

- [ ] **Implementation.** `scripts/lib/draft.mjs`:

```js
/** Does the instance at `origin` serve drafts? Read from its public well-known file; false on any failure. */
export async function draftsServed(origin, { timeoutMs = 2500 } = {}) {
  if (!origin) return false;
  try {
    const r = await fetch(`${String(origin).replace(/\/+$/, "")}/.well-known/augur.json`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.drafts && j.drafts.enabled === true);
  } catch (e) { return false; }
}
```

`scripts/ship.mjs`, right after `const SPACE = idOf(dir);` and before any git call:

```js
// ── drafts that land: where the instance serves drafts, ship is not the way ─
// One fact, read from the instance's public well-known file: does it serve drafts? Where
// it does, a prototype is changed by opening it, editing and landing — a whole tree is no
// longer what goes live, and shipping one here would put every session's half-done work
// on the site at once. Where it does not (every self-hosted instance today) nothing here
// changes. `--legacy` runs the old path for one release, and says so.
const LEGACY = flag("--legacy");
{
  let origin = process.env.AUGUR_ORIGIN || "";
  try { origin = origin || JSON.parse(readFileSync(path.join(dir, "space.json"), "utf8")).siteOrigin || ""; } catch (e) { /* no origin known: nothing to ask */ }
  if (origin && await draftsServed(origin)) {
    if (LEGACY) warn("this workspace serves drafts; shipping a whole tree here is the legacy path and goes away next release.");
    else {
      console.error(`\x1b[31m[ship]\x1b[0m ${origin} serves drafts, so a prototype is changed by opening it, not by shipping a tree:\n\n` +
        `  augur open <opportunity>/<prototype>     # a folder of its own, live at once at its draft address\n` +
        `  …edit; every save is live there…\n` +
        `  augur land                               # the real URL moves; the last line printed is the live URL\n\n` +
        `If the landing is refused because main moved: augur sync, then augur land again.\n` +
        `Read agents/drafts.md in the engine clone. \`augur ship --legacy\` runs the old path for one release.`);
      process.exit(1);
    }
  }
}
```

with `import { draftsServed } from "./lib/draft.mjs";`. Add `--legacy` to the header comment.

- [ ] Run `node --test test/ship-drafts-refusal.test.mjs test/ship-exit-code.test.mjs test/repo-less-ship.test.mjs`; commit — `cli: ship refuses where drafts are served and says what to do instead`.

---

### Task 3: The contracts say open and land

- [ ] `agents/drafts.md` (new) — the whole of the agent's day in plain words: what a draft is (your own live copy at its own address), the four commands (`open`, edit, `land`, `sync` when refused), `read`, `close`, `status`, what the hooks do for you and what they refuse, two sessions on one prototype, what "done" means (the URL `land` prints), when this applies (the instance says `drafts.enabled` at `/.well-known/augur.json`; otherwise `publishing.md`), and a short table of refusals → what to do. No object model, no server vocabulary.
- [ ] `agents/README.md`: in "Getting in", after the sentence about `augur ship` / `augur publish` using the token, add: *"On a workspace that serves drafts (`/.well-known/augur.json` says `drafts.enabled`), the everyday verbs are `augur open` and `augur land` instead — see [drafts.md](./drafts.md)."* In the trigger table, the "shipping / going live" row becomes two rows: *"changing a prototype on a workspace that serves drafts"* → drafts.md; *"shipping / going live (a workspace without drafts)"* → publishing.md.
- [ ] `agents/publishing.md`: a first paragraph under the title: *"**Where the workspace serves drafts, this is the legacy path** — `augur ship` refuses there and points at `augur open` / `augur land`; read [drafts.md](./drafts.md). Everything below is for a workspace that does not serve drafts yet."*
- [ ] `agents/working-marks.md`: after the first paragraph: *"Where the workspace serves drafts, a draft IS the mark: `augur open` tells you who else has the prototype open and shows you on their chips, with nothing to leave and nothing to expire — see [drafts.md](./drafts.md). Marks stay for workspaces without drafts."*
- [ ] `scripts/init.mjs`: the scaffold paragraph becomes *"When it works, ship it: on a workspace that serves drafts, `augur open <project>/<name>` then `augur land`; otherwise `augur ship`. Either way you get the live URL."* and the final log line: ``next: edit the prototype, then `augur land` (drafts) or `augur ship`.``
- [ ] `README.md` line 127: *"**Publishing is `augur land`** on a hosted workspace — open one prototype, edit, land; seconds, atomic, with history. Self-hosted instances without a unit store publish with `augur publish`."*
- [ ] Seeded pages: `set-up-your-design-system` Command specimen → `augur land`; slide-deck slide 05 → title "Shipping is one word", text *"Open the prototype, edit, land. Every edit is live at your own draft address as you go; landing moves the real URL and keeps the history. Seconds, not a deploy."* with the command `augur land`.
- [ ] `npm run check` (doc-lint resolves the new links); `npm test`; commit — `Contracts: drafts that land — agents/drafts.md, and every door says open and land`.

## Manual verify

1. `curl https://<drafts instance>/llms.txt` shows the drafts paragraph; `curl https://<self-hosted instance>/llms.txt` is unchanged.
2. In a space clone whose `siteOrigin` is a drafts instance: `augur ship` exits 1 with the instructions and touches nothing (`git status` unchanged); `augur ship --legacy --dry-run` proceeds with a warning.
3. Ask a fresh agent in that clone to "change the checkout prototype": it reads `/llms.txt` or `agents/README.md`, runs `augur open`, edits, lands, and hands back the URL `land` printed.
