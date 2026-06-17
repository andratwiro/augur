# Piti agent — add Pruna (tabby cat) + Senda (mastiff species)

Two new real-pet additions, in the existing traced doodle style. Internal doc.

## Repo + how it works (read first)
Work in `/Users/rob/Documents/go-vocal-prototypes`. Read **`pitis/README.md`** (current
state + architecture) and **`pitis/dog-agent.md`** (the exact potrace/magick pipeline
that built the dog species). Engine = `pitis/piti.js`; customizer = `pitis/index.html`.
`potrace` + `magick` + headless Chrome are installed. This is Free-mode design craft
(load `skills/frontend-design/SKILL.md`; do NOT pull govocal-ui). `node build.js` must
stay green. After finishing, `npm run deploy` and report the URL. Commit ONLY your
paths (`pitis/piti.js`, `pitis/index.html`) to `main` with the trailer
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; never `git add -A`.

**Key engine facts:** `svg(config,state)` renders a piti; `config = {name, furIdx, hat,
species}`. Species today = `cat` (default) + `dog` (corgi), via `petBody(species,…)`
and paths `P` (cat) / `DOG_P` (dog). Colours live in `PALETTE`; cat-only patterns are
drawn by `bicolorMarks` (Aslam) clipped to the silhouette and guarded so they only
apply to the cat. **CLIP GOTCHA:** inside `<clipPath>`, put the transform on the
`<path>` directly, not a wrapping `<g>`. Per-species hats use `HAT_T_CAT`/`HAT_T_DOG`.
The customizer's `colourIndices()` (in index.html) filters which swatches show per
species, and `HIDDEN_COLOURS` hides dropped colours. Cat currently shows **Aslam**
(ginger & white) + the grey; **Aslam must stay first**.

**VERIFY EVERYTHING by rendering with headless Chrome and Read-ing the PNG against the
reference photos — never eyeball-grade your own SVG.** Reuse harnesses in `reference/`.
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=W,H --screenshot=OUT.png "file://ABS.html"`

## Task 1 — Pruna: a grey/brown tabby CAT pattern (replaces the cat's grey)
Reference: `pitis/reference/pruna.png`. Pruna is a **brown-grey mackerel tabby**:
warm grey-brown base fur, **darker brown/black mackerel stripes** (roughly vertical
ribs down the back/sides), a **cream/buff belly + chest**, the tabby **forehead "M"**,
**dark rings on the tail**, a pinkish nose. Implement as a new **cat-only pattern**
(like Aslam's `bicolor` — add e.g. `pattern:'tabby'`) drawn clipped to the cat
silhouette: base fur recoloured grey-brown, plus stripe + belly + brow overlays.
Suggested anchors (tune against the photo): fur `#9C8C76`, stripe `#4A4038`, belly
`#D9CDB6`, nose pinkish. Add a `PALETTE` entry **"Pruna"** with a tabby-ish swatch.
Make the **cat picker show Aslam first, then Pruna** (drop the plain grey for cats; the
plain grey can stay for the dog). Keep Aslam unchanged.

## Task 2 — Senda: a new MASTIFF species (Rob's dog), ≥30% bigger than the cats
References: `pitis/reference/senda-1.png` + `senda-2.png`. Senda is a big **Spanish
mastiff**: heavy body, **long droopy ears**, **jowly muzzle**, lying/curled (sploot)
pose like the cat/dog. Her colouring: **fawn/tan body** (~`#C9A05A`), a **black mask
over the muzzle/face + black droopy ears + dark "saddle" shading along the back**,
lighter tan chest/legs, dark nose. Build her like the dog species was built (trace
from a clean rendering you compose, or hand-author in the same chunky-outline doodle
style — match the cat/dog line weight and the resting pose, head to the LEFT). Add a
new species **`mastiff`** to the engine (`petBody`), and a **third species tab** in the
customizer with a clean mastiff face icon (droopy ears + jowls). Senda's colour can be
a single fixed "Senda" look (fawn + black mask) rather than the full palette.
**Size:** the mastiff companion must render **at least 30% larger than the cat** on
screen — do this with a per-species size/scale (e.g. a species scale factor in `svg()`
fit, or a larger mount size when `species==='mastiff'`). She wears the hats too
(measure her crown like the dog; give `HAT_T_MASTIFF`).

## Acceptance
- Pruna reads as the grey/brown tabby in `pruna.png` (stripes + cream belly + brow M),
  cat-only, and the cat picker shows **Aslam then Pruna**.
- Senda reads as a fawn mastiff with black mask + droopy ears in the resting pose, is a
  selectable third species, wears hats correctly, and is **≥30% bigger** than the cat.
- Cat, dog, and Aslam are unchanged; `node build.js` green; deployed; committed.
- Report: before/after, per-pass fixes, fidelity estimates for Pruna + Senda, deploy URL.
