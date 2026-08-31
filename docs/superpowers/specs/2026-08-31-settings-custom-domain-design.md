# Settings shows the claimed platform subdomain

**Status:** design, approved 2026-08-31
**Touches:** `src/_worker.js` (new admin API route), `build.js` (Settings panel HTML + JS)

## Problem

`B-claim-platform-subdomain` shipped a real mechanism (28 Aug): an operator can give a
workspace a second, chosen hostname on `augur.page` — `demo.augur.page` for the public
demo — and the workspace's own object remembers it as `canonical_host` in its meta. But
the mechanism was built deliberately as "a mechanism, not a UI." The Admin → Settings
"Custom URL" field (`build.js:5822-5827`) is static: it always reads *"Not available
yet. This workspace is served at `<built-in address>`."*, populated only by
`location.host` (`build.js:5521`) — it never asks whether this workspace has actually
been claimed. A workspace that has been claimed (demo/Fulla) and one that has not
(Delta, until we run the claim) render identically in Settings today.

## Goals

- The Settings panel shows the real claimed hostname when one exists.
- Zero new store reads beyond what the front door already does every request: the
  claimed hostname is read via the same `readSuspension()` call (`_worker.js:7769`) the
  redirect logic already uses to find `canonicalHost` — same isolate-level TTL cache
  (`SUSPENSION_STATE`, `SUSPENSION_TTL_MS`), no KV scan, no new store shape.
- Follows the existing Settings-panel convention exactly: a small `/__admin/*` JSON
  route (matching `adminStorageApi`/`adminVersionApi`, `_worker.js:5682,5786`) plus a
  client-side fetch in the same script block that already fills Storage/Engine/Origin
  (`build.js:5486-5522`).
- Unclaimed state is untouched, byte-for-byte — confirmed with you already.

## Non-goals

- Real custom domains (`B-custom-hostname-alias`) — that item isn't built yet. This
  spec only ever reads/renders a platform subdomain (`<label>.augur.page`). The field
  gets reused for real domains later; nothing here assumes or half-builds that.
- Any self-service claim/request affordance. The field stays read-only — claiming
  stays operator-only, unchanged, per the plan's explicit decision that "self-service
  claiming stays impossible."
- Showing the original generated address alongside the claimed one. Constructing it
  client-side would need the platform-suffix template threaded to the browser for no
  real benefit — the claimed hostname alone is the useful fact. (The generated address
  still works and still redirects; that's server-side behavior already shipped, not
  something this Settings field needs to explain.)
- Any change to the claim mechanism itself, `readSuspension`, or the front-door
  redirect. This only reads what already exists.

## Design

**Backend — `GET /__admin/custom-domain`** (new route, wired beside `/__admin/storage`
and `/__admin/version` in the dispatch table, `_worker.js:10720-10726`):

```js
async function adminCustomDomainApi(tctx, env, me) {
  if (!me || me.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  const doc = await readSuspension(tctx.tenantId, env);
  const hostname = (doc && doc.canonicalHost) || null;
  return jsonResponse({ claimed: !!hostname, hostname });
}
```

Same admin-only gate as `adminVersionApi`/`adminStorageApi`. `readSuspension` already
returns `null` for a single-workspace (self-hosted, no `TENANTS` binding) deployment —
that answers `{claimed: false, hostname: null}` for free, matching the unclaimed copy.

**Frontend — `build.js`:**

- HTML (`build.js:5826-5827`): add `data-set-url-note` to the `<p>` alongside its
  existing `id="auset-url-note"` (kept for `aria-describedby`) — a hook for the script,
  matching every other dynamic field's `data-set-*` convention on this page.
- Script (new block beside the `data-set-origin` fill, `build.js:5521-5522`):

```js
var uEl = document.querySelector('[data-set-url]');
var uNote = document.querySelector('[data-set-url-note]');
fetch('/__admin/custom-domain', {headers:{'Accept':'application/json'}}).then(function(r){
  return r.ok ? r.json() : null;
}).then(function(d){
  if(d && d.claimed && d.hostname && uEl){
    uEl.value = d.hostname;
    if(uNote) uNote.textContent = "This workspace's custom address.";
  }
}).catch(function(){});
```

Unclaimed or fetch failure: no-op, field renders exactly as it does today (input stays
empty, note stays the existing static copy) — same "a closed door reads as no door"
posture `adminStorageApi`'s `Unavailable.` fallback already uses on this same page.

## Testing

Worker-level: a test hitting `/__admin/custom-domain` for a tenant whose object has
`canonical_host` set (asserts `{claimed:true, hostname}`) and one that doesn't (asserts
`{claimed:false, hostname:null}`), alongside the existing admin-route test suite.

Driven: `npm run offline` against a tenant-bound config, confirm the Settings panel
renders the static copy pre-claim, then (after Task 2's claim runs against
demo/Fulla and Delta) confirm production Settings on both shows the real hostname in
the input and the updated note.
