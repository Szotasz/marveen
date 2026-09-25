# Billingo MCP server (read-only)

`scripts/billingo-mcp.py` is a dependency-free Python stdio MCP server for the
[Billingo](https://www.billingo.hu) v3 API, the Hungarian invoicing service.

Guardrail: **read-only**. Only list/get tools exist; there is deliberately no
create, modify or delete tool, so the agent can inspect financial documents
but never change them, whatever the key's scope.

Tools (5): `billingo_list_documents` (outgoing invoices / documents),
`billingo_get_document`, `billingo_list_partners`,
`billingo_download_document` (PDF to a local file), `billingo_list_spendings`
(incoming / supplier invoices).

Transient upstream failures (HTTP 429, 5xx, network) are retried with
exponential backoff, and a list endpoint that returns an unexpectedly empty
page is retried too, so a report does not silently treat "empty" as zero.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `BILLINGO_KEY` | yes | Billingo v3 API key (sent as `X-API-KEY`). Inject it from the dashboard Vault via a binding. |
| `BILLINGO_DOWNLOAD_DIR` | no | Where `billingo_download_document` writes PDFs. Default: `<system temp>/billingo`. |

## .mcp.json

```json
{
  "mcpServers": {
    "billingo": {
      "command": "python3",
      "args": ["<install>/scripts/billingo-mcp.py"],
      "env": { "BILLINGO_KEY": "vault:<your-billingo-key-id>" }
    }
  }
}
```

## Data caveats (measured on a real account; worth knowing before you build reports)

- **Outgoing documents: trust `payment_status`, not `paid_date`.** On unpaid
  invoices `paid_date` was never null; it carried the date of the request.
  `paid_date` is only a real payment date when `payment_status == "paid"`.
  The server-side `payment_status` filters `expired` (overdue, unpaid,
  includes partially paid) and `outstanding` (open) are reliable; `unpaid`
  is not a valid filter (HTTP 422).
- **Incoming invoices (`/spendings`): payment fields are incomplete.**
  `payment_status` was almost always null and `paid_at` was filled on only a
  few percent of rows (invoices imported from the tax authority do not set
  it). A null `paid_at` does NOT mean unpaid; there is no reliable
  "overdue supplier invoice" list from Billingo, only a due-date-based
  estimate. Use the bank or the accounting side for actual payables.
- Bank transactions are not exposed by the v3 API (`/bank-accounts` returns
  account metadata only).
