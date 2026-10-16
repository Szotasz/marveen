# Upstream ledger: what have we NOT decided on yet?

`scripts/upstream-new.sh`

## The problem it solves

A fork that carries its own work cannot always merge upstream wholesale. Some commits get
hand-ported, some are deliberately skipped because they collide with local behaviour.

Git compares commit **identity**, not content. A hand-ported commit keeps a different SHA, so
`git log HEAD..upstream/develop` lists it forever. The list only grows, and every review has to
re-read commits it already decided on -- which is exactly the friction that makes a fork stop
reviewing upstream at all.

## How it works

`store/upstream-ported.json` is the missing memory: every SHA that was ported or consciously
skipped, with a one-line reason. The script subtracts the ledger from the upstream log, so what
it prints is genuinely new.

```bash
scripts/upstream-new.sh                 # unhandled upstream commits, newest first
scripts/upstream-new.sh --count         # just the number
scripts/upstream-new.sh mark ported  <sha> "reason"
scripts/upstream-new.sh mark skipped <sha> "reason"
scripts/upstream-new.sh mark pending <sha> "what it waits for"
```

A SHA lives in exactly one bucket: re-marking moves it rather than duplicating it.

`ported` and `skipped` are decisions, so the script subtracts them. **`pending` is not a
decision**, so it stays on the list with its note attached:

```
  6d059637  2026-08-29  feat(x): something  [pending: waiting on the author]
```

and it still counts in `--count`. Marking something pending must never be the gesture that
makes you forget it -- that is the failure this script exists to prevent.

The ledger is **per-install state** -- every fork makes its own decisions -- so it lives under
the gitignored `store/` and the script seeds it on first use. Nothing to set up.

## Which upstream ref

`UPSTREAM_REF` (default `upstream/develop`). Point it at whatever you track:

```bash
UPSTREAM_REF=upstream/main scripts/upstream-new.sh
```

## What it is worth

Measured on 2026-08-31, on this fork (`maxineender/marveen`, tracking `Szotasz/marveen`),
which had let 54 upstream commits accumulate: the raw
`git log HEAD..upstream/develop` listed everything ever hand-ported alongside them, while
`upstream-new.sh` listed only the genuinely undecided ones. That is the difference between a
review someone will do and one they will keep postponing.
