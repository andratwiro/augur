# Pitis — the pets bible (handoff doc)

Everything about the **pitis** (our private cursor-pet layer) and the real animals
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

### Senda — Spanish mastiff  ·  SPECIES `mastiff`  *(re-traced from a clean flat-tone illustration)*
- **Real:** big fawn/tan mastiff, curled tightly asleep. Dark-brown muzzle **mask**,
  droopy dark-brown **ears**, furrowed **brow**, closed sleepy eyes, dark nose, pink
  **blush** cheeks, faint tabby **stripe ticks** on the haunch, and a **black harness**
  strap with a loop across the shoulder. Compact curl (head low-left on the front paws,
  body curving up-right, tail curling back along the bottom).
- **Ref:** **the Senda illustration in `reference/` (756×534, local-only)** — a CLEAN
  flat-tone illustration (not a photo). Because the tones are flat/separable, the proper
  **layered-potrace pipeline works** (no guide-mask hack — that was the previous, weaker
  attempt, now replaced).
- **Piti:** species **`mastiff`** in the resting curl. **≥30% bigger than the cat**
  (~1.35×). Third species tab; wears hats via `HAT_T_MASTIFF`. **Three TRACED layers**
  in one shared potrace frame **3024×2136** (`MTT = translate(0,2136) scale(0.1,-0.1)`),
  all from that Senda illustration with the green grass oval dropped (the stage draws its own):
  `MASTIFF_P.sil` = full body silhouette → fawn fur (derived by **flood-filling the
  interior of the outline line-art**, NOT by tone-thresholding — a threshold mask let the
  grass-oval footprint leak in as a fawn "floor" slab under the dog; filling the closed
  outline excludes the grass by construction); `MASTIFF_P.brown` = dark-brown
  mask + droopy ears + brow ridge + haunch stripe ticks (clipped to sil); `MASTIFF_P.outline`
  = the chunky near-black hand-drawn line — body contour, **closed-eye arcs + nose + brow
  furrow** (baked in), the **black harness** strap + loop, paw lines — drawn on top.
  The pink **blush** has no hard edge so it's positioned (`blushL/R` ovals, upright frame,
  clipped to sil). **Awake** = fawn lids painted over the eye area + open round eyes
  (`eyeL/R`). Pipeline: flood-fill the grass → silhouette mask; threshold bands
  (<13% black harness/nose, 13–55% brown mask/ears, <30% the outline line-art) → potrace
  each at the SAME dims so one transform maps them. **CLIP GOTCHA:** transform on the
  `<path>` inside `<clipPath>`, never a wrapping `<g>`. Fixed "Senda" look (ignores the
  recolour palette; `PALETTE` "Senda" carries fur `#CE9D66`, brown mask `#5F4F40`,
  blush `#E4AC93`, line `OUT`). Scratch trace harnesses live in `reference/_*` (gitignored).

### Originals still present
- **Cat** (default species) — traced from the reference sleeping-cat art; default
  colour is now Aslam. Cat picker holds **two cats**: Aslam (bicolor) then Pruna (tabby).
- **The corgi/dog species was removed** — **Senda replaces it**, so the whole lineup
  is now just **the two cats + Senda the mastiff**. The traced corgi paths (`DOG_P`),
  `dogMarks`, `DTT` and `HAT_T_DOG` are gone from `piti.js`; `loadConfig` migrates any
  saved `species:'dog'` config to `'mastiff'` so old adopters land on Senda. The corgi
  reference (`corgi-sleep.png`) stays as history.

## Architecture (how a piti is made)
- **`piti.js`** = the whole engine. `window.Piti = { PALETTE, HATS, svg, loadConfig,
  saveConfig, mount, auto, reveal, hide, toggle, refreshLive }`. `config = {name,
  furIdx, hat, species}`. Traced potrace paths per species (`P` cat, `MASTIFF_P`
  mastiff). `petBody(species,…)` assembles; `svg(config,state)` renders.
  Markings = `normalMarks` / `bicolorMarks` (Aslam) / `tabbyMarks` (Pruna), drawn
  **clipped to the silhouette**. **CLIP GOTCHA:** put the transform on the `<path>`
  inside `<clipPath>`, never a wrapping `<g>` (Chrome silently mis-clips otherwise).
- **Per-pet patterns are cat-only**, guarded in `petBody` + filtered in the
  customizer's `colourIndices()` (`index.html`). Aslam sorts first.
- **Hats:** `HAT_T_CAT` / `HAT_T_MASTIFF` place hats on each crown
  (measured off coordinate-grid renders). 5 hats: sprout, top hat, wizard, beanie, party.
- **Behaviours:** eased cursor-follow + catch-up; idle→sit→sleep("z"); pop-in;
  startled hop + "!" on clicking links/cards; sweat "running" + **after-image trail**
  on big fast moves (`dist > 165`); **custom arrow cursor** while active (`html.piti-cursor`).
- **Wiring (`piti.build.js`, an optional addon `build.js` loads):** copies `pitis/` →
  dist, injects the loader into the shell + every prototype (skips preview iframes),
  adds the footer paw. The paw opens the **customizer as an overlay modal** over the
  dimmed site (`piti.js openModal()` → iframe of `/pitis/`); it **auto-saves** every
  change and closes on **click-outside / Esc**. **Shift+Ñ** toggles the piti anywhere.
- **Self-contained:** nothing outside `pitis/` references it except one optional
  `import` in `build.js`. Keep it that way.

## Roast mode (the talking piti)
A **terminal agent** can drive the cat as a live design wingman ("roast mode"): it reads which prototype
you're on and, now and then, the cat **walks to an element, says one short UX/a11y remark,
waits ~3–5s, then returns to the cursor**. Voice = an advocate for people with **low
comprehension for screens** (the nervous first-timer, not the power user); bold but always
true. **Live only · prototypes + `/playground/` only · only while active (Shift+Ñ).**
- **Bridge:** `src/_worker.js` `pitiApi()` → `/__piti`, KV keys `pt:view` (browser → what
  it's viewing) + `pt:remarks` (agent → quips, id = `Date.now()`, pruned at 3 min). Browser
  ops open; agent read-view/write-remark reuse `REVIEW_EXPORT_KEY` (no new secret). This is
  the one out-of-`pitis/` touch, and the worker already names piti (`/piti.js` whitelist), so
  it's consistent — keep all *logic* in `pitis/`.
- **Client:** wingman channel inside `piti.js` `mount()` — `isCommentable()`, `publishView()`,
  `pollRemarks()`, `startComment()` and a travel→speak→dwell→return state machine in `frame()`;
  worded bubble `.piti-says` (resolves the target by CSS selector, falls back to rescaled
  viewport coords). Cleaned up in `destroy()`.
- **Agent brief:** `pitis/roast-agent.md` (persona, low-comprehension checklist, the loop,
  cadence/restraint, the full `/__piti` payload). Run from an agent terminal while building.

## Working discipline (do not skip)
- **Verify every visual by rendering with headless Chrome and Read-ing the PNG
  against `reference/*` — never eyeball-grade your own SVG.** Reuse the `reference/`
  harnesses. Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2
  --window-size=W,H --screenshot=OUT.png "file://ABS.html"`.
- Free-mode design craft — load the default space's `skills/frontend-design/SKILL.md`; no
  `.gv-*`, no space UI kit. `node build.js` must stay green. Commit only `pitis/` paths to `main`
  (never `git add -A`) with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer;
  after live changes `npm run deploy` and report the URL.

## Recipe — adding a new pet
- **New cat colour/marking:** add a `PALETTE` entry + a marks function (cat-only),
  slot it into the picker order. Model real anchors off the photo (sample with magick).
- **New species:** trace the resting pose from a photo (the layered-potrace pipeline
  described for Senda above), add a `petBody` branch + species tab + `HAT_T_<species>` + size.
- Always render-compare against the reference in a loop until it reads as the animal.

## Pending / TODO
- ~~Cursor 30% smaller~~ — done (`CURSOR_SVG` 21×21, hotspot `5 3`).
- More pets welcome (more cats, etc.) — follow the recipe.

## References & docs
- `reference/` (gitignored, never shipped): `aslam-*`, `mycat-*`, `pruna.png`,
  `senda-1/2.png`, `corgi-sleep.png`, pose reference imagery, the behaviour clip
  + frames, cursor refs (`_cur31*`), plus scratch render harnesses (`_*.html`/`_*.png`).
- Docs: `README.md` (current state), `research.md` (design research + interaction
  catalogue), build brief `senda-pruna-agent.md`.
