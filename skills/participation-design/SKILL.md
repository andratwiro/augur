---
name: participation-design
description: Critique and shape resident-facing participation pages (project pages, About/Participation box, surveys, phases, events) the way a senior digital-democracy practitioner would — for conversion, trust, and inclusion. Pull when designing or hard-critiquing a front-office participation flow, choosing CTAs/copy, or deciding what goes where on a project page.
---

# Participation design

Wear three hats at once: **UX/UI designer**, **content strategist**, and **participation
expert** (digital democracy / community engagement, the GoVocal/CitizenLab world). The goal
of a participation page is not "look nice" — it is to get a real resident to take one real
action, trust that it matters, and come back. Critique against that, hard.

## The non-negotiables

1. **One obvious next step per page.** A resident should never have to choose between
   competing primary CTAs. Pick the single critical method for this phase; make it the one
   filled button. Everything else is secondary (outlined) or quieter. Two participation
   widgets both shouting "Take the survey" is a bug, not redundancy you can ignore.
2. **The Participation/About box is the conversion point.** It answers: what's open, how
   many people already took part (social proof), and the one thing to do now. If the page's
   action lives elsewhere (an inline picker, a vote in the timeline), the box should carry
   *social proof + a glance at results/transparency*, not a duplicate of that action.
3. **Phases = transparency = trust.** The timeline shows where we are in the process and
   what's next. Highlight the current phase. People participate more when they can see the
   process is real and their input has a destination.
4. **Close the loop, visibly.** "What we heard" / "what happens with your answers" is the
   highest-trust content a platform has and the most-skipped. A page that only *collects*
   reads as extractive. Show the return path even while a method is still open.
5. **Inclusion is a feature, not a footnote.** Easy Read (plain words, big type, one
   high-contrast button), no-account participation, and an in-person/offline path (events)
   are how you reach beyond the already-engaged. Don't bury them; don't make them look lesser.

## Choice & cognitive load

- **Choice overload kills participation.** More than a handful of options collapses people
  into inaction. If a phase genuinely has many parallel methods, *collapse* them (one
  "Participate · N ways" button → modal/sheet) rather than listing them all inline.
- **Tier by effort when you do offer choice** ("5 minutes / 10 minutes / Easy Read"), and
  still mark one as the default path. Self-selection by time is good; a wall of equal buttons
  is not.
- **Match the widget to the lifecycle stage:** gathering (ideation feed, open CTA) →
  deciding (vote, prioritisation) → closing (results, what-we-heard, follow-up survey).

## Copy (content-strategist hat)

- **CTAs are verbs naming the outcome:** "Cast your vote", "Add your idea", "Take the
  5-minute survey" — never "Submit" or "Click here". The action keeps its name across the
  whole flow (button "Publish" → toast "Published").
- **Write from the resident's side.** "Streets suggested", not "inputs". Name things by what
  people recognise, not how the backend models them. Don't claim a duration or count the
  product can't actually show.
- **Sentence case, active voice, specific over clever.** Each line does one job: a subtitle
  frames, an intro motivates, the box converts. Kill duplicated phrasing across pages — a
  set of pages that all say "your answers go straight to the team" reads as templated.
- **Distinct municipal voices.** A budget vote, an accessibility survey, and a light pilot
  should not sound like the same author.

## When critiquing, ask

- What is the *one* action here, and is it unmistakably the loudest thing?
- Does the box prove other people are doing this? Does it show where input goes?
- Can someone who has 30 seconds, no account, or who needs Easy Read still take part?
- Is the offline/in-person path visible to people who won't act online?
- Does every CTA say what happens, in the resident's words, consistently?
- If you're building several pages to show range: is each one a *genuinely different*
  scenario (stage, method, tone, arrangement) — or the same page reskinned?

## Caveat

These are heuristics, not a rubric to apply mechanically. The product truth lives in
`GOVOCAL.md` (the Folder→Project→Phase→method spine, the 8 methods, roles, vocabulary) and
in real captures — verify specifics there rather than inventing them. Pair with
`govocal-a11y` for measured accessibility and `govocal-persona-critique` for in-character
walkthroughs.
