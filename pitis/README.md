# Piti 🐾 (private)

A little companion that trails your cursor around the prototypes site. We call them
**pitis** at home — customizable cursor pets modelled on our own animals. A small
delight layer that never gets taken away.

Not a prototype, not a product thing — a private aside. **Self-contained in `pitis/`:**
the rest of the repo doesn't know it exists. `build.js` only references it through a
single **optional addon import** (`pitis/piti.build.js`) + generic hooks; remove the
folder and the site builds identically. Keep it that way — don't reference piti from
general repo files (CLAUDE.md, build.js logic, shared CSS, agent memory, etc.).

## Summon / dismiss
- **Shift + Ñ** anywhere toggles the piti on/off. Remembered per-browser via
  `localStorage['piti-revealed']` (there is **no** typed secret). While active, the
  whole page uses a **custom arrow cursor** (dark arrow + white outline; `html.piti-cursor`).
- A quiet, Linear-styled **paw in the site footer** (the addon's `footerHtml()`) opens
  the **customizer** as an in-page **overlay modal** over the dimmed site (piti.js
  `openModal()` loads `/pitis/` in an iframe). Direct `/pitis/` visits work standalone.
- **Admin-only, identity-gated.** Summoning requires a signed-in **admin** — `auto()`
  checks `/__me` (or an instance with no user accounts at all: `accounts:false`, nobody
  to hide it from). A signed-in teammate or a signed-out visitor on a public prototype
  can press the combo all day and gets nothing; a stale `piti-revealed` flag in their
  browser is cleared on the next page. Fails closed if `/__me` fails. Identity is only
  asked for when it can change something (a pal already revealed here, or the combo
  pressed) — a customer opening a public prototype costs no extra request.
  The paw is separately hidden behind `html.gv-admin`.
  ⚠️ The hotkey matches the **ñ character only** — it used to also match `e.code ===
  "Semicolon"`, which on a US/AZERTY keyboard is `;`, so a teammate typing a colon
  summoned a permanent pink cat. (Which is how the gate came to exist.)

## What it does
- **Follows the cursor** — eased trailing follow with a catch-up boost and a smooth
  facing flip.
- **Two species** — **cat** (default) and **mastiff** (the maintainer's dog). The cat is
  traced from reference art of a resting cat; Senda is traced from her own photo in the
  same pipeline. (The old corgi species was removed — Senda replaces it.) The piti only
  exists in the resting/lying pose; `awake` just opens the eyes (awake while travelling,
  sleepy when settled).
- **Recolour + hats** — the cat recolours, with two real-cat patterns in the picker:
  **"Ginger & white"** bicolor (the maintainer's cat) and **Pruna** (mackerel tabby).
  Senda is a fixed fawn look. 5 hats: sprout, top hat, wizard, beanie, party.
- **Behaviours / emotions** — idle → sit → (after ~11s) sleep with a "z"; a **pop-in**
  when summoned; a **startled hop + "!"** when you click a link/card; a
  **sweat-drop "running"** state + a faint
  **after-image trail** (fading ghost copies) when it lags a fast cursor; the
  occasional heart.
- **Follows INTO prototypes**, not just the nav. Never blocks the UI
  (`pointer-events:none`), respects `prefers-reduced-motion`.

No feeding and no photobooth — both were prototyped early and removed.

## Roast mode (the talking piti)
The piti can be driven by a **terminal agent** that watches what you're looking at and,
now and then, has the cat **walk to a spot on the screen, drop one short snarky UX/a11y
remark, hover ~3–5s, then return to the cursor** — a design wingman roasting your screen on
behalf of users with low comprehension for screens (snark is the delivery; the point is
always true). Self-contained: two KV keys on the live site + the agent brief.
- **Live only, prototypes + playground only, and only while active (Shift+Ñ).** The cat
  polls `/__piti` for remarks just on `/…/prototypes/…` and `/playground/…` pages.
- **Bridge:** `src/_worker.js` `pitiApi()` exposes `/__piti` over KV keys `pt:view`
  (browser publishes the page it's on) and `pt:remarks` (agent posts quips). Browser ops are
  open; agent read-view / write-remark reuse the existing `REVIEW_EXPORT_KEY` secret — **no
  new secret to provision**. The worker is the one sanctioned edge touch (same as it already
  whitelists `/piti.js`); everything else lives in `pitis/`.
- **Client:** the wingman channel in `piti.js` `mount()` — `publishView()`, `pollRemarks()`,
  and a travel→speak→dwell→return state machine; the worded bubble is `.piti-says`.
- **The agent:** see **`roast-agent.md`** — persona, the low-comprehension lens, the loop
  (read view → read local source + screenshot live URL → compose ONE quip → POST), cadence
  and restraint rules. Run it from an agent terminal (`/loop` self-paced) while you build.

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
- **`index.html`** — the customizer: **species
  tabs (cat/mastiff)** on top, the piti on a grass stage with **four chevrons (top pair
  cycles hat, bottom pair cycles colour)**, a colour swatch row, name box. No title,
  no Save (every change **auto-saves** + summons the piti), closes by **clicking
  outside** (or Esc). Loads its own `piti.js`.
- **`research.md`** — design research: the look, the full **interaction
  catalogue**, and an ours-vs-reference comparison. Internal (gitignored).
- **`reference/`** — source imagery, **gitignored & never shipped**: pose reference
  imagery, the 35s behaviour clip + frames, the colour-picker capture, **Aslam's
  photos** (`aslam-*`, `mycat-*`), the **corgi** (`corgi-sleep.png`), plus scratch
  render harnesses (`_*.html` / `_*.png`).
- **`roast-agent.md`** — the brief that turns a terminal agent into the *talking* piti
  (roast mode above). Persona + loop + the `/__piti` contract.

## Working discipline (important)
- **Verify visuals by rendering with headless Chrome and Read-ing the PNG against
  `reference/*` — never eyeball-grade your own SVG.** Reuse the harnesses in
  `reference/`.
- **Clip gotcha:** inside `<clipPath>`, put the transform on the `<path>` directly,
  not on a wrapping `<g>` (Chrome only partially honours the `<g>` form — it silently
  clipped the markings until fixed).
- Free-mode bespoke build — **not** product UI, no `.gv-*` classes, exempt
  from any space UI-kit lint.

## Colours (PALETTE order)
Blossom (pink, default) · Sunset (orange) · Ink (black = warm grey) · Sunbeam
(yellow) · Meadow (olive) · Sky (blue) · Iris (purple) · Bubblegum (magenta) · Pebble
(grey) · **Ginger & white** (cat-only bicolor = Aslam) · **Pruna** (cat-only mackerel
tabby) · **Senda** (mastiff-only fixed fawn look). Body fills are paler than the real
selector swatches (matched to real art). The cat picker shows only Aslam + Pruna; the
mastiff picker shows only Senda.
