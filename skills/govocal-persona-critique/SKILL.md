---
name: govocal-persona-critique
description: Critique a GoVocal prototype "in character" as a specific user persona — a participant (Down syndrome, neurodivergent, low-literacy, older/low-vision, non-native, savvy techie) or an admin (reluctant tender-assigned, quick-survey officer, expert participation officer, moderator). Walks the core task in their shoes, screenshots it (webapp-testing), and returns an in-character narrative plus severity-ranked findings tied to the design + a11y skills. Personas are a design lens, not a demand for perfect edge-case UI. Use when reviewing/critiquing a prototype, "review as a persona", or before calling a resident/admin flow done.
---

# GoVocal persona critique

Pass a prototype through the eyes of the people who actually use GoVocal and report
what fails *them*. This is the structured "review my own work" flow: **screenshot →
walk the task in character → critique through the persona + design + a11y lenses →
severity-ranked findings with fixes.**

Companion to `skills/govocal-ui/` (real
components/tokens), `skills/govocal-a11y/` (WCAG 2.2 AA, the perceivable layer), and
`skills/webapp-testing/` (Playwright capture). The persona roster lives in
**`personas.md`** next to this file — read it before critiquing.

## What this is (and isn't)

A persona is a **design lens**, not a spec for a flawless build. We will never ship
perfect UI for "a blind person with Down syndrome on the bus" — that's not the point.
The point is to **pass the design through the lens**: would this choice exclude or
frustrate this person, and is there a cheap design move that includes them instead?
The output is *design guidance*, scoped exactly like `govocal-a11y`: the
perceivable/visual decisions a mockup owns, plus task-flow clarity — not deep
screen-reader engineering. Be generous about what's "good enough" for an edge case;
be ruthless about cheap fixes that were missed.

**Two postures, deliberately different:**
- **Participant (resident-facing): empathy-first, inclusion-first.** The whole brand
  is *"hearing the many, not the few."* Judge against the *most-excluded* relevant
  persona, not the average user. A flow that only works for Alex the techie has
  failed.
- **Admin (back-office): be very careful.** These are reluctant, often non-savvy
  staff who inherited GoVocal because the city procured it. Hold admin flows to a
  *high* bar for clarity, safe defaults, undo, preview-before-publish, and plain
  language. Confusion here isn't a missed survey — it's a civil servant stuck,
  embarrassed, and souring on the platform. **Scrutinize the back-office harder.**

## Mobile-first — always

Check the small screen **first**, then scale up. This is a priority on every
critique, not a footnote.

- **Participants → mobile is the primary case.** Residents show up on phones, often
  mid-life (on a bus, at a kitchen table, on a shared/older device). If it doesn't
  work one-handed at 360–390px wide, it doesn't work. Critique the phone layout as
  the real product; desktop is the bonus.
- **Admins → desktop-primary, but mobile happens.** Brigitte and Sofia mostly work
  at a desk, so deep config can assume a wide screen — but the *common, urgent*
  actions (check responses, approve a flag, publish, fix a typo) should survive on a
  phone. Flag complex admin screens that are *outright broken* on mobile for the
  quick-action case; don't demand full power-config parity on a phone.

Capture at a phone viewport (e.g. 390×844) **and** desktop, and call out anything
that only works on one.

## When to use

**Scope: prototype work only.** This lens applies when building or modifying a
prototype under `<opportunity>/prototypes/` — not to skills, build.js shell,
research/context docs, or the Pages/Patterns reference reproductions.

**I (the agent) proactively suggest it.** The user won't usually ask. When building
or finishing a prototype, *offer* the persona pass — name the one or two personas
that fit and why — and run it once they're on board (or run it as part of the
self-review and report back). Don't wait to be told.

- When **starting** a resident- or admin-facing prototype: name which persona(s)
  this flow most needs to serve, so the design is shaped through that lens from the
  outset.
- Before calling any prototype **done** — run a persona critique alongside `npm run
  audit`, and report both in chat (this is the structured self-review step).
- Whenever the user asks to "critique / review as [persona]", or to pressure-test a
  flow for a specific kind of user.
- Especially on **resident-facing** flows (judge the most-excluded persona) and
  **admin/back-office** flows (be extra careful — see above).

## How to run a critique

1. **Pick the persona(s).** From `personas.md`'s quick chooser, or use a custom
   description the user gives (a custom persona *replaces* the canon one for that run;
   start from the closest canon template). When unsure, critique through **two
   contrasting** personas — the gap between them is where the design usually breaks
   (e.g. Mara vs Alex; Sofia's depth vs Brigitte's first run).
2. **Identify the core task.** What is this persona here to *do*? (Give my answer;
   stand up a quick survey; clear the moderation queue.) Critique that task, not the
   whole UI.
3. **Capture it — mobile first.** Use `skills/webapp-testing/` (Playwright, via
   `.venv/bin/python`) to screenshot the relevant screens/states at a **phone
   viewport first (≈390×844), then desktop**. Trigger the states that matter to this
   persona (error, empty, loading, the confirmation). You're looking at what they'd
   actually see.
4. **Walk the task in character.** Step through the flow as this person — narrate the
   real reactions, confusion, hesitation, and wins. Stay honest to *their* literacy,
   confidence, patience, and device.
5. **Judge through the three lenses, in this order:**
   - **Persona** — does it fit *their* goals, vocabulary, confidence, patience, body?
   - **a11y (perceivable)** — contrast/use-of-color/type/targets/focus/motion +
     all states shown (defer to `govocal-a11y`; don't re-derive it).
   - **Design** — on-brand, clear hierarchy, right components/tokens (defer to
     `govocal-ui` + `frontend-design`).
6. **Write it up** in the format below.

## Output format

**1 · In-character walkthrough** — first person, as the persona. Short, honest, a
little vivid. What they're trying to do, where they hesitate, what delights or stops
them. (3–8 sentences; this is the empathy half.)

**2 · Severity-ranked findings** — a table, worst first:

| Sev | Finding | Why it matters (to this persona) | Where | Fix |
|-----|---------|----------------------------------|-------|-----|

- **Blocker** — this persona can't complete the core task, or would abandon /
  be excluded. (Resident flows: an exclusion is a blocker. Admin flows: "can't tell
  what's public", "no preview before publish", "irreversible with no undo" are
  blockers.)
- **Major** — completes it, but with real friction, confusion, or risk.
- **Minor** — polish that would smooth the experience.

Tag each finding's lens (persona / a11y / design) and note device if it's mobile- or
desktop-specific. Give a **concrete** fix, not "improve clarity."

**3 · What works** — 1–3 things worth keeping. (Critique isn't only damage.)

**4 · Verdict** — one line: would this persona succeed? What's the single highest-
leverage change?

## Principles

- **Be specific and actionable.** "Mara won't parse 'co-creation phase' — relabel the
  button 'Add your idea'" beats "simplify language."
- **Match severity to real impact for this persona** — not generic nitpicks. A muted
  grey caption is Minor for Alex and a Blocker for Doris; say so.
- **Don't punish a prototype for being a prototype.** It's interactive guidance, not
  the shipping build — judge the *design decisions*, not missing backend or
  un-hardened ARIA (that's the dev team's, per `govocal-a11y`).
- **Inclusion over average.** On resident flows, the most-excluded relevant persona
  sets the bar. On admin flows, the least-confident admin (Brigitte) does.
- **Two lenses beat one.** A single persona flatters; a contrasting pair exposes the
  trade-off the design is silently making.

## Notes

- Internal skill — lives under `skills/`, never ships to `/dist`.
- Pairs with `npm run audit`: persona critique = the human/design lens; audit = the
  automated perceivable-a11y lens. Report both when finishing a prototype.
