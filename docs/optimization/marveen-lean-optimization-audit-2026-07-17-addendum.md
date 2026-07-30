# Addendum to the 2026-07-17 Lean Optimization audit

This is an addendum, not a revision. `marveen-lean-optimization-audit-2026-07-17.md`
is left exactly as written — it is a record of what was believed on 2026-07-17,
and rewriting it would destroy the evidence of how the picture changed.

Status as of 2026-07-29, after Phase 1 (card c755f4b2, as-built:
`lean-optimization-phase-1-as-built.md`).

## Corrections to the audit's findings

**G4 "data-sensitivity gate MISSING" was already stale when the audit was
written.** The gate shipped in commits `0e9759d` + `97aaf3c` on 2026-07-18, and
Istvan's ruling is that this was not a deliberate reversal — the audit simply
predated it. G4 should be read as "present but incomplete", and the specifics
the audit could not have known are:

- the gate was wired at exactly one of five content-bearing dispatch paths, and
  that one call site was later deleted by merge `14023f0`;
- `classifyContent` returned `public` when no pattern matched, which is
  fail-open;
- `evaluateDispatch` short-circuited on a trusted provider and wrote a false
  `public` category into the audit log;
- the audit table was already hash-only, so the audit's "no PII in logs" concern
  was already satisfied.

## Gap status after Phase 1

| Gap | Status |
|---|---|
| G1 (extent) | IMPLEMENTED |
| G4 (data-sensitivity gate) | **BUILT, PARKED at observe-only.** Not "implemented" — it is not enforcing, not merged, not deployed. |
| Neutral model-profile layer | IMPLEMENTED and accepted (Block B), additive, behaviour-neutral |

G4 is deliberately **not** marked implemented. Istvan removed privacy
enforcement from active Phase 1 scope on 2026-07-29 (no customer PII during
development; the primary operator input path is plugin-injected and unobservable
from Node). The gate exists and is tested, but it changes no dispatch decision
today. Recording it as implemented would be the exact false-green this
programme was meant to eliminate.

## Deferred

- Privacy enforcement (OBSERVE → ENFORCE) — deferred, resumable from commit
  `1f762e7`.
- Gating the channel-plugin input path — structurally outside this repo. See
  the as-built doc's Known limitations.
- Everything the audit assigned to Phase 2/3/4 — untouched, not started.
