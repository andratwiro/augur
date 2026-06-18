---
name: participation-design
description: Critique and shape resident-facing participation pages (project pages, About/Participation box, surveys, phases, events) the way a senior digital-democracy practitioner would — for conversion, trust, and inclusion. Grounded in the public participation canon (IAP2, Arnstein, OECD, Ostrom, Plurality). Pull when designing or hard-critiquing a front-office participation flow, choosing CTAs/copy, or deciding what goes where on a project page.
---

# Participation design

Wear three hats at once: **UX/UI designer**, **content strategist**, and **participation
expert** (digital democracy / community engagement — the GoVocal/CitizenLab world). The job
of a participation page is not "look nice." It is to get a real resident to take one real
action, trust that it matters, and come back. Critique against that, hard.

This skill carries two layers: the **operational heuristics** (what to change on the page)
and the **canon they rest on** (why, with sources). Lead with the heuristics; reach for the
canon when you need to justify a call or go deeper.

---

## Part 1 — Operational heuristics

### The non-negotiables

1. **One obvious next step per page.** A resident should never have to choose between
   competing *primary* CTAs. Pick the single critical method for this phase; make it the one
   filled button. Everything else is secondary (outlined) or quieter. Two participation
   widgets both shouting "Take the survey" is a bug, not redundancy you can ignore.
2. **The Participation/About box is the conversion point.** It answers: what's open, how
   many people already took part (social proof), and the one thing to do now. If the page's
   action lives elsewhere (an inline picker, a vote in the timeline), the box should carry
   *social proof + a glance at results/transparency*, not a duplicate of that action.
3. **Match the promise to the real level of influence.** This is the single biggest
   trust-killer (see IAP2 + Arnstein below). If the city will *decide* with residents, say
   so; if it will only *consider* input, don't dress consultation up as "you decide." A CTA
   that over-promises power the process won't deliver is how you train a community to stop
   showing up.
4. **Close the loop, visibly.** "What we heard" / "what happens with your answers" is the
   highest-trust content a platform has and the most-skipped. A page that only *collects*
   reads as extractive. Show the return path even while a method is still open. (OECD calls
   this *accountability*; Arnstein calls its absence *tokenism*.)
5. **Inclusion is a feature, not a footnote.** Easy Read (plain words, big type, one
   high-contrast button), no-account participation, and an in-person/offline path (events)
   are how you reach beyond the already-engaged. Don't bury them; don't make them look lesser.

### Choice & cognitive load

- **Choice overload kills participation.** More than a handful of options collapses people
  into inaction. If a phase genuinely has many parallel methods, *collapse* them (one
  "Participate · N ways" button → modal/sheet) rather than listing them all inline.
- **Tier by effort when you do offer choice** ("5 minutes / 10 minutes / Easy Read"), and
  still mark one as the default path. Self-selection by time is good; a wall of equal buttons
  is not.
- **Match the widget to the lifecycle stage:** gathering (ideation feed, open CTA) →
  deciding (vote, prioritisation) → closing (results, what-we-heard, follow-up survey).

### Copy (content-strategist hat)

- **CTAs are verbs naming the outcome:** "Cast your vote", "Add your idea", "Take the
  5-minute survey" — never "Submit" or "Click here". The action keeps its name across the
  whole flow (button "Publish" → toast "Published").
- **Write from the resident's side.** "Streets suggested", not "inputs". Name things by what
  people recognise, not how the backend models them. Don't claim a duration or count the
  product can't actually show.
- **State the purpose as a plain, neutral question.** The page's job is one defined public
  problem, phrased in plain language — not a slogan (OECD principle #1, *Purpose*).
- **Sentence case, active voice, specific over clever.** Each line does one job: a subtitle
  frames, an intro motivates, the box converts. Kill duplicated phrasing across pages — a
  set of pages that all say "your answers go straight to the team" reads as templated.
- **Distinct municipal voices.** A budget vote, an accessibility survey, and a light pilot
  should not sound like the same author.

### When critiquing, ask

- What is the *one* action here, and is it unmistakably the loudest thing?
- Does the CTA promise exactly the influence the process will actually give (no more, no less)?
- Does the box prove other people are doing this? Does it show where input goes?
- Can someone with 30 seconds, no account, or who needs Easy Read still take part?
- Is the offline/in-person path visible to people who won't act online?
- Whose voice does this design amplify — and who does it quietly exclude or drown out?
- If you're building several pages to show range: is each a *genuinely different* scenario
  (stage, method, tone, arrangement) — or the same page reskinned?

---

## Part 2 — The canon (why the heuristics hold)

### IAP2 Spectrum of Public Participation — match the promise to the power

Five increasing levels of public influence, each with a "promise to the public":
**Inform** (we'll keep you informed) → **Consult** (we'll listen and acknowledge) →
**Involve** (we'll ensure your concerns are reflected) → **Collaborate** (we'll look to you
for advice and incorporate it as far as possible) → **Empower** (we'll implement what you
decide). The level *is* the promise; the CTA and the copy must sit at the right rung. Most
real engagement lives in the middle three. Picking a level you won't honour is the classic
failure. *(IAP2 Federation; mirrored by US EPA's public-participation guide.)*

### Arnstein's Ladder of Citizen Participation (1969) — is it real, or tokenism?

Eight rungs in three tiers. **Nonparticipation:** (1) Manipulation, (2) Therapy — pseudo-
participation to "educate" or placate. **Tokenism:** (3) Informing, (4) Consultation,
(5) Placation — people get a voice but no assurance it changes anything; consultation with
no feedback loop is "a window-dressing ritual." **Citizen power:** (6) Partnership,
(7) Delegated power, (8) Citizen control — real redistribution of decision-making. Use it as
a gut check: a survey whose results visibly drive a decision climbs the ladder; one that
vanishes is rung 4. *Closing the loop is what moves a feature up the ladder.*

### OECD — Good Practice Principles for Deliberative Processes (2020)

Eleven principles; these six translate directly to front-office page design (the rest —
representativeness via sortition, ~4 days in person, arm's-length integrity — govern
*deliberative methods* like citizens' assemblies, not every project page, so don't
mis-apply them):

- **Purpose** — a clear task tied to a defined public problem, phrased neutrally in plain language.
- **Accountability** — there must be real influence; commit publicly to respond/act, and report progress. *(This is "close the loop," made a duty.)*
- **Transparency** — announce the process up front; make materials, results and even the funding source visible.
- **Inclusiveness** — actively involve underrepresented groups; lower barriers (plain language, no-account, support).
- **Information** — give accurate, relevant, *accessible* evidence so people decide informed.
- **Privacy** — protect participants' data; GDPR-grade handling; no-account options reduce exposure.

### Elinor Ostrom — 8 design principles for the commons

For the *ongoing community* behind repeat participation (a platform is a managed commons):
(1) clearly defined boundaries; (2) rules congruent with local conditions; (3) those affected
help make the rules; (4) monitoring by/accountable to the community; (5) graduated sanctions;
(6) cheap, fast conflict resolution; (7) the right to self-organise is recognised by
authorities; (8) nested/federated layers for larger systems. Read as UX: people sustain
participation when the rules are theirs, enforcement is fair and visible, disputes have a
cheap path, and local groups nest into the city rather than being overridden.

### Plurality (Audrey Tang, Glen Weyl & ⿻ Community, 2024, CC0)

Technology should **bridge across difference**, not exploit it. Two ideas worth designing for:

- **Broad listening over loudest-voice.** Healthy participation surfaces *hidden consensus
  and the full range of views* — not just the majority or the most active clique. Tools like
  pol.is-style clustering and **augmented deliberation** ("digital tools that deepen
  collective sense-making … surfacing areas of hidden consensus … without collapsing
  disagreement into false consensus" — Plurality, Ch. 5-1) do this; a raw comment wall
  rewards whoever shouts most.
- **"Social diversity is supermodular: the value created by interaction across difference
  increases with the degree of difference."** (Plurality, Ch. 2-0, CC0.) Design for coalitions
  across neighbourhoods/groups, not winner-take-all.

**Counter-patterns to actively avoid** (Plurality's named failure modes, all directly
relevant to engagement platforms): *engagement-maximization* (optimising clicks/volume over
meaning), *deliberation disconnected from decision-making power* (Arnstein's tokenism, again),
*digital-divide exclusion*, *homophily echo-chambers / capture by dense cliques*, and
*winner-takes-all voting* crushing minority preferences. For participatory budgeting, plural
methods (quadratic/points voting) express intensity and protect minorities better than
first-past-the-post.

---

## Sources & going deeper

These are heuristics, not a rubric to apply mechanically — and the *product* truth (the
Folder→Project→Phase→method spine, the 8 methods, roles, vocabulary) lives in `GOVOCAL.md`
and real captures; verify specifics there rather than inventing them. Pair with
`govocal-a11y` (measured accessibility) and `govocal-persona-critique` (in-character walkthroughs).

**Frameworks:** IAP2 Spectrum (iap2.org / EPA public-participation guide) · Arnstein, *A
Ladder of Citizen Participation* (1969) · OECD, *Good Practice Principles for Deliberative
Processes for Public Decision Making* (2020) and *Catching the Deliberative Wave* (2020) ·
Ostrom, *Governing the Commons* (1990) · Weyl, Tang & ⿻ Community, *Plurality* (2024, CC0,
plurality.net).

**BookPower MCP servers** (books-as-tools for agents, bookpower.org — built by Citizen
Infrastructure, MIT-licensed server code). The Plurality server is a live remote HTTP MCP
exposing ~13 tools (`find_failure_mode`, `suggest_governance_forms`, `find_precedent_case`,
`assess_plural_design`, `get_glossary_term`, `find_quote`, `search_book`, …). To wire it into
Claude Code so future sessions can query the book directly:

```
claude mcp add --transport http -s user plurality https://plurality-mcp-production.up.railway.app/mcp
```

Also on BookPower: **Governable Spaces** (Schneider — "implicit feudalism," sortition,
federated subsidiarity, plural voting), **Think Like a Commoner** (Bollier — Ostrom's
principles as tools), and **Facilitating Deliberation** (MosaicLab — facilitator tools,
private/by-request). When a participation-design question turns on democratic theory rather
than page craft, query these rather than guessing.
