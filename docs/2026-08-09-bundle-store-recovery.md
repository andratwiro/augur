# Recovering the bundle store

What to do when the R2 bucket behind an instance is damaged, emptied, or gone.

## What is actually at risk

Space content reaches production only through `augur publish`, into the bundle
store. Nothing rebuilds it from git on a schedule any more, so it is worth being
precise about what a total loss of the bucket would cost:

| | Recoverable from | Cost |
|---|---|---|
| A clean publish | the space repo at the recorded `sha`, republished | time |
| Engine chrome | the engine repo at the recorded `sha`, redeployed | a CI run |
| Instance config | the deploy shell (`identity.json`, `deploy.config.json`) | a CI run |
| **A dirty publish** | **nothing** | **the bytes are gone** |
| Publish history / versions | nothing (an export, if you took one) | rollback targets |

Only the last two rows are irreplaceable, and the fourth is the reason this
document exists. A publish made from an uncommitted working tree serves bytes that
exist in no repository anywhere. `/_build.json` flags those with `dirty: true`,
the admin panel shows a red chip, and the deploy canary complains once one
outlives its grace window — because the right response to a dirty publish is to
commit and republish, not to rely on a backup catching it.

Note also what is NOT at risk: KV. Comment threads, pins, dev statuses and renames
live there, backed up separately by the shell's `kv-backup.yml`.

## In-store recovery: rollback

The store keeps every version manifest it has ever written (nothing prunes them)
and never garbage-collects blobs, so any past publish is still fully addressable.
A bad publish does not need a backup — it needs a rollback:

```
curl -X POST https://<origin>/__publish/<space>/rollback \
  -H "Authorization: Bearer $AUGUR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"version": 14}'
```

List the versions to choose from:

```
curl -s https://<origin>/__publish/<space>/versions -H "Authorization: Bearer $AUGUR_TOKEN"
```

A rollback repoints the live manifest and takes effect within a couple of seconds
(other isolates within ~1.5s). It does not delete the version you rolled away
from, so it is reversible in both directions.

## Off-Cloudflare copy: export

```
augur export --out /path/to/backup             # live state of every space + chrome
augur export --out /path/to/backup --history   # + every retained version's manifest and blobs
```

The output is a plain directory — `manifests/<id>.json`, `blobs/<sha256>`,
`export.json` — and it is incremental: blobs already present are skipped, so
re-running is cheap and safe. Point it somewhere your normal backups already
cover and run it on a schedule.

It authenticates with an ordinary publish token, not Cloudflare account
credentials. That is deliberate: the machine holding the backup schedule should
hold the weakest credential that can do the job, and a restore should need nothing
but the directory and a token.

Not included: `config/instance.json` (the user roster). It is reproducible from
the deploy shell, and it is not a thing to keep extra copies of. After a
total-loss restore, one shell deploy puts it back.

## Restoring

```
augur restore /path/to/backup --dry-run    # what would ship
augur restore /path/to/backup              # blobs, then one commit per space
```

A restore is an ordinary publish: it uploads the blobs the store is missing, then
commits each manifest, so it lands atomically and gets a fresh version number. It
does not rewrite history — the restored state arrives on top of whatever the store
already has, which means a mistaken restore is itself undone by `rollback`.

Two guards worth knowing:

- If live content is **newer** than the copy, restore refuses. Pass `--force` when
  burying it is genuinely what you mean.
- If the copy is missing a blob that the store also lacks, restore stops before
  committing anything. The live site is untouched and the run can be repeated once
  the copy is complete.

`source` provenance rides through unchanged, so a restored site still reports the
sha it was built from — including the dirty flag, if that publish had one.

## Total loss: the whole sequence

1. Recreate the bucket and rebind it (`BUNDLES`) on the Pages project.
2. Deploy the shell. This ships the worker, publishes engine chrome, and pushes
   `config/instance.json` — the site comes up, gated, with no space content.
3. `augur restore <dir>` for every space.
4. `augur status` from a god-mode checkout: live should match each clone.
5. If there is no export to restore from, publish each space from a clean clone at
   the sha `/_build.json` last reported. Anything that was dirty is lost; publish
   the current tree instead and say so.

## Testing it

Run the round trip against the canary instance, not production:

```
augur export --out /tmp/augur-canary
augur restore /tmp/augur-canary --dry-run
```

A dry run that reports zero blobs to upload for every space is the assertion worth
having: it means the copy on disk is byte-identical to what is live.
