# What is current here — and what has been left behind

Making a second version of a screen costs one folder, so a workspace fills up
with abandoned paths faster than anyone tidies them. Nothing breaks when it does:
the dead prototype still opens, still looks finished, and still sits in the
gallery next to the live one. That is the failure to watch for — a shelf where
current and abandoned look identical has stopped being a repository, and it never
announces itself.

Two facts answer it, and the workspace already records both: the **status**
somebody set on a unit, and the **date its bytes last changed**. One call returns
them together for every unit.

## The call

```
GET https://<your-site>/__publish/<workspace>/currency
Authorization: Bearer $AUGUR_TOKEN
```

Same token `augur connect` (or `augur login`) already saved for publishing; scoped to your workspace,
so it answers about that one and no other. (A signed-in browser reads the same
answer from `/__currency` — one function, two doors, because a person has a
session and you have a token.)

```json
{
  "staleAfterDays": 90,
  "now": "2026-08-27T09:12:04.000Z",
  "since": null,
  "count": 2,
  "units": [
    { "key": "checkout/flow", "path": "/checkout/flow/", "space": "acme",
      "status": "dev-ready", "statusLabel": "Dev ready",
      "editedAt": "2026-08-25T14:02:11.000Z", "by": "a1b2c3d4",
      "ageDays": 2, "stale": false, "when": "Edited 2 days ago" },
    { "key": "checkout/old-flow", "path": "/checkout/old-flow/", "space": "acme",
      "status": null, "statusLabel": null,
      "editedAt": "2025-11-02T08:44:00.000Z", "by": "a1b2c3d4",
      "ageDays": 298, "stale": true, "when": "Untouched for 9 months" }
  ]
}
```

`key` is the same key the status chip writes under, so a row joins straight onto
`/__status`. `by` is a one-way id, never an address — resolve it to a person
through the roster, not by guessing.

## What changed here lately

```
GET …/currency?since=14d          # 2w, 36h and a bare number of days also work
```

Narrows `units` to what actually moved in that window — the whole of "what
happened here recently", in one request, without walking a manifest. A window
the server cannot read is refused with a `400`, never widened: an answer to a
different question would read as a busy workspace.

## Three things to know before you use it

**`stale` has three values, and `null` is one of them.** A unit published before
per-file dates existed carries no date, so the answer is "no record" rather than
either extreme. Do not treat `null` as fresh, and do not treat it as abandoned —
say you do not know. It resolves itself the next time that unit is published.

**`staleAfterDays` is in the response because it is the instance's number, not
yours.** Read it; never hardcode 90. A workspace that moves the threshold would
otherwise keep hearing its old one from you.

**Never add a field to record staleness.** It is computed from the date a publish
already stamps, which is why it needs no upkeep. The tempting fix — a flag on a
prototype saying it is archived — is accurate only for units somebody came back
to mark, and the ones that matter are exactly the ones nobody came back to.
