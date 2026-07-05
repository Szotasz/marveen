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
- No autonomous action of any kind. `warning_threshold` / `hard_threshold` are
  **display-only** -- never stop an agent, switch a model, change a spend cap,
  top-up, or modify a subscription.
- No LLM anywhere in CostOps (summary is pure SQL + arithmetic). Future periodic
  collectors must run as `type: "command"` scheduled tasks (raw shell, no LLM),
  never as an LLM heartbeat.
- No raw account IDs / invoice refs / secrets in DB, logs, audit or API response.
  Use `hashRef(salt, raw)` for identifiers if ever needed.

## v0.2 -- token-cost ESTIMATE (deterministic, no LLM/provider API)

v0.2 adds a **separate, estimate-only** token cost derived from `token_usage`.
It is never folded into `current_spend` and is clearly labelled as an estimate.

**Model enrichment (forward-only).** `token_usage` now has nullable `model`,
`provider`, `model_source` columns. The ingestion (`src/web/token-usage.ts`)
captures `message.model` from the transcript for NEW rows (`model_source =
'transcript'`) and derives a coarse `provider` (`deriveProvider`). Existing rows
stay `NULL` (unknown) -- no uncertain backfill. **The model-capture activates on
the next dashboard restart**; rows ingested before that stay unknown.

**Pricing config (local, gitignored).** Per-model rates live in
`store/costops-pricing.json` (gitignored; a safe 0-rate `.example` is generated).
Rates are **per 1,000,000 tokens** in `currency`. No provider prices are hardcoded
in tracked source.

**Summary block.** `GET /api/costs/summary` gains `token_cost_estimate`
(`total_estimated_huf`, `priced_by_model[]`, `unpriced.{unknown_model_tokens,
no_rate_tokens}`, `pricing_profile_status`, `confidence: "estimate"`) and
`estimated_total_with_token_cost` (= `current_spend` + token estimate, clearly
labelled -- not added to `current_spend`).

**Provider billing/usage API collector is v0.3** (still no external API in v0.2).

## v0.3 -- provider cost collector framework

v0.3 adds a generic, deterministic framework to import ACTUAL provider cost as
high-confidence `provider_api` line items -- **without** overwriting the local
manual/estimate rows, and with a strict secrets-in-Vault-only posture.

- **Framework** (`src/costops/collectors/`): `ProviderCollector` interface with an
  INJECTED HTTP fetcher (so collectors are unit-tested fully offline with fixtures
  -- no live call unless a real fetcher is passed after explicit approval).
- **`runner.ts`**: loads a collector's normalized lines, idempotently upserts them
  into `cost_line_items` as `confidence='provider_api'`, and records an `import_runs`
  row. On error it DELETES NOTHING and records a **sanitized** failure (keys redacted).
- **`import_runs` table**: run history / sync status. No raw account id, no raw API
  response, no secret ever stored.
- **Config**: gitignored `store/costops-collectors.json` holds only non-secret
  wiring -- an `enabled` flag and a `secret_ref` (validated to REQUIRE the `vault:`
  form, never a raw key). A tracked safe example lives at
  `src/costops/collectors/collectors-config.example.json` (no key, no account id).
- **Summary reconcile**: the headline `current_spend` resolves each source to its
  single highest-confidence line so an actual supersedes an estimate WITHOUT
  double counting. New `reconcile[]` (per-source estimate vs actual vs variance) and
  `provider_sync[]` (last run per provider: status, freshness, stale/failed marker).

**Vault**: real Admin keys go into `src/web/vault.ts` via the secure handover, never
into config/log/transcript/dashboard-response.

## Known limitations

- Provider API calls only happen when Vault keys are configured and a live run is
  explicitly approved. Until then `provider_sync`/`reconcile` stay empty.
- Forward-only enrichment: token costs only appear for rows ingested AFTER
  the dashboard restart that activates model-capture.
- Forecast is a naive linear proration of usage-type lines; fixed monthly costs
  are attributed whole-month (no proration).
- No provider billing integration yet (see the maturity model in
  `audits/costops-v0.1-pr1-local-ledger-plan.md`).
