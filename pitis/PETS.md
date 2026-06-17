# Pitis — the pets bible (handoff doc)

Everything about the **pitis** (our private FigPals homage) and the real animals
they're modelled on, so a fresh agent can continue without re-deriving anything.
Internal — never ships. Companion engine lives entirely in `pitis/` (see README.md).

## The animals (real → piti)

### Aslam — ginger-&-white cat  ·  CAT pattern `bicolor` (cat-only)
- **Real:** white-dominant ginger bicolor. Orange cap over the head + ears, orange
  patches on the back (shoulder + rump), ginger tail, **white face with a forehead
  blaze**, white chest/belly/legs, pink nose. Refs: `reference/aslam-*.png`,
  `reference/mycat-*.png` (`mycat-face/back/sit/yawn`, `cat-sleep-heart-hi`).
- **Piti:** `PALETTE` entry **"Ginger & white"**, `pattern:'bicolor'`, cat-only.
  Drawn by `bicolorMarks()` in `piti.js` (white base fur + clipped ginger patches +
  pink nose + white blaze). **Aslam is FIRST in the cat colour picker.**

### Pruna — grey/brown tabby cat  ·  CAT pattern `tabby` (cat-only)  *(added by the Senda+Pruna agent)*
- **Real:** brown-grey **mackerel tabby**. Warm grey-brown base, darker brown/black
  mackerel stripes (vertical ribs down back/sides), cream belly + chest, tabby
  forehead "M", dark tail rings, pinkish nose. Ref: `reference/pruna.png`.
- **Piti:** `PALETTE` entry **"Pruna"**, cat-only pattern; **replaces the cat's plain
  grey**. Second in the cat picker (after Aslam). Anchors used: fur ~`#9C8C76`,
  stripe ~`#4A4038`, belly ~`#D9CDB6`. (Confirm exact values in `piti.js`.)

### Senda — Spanish mastiff  ·  SPECIES `mastiff`  *(added by the Senda+Pruna agent)*
- **Real:** big fawn/tan mastiff. **Black mask over the muzzle/face, black droopy
  ears, dark "saddle" shading along the back**, lighter tan chest/legs, dark nose,
  jowly. Lying/sploot. Refs: `reference/senda-1.png`, `reference/senda-2.png`.
- **Piti:** new species **`mastiff`** in the resting pose (head left), fawn body +
  black mask + droopy ears + jowls. **≥30% bigger than the cat.** Third species tab;
  wears hats via `HAT_T_MASTIFF`. **Her silhouette is TRACED (potrace) from `senda-1.png`**
  (flipped head-left) just like the cat/dog — the photo's terracotta floor matches her
  fawn fur so an auto-threshold can't separate figure/ground, so the body was traced from
  a clean *guide-mask* (painted over the photo, then potraced for the organic doodle line)
  rather than thresholded; `MASTIFF_P.sil` lives in the potrace y-flip frame (2360×1120,
  `MTT`). The dark regions (black **mask**, **near/far ears**, **saddle**, lighter
  **belly**) have no hard photo edge, so — exactly as the cat's belly/blush — they're
  authored UPRIGHT in the same frame and **clipped to the traced silhouette**. (Earlier
  she was a hand-authored blob; that was the bug — now she's traced.) Fixed "Senda" look
  (ignores the recolour palette).

### Originals still present
- **Cat** (default species) — the traced FigPal sleeping cat; default colour is now
  Aslam. **Dog** (corgi) — traced sleeping corgi; the plain **grey** is dog-only now.

## Architecture (how a piti is made)
- **`piti.js`** = the whole engine. `window.Piti = { PALETTE, HATS, svg, loadConfig,
  saveConfig, mount, auto, reveal, hide, toggle, refreshLive }`. `config = {name,
  furIdx, hat, species}`. Traced potrace paths per species (`P` cat, `DOG_P` dog,
  mastiff paths). `petBody(species,…)` assembles; `svg(config,state)` renders.
  Markings = `normalMarks` / `bicolorMarks` (Aslam) / `tabbyMarks` (Pruna), drawn
  **clipped to the silhouette**. **CLIP GOTCHA:** put the transform on the `<path>`
  inside `<clipPath>`, never a wrapping `<g>` (Chrome silently mis-clips otherwise).
- **Per-pet patterns are cat-only**, guarded in `petBody` + filtered in the
  customizer's `colourIndices()` (`index.html`). Aslam sorts first.
- **Hats:** `HAT_T_CAT` / `HAT_T_DOG` / `HAT_T_MASTIFF` place hats on each crown
  (measured off coordinate-grid renders). 5 hats: sprout, top hat, wizard, beanie, party.
- **Behaviours:** eased cursor-follow + catch-up; idle→sit→sleep("z"); pop-in;
  startled hop + "!" on clicking links/cards; sweat "running" + **after-image trail**
  on big fast moves (`dist > 165`); **Figma-style cursor** while active (`html.piti-cursor`).
- **Wiring (`piti.build.js`, an optional addon `build.js` loads):** copies `pitis/` →
  dist, injects the loader into the shell + every prototype (skips preview iframes),
  adds the footer paw. The paw opens the **customizer as an overlay modal** over the
  dimmed site (`piti.js openModal()` → iframe of `/pitis/`); it **auto-saves** every
  change and closes on **click-outside / Esc**. **Shift+Ñ** toggles the piti anywhere.
- **Self-contained:** nothing outside `pitis/` references it except one optional
  `import` in `build.js`. Keep it that way.

## Working discipline (do not skip)
- **Verify every visual by rendering with headless Chrome and Read-ing the PNG
  against `reference/*` — never eyeball-grade your own SVG.** Reuse the `reference/`
  harnesses. Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2
  --window-size=W,H --screenshot=OUT.png "file://ABS.html"`.
- Free-mode design craft — load `skills/frontend-design/SKILL.md`; no `.gv-*`, no
  govocal-ui. `node build.js` must stay green. Commit only `pitis/` paths to `main`
  (never `git add -A`) with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer;
  after live changes `npm run deploy` and report the URL.

## Recipe — adding a new pet
- **New cat colour/marking:** add a `PALETTE` entry + a marks function (cat-only),
  slot it into the picker order. Model real anchors off the photo (sample with magick).
- **New species:** trace the resting pose from a photo (pipeline in `dog-agent.md` /
  `trace-agent.md`), add a `petBody` branch + species tab + `HAT_T_<species>` + size.
- Always render-compare against the reference in a loop until it reads as the animal.

## Pending / TODO
- ~~Cursor 30% smaller~~ — done (`CURSOR_SVG` 21×21, hotspot `5 3`).
- More pets welcome (more cats, etc.) — follow the recipe.

## References & docs
- `reference/` (gitignored, never shipped): `aslam-*`, `mycat-*`, `pruna.png`,
  `senda-1/2.png`, `corgi-sleep.png`, official FigPal blog imagery, the behaviour clip
  + frames, cursor refs (`_cur31*`), plus scratch render harnesses (`_*.html`/`_*.png`).
- Docs: `README.md` (current state), `research.md` (real-FigPals research + interaction
  catalogue), build briefs `trace-agent.md` / `redesign-agent.md` / `dog-agent.md` /
  `senda-pruna-agent.md`.
