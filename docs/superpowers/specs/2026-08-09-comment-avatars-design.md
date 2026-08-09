# Faces on comments

**Status:** design, approved 2026-08-09
**Touches:** `src/review/comments.js`, `src/_worker.js`
**Reference:** Figma's three comment states (normal pin → hover card → open thread)

## Problem

`docs`-adjacent `src/review/COMMENTING-UX.md` locked a v1 decision in its §7:

> **Avatars / identity — DECIDED: none.** No users, no avatars.

That was true when it was written. It is not true now. The engine has an invite-only
identity layer, an admin people table, per-person `name` / `initials` / `color` /
`avatar`, and a stable ungated `/__avatar/<key>` route (`_worker.js:428–441`). The
overlay already fetches `/__me` and adopts the signed-in name as the comment author
(`comments.js:216–226`).

So every comment left by a known person already knows *who* wrote it — and renders as
an anonymous blue numbered disc anyway. Three surfaces show a name where the reference
shows a face: the pin, the hover preview card, and the open thread.

The numbered pin is not the problem. It is the correct rendering for a comment from
someone the instance does not know, and it stays exactly as it is. The gap is that a
person with an account has no way to appear as themselves.

## Goals

- A comment from a signed-in person renders as their photo — on the pin, in the hover
  card, on each message in the thread, and beside the reply field.
- A person with an account but no photo renders as their initials in their assigned
  colour, never as a generic silhouette.
- A comment with no account behind it renders exactly as it does today: a numbered
  blue pin. No regression, no new visual species.
- Changing a photo or a name in the admin panel updates every past comment by that
  person, with no migration and no stale faces.
- Comments written before this change still resolve to the right face.
- No email address is exposed to any client, and the team roster cannot be enumerated
  from a public prototype URL.

## Non-goals

- The cat annotation pin (`.pin.anno`) is untouched — it is a different affordance with
  its own semantics, and it already carries an image.
- Emoji, `@mentions`, and image attachments stay deferred (COMMENTING-UX §7).
- No change to how threads are anchored, moved, resolved, or deleted.
- No dark-mode variant. White chrome only, as already decided.

## Design

### Identity is stamped by the server, never sent by the client

`sanitizeMsg` already rewrites the author of every added or replied message from the
session (`_worker.js:1983–1990`), via `stampAuthor` (`:1976`):

```js
function stampAuthor(rawAuthor, me) {
  if (me) return { author: me.name, verified: true };
  const a = clamp(rawAuthor, 80) || "Anonymous";
  const collides = USERS.some((u) => u.name && u.name === a);
  return { author: collides ? "Anonymous" : a, verified: false };
}
```

Two properties fall out of this that the design leans on:

1. A signed-in author is already recorded with `verified: true`. The overlay simply
   never reads the field.
2. An un-authed POST *cannot* wear a team member's name — the collision is renamed to
   "Anonymous". So `verified: true` plus a name is already a trustworthy identity claim.

The change is one field in `sanitizeMsg`:

```js
by: me ? personId(me.email) : null,
```

The client sends nothing and can forge nothing. This is strictly better than having the
overlay attach its own `/__me` identity to the request, and it needs no new trust rules.

### `personId` — a hash, not an address

```js
// Stable per address and independent of the avatar, so a new photo does not orphan
// past comments. Distinct from avatarKey(), which deliberately hashes email + photo
// length so a changed photo yields a new immutable-cacheable URL.
function personId(email) {
  const s = String(email).trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
```

The id is a display-resolution key, not a credential — nothing is authorised by it. A
collision would mean two people sharing one face. Across a roster in the tens, the odds
of any collision in a 32-bit space are on the order of one in a million, and the
consequence is a wrong photo on a comment, not a security failure. That risk is
accepted rather than engineered against: a worker has no startup hook to assert
uniqueness in, and a per-request check would tax every read to guard an event that will
not happen. `colorFor` and `avatarKey` already make the same trade.

### `GET /__people?ids=a,b,c` — resolve, don't enumerate

```json
{ "people": [ { "id": "1f3k2p", "name": "Rob", "initials": "RA",
                "color": "#4f46e5", "avatar": "/__avatar/ab12" } ] }
```

- **Answers only what is asked for.** The endpoint takes `ids` (and, for the
  back-compatibility path below, `names`). There is no "list everyone" mode, so a public
  prototype URL cannot be used to enumerate the team.
- **⚠️ It is, however, a membership oracle, and that is accepted.** `personId` is an
  unsalted hash of the address, so anyone can compute the id for a *guessed* email
  offline and ask this endpoint whether it exists — 50 guesses per request, from any
  public prototype URL, unrated-limited. A hit confirms that address has an account and
  returns that person's name and photo. `names` is the same oracle keyed on display name.
  No address is ever returned, and a commenter's name and face are already visible in the
  public comment they wrote, so what leaks is (a) confirmation that a guessed address is
  a member and (b) the name and photo of colleagues who have not commented on that page.
  At a roster of this size that is judged acceptable. Closing it would mean salting the
  hash with a **dedicated, never-rotated** secret — not `SESSION_SECRET`, because
  rotating that would silently orphan the `by` on every existing comment and drop every
  face back to initials.
- **Ungated**, for the same reason `/__avatar/` is (`_worker.js:115–117`): the overlay is
  embedded in public prototypes, and a gated fetch would return the login page. It
  reveals nothing new — the author's name is already rendered in the public comment, and
  only ids that appear in that page's own threads are ever requested.
- **Capped at 50 ids** per request; unknown ids are omitted rather than erroring.
- **Cache-Control: private, max-age=60.** Long enough to spare a fetch per navigation,
  short enough that an admin-panel photo change lands within a minute.

Add `personId` to the `publicUser` projection (`_worker.js:420`) and to
`_instance/profiles` (`:1114`), so build-time editor chips and the runtime overlay speak
the same id.

### Resolution in the overlay

One `loadPeople()` after threads load: collect every distinct `by` on the page, plus
your own from `/__me`, fetch them in one request, cache in a module-level map. Refetch
only when a `by` appears that the map does not hold (i.e. after someone else comments in
a live session).

Per message, in order:

| Condition | Renders |
|---|---|
| `by` resolves in the people map, profile has an avatar | the photo |
| `by` resolves, no avatar on the profile | initials chip in `profile.color` |
| no `by`, but `verified: true` and `author` matches a fetched profile name | that profile (back-compat for comments written before this change) |
| `verified: true` but nothing resolves — roster unreachable, or it has not answered yet | initials derived from the stored `author`, colour hashed from the same string |
| anything else | today's numbered blue pin — unchanged |

The third row is why no migration is needed. `stampAuthor` guarantees a `verified`
message's name belongs to a real account, so name-matching is safe *for verified
messages only*. It is never applied to unverified ones, where a name is just a string
someone typed.

The name-match path needs the roster it cannot ask for by id. It resolves against
profiles already fetched for that page, and — only when a page holds verified messages
with no `by` — one extra request, `GET /__people?names=Rob,Ana`, answering by exact name
under the same no-enumeration and cap rules. This path exists purely for pre-change
comments and goes quiet as they age out.

### Failure and fallback

If `/__people` is unreachable (offline, or the localStorage fallback path in
`applyLocal`, `comments.js:88–108`), every message degrades to initials derived from the
stored `author` string, in a colour hashed from the same string. Nothing renders empty,
nothing renders as a broken image, and the pin never disappears.

`by` must round-trip through both `mutate`/`apiCall` and `applyLocal` — the KV-or-
localStorage invariant from COMMENTING-UX.

The localStorage path stores the client's own message object verbatim (`comments.js:98`),
where no server is involved to stamp anything. So the overlay attaches `by` and
`verified: true` from its own `/__me` result when composing, and your face appears on an
offline comment too. This is not a forgery vector: `sanitizeMsg` builds a fresh object
from `me` and the body, so a client-sent `by` or `verified` never reaches KV. For that,
`/__me` returns the signed-in person's own `id` alongside their profile.

### The three states

A single `avatarEl(person, size)` helper builds the disc — `<img>` when there is a
photo, initials `<span>` on `person.color` when there is not — and all three surfaces
call it. One implementation, one visual language.

**Normal.** `.pin.who`: 28px, white 2px ring, keeping the teardrop notch `.pin` already
has (`border-radius:50% 50% 50% 2px`, `comments.js:242`), photo or initials inside, no
number and no badge. `.pin.anno` (`:248`) is the working precedent for an image in a
pin — same `object-fit:cover`, same overflow clip. Resolved state keeps its green
treatment as a ring rather than a fill, so the face stays legible.

**Hover.** `.preview` gains a leading avatar column. To reproduce the reference's read —
where the pin *becomes* the card's avatar — `showPreview` (`:1117`) positions the card so
its avatar circle lands on the pin's centre, and the pin is hidden for the duration. The
disc appears to stay put while the card grows out from behind it. This reuses the
existing `transform-origin:left center` / `scaleX(.2→1)` spring (`:356`) and its
flip-to-`.left` clamp; when the card flips, the avatar column moves to the trailing edge
so it still lands on the pin.

**Click.** The pin returns with its existing `.pin.active` ring (`:243`) and the thread
card opens offset to the side, as today. Each `.msg` gains a leading avatar aligned to
the name row (`openThread`, `:1085–1094`), and the reply bar gains *your* avatar outside
the pill, to its left (`:1081`). Sidebar rows swap the `.num` for the same disc — the
markup already does exactly this swap for annotations (`:515–521`).

## Testing

- `stampAuthor` / `sanitizeMsg`: a signed-in write gets `by`; an anonymous write gets
  `by: null`; a forged `by` in the request body is discarded.
- `personId`: stable across a photo change, case- and whitespace-insensitive on the
  address, and distinct from `avatarKey` for the same user.
- `/__people`: answers only requested ids; rejects over 50; omits unknown ids; has no
  enumeration mode; reachable without a session cookie.
- Resolution order: each of the four table rows renders the expected element, including
  the pre-change `verified`-plus-name path.
- Degradation: with `/__people` stubbed to fail, every pin still renders as initials.
- Round-trip: `by` survives KV *and* the localStorage fallback.
- Visual: the three states against the reference, plus a screen mixing a photo pin, an
  initials pin and an anonymous numbered pin.

## Build order

1. `personId` + the `by` stamp in `sanitizeMsg` + `/__people`. Server-only; nothing
   visible changes yet, but new comments start recording identity immediately.
2. `avatarEl()` + `loadPeople()` + the resolution chain in the overlay.
3. Normal state — the pin.
4. Hover state — the preview card's avatar column and the pin-becomes-avatar positioning.
5. Click state — thread messages, reply bar, sidebar rows.

Each step leaves the overlay shippable.

## Invariants preserved

- Shadow-DOM isolation; no style leaks to the host page (`comments.js:208`).
- No `innerHTML` of user text — `textContent` and built nodes only (`:549`). Author names
  and initials go through the same rule.
- Screen contract: `anchorAt` / `pinXY` / `data-gv-screen` untouched (`:179`, `:136`).
- KV-or-localStorage fallback for every new field.
- Annotations and their resolve-tooling exemption unchanged.
- Self-contained: no external asset, picker, or CDN.

## Supersedes

`src/review/COMMENTING-UX.md` §7.1 ("Avatars / identity — DECIDED: none") and the "**No
avatars** (we have no users)" instruction in its §6. Both should be marked superseded by
this document in the same commit that ships step 3.
