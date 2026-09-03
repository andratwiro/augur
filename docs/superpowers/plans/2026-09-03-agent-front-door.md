# Agent Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gated workspace tells any agent, in one sentence, that the key is `augur connect`, at every place an agent can arrive.

**Architecture:** One `doorFacts()` in `src/_worker.js` derives the facts from the tenant context; three surfaces render it (`/llms.txt`, `/.well-known/augur.json`, the machine 401), and the HTML gate points at the first. The CLI and the agents contract repeat the same words.

**Tech Stack:** Cloudflare worker (`src/_worker.js`), node CLI scripts, `node --test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-03-agent-front-door-design.md`.
- Zero product words, no person's name, no instance name in engine code, docs or tests (`npm run check` scans for them).
- A bare `Accept: */*` request keeps getting the HTML gate at 200 (`scripts/frontdoor-parity.mjs` depends on it).
- The door body never names a person, a token or a roster.
- The engine keeps reading the identity-file seed; the trap is fixed in the docs only.

---

### Task 1: The worker's door (facts, text, JSON, machine 401, gate pointer)

**Files:**
- Modify: `src/_worker.js` (helpers near `wantsJson` ~8485; routes next to `/robots.txt` ~11340; the four `loginPage(..., 200)` gate returns at ~11741, ~11749, ~11831; the HTML at ~6440; `__testables` ~11836)
- Test: `test/agent-front-door.test.mjs`

**Produces:** `doorFacts(tctx, url)`, `doorText(facts)`, `wantsMachineDoor(request, url)`, `gateResponse(tctx, request, url)`; routes `GET /llms.txt`, `GET /.well-known/augur.json`.

- [ ] **Step 1: Write the failing tests** — fixture copied from `test/device-pairing.test.mjs` (`instance()`, `memKV`, `freshIsolate`), requests via `worker.fetch`. Cases: llms.txt on/off, well-known shape, `/__api/state` → 401 JSON + `WWW-Authenticate`, `/` with `Accept: application/json` → 401, `/` with `*/*` → 200 HTML with comment + `Link` header, no email anywhere in the door bodies.
- [ ] **Step 2: Run** `node --test test/agent-front-door.test.mjs` → fails (llms.txt answers HTML).
- [ ] **Step 3: Implement.**

```js
// after wantsJson():
const DOOR_DOCS = "/llms.txt";
function doorFacts(tctx, url) {
  const def = tctx.SPACES.find((s) => s.default) || tctx.SPACES[0] || {};
  const pairing = tctx.DEVICE_PAIRING === true;
  return {
    product: "augur", workspace: def.id || tctx.tenantId || null, origin: url.origin,
    engine: tctx.INSTANCE_ENGINE_VERSION ? { version: tctx.INSTANCE_ENGINE_VERSION } : {},
    pairing: { enabled: pairing, start: "/__publish/_pair/start", approve: "/__connect" },
    connect: pairing ? `npx augur connect --origin ${url.origin}` : null,
    docs: DOOR_DOCS,
  };
}
function doorText(f) { /* the plain-text sentence, on/off variants */ }
function wantsMachineDoor(request, url) {
  if (url.pathname.startsWith("/__")) return true;
  return /application\/json/i.test(request.headers.get("Accept") || "");
}
function gateResponse(tctx, request, url) {
  if (wantsMachineDoor(request, url)) {
    return jsonResponse({ error: "sign-in-required", ...doorFacts(tctx, url) }, 401,
      { "WWW-Authenticate": 'Bearer realm="augur"', "Cache-Control": "no-store" });
  }
  const res = htmlResponse(loginPage(tctx, url.pathname + url.search, false, url.href), 200);
  res.headers.set("Link", `<${DOOR_DOCS}>; rel="help"`);
  return res;
}
// routes, beside /robots.txt:
if (url.pathname === DOOR_DOCS) return new Response(doorText(doorFacts(tctx, url)), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
if (url.pathname === "/.well-known/augur.json") return jsonResponse(doorFacts(tctx, url), 200, { "Cache-Control": "no-store" });
```
Replace the three `if (!authed) return htmlResponse(loginPage(tctx, url.pathname + url.search, false, url.href), 200);` and the final fallthrough with `return gateResponse(tctx, request, url);`. Add the comment line after `<!doctype html>` in `loginPage`. Export the helpers in `__testables`.
- [ ] **Step 4: Run** the new test and the whole suite: `node --test test/agent-front-door.test.mjs && npm test`.
- [ ] **Step 5: Commit** `feat(gate): the front door tells an agent how to get in`.

### Task 2: The CLI leads to the door

**Files:**
- Modify: `scripts/connect.mjs:60-67` (relay wording), `scripts/status.mjs:135-143` (no-token line), `scripts/login.mjs:27` (CI banner)
- Test: none new (these are console lines); `node scripts/status.mjs` from a workspace with no token shows the line.

- [ ] **Step 1:** connect prints `Ask the owner of this workspace to open <approveUrl> and enter <code>.` then `Send them that line as it is. …`.
- [ ] **Step 2:** status, when `!markToken`: print `not paired with <origin>. To publish from here: augur connect --origin <origin> …`.
- [ ] **Step 3:** login logs `for CI and scripts; people and agents run \`augur connect\` instead…` before asking.
- [ ] **Step 4:** run `node scripts/status.mjs` in `augur-space-fulla` with `HOME` pointed at an empty dir → line shows. Commit `cli: status, connect and login name the door`.

### Task 3: The contract opens with the door

**Files:**
- Modify: `agents/README.md` (new "Getting in" section above the trigger table), `agents/identity.md` (same section at top, plus the seed warning), `changelog.md` (one entry).

- [ ] **Step 1:** write the sections with the words from the spec §1 and the fallback from §2.
- [ ] **Step 2:** `npm run check` passes (doc-lint, word scan).
- [ ] **Step 3:** Commit `docs(agents): getting in`.

### Task 4: Ship and verify live

- [ ] Bump the shared deployment's engine pin and deploy it, then the spec's four curls against a live instance and `scripts/frontdoor-parity.mjs`.
- [ ] Add the plan item to the hosted plan and mark it done with a snapshot note; ship the plan page.
- [ ] The sandbox experiment: a fresh agent session with only the hostname.
