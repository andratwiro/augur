# Methods — page & component bundle index

Internal reference. Never published. Each method maps to its FO page, BO page,
and the components that belong to it. Use this to quickly orient on a method
without scanning the whole library.

---

## Survey

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-survey/` |
| BO page | `pages/bo-method-survey/` *(pending)* |

**Components:** `survey-band`, `survey-fields`, `extra-survey`, `participation-bar`

Notes: FO page shows the survey form as the phase body + the survey widget as a
secondary entry point. BO page = phase config focused on survey settings (question
builder link, anonymity, CTA copy, widget embed).

---

## Ideation

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-ideation/` |
| BO page | `pages/bo-method-ideation/` *(pending)* |

**Components:** `idea-card`, `idea-feed`, `proposal-threshold`, `participation-bar`

Notes: Shows the idea feed + filter sidebar below the timeline. Proposals/petitions
are a sub-state (threshold bar + status pill).

---

## Perspectives

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-perspectives/` |
| FO feed (sub-artifact) | `pages/fo-method-perspectives/feed/` |
| BO page | `pages/bo-method-perspectives/` *(pending)* |

**Components:** `issue-canvas`, `sticky-note`, `theme-card`, `participation-bar`

Notes: FO page = project page with Perspectives tab active; "See all ideas" opens
the feed in a new tab. The feed is a linked sub-artifact, not a top-level card.

---

## Mapping

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-mapping/` *(pending)* |
| BO page | `pages/bo-method-mapping/` *(pending)* |

**Components:** `idea-card`, `idea-feed` (map view), `participation-bar`

Notes: Ideation with a map instead of a list. Same idea card, `gv-viewseg`
toggle switches between list and map views.

---

## Common Ground

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-common-ground/` |
| BO page | `pages/bo-method-common-ground/` *(pending)* |

**Components:** `participation-bar`

Notes: Polis-style agree/disagree on statements. FO page hosts the iframe embed.

---

## Voting

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-voting/` *(pending)* |
| BO page | `pages/bo-method-voting/` *(pending)* |

**Components:** `approval-voting`, `participation-bar`

Notes: FO shows vote options accordion + results tally. BO config = vote method
picker, max-votes setting, budget cap (shared with PB).

---

## Participatory Budgeting

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-budgeting/` *(pending)* |
| BO page | `pages/bo-method-budgeting/` *(pending)* |

**Components:** `approval-voting` (budget variant), `participation-bar`

Notes: Voting sub-method with a total-budget constraint and per-option price tags.
Treated as its own page because the FO UI is meaningfully different.

---

## Information

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-information/` *(pending)* |
| BO page | `pages/bo-method-information/` *(pending)* |

**Components:** `attachment`, `content-builder-render`, `participation-bar`

Notes: No participation input — shows reports and flexible content below the
timeline. FO page demonstrates a rich info phase with file attachments + CB blocks.

---

## Volunteering

| Layer | Path |
|---|---|
| FO page | `pages/fo-method-volunteering/` |
| BO page | `pages/bo-method-volunteering/` *(pending)* |

**Components:** `volunteer-cause`, `participation-bar`

Notes: Sign-up cards for volunteer slots. The `.gv-btn.volunteer` toggles to a
withdrawn state on click.

---

## Sensemaking (AI analysis layer)

Not a method page — surfaces within BO pages for Survey and Ideation as the
Insights sub-tab. See `components/bo-analysis/` and `pages/bo-project-phase/`
(Insights panel). Will appear as a subsection in `bo-method-survey` and
`bo-method-ideation` when those are built.
