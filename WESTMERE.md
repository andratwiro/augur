# Westmere — demo city bible (INTERNAL, never published)

The single fictional city all **front-office reference pages** (`pages/`) are dressed
with, so the prototypes read as one real platform. Keep names, numbers, districts and
projects consistent across every page. NW-European mid-size coastal city.

> Internal only. Lives at repo root; `build.js` never copies it. Don't reference it
> from a `prototypes/` folder.

## The city

- **Name:** Westmere · platform title "Westmere — Have your say"
- **Size:** ~165,000 residents, coastal/river city (a harbour, a river "the Mere")
- **Voice:** warm, civic, plain-spoken, second person ("Help shape…", "Have your say").
  British/EU spelling (neighbourhood, organise, programme, centre).
- **Platform totals:** 15,400 participants · 38 projects run to date

### Brand
- Primary: deep teal `#0E6E6E` · Secondary/accent: warm coral `#FF5A5F` · Ink `#1A2B2B`
- These map to `--gv-tenant-primary` / `--gv-tenant-secondary` via the theme system —
  **don't hardcode** in pages; rely on the theme (pages already theme-driven).

### Districts (use these six only — never invent more)
Harbour · Old Town · Northgate · Riverside · Westside · Lakeshore

### People (commenters, authors, organisers — recurring names)
Sofie Maes · Daan Verhoeven · Aisha Karimi · Tom Bekker · Lena Okонkwo → use **Lena Okonkwo** ·
Marek Nowak · Emma de Vries · Youssef El Amrani · Clara Janssen · Ravi Patel ·
City staff: "Westmere City — Engagement team", organiser "Hanne Vos (City of Westmere)"

## Canonical projects (reuse the same titles + stats everywhere)

| Title | Method | District | Status | Stat |
|---|---|---|---|---|
| The big downtown survey | Survey | Centre | Open · 248 participants | featured |
| A square for everyone | Ideation | Old Town | Open · 122 contributions | Market Square redesign |
| The future of Station Road | Survey | Northgate | Open · 6 weeks left · 57 | mobility |
| Participatory budget 2026 | Voting | Citywide | Open · 2 weeks left · 86 | €1.2M to allocate |
| Westmere climate teams | Folder (3 projects) | Westside/Old Town/Riverside | Open · 346 | climate |
| Old Town renewal | (closed) | Old Town | Finished · 503 contributions | report ready |
| Greening the schoolyards | Ideation | Citywide | Finished 3 weeks ago | done |
| Children & youth strategy 2025–2030 | Survey | Citywide | Finished 7 weeks ago | done |
| Redesigning Market Square | Ideation | Old Town | Finished | done |
| Riverside path study | Survey | Riverside | Ongoing · no end date | done |
| Cleaner Harbour, healthier Mere | Common ground | Harbour | Open · 1,204 votes | consensus |
| Tree-planting volunteers | Volunteering | Citywide | Open · 18 spots | volunteering |

### Climate teams (folder children) — emblem cards
Westside · Old Town · Riverside (each "your idea for a better climate in the <district> district").

## Canonical events (reuse across homepage + events pages)

| Date 2026 | Title | Where | RSVP |
|---|---|---|---|
| Jun 18 | Community session: bringing online & offline participation together | Online | 2 |
| Jun 25 | Station Road walk & talk: see the plans on site | Northgate, meet at the station | 41 |
| Jul 02 | Participatory budget: info & Q&A session | Online | 7 |
| Jul 09 | Old Town renewal — neighbourhood open house | Old Town Hall, Market Square | 33 |
| Jul 16 | Harbour clean-up morning | Harbour quayside | 64 |

## Imagery direction (for picking stock photos)

Coastal NW-European city: brick/townhouse streets, a working harbour & quayside,
market squares, canal/river paths, parks & schoolyards, trams/cycle lanes, mixed
crowds of residents, council meetings/workshops. Avoid skyscrapers, US suburbia,
tropical/desert. Muted, slightly cool daylight palette suits the teal brand.

**Hero gotcha:** a relative `url()` inside the `--gv-hero-image` custom property
resolves against `govocal-ui.css` (in `skills/govocal-ui/`), NOT the page — so it
404s. For page heroes set the photo with a **direct inline** `style="background-image:url('img/hero.webp')"`
on `.gv-hero` (resolves against the document). The teal `::before` scrim still applies.

**Pipeline:** `scripts/fetch-img.sh <url> pages/<page>/img/<name>.webp <width> <maxKB>`
(groups of ≤6 downloads per shell call — Pexels throttles bursts). Source URL form:
`https://images.pexels.com/photos/<id>/pexels-photo-<id>.jpeg?auto=compress&cs=tinysrgb&w=<n>`.
Eyeball picks via a contact sheet: `magick montage .imgwork/*.jpg -set label '%t' -tile 4x ...`.
Budgets: hero ≤150KB @1600px · wide card ≤90KB @1200px · card ≤45KB @600px ·
thumb ≤25KB @400px. Store images in each page's own `img/` (pages stay self-contained).
