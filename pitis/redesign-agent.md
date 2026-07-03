# FigPal redesign agent — prompt

A ready-to-run brief for a fresh agent. Goal: iterate the FigPal sprite + motion
until it's ~99% faithful to the real Figma FigPals in **style, animation, and
smoothness**. Internal doc (gitignored from dist; `.md` never ships).

---

## PROMPT (paste this to the agent)

You are improving **FigPal**, a cursor-following companion in this repo
(`/Users/rob/Documents/govocal-split/augur`). It already works; your job is a
**quality loop** — make it look and move ~99% like Figma's real FigPals. This is
a Free-mode design-craft task (not GoVocal product UI): load
`spaces/go-vocal/skills/frontend-design/SKILL.md` for craft, ignore the govocal-ui system.

### Ground truth — STUDY THESE FIRST (do not skip, do not work from memory)

Real reference imagery + behaviour live in `pitis/reference/` (internal, never
shipped). **Use the Read tool to actually look at each image** before changing
anything, and again after each pass:

- `04-pink-cat-heart-photobooth.png` — **THE canonical look**: the iconic sleeping
  pink cat + heart speech bubble. Thick even black outline, flat pastel fill,
  lighter belly, darker stripes, blush cheeks, heart brow-marking, curled tail.
- `01-hero-figpals.png`, `06-figpal-stickers.png` — the art language across many
  pals (line weight, corner rounding, face proportions, flat fills).
- `05-capybara-top-hat.png` — the real creator UI (for reference only).
- `07-behavior-cursor-follow.mp4` (35s) + `frame-01..12.png` — **the real
  behaviour**: how it trails the cursor, walks, idles, rests. Sample more frames
  if useful: `ffmpeg -i 07-behavior-cursor-follow.mp4 -vf fps=2 f-%03d.png`.
- `pitis/research.md` — written findings (style + behaviour breakdown).

Take the reference seriously: outline weight is **consistent and chunky**, fills
are **flat** (no gradients on the body), faces are simple (dot/closed eyes, tiny
nose, small mouth), every pal reads as a friendly hand-drawn sticker.

### What you're editing

- `pitis/piti.js` — **the engine** (single source of truth). Contains the
  `PALETTE`, the SVG generators (`svgUpright`, `svgSleep`), `svg()`, the
  `mount()` follow/animation state machine + injected CSS keyframes, and
  `auto()`/`reveal()`/`hide()`.
- `pitis/index.html` — the adopt/customize page (uses the engine).
- `build.js` injects `/piti.js` into every shell page via `Piti.auto()` and
  copies the engine to the dist root. **Don't change the wiring.**

**HARD CONSTRAINTS (do not break — other code depends on them):**
- Keep the public API intact: `window.Piti = { PALETTE, svg, loadConfig,
  saveConfig, mount, auto, reveal, hide }`, and `mount()`'s return handle
  `{ el, destroy, refresh(override) }`.
- The companion wrapper stays `pointer-events:none` (must never block site UI).
- Keep `prefers-reduced-motion` handling and the reveal-gating (`auto()`).
- Self-contained, no new dependencies, no network. `node build.js` must pass.

### The loop (repeat until acceptance)

1. **Look** — Read the reference image(s) for whatever you're working on, and
   Read your current render (below) side by side. Name the specific gaps.
2. **Render your sprite** — there's a harness at
   `pitis/reference/_sprite-test.html` (loads `../piti.js`, lays out states).
   Screenshot it headless and Read the PNG:
   ```
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
     --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
     --window-size=600,460 --screenshot=pitis/reference/_sprite-shot.png \
     "file:///Users/rob/Documents/govocal-split/augur/pitis/reference/_sprite-test.html"
   ```
   Extend the harness to show every state (sit, blink, sleep) and a few palettes.
3. **Check motion** — static shots won't reveal jitter/easing. Build a motion
   harness (`_motion-test.html`) that calls `Piti.mount()` then synthesises a
   path of `pointermove` events (e.g. a lissajous/figure-8 via `setInterval`
   dispatching `new PointerEvent('pointermove',{clientX,clientY})`), and capture
   a burst of timed screenshots (or `--screenshot` at several `setTimeout`s) to
   inspect: follow lag, overshoot, facing-flip, walk-bob, and the
   walk→sit→blink→sleep transitions. Read the frames.
4. **Refine** — adjust SVG geometry/colours and the easing/animation. Typical
   levers: outline `stroke-width` consistency, fill flatness, ear/head/body
   proportions vs `04`, blush/heart placement, tail curl; and for motion: the
   `pos += d * k` lerp factors, the bob keyframe, idle timings, the
   facing-flip threshold/transition (add a smooth scaleX tween so it doesn't snap).
5. **Re-render, re-Read, score** — repeat. Each pass must visibly close a named
   gap. Log what changed and the new score estimate.

### Acceptance — "~99% there"

Style (vs `04`/`01`/`06`):
- [ ] Outline is one consistent chunky weight, rounded joins/caps, no thin spots.
- [ ] Body fills are flat pastel; belly lighter; stripes/heart in the darker tone.
- [ ] Face reads friendly & simple; blush cheeks; proportions match the reference.
- [ ] Sleeping pose reads as a content curled nap that recalls `04` (not lumpy/sad).
- [ ] All 8 palettes look good (esp. the dark "Shadow" — eyes/face stay legible).

Motion (vs the video):
- [ ] Follows the cursor with smooth lag — no jitter, no rubber-banding, no snap.
- [ ] Facing flips smoothly (tween, not an instant mirror) and only when warranted.
- [ ] Walk bob looks like trotting, not vibrating; stops cleanly when it arrives.
- [ ] Idle → sit → occasional blink → sleep transitions are gentle and well-timed.
- [ ] 60fps-smooth on a normal page; CPU reasonable; respects reduced-motion.
- [ ] Never blocks clicks; survives `figbye`/`figpal`; `node build.js` is green.

### When done

- Remove scratch harnesses you added under `reference/` if they're throwaway
  (keep `_sprite-test.html`/`_motion-test.html` if useful — `reference/` is
  gitignored and never ships).
- `node build.js`, then `npm run deploy`, report the URL.
- Commit only your paths (`pitis/piti.js`, `pitis/index.html`, and
  `build.js` if touched) to `main` with a clear message + the repo's
  `Co-Authored-By` trailer. Never `git add -A` (shared checkout).
- Summarise: before/after, what each pass fixed, final score, anything left <100%.
