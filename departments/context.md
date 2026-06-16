# Departments — context

> ⚠️ INTERNAL ONLY. Never published / never copied to /dist. Agents read this for
> context when building prototypes in this opportunity.

## What this opportunity is

How a **large, multi-department organisation** runs GoVocal. Today the product
gives one platform with flat **Folders** (group projects, no logic) and **Groups**
(segment users). A big city/region with many departments — Parks, Mobility,
Housing, Climate, Culture, Public Works, Health, Finance — has no first-class way
to give each department a **scoped workspace**: its own team/managers, its own
projects and audiences, its own branding, with a roll-up the platform admin can
see across the whole org.

This matters because multi-department adoption is a growth lever (one of Irene's
open strategic threads in `GOVOCAL.md` §13): get one department live, then expand
sideways across the org. The friction is organisational, not just visual —
"who manages what" and "where does this department's stuff live."

## The bet

A **"Department space"** = a scoped workspace one level above Folders. It owns:
- a **team** (managers, folder leads) — optionally **synced from the org directory**
  (Microsoft Entra / SharePoint groups), which ties into the SharePoint-integration
  adoption thread;
- its **projects** (folders still work *inside* a space);
- **branding/accent** and **visibility** scoped to the department;
- a per-space SSO option.
Platform admins get an **org roll-up** (spaces, active projects, participants,
team) so the whole organisation is legible at a glance.

This is a credible evolution of the half-built **"Spaces"** concept (reachable by
URL today, flagged as possibly-sunset pending usage data in `GOVOCAL.md` §13) —
reframed around the real adoption need rather than a generic container.

## Prototypes in this folder

- `department-spaces/` — back-office **Department spaces** overview (the first real
  prototype here, built 2026-06-16). Sidebar destination → page head + org roll-up
  stats + filter tabs (All / Active / Setup / Archived) + a grid of department
  cards. Click a card → right **drawer** (projects, team with a LEAD, space
  settings incl. directory-sync + SSO toggles). "New space" → modal (name, lead,
  accent, start-from template). Built in GoVocal's real BO chrome (canonical
  `.gv-bo-*`, real tokens/icons), page-local `ds-*` for the screen-specific layout.
  Self-contained; passes `npm run audit`.

## Open questions / next

- Is a "space" a new model object, or sugar over Folder + Group + Branding scope?
  (Prototype assumes a new first-class object — cleaner mental model.)
- Directory sync (Entra/SharePoint) is the likely adoption unlock — worth a
  dedicated flow (map a directory group → a space's managers).
- A resident-facing angle: does a department space surface to residents as a
  branded sub-site, or stay a back-office organising construct? (Prototype is
  back-office only for now.)
