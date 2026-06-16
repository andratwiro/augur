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
