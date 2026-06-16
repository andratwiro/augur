# Phase access & user data — reference

> Internal context for agents. **Never published** (lives outside `prototypes/`).
> This is the distilled result of several deep dives into GoVocal's real back office
> (the `7868.epic.govocal.com` tenant) plus a faithful rebuild. Read this instead of
> re-exploring the live UI. See `GOVOCAL.md` (repo root) for the wider product model.

---

## TL;DR

"Phase access and user data" is one **tab** inside the GoVocal project editor. It
answers two questions for a single **phase**:

1. **Who is allowed to take each action** (submit / comment / react / attend), and
2. **What data we collect** from them when they do.

It is powerful and dense: rules are set **per action type**, verification methods
**stack**, you can restrict to **groups**, and you can collect **personal info +
demographic questions**. The design problem we're exploring is: **make this
understandable to a non-technical municipal admin without removing the power an
expert needs.**

---

## Where it lives (product context)

GoVocal's spine is **Folder → Project → Phase → Participation method**. A city runs a
branded platform; residents participate in projects; staff configure from a back
office. Each **phase** runs exactly one method (ideation, survey, voting, …).

Navigation to this tab: **Admin → Projects → [a project] → Timeline tab → [a phase]
→ sub-tab "Phase access and user data".** (Real URL pattern:
`/admin/projects/<id>/phases/<id>/access-rights`.) The sub-tab sits among Setup,
Description, Input manager, Input form, Map, Insights, Notifications.

The surface is **back office** (staff-facing, GoVocal's bluish admin theme), **not**
resident-facing. Admins here are often reluctant, non-technical civil servants.

---

## What it configures — the mental model

For the current phase, you configure a small matrix:

```
                 │ Who can do it        │ How they prove it   │ Extra restriction │ What we collect
─────────────────┼──────────────────────┼─────────────────────┼───────────────────┼──────────────────────
Submit inputs    │ Anyone / Sign-in /   │ email? sms? ID?      │ limit to group(s) │ name? password?
Comment          │ Admins & managers    │ (+ recency for ID)   │ (+ custom error   │ demographic questions
React / vote     │ only                 │ — they STACK         │  message)         │ (+ when to ask)
Attend an event  │                      │                     │                   │
```

Each **action row is configured independently.** A phase can let *anyone comment*
but require *verified locals to submit*, etc. This per-action granularity is the
single biggest source of complexity — and the open question is whether real admins
actually need it or would accept one rule for the whole phase + occasional overrides.

---

## The four actions

| Action | Participation options | Notes |
|--------|----------------------|-------|
| **Who can submit inputs?** | Anyone · Require sign-in · Admins & managers only | The only action that offers **Anyone** (you can submit anonymously). |
| **Who can comment on inputs?** | Require sign-in · Admins & managers only | No "Anyone" — commenting needs an identity. |
| **Who can react to inputs?** (like/vote) | Require sign-in · Admins & managers only | Same two options. |
| **Who can sign up to attend an event?** | Require sign-in · Admins & managers only | Group default shown as "Everyone who signs in" rather than a count. |

(The exact action set varies slightly by method, but these four are the canonical
ones for an ideation phase.)

---

## Dimension 1 — Participation level ("Who can participate")

A row of selectable **cards**:

- **🌍 Anyone** — "No account needed." No sign-in, no verification. (Submit only.)
- **🔑 Require sign-in** — "Must prove who they are first." Unlocks the verification
  methods, groups, and personal-info collection below.
- **🔒 Admins & managers only** — "Restricted to staff." Hides everything else;
  residents can't do this action at all.

**This card choice drives what's visible below it** (see Dynamic behaviors).

---

## Dimension 2 — Verification methods ("How they prove it")

Only shown when **Require sign-in** is chosen. These are **toggles that STACK** — you
can require several at once (this is critical; it is NOT a single pick):

- **✉️ Confirmed email** — "Participant confirms an email address with a one-time
  code." The common default.
- **📱 SMS / text code** — *the new method this whole opportunity is about.* A
  one-time code to their phone. One option among the others, not special in the UI.
- **🪪 Identity verification** — "Participant proves their identity through an
  external register" (national eID / third-party). Reveals two extras when on:
  - a **"See which fields this returns"** link (what the register hands back), and
  - a **"+ Require recent verification"** option (re-verify each phase, not once-ever).

Each method adds a step to the resident's sign-up flow.

---

## Dimension 3 — Limit to groups

Only with sign-in. Restrict the action to members of one or more **user groups**
(e.g. "Verified residents", "Homeowners"). Multi-select.

- Default for most actions shows a count ("1 group"); the event action shows
  "Everyone who signs in" when unrestricted.
- A **"Customize error message"** button opens a modal: a short explainer, the
  default message *"You do not meet the requirements to participate in this
  process."*, and a **per-language** override (tabs: EN / NL-BE / NL-NL / FR-BE …
  — localization is first-class because cities are multilingual).

---

## Dimension 4 — What we collect

Two groups, both gated by participation level:

- **Personal info** (only meaningful with sign-in — no account, nothing to store):
  - **🙋 Full name** — first + last.
  - **🔑 Password** — creates a full account (vs. a lightweight email-only one).
- **📋 Demographic questions** (available to Anyone *and* sign-in — they can be
  anonymous):
  - **When to ask:** "before the user participates" **or** "on a page at the end of
    the form."
  - **Which questions:** an "Add a demographic question" modal lists the city's
    configured questions (defaults: **Gender, Year of birth, Place of residence**) +
    "Create a new question." Importantly, the **question wording is authored in
    Settings → Registration**, not here — this tab only chooses *which* to ask in
    *this* phase. (Good candidate to push out-of-tab in simplified designs.)

A **"Reset demographic questions and groups"** link clears the collection/group
config back to defaults.

---

## Dynamic behaviors (the rules that make it feel alive)

- **Card choice gates everything:**
  - *Anyone* → hides verification, groups, and personal info; shows only
    "What we collect → Demographic questions."
  - *Require sign-in* → shows the full set.
  - *Admins & managers only* → hides everything except the Reset link.
- **Personal info requires sign-in.** Name/password only make sense with an account;
  "Anyone" can only be asked anonymous demographic questions.
- **Identity verification ON** reveals "See which fields this returns" + "+ Require
  recent verification."
- **Sub-sections collapse by default** (Limit to groups, Personal info, Demographic
  questions are collapsed; the admin expands what they need).
- **Cards are horizontal** (icon left, title + one-line description stacked right).

---

## Save & publish model

- The tab **auto-saves** as you change things (no explicit Save button). This is a
  real anxiety source for cautious admins — "did I just make something public?"
- Rules only take effect for residents **when the phase/project is published**;
  before that it's a draft. Reassuring the admin about draft-vs-live is valuable.
- There is no obvious undo. Treat "what's public vs private" and "is this live yet"
  as first-class reassurance needs in any redesign.

---

## Why it's hard (the design problem we're solving)

- **Density:** four actions × (level + stacking methods + groups + message +
  collection + timing) = a lot of controls, mostly hidden behind accordions.
- **Vocabulary:** "inputs", "verification", "demographic", "recent verification",
  "groups" — jargon for a non-techy admin.
- **Invisible consequences:** the admin can't easily see what the *resident* will
  experience, or how many people a stricter setting excludes.
- **Tension:** the beginner (see Brigitte) wants one safe choice; the expert (Sofia)
  wants full per-action control. A good design serves both — simple by default,
  full power on demand (progressive disclosure).

**Goal of the exploration work:** radically simpler takes on this tab — a 15-year-old
should understand what's going on — while still capturing the full model above (you
may flip/merge/relocate parts, but every capability must have a home, or be moved
out-of-tab *with an explanation*). SMS verification is just one method among many;
it does not need to be the hero.

---

## Vocabulary cheat-sheet

- **Input** — anything a resident submits (idea, proposal, comment is separate).
- **Phase** — a time-boxed stage of a project running one method.
- **Participant / resident** — the public user.
- **Method** — the participation type of the phase (ideation, survey, voting…).
- **Verification** — proving who you are (email code, SMS code, eID/ID).
- **Group** — an admin-defined segment of users.
- **Demographic questions** — optional profile questions (age, gender, area…).

---

## Personas (for critique — see `skills/govocal-persona-critique/personas.md`)

- **Brigitte** — reluctant, non-techy, tender-assigned admin. Sets the floor:
  needs a clear starting point, plain language, defaults that work, and reassurance
  about what's public. Fears irreversible/public mistakes.
- **Sofia** — expert participation officer. Needs full per-action depth, stacking,
  groups, recency, data — without hand-holding that slows her down. Hates ceilings.
- **Tom** — time-poor "just a quick survey" officer. Wants a safe default fast and to
  get out. Progressive disclosure keeps power out of his way.

The recurring tension to name: **does serving the expert bury the beginner (or vice
versa)?**

---

## Reference assets (so you don't re-explore)

- **Faithful rebuild of the real tab:** `pages/bo-project-phase/` (the canonical
  project editor) and `sms-verification/prototypes/phase-access-permissions/` (the
  same tab isolated, data-driven, built to match the epic).
- **Raw captures + interaction states:** `govocal-exports/fo-sms-access-rights/`
  (page/dom/styles digest) and `.../states/` (the 5-pass interaction screenshots:
  participation-card states, identity-on, other-actions, the two modals).
- **Exploration set so far:** `sms-verification/prototypes/access-rights-explorations/`
  — six takes behind a floating switcher: (1) Recommended (presets+matrix×live
  phone), (2) Sentence, (3) Presets, (4) Slider, (5) Wizard, (6) Live. Read these to
  avoid repeating the same directions.
- **Exploration set v2:** `sms-verification/prototypes/access-rights-explorations-v2/`
  — five fresh takes, each grounded in a different best-in-class product:
  (1) Share menu (Google Docs/Notion), (2) Properties inspector (Figma, with
  multi-select "Mixed"), (3) Branch protection (GitHub), (4) App-privacy label
  (Apple), (5) Audience builder (Intercom, live "who can take part" count). Shared
  state persists across takes, so the same config reads back in every mental model.
- **Pattern research notes:** `sms-verification/research.md`.

---

## Hard-won learnings (don't relearn these)

- The epic **auto-saves** — when exploring it live, revert any card/toggle you flip.
- The phase default that was captured: **Require sign-in + Confirmed email ON,
  Identity OFF.**
- Verification **stacks** (email + SMS + ID together) — any design that treats it as
  one mutually-exclusive choice (e.g. a single slider) imposes a real ceiling.
- The **natural-language "sentence" pattern localizes badly** (clause order changes
  per language) — a genuine risk for GoVocal's many locales.
- **Mobile:** the GoVocal back-office shell is desktop-only and doesn't reflow.
  This is deep config done at a desk, so desktop-primary is acceptable — but say so.
- Run **`npm run audit`** (design-level a11y: contrast/targets) before calling a
  prototype done; muted greys on light backgrounds tend to fail 4.5:1.
