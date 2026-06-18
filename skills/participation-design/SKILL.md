---
name: participation-design
description: Critique and shape resident-facing participation pages (project pages, About/Participation box, surveys, phases, events) the way a senior digital-democracy practitioner would — for conversion, trust, and inclusion. Grounded in the public participation canon (IAP2, Arnstein, OECD, Ostrom) and read directly from the source books via the BookPower MCP (Plurality; Schneider's Governable Spaces; Bollier's Think Like a Commoner). Pull when designing or hard-critiquing a front-office participation flow, choosing CTAs/copy, or deciding what goes where on a project page.
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

### Governable Spaces (Nathan Schneider, 2024)

- **Implicit feudalism** — "online communities … governed by relations of lord-and-vassal
  power disguised as neutral platform administration. Platform owners hold unilateral, largely
  unaccountable authority … in a structural pattern that mirrors pre-modern feudal hierarchy
  even as it presents itself as merely technical or managerial" (Schneider, Intro). A city
  platform where admins configure, moderate and decide *everything* while residents only fill
  forms is implicit feudalism with a civic skin. The antidote is giving residents legible,
  accountable governance levers — not just inputs.
- **From users to citizens.** "Before a community can begin to self-govern, it needs to see
  itself as a community — through participants telling stories about themselves and having
  shared experiences" (Schneider). Design for *belonging* before extraction: credited
  contributors, visible history, "what we heard," repeat participation — not one-shot
  survey-fillers.

### Think Like a Commoner (David Bollier, 2024)

- **Commoning** is "the active, ongoing social practice of creating and sustaining a commons …
  through shared governance, mutual obligation, and care" — and "MUST NOT be reduced to an
  economic transaction" (Bollier). Treat participation as something residents *co-steward*,
  not a service delivered to passive consumers.
- **Enclosure / commons-washing** — the failure mode is an authority or vendor *claiming*
  participation while capturing the public square and giving nothing back ("commons-washing").
  On a page that is consultation theatre: a polished CTA over a process with no real return of
  power. It is Arnstein's tokenism and Plurality's deliberation-without-action in commons language.

### Aggregated through-line (across all sources)

The frameworks converge on **one dominant failure and its inverse.** The failure — *control
dressed as participation* — is named six ways: Arnstein's **tokenism**, IAP2's
**over-promised level**, the OECD's missing **accountability**, Plurality's
**deliberation-disconnected-from-decision**, Schneider's **implicit feudalism**, Bollier's
**commons-washing**. Same defect each time: a page that *collects* without *ceding* or
*returning*. The inverse — what good participation design does — also recurs, and every
concrete heuristic in Part 1 is a page-level expression of one of these four:
1. **Make real influence legible** — who decides, what your input changes; match the CTA to it
   and prove it by closing the loop.
2. **Build belonging, not just throughput** — users → citizens/commoners; credit people, show
   history, design for the next visit, not just this submission.
3. **Listen broadly, not loudly** — surface the full range and protect minorities (broad
   listening, intensity-aware voting); don't reward whoever shouts most.
4. **Lower the barrier and bridge difference** — inclusion (Easy Read, no-account, offline) and
   cross-group coalition over winner-take-all; diversity is where value is created.

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
Infrastructure, MIT-licensed server code). The Part 2 book material above was read **directly
from these live remote HTTP MCPs** (each ~12–13 tools: `find_failure_mode` /
`find_enclosure_pattern`, `suggest_governance_forms` / `suggest_commoning_protocols`,
`get_glossary_term`, `find_quote`, `search_book`, `assess_*`, …). To wire them into Claude
Code so future sessions can query the books directly:

```
claude mcp add --transport http -s user plurality           https://plurality-mcp-production.up.railway.app/mcp
claude mcp add --transport http -s user governable-spaces   https://governable-spaces-mcp-production.up.railway.app/mcp
claude mcp add --transport http -s user think-like-a-commoner https://tlac-book-mcp-production.up.railway.app/mcp
```

They are also reachable ad hoc over plain HTTP without installing: POST JSON-RPC `initialize`
→ keep the `mcp-session-id` header → `notifications/initialized` → `tools/call` (responses
are SSE `data:` lines). **Facilitating Deliberation** (MosaicLab) is also on BookPower but is
private/by-request (copyrighted; email hello@zhgnv.com). When a participation-design question
turns on democratic theory rather than page craft, query these rather than guessing.
