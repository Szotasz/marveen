#!/usr/bin/env python3
"""Minimal dependency-free Billingo (v3) MCP server -- READ-ONLY.

Auth: BILLINGO_KEY env (Billingo v3 API key, X-API-KEY header). Injected from the
dashboard Vault via a binding (vault-env-wrapper.sh), never hard-coded.

GUARDRAIL: only READ tools exist (list/get invoices+documents, partners, download
a document PDF). There is deliberately NO create/modify/delete tool -- the agent can
only inspect financial documents, never change them, regardless of key scope.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

KEY = os.environ.get("BILLINGO_KEY", "")

# Retry policy for transient upstream failures (5xx, 429, network/timeout).
# NOTE: a HTTP 200 with an empty body is NOT retried here (it is a "successful"
# response); the empty-but-should-have-data case is handled at the list-endpoint
# level (see _get_list_retry) so a report never silently treats "empty" as zero.
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF = 1.5  # seconds, exponential: 1.5, 3.0, ...
_RETRY_HTTP_CODES = {429, 500, 502, 503, 504}
BASE = "https://api.billingo.hu/v3"
# Where billingo_download_document writes PDFs. Default: <system temp>/billingo.
SCRATCH = os.environ.get("BILLINGO_DOWNLOAD_DIR") or os.path.join(__import__("tempfile").gettempdir(), "billingo")


def _get(path, raw=False):
    if not KEY:
        raise RuntimeError("BILLINGO_KEY is not set (missing vault binding?)")
    req = urllib.request.Request(BASE + path, headers={"X-API-KEY": KEY, "Accept": "application/json"})
    last_err = None
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = r.read()
                return data if raw else json.loads(data.decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:300]
            last_err = RuntimeError(f"Billingo HTTP {e.code}: {body}")
            if e.code not in _RETRY_HTTP_CODES or attempt == _RETRY_ATTEMPTS - 1:
                raise last_err
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = RuntimeError(f"Billingo network error: {e}")
            if attempt == _RETRY_ATTEMPTS - 1:
                raise last_err
        time.sleep(_RETRY_BACKOFF * (2 ** attempt))
    raise last_err  # unreachable, defensive


def _get_list_retry(path):
    """Fetch a Billingo list endpoint, retrying a couple of times when the
    response is HTTP 200 but carries an EMPTY `data` array. This defends against
    the observed transient "200 + empty" symptom on /spendings. Returns
    (payload, health) where health is 'ok' or 'empty' (empty after all retries).
    Callers surface `health` so a report never silently reads empty as zero."""
    d = _get(path)
    if d.get("data"):
        return d, "ok"
    for attempt in range(_RETRY_ATTEMPTS - 1):
        time.sleep(_RETRY_BACKOFF * (2 ** attempt))
        d = _get(path)
        if d.get("data"):
            return d, "ok"
    # Persistently empty. Could be genuinely empty OR a silent upstream glitch;
    # the caller MUST NOT treat this as a confirmed zero.
    return d, "empty"


def _doc_brief(x):
    partner = x.get("partner") or {}
    return {
        "id": x.get("id"),
        "invoice_number": x.get("invoice_number"),
        "type": x.get("type"),
        "partner": partner.get("name"),
        "invoice_date": x.get("invoice_date"),
        "fulfillment_date": x.get("fulfillment_date"),
        "due_date": x.get("due_date"),
        "gross_total": x.get("gross_total"),
        "currency": x.get("currency"),
        "payment_status": x.get("payment_status"),
        "paid_date": x.get("paid_date"),
    }


def billingo_list_documents(page=1, per_page=25, payment_status=None, start_date=None, end_date=None, partner_id=None):
    params = {"page": int(page), "per_page": int(per_page)}
    if payment_status:
        params["payment_status"] = payment_status
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date
    if partner_id:
        params["partner_id"] = partner_id
    d = _get("/documents?" + urllib.parse.urlencode(params))
    return {"total": d.get("total"), "page": page, "count": len(d.get("data", [])),
            "documents": [_doc_brief(x) for x in d.get("data", [])]}


def billingo_get_document(document_id):
    x = _get(f"/documents/{urllib.parse.quote(str(document_id))}")
    brief = _doc_brief(x)
    brief["items"] = [{"name": it.get("name"), "net_unit_price": it.get("net_unit_price"),
                       "quantity": it.get("quantity"), "unit": it.get("unit"),
                       "gross_amount": it.get("gross_amount") or it.get("gross_total"), "vat": it.get("vat")}
                      for it in (x.get("items") or [])]
    brief["comment"] = x.get("comment")
    return brief


def billingo_list_partners(page=1, per_page=25, query=None):
    params = {"page": int(page), "per_page": int(per_page)}
    if query:
        params["query"] = query
    d = _get("/partners?" + urllib.parse.urlencode(params))
    return {"total": d.get("total"), "count": len(d.get("data", [])),
            "partners": [{"id": p.get("id"), "name": p.get("name"),
                          "taxcode": p.get("taxcode"), "emails": p.get("emails")}
                         for p in d.get("data", [])]}


def billingo_download_document(document_id):
    """Download a document PDF to the local scratchpad; return the file path."""
    pdf = _get(f"/documents/{urllib.parse.quote(str(document_id))}/download", raw=True)
    os.makedirs(SCRATCH, exist_ok=True)
    path = os.path.join(SCRATCH, f"billingo-doc-{document_id}.pdf")
    with open(path, "wb") as f:
        f.write(pdf)
    return {"document_id": document_id, "saved_to": path, "bytes": len(pdf)}


def _spend_brief(x):
    # Spending (cost / incoming) objects; field names differ from documents,
    # so extract defensively with fallbacks.
    partner = x.get("partner") or {}
    pname = partner.get("name") if isinstance(partner, dict) else partner
    return {
        "id": x.get("id"),
        "category": x.get("category"),
        "partner": pname or x.get("partner_name"),
        "invoice_number": x.get("invoice_number"),
        "fulfillment_date": x.get("fulfillment_date"),
        "due_date": x.get("due_date"),
        "paid_at": x.get("paid_at") or x.get("paid_date"),
        "payment_status": x.get("payment_status"),
        "gross_total": x.get("total_gross") or x.get("gross_total") or x.get("total"),
        "net_total": x.get("total_net") or x.get("net_total"),
        "currency": x.get("currency"),
    }


def billingo_list_spendings(page=1, per_page=25, start_date=None, end_date=None):
    """List spendings = cost / incoming (supplier) invoices. Read-only. Billingo v3 /spendings."""
    params = {"page": int(page), "per_page": int(per_page)}
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date
    d, health = _get_list_retry("/spendings?" + urllib.parse.urlencode(params))
    out = {"total": d.get("total"), "page": page, "count": len(d.get("data", [])),
           "health": health,
           "spendings": [_spend_brief(x) for x in d.get("data", [])]}
    if health == "empty":
        # Explicit signal: HTTP 200 but empty data even after retries. Do NOT
        # read this as "0 spendings" -- verify before using it in a report.
        out["warning"] = ("Billingo /spendings returned HTTP 200 but EMPTY data "
                          "after retries. Treat as UNKNOWN, not zero.")
    return out


TOOLS = {
    "billingo_list_documents": {
        "fn": lambda a: billingo_list_documents(a.get("page", 1), a.get("per_page", 25),
                                                a.get("payment_status"), a.get("start_date"),
                                                a.get("end_date"), a.get("partner_id")),
        "desc": "List invoices/documents (read-only). Optional filters: payment_status (paid|unpaid|...), start_date/end_date (YYYY-MM-DD), partner_id, page, per_page.",
        "schema": {"type": "object", "properties": {
            "page": {"type": "integer"}, "per_page": {"type": "integer"},
            "payment_status": {"type": "string"}, "start_date": {"type": "string"},
            "end_date": {"type": "string"}, "partner_id": {"type": "integer"}}},
    },
    "billingo_get_document": {
        "fn": lambda a: billingo_get_document(a["document_id"]),
        "desc": "Get one document's full details incl. items (read-only).",
        "schema": {"type": "object", "properties": {"document_id": {"type": "integer"}}, "required": ["document_id"]},
    },
    "billingo_list_partners": {
        "fn": lambda a: billingo_list_partners(a.get("page", 1), a.get("per_page", 25), a.get("query")),
        "desc": "List partners/clients (read-only). Optional query to search by name.",
        "schema": {"type": "object", "properties": {
            "page": {"type": "integer"}, "per_page": {"type": "integer"}, "query": {"type": "string"}}},
    },
    "billingo_download_document": {
        "fn": lambda a: billingo_download_document(a["document_id"]),
        "desc": "Download a document's PDF to local scratch and return the path (read-only).",
        "schema": {"type": "object", "properties": {"document_id": {"type": "integer"}}, "required": ["document_id"]},
    },
    "billingo_list_spendings": {
        "fn": lambda a: billingo_list_spendings(a.get("page", 1), a.get("per_page", 25),
                                                a.get("start_date"), a.get("end_date")),
        "desc": "List spendings = COST / incoming (supplier) invoices (read-only). These are the expense side (incoming/cost), separate from billingo_list_documents (outgoing). Optional filters: start_date/end_date (YYYY-MM-DD), page, per_page.",
        "schema": {"type": "object", "properties": {
            "page": {"type": "integer"}, "per_page": {"type": "integer"},
            "start_date": {"type": "string"}, "end_date": {"type": "string"}}},
    },
    # NOTE: intentionally NO create/update/delete -- the agent is read-only on Billingo.
}


def _send(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method, rid = msg.get("method"), msg.get("id")
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "billingo-mcp", "version": "0.1.0"}}})
        elif method == "notifications/initialized":
            pass
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
                {"name": n, "description": t["desc"], "inputSchema": t["schema"]} for n, t in TOOLS.items()]}})
        elif method == "tools/call":
            p = msg.get("params", {})
            tool = TOOLS.get(p.get("name"))
            if not tool:
                _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Unknown tool: {p.get('name')}"}})
                continue
            try:
                res = tool["fn"](p.get("arguments", {}) or {})
                _send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]}})
            except Exception as e:
                _send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": f"ERROR: {e}"}], "isError": True}})
        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Method not found: {method}"}})


if __name__ == "__main__":
    main()
