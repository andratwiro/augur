# Westmere shared photo pool (optimized WebP)

Reusable, size-optimized stock photos for dressing the **front-office reference
pages** as the City of Westmere. It's one city, so these recur across pages —
reference them from a page with a relative path, e.g. from `pages/<page>/index.html`:
`../../skills/govocal-ui/img/westmere/square.webp`.

> **Hero gotcha:** set page heroes with an inline `style="background-image:url('../../skills/govocal-ui/img/westmere/hero-waterfront.webp')"`
> on `.gv-hero` (NOT the `--gv-hero-image` custom property — relative url() in a
> custom prop resolves against the CSS file and 404s).

| File | What it shows | Good for |
|---|---|---|
| `hero-waterfront.webp` (1600) | Sunny waterfront cityscape across the water | Page heroes / banners |
| `skyline-dusk.webp` (1300) | City skyline at dusk across the harbour | Hero alt / wide feature |
| `avenue.webp` (1100) | Sun-dappled tree-lined avenue, cyclists | Hero alt / "greener street" / mobility |
| `harbour.webp` (1100) | Working harbour full of boats + hillside town | Feature / harbour projects |
| `townhouses-wide.webp` (1100) | Traditional NW-European waterfront houses | Feature / neighbourhood |
| `square.webp` (620) | Civic square with cyclists | Market Square / public-space cards |
| `oldtown.webp` (620) | Cobbled Old Town street | Old Town / renewal cards |
| `street-townhouses.webp` (620) | Sunny street of brick townhouses | Neighbourhood / street cards |
| `street-trees.webp` (760) | Quiet tree-lined road | Station Road / mobility / paths |
| `marina.webp` (760) | Marina + modern waterfront apartments | Harbour / housing cards |
| `park.webp` (560) | Green park path | Parks / climate / green cards |
| `park-people.webp` (700) | Park with people walking | Community / outdoor cards |
| `workshop.webp` (760) | Community workshop with screens + tables | Events / co-creation / survey |
| `meeting.webp` (760) | Public meeting, resident raising a hand | Voting / budget / consultation |
| `group.webp` (760) | Small group around a table with papers | Ideation / proposals / working group |
| `community.webp` (760) | Busy community event, mixed crowd | Open house / fair / volunteering |
| `consult.webp` (760) | Two staff consulting residents at a desk | Help / contact / 1:1 |

Need something page-specific not here (e.g. a clipboard/survey illustration, a
map, tree-planting)? Fetch it with `scripts/fetch-img.sh <pexels-url> pages/<page>/img/<name>.webp <w> <kb>`
(download in groups of ≤6 — Pexels throttles bursts) and keep it in the page's own `img/`.
