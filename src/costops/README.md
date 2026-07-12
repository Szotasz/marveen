# CostOps -- local cost ledger (base)

A deterministic, read-mostly local cost ledger for the operator's own recurring
costs (subscriptions, hosting, domain, SaaS). Pure SQL + arithmetic: no LLM, no
provider API calls, no secrets. Real amounts and account references live in a
gitignored local config, never in the repo.

This is the base slice: manual/fixed cost sources, a monthly summary with
budget thresholds, and token-usage **volume** reporting (activity only, never
priced). Provider collectors, provider-API imports, and token-cost pricing are
intentionally out of scope here and land in follow-up changes.

## Data model

- `cost_sources` -- provider/subscription origin (id, name, provider, type,
  currency, active). No raw account IDs.
- `cost_line_items` -- individual charge rows for a charge period (billed_cost,
  confidence, dedup_key for idempotent upserts). FOCUS-inspired.
- `budgets` -- display-only warning/hard thresholds. No action is ever taken;
  status is informational.

## Config (local, gitignored)

The operator's fixed/manual monthly costs and budgets live in
`store/costops-config.json` (under the gitignored `store/` tree, so real amounts
and account references never enter git). A safe `*.example` is generated on first
load if no config exists. With no config present the summary is simply empty --
it never fabricates numbers and never blocks the rest of the app.

```json
{
  "currency": "HUF",
  "fixed_costs": [
    { "source_id": "example-subscription", "name": "Example subscription", "provider": "other", "source_type": "subscription", "amount": 0, "confidence": "manual" }
  ],
  "budgets": [
    { "id": "global-monthly", "name": "Monthly budget", "amount": 0, "warning_threshold": 0.8, "hard_threshold": 1.0 }
  ]
}
```

## API (Bearer-gated, read-only)

- `GET /api/costs/summary` -- monthly spend, forecast, per-source and confidence
  breakdown, budget status, and token-usage volume. On read it idempotently
  reflects the config's fixed costs into the ledger (upsert by dedup_key).
- `GET /api/costs/sources` -- active cost sources.
- `GET /api/costs/budgets` -- configured budgets.

No client writes, no LLM, no provider API, no secrets in any response.

## Guardrails

- Deterministic: every function takes `db` and `now`, unit-tested against an
  in-memory database.
- Manual/fallback is the only cost source in this slice; the provider-derived
  path is empty and handled gracefully.
- Token usage is reported as **volume only** and explicitly not priced; no money
  is ever derived from tokens here.
- Additive schema (`CREATE TABLE IF NOT EXISTS`); with no CostOps config the rest
  of the app behaves exactly as before.
