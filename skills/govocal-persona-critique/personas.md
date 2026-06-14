# GoVocal personas — the canon roster

Reusable personas for design critique. Each one is a **lens**: a specific person
with goals, context, and the things that trip them up. Critiquing "as" a persona
means walking the prototype's core task in their shoes and judging it against
*their* needs — not a generic usability pass.

**Two sides of the product:**
- **Participants** (resident-facing) — the public who shows up to a project to
  have their say. Enormous range: cognitive disability → neurodivergent →
  low-literacy → older/low-vision → non-native speaker → power techie.
- **Admins** (back-end) — staff who *run* participation. Often older, non-savvy
  civil servants who did this work offline (paper, Typeform, Google Forms) and now
  face GoVocal because their city procured it. Range: "just give me a quick survey"
  → seasoned participation officer running complex multi-phase processes →
  moderator keeping the content clean.

**Per-run override:** these are defaults, not a cage. You can describe a custom
persona at run time (e.g. "a blind screen-reader user", "a parent filling this in
one-handed on a phone on the bus", "a city comms officer under deadline"). A custom
description **replaces** the canon persona for that run; everything else about the
critique flow is identical. Pick the *closest* canon persona as a starting template
when the custom one is a variant.

When choosing, default to the persona the prototype most needs to serve. If unsure
which, critique through **two contrasting** ones (e.g. a vulnerable participant +
the reluctant admin) — the gap between them is usually where the design fails.

---

## Participant personas (resident-facing)

### P1 · Mara — participant with Down syndrome
**Tagline:** "I want to join in, but I get lost when there's too much at once."

- **Who:** Adult with Down syndrome; a mild-to-moderate intellectual disability.
  Reads slowly, sometimes with a support worker nearby. Keen to be included and
  proud to take part.
- **Context:** On a phone or a shared tablet. May have one go at it; little patience
  for re-reading. Anxious about "getting it wrong."
- **Goals:** Understand what's being asked, give *her* answer, know it counted.
- **Trips her up:** long sentences and jargon ("co-creation phase", "deliberation");
  multi-step forms with no sense of how long; abstract icons with no label; anything
  that punishes a mistake; ambiguous "are you sure?" moments; timeouts.
- **Good looks like:** plain language (≈ age-9 reading level), one clear thing per
  screen, big obvious buttons, concrete words and pictures *together*, a visible
  "you're on step 2 of 3", forgiving inputs, an unmistakable "Thanks — your answer
  was sent" confirmation.

### P2 · Ravi — neurodivergent participant (ADHD / autistic)
**Tagline:** "If it's noisy or vague, I bounce."

- **Who:** Neurodivergent adult — high capability, low tolerance for sensory clutter
  and ambiguity. Could be a careful autistic reader who needs literal, precise
  wording, or an ADHD user who skims and needs the path to be obvious.
- **Context:** Easily pulled away; an interruption mid-form can mean abandonment.
- **Goals:** Complete the task without friction, surprises, or wasted effort.
- **Trips him up:** busy/animated UI, carousels that move on their own, vague
  instructions, unclear what's required vs optional, no save/resume, sudden layout
  shifts, ambiguous error messages, figurative language, "click here" with no idea
  what happens next.
- **Good looks like:** calm low-stimulation layout, literal and precise copy, clear
  required-vs-optional, predictable navigation, progress saved, no surprise motion
  (honors `prefers-reduced-motion`), errors that say exactly what to fix.

### P3 · Doris — older, low-digital-literacy resident
**Tagline:** "I'm not good with computers — is this going to be hard?"

- **Who:** 70s, cares deeply about the local issue (a park, a road, a budget). Low
  confidence with technology; worried she'll "break something" or do it wrong.
- **Context:** Larger phone or a desktop with text zoomed up. Possibly reduced
  vision. Reading glasses on.
- **Goals:** Have her say on the thing she cares about, without needing help.
- **Trips her up:** small text and tap targets; low-contrast grey-on-white; hidden
  navigation (hamburger menus, icon-only controls); jargon; no clear primary action;
  fear-inducing language; multi-tab flows; needing an account before she can look.
- **Good looks like:** large legible type that survives zoom, high contrast, one
  obvious primary button per screen, plain reassuring copy, visible labels on every
  control, big targets, the ability to browse before committing/signing up.

### P4 · Yusuf — non-native speaker / new resident
**Tagline:** "Is this in my language? Do I even have to live here to take part?"

- **Who:** Recently arrived; the city's main language is his second or third.
  Reading carefully, sometimes translating in his head. (GoVocal cities run
  multilingual — Copenhagen, Vienna.)
- **Goals:** Understand, switch to a language he reads comfortably, know if he's
  eligible to participate.
- **Trips him up:** language switcher buried or missing; idioms and bureaucratic
  phrasing; untranslated key labels/buttons; unclear eligibility/ID requirements;
  text baked into images (can't be translated).
- **Good looks like:** obvious language switch up top, plain literal language,
  fully-translated UI (not half), clear eligibility stated up front, no essential
  text trapped in images.

### P5 · Alex — savvy techie participant
**Tagline:** "Just let me do it fast — and don't be sketchy with my data."

- **Who:** Highly digitally fluent, high expectations set by best-in-class consumer
  apps. Impatient with friction; scrutinizes privacy and whether participation is
  *real* or theatre.
- **Context:** Fast device, keyboard, may speed-run the form. Will notice dead-ends,
  jank, and dark patterns instantly.
- **Goals:** Contribute in the fewest steps; trust that it matters and that data is
  handled well.
- **Trips him up:** pointless steps, forced account creation, slow/janky
  interactions, no keyboard support, unclear what happens to his input, vague privacy
  / cookie handling, no feedback that the process leads anywhere.
- **Good looks like:** fast frictionless path, keyboard-friendly, transparent about
  data and *what happens next* with his contribution, no dark patterns, evidence the
  participation is genuine (results, follow-up, status).

---

## Admin / back-end personas

### A1 · Brigitte — reluctant, tender-assigned admin
**Tagline:** "I did this fine on paper. Now I *have* to use this thing."

- **Who:** Long-serving civil servant, 50s–60s, low tech-confidence. Ran
  consultations offline or in Typeform/Google Forms/Word for years. GoVocal landed
  on her desk because the city procured it — not her choice. Mild resentment, real
  fear of looking incompetent.
- **Context:** On a work desktop, limited time, no patience for a learning curve, no
  one to ask. Judges everything against "was this easier in Google Forms?"
- **Goals:** Get the one thing her boss asked for *done and published*, correctly,
  without embarrassing herself.
- **Trips her up:** dense admin UIs with dozens of options; unfamiliar vocabulary
  (phases, methods, inputs, ideation); no clear starting point or "what do I do
  first"; fear that a setting is irreversible or public when it isn't; no preview of
  what residents will see; settings whose effects are unclear; jargon with no
  tooltip.
- **Good looks like:** an obvious guided starting path, templates/defaults that work
  out of the box, plain-language labels with help on hover, a clear draft→preview→
  publish model so she can *see* before it goes live, reassurance about what's public
  vs private, easy undo, the feeling that it's *at least as simple as the tool she
  left behind*.

### A2 · Tom — "just a quick survey" officer
**Tagline:** "I don't need the whole platform — I need a survey up by Friday."

- **Who:** Comms or project officer, moderately capable, time-poor. Has one concrete,
  simple need and no interest in the full participation toolkit *today*.
- **Goals:** Stand up a simple survey/poll fast, share a link, collect responses.
- **Trips him up:** being forced through full project/phase setup for a simple survey;
  power features crowding out the simple path; too many decisions before he can start;
  not knowing which "method" maps to "a basic survey"; unclear how to share/distribute.
- **Good looks like:** a fast lane for the simple case (template → questions → share),
  sensible defaults, advanced options tucked away (progressive disclosure), an obvious
  share/distribute step, quick view of responses.

### A3 · Sofia — expert participation officer
**Tagline:** "I run complex processes — give me control and don't make me click 100 times."

- **Who:** Seasoned participation professional. Runs multi-phase processes
  (ideation → budgeting → voting → feedback), often several at once, sometimes at
  city scale. Fluent in the domain and the platform.
- **Goals:** Configure sophisticated processes precisely; manage many inputs/users
  efficiently; analyse and report; close the loop with participants.
- **Trips her up:** rigid flows that assume the simple case; missing power features
  (bulk actions, phases, permissions, export, segmentation); repetitive manual work;
  shallow analytics; no way to reuse/duplicate setups; hand-holding that slows her
  down; ceilings on complexity.
- **Good looks like:** full control with depth, efficient bulk/keyboard workflows,
  reusable templates and duplication, strong analytics and export, clear phase/method
  configuration, tools to *report back* to participants — power without forcing it on
  the simple user (A2's fast lane still intact).

### A4 · Nadia — moderator
**Tagline:** "Keep it clean and fair, fast, at volume."

- **Who:** Moderates resident contributions — ideas, comments, submissions. Handles
  spam, abuse, off-topic, duplicates. Often doing it alongside other duties.
- **Goals:** Triage a queue quickly and fairly; act on flags; keep the space safe and
  on-topic without silencing legitimate voices.
- **Trips her up:** no triage queue or bulk handling; missing context around a flagged
  item; unclear moderation actions/consequences; no audit trail; slow per-item flows;
  no way to spot patterns (one bad actor, a spam wave); irreversible actions with no
  confirmation.
- **Good looks like:** a clear queue with filters, item context at a glance,
  consistent labelled actions (approve/hide/remove/flag) with confirmation on
  destructive ones, bulk handling, an audit trail, fairness cues (why something was
  flagged).

---

## Quick chooser

| If the prototype is… | Critique as… |
|---|---|
| A resident form / survey / vote | **P1 Mara** + **P3 Doris** (most-excluded first), then **P5 Alex** for friction |
| A multilingual / public-facing landing | **P4 Yusuf** + **P3 Doris** |
| An interactive/novel resident interaction | **P2 Ravi** + **P1 Mara** |
| An admin "create something" flow | **A1 Brigitte** (can she start?) + the matching expert/quick lens |
| A simple survey-builder path | **A2 Tom** + **A1 Brigitte** |
| A complex process / config / analytics screen | **A3 Sofia** + **A1 Brigitte** (does depth bury the beginner?) |
| A moderation / queue / review screen | **A4 Nadia** |

The recurring tension worth naming in almost every admin critique: **does serving
the expert (A3) bury the beginner (A1/A2)?** — and in almost every participant
critique: **does the happy path for Alex (P5) leave Mara/Doris behind?**
