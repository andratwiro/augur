# FigPal 🐾 (private)

A little companion that follows your cursor — our own homage to Figma's
[FigPals](https://www.figma.com/blog/finding-a-forever-home-for-figpals/), the
customizable pets they shipped for a limited "April Fun Week" in 2025 and then
took away (much to everyone's sadness). This one doesn't leave.

Not a prototype, not a GoVocal thing — just a cute aside. It lives **outside any
`prototypes/` folder on purpose**, so `build.js` never publishes it as a public
link. `build.js` does copy `figpals/` into `/dist` so the homepage trigger can
reach it, but it stays **behind the site password** (never added to
`PUBLIC_PREFIXES`).

## How to open it

On the prototypes homepage, type the secret word **`figpal`** — a soft pink paw
appears bottom-right and is remembered on that browser (localStorage). Click it to
open your pal. Type **`figbye`** to hide the paw again.

This is the lightweight "only-you" gate for now: the paw only shows on browsers
where you've typed the secret. A real per-user gate (e.g. checking the
Cloudflare Access / login identity in `src/_worker.js`) can come later if we want
it truly invisible to everyone else.

## What it does

- **Follows your cursor** — trots after the pointer, faces the way it's going,
  idles and wanders when you stop moving.
- **Adopt + customize** — name it, pick a fur colour (8 palettes) and a hat
  (leaf / beanie / party / crown). Saved to localStorage so your pal persists.
- **Boop** — click the pal for a squish + hearts.
- **Feed 🍪** — toss a treat; it arcs to the pal. Fullness slowly decays so
  there's something to care for. Happiness too.
- **Photobooth 📸** — snap a framed polaroid of your pal and save it as a PNG.

All self-contained in `index.html` — open it directly, no build/server needed.

## Source on FigPals (for context)

- Figma blog: *Finding a Forever Home for FigPals* — design, behaviours, the
  9,000+ variations, the "pink cat with a heart bubble" being the most popular.
- Origin: a Maker Week intern's "Figmagotchi" (raise a Tamagotchi by feeding it
  sticky notes) → "FigPets" → the full FigPals limited release.
