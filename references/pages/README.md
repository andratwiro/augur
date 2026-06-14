# Page source exports — intake (internal, never ships)

Raw GoVocal HTML exports + reference screenshots used to rebuild the **Pages** tab
reproductions. This whole `references/` tree is internal: it lives outside any
`prototypes/` folder and is in `build.js`'s `IGNORED_TOPLEVEL`, so it is **never
copied to `/dist`** and never reaches the public URL.

## How to add a page to the pipeline

For a page with slug `<slug>` (one of the `PENDING_PAGES` in `build.js`), create:

```
references/pages/<slug>/
  source.html      ← the raw HTML export from GoVocal (save the full page)
  screenshot.png   ← a full-page screenshot of the real page (desktop; mobile too if handy)
  notes.md         ← (Claude writes this) anatomy + component mapping + gaps
```

Then tell Claude the slug is ready. Claude runs the 5-step loop:

1. **Analyze** — read `source.html` against `screenshot.png`, break the page into
   blocks, map each to `LIBRARY.md` (Primitives → Components → Pages); write `notes.md`
   with a *reuse list* + *gaps* (new components needed).
2. **Build** — assemble `pages/<slug>/index.html` from existing components first; for
   each gap, build a new canonical component in `components/<name>/` (source-grounded,
   `--gv-*` tokens, themeable, a11y) and then use it — the library grows as we go.
3. **Verify** — screenshot mobile+desktop vs. the reference, `npm run audit`, report
   fidelity + a11y in chat.
4. **Land** — remove the slug from `PENDING_PAGES`, `npm run index`, rebuild.
5. **Deploy** — commit + push + `npm run deploy`.

## Capturing a NEW component (the visual loop — required for fidelity)

When a page needs a block we don't have, **don't hand-wave it inside the page**. Build
it as a real component with a tight screenshot-compare loop until it's ≥95% to the source:

1. **Crop the reference.** Use PIL to crop the exact block from the source PNG at full
   resolution (`im.crop((x0,y0,x1,y1))`) — don't judge from a full-page thumbnail.
2. **Scaffold `components/<name>/`** — copy the shared assets in; write an isolated demo
   `index.html` that renders ONLY the component, with realistic data + every state.
3. **Loop:** screenshot just the component (Playwright `element.screenshot`), build a
   **stacked composite** (reference on top, mine below, same width) with PIL, and eyeball
   the deltas — shape, proportions, colour, spacing, type, states. Fix the CSS. Repeat.
   Stop at ≥95%. (Keep the demo's CSS inline while iterating; promote when it's right.)
4. **Promote to canonical:** move the `.gv-*` rules into `skills/govocal-ui/govocal-ui.css`
   (never fork it from a prototype/page), strip the demo's inline copy, re-sync the
   asset into the component folder. Add a row to `components/manifest.md` + a snippet to
   `skills/govocal-ui/components.md`.
5. **Wire the page** to the canonical classes (delete the page's throwaway version).
6. **Verify + index:** `npm run audit`, `npm run index`, rebuild.

> Why: the first project-page pass shipped a circles-on-a-line timeline when the real
> one is a chevron-ribbon stepper — because it was eyeballed off thumbnails, not looped
> against a crop. The loop is what gets it from ~50% to ~95%.

## Notes

- These are Pages-tab **reference reproductions**, not interactive prototypes:
  **no cookie-consent banner, no persona critique** (both are prototype-scoped).
- Fidelity bar: **faithful, rebuilt in our system** — match layout/structure/content
  closely, but with clean `.gv-*` components + `--gv-*` tokens, not a DOM copy of
  GoVocal's markup.
- Pending slugs: `content-builder`, `project-page`, `input-form`, `survey-builder`,
  `perspectives`, `voting`, `common-ground`, `ideation`, `project-list`,
  `project-editor`.
</content>
</invoke>
