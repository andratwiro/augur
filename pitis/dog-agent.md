# FigPal DOG + picker-revision agent — brief

Add a **dog** species (traced, same style as the cat) and revise the customizer to
the real FigPal-creator layout: **species (cat/dog) on top**, the **four chevrons
cycle hats (top pair) and colour (bottom pair)**. Internal doc; never ships.

## Repo + tooling
Work in `/Users/rob/Documents/go-vocal-prototypes`. `potrace` + `magick` + headless
Chrome are installed. Engine = `pitis/piti.js`; customizer = `pitis/index.html`.
`node build.js` must stay green. Commit only your paths to `main` with the
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer; never
`git add -A` (shared checkout). After finishing, `npm run deploy` and report the URL.
`pitis/reference/` is gitignored — scratch renders there are fine.

## How the cat works today (your template — study piti.js first)
- `const P = { sil, outMain, eyeL, eyeR, nose }` are **potrace paths** (viewBox-ish
  1744×720) drawn via `TT = translate(0,720) scale(0.1,-0.1)`. `sil` = recoloured
  silhouette (fur); `outMain` = the hand-drawn outline; eyes/nose on top.
- `catBody(c, awake, hat)` assembles: silhouette (fill `c.fur`) → clipped markings
  (`normalMarks`/`bicolorMarks`) → outline+nose → eyes → `hatSVG(hat)`.
- `svg(config, state)` fits it into a 100×100 viewBox and is the public render fn.
- `PALETTE` (shared colours) + `HATS`. Hats are positioned on the cat crown via
  `HAT_T = translate(140,-82)` (measured off a coordinate-grid render).
- **CLIP GOTCHA (already fixed for the cat — keep it):** inside `<clipPath>`, put the
  transform DIRECTLY on the `<path>` (`<clipPath><path TT d=.../></clipPath>`), NOT on
  a wrapping `<g>` — Chrome only partially honours the `<g transform>` form.
- The pal trails the cursor in the RESTING pose; `awake` just opens the eyes.

## Task 1 — trace the DOG (resting pose, recolourable)
Source: **`pitis/reference/corgi-sleep.png`** — a real FigPal-style sleeping dog
(orange/white, head resting left, same orientation as the cat). Follow the same
pipeline that built the cat (it's documented in `pitis/trace-agent.md`):
crop → pre-smooth (`-filter Catrom -resize 400% -median 2 -blur 0x0.4`) → threshold
into an **outline** mask + a **full-silhouette** mask → `potrace` each (same frame so
transforms match) → assemble a recolourable dog: silhouette=`c.fur`, outline dark,
eyes/nose, plus clipped overlays (belly + blush; floppy-ear shading). The dog is
white-dominant ginger like the cat's Aslam pattern is optional — for v1 a plain
recolourable dog (one fur tone + belly + blush, droopy ears, snout) is enough.
**Verify by rendering with headless Chrome and Read-ing the PNG against
`corgi-sleep.png`** — loop until a stranger says "that's the FigPal dog." It must
sit at the same scale/baseline as the cat so it drops into the same frame.

## Task 2 — add a `species` concept to the engine
- `config` gains `species: 'cat' | 'dog'` (default `'cat'`; keep old configs working).
- Refactor so `svg(config,state)` picks the species' paths + markings. Suggested:
  keep the cat exactly as-is, add `DOG = { sil, outMain, eyeL, eyeR, nose }` and a
  `petBody(species, c, awake, hat)` that branches. Don't regress the cat.
- `PALETTE` stays shared (colours apply to both). The **"Ginger & white" bicolor is
  cat-only** (it's Aslam) — guard it so it only patterns the cat; the dog uses the
  flat fills (or its own simple pattern if you have time).
- **Hats per species:** the dog's crown sits differently — measure it with a
  coordinate-grid render (like the cat) and give the dog its own hat transform
  (e.g. `HAT_T_DOG`); `hatSVG` should accept/lookup the per-species offset.
- Keep the public API intact and ADD nothing breaking:
  `window.Piti = { PALETTE, HATS, svg, loadConfig, saveConfig, mount, auto, reveal,
  hide, toggle, refreshLive }`. `loadConfig` must default `species:'cat'`. `mount()`'s
  handle `{el, destroy, refresh}` and the `pointer-events:none` / reduced-motion /
  `auto()` iframe-skip behaviour must all stay.

## Task 3 — revise the customizer (`pitis/index.html`) to match the creator
Reference: the real FigPal creator (grass stage, 4 chevrons, swatch row, name box).
- **Top pill = species**: cat / dog tabs (draw small cat & dog face icons), selected =
  white/raised. Switching species re-renders + `Piti.refreshLive(cfg)`.
- **Stage**: the pet on the green grass oval, with **four chevron buttons** (‹ › top,
  ‹ › bottom) like the reference. **Top pair cycles HAT** (prev/next through
  `Piti.HATS`, wrap-around); **bottom pair cycles COLOUR** (prev/next through
  `Piti.PALETTE`, wrap-around).
- Keep the **colour swatch row** below (direct pick; selected = purple ring; Aslam's
  two-tone gradient swatch only shows when species=cat, since it's a cat pattern).
- Keep the **name box** + **Save** (Save persists, sets `piti-revealed`, calls
  `Piti.auto()` + `Piti.refreshLive(cfg)`). Keep the Shift+Ñ hint line.
- The page loads its own `piti.js` (so build's injector skips it — don't add a
  second loader).
- **No title, no subtitle** — remove the "Customize your FigPal" heading and the
  "A little friend…" subtitle. Just the creator itself (pill → stage → swatches →
  name → Save), matching the reference screenshot exactly.

## Loop / acceptance
trace → render (headless Chrome, ~48px AND large) → Read + compare to the reference →
fix the named gap → repeat. Done when: the dog reads as a faithful FigPal dog in the
resting pose, recolours across all `PALETTE` hues, wears all hats correctly (measured,
not guessed); the cat is unchanged; the picker matches the creator (species tabs +
chevrons cycling hat/colour + swatches + name + Save); `node build.js` green; deployed;
committed (piti.js + index.html only). Report before/after, per-pass fixes, fidelity
estimate for the dog, the deploy URL, and anything still short.
