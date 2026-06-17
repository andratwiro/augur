# Piti 🐾 (private)

A little companion that trails your cursor around the prototypes site. We call them
**pitis** at home. It's our homage to Figma's
[FigPals](https://www.figma.com/blog/finding-a-forever-home-for-figpals/) — the
customizable pets they shipped for a limited "April Fun Week" 2025 and then took
away. This one doesn't leave.

Not a prototype, not a GoVocal thing — a private aside. **Self-contained in `pitis/`:**
the rest of the repo doesn't know it exists. `build.js` only references it through a
single **optional addon import** (`pitis/piti.build.js`) + generic hooks; remove the
folder and the site builds identically. Keep it that way — don't reference piti from
general repo files (CLAUDE.md, build.js logic, shared CSS, agent memory, etc.).

## Summon / dismiss
- **Shift + Ñ** anywhere toggles the piti on/off. Remembered per-browser via
  `localStorage['piti-revealed']` (there is **no** typed secret). While active, the
  whole page uses a **Figma-style cursor** (dark arrow + white outline; `html.piti-cursor`).
- A quiet, Linear-styled **paw in the site footer** (the addon's `footerHtml()`) opens
  the **customizer** as an in-page **overlay modal** over the dimmed site (piti.js
  `openModal()` loads `/pitis/` in an iframe). Direct `/pitis/` visits work standalone.
- "Only-you" is lightweight: it only shows on browsers where you've toggled it.
  Prototypes are **public**, so a visitor who presses Shift+Ñ on a shared prototype
  also gets one (harmless easter egg). A real per-user gate (Cloudflare Access / login
  identity in `src/_worker.js`) is the someday option to make it invisible to others.

## What it does
- **Follows the cursor** — eased trailing follow with a catch-up boost and a smooth
  facing flip.
- **Two species** — **cat** (default) and **mastiff** (Rob's dog **Senda**). The cat is
  traced from the real FigPals resting pose; Senda is traced from her own photo in the
  same pipeline. (The old corgi species was removed — Senda replaces it.) The piti only
  exists in the resting/lying pose; `awake` just opens the eyes (awake while travelling,
  sleepy when settled).
- **Recolour + hats** — the cat recolours, with two real-cat patterns in the picker:
  **"Ginger & white"** bicolor (Rob's cat **Aslam**) and **Pruna** (mackerel tabby).
  Senda is a fixed fawn look. 5 hats: sprout, top hat, wizard, beanie, party.
- **Behaviours / emotions** — idle → sit → (after ~11s) sleep with a "z"; a **pop-in**
  when summoned; a **startled hop + "!"** when you click a link/card (a port of the
  FigPals detach-component surprise); a **sweat-drop "running"** state + a faint
  **after-image trail** (fading ghost copies) when it lags a fast cursor; the
  occasional heart.
- **Follows INTO prototypes**, not just the nav. Never blocks the UI
  (`pointer-events:none`), respects `prefers-reduced-motion`.

No feeding and no photobooth — both were prototyped early and removed.

## Files (everything lives in `pitis/`)
- **`piti.js`** — the whole engine (one source of truth). Exposes
  `window.Piti = { PALETTE, HATS, svg, loadConfig, saveConfig, mount, auto, reveal,
  hide, toggle, refreshLive }`. Cat art = potrace paths `P.{sil,outMain,eyeL,eyeR,nose}`;
  mastiff art = `MASTIFF_P` (traced silhouette + clipped overlays). `petBody(species,…)`
  assembles a piti; `svg(config,state)` is the public render (config = `{name, furIdx,
  hat, species}`, defaults to cat). Markings = `normalMarks` / `bicolorMarks` (Aslam) /
  `tabbyMarks` (Pruna), clipped to the silhouette. `hatSVG(id, species)` positions a hat
  on the per-species crown (`HAT_T_CAT` / `HAT_T_MASTIFF`, measured off grid renders).
  `mount()` = the
  trailing companion (`{el, destroy, refresh}`); `auto()` = site manager (mounts when
  revealed, wires Shift+Ñ, **skips inside iframes** so previews stay piti-free). CSS
  classes are `piti-*` / `pt-*`.
- **`piti.build.js`** — the build-time addon (all of piti's `build.js` footprint).
  Exports generic hooks: `transformHtml(html, v)` (inject the loader into copied
  prototype/page/demo HTML; skips pages that already load `piti.js`), `bodyScripts()`
  + `footerHtml()` + `css()` (for the generated shell pages), and `emit(ctx)` (copy
  `pitis/` → `/dist/pitis/` and the engine to `/dist/piti.js`). `build.js` loads this
  via one optional `import("./pitis/piti.build.js")` and calls the hooks — nothing
  else in `build.js` mentions piti.
- **`index.html`** — the customizer, mirroring the real FigPals creator: **species
  tabs (cat/mastiff)** on top, the piti on a grass stage with **four chevrons (top pair
  cycles hat, bottom pair cycles colour)**, a colour swatch row, name box. No title,
  no Save (every change **auto-saves** + summons the piti), closes by **clicking
  outside** (or Esc). Loads its own `piti.js`.
- **`research.md`** — research on the real FigPals: look, the full **interaction
  catalogue**, and an ours-vs-real comparison. Internal (gitignored).
- **`reference/`** — source imagery, **gitignored & never shipped**: official FigPals
  blog images, the 35s behaviour clip + frames, the colour-picker capture, **Aslam's
  photos** (`aslam-*`, `mycat-*`), the **corgi** (`corgi-sleep.png`), plus scratch
  render harnesses (`_*.html` / `_*.png`).
- **Agent briefs** (`trace-agent.md`, `redesign-agent.md`, `dog-agent.md`) — the
  prompts used to build/iterate the art; history.

## Working discipline (important)
- **Verify visuals by rendering with headless Chrome and Read-ing the PNG against
  `reference/*` — never eyeball-grade your own SVG.** Reuse the harnesses in
  `reference/`.
- **Clip gotcha:** inside `<clipPath>`, put the transform on the `<path>` directly,
  not on a wrapping `<g>` (Chrome only partially honours the `<g>` form — it silently
  clipped the markings until fixed).
- Free-mode bespoke build — **not** GoVocal product UI, no `.gv-*` classes, exempt
  from the govocal-ui lint.

## Colours (PALETTE order)
Blossom (pink, default) · Sunset (orange) · Ink (black = warm grey) · Sunbeam
(yellow) · Meadow (olive) · Sky (blue) · Iris (purple) · Bubblegum (magenta) · Pebble
(grey) · **Ginger & white** (cat-only bicolor = Aslam) · **Pruna** (cat-only mackerel
tabby) · **Senda** (mastiff-only fixed fawn look). Body fills are paler than the real
selector swatches (matched to real art). The cat picker shows only Aslam + Pruna; the
mastiff picker shows only Senda.
