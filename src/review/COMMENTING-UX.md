# Commenting UX — compose & thread redesign (build plan)

> **Historical** — the original build plan for the comments overlay, kept as a design record.
> Current behavior is the code (`src/review/comments.js`); do not treat "what's there today" claims below as current.

Target spec for upgrading the review overlay (`comments.js`) to a modern
commenting interaction model, captured from a set of annotated reference
screenshots. This is a **build plan**, not a description of
current behavior: each state below states the *target*, the *interaction detail*
(transitions, focus, keyboard, edge cases), and **what's there today vs. what to
build** against the current implementation.

> Scope note: the overlay lives entirely in `src/review/comments.js` (shadow-DOM,
> single IIFE). Everything here is implementable inside that file + its stylesheet
> block (`root.innerHTML` `<style>`, comments.js:211). KV/worker changes are flagged
> where a state needs persisted data we don't store yet.

---

## State machine (overview)

```
            click canvas                  first keypress
  (browse) ─────────────▶ [pin + collapsed input] ─────────────▶ [compose box + toolbar]
                                  │  Esc / blur-empty                 │  text grows box
                                  └──────────────┐                    │  @ / emoji / image
                                                 ▼                    ▼
                                            (discard)            submit (⏎ / arrow)
                                                                      │
                  hover pin                                           ▼
  [numbered pin] ───────────▶ [hover preview card] ──click──▶ [open thread]
                                                                      │
                                              ┌───────────────────────┤
                                          reply box (same compose UI)  resolve ✓ / close ✕ / ⋯
```

Five visible compose/read surfaces, mapped to the reference image's six panels:

| Reference panel        | Surface                                  |
|------------------------|------------------------------------------|
| *when dropping pin*    | Collapsed compose (pin + 1-line input)   |
| *when starting to write* | Expanded compose (box + toolbar)       |
| *longer write*         | Expanded compose, auto-grown + @mentions |
| (emoji grid)           | Emoji picker popover                     |
| *preview on hover*     | Hover preview card (read-only)           |
| (open thread + reply)  | Open thread + reply compose              |

---

## 1. Dropping a pin — collapsed compose

**Target.** Clicking the canvas drops the pin glyph and, immediately to its right,
a single-line pill input reading **"Add a comment"** with a circular send arrow on
the trailing edge (disabled/greyed until there's text). No toolbar yet, no name
field, nothing else. It reads as one lightweight affordance, not a form.

**Interaction detail.**
- The pin appears at the click point; the input anchors beside it (right by
  default, flips left if it would overflow the viewport — reuse the clamp logic in
  `positionCard`, comments.js:481).
- Input autofocuses. Caret is in the field; the user can type immediately.
- **Esc** or **clicking away while empty** discards the whole thing (pin + input)
  with no persistence — this is a *pending* pin, not a saved comment.
- Send arrow is disabled while empty; pressing **⏎** with text submits (see §2).
- The pin has no number yet — it's numbered only once the comment is saved and
  enters `listed()` (comments.js:338).

**Today vs. build.**
- Today: the catcher click goes straight to `composeNew` (comments.js:631, :490),
  which renders the *full* card (heading, optional name input, multi-line
  textarea, anno toggle, Cancel/Comment buttons). There is no collapsed step.
- Build: split `composeNew` into a **collapsed → expanded** progression. Start
  with a compact `.compose.collapsed` element (pin + 1-line input + send). Keep the
  `anchorAt()` capture (comments.js:179) exactly as-is — that's the pin's anchor and
  is orthogonal to the compose chrome.

---

## 2. Starting to write — expanded compose + toolbar

**Target.** On the first keypress the collapsed pill **expands** into a rounded
card: a multi-line text area on top, and a toolbar row beneath it with three icon
buttons — **emoji** (☺), **@mention**, **image** — on the left, and the blue
circular **send** arrow on the right (now enabled).

**Interaction detail.**
- Transition is the input *growing into* the box, not a swap — the typed text
  stays, caret position preserved. Animate height if cheap; never lose focus.
- Toolbar buttons:
  - **Emoji** → opens the emoji picker popover (§4); inserts at caret.
  - **@mention** → inserts `@` at caret and opens the mention autocomplete (§3).
  - **Image** → file picker; see §6 for the storage decision (currently unsolved).
- **Send**: blue filled circle + up-arrow. Enabled iff trimmed text is non-empty.
  Click or **⏎** submits. **Shift+⏎** inserts a newline (don't submit).
- On submit: persist via `mutate({op:"add", …})` (comments.js:522), collapse the
  compose, and render the saved pin (numbered) + open thread — first send drops
  you into the open thread.

**Today vs. build.**
- Today: the textarea exists (`.tx`, comments.js:498) but there's **no toolbar**,
  no emoji/@/image, and submit is a labelled "Comment" button (comments.js:500) with
  no ⏎-to-send.
- Build: add the toolbar row + send-arrow button; wire ⏎/Shift+⏎ key handling on
  the textarea; auto-grow (§3). The name capture (`needName`, comments.js:496) should
  move out of the inline form — the reference identifies the author by avatar, not a
  text field. Capture the name **once** (first-run prompt or a small identity chip), then
  represent the author as an avatar everywhere (see §7, Open questions).

---

## 3. Longer write — auto-grow + @mentions

**Target.** As content grows the box grows with it (the *"auto-box increase"* in
the reference). `@`-mentions render inline as a coloured token (the name in the
accent colour, e.g. "Rob" in blue), distinct from body text.

**Interaction detail.**
- **Auto-grow:** textarea height tracks content up to a max (then it scrolls).
  Implement by setting `height:auto; height:scrollHeight` on each `input` event, or
  a mirror/`field-sizing` approach. The toolbar stays pinned to the bottom edge.
- **@mention flow:** typing `@` opens an autocomplete list of known
  participants/teammates; arrow-keys + ⏎ to pick; Esc closes the list without
  inserting. A committed mention is a styled, atomic token — backspace deletes the
  whole token, not one character.
- Rendering mentions requires storing the message as **rich content** (text +
  mention spans), not the current plain `body` string (comments.js:520). Either a
  lightweight markup (`@[name](id)`) parsed at render, or a structured
  `{ text, mentions:[{offset,len,id,name}] }`. Pick one and use it for both compose
  and the message list (§6). **Never** `innerHTML` raw user text — the current code
  correctly uses `textContent` (comments.js:549); the mention renderer must tokenise
  and build nodes, not interpolate strings.

**Today vs. build.**
- Today: fixed `min-height:64px; resize:vertical` textarea (comments.js:273); plain
  string body; no mentions.
- Build: auto-grow handler; rich-content model; mention autocomplete + token
  rendering. **Mention directory is an open question** — see §7.

---

## 4. Emoji picker

**Target.** A popover with: a category tab strip across the top (recent ⏱, smileys,
nature, food, activity, travel, objects, symbols, flags), a **Search** field, a
**Frequently used** row, then **Smileys & People** and the rest in a scrollable
grid. A skin-tone selector sits bottom-right.

**Interaction detail.**
- Opens anchored to the emoji toolbar button; flips to stay on-screen (reuse the
  viewport clamp pattern from `showTip`, comments.js:455).
- Picking an emoji inserts it at the caret and keeps the picker
  open for multi-pick; click-away or Esc closes it.
- Search filters the grid live by name/keyword.
- "Frequently used" is per-user, persisted to `localStorage` (same pattern as
  `LS_NAME`, comments.js:42) — no server needed.

**Today vs. build.** Not present at all. This is the heaviest new piece.
- Build: ship a small emoji dataset (categories + keywords) as a local module —
  **do not** pull a CDN/npm picker; prototypes are self-contained static files
  (CLAUDE.md). A compact JSON of common emoji + a simple grid renderer inside the
  shadow root keeps it dependency-free. Defer the full Unicode set unless asked;
  "Frequently used + Smileys & People + search" covers the reference.

---

## 5. Preview on hover

**Target.** Hovering a pin shows a small read-only **preview card**: author
name, relative time ("just now"), and the comment body truncated with an ellipsis
(*"Adding a really long comment, I really don't need the @ or the images (well, can
you highlight…"*). It does **not** show replies or any input — it's a peek. Click
opens the full thread (§6).

**Interaction detail.**
- **Grow-from-pin animation (the reference image):** the card **unfurls out of the
  pin, left edge → right**. The pin sits at the card's left; the card scales/expands
  rightward from there. Implement with `transform-origin: left center` + a
  `scaleX`/width-and-opacity transition (~160–200ms, ease-out); the pin stays put and
  the body grows out of it. (Today's `.atip` grows *upward* from centre,
  comments.js:228–232 — this is a different origin: anchor left, expand right.)
- Default placement is to the **right** of the pin; flip to the left if it would
  overflow the right edge (mirror the viewport clamp in `showTip`, comments.js:455).
- Hover-intent: small delay in (~150ms) so sweeping the canvas doesn't flash cards;
  hide on mouse-leave unless the cursor moves onto the preview itself.
- Truncate body to ~3 lines via CSS line-clamp; never render the full thread here.
- Touch: no hover — tap opens the thread directly.

**Today vs. build.**
- Today: hover preview exists **only for annotations in delivery mode** — the blue
  `.atip` bubble shows the note text (comments.js:451, :228). Normal comment pins in
  review mode have only a native `title` tooltip (comments.js:396).
- Build: extend hover preview to all pins in review mode, upgraded from a text
  bubble to an author + relative-time + snippet card (no avatar) that grows from the
  pin left→right. The annotation delivery-mode bubble can stay as-is (it's a
  different, simpler affordance) or share the card styling.

---

## 6. Open thread + reply

> **Copy this card as-is — the user loves it.** Replicate the layout, spacing, and
> chrome of the reference exactly: rounded white card, "Comment" header, bold
> name + grey relative time per message, the accent-coloured `@mention` and
> name token in body text, and the rounded grey **"Reply"** pill with an inner
> circular send arrow on its trailing edge. Match it pixel-faithfully, then map the
> header icons to our semantics below. **No avatars** (we have no users) — drop the
> avatar circles; the author is just the bold name. **White only** — no dark-mode
> variant.

**Target.** The full thread card. Header: **"Comment"** title on the left; on the
right, **four** icon buttons in this order — **⋯**, the **annotation (cat) toggle**,
**resolve ✓** (circle-check), and **✕** close. Body: each message as bold
name + grey relative time + per-message **⋯** + the text. Footer: a **reply** compose
box (collapsed "Reply" pill → expands to the §2–4 toolbar compose on focus).

**Header icon mapping (our semantics — not the reference's):**

| Icon                    | Our action                                                        |
|-------------------------|-------------------------------------------------------------------|
| **⋯** (three dots)      | **Delete** the thread (this is our delete affordance, not a menu) |
| **aslamnotation** (cat) | **Annotation toggle** — promote/demote the always-on dev note     |
| **✓** (circle-check)    | **Resolve** / reopen                                              |
| **✕**                   | **Close** the card (browse stays on)                              |

**Interaction detail.**
- **⋯ = Delete.** It is *not* an overflow menu — clicking it deletes the thread
  (keep the existing confirm, comments.js:568–571). Style it as a three-dot
  glyph, in the header's top-right cluster.
- **Cat toggle** sits next to resolve, carrying the annotation promotion that's
  inline today (`anno-toggle`, comments.js:561). Same on/off visual it already has
  (greyscale ↔ amber border, comments.js:264–266), just relocated into the header
  row. Keep the title/tooltip copy.
- **Resolve ✓** toggles resolved (green pin, comments.js:218); resolved threads stay
  listed and reopenable. **✕** closes the card.
- Each message's **⋯** → delete that message (per-message; today only whole threads
  delete). Lower priority than the header cluster — build last.
- Reply: collapsed grey **"Reply"** pill with inner send arrow (disabled until text);
  on focus/keypress it expands into the same toolbar compose as §2–4 (auto-grow, ⏎
  sends, Shift+⏎ newline).
- **Relative time:** show "Just now" / "1 minute ago". Replace the absolute
  `fmt()` (comments.js:611) with a relative formatter (re-tick open cards on an
  interval so "Just now" ages to "1 minute ago").

**Today vs. build.**
- Today: header is `Comment/Annotation · resolved` text + an inline anno-toggle
  avatar (comments.js:533–537); actions are labelled buttons in a footer row
  (Delete / Resolve / Reply, comments.js:540–542); messages are name + absolute time
  + body, no avatar, no per-message menu (comments.js:544–551); reply is a plain
  textarea (comments.js:539).
- Build: restyle header to the four icon buttons (⋯ delete / cat annotate / ✓ resolve
  / ✕ close); add per-message ⋯ (delete message, last); swap the reply textarea for
  the expanding compose pill; relative timestamps; remove dark mode.

---

## 7. Open questions / decisions before building

**Locked for v1:** no avatars · white only · build all at once · **emoji, @mentions,
and images all deferred** → the compose box has **no toolbar row** for now (just the
auto-growing field + send arrow). Native OS emoji can still be typed into the field.
The annotation (cat) affordance is **removed from compose** — you create a plain
comment, then promote it via the cat icon in the open-thread header (§6).

These aren't visible in the image but the build can't proceed cleanly without them:

1. **Avatars / identity — DECIDED: none.** No users, no avatars. Drop every avatar
   circle from the reference; author is the bold name string only (`LS_NAME`,
   comments.js:200). Pins stay numbered (and the cat for annotations) as today.
2. **Theme — DECIDED: white only.** Remove the `prefers-color-scheme: dark` block
   (comments.js:282–292). Go all-white for compose/thread chrome.
4. **@mention directory.** Where does the autocomplete list come from? There's no
   user list in a static prototype. Options: a hardcoded teammate list per
   prototype, or free-text `@anything` that just styles the token without resolving
   to a real user. **Recommend free-text styled tokens** unless a real list exists.
5. **Image upload.** KV stores small JSON thread blobs (comments.js:88); it's not an
   image store. Options: base64-inline small images into the message (bloats KV,
   simplest), upload to R2/an asset endpoint (new worker route), or **drop image
   support for v1** and ship emoji + @ only (the reference author even says *"I don't
   need images"*). **Recommend deferring images.**
6. **Persistence shape.** Mentions/rich content change the stored `message` schema
   (comments.js:519). Decide the model once (plain string vs. structured) — it
   touches add, reply, render, and the resolve tooling (`scripts/review.mjs`).
7. **Scope.** Build all surfaces at once, or stage it? Suggested order that keeps the
   overlay shippable at each step: **(1)** collapsed→expanded compose + ⏎-to-send +
   auto-grow → **(2)** relative time + header icon buttons + remove dark mode →
   **(3)** hover preview card → **(4)** emoji picker → **(5)** @mentions →
   **(6)** images (if at all).

---

## Invariants to preserve (don't regress these)

- **Shadow-DOM isolation** — all UI stays inside `root` (comments.js:208); never
  leak styles to the host page.
- **No `innerHTML` of user text** — tokenise/`textContent` only (comments.js:549).
- **Screen contract** — pins stay anchored via `anchorAt`/`pinXY` + `data-gv-screen`
  scoping (comments.js:179, :136); compose chrome must not touch anchoring.
- **KV-or-localStorage fallback** — every new field must round-trip through both
  `mutate`/`apiCall` and `applyLocal` (comments.js:88–108).
- **Annotations** — the cat-avatar always-on delivery notes (comments.js:110, :340)
  and their resolve-tooling exemption stay intact; the annotation toggle just moves
  into the thread ⋯ menu.
- **Self-contained** — no external picker/emoji CDN; everything ships in-file
  (CLAUDE.md prototype rules).
