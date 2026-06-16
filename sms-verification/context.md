# SMS Verification — context

> Internal context for agents. **Never published** (lives outside `prototypes/`).
> Read this (and `research.md`) before building or modifying a prototype here.

## What this opportunity is

_One-paragraph framing of the SMS verification opportunity._

## Prototypes in this folder

- `hello-world/` — scaffold placeholder. Replace with the first real flow.
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
