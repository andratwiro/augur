# project-page — analysis & component mapping

Source: GoVocal internal instance (`internal.govocal.com`) — three exported examples
of the **same project surface** built different ways via the page builder:

- `source2.{html,png}` — **the canonical shell** (used for this build): hero banner →
  title + description + participants → accordion → **phases timeline** → phase-content.
- `source.{html,png}` — a project whose visible phase is an **ideation collection**
  (input-card list + filter sidebar + events). → belongs to the future `ideation` page.
- `source3.*` — a project whose visible phase is a **report** (charts, etc.).
  → reinforces the model below; belongs to a future `report`/results surface.

## The model this confirms

A project page = **stable shell** + a **swappable phase slot**. The shell is the same
regardless of configuration; only what fills the phase-content slot changes by method
(information/announcement, ideation, voting, survey, report…). So:

- **`project-page` (this build)** = the shell + the **phases timeline** + ONE
  representative phase rendered in the slot (an *information / announcement* phase — the
  simplest content, real text from source2).
- The ideation list (`source`) and the report (`source3`) are what fill the slot for
  *those* phase types → built as their own pages later and slotted in.

## Block-by-block reuse map (source2 shell)

| Block | Reuse / build | Notes |
|---|---|---|
| Header (logged-in) | **reuse** `.gv-header` + adapt | add notification bell + count badge, avatar button, keep mobile drawer. GoVocal default theme (pink), not a city. |
| Action bar (Back / Edit / Unfollow) | **NEW** `.gv-projbar` | manager view, faithful to export. Public view would drop *Edit* + show *Follow*. |
| Banner | **reuse** `.gv-hero` idea → **NEW** `.gv-banner` | image-only banner (no overlay title); title sits below. Teal illustration placeholder + "LET'S CHAT!" sticker. |
| Title + lock + description | primitives (`.gv-title`/`.gv-text`) + **NEW** `.gv-projhead` | brain-emoji title, a small "Private" lock chip, intro paragraphs. |
| Participants | **reuse** `.gv-avatars` (on-light variant) | avatar stack + "34 participants" + the admin real-time note. |
| Accordion (3 FAQ items) | **NEW** `.gv-accordion` | CSS-only `<details>`; first item open to show the open state. |
| **Phases timeline** | **NEW** `.gv-phases` (the signature block) | numbered stepper, `role=tablist`; done ✓ / current / upcoming states (not colour-alone). |
| Phase-content | **NEW** `.gv-phasepanel` | title + date + rich body + Read more; switches when a phase chip is clicked. |
| Footer | **reuse** `.gv-footer` | legal links + "Powered by go·vocal" (no city logo — GoVocal's own instance). |

## Deliberate deviations (documented)

- **Phase states:** the source project happened to sit on its *final* phase (10 of 10,
  all others past). For a reference that teaches the component — and per the a11y rule
  to *demonstrate all states* — the timeline here shows **done + current + upcoming**:
  7 phases, current = "Development plan is announced", with the real announcement text in
  the panel. Real phase labels kept.
- **Theme:** rebuilt on the **default GoVocal theme** (pink `#E10069`) and kept themeable
  via `--gv-tenant-*`; `?theme=` picker left on so reviewers can re-skin.
- **Imagery:** banner/illustration are CSS placeholders (same convention as `homepage`).

## New components to promote to the library (follow-up)

`.gv-phases` (timeline/stepper + panel) and `.gv-accordion` are genuinely reusable —
promote to `components/phase-timeline/` and `components/accordion/` (+ `govocal-ui.css`,
`components.md`, `manifest.md`, `npm run index`) after the page is verified. `.gv-projbar`
/ `.gv-projhead` / `.gv-banner` are project-page chrome — promote if a second page needs them.
</content>
