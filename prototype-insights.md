# Prototype Insights — cross-loop memory

> ⚠️ INTERNAL ONLY. Lives at repo root, OUTSIDE any `prototypes/` folder, so
> `build.js` never copies it to `/dist`. This is the running log of the overnight
> improvement loop: what was questioned, changed, learned, and queued. Newest loop
> entries at the BOTTOM of the Loop Log. Read this first every loop.

Started: 2026-06-16 (overnight unattended improvement run).

---

## Prototype map (as of orientation)

| Opportunity / Prototype | State | What it is | Verdict at orientation |
|---|---|---|---|
| **parallel-participation / parallel-editor-builder** | strong flagship (4179 lines, 6MB, 48 files) | BO project editor with a live phone/window preview of the resident Project Page; FRAME/Phone/Window + Empty/Few/Complex state toggles; device-agnostic frame | The best prototype here. Polished, clickable, on-brand. Deserves depth + a clear "what is it proving" framing. |
| **parallel-participation / full-parallel-build** | ⚠️ messy/superseded | NO index.html. Two unrelated files: `govocal-prototype.html` (older dupe of the editor, uses a non-device-agnostic phone notch) + `content-builder.html` (a distinct Content Builder "EAB betting tables" surface) | Entry point resolves to `content-builder.html` (alphabetical) → the card opens the wrong file. Needs a decision: retire the stale dupe, promote content-builder to its own clean folder. |
| **sms-verification / phase-access-permissions** | dev-ready | Faithful rebuild of the REAL epic phase access-rights tab (card "Who can participate" + verification + groups + collect) | The truthful baseline. This is what the others simplify against. Keep faithful. |
| **sms-verification / access-rights-explorations** | in-progress | 6 wild simplifications of the access tab (Sentence/Presets/Slider/Wizard/Live + a Recommended E2×E5 synthesis), off-design-system `.ax-*`, floating switcher + live resident phone | Rich idea bank. The "Recommended" synthesis is the real candidate. |
| **sms-verification / access-rights-explorations-v2** | not in status.json | "Share this phase" — a single cleaner take (General access + per-action + "When people join, we collect…") | A refinement of the explorations; reads as the maturing direction. Not surfaced with a chip. |
| **sms-verification / phase-access-inspector** | not in status.json (newest, 22:33) | Per-action left rail + detailed config panel inspector | Another serious take. Not surfaced with a chip. |
| **sms-verification / hello-world** | ignore | placeholder stub | Dead. |
| **departments / department-spaces** | in-progress (but is a stub) | 26-line hello-world placeholder | Never built. No research.md/context.md for the `departments` opportunity at all. |
| **departments / sms-verification** | in-progress (but is a stub) | 26-line hello-world placeholder; name collides with the sms-verification opportunity | Dead + confusing. |

## Cross-cutting observations (orientation)

1. **The access-rights theme is over-forked.** Four substantive prototypes
   (`phase-access-permissions`, `access-rights-explorations`,
   `access-rights-explorations-v2`, `phase-access-inspector`) all attack the SAME
   surface — the phase "access and user data" tab. That's legitimate divergent
   exploration, but there's no signal for which is the leading direction, and two of
   them have no status chip. Needs a convergence verdict.
2. **`full-parallel-build` is structurally broken** as a card (no index.html; opens
   content-builder.html). Either fix or retire.
3. **`departments` is an empty opportunity** — two hello-world stubs, no research/
   context. Either seed it with a real idea or drop the dead stubs from the build.
4. **Naming collision**: `departments/prototypes/sms-verification` vs the
   `sms-verification/` opportunity. Confusing in the UI and on disk.
5. The flagship `parallel-editor-builder` is the one prototype clearly worth
   compounding on. Everything else is either exploration sprawl or stubs.

---

## PLAN / QUEUE / DONE

### DONE
- Orientation pass: read CLAUDE.md, GOVOCAL.md, all research/context, rendered every
  prototype headless, built the map above.

### QUEUE (prioritized — rotate, don't fixate)
1. **Fix `full-parallel-build`**: retire the stale `govocal-prototype.html` dupe;
   give `content-builder.html` a proper home + index.html so its card opens the right
   thing (or fold it into a clean folder). [structural, high-value, low-risk]
2. **Converge the access-rights cluster**: judge the four variants against the real
   baseline + the research patterns; pick/declare a leading direction; tidy status
   chips; consider merging the best ideas into one canonical "simpler access" take.
3. **`departments` opportunity**: decide — seed one real prototype (e.g. a
   department-scoped workspace, per the BO architecture notes on Spaces) or remove the
   dead stubs so the landing isn't padded with placeholders.
4. **Deepen `parallel-editor-builder`**: interrogate the core bet (one project, the
   parallel-methods question), tighten the resident-preview fidelity, a11y pass.
5. **a11y sweep** across all live prototypes (`npm run audit`), fix muted-grey fails.
6. Eyeball each access-rights variant's interaction depth (clicking, not just the
   landing screenshot) and fix dead controls.

### Guardrails reminder
- Never publish internal files; keep new notes outside `prototypes/`.
- Prototypes are self-contained: copy govocal-* assets in, no server needed.
- Prototype mode = looks/behaves like GoVocal, NOT linter-clean. Don't run the
  architecture linter against prototypes.
- After live-site changes: `node build.js` → `npm run deploy` → commit (stage only my
  paths, never `git add -A`).

---

## Loop Log

### Loop 1 — 2026-06-16 ~23:40 · Structural cleanup (parallel-participation)
- **Questioned:** why does `full-parallel-build` exist alongside the flagship
  `parallel-editor-builder`, and why does its card open a content-builder file?
- **Found:** folder had no `index.html` → gallery card mis-linked to
  `content-builder.html` (alphabetical first). Both files superseded — `govocal-prototype.html`
  is the flagship's predecessor (worse, notched phone frame); `content-builder.html`
  is a throwaway internal "EAB betting tables" scratch. Files were UNTRACKED (not
  git-recoverable).
- **Did:** moved the folder to `_archive/` (outside prototypes/, so unpublished;
  reversible) rather than deleting. Cleaned `prototype-status.json` (dropped dead
  entry; added missing chips for `access-rights-explorations-v2` +
  `phase-access-inspector`). Rebuilt → confirmed card gone. Deployed + committed.
- **Verdict:** parallel-participation now shows exactly one (strong) card. Good.
- **Queued:** the access-rights cluster still needs a convergence verdict (4 forks).
  The `departments` opportunity is still two dead hello-world stubs — needs a
  seed-or-retire decision in its own loop.

### Loop 2 — 2026-06-16 ~23:55 · Harden the access-rights lead (phase-access-inspector)
- **Questioned:** four prototypes attack the same access tab — which leads, and is
  the lead actually usable/accessible? Clicked through inspector + v2 source.
- **Found:** the **inspector** is the cleanest converged direction — per-action rail,
  set-all shortcut, stacking verification (SMS is first-class), mixed-state handling,
  plain-English outcome. Weaknesses: selected buttons lacked `aria-pressed`; the
  multi-select shift/⌘-click gesture was invisible.
- **Did:** added `aria-pressed` to the action rail + Access segmented control; added a
  rail hint ("⌘/Ctrl-click to pick several"); Select-all now toggles to Clear;
  disabled "Anyone" carries a title. Passes audit. Deployed + committed.
- **Verdict:** inspector is the lead access-rights direction. v2 ("Share this phase")
  is a nice reframe but denser; permissions = faithful baseline; explorations = idea bank.
  The gallery's recency order (inspector first) already tells the convergence story, so
  no destructive consolidation needed.
- **Queued:** consider lifting the inspector's two-pane pattern to a canonical
  `.gv-bo-insp*` family if a 2nd surface needs it (system-building mode).

### Loop 3 — 2026-06-17 ~00:20 · Seed the departments opportunity (real build)
- **Questioned:** departments was an empty opportunity (two hello-world stubs, no
  research/context). Seed a real prototype or retire?
- **Did:** built a real **Department spaces** back-office prototype — org roll-up
  stats, filter tabs, department-card grid, detail **drawer** (projects / team-with-LEAD
  / space settings incl. directory-sync + SSO toggles), New-space **modal**. Real
  `.gv-bo-*` chrome + tokens/icons, page-local `ds-*`, self-contained. Removed the dead
  `departments/sms-verification` duplicate stub. Seeded `departments/context.md` +
  `research.md` grounding the multi-department / Spaces / SharePoint-sync bet.
- **a11y lessons (durable):** (1) dimming a whole card with `opacity` drags muted
  secondary text below 4.5:1 — dim only the accent chrome, keep text full-contrast.
  (2) white text on vivid accent fills (coral/blue/green) often fails AA at small
  sizes — keep a separate *darkened* palette for anything bearing white text (avatars).
- **Verdict:** departments now has one strong, real card. Concept is credible
  (grounded in the real "Department Directors" group + Spaces sunset thread).
- **Queued:** a directory-sync mapping flow (Entra group → space team); a resident-facing
  department sub-site angle.

### Plan refresh (after Loop 3)
DONE: full-parallel-build retired · inspector hardened · departments seeded.
NEXT (rotate): 4) deepen flagship `parallel-editor-builder` (interrogate the core
parallel bet + fidelity + a11y). 5) eyeball interaction depth of `access-rights-explorations`
(6 takes) + `v2` for dead controls. 6) a11y sweep remaining live prototypes
(phase-access-permissions, explorations, v2, peb). 7) promote inspector pattern note.

### Loop 4 — 2026-06-17 ~00:40 · Flagship a11y fix + concept review
- **Questioned/found:** `parallel-editor-builder` is polished and its concept is sound
  (BO project editor + live resident Project-Page preview; "survey outside the timeline"
  is the parallel-participation hook) — no redo warranted. But its bespoke greys failed
  WCAG AA (2.5–3.9:1 on white).
- **Did:** darkened to two AA-passing tiers preserving hierarchy (secondary #5b6573,
  tertiary/example #656e7d). Look unchanged; passes audit. Deployed + committed.
  Promoted the two contrast traps to agent memory ([[a11y-contrast-pitfalls]]).
- **Milestone:** ALL live prototypes now pass `npm run audit`.
- **Queued:** review interaction depth of the 6 access-rights-explorations + v2 for dead
  controls; consider an in-prototype "what this proves" line on the flagship (deferred —
  user prefers clean).

### ⚠️ SCOPE CHANGE — 2026-06-17 (user steer mid-run)
**User: "focus ONLY on the SMS verification opportunity, don't go beyond that."**
From now on, all loop work stays within `sms-verification/prototypes/` :
`phase-access-permissions` (faithful baseline), `phase-access-inspector` (lead),
`access-rights-explorations` (6 takes), `access-rights-explorations-v2`. `hello-world`
= ignore. Do NOT touch `parallel-participation/` or `departments/` again.
Already-deployed work in those (Loops 1/3/4) is complete + working — left in place
(reverting deployed working prototypes would be destructive); the user narrowed
*future* focus, didn't ask for a teardown.

### Loop 6 — 2026-06-17 ~01:30 · NEW lead: access-rights-simple (post-steer focus)
- **Per the user's two steers** (sms-verification only; make an amazing, 14yo-clear
  admin experience for this complex topic; skip mobile/keyboard-a11y), built a new
  definitive prototype `access-rights-simple`.
- **Design thesis (works):** PRESETS FIRST (one plain "How open is this phase?" with 4
  cards) + LIVE RESIDENT PHONE (shows the exact step-by-step journey, honest "N steps
  before they take part" counter — Open=0/instant, Team=blocked) + PROGRESSIVE
  DISCLOSURE (verification stacking w/ SMS first-class & purple-highlighted, per-action
  rules, data collection all hidden behind "Need finer control?"). Live one-sentence
  plain summary restates the setup.
- **Verdict:** this is the clearest of all the access-rights takes — lands the 14yo bar.
  Registered dev-ready; it's the new lead. Deployed + committed. Passes audit (bonus).
- **Gaps to close next:** (1) advanced copy mentions "specific groups" but the groups
  picker isn't built yet — build it or trim copy. (2) Add motion when a check is
  added/removed so cause→effect on the phone is felt. (3) Verify "Verified locals"
  preset state. (4) Consider a soft "more checks = fewer people finish" trade-off cue.

### Loop 7 — 2026-06-17 ~02:00 · access-rights-simple: groups + motion
- Built the "Limit to specific groups" control (plain toggle + chips; reflected in the
  live summary). Added a staggered slide-in to the phone steps so changes feel like
  cause→effect. Transform-only animation (no opacity fade) to avoid a transient
  contrast dip the audit caught. Deployed + committed.

### Loop 8 — 2026-06-17 ~02:20 · access-rights-simple: per-action phone preview
- **Critique that drove it:** with per-action rules on, the phone still showed only the
  phase default — contradicting "actions set differently" (a 14yo would be confused).
- **Fix:** phone gains action-preview tabs (Submit/Comment/Like/Attend) with a dot on
  any that differ; renders that action's real journey (e.g. open Comment = 0 steps while
  submit needs sign-in). Summary counts how many differ. Now the live-consequence promise
  holds in the advanced case too. Deployed + committed; passes audit.
- **access-rights-simple is now the definitive sms-verification deliverable.** Covers
  presets · verification stacking (SMS first-class) · groups · data collection ·
  per-action · live resident phone · plain summary. Clear enough for the 14yo bar.

### Consolidation note (for the user to decide — not auto-deleted)
The opportunity now has 5 access-rights takes. Recommended end state:
- **access-rights-simple** = THE experience (lead, dev-ready).
- **phase-access-permissions** = the real-product baseline (keep, for "before/after").
- **access-rights-explorations** = the 6-take idea gallery that led here (keep as journey).
- **phase-access-inspector** + **access-rights-explorations-v2** = earlier serious takes,
  now superseded by -simple. Candidates to archive once the user confirms -simple is the
  one. (Not deleted: -inspector was improved in Loop 2; leaving the call to the user.)

### Loop 9 — 2026-06-17 ~02:45 · honesty fix
- Renamed "Verified locals" → "Verified people" (its default check is SMS = phone
  control, not residency; the old name overclaimed). Keeps SMS central. Deployed.

### Loop 10 — 2026-06-17 ~03:00 · admin-anxiety reassurance
- Added a quiet "Saved automatically — nothing reaches residents until you publish"
  strip (grounded in Brigitte persona's top fear). access-rights-simple feels safe to
  explore now. Deployed. Next: independent critique pass for blind spots.

### Loop 11 — 2026-06-17 ~03:30 · acted on independent critique (see Loop 11 commit)
### Loop 12 — 2026-06-17 ~03:50 · trade-off framing + summary polish + full QA pass
### Loop 13 — 2026-06-17 ~04:05 · 'Reset to recommended' confidence affordance

## ═══ STATUS SUMMARY (as of ~04:10, 2026-06-17) ═══
**Scope (per user steers mid-run): sms-verification ONLY; goal = an amazing,
14yo-clear admin experience for the complex access-rights topic; mobile & keyboard-a11y
explicitly out of scope.**

### Biggest win
`sms-verification/prototypes/access-rights-simple/` — a new, definitive admin experience
for the phase "access & user data" tab. Presets-first + live resident phone (honest
step counter, real blocked view) + progressive disclosure (verification stacking with
SMS first-class; per-action rules with per-action phone preview; limit-to-groups; data
collection). Live plain-language summary, auto-save reassurance, trade-off framing,
reset-to-recommended. Went through an independent critique pass + full QA (all presets ×
verify stacks × per-action × groups; no console errors; passes `npm run audit`).
Deployed + dev-ready. **This is the deliverable.**

### Other sms-verification prototypes (UNTOUCHED beyond Loop 2/5; left for the user)
- `phase-access-permissions` (dev-ready) — faithful real-product baseline. Keep as the
  "before."
- `access-rights-explorations` — 6-take idea gallery (Loop 5 fixed the switcher overlap).
  Keep as the divergent-thinking journey.
- `phase-access-inspector` — power-tool "layers" take. **Was the user's most-recently-edited
  prototype (22:33, right before this run) → likely their ACTIVE work, so deliberately NOT
  archived/changed beyond Loop 2's a11y hardening.**
- `access-rights-explorations-v2` — intermediate "Share this phase" take.

### Consolidation recommendation (for the user — NOT auto-applied)
The opportunity now has 5 access-rights takes. If the user wants the clean single-experience
they asked for: keep **access-rights-simple** (answer) + **phase-access-permissions**
(baseline) + **access-rights-explorations** (idea gallery); consider archiving
**v2** and **inspector** once the user confirms they're done with the inspector.

### Known trade-offs in access-rights-simple (deliberate, for the 14yo bar)
- Per-action overrides set ACCESS LEVEL only (open/sign-in/team), not per-action
  *verification methods*. Phase-wide verification covers the common case; the power case
  (e.g. comments need email but submissions need SMS) is intentionally left to the
  faithful baseline / inspector to keep the simple experience simple.

### Out-of-scope work done EARLIER in the run (before the user's "sms-verification only"
steer), already deployed + working, left in place (reverting deployed work is destructive):
Loop 1 retired a broken parallel-participation card; Loop 3 built a departments prototype;
Loop 4 fixed flagship a11y. Not touched again after the steer.

### Loop 14 — 2026-06-17 ~04:40 · access-rights-simple: "live preview" label
- Re-examined access-rights-simple fresh; it's mature/complete. Made one genuine small
  clarity win: caption under the resident phone ("Live preview — updates instantly as you
  change the rules") so the interactive nature is explicit to a first-time/hesitant admin.
  Deployed + committed; passes audit.
- **Confirmed strong diminishing returns** within the narrowed scope (sms-verification
  only; access-rights-simple is the deliverable; can't touch the user's active inspector;
  other opportunities off-limits). Avoiding marginal changes that risk regressing a
  polished, deployed deliverable. Pacing the loop down to a long heartbeat; will re-check
  for new user direction and only ship further changes that are genuinely worth it.
- User is committing concurrently (front-office folder-avatar work) — no new direction for
  the sms-verification scope.
