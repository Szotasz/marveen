#!/usr/bin/env python3
"""Minimal dependency-free Notion MCP server (e.g. for a knowledge-base agent).

Auth: NOTION_TOKEN env (Notion internal integration token). Injected from the
dashboard Vault via a binding (vault-env-wrapper.sh), never hard-coded.

GUARDRAIL: read + controlled write (search, read page text, append content,
update a block's text). There is deliberately NO delete/archive tool -- the agent
cannot remove pages or blocks, regardless of token scope.
"""
import json
import os
import sys
import urllib.request
import urllib.error

TOKEN = os.environ.get("NOTION_TOKEN", "")
H = {"Authorization": "Bearer " + TOKEN, "Notion-Version": "2022-06-28", "Content-Type": "application/json"}


def _call(method, path, body=None):
    if not TOKEN:
        raise RuntimeError("NOTION_TOKEN is not set (missing vault binding?)")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("https://api.notion.com/v1" + path, data=data, headers=H, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Notion HTTP {e.code}: {e.read().decode()[:300]}")


def _rt(rich):
    if not isinstance(rich, list):
        return ""
    return "".join(x.get("plain_text", "") for x in rich if isinstance(x, dict))


def _title_of(obj):
    props = obj.get("properties", {})
    for k, v in props.items():
        if v.get("type") == "title":
            return _rt(v.get("title", []))
    if obj.get("object") == "database":
        return _rt(obj.get("title", []))
    return ""


PREFIX = {"heading_1": "# ", "heading_2": "## ", "heading_3": "### ",
          "bulleted_list_item": "- ", "numbered_list_item": "1. ", "quote": "> ",
          "to_do": "[ ] ", "toggle": "▸ ", "callout": "💡 "}


def _render(pid, depth=0, out=None, budget=None):
    if out is None:
        out = []
    if budget is None:
        budget = [400]  # max blocks
    if depth > 4 or budget[0] <= 0:
        return out
    r = _call("GET", f"/blocks/{pid}/children?page_size=100")
    for b in r.get("results", []):
        budget[0] -= 1
        if budget[0] <= 0:
            break
        t = b.get("type"); v = b.get(t, {})
        if not isinstance(v, dict):
            v = {}
        ind = "  " * depth
        if t in ("file", "pdf", "image"):
            f = v; url = (f.get("file") or {}).get("url") or (f.get("external") or {}).get("url", "")
            out.append(f"{ind}📎 {f.get('name') or url}")
        elif t == "child_page":
            out.append(f"{ind}[[oldal: {v.get('title','')}]] (id={b['id']})")
        elif t == "table":
            out.append(f"{ind}[table]")
            _render(b["id"], depth + 1, out, budget)
        elif t == "table_row":
            cells = [_rt(cell) for cell in v.get("cells", [])]
            out.append(f"{ind}| " + " | ".join(cells) + " |")
        elif "rich_text" in v:
            txt = _rt(v.get("rich_text"))
            if t == "to_do":
                out.append(f"{ind}[{'x' if v.get('checked') else ' '}] {txt}")
            else:
                out.append(f"{ind}{PREFIX.get(t,'')}{txt}")
            if b.get("has_children"):
                _render(b["id"], depth + 1, out, budget)
        elif b.get("has_children"):
            _render(b["id"], depth + 1, out, budget)
    return out


def notion_search(query="", max_results=15):
    body = {"page_size": max_results}
    if query:
        body["query"] = query
    d = _call("POST", "/search", body)
    return {"count": len(d.get("results", [])),
            "results": [{"object": r.get("object"), "id": r.get("id"), "title": _title_of(r),
                         "url": r.get("url")} for r in d.get("results", [])]}


def notion_get_page(page_id):
    p = _call("GET", f"/pages/{page_id}")
    text = "\n".join(_render(page_id))
    return {"id": page_id, "title": _title_of(p), "url": p.get("url"), "content": text[:12000]}


def notion_list_blocks(parent_id, start_cursor=None, max_results=100):
    """List a page/block's direct child blocks WITH their block IDs + text, so a
    specific block can be targeted by notion_update_text. Paginated (next_cursor)
    and recursable (call again with a has_children block's id) -> no truncation.
    This is the tool to use before editing existing content."""
    path = f"/blocks/{parent_id}/children?page_size={int(max_results)}"
    if start_cursor:
        path += "&start_cursor=" + urllib.parse.quote(start_cursor)
    r = _call("GET", path)
    out = []
    for b in r.get("results", []):
        t = b.get("type"); v = b.get(t, {})
        if not isinstance(v, dict):
            v = {}
        if "rich_text" in v:
            txt = _rt(v.get("rich_text"))
        elif t == "child_page":
            txt = v.get("title", "")
        elif t == "table_row":
            txt = " | ".join(_rt(cell) for cell in v.get("cells", []))
        else:
            txt = ""
        out.append({"id": b["id"], "type": t, "text": txt, "has_children": b.get("has_children", False)})
    return {"blocks": out, "next_cursor": r.get("next_cursor"), "has_more": r.get("has_more", False)}


def notion_append_text(parent_id, text, heading=None, after=None):
    """Append content to a page/block. text may contain newlines -> paragraphs.
    Optional heading (a heading_2) inserted before the paragraphs.
    Optional 'after' = the block_id of an EXISTING direct child of parent_id; when
    given, the new blocks are inserted RIGHT AFTER that block (mid-page placement,
    e.g. into a section) instead of at the page end. The 'after' block must be a
    direct child of parent_id (use notion_list_blocks to find its id). Insert-only,
    never removes anything."""
    children = []
    if heading:
        children.append({"object": "block", "type": "heading_2",
                         "heading_2": {"rich_text": [{"type": "text", "text": {"content": heading}}]}})
    for line in (text or "").split("\n"):
        children.append({"object": "block", "type": "paragraph",
                         "paragraph": {"rich_text": [{"type": "text", "text": {"content": line}}]}})
    body = {"children": children}
    if after:
        body["after"] = after
    d = _call("PATCH", f"/blocks/{parent_id}/children", body)
    return {"appended": len(children), "parent_id": parent_id, "after": after or None}


def notion_update_text(block_id, text):
    """Replace the rich_text of a text-bearing block (paragraph/heading/list/etc.)."""
    b = _call("GET", f"/blocks/{block_id}")
    t = b.get("type")
    if "rich_text" not in b.get(t, {}):
        return {"updated": False, "reason": f"block type {t} has no editable text"}
    d = _call("PATCH", f"/blocks/{block_id}", {t: {"rich_text": [{"type": "text", "text": {"content": text}}]}})
    return {"updated": True, "block_id": block_id, "type": t}


def _cell(text):
    """Build a Notion table cell (array of rich_text) from a plain string; empty string -> empty cell."""
    return [{"type": "text", "text": {"content": text}}] if text != "" else []


def notion_update_table_cell(row_block_id, col, text):
    """Edit ONE cell of an existing table_row block (0-indexed `col`), preserving the other cells.
    Get row_block_id from notion_list_blocks (type=table_row; the row text is cells joined by ' | ',
    so count from 0 to find the column). Controlled write; never deletes."""
    b = _call("GET", f"/blocks/{row_block_id}")
    if b.get("type") != "table_row":
        return {"updated": False, "reason": f"a(z) {row_block_id} nem table_row (type={b.get('type')})"}
    cells = b.get("table_row", {}).get("cells", []) or []
    col = int(col)
    while len(cells) <= col:
        cells.append([])
    cells[col] = _cell(text)
    _call("PATCH", f"/blocks/{row_block_id}", {"table_row": {"cells": cells}})
    return {"updated": True, "row_block_id": row_block_id, "col": col, "cols_total": len(cells)}


def notion_append_table_row(table_block_id, cells, after=None):
    """Append a NEW row to a table block. `cells` = list of plain strings (one per column, in order).
    table_block_id = the `table` block id (from notion_list_blocks). Optional `after` = an existing
    table_row id to insert the new row right after it. Controlled write; never deletes."""
    if not isinstance(cells, list):
        cells = [cells]
    row = {"object": "block", "type": "table_row",
           "table_row": {"cells": [_cell("" if c is None else str(c)) for c in cells]}}
    body = {"children": [row]}
    if after:
        body["after"] = after
    _call("PATCH", f"/blocks/{table_block_id}/children", body)
    return {"appended_row": True, "table_block_id": table_block_id, "ncols": len(cells), "after": after or None}


def notion_create_page(parent_page_id, title, text=None):
    """Create a NEW child page under an existing parent PAGE (the integration must be shared on the parent).
    Optional `text` becomes an initial paragraph. Guardrail: create/insert allowed, NO delete/archive."""
    body = {"parent": {"type": "page_id", "page_id": parent_page_id},
            "properties": {"title": {"title": [{"type": "text", "text": {"content": title}}]}}}
    if text:
        body["children"] = [{"object": "block", "type": "paragraph",
                             "paragraph": {"rich_text": [{"type": "text", "text": {"content": line}}]}}
                            for line in str(text).split("\n")]
    p = _call("POST", "/pages", body)
    return {"created": True, "page_id": p.get("id"), "url": p.get("url"), "title": title}


TOOLS = {
    "notion_create_page": {"fn": lambda a: notion_create_page(a["parent_page_id"], a["title"], a.get("text")),
                           "desc": "Create a NEW child page under a parent PAGE (parent_page_id must be a page the integration is shared on). Optional 'text' = initial paragraph(s, newline-split). Insert-only; there is NO delete/archive tool by design. Returns the new page_id + url.",
                           "schema": {"type": "object", "properties": {"parent_page_id": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string"}}, "required": ["parent_page_id", "title"]}},
    "notion_search": {"fn": lambda a: notion_search(a.get("query", ""), int(a.get("max_results", 15))),
                      "desc": "Search the KB (pages/databases the integration can access). Returns id+title+url.",
                      "schema": {"type": "object", "properties": {"query": {"type": "string"}, "max_results": {"type": "integer"}}}},
    "notion_get_page": {"fn": lambda a: notion_get_page(a["page_id"]),
                        "desc": "Read a page's content as text (headings, lists, tables, toggles, file links). Read-only. For EDITING, use notion_list_blocks to get block IDs.",
                        "schema": {"type": "object", "properties": {"page_id": {"type": "string"}}, "required": ["page_id"]}},
    "notion_list_blocks": {"fn": lambda a: notion_list_blocks(a["parent_id"], a.get("start_cursor"), int(a.get("max_results", 100))),
                           "desc": "List direct child blocks of a page/block WITH block IDs + text (paginated via next_cursor, recurse into has_children). Use this to find the exact block id to pass to notion_update_text. No truncation.",
                           "schema": {"type": "object", "properties": {"parent_id": {"type": "string"}, "start_cursor": {"type": "string"}, "max_results": {"type": "integer"}}, "required": ["parent_id"]}},
    "notion_append_text": {"fn": lambda a: notion_append_text(a["parent_id"], a.get("text", ""), a.get("heading"), a.get("after")),
                           "desc": "Add content (paragraphs, optional heading) to a page/block. By default appends to the END; pass 'after' = an existing DIRECT-child block_id (from notion_list_blocks) to insert RIGHT AFTER it instead (mid-page / into a section). Insert-only, never removes anything.",
                           "schema": {"type": "object", "properties": {"parent_id": {"type": "string"}, "text": {"type": "string"}, "heading": {"type": "string"}, "after": {"type": "string"}}, "required": ["parent_id", "text"]}},
    "notion_update_text": {"fn": lambda a: notion_update_text(a["block_id"], a["text"]),
                           "desc": "Replace the text of an existing text block (paragraph/heading/list item). Does not delete.",
                           "schema": {"type": "object", "properties": {"block_id": {"type": "string"}, "text": {"type": "string"}}, "required": ["block_id", "text"]}},
    "notion_update_table_cell": {"fn": lambda a: notion_update_table_cell(a["row_block_id"], a["col"], a.get("text", "")),
                           "desc": "Edit ONE cell of an existing table row (0-indexed col), preserving other cells. Get row_block_id from notion_list_blocks (type=table_row; its text shows the cells joined by ' | ', count from 0). Controlled write, never deletes.",
                           "schema": {"type": "object", "properties": {"row_block_id": {"type": "string"}, "col": {"type": "integer"}, "text": {"type": "string"}}, "required": ["row_block_id", "col"]}},
    "notion_append_table_row": {"fn": lambda a: notion_append_table_row(a["table_block_id"], a["cells"], a.get("after")),
                           "desc": "Append a NEW row to a table block. cells = list of plain strings (one per column, in order). table_block_id from notion_list_blocks (type=table). Optional 'after' = existing table_row id to insert right after. Controlled write, never deletes.",
                           "schema": {"type": "object", "properties": {"table_block_id": {"type": "string"}, "cells": {"type": "array", "items": {"type": "string"}}, "after": {"type": "string"}}, "required": ["table_block_id", "cells"]}},
    # NOTE: intentionally NO delete/archive tool -- the agent cannot remove KB content.
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
            _send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2024-11-05",
                   "capabilities": {"tools": {}}, "serverInfo": {"name": "notion-mcp", "version": "0.1.0"}}})
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
