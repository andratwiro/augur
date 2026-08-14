# How a prototype gets made — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the README's "How a prototype gets made" section, backed by a real
receipt in fulla and a real capture of the session that produced it.

**Architecture:** One live authoring session (HUMAN + agent) produces all three
artifacts — a new fulla screen, its receipt, a screen recording. The recording
becomes `docs/shots/authoring.gif`; the receipt's opening brief becomes the README's
fenced block, verbatim. Engine work happens in a fresh worktree off `origin/main`
(the main checkout is parked mid-avatars on a detached HEAD — do not touch it).

**Tech Stack:** git worktrees, macOS screen recording (Cmd-Shift-5), ffmpeg
(installed; gifsicle optional via brew), the engine's own `dev.mjs` / `publish.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-14-authoring-loop-receipts-design.md`

## Global Constraints

- **Zero engine code.** Only `README.md`, `docs/shots/authoring.gif`, and the two
  superpowers docs change in the engine repo.
- **The honesty rule:** a receipt is captured at authoring time, never
  reconstructed. If a session step was skipped or lost, the artifact is redone —
  not backfilled.
- **Copy claims only what is true at merge time:** "screens carry", never "every
  screen carries". "Claude Code" appears exactly once in the section; "any coding
  agent" exactly once.
- **The brief must fit the README's fenced block without elision** — keep it under
  ~12 lines when writing it.
- **Gif budget:** ≤ 2.0 MB (match `canvas-live.gif`), 15–20 s loop, ends on pixels
  not terminal.
- **Receipt path:** `garden/prompts/seed-swap.md` — outside `prototypes/`, so it
  never publishes (same privacy class as `garden/context.md`).
- **Never `publish.mjs --all` from this parent.** `delta-designs/` holds spaces of
  two instances (delta + demo); `--all` would cross-publish. Always publish from
  inside the one space clone.
- **HUMAN steps** are Rob's — the executing agent stops and asks, INSTALL.md style.
- The featured screen is **Seed swap** (`garden/prototypes/seed-swap/`). If Rob
  renames it at session time, the new name propagates everywhere this plan says
  `seed-swap` (folder, URLs, receipt filename, README links, status key).

---

### Task 1: Worktree, branch, and the docs that ride it

**Files:**
- Create: worktree `~/Documents/delta-designs/augur-readme/` on branch
  `readme/authoring-loop` from `origin/main`
- Create (in worktree): `docs/superpowers/specs/2026-08-14-authoring-loop-receipts-design.md`,
  `docs/superpowers/plans/2026-08-14-authoring-loop-receipts.md` (copied from the
  main checkout, where they sit untracked)

**Interfaces:**
- Produces: `~/Documents/delta-designs/augur-readme/` — every later engine-side
  task works here, and its `scripts/` serve fulla in tasks 2–3.

- [ ] **Step 1: Create the worktree off current main**

```bash
cd ~/Documents/delta-designs/augur
git fetch origin
git worktree add ../augur-readme -b readme/authoring-loop origin/main
```

Expected: `Preparing worktree (new branch 'readme/authoring-loop')`, HEAD at
origin/main (`83861190` or newer). The detached checkout is untouched.

- [ ] **Step 2: Copy spec + plan onto the branch and commit**

```bash
cp docs/superpowers/specs/2026-08-14-authoring-loop-receipts-design.md ../augur-readme/docs/superpowers/specs/
cp docs/superpowers/plans/2026-08-14-authoring-loop-receipts.md ../augur-readme/docs/superpowers/plans/
cd ../augur-readme
git add docs/superpowers
git commit -m "Spec+Plan: how a prototype gets made (receipts + authoring capture)"
```

- [ ] **Step 3: Verify the worktree's engine serves fulla**

```bash
cd ~/Documents/delta-designs/augur-space-fulla
node ../augur-readme/scripts/dev.mjs
```

Expected: the dev server starts and prints its local URL; the fulla gallery loads
in a browser. Note the URL — task 2 records against it. Leave it running or note
how to restart it.

---

### Task 2: HUMAN — the authoring session

One session produces the screen, the receipt, and the recording. Nothing here can
be done by the executing agent on Rob's behalf — the honesty rule forbids it.
The executing agent's job for this task: prepare the two files in steps 1–2,
present the checklist, then stop and wait.

**Files:**
- Create: `~/Documents/delta-designs/augur-space-fulla/garden/prompts/seed-swap.md`
  (skeleton first, filled during the session)
- Create (by the session's agent): `garden/prototypes/seed-swap/index.html`
- Modify: `prototype-status.json` (add `"garden/seed-swap": "in-progress"`)
- Create (recording): `~/Documents/delta-designs/captures/authoring-seed-swap.mov`

**Interfaces:**
- Consumes: the dev server from Task 1 step 3.
- Produces: the committed screen + receipt on fulla `main` (Task 3 publishes
  them); the `.mov` (Task 4 cuts it); the receipt's opening brief (Task 5 quotes
  it verbatim).

- [ ] **Step 1: Create the receipt skeleton (before the session, so prompts land as issued)**

```bash
mkdir -p ~/Documents/delta-designs/augur-space-fulla/garden/prompts ~/Documents/delta-designs/captures
```

Write `garden/prompts/seed-swap.md`:

````markdown
# Seed swap — the session that made it

> A receipt is captured at authoring time, never reconstructed. A screen
> without one says so by having none.

*Context handed to the agent: the fulla clone, the engine contracts in
`agents/`, the fulla design-system skill.*

## The brief

```text
(paste the brief here, verbatim, the moment it is issued)
```

## Follow-ups

> (each follow-up, verbatim, in the order issued)

---

Claude Code, 2026-08-14.
````

- [ ] **Step 2: Draft brief — Rob edits before the session, keep it ≤ 12 lines**

```text
Seed swap — a noticeboard where members offer saved seeds and claim each
other's. One screen. A board of offer cards: who, what, roughly how many,
which plot they came from — "Fava beans, saved from plot 12, ~40 seeds".
Claiming an offer keeps the card on the board but settles it down visually;
the swap happens at the shed, not in the app. The empty state suggests the
first action instead of apologizing. Warm and hand-made like the rest of
Fulla — use the fulla design system, don't invent new vocabulary. Add the
one-line meta description. No routing, no backend; seed the board with a
handful of believable offers.
```

- [ ] **Step 3: HUMAN — pre-flight**

- Dev server running (Task 1 step 3), browser on the fulla gallery.
- Terminal (Claude Code, fresh session, cwd = the fulla clone) on the left,
  browser on the right, both inside one Cmd-Shift-5 "record selected portion"
  region. Do Not Disturb on; nothing personal in frame.
- Start recording. It is fine to record long — Task 4 trims.

- [ ] **Step 4: HUMAN — run the session**

- Operational preamble to the agent (this is context, not the brief): *"You are
  in the fulla space. Read `../augur-readme/agents/prototype-contract.md` and the
  fulla design-system skill, then build the screen I brief under
  `garden/prototypes/seed-swap/`."*
- Paste the brief into the agent **and** into the receipt's fenced block.
- Every follow-up you give: paste into the receipt as a `>` line at the moment
  you issue it. Follow-ups are the point — direct like a designer ("warmer",
  "the empty state should suggest the first action").
- Watch the hot-reload flips in the browser; end the recording by poking the
  finished screen and pinning a Shift+C comment on it.
- Save the recording as `~/Documents/delta-designs/captures/authoring-seed-swap.mov`.

- [ ] **Step 5: Register the status chip**

In `prototype-status.json`, add inside the object:

```json
  "garden/seed-swap": "in-progress",
```

- [ ] **Step 6: Verify the contract, then commit on fulla main**

```bash
cd ~/Documents/delta-designs/augur-space-fulla
grep -c 'meta name="description"' garden/prototypes/seed-swap/index.html   # ≥ 1
open garden/prototypes/seed-swap/index.html                                # works from file://
git add garden/prototypes/seed-swap garden/prompts/seed-swap.md prototype-status.json
git commit -m "garden: seed swap — first screen with an authoring receipt"
```

Expected: the screen renders opened straight from disk; the receipt holds the
brief and at least one follow-up, verbatim.

---

### Task 3: Publish fulla, verify it live and readable

**Files:**
- None created — pushes fulla `main`, publishes to the demo instance.

**Interfaces:**
- Consumes: Task 2's commit.
- Produces: `https://demo.augur.works/garden/seed-swap/` live (Task 5 links it);
  `https://raw.githubusercontent.com/andratwiro/augur-space-fulla/main/garden/prompts/seed-swap.md`
  resolving (Task 6 checks it).

- [ ] **Step 1: Token preflight**

```bash
python3 -c "import json,os;print(list(json.load(open(os.path.expanduser('~/.config/augur/tokens.json'))).keys()))"
```

If no key covers the demo instance (`demo.augur.works` — currently absent; only
`augur-demo.pages.dev` is present, which may or may not be honored): **HUMAN**
logs in — `node ../augur-readme/scripts/login.mjs --origin https://demo.augur.works`
from the fulla clone, with admin credentials. Never write the password anywhere.

- [ ] **Step 2: Push and publish (from inside the fulla clone — never `--all`)**

```bash
cd ~/Documents/delta-designs/augur-space-fulla
git push
node ../augur-readme/scripts/publish.mjs
```

Expected: publish reports success for the `fulla` space, not dirty.

- [ ] **Step 3: Verify live**

```bash
curl -s https://demo.augur.works/_build.json | python3 -m json.tool | grep -B1 -A3 '"fulla"'
curl -s -o /dev/null -w '%{http_code}\n' https://demo.augur.works/garden/seed-swap/
curl -s -o /dev/null -w '%{http_code}\n' https://raw.githubusercontent.com/andratwiro/augur-space-fulla/main/garden/prompts/seed-swap.md
curl -s https://demo.augur.works/garden/prompts/seed-swap.md | grep -c "captured at authoring time"
```

Expected: `sha` matches `git rev-parse HEAD`, `dirty` false; then `200`
(screen live), `200` (receipt readable logged-out on GitHub), and `0` for the
last one — the receipt's text must NOT be served by the site. Status codes
prove nothing here: the gate answers unknown paths with a login page at 200,
which is itself the correct "unpublished" outcome.

- [ ] **Step 4 (optional): posters**

The gallery card falls back to a live iframe without one, so this can wait:
`cd ~/Documents/delta-designs/augur-readme && npm install && node scripts/shoot.mjs --stale`,
then commit the generated `preview.webp` / `og.jpg` in fulla and repeat steps 2–3.

---

### Task 4: The capture — `docs/shots/authoring.gif`

**Files:**
- Consume: `~/Documents/delta-designs/captures/authoring-seed-swap.mov`
- Create: `~/Documents/delta-designs/augur-readme/docs/shots/authoring.gif`

**Interfaces:**
- Consumes: Task 2's recording.
- Produces: `docs/shots/authoring.gif` ≤ 2.0 MB (Task 5 embeds it).

- [ ] **Step 1: HUMAN — trim the .mov to the four beats**

In QuickTime (Edit → Trim, or split into clips): brief pasted → agent working →
the hot-reload flip → poking the screen + the Shift+C pin. Aim for 60–120 s of
trimmed source; time-compression happens next. Export as
`captures/authoring-trimmed.mov`. If exported as several clips, concat first:

```bash
cd ~/Documents/delta-designs/captures
printf "file '%s'\n" clip1.mov clip2.mov clip3.mov > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy authoring-trimmed.mov
```

- [ ] **Step 2: Compress time and preview**

```bash
cd ~/Documents/delta-designs/captures
ffmpeg -i authoring-trimmed.mov -vf "setpts=PTS/5,fps=10,scale=1280:-2:flags=lanczos" -an -y fast.mp4
open fast.mp4
```

Tune `PTS/5` until the result lands in 15–20 s and the reload flip is still
legible at full speed. HUMAN judges the timing.

- [ ] **Step 3: Two-pass palette gif, then check the budget**

```bash
ffmpeg -i fast.mp4 -vf "palettegen=stats_mode=diff" -y palette.png
ffmpeg -i fast.mp4 -i palette.png -lavfi "paletteuse=dither=bayer:bayer_scale=4" -y authoring.gif
du -h authoring.gif
```

Expected: ≤ 2.0 MB. If over, in order: rerun step 2 with `scale=1100:-2`, then
`fps=8`; last resort `brew install gifsicle` and
`gifsicle -O3 --lossy=80 authoring.gif -o authoring.gif`. Re-check `du -h` after
each. Confirm the loop ends on the pinned comment, not the terminal.

- [ ] **Step 4: Commit**

```bash
cp authoring.gif ~/Documents/delta-designs/augur-readme/docs/shots/authoring.gif
cd ~/Documents/delta-designs/augur-readme
git add docs/shots/authoring.gif
git commit -m "shots: the authoring session, brief to pinned comment"
```

---

### Task 5: The README section

**Files:**
- Modify: `~/Documents/delta-designs/augur-readme/README.md` — insert between the
  fulla intro paragraph ("…everything below works against it.") and
  `## Boards where the prototypes run`.

**Interfaces:**
- Consumes: the receipt's opening brief (Task 2, quoted verbatim), the gif
  (Task 4), the live URL (Task 3).

- [ ] **Step 1: Insert the section**

The fenced brief below is the plan's draft; **replace it with the receipt's
opening brief, verbatim** — if the session changed a word, the README changes
with it.

````markdown
## How a prototype gets made

There is no editor. A prototype is briefed, not drawn — you describe the screen
the way you would brief a designer, and an agent builds it as a real page in
the space, using the design system like anyone else on the team.

The brief that made [Seed swap](https://demo.augur.works/garden/seed-swap/):

```text
Seed swap — a noticeboard where members offer saved seeds and claim each
other's. One screen. A board of offer cards: who, what, roughly how many,
which plot they came from — "Fava beans, saved from plot 12, ~40 seeds".
Claiming an offer keeps the card on the board but settles it down visually;
the swap happens at the shed, not in the app. The empty state suggests the
first action instead of apologizing. Warm and hand-made like the rest of
Fulla — use the fulla design system, don't invent new vocabulary. Add the
one-line meta description. No routing, no backend; seed the board with a
handful of believable offers.
```

![The agent building the seed swap screen from the brief while the browser hot-reloads into it](docs/shots/authoring.gif)

That is Claude Code in the capture; any coding agent that can read the
contracts in [agents/](./agents/) does the same job. Screens in the demo space
carry the session that made them — [open the repo and read one](https://github.com/andratwiro/augur-space-fulla/tree/main/garden/prompts).
The follow-ups read like design direction, because that is what they are.
````

- [ ] **Step 2: Verify claims and counts**

```bash
cd ~/Documents/delta-designs/augur-readme
grep -c "Claude Code" README.md          # exactly 1
grep -c "any coding agent" README.md     # exactly 1
grep -n "authoring.gif" README.md        # present, path docs/shots/
grep -n "every screen" README.md         # no match in the new section
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: how a prototype gets made"
```

---

### Task 6: Verification sweep and ship

**Files:**
- None — checks, push, and a HUMAN merge decision.

- [ ] **Step 1: The spec's verification list**

```bash
cd ~/Documents/delta-designs/augur-readme
# Brief is verbatim: extract the README's fence and diff against the receipt's.
awk '/^```text$/,/^```$/' README.md | sed '1d;$d' > /tmp/readme-brief.txt
awk '/^```text$/,/^```$/' ~/Documents/delta-designs/augur-space-fulla/garden/prompts/seed-swap.md | sed '1d;$d' > /tmp/receipt-brief.txt
diff /tmp/readme-brief.txt /tmp/receipt-brief.txt && echo VERBATIM
```

Expected: `VERBATIM`. Then by eye: the gif's final frame shows the screen that is
live at `https://demo.augur.works/garden/seed-swap/`.

- [ ] **Step 2: Push the branch and check the render**

```bash
git push -u origin readme/authoring-loop
```

**HUMAN:** open
`https://github.com/andratwiro/augur/blob/readme/authoring-loop/README.md` —
image renders, fence renders, all three links resolve logged-out.

- [ ] **Step 3: HUMAN — merge**

Rob's call: `gh pr create` for a paper trail, or merge `readme/authoring-loop`
into `main` and push. README changes are repo-only — nothing deploys, no pin
bump needed anywhere.

- [ ] **Step 4: Cleanup**

```bash
cd ~/Documents/delta-designs/augur
git worktree remove ../augur-readme   # only after the merge has landed
```
