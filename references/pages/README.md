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
