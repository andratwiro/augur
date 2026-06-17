# FigPal 🐾 (private)

A little companion that trails your cursor around the prototypes site — our homage
to Figma's [FigPals](https://www.figma.com/blog/finding-a-forever-home-for-figpals/),
the customizable pets they shipped for a limited "April Fun Week" 2025 and then took
away. This one doesn't leave.

Not a prototype, not a GoVocal thing — a private aside. It lives **outside any
`prototypes/` folder** so it's never a published link of its own.

## Summon / dismiss
- **Shift + Ñ** anywhere toggles the pal on/off. Remembered per-browser via
  `localStorage['figpal-revealed']` (there is **no** typed `figpal`/`figbye` secret
  anymore — that was removed).
- A quiet, Linear-styled **paw in the site footer** (built by `figpalPaw()` in
  `build.js`) opens the **customizer** at `/figpals/`.
- "Only-you" is lightweight: it only shows on browsers where you've toggled it.
  Prototypes are **public**, so a visitor who presses Shift+Ñ on a shared prototype
  also gets a pal (harmless easter egg). A real per-user gate (Cloudflare Access /
  login identity in `src/_worker.js`) is the someday option if we want it invisible
  to everyone else.

## What it does
- **Follows the cursor** — eased trailing follow with a catch-up boost and a smooth
  facing flip; it faces the way it's going.
- **Two species** — **cat** (default) and **dog** (corgi), both traced from the real
  FigPal resting pose. The pal only exists in the resting/lying pose; `awake` just
  opens the eyes (it's awake while travelling, sleepy when settled).
- **Recolour + hats** — 9 shared colours + a cat-only **"Ginger & white"** bicolor
  pattern (modelled on Rob's cat, **Aslam**). 4 hats: top hat, wizard, beanie, party.
- **Behaviours / emotions** — idle → sit → (after ~11s) sleep with a "z"; a **pop-in**
  when summoned; a **startled hop + "!"** when you click a link/card (a port of
  FigPal's detach-component surprise); a **sweat-drop "running"** state when it lags a
  fast cursor; the occasional heart.
- **Follows INTO prototypes**, not just the nav (see wiring below). Never blocks the
  UI (`pointer-events:none`), respects `prefers-reduced-motion`.

There is **no feeding and no photobooth** — both were prototyped early and removed.

## Where everything lives
- **`figpal.js`** — the whole engine (one source of truth). Exposes
  `window.FigPal = { PALETTE, HATS, svg, loadConfig, saveConfig, mount, auto, reveal,
  hide, toggle, refreshLive }`. Cat art = potrace paths `P.{sil,outMain,eyeL,eyeR,nose}`;
  dog art = `DOG_P` (+ its `DTT` transform). `petBody(species,…)` assembles a pal;
  `svg(config,state)` is the public render (config = `{name, furIdx, hat, species}`,
  defaults to cat). Markings = `normalMarks` / `bicolorMarks` (Aslam, cat-only),
  drawn clipped to the silhouette. `hatSVG(id, species)` positions a hat on the
  per-species crown (`HAT_T` cat / `HAT_T_DOG` dog, measured off grid renders).
  `mount()` = the trailing companion (returns `{el, destroy, refresh}`); `auto()` =
  site manager (mounts when revealed, wires Shift+Ñ, **skips inside iframes**).
- **`index.html`** — the customizer, mirroring the real FigPal creator: **species
  tabs (cat/dog)** on top, the pet on a grass stage with **four chevrons (top pair
  cycles hat, bottom pair cycles colour)**, a colour swatch row, name box, Save. No
  title/subtitle. Loads its own `figpal.js`.
- **`research.md`** — real-FigPal research: look, the full **interaction catalogue**,
  and an our-vs-real comparison. Internal (gitignored).
- **`reference/`** — source imagery, **gitignored & never shipped**: official FigPal
  blog images, the 35s behaviour clip + frames, the colour-picker capture, **Aslam's
  photos** (`aslam-*`, `mycat-*`), the **corgi** (`corgi-sleep.png`), plus scratch
  render harnesses (`_*.html` / `_*.png`).
- **Agent briefs** (`trace-agent.md`, `redesign-agent.md`, `dog-agent.md`) — the
  prompts used to build/iterate the art; useful history.

## Build / deploy wiring (in `build.js`)
- Copies `figpals/` → `/dist/figpals/` via `copyDir` with `skipFigInternal`
  (excludes `*.md` + `reference/`), and copies the engine to the dist root as
  **`/figpal.js`** so any page can load it by absolute path.
- `shell()` puts the **footer paw** (`figpalPaw()`) on every internal page and loads
  `/figpal.js` + calls `FigPal.auto()`.
- **`injectFigpal(html)`** appends `/figpal.js` + `auto()` to every copied
  prototype/page/demo so the pal follows inside them too. It **skips** any page that
  already contains `figpal.js` (the customizer) or the `gv-figpal-start` marker. The
  iframe-skip in `auto()` keeps previews pal-free.

## Working discipline (important)
- **Verify visuals by rendering with headless Chrome and Read-ing the PNG against
  `reference/*` — never eyeball-grade your own SVG.** That's how every sprite pass was
  checked (harnesses are in `reference/`).
- **Clip gotcha:** inside `<clipPath>`, put the transform on the `<path>` directly,
  not on a wrapping `<g>` (Chrome only partially honours the `<g>` form — it silently
  clipped the markings until fixed).
- Free-mode bespoke build — **not** GoVocal product UI, no `.gv-*` classes, exempt
  from the govocal-ui lint.

## Colours (PALETTE order)
Blossom (pink, default) · Sunset (orange) · Ink (black = warm grey) · Sunbeam
(yellow) · Meadow (olive) · Sky (blue) · Iris (purple) · Bubblegum (magenta) · Pebble
(grey) · **Ginger & white** (cat-only bicolor = Aslam). Body fills are paler than the
real selector swatches (matched to real art). Dog is a generic corgi (flat fill +
white blaze) until Rob's dog markings are added.
