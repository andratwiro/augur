# The refine loop — verifying a rebuilt canon by photograph

Rebuilding a design system's components against a real product is not finished when the
agent doing it says it is finished. It is finished when each component, rendered and
photographed, looks like the original. That is a measurement, and `augur refine` takes it.

The loop is old and boring and it is the reason the work takes as long as it takes:

```
render the candidate → photograph it → compare it to the original → fix → repeat
```

Run overnight, it converges. Run once, it tells you how far off you are. What it never
does is ask the thing being measured how it thinks it did.

## The one rule: no self-assessment

The harness renders the pixels, measures them, and derives pass and fail from the number
**every time the report is drawn**. There is no `--approve`, no "mark as done", and
deliberately **no command that adopts a candidate render as its own reference** — a
blessing tool is the whole hole, because an agent that can nominate its own output as the
thing to match can make anything pass. References come from OUTSIDE the loop.

Four consequences worth knowing, because each one closes a way round the rule:

| | |
|---|---|
| The ledger stores measurements, never verdicts | A line edited to say `"pass": true` changes nothing — the field is not read. |
| `--audit` re-derives every verdict from the saved screenshots | A line whose *number* was edited disagrees with the pixels it claims to describe, and the audit names it. |
| `--gate` refuses to run with `--only` | A pass-rate over components you picked is a claim wearing a measurement's clothes. |
| The threshold is printed on the same line as the pass-rate | Loosening the bar is the cheapest way to turn a red night green, so the bar travels with the number. |

**What is still the reader's job.** The manifest and the references *are* the canon.
Anyone who can edit those can change what "correct" means, and no harness can tell that
from a legitimate correction. Extract references from the original product and review them
like source. This tool guarantees the number describes the pixels — not that those were the
right pixels to ask for.

## The manifest

`refine.json` at the root of the canon:

```json
{
  "viewport": { "width": 520, "height": 280 },
  "threshold": 0.02,
  "pixelTolerance": 0.02,
  "components": [
    { "id": "action-button", "candidate": "components/action-button", "reference": "original/action-button" },
    { "id": "summary-card",  "candidate": "components/summary-card",  "reference": "original/summary-card", "threshold": 0.005 }
  ]
}
```

`id` names the component in the report and the screenshot filenames. `threshold` on a
component overrides the manifest's for that one. Everything else is optional and defaults
to the values above.

With no `refine.json`, the harness discovers components instead: every gallery-tier folder
(`base/`, `components/`, `patterns/`, `pages/`) and every prototype folder that has a
`reference.png` beside it or a `reference/` folder to render. **A folder with no reference
is listed as unverifiable, never silently dropped** — a component nothing can be compared
against is not a passing component, and the report says so by name.

### What a reference (or a candidate) may be

One string per side; the kind is inferred.

| Written as | Means |
|---|---|
| `components/card` | a folder (or an `.html` file) on disk, rendered over `file://` |
| `/components/card/` | a site path, rendered through `--base <origin>` — the real serving path |
| `https://…` | a URL, rendered as-is |
| `shots/card.png` | an image already captured; loaded, not rendered |

#### ⚠️ A URL does not describe its own contents

Resuming works by digesting what each side is made of (see below). A folder or a PNG can be
digested; a URL cannot — and digesting the URL *string* would be the worst kind of wrong,
because the string never changes and the component you fixed at 2am would keep its 11pm
verdict all night.

So a side rendered from a URL needs something on disk behind it:

- a **site path** resolves by convention to the same-named folder under the canon root
  (`/components/card/` → `components/card`), which is what serving your own canon over a
  local server gives you for free;
- `"candidateSource"` / `"referenceSource"` on the component override that, for a server
  whose URLs are not its folder names;
- anything left over is **volatile**: re-measured every run, never resumed, and named in
  the run's output. "I cannot tell whether this changed" is an honest answer. "Unchanged"
  would not be.

**Prefer rendering both sides over a captured PNG.** When both sides are rendered in the
same browser in the same run, font rasterisation, hinting and antialiasing are identical on
both sides and cancel exactly, so the comparison is about the component. A PNG captured on
another machine brings that machine's font stack with it, and the threshold then has to
absorb text-edge noise — which is how a harness ends up too loose to catch anything. If you
must use captured PNGs, make that mode's threshold empirical rather than hopeful: measure a
component you know is right, and set the bar above the noise you actually observe.

## The two numbers

Per pixel, the harness takes the YIQ-weighted colour distance and compares it to
`pixelTolerance`; then it takes the fraction of pixels that exceeded it and compares that
to `threshold`.

Two numbers rather than one, because the two classic errors leave opposite signatures:

- **A shifted padding** moves a *small number* of pixels a *long way*.
- **A wrong hue** moves a *large number* of pixels a *short way*.

A single mean delta hides both under a big flat background. Counting pixels over a
per-pixel cutoff catches both.

`pixelTolerance` defaults to `0.02`, which forgives a uniform grey shift of about five
levels out of 255 and catches six. That is tight on purpose: in same-run rendering, two
renders of the same thing are bit-identical and there is nothing legitimate to forgive. The
widely published default of `0.1` puts the cutoff twenty-five times higher, which lets a
twenty-level channel error through unremarked — and a wrong hue is exactly a twenty-level
channel error.

### ⚠️ Size the viewport to the component

`threshold` is a fraction of the **frame**, so it only means anything if the component
fills the frame. A small component photographed on a large empty page can be badly wrong in
1% of the pixels and pass. This is the one reliable way to get a green run that means
nothing.

## Running it

```
augur refine                        verify every component in refine.json
augur refine --gate 0.99            …and exit 1 unless 99% of them pass
augur refine --root ./canon         a canon that is not the current directory
augur refine --base http://localhost:8791    render site paths through a local server
augur refine --only card,toolbar    just these, while you work on them
augur refine --restart              ignore the ledger and re-measure everything
augur refine --audit                re-derive every verdict from the saved shots, no browser
```

Output lands in `.augur-refine/` (gitignored): `ledger.jsonl`, `report.json`, and
`shots/<id>.{candidate,reference,diff}.png`. The diff image marks every counted pixel over a
ghost of the reference — for a person to look at **after** the fact, never for the verdict.

**The exit code is the answer**, because the caller is a loop and a printed table is not
something a loop can read.

| code | meaning |
|---|---|
| `0` | with `--gate`, the rate met it; without one, every component passed |
| `1` | the gate was missed, or something failed or was never measured |
| `2` | the run could not be made sense of (no manifest, a bad flag, no browser) |

Without a gate, a component the run never reached is a non-zero exit: silence is not a pass.

## The overnight loop an agent drives

```sh
# Each pass: measure, then work on whatever failed, then measure again.
until augur refine --gate 0.99; do
  # .augur-refine/report.json lists every component and its number.
  # Fix the worst ones; the next run re-measures only what changed.
  work-on-the-failures
done
```

Three properties make this safe to leave running:

**It is resumable, by content — and by content only.** Each component's measurement is appended to
`.augur-refine/ledger.jsonl` and fsynced before the next one starts, so a run killed at
component 340 of 500 restarts at 341 rather than at 1. Skipping is keyed on the digests of
both sides plus a fingerprint of the settings — so editing one component re-verifies that
one and skips the rest, and changing the threshold or the viewport re-verifies everything,
because the old numbers were measured under different rules. A torn final line is discarded
on read rather than crashing the next run: that is the only sane reading of a file a kill
was allowed to end.

**A failed render is retried, never resumed.** An errored measurement is recorded so the
component counts as failed rather than as missing, but it is never treated as a completed
answer. This matters more than it sounds: without it, one browser crash at component 200 of
500 writes a permanent failure for the remaining 300, and every resume afterwards skips
them — the run reports 40% forever and nothing re-renders.

**The browser is replaced if it dies.** A long night is long enough for a browser to be
killed by the OS, run out of memory, or be caught by a machine sleeping. The harness
relaunches and retries that component once. A component that is genuinely unrenderable
fails on the first attempt and is not retried — retrying a real fault just doubles the
night.

## Seeing it work, in ten seconds

A sample canon ships with the engine: fourteen small components, each with the original it
was rebuilt from. Twelve match. Two do not, and they are the two classic errors — one
component's padding moved, another's fill hue changed.

```
augur refine --root test/fixtures/canon
```

```
summary-card               5.57%  FAIL   ← padding: few pixels, moved a long way
notice-banner             36.02%  FAIL   ← hue: a third of the frame, moved a hair
14 components · 12 pass · 2 fail · 0 not measured
measured pass-rate 85.71% at threshold 2.00%
```

Open `.augur-refine/shots/notice-banner.diff.png` afterwards and the point of the harness
is on the screen: `#dbe9ff` became `#dbe9e2`, the worst pixel in the frame moved about a
tenth of one percent of the way across colour space, and nobody flicking between two
screenshots at 2am was ever going to see it.

## Auditing a run someone else reports

```
augur refine --audit
```

Re-measures every saved screenshot pair with no browser and no trust in the ledger's
arithmetic, then compares what it found to what the ledger claims. A number that was edited
is named:

```
LEDGER DISAGREES WITH THE PIXELS:
  summary-card: ledger says 0.00%, the shots say 5.57%
```

It also checks that each saved screenshot is the one the ledger recorded a hash for, so
swapping in a better-looking capture is caught too. Exit 1 on any discrepancy.
