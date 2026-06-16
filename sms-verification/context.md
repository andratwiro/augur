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

## Working notes

- Resident-facing prototypes here must show the cookie-consent dialog and build on
  the `--gv-tenant-*` tokens (see `CLAUDE.md` + `skills/govocal-ui/`).
- _Add decisions, terminology, and learnings as we go._
