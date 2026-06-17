# FigPal TRACE agent — brief

Replace the hand-drawn geometric cat with the **real FigPal art, traced from the
reference captures**, recolourable, with hats, at the **correct small size**, and
iterate (trace → render → compare) until it genuinely matches. Internal doc
(gitignored; never ships).

## Why this exists
The previous hand-authored SVG read as a slick symmetric *vector mascot*. The real
FigPal is a loose, squishy, hand-drawn doodle. We are now **tracing the genuine
artwork** (private, password-gated homage — never published) instead of redrawing.

## Tooling — use it, don't hand-author paths
`potrace` + `magick` (ImageMagick) are installed. Follow the layered-trace workflow:
1. **Assess**: `magick IN -format '%wx%h\n' info:` and sample tones with
   `magick IN -format '%[pixel:p{X,Y}]\n' info:`.
2. **Pre-smooth before tracing**:
   `magick IN -background white -flatten -colorspace Gray -filter Catrom -resize 400% -median 2 -blur 0x0.4 flat.png`
3. **Threshold into per-tone black-shape masks** (`-threshold T%`; darker→black).
4. **Layered potrace**, darkest first; lighter layers must EXCLUDE the dark shape's
   fringe. **GOTCHA: to grow a black core use `-morphology Erode` (Erode grows
   black). If a halo widens when you "grow more", you have it backwards.**
   `potrace mask.pgm -s --alphamax 0.9 --opttolerance 0.4 --turdsize 16 -o layer.svg`
5. **VERIFY by rendering, every time**:
   `magick -background white OUT.svg -resize 1200x render.png` and zoom crops; Read
   them and compare against the ORIGINAL zoomed. If a defect isn't in the source,
   it's from your pipeline.

Identical-dimension masks → identical potrace `transform`, so you can nest each
`<g transform=...>` (recoloured) in one shared-viewBox `<svg>`, darkest LAST (on top).

## Source captures (all in `pitis/reference/`)
- **`cat-sleep-heart-hi.png` (436×400) — PRIMARY trace target**: the iconic resting
  pink cat (+ heart bubble). Cleanest, highest-res.
- `04-pink-cat-heart-photobooth.png` — alt clean source of the same cat.
- `cat-sleep-small.png`, `_sticker-cat.png` — corroborate proportions.
- `creator-picker.png` (942×838) — the creator UI: the **9 official colour
  swatches** + a clean **top hat** on the capybara.
- `05-capybara-top-hat.png` — top hat (black, red band).
- `corgi-sleep.png` — **real orange body anchor** + same resting pose, different ears.
- `frame-05.png` (party-hat snake), `frame-08.png`/`frame-11.png` (purple wizard-hat
  snake) — hat sources. Sample more frames if needed:
  `ffmpeg -i 07-behavior-cursor-follow.mp4 -vf fps=2 f-%03d.png`.

## The cat: trace it RECOLOURABLE (not baked pink)
The resting cat decomposes into flat tones: black outline+features, main fur,
lighter belly/face patch, darker stripes/inner-ear, soft blush, the heart brow-mark.
Trace these as **separate layers** and fill each via a swappable colour so the same
silhouette repaints into any palette:
- `outline` (the darkest mask: outline + eyes + nose) → stays near-black `#241d29`.
- `fur` (full silhouette) → `var fur`.
- `belly` (the lighter face/belly patch) → `var belly`.
- `stripes`/inner-ear (the darker tone) → `var dark`.
- `blush` (two cheek ovals) → `var cheek` (semi-opacity).
- `heart` brow-marking → `var dark` (or `cheek`).
Keep the hand-drawn line — do NOT re-regularise it into clean geometry.

## Colours — real hues (the user explicitly wants ORANGE and BLACK)
Bodies are PALER/softer than the selector swatches (the capybara body is a pale
olive, not the saturated swatch). Anchor from real art, then derive the rest by
lightening/desaturating each swatch hue consistently:
- **Official swatches** (sampled from `creator-picker.png`): red `#D05555`,
  orange `#EFA254`, yellow `#F1D86D`, olive `#98AE65`, blue `#91BAD0`,
  purple `#B581D2`, magenta `#DB76C4`, gray `#9B9B9B`, charcoal `#414141`.
- **Pink (Blossom, default)** — match the real cat: light fur ≈ `#F9D6EE`,
  darker/stripe ≈ `#EF9BDA`, blush pinkish, pale belly. Trace-sample to confirm.
- **Orange** — anchor to the real corgi body `#E79A41` (fur), lighter belly, warm
  blush. Must look great.
- **Black** — a dark **warm grey** body (≈ `#4F4A57`) with a lighter grey belly so
  it stays distinct from the black outline; keep the pink blush. Must look great.
- Include the other official hues as palette entries too (nice to have).

## Hats — trace ~3–4 real ones, attachable + optional
From the cleanest real sources, trace and position on the resting cat's head
(head sits low-left in the lying pose):
- **Top hat** (black + red band) — `creator-picker.png` / `05-capybara-top-hat.png`.
- **Wizard hat** (purple, star?) — the snake frames.
- **Beanie** — pufferfish/volleyball (hero/stickers).
- **Party hat** — `frame-05` / the cake in `01-hero-figpals.png`.
Make hat a config option (`none` + the traced set), selectable on the customize page.

## Size — the real pal is small (cursor-sized)
The shipped 76px was way too big. The live companion should read like a slightly-
larger-than-cursor friend: target **~46–50px** (make it one constant). The customize-
page portrait can be larger (~130–150px). Confirm by eye against the video.

## Implementation (don't break the contract)
Edit `pitis/piti.js` and `pitis/index.html`. Keep intact:
- `window.Piti = { PALETTE, svg, loadConfig, saveConfig, mount, auto, reveal, hide }`
  and `mount()`'s handle `{ el, destroy, refresh(override) }`.
- `svg(config, state)` still returns an SVG string. `config` now carries
  `{ name, furIdx, hat }`. `PALETTE` entries carry the per-colour fills.
- Wrapper stays `pointer-events:none`; keep `prefers-reduced-motion` + `auto()` gating.
- `build.js` injects `/piti.js` already — don't change the wiring. `node build.js`
  must stay green.
Behaviour: the resting cat trails the cursor with a gentle glide + soft bob; faces
travel direction (source faces LEFT — flip scaleX for right) with a smooth flip (no
vanish-through-zero); when idle a while it just stays curled (optionally a faint zzz
and/or the occasional heart bubble — keep subtle). Update `index.html` to add a hat
picker and ensure the orange + black swatches are present and obviously selectable.

## Loop until it matches
trace → assemble recolourable SVG → render at ~48px AND large → **Read both and
compare side-by-side to `cat-sleep-heart-hi.png`** → fix the named gap → repeat.
Then sanity-check every colour (esp. pink/orange/black) and each hat renders cleanly.
Acceptance: a stranger would say "that's the FigPal cat," at the right small size,
recolours correctly to orange & black, hats sit right, motion is smooth, build green.

## Done
- `node build.js`, `npm run deploy`, capture the URL.
- Commit ONLY your paths (`pitis/piti.js`, `pitis/index.html`; `build.js` only
  if touched) to `main`, clear message + trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  Never `git add -A` (shared checkout). `reference/` is gitignored — leave scratch there.
- Report: before/after, per-pass fixes, which colours/hats shipped, final fidelity
  estimate, deploy URL, anything still short.
```
```
