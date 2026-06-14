# GoVocal — Product Context (internal)

Internal product brief for anyone (human or agent) building GoVocal prototypes.
Synthesized from the public help center (`support.govocal.com`, all 70 articles,
read 2026-06-14). **Internal-only — never ships.** Lives at repo root, outside any
`prototypes/` folder, so `build.js` never copies it to `/dist`.

Companions: brand/voice → `skills/govocal-design/`; real components & tokens →
`skills/govocal-ui/`; a11y → `skills/govocal-a11y/`. This file is the *product
model* (what the thing is and how it works); those are the *how it looks/sounds*.

---

## 1. Big picture (read this first)

**GoVocal** (formerly **CitizenLab**; rebrand still in progress — see §13) is a
**digital democracy / community-engagement SaaS** used by 500+ governments
(mostly municipalities). A city runs a branded **platform** where **residents**
participate in **projects**, and city staff configure everything from a **back
office** and analyze the results.

The whole product hangs off one structural spine:

> **Folder → Project → Phase → Participation method**

- A **Project** is a single engagement initiative ("Redesign of Central Park").
- A project's **Timeline** is an ordered set of **Phases**; phases can't overlap.
- Each **Phase** runs exactly **one Participation method** (survey, ideation,
  voting, …). Want two methods at once → use two projects.
- **Folders** just group related projects (organization only, no logic).

**Two surfaces** every prototype is one of:
- **Front office** (resident-facing) — the public branded site residents browse
  and participate in. *Gets the cookie-consent banner* (CLAUDE.md rule).
- **Back office / admin panel** — where staff configure, moderate, analyze.
  *No cookie banner.*

**Roles** (low → high power): Visitor → User → Participant → **Project Manager**
→ **Folder Manager** → **Platform Admin**. Most platform-wide config is admin-only.

**An "Input"** is the generic word for anything a resident submits — an idea, a
proposal, a survey answer, a vote option. You'll see it everywhere ("Input
Manager", "input form", "Input tags").

**Heavy current direction: AI.** "AI Sensemaking" / "AI Analysis" summarizes and
tags open-text input; "Perspectives" auto-clusters ideas into themes; FormSync
2.0 OCRs paper forms ("powered by Claude"). Privacy defaults recently flipped to
**private-by-default profiles**.

---

## 2. Core vocabulary (the words to get right)

| Term | Meaning |
|---|---|
| **Platform** | A city/org's whole branded GoVocal site (custom URL). |
| **Front office** | Resident-facing public side. |
| **Back office / admin panel** | Staff configuration & management side. |
| **Folder** | Organizational grouping of projects. No timeline/logic of its own. |
| **Project** | One engagement initiative; container for phases, events, files. |
| **Phase** | A time-bounded stage of a project; runs ONE participation method. |
| **Timeline** | The ordered sequence of a project's phases. |
| **Participation method** | The activity type of a phase (8 of them, §4). |
| **Input** | Generic resident contribution (idea / proposal / answer / option). |
| **Idea** | An input in an ideation phase. **Proposal** = citizen-initiated input w/ a vote threshold. |
| **Input Manager** | Back-office tool to view/assign/tag/move/status inputs. |
| **Input form** | The submission form participants fill in. |
| **Input tags** | Themes residents pick when submitting (per-project). |
| **Platform tags / Areas** | Categorize *projects*; drive "follow by interest" + filtering. |
| **Status** | Workflow state of an input (defaults + custom, e.g. "Under consideration"). |
| **Smart group** | Auto-membership user segment (conditions, ⚡ icon, AND-only). |
| **Access rights** | Who can see / participate in a folder, project, or phase. |
| **Listed / Unlisted** | Project discoverability (unlisted = direct-link only). |
| **Content Builder** | Drag-and-drop editor for rich project/phase descriptions. |
| **Insights** | Per-phase analytics tab. |
| **Report Builder** | Drag-and-drop tool for shareable PDF/online reports. |
| **AI Sensemaking / AI Analysis** | AI summarization + tagging of input. |
| **Community Monitor** | Always-on quarterly resident-satisfaction tracking. |

---

## 3. Structure, roles & access

### Folder → Project → Phase
- **Folders**: grouping only; can't be unlisted (set to Draft to hide).
- **Projects**: states = **Draft / Published / Archived / Published–Finished**
  (auto when the last phase ends). **Listed/Unlisted** = discoverability;
  visibility = Everyone / admins+managers only / specific groups. Custom **slug**
  after `/projects/`. **Preview link** lets even non-registered stakeholders test
  a draft.
- **Phases**: one method each, can't overlap (can touch same day if times don't).
  Empty end date = open-ended (auto-set when a later phase is added). A method
  **locks after input collection begins**.

### Roles & permissions
- **Visitor** (unregistered) → **User** (registered, inactive) → **Participant**
  (has engaged) → **Project Manager** (manages assigned projects only) →
  **Folder Manager** (manages a folder's projects; auto-PM of ones they create) →
  **Platform Admin** (full rights; only admins grant roles).
- PMs **can't**: create registration questions, email users outside their
  projects, access platform config (homepage, Users, Dashboard). Folder Managers
  **can't**: delete projects or make platform-wide changes.

### Access rights (three nested levels: folder / project / phase)
- Phase auth flows: admins+PMs only · **None** (surveys/ideation/proposals only) ·
  Email confirmation · Account creation · SSO.
- **User-data tiers**: (1) full PII + demographics · (2) exclude PII, keep
  demographics · (3) full anonymity (no PII, no demographics → no demographic
  reporting, and users can't see their own submissions).

### Anonymous participation
- **Voluntary** (toggle on ideation/proposals/comments) vs **Mandated** (surveys
  default). Anonymous inputs aren't linked to a profile (even admins can't see the
  author); each gets a unique ID; users may show as "User1234" / random animal
  names. Moderation still works. It's a privacy layer *on top of* access rights.

---

## 4. Participation methods (the heart of the product)

Eight options shown when creating a phase:

1. **Collect input & feedback (Ideation)** — *the core method.* Residents submit
   ideas (bottom-up) or react to team options (top-down). **Three views:**
   **List** (cards; 👍/👎 + comments), **Map** (drop pins; needs location Q),
   **Feed/Perspective** (high volume grouped into themes). Title field is always
   required & non-removable. Sort by most liked/discussed/trending/new/etc.
2. **Voting / Prioritization** — three types: **Approval** (endorse each you
   like), **Cumulative** (distribute N votes), **Participatory Budgeting**
   (spend a budget across costed options). **Anonymous by default.** Online vs
   offline votes tracked separately (admins enter offline tallies only).
3. **Survey** — fully native, rich question set (text, single/multi choice, image
   choice, linear scale, matrix, ranking, rating, sentiment/emoji, numeric, file
   upload, + **4 map types**: drop pin, route/line, area/polygon, shapefile).
   Page-based builder; **logic only on single-select & linear-scale**; logic fires
   on Next; can't go back a page. **No draft phase** (live on creation; toggle
   "Open for responses" off instead).
4. **Proposals / Petitions / Initiatives** — bottom-up; gather votes + cosponsors
   to a **threshold** (~1–3% of population, ~90-day timeline) → **official
   response**. Auto statuses: Proposed / Expired / Threshold Reached /
   Pre-screening. Manual: Ineligible / Answered.
5. **Finding Common Ground** (a.k.a. **Common Ground**, Beta) — distills debate
   into ~25 **trade-off statements** (≤120 chars); participants respond
   **agree / unsure / disagree**; real-time results map. **Votes are final.**
6. **Share Information** — one-way updates/results (hosts Reports; also a no-auth
   host for embedded external surveys).
7. **Recruit Participants or Volunteers** — list opportunities with a signup
   button each; admins follow up. Used for panels/workshops/committees too.
8. **Collect Feedback on a Document** — in-PDF commenting via the **Konveio**
   add-on (paid; one PDF per phase).

**Adjacent / non-phase methods:**
- **Poll (Quick Poll)** — single/multi-choice only; **no analytics, no Report
  Builder**; export to Excel.
- **External survey** — embed Typeform (recommended)/Google Forms/Qualtrics/etc.
  **URL must be set at phase creation, can't be added later.** Loses native
  analytics.
- **Online Workshop** — live sessions, **desktop-only, max 50**; steps × rooms;
  per-room Q&A / Poll / Info / Breakout / Summarise / Report Out.
- **Community Monitor / Resident Satisfaction Survey** — always-on quarterly
  sentiment; **Live Monitor Dashboard** with a **Health Score** across Governance
  & Trust / Community Life / Services / Other.

---

## 5. Input management & moderation

- **Assignment**: new ideas auto-assign to first PM/admin; reassign in Input
  Manager (triggers email + notification); weekly reminders; **internal comments**
  staff-only.
- **Official feedback**: change status (+ comment) or post a prominent **red
  feedback box**; notifies author + commenters + voters. Bulk feedback via Excel
  template → support imports.
- **Tag / copy / move**: drag onto tags; **copy** = same input in multiple phases
  (edits propagate); **move** via blue phase-number bubbles. Proposal inputs can't
  move to/from ideation.
- **Resident editing**: edit/delete own input/comment via "three dots" — but
  **inputs lock once status changes**, and only while project is active.
- **Monitoring**: **Management Feed** (Admin Panel → Dashboard) logs
  Created/Modified/Deleted on inputs/phases/projects/folders; filter by
  project/user; 30-day window; admin-only.
- **Protection**: spam/throttle detection, IP monitoring, downvote
  self-moderation, **Profanity Filter**, **AI/NLP "Detect inappropriate content"**
  (EN/FR/DE/ES/PT). Flagged content stays visible until an admin acts.
- **Offline import**: **Excel** template (Input Manager/Insights → Import →
  drafts → approve; tagged "imported") or **FormSync** OCR of scanned paper forms
  (generate PDF → distribute → scan → import). Neither imports mapping or
  file-upload questions.

---

## 6. Configuration (back office)

- **Homepage** (Pages & Menu → Edit Home): admin-only widget builder. Functional
  widgets (Open to participation, Followed items, Finished projects, In your area,
  Spotlight, Published projects/folders, Call to action) + layout widgets. Can
  differ for logged-in vs guest.
- **Navbar**: max **7 items**, **Home is locked**, no external URLs. + **Custom
  Pages** (hero + info sections; can auto-list projects by tag/area).
- **Users & Groups**: Manual Groups + Smart Groups (⚡, AND-only conditions).
  Block (default 90-day ban) / delete (or anonymize) / invite (email or in-person
  codes at `/invite`; bulk Excel import; invites expire 30 days, skip email
  verification).
- **Registration** (Settings → Registration): email step → verification → complete
  profile. Default fields **Gender / Year of birth / Place of residence**. Custom
  question types: multiple choice, yes/no, short/long text, numeric, date.
  **Deferred registration** (Jan 2026): submit ideas/proposals *before*
  registering.
- **SSO / verification**: free Google + Facebook; paid Microsoft Entra; national
  systems (Belgium CSAM/itsme, France FranceConnect, Chile, Denmark, Austria;
  2–3-month lead). Most SSO setup is done by **Support**, not self-service.
- **Branding** (Settings → Branding): Primary / Secondary / Text / Overlay colors
  (+ opacity); logo; favicon at `/admin/favicon`. **Fonts & navbar color need
  Support.** (For prototypes use `--gv-tenant-*` vars — see govocal-ui skill.)
- **Languages**: drag to order (first = default); **Weglot** (whole UI + content)
  or **Google Translate** (ideas/comments only). Publishing needs a translated
  title for every active language.
- **Policies**: Terms & Conditions (accepted at registration) + Privacy Policy.
- **Email**: **Automated** (platform-level defaults; a phase can disable but never
  enable a platform-disabled email; essential emails can't be disabled) +
  **Manual campaigns** (to groups/smart groups only, never individual addresses;
  tokens `###{{first_name}}`). Default FROM `@govocal.com`.

---

## 7. Analysis & reporting

- **Exports**: everything to **Excel** (users, inputs, surveys/polls, workshops).
  Images/attachments not batch-exported; only public comments export.
- **Representation Dashboard**: participants vs community **base/census data**;
  **Representation Score** (100% = perfect; drops to 0 if any group is at zero).
- **Visitors Dashboard** (admin-only): visitors vs visits, traffic sources,
  registrations + conversion, participants, language.
- **AI Analysis / AI Sensemaking**: summarize + tag open text; 4-column UI (tags /
  inputs / users+filters / summaries); auto + manual tagging, sentiment, heatmap
  of significant correlations; drag summaries into reports. Runs on **GPT-4 Turbo
  via Azure** (not public OpenAI); only free-text sent; **not 100% accurate —
  cross-check**. (Newer: **Perspectives** AI auto-theming; FormSync "powered by
  Claude".)
- **Report Builder**: Blank / Project template / Platform template; content + data
  widgets; export PDF/Word or attach to a "Share Information" phase. **Platform
  reports and project reports are separate and non-interchangeable.**
- **PowerBI** (Premium) + read-only public **API** (`developers.govocal.com`).

---

## 8. Asset specs & accessibility (use when building UI)

- **Images**: PNG/JPG, max 10 MB, min 72 dpi. Homepage banner **1440×480 (3:1)**;
  project/folder card **1400×1050 (4:3)**; project/folder banner **2400×600
  (4:1)**; **idea card 1024×1024 (1:1)**; proposal card **1000×500 (2:1)**; event
  card **1800×600 (3:1)**; logo min **48px** height. Mobile crops differ.
- **Accessibility**: platform certifies to **WCAG 2.2 AA** (with AnySurfer);
  keyboard nav, screen-reader support, alt-text, contrast warnings on custom
  colors. No third-party a11y overlays. (Mirrors our `skills/govocal-a11y/` rule.)
- **Browsers**: Chrome, Firefox, Safari, Edge (latest). No IE11.
- **Editors**: **Content Builder** (block page editor; images not resizable) vs
  **Text Box editor** (WYSIWYG; reduced variant for emails).

---

## 9. Constraints & gotchas (quick reference)

- One method per phase; phases can't overlap; parallel participation = separate
  projects.
- Method **locks after input collection** begins.
- Surveys/polls have **no draft phase** (toggle responses off instead).
- **Polls** have no analytics / no Report Builder.
- External survey **URL set at creation only**.
- Inputs **lock once status changes**; Common Ground votes are **final**.
- Voting **anonymous by default**; admins manage offline votes only.
- Navbar **max 7, Home locked**, no external URLs.
- Smart-group conditions **AND-only**.
- Phase email rule **one-directional** (can disable, never enable).
- Publishing needs a **translated title per active language**.
- Full-anonymity tier ⇒ **no demographic reporting**; users can't see own input.
- Online Workshop: **desktop-only, max 50**.
- Lots depends on **Support** (chat bubble): SSO, fonts, navbar color, tracking
  codes, metadata, custom currency, disabling email verification.

---

## 10. Brand transition

The company rebranded **CitizenLab → GoVocal**, and it's **incomplete in-product**:
help text says "Go Vocal / GoVocal" but infra still surfaces legacy strings (e.g.
verification emails from `noreply@citizenlab.co`). Source code/repo is still
`CitizenLabDotCo/citizenlab`. A prototype mimicking system emails could justifiably
use either name — prefer **GoVocal** for anything user-visible.

---

## 11. Recent product direction (changelog, Sep 2025 → May 2026)

AI is the clear throughline. Highlights:
- **Perspectives** — AI auto-tagging ideas into themes (Mar 2026).
- **Common Ground (Beta)** — agree/disagree trade-off statements (Mar 2026).
- **FormSync 2.0** — paper-form OCR, 95%+, skip logic, "powered by Claude" (Apr 2026).
- **Deferred registration** — participate before registering (Jan 2026).
- **Method dashboards** — pre-populated phase metrics (Jan 2026).
- **Community Monitor** — always-on satisfaction tracking (Nov 2025).
- **Private-by-default profiles** w/ random-number URLs (Mar–May 2026).
- **Seat management** billing UI; advance scheduling/auto-publish (Apr 2026).

---

## 12. Source index

Public help center: **https://support.govocal.com/en/** (browsable, no login).
Seven collections, ~70 articles, all read 2026-06-14. Source code (for deeper
product truth): **github.com/CitizenLabDotCo/citizenlab** (also pinned in
`skills/govocal-ui/`). When a product detail matters and isn't here, the help
center article or the repo is the ground truth — re-fetch rather than guess.

Collections: Getting Started · Admin Configurations · Managing Projects &
Participation Methods (largest) · Monitoring & Offline Participation · Data
Analysis & Reporting · FAQ · Product Changelog.

---

## Appendix A — Source-grounded reference (from the repo)

Exact identifiers mined from `CitizenLabDotCo/citizenlab` @ `5d67730` (Rails back
end + React front end). Use these when you want a prototype to ring *true* — real
enum values, statuses, URLs, field types. The help-center sections above are the
behavior; this is the literal data model. Pull what you need; don't memorize it.

### A1. Participation-method internal keys (11)
`ideation · proposals · voting · native_survey · survey · poll · volunteering ·
information · document_annotation · common_ground · community_monitor_survey`
(plus `none` = null fallback). Note the inheritance: **`voting` and `proposals`
are specialized `ideation`**; `community_monitor_survey` is a specialized
`native_survey`.

- **`survey` ≠ `native_survey`.** `survey` = thin **embedded/external** survey
  (Typeform etc. via `survey_embed_url` / `survey_service`); `native_survey` =
  the built-in **form-builder** survey. Never conflate the two.
- **`ideation`** supports comments, up/down reactions, statuses, public input,
  assignment, topics. **`proposals`** = ideation but **up-vote only** (no dislike),
  with automated statuses, a reacting **threshold** (default 300) and
  **`expire_days_limit` default 90**, cosponsors in the form, `input_term` default
  `proposal`. **`voting`** = ideation but you **don't post** (`supports_submission?`
  false) — you vote on existing options via **baskets**, no reactions.
- **`common_ground`** = short title-only statements; reactions are the vote with a
  third **`neutral`** mode ("pass"); `input_term` forced to `contribution`; votes final.
- **`community_monitor_survey`** must be a project's only phase, project is `hidden`,
  no `end_at`, re-participate after 3 months; fixed sentiment battery over categories
  `quality_of_life · service_delivery · governance_and_trust · other`.

### A2. Idea statuses (only `ideation` & `proposals` have them)
Codes: `prescreening · proposed · threshold_reached · expired · viewed ·
under_consideration · accepted · implemented · rejected · answered · ineligible ·
custom`. New inputs start **`proposed`**. `prescreening` is the only non-public
status. `threshold_reached` / `expired` are proposal automation outcomes (locked,
not manually settable). Admin status managers live at
`/admin/settings/statuses/ideation` and `/admin/settings/statuses/proposals`.

### A3. Voting
`voting_method ∈ {budgeting, multiple_voting, single_voting}`;
`vote_term ∈ {vote, point, token, credit, percent}` (default `vote`). All three
methods funnel through one **Basket** (one per user+phase) of `votes` — **budgeting
just relabels votes as currency**; no separate budget model. Phase fields:
`voting_max_total · voting_min_total · voting_max_votes_per_idea ·
voting_min_selected_options · autoshare_results_enabled` + manual-tally fields
(`manual_votes_count`, …). Voting phase default `ideas_order` = `random`.

### A4. Reactions, input terms, key model fields
- **Reaction modes:** `up · down · neutral` (`neutral` is Idea-only / Common Ground
  only; comments are up/down). `Idea#score = likes − dislikes`.
- **`input_term`** (the noun the UI uses for an input): `idea · question ·
  contribution · project · issue · option · proposal · initiative · petition ·
  comment · response · suggestion · topic · post · story` (fallback `idea`).
- **Phase presentation modes:** `card · map · feed` (the List/Map/Feed views).
  Ideation order options: `trending (default) · random · popular · -new · new ·
  comments_count`.
- **Project visibility:** `visible_to ∈ {public, groups, admins}`; `listed`
  (unlisted ≠ hidden); `hidden`; `preview_token` for share-before-publish.
  **Publication status (draft/published) + folder nesting live on `AdminPublication`,
  not on the project.** A project has **no** participation_method — that's per-phase.

### A5. Resident-facing URLs (front office)
**Every front-office URL is locale-prefixed: `/:locale/…`** (e.g. `/en/projects/clean-streets`).

| URL | Resident sees |
|---|---|
| `/:locale/` | Homepage |
| `/:locale/projects` | Projects overview |
| `/:locale/projects/:slug` | Project page (current phase) |
| `/:locale/projects/:slug/:phaseNumber` | Project scoped to a phase (1-based ordinal) |
| `/:locale/projects/:slug/ideas/new` | Submit an input (all input types post here) |
| `/:locale/projects/:slug/surveys/new` | Take a native survey |
| `/:locale/projects/:slug/ideas-feed` | Swipeable feed view |
| `/:locale/projects/:slug/preview/:token` | Pre-launch preview link |
| `/:locale/ideas/:slug` | Single input detail (any input type) |
| `/:locale/ideas/edit/:ideaId` | Edit an input (by id) |
| `/:locale/folders/:slug` | Folder page |
| `/:locale/events` · `/events/:eventId` | Events list · event detail |
| `/:locale/profile/:userId` | Public profile (by **id**; default `/submissions` tab) |
| `/:locale/profile/edit` | My settings |
| `/:locale/sign-in` · `/sign-up` · `/invite` | Auth (modal over homepage; `?return_to=`) |
| `/:locale/pages/:slug` | Custom CMS page |
| `/:locale/pages/cookie-policy` | **Canonical cookie-policy link** for the consent banner |
| `/:locale/pages/accessibility-statement` | Accessibility statement |

No standalone `/proposals` or `/initiatives` route — proposals live inside a
project and reuse the `ideas` routes ("ideas" = the generic input type).

### A6. Admin URLs (back office) — all under `/:locale/admin/…`
`/admin` → redirects to `/admin/dashboard/overview` (admin) or `/admin/projects`
(moderator). Top sections: **Dashboard** (`/overview · /users · /visitors ·
/management-feed · /representation · /moderation`), **Projects**
(`/admin/projects`, `/projects/:id` → phases), **Users**
(`/admin/users` + `/admins · /groups/:id · /blocked · /banned-emails · /seats`),
**Settings** (`/general · /branding · /policies · /registration ·
/statuses/{ideation,proposals} · /areas · /topics`), **Pages & menu**
(`/admin/pages-menu` + `/homepage-builder · /pages/:id/{settings,content,banner,…}`),
**Messaging** (`/emails/{custom,automated}`), **Reporting**
(`/report-builder`), **Tools** (`/public-api-tokens · /power-bi · /esri-integration
· /webhooks`), plus Invitations, Ideas (cross-project input manager), Project
folders, Community monitor, Inspiration hub, Spaces.

A project's edit tabs: `phases/:phaseId/{setup, description, ideas, proposals,
form/edit, survey-form/edit, survey-results, polls, volunteering, map,
access-rights, emails, input-importer, report, insights}`. The two form builders:
`…/form/edit` (**input form**, ideation/proposals) and `…/survey-form/edit`
(**native survey**) — both built on the same custom-field system as registration
questions (`/admin/settings/registration`).

### A7. Survey / form / registration field types (`input_type`)
One `CustomField` model powers surveys, input forms, **and** registration questions.
Types:

- **Text:** `text` · `multiline_text` · `text_multiloc` · `multiline_text_multiloc` ·
  `html_multiloc` (rich text) · `html` (display block).
- **Choice:** `select` (single) · `multiselect` · `select_image` · `multiselect_image` ·
  `checkbox` · `ranking` (drag to rank).
- **Scales:** `linear_scale` (1–N, labelled) · `rating` (stars) ·
  `sentiment_linear_scale` (emoji + follow-up) · `matrix_linear_scale`.
- **Other:** `date` · `number` · `files` · `file_upload` · `image_files`.
- **Map / geo:** `point` · `line` · `polygon` · `shapefile_upload`.
- **Structural / built-in:** `page` (page break / section; `page_layout ∈ {default,
  map}`) · `topic_ids` · `cosponsor_ids`.

**Survey logic** is supported on only four: **`linear_scale`, `select`, `ranking`,
`page`** (page-level branching). Reference-distribution (representativeness):
`select · multiselect · checkbox`, and `number` only for `birthyear`. Default
registration fields map to built-in codes `gender · birthyear · domicile`.

---

## 13. Working knowledge (living — grows as we go)

This section is the **project brain**: what we learn building prototypes, the
user's product opinions and priorities, terminology preferences, decisions, and
corrections. Add to it proactively (see CLAUDE.md → "Keeping GOVOCAL.md alive").
Keep entries short, deduped, and dated when point-in-time. Newest at top.

- _(2026-06-14)_ This file should read as **a representation of the user's brain
  into this project** — capture their thinking, not just public product facts.
  Pull learnings from prototype conversations, the opportunities' `research.md` /
  `context.md`, and reviewer feedback as we go.

- _(2026-06-14)_ **Input-form / survey capture is reproducible without auth via the
  form-definition API.** `GET /web_api/v1/phases/<phase_id>/custom_fields` returns the
  full form JSON publicly (`data[]` = fields by `ordering`, `included[]` = options,
  matrix statements, images, map_configs) — even when the phase is closed and the
  resident render is gated. The pre-rendered `…/custom_fields/json_forms_schema` needs
  auth (401), but you don't need it. Captured a deliberate **kitchen-sink demo survey**
  ("Redesigning Coffman Park", wietsedemo tenant) exercising **all 17 input types** into
  `references/pages/input-form/` (internal) to drive the **Input Form** Pages-tab build.
  Capture script: `scripts/capture-input-form.py` (Playwright walk, both viewports).
- _(2026-06-14)_ **Survey "Next" gates on scale/rating/matrix fields even when they're
  marked `required:false`.** In the resident survey runner, the **Next** button stays
  `aria-disabled` until **`rating`, `linear_scale`, `sentiment_linear_scale`, and
  `matrix_linear_scale`** fields on the page are answered — pages with only
  text/select/checkbox advance unfilled. So these field types are *de-facto required to
  advance*. Reproduce this behavior in the Input Form page rebuild (it's real UX, not a
  bug to "fix"). The custom radio/scale controls are styled cards whose `<input>` is
  overlaid by divs → automating them needs `force=True` clicks on the option element.
- _(2026-06-14)_ **The user dislikes the GoVocal hot-pink brand.** The default
  `?theme=0` ("GoVocal") combination was changed from pink `#E10069` + black to a
  **deep teal `#0E7C86` primary + warm coral `#E2603A` secondary** (their call to me:
  "the pink is terrible, choose something better"). Teal clears AA for white button
  text (4.95:1); coral is a warm accent. Changed in the canonical `govocal-tokens.css`
  default + theme-0 in `govocal-themes.js`, and re-synced into every prototype's
  self-contained asset copy. **Themes 1–3 are real city tenants (Copenhagen, Vienna,
  California) — left untouched.** Note: this default is no longer the literal product
  brand; if exact GoVocal-brand fidelity is ever needed, the real pink is `#ef0071`.

- _(2026-06-14)_ **Per-theme typography is a real, wired feature** (the user cares about
  it switching per city). `--gv-font-family` is set per theme in `govocal-themes.js` and
  applied via `.gv-root`/components; every prototype/component/page/primitive uses the
  variable (no hardcoded fonts except monospace `<code>`). Real city faces (researched
  from official sources): **Stadt Wien = "Wiener Melange"** (Dalton Maag, 2019 — warm,
  humanist, rounded, open counters; proprietary, `wien.gv.at` CD-manual); **Københavns
  Kommune = "KBH Sans"** (Playtype/e-Types — Art-Nouveau curves + modern grotesque;
  proprietary, `design.kk.dk`); **GoVocal = Public Sans** (component-library default, no
  custom face); Engaged California = Noto Sans (free, exact). Proprietary faces can't be
  bundled → free substitutes chosen to match brand character: **Wien → Mulish** (warm
  humanist), **Copenhagen → Archivo** (grotesque). Real names are listed first in each
  stack so a licensed machine renders the true face. Drop in real web-font files for
  pixel-exact Wien/Copenhagen if/when licensed.

- _(2026-06-14)_ **Live navbar markup (from rendered Stadt Wien `mitgestalten.wien.gv.at`):**
  the real header is `<header id="e2e-navbar">`; the primary nav is a
  `<nav aria-label="Primäre">` landmark; the active homepage/logo link carries
  `aria-current="page"`; the **hamburger is GoVocal's filled three-bar icon**
  `M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z` (not a generic stroked icon) with
  label "Mobiles Navigationsmenü anzeigen"; sign-in button is `Anmelden`
  (`#e2e-navbar-login-menu-item`). Our header-nav component + `.gv-*` source now mirror
  this (`.gv-nav` = the `<nav>` wrapper, `.gv-nav__list` = the `<ul>`).

- _(2026-06-14)_ **The prototypes review site (the build.js shell) has its own
  Linear.app-style identity, kept deliberately separate from the GoVocal product
  brand.** **Light** near-white canvas (`#fbfbfd`) — switched from dark because a dark
  shell was a hard fit next to GoVocal's light brand content — with an indigo accent
  (`#5e6ad2` — never the GoVocal pink), Inter, faint indigo wash, and a glassy sticky
  top bar titled **"Product Team"** (with a ⌘K command-palette search). User pref:
  **no big page titles** (compact uppercase section labels instead); the user cares
  about the tooling UI being beautiful to work from. The **Components and Pages tabs
  are a designer reference** (Open only, no HTML download) — they exist so we verify
  surfaces look correct when building a prototype, not to copy from.
- _(2026-06-14)_ **10 GoVocal reference pages are the planned "Pages" roadmap**
  (shown as Pending cards, `PENDING_PAGES` in build.js): Content Builder, Project Page,
  Input Form, Survey Builder, Perspectives, Voting, Common Ground, Ideation, Project
  List, Project Editor. These are the real product surfaces to reproduce next.

<!-- Add new learnings above this line. Format: - _(YYYY-MM-DD)_ <fact / decision / preference>. -->

