# SMS Verification — context

> Internal context for agents. **Never published** (lives outside `prototypes/`).
> Read this (and `research.md`) before building or modifying a prototype here.

## What this opportunity is

_One-paragraph framing of the SMS verification opportunity._

## Prototypes in this folder

- `hello-world/` — scaffold placeholder. Replace with the first real flow.
- `access-rights-explorations/` — **5 radically simpler takes** on the phase
  access-rights tab, in one prototype with a **floating switcher** (bottom-center,
  1–5). Keeps the GoVocal editor frame for context; the tab content goes wild and
  is intentionally **off the GoVocal design system** (own `.ax-*` namespace, plain
  language, a 15-year-old should get it). The five: **1 Sentence** (tap words in a
  natural-language sentence), **2 Presets** (4 plain cards + fine-tune disclosure),
  **3 Slider** (open↔strict spectrum with a live "who gets in" meter + resident
  steps), **4 Wizard** (1–2 plain questions → summary), **5 Live** (toggle door
  checks, watch the resident's phone update). All fully clickable; SMS is one
  verification option among email/ID. Pattern research in `research.md`.
  **Now carries the FULL model** (per Luuc's tab): per-action rules (submit /
  comment / react / attend), **stacking** verification methods (email/SMS/ID +
  recency), limit-to-groups (+ inline customize-message), and data collection
  (name / password / demographics + timing + question picker that notes the
  questions live in Registration settings). Bar = reachable + clickable, deep
  editors light. Per-action treatment is **mixed**: E1 Sentence, E2 Presets,
  E4 Wizard = one rule + per-action overrides; E3 Slider & E5 Live = per-action
  first-class. E3 deliberately trades per-action *data/groups* to a phase-level
  block (slider keeps per-action *access*) — flagged in an in-prototype note.
  **Review round 2:** fixed the collect logic to match the epic — personal info
  (name/password) only when sign-in is required; "Anyone" can only be asked
  anonymous demographic questions (no account = nothing to collect). E1 now
  defaults to the epic's real default (sign-in + email) with grammatical
  subject phrasing. Passes `npm run audit` (darkened `--ax-muted` for contrast).
  **Round 3 (persona pass — Brigitte/Sofia/Tom):** moved the floating switcher
  out of the content column, added a draft/"saves as you go, nothing live until
  publish" reassurance strip (Brigitte's top fear), and added a **6th
  "Recommended" exploration** = the E2×E5 synthesis (preset cards + per-action
  matrix spine with the live resident phone pinned beside the focused action).
  It's now the default landing. Mobile remains desktop-primary (inherited BO
  shell doesn't reflow) — known limitation. Full findings in chat / git history.
- `phase-access-permissions/` — the **Project Editor back office** (duplicated from
  `pages/bo-project-phase/`, self-contained) focused on **Timeline → Phase →
  "Phase access and user data"**. The access tab is rebuilt to mirror the *current
  epic* design (7868.epic.govocal.com): card-based "Who can participate"
  (Anyone / Require sign-in / Admins & managers only) + verification toggles
  (Confirmed email, Identity verification) + "Limit to groups" + "What we collect"
  (Personal info, Demographic questions). This is the surface where **SMS
  verification** will be configured, and the baseline we'll simplify. Page-local
  `sms-*` CSS; values measured from `govocal-exports/fo-sms-access-rights/`.
  Rebuilt **data-driven** (JS renders all 4 action accordions) from 5 capture
  passes recorded in `govocal-exports/fo-sms-access-rights/states/`:
  - **Participation card drives visibility** — *Require sign-in* shows everything;
    *Anyone* shows only "What we collect → Demographic questions"; *Admins &
    managers only* shows nothing but the reset link.
  - **Identity verification ON** reveals a "+ Require recent verification" link.
  - Sub-sections (Limit to groups / Personal info / Demographic questions) are
    **collapsed by default**; cards are horizontal (icon left, title/desc right).
  - Comment / react / attend-event mirror submit but with **only 2 cards** (no
    *Anyone*); event's groups default = "Everyone who signs in".
  - Real **modals**: "Customize error message" (intro + default quote + EN/NL-BE/
    NL-NL/FR-BE language pills) and "Add demographic questions" (Gender / Year of
    birth / Place of residence + Create a new question).

  ⚠️ The epic **auto-saves** access changes — when exploring it live, revert any
  card/toggle you flip (the captured phase default is Require sign-in + Confirmed
  email ON + Identity OFF).

## Working notes

- Resident-facing prototypes here must show the cookie-consent dialog and build on
  the `--gv-tenant-*` tokens (see `CLAUDE.md` + `skills/govocal-ui/`).
- _Add decisions, terminology, and learnings as we go._
