#!/usr/bin/env python3
"""Minimal dependency-free Monday.com MCP server (stdio, line-delimited JSON-RPC 2.0).

Auth: MONDAY_TOKEN env (a Monday personal API token). Injected from the dashboard
Vault via a binding, so the token is never hard-coded here.

Design guardrails (per owner request):
  * READ is unrestricted across all boards (reports, search, verify, statuses).
  * WRITE is limited to create + update (add items, change column values, post
    updates/comments). There is deliberately NO delete tool -- the capability is
    simply absent, so the agent physically cannot delete anything regardless of
    what the token permits.
"""
import json
import os
import sys
import urllib.request
import urllib.error

TOKEN = os.environ.get("MONDAY_TOKEN", "")
API = "https://api.monday.com/v2"
# Optional prefix on every posted update, e.g. "\U0001F916 Bot (automated): ".
_MARK = os.environ.get("MONDAY_AUTHOR_MARK", "")
if _MARK and not _MARK.endswith(" "):
    _MARK += " "


def _gql(query, variables=None):
    if not TOKEN:
        raise RuntimeError("MONDAY_TOKEN is not set (missing vault binding?)")
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "Authorization": TOKEN, "Content-Type": "application/json", "API-Version": "2025-07",
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Monday HTTP {e.code}: {e.read().decode()[:400]}")
    if data.get("errors"):
        raise RuntimeError("Monday API error: " + json.dumps(data["errors"])[:400])
    return data.get("data", {})


# ---- tools -----------------------------------------------------------------

def monday_me():
    d = _gql("query { me { id name email is_admin } }")
    return d.get("me", {})


def monday_get_users(limit=200):
    """List account users (id, name, email) to build a NAME->Monday user-ID map for real
    @mentions. Filter to INTERNAL users (your own domain) before mentioning; never mention externals."""
    d = _gql("query ($l:Int!){ users(limit:$l, kind: non_guests){ id name email enabled } }",
             {"l": int(limit)})
    return {"users": d.get("users", [])}


def _esc_html(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def monday_notify(user_id, target_id, text, target_type="Project"):
    """Send a REAL Monday notification to a user (bell + email) -- reliable, unlike inline
    @mentions in update bodies which the API renders as plain text. target_type: 'Project'
    for an item/board target, 'Post' for an update. Internal (allowlisted) users only."""
    q = ("mutation ($u:ID!, $t:ID!, $x:String!, $tt:NotificationTargetType!){ "
         "create_notification(user_id:$u, target_id:$t, text:$x, target_type:$tt){ id text } }")
    d = _gql(q, {"u": str(user_id), "t": str(target_id), "x": text, "tt": target_type})
    return {"notified": True, "user_id": user_id, "result": d.get("create_notification")}


def monday_list_boards(limit=50):
    d = _gql("query ($l:Int!){ boards(limit:$l){ id name state board_kind } }", {"l": int(limit)})
    return {"boards": d.get("boards", [])}


def monday_list_groups(board_id):
    """List the groups (sections) of a board: id + title. READ-only. Needed to
    resolve a group by NAME to its group_id before creating an item into it
    (monday_create_item group_id=...), without a raw-GraphQL bypass."""
    d = _gql("query ($id:[ID!]){ boards(ids:$id){ id name groups{ id title } } }",
             {"id": [str(board_id)]})
    boards = d.get("boards", [])
    if not boards:
        return {"board_id": board_id, "groups": []}
    return {"board_id": board_id, "groups": boards[0].get("groups", [])}


def monday_board_items(board_id, limit=25):
    q = ("query ($id:[ID!], $l:Int!){ boards(ids:$id){ id name "
         "items_page(limit:$l){ cursor items { id name created_at updated_at column_values{ id text } } } } }")
    d = _gql(q, {"id": [str(board_id)], "l": int(limit)})
    boards = d.get("boards", [])
    if not boards:
        return {"board_id": board_id, "items": []}
    page = boards[0].get("items_page", {})
    items = [{"id": it["id"], "name": it["name"],
              "created_at": it.get("created_at"), "updated_at": it.get("updated_at"),
              "columns": {c["id"]: c.get("text") for c in it.get("column_values", []) if c.get("text")}}
             for it in page.get("items", [])]
    return {"board_id": board_id, "board_name": boards[0].get("name"), "count": len(items),
            "cursor": page.get("cursor"), "items": items}


def monday_get_item(item_id):
    q = ("query ($id:[ID!]){ items(ids:$id){ id name created_at updated_at board{ id name } "
         "column_values{ id text } updates(limit:20){ id body created_at creator{ name } "
         "assets{ id name url file_extension } "
         "replies{ id body created_at creator{ name } } } } }")
    d = _gql(q, {"id": [str(item_id)]})
    items = d.get("items", [])
    if not items:
        return {"item_id": item_id, "found": False}
    it = items[0]
    def _asset(a):
        return {"id": a.get("id"), "name": a.get("name"), "url": a.get("url"), "ext": a.get("file_extension")}
    return {
        "id": it["id"], "name": it["name"], "board": it.get("board"),
        "created_at": it.get("created_at"), "updated_at": it.get("updated_at"),
        "columns": {c["id"]: c.get("text") for c in it.get("column_values", []) if c.get("text")},
        "updates": [{"id": u.get("id"), "by": (u.get("creator") or {}).get("name"), "at": u.get("created_at"), "body": u.get("body"),
                     "assets": [_asset(a) for a in (u.get("assets") or [])],
                     "replies": [{"id": r.get("id"), "by": (r.get("creator") or {}).get("name"), "at": r.get("created_at"), "body": r.get("body")}
                                 for r in (u.get("replies") or [])]}
                    for u in it.get("updates", [])],
    }


def monday_get_update_replies(update_id):
    """Replies (comment-answers) of a specific UPDATE, incl. their attachments (assets).
    get_item does NOT expose nested replies' assets; use this to reach a file attached to a REPLY.
    Pipe a returned asset id through monday_get_asset_url for a login-free download URL."""
    q = ("query ($id:[ID!]){ updates(ids:$id){ id creator{ name } "
         "replies{ id body created_at creator{ name } assets{ id name url file_extension } } } }")
    d = _gql(q, {"id": [str(update_id)]})
    ups = d.get("updates", [])
    if not ups:
        return {"update_id": update_id, "found": False}
    u = ups[0]
    return {"update_id": u.get("id"),
            "replies": [{"id": r.get("id"), "by": (r.get("creator") or {}).get("name"),
                         "at": r.get("created_at"), "body": r.get("body"),
                         "assets": [{"id": a.get("id"), "name": a.get("name"), "url": a.get("url"),
                                     "ext": a.get("file_extension")} for a in (r.get("assets") or [])]}
                        for r in (u.get("replies") or [])]}


def monday_activity_logs(board_id, from_iso=None, to_iso=None, limit=200):
    """Board activity logs (events incl. status/column changes) between from/to ISO8601.
    READ-only. Authoritative source for 'what moved / changed status in a period'.
    Each log has event (e.g. update_column_value, create_pulse), created_at, and a
    JSON `data` string with the details (column_id, previous/new value, pulse_id)."""
    q = ("query ($id:[ID!], $from:ISO8601DateTime, $to:ISO8601DateTime, $l:Int!){ "
         "boards(ids:$id){ activity_logs(from:$from, to:$to, limit:$l){ id event created_at data user_id } } }")
    d = _gql(q, {"id": [str(board_id)], "from": from_iso, "to": to_iso, "l": int(limit)})
    boards = d.get("boards", [])
    logs = boards[0].get("activity_logs", []) if boards else []
    return {"board_id": board_id, "from": from_iso, "to": to_iso, "count": len(logs),
            "logs": [{"id": l.get("id"), "event": l.get("event"), "at": l.get("created_at"),
                      "user_id": l.get("user_id"), "data": l.get("data")} for l in logs]}


def monday_create_column(board_id, title, column_type="numbers"):
    """Create a NEW column on a board (board-structure write). Default type 'numbers'
    (for the 'Varhato ertek' value column). Common types: numbers, text, status, date, dropdown.
    Guardrail: create only -- there is NO delete-column tool. The owner verifies afterwards."""
    q = ("mutation ($b:ID!, $t:String!, $ct:ColumnType!){ "
         "create_column(board_id:$b, title:$t, column_type:$ct){ id title type } }")
    d = _gql(q, {"b": str(board_id), "t": title, "ct": column_type})
    c = (d.get("create_column") or {})
    return {"created": True, "board_id": board_id, "column_id": c.get("id"), "title": c.get("title"), "type": c.get("type")}


def monday_search(board_id, term, limit=25):
    """Substring search on item names within a board (local filter)."""
    res = monday_board_items(board_id, limit=200)
    t = (term or "").lower()
    hits = [it for it in res.get("items", []) if t in (it["name"] or "").lower()
            or any(t in (v or "").lower() for v in it["columns"].values())]
    return {"board_id": board_id, "term": term, "count": len(hits), "items": hits[:limit]}


def monday_create_item(board_id, item_name, column_values=None, group_id=None):
    q = ("mutation ($b:ID!, $g:String, $n:String!, $cv:JSON){ "
         "create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$cv){ id name } }")
    cv = json.dumps(column_values) if isinstance(column_values, dict) else (column_values or None)
    d = _gql(q, {"b": str(board_id), "g": group_id, "n": item_name, "cv": cv})
    return {"created": True, "item": d.get("create_item")}


def monday_get_subitems(item_id):
    """List a parent item's SUBITEMS (id, name, status text) -- use this to dedup before
    creating a subitem. monday_get_item does NOT expand subitems, so use this instead."""
    q = ("query ($id:[ID!]){ items(ids:$id){ id name subitems{ id name "
         "column_values{ id text } } } }")
    d = _gql(q, {"id": [str(item_id)]})
    items = d.get("items", [])
    if not items:
        return {"item_id": item_id, "found": False}
    subs = items[0].get("subitems") or []
    return {"item_id": item_id, "count": len(subs),
            "subitems": [{"id": s["id"], "name": s["name"],
                          "columns": {c["id"]: c.get("text") for c in s.get("column_values", []) if c.get("text")}}
                         for s in subs]}


def monday_create_subitem(parent_item_id, item_name, column_values=None):
    """Create a SUBITEM linked under a parent item (create_subitem mutation). NOT the same as
    monday_create_item (which makes a TOP-LEVEL item). Subitems live on a hidden subitems board;
    the returned board.id is that subitems board. To comment on the new subitem, call
    monday_add_update with the returned subitem id. Dedup first with monday_get_subitems."""
    q = ("mutation ($p:ID!, $n:String!, $cv:JSON){ "
         "create_subitem(parent_item_id:$p, item_name:$n, column_values:$cv){ id name board{ id name } } }")
    cv = json.dumps(column_values) if isinstance(column_values, dict) else (column_values or None)
    d = _gql(q, {"p": str(parent_item_id), "n": item_name, "cv": cv})
    return {"created": True, "parent_item_id": parent_item_id, "subitem": d.get("create_subitem")}


def monday_change_value(board_id, item_id, column_id, value):
    """Change a column value using the 'simple' string form (status label, text, date...)."""
    q = ("mutation ($b:ID!, $i:ID!, $c:String!, $v:String!){ "
         "change_simple_column_value(board_id:$b, item_id:$i, column_id:$c, value:$v){ id } }")
    d = _gql(q, {"b": str(board_id), "i": str(item_id), "c": column_id, "v": str(value)})
    return {"updated": True, "item_id": item_id, "column_id": column_id, "value": value, "result": d.get("change_simple_column_value")}


def monday_change_status(board_id, item_id, column_id, label):
    """Set a STATUS (or dropdown) column to `label`, CREATING the label if it does not exist yet.
    change_simple_column_value CANNOT create labels ('This status label doesn't exist'); this uses
    change_column_value with create_labels_if_missing:true. `label` is the visible text (e.g. 'EUR')."""
    q = ("mutation ($b:ID!, $i:ID!, $c:String!, $v:JSON!){ "
         "change_column_value(board_id:$b, item_id:$i, column_id:$c, value:$v, create_labels_if_missing:true){ id } }")
    v = json.dumps({"label": str(label)})
    d = _gql(q, {"b": str(board_id), "i": str(item_id), "c": column_id, "v": v})
    return {"updated": True, "item_id": item_id, "column_id": column_id, "label": label, "result": d.get("change_column_value")}


def monday_change_multiple(board_id, item_id, column_values):
    """Update SEVERAL columns of an item in ONE call. column_values is a dict/JSON keyed by
    column_id (Monday's JSON value form per type, e.g. {"status":{"label":"Kesz"},"date4":{"date":"2026-09-08"}}).
    Uses create_labels_if_missing:true so new status/dropdown labels are accepted. Prefer this over
    repeated monday_change_value when setting multiple fields at once."""
    q = ("mutation ($b:ID!, $i:ID!, $cv:JSON!){ "
         "change_multiple_column_values(board_id:$b, item_id:$i, column_values:$cv, create_labels_if_missing:true){ id name } }")
    cv = json.dumps(column_values) if isinstance(column_values, dict) else column_values
    d = _gql(q, {"b": str(board_id), "i": str(item_id), "cv": cv})
    return {"updated": True, "item_id": item_id, "result": d.get("change_multiple_column_values")}


def monday_move_item_to_group(item_id, group_id):
    """Move an existing item into another GROUP (section) on the same board. group_id from
    monday_list_groups. WRITE (no delete)."""
    q = ("mutation ($i:ID!, $g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id } }")
    d = _gql(q, {"i": str(item_id), "g": str(group_id)})
    return {"moved": True, "item_id": item_id, "group_id": group_id, "result": d.get("move_item_to_group")}


def monday_create_group(board_id, group_name):
    """Create a new GROUP (section) on a board; returns the new group id (use it as group_id for
    monday_create_item / monday_move_item_to_group). WRITE (no delete)."""
    q = ("mutation ($b:ID!, $n:String!){ create_group(board_id:$b, group_name:$n){ id title } }")
    d = _gql(q, {"b": str(board_id), "n": group_name})
    return {"created": True, "board_id": board_id, "group": d.get("create_group")}


def monday_duplicate_item(board_id, item_id, with_updates=False):
    """Duplicate an existing item on the same board (optionally copying its updates). Returns the
    new item. WRITE (no delete)."""
    q = ("mutation ($b:ID!, $i:ID!, $u:Boolean){ "
         "duplicate_item(board_id:$b, item_id:$i, with_updates:$u){ id name } }")
    d = _gql(q, {"b": str(board_id), "i": str(item_id), "u": bool(with_updates)})
    return {"created": True, "source_item_id": item_id, "item": d.get("duplicate_item")}


def monday_add_file_to_update(update_id, file_path):
    """Attach a local FILE (PDF/DOCX/image) to an existing UPDATE (comment) via Monday's
    multipart file endpoint (add_file_to_update). Use to put e.g. an email attachment
    (fetched via gmail_get_attachment) onto a Monday item's update. Insert-only, no delete."""
    import os
    import mimetypes
    if not TOKEN:
        raise RuntimeError("MONDAY_TOKEN nincs beallitva (vault binding hianyzik?)")
    with open(file_path, "rb") as f:
        content = f.read()
    fname = os.path.basename(file_path)
    ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    boundary = "----marveen" + os.urandom(16).hex()
    query = ("mutation ($file: File!) { add_file_to_update (update_id: "
             + str(update_id) + ", file: $file) { id } }")
    parts = []
    def field(name, val):
        parts.append(("--" + boundary).encode())
        parts.append(('Content-Disposition: form-data; name="%s"' % name).encode())
        parts.append(b"")
        parts.append(val.encode("utf-8") if isinstance(val, str) else val)
    field("query", query)
    field("map", '{"image":"variables.file"}')
    parts.append(("--" + boundary).encode())
    parts.append(('Content-Disposition: form-data; name="image"; filename="%s"' % fname).encode())
    parts.append(("Content-Type: %s" % ctype).encode())
    parts.append(b"")
    parts.append(content)
    parts.append(("--" + boundary + "--").encode())
    data = b"\r\n".join(parts)
    req = urllib.request.Request(API + "/file", data=data, headers={
        "Authorization": TOKEN, "API-Version": "2025-07",
        "Content-Type": "multipart/form-data; boundary=" + boundary,
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Monday file HTTP {e.code}: {e.read().decode()[:400]}")
    if d.get("errors"):
        raise RuntimeError("Monday file API error: " + json.dumps(d["errors"])[:400])
    asset = (d.get("data") or {}).get("add_file_to_update") or {}
    return {"uploaded": True, "update_id": update_id, "file": fname, "bytes": len(content), "asset_id": asset.get("id")}


def monday_add_update(item_id, body, mentions=None, reply_to_update_id=None):
    """Post an update/comment on an item. Optional `mentions`: list of {id, name} INTERNAL
    (your own domain) Monday users to REALLY @mention. Uses the create_update `mentions_list`
    argument (API 2025-07+), which renders a real CLICKABLE mention chip AND triggers the
    mentioned user's native Monday notification (bell + email) -- no separate create_notification
    needed. NOTE: Monday appends the chip at the END of the update (from mentions_list); its
    inline position is NOT API-controllable, so don't bother embedding the id/name in `body`.
    Caller MUST pass only internal user IDs -- never external. Without mentions the body is
    posted unchanged (backward compatible).
    Optional `reply_to_update_id`: parent update id to reply UNDER as a THREAD REPLY
    (create_update `parent_id`, API 2025-07+) instead of a new top-level post -- keeps the
    conversation context (e.g. answering someone's comment on a subtask). Digit-validated;
    combines with `mentions`. Omit for a normal top-level update (unchanged behaviour)."""
    # Transparency marker: the agent writes with a person's Monday token, so the
    # post appears under that person's name. MONDAY_AUTHOR_MARK (e.g. "Bot (automated)")
    # prefixes every update so it does not read as a personal comment. Enforced at the
    # tool level so it is guaranteed on every update. Empty/unset = no marker.
    if _MARK and body and not body.lstrip().startswith(_MARK.strip()):
        body = _MARK + body
    ids = [str(m["id"]) for m in (mentions or []) if str(m.get("id", "")).isdigit()]
    # Compose optional create_update args injection-safely (all values digit-validated).
    extra = ""
    if ids:
        # Build mentions_list inline (avoids depending on the exact input-type name). ids are
        # digit-validated above, so this is injection-safe.
        ml = ", ".join("{id: %s, type: User}" % i for i in ids)
        extra += ", mentions_list:[%s]" % ml
    parent = str(reply_to_update_id) if (reply_to_update_id is not None and str(reply_to_update_id).isdigit()) else None
    if parent:
        # Thread reply under an existing update. parent_id is ID (bare numeric literal ok).
        extra += ", parent_id:%s" % parent
    q = "mutation ($i:ID!, $b:String!){ create_update(item_id:$i, body:$b%s){ id } }" % extra
    d = _gql(q, {"i": str(item_id), "b": body})
    return {"added": True, "item_id": item_id,
            "mentioned": ids,
            "reply_to_update_id": parent,
            "update": d.get("create_update")}


def monday_edit_update(update_id, body):
    """Edit the BODY of an already-posted update/comment IN PLACE (edit_update mutation --
    confirmed to exist via live GraphQL introspection, 2026-09-23). Two use cases:
      (1) Accent/grammar-only fix: pass the FULL corrected text as `body` -- this REPLACES
          the update entirely, so build the corrected text from the CURRENT body (fetch it
          first via monday_get_item -> updates[].body), not from memory.
      (2) Substantive content change: do NOT just replace -- fetch the current body, then
          pass `body` = current_body + an appended "<br><br><b>Update (YYYY-MM-DD):</b> ..."
          section, so the original text stays visible and the change is traceable.
    No delete tool exists on purpose (see TOOLS note) -- edit is insert-in-place, not erase."""
    q = "mutation ($id:ID!, $b:String!){ edit_update(id:$id, body:$b){ id } }"
    d = _gql(q, {"id": str(update_id), "b": body})
    return {"edited": True, "update_id": update_id, "update": d.get("edit_update")}


def monday_get_asset_url(asset_id):
    """Get a temporary PUBLIC (login-free) download URL for a Monday ASSET (attachment/file)
    via assets(ids:){public_url}. The URL is short-lived + signed; anyone with it can download
    WITHOUT auth. Use to fetch an attached document's content (e.g. an offer DOCX behind
    protected_static). Read-only -- does not modify anything."""
    q = "query ($ids:[ID!]!){ assets(ids:$ids){ id name public_url url file_extension } }"
    d = _gql(q, {"ids": [str(asset_id)]})
    assets = d.get("assets") or []
    a = assets[0] if assets else None
    return {"asset_id": str(asset_id), "asset": a}


def monday_get_columns(board_id):
    """List a board's columns incl. settings_str. For status/dropdown columns, parse the FULL
    defined label list (index + text), including labels that are not currently in use."""
    q = ("query ($id:[ID!]){ boards(ids:$id){ id name "
         "columns { id title type settings_str } } }")
    d = _gql(q, {"id": [str(board_id)]})
    boards = d.get("boards") or []
    if not boards:
        return {"board_id": board_id, "columns": []}
    cols = []
    for c in boards[0].get("columns") or []:
        entry = {"id": c.get("id"), "title": c.get("title"), "type": c.get("type")}
        settings = c.get("settings_str") or ""
        if settings:
            try:
                s = json.loads(settings)
                labels = s.get("labels")
                if isinstance(labels, dict):
                    # {"0":"Label A","1":"Label B",...}
                    entry["labels"] = [{"index": int(k), "text": v}
                                       for k, v in sorted(labels.items(), key=lambda kv: int(kv[0]))
                                       if v]
                elif isinstance(labels, list):
                    # [{"id":0,"name":"Label A"},...]
                    entry["labels"] = [{"index": l.get("id"), "text": l.get("name")}
                                       for l in labels if l.get("name")]
            except Exception:
                entry["settings_str"] = settings
        cols.append(entry)
    return {"board_id": board_id, "columns": cols}


TOOLS = {
    "monday_me": {"fn": lambda a: monday_me(),
                  "desc": "Which Monday account this connection uses (sanity check).",
                  "schema": {"type": "object", "properties": {}}},
    "monday_get_users": {"fn": lambda a: monday_get_users(int(a.get("limit", 200))),
                         "desc": "List account users (id, name, email, enabled) to build a name->user-ID map for REAL notifications/mentions. Use an allowlist of internal users (NOT domain-only: some internal users' Monday accounts use gmail).",
                         "schema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    "monday_notify": {"fn": lambda a: monday_notify(a["user_id"], a["target_id"], a["text"], a.get("target_type", "Project")),
                      "desc": "Send a REAL Monday notification (bell + email) to an internal (allowlisted) user. Reliable, unlike inline @mentions in comments (which render as plain text). target_type: 'Project' (item/board) or 'Post' (update).",
                      "schema": {"type": "object", "properties": {"user_id": {"type": "string"}, "target_id": {"type": "string"}, "text": {"type": "string"}, "target_type": {"type": "string"}}, "required": ["user_id", "target_id", "text"]}},
    "monday_list_boards": {"fn": lambda a: monday_list_boards(int(a.get("limit", 50))),
                           "desc": "List boards (id, name, state) visible to the token.",
                           "schema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    "monday_list_groups": {"fn": lambda a: monday_list_groups(a["board_id"]),
                           "desc": "List a board's groups (sections): id + title. Use to resolve a group by NAME to group_id before monday_create_item(group_id=...). READ-only.",
                           "schema": {"type": "object", "properties": {"board_id": {"type": "string"}}, "required": ["board_id"]}},
    "monday_board_items": {"fn": lambda a: monday_board_items(a["board_id"], int(a.get("limit", 25))),
                           "desc": "List items of a board with their column values (text).",
                           "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["board_id"]}},
    "monday_get_item": {"fn": lambda a: monday_get_item(a["item_id"]),
                        "desc": "Full item detail: columns + created_at/updated_at + updates/comments.",
                        "schema": {"type": "object", "properties": {"item_id": {"type": "string"}}, "required": ["item_id"]}},
    "monday_create_column": {"fn": lambda a: monday_create_column(a["board_id"], a["title"], a.get("column_type", "numbers")),
                             "desc": "Create a NEW column on a board (board-structure write). column_type default 'numbers' (for a value/'Varhato ertek' column); other types: text, status, date, dropdown. Returns the new column_id. Insert-only; NO delete-column tool. Use monday_change_value to fill the column per item afterwards.",
                             "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "title": {"type": "string"}, "column_type": {"type": "string"}}, "required": ["board_id", "title"]}},
    "monday_get_update_replies": {"fn": lambda a: monday_get_update_replies(a["update_id"]),
                                  "desc": "Get an UPDATE's replies (comment-answers) INCL. their attachments/assets (read-only). get_item does NOT expose reply-level assets; use this to reach a file attached to a REPLY (e.g. a .docx in a comment-answer). Returns reply id/body/creator + assets[id,name,url,ext]; pipe an asset id through monday_get_asset_url for a login-free download URL. Needs the parent UPDATE id (find it via monday_get_item, which now lists updates+reply bodies).",
                                  "schema": {"type": "object", "properties": {"update_id": {"type": "string"}}, "required": ["update_id"]}},
    "monday_activity_logs": {"fn": lambda a: monday_activity_logs(a["board_id"], a.get("from_iso"), a.get("to_iso"), int(a.get("limit", 200))),
                             "desc": "Board activity logs (READ-only) between from_iso/to_iso (ISO8601). Authoritative for 'what changed status / was created in a period' -- events incl. update_column_value (status changes: data has column_id + prev/new value) and create_pulse (item creation). Use for period-scoped monthly report (which projects moved/won/lost in the month). NOTE: Monday retains activity logs ~6 months (plan-dependent).",
                             "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "from_iso": {"type": "string"}, "to_iso": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["board_id"]}},
    "monday_get_asset_url": {"fn": lambda a: monday_get_asset_url(a["asset_id"]),
                             "desc": "Get a temporary PUBLIC (login-free) download URL for a Monday ASSET/attachment (assets(ids){public_url}). Returns {asset_id, asset:{id,name,public_url,url,file_extension}}. Use to fetch an attached file's content (e.g. an offer DOCX behind protected_static). Read-only; the URL is short-lived + signed.",
                             "schema": {"type": "object", "properties": {"asset_id": {"type": "string"}}, "required": ["asset_id"]}},
    "monday_search": {"fn": lambda a: monday_search(a["board_id"], a.get("term", ""), int(a.get("limit", 25))),
                      "desc": "Search items within a board by name/column text (substring).",
                      "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "term": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["board_id", "term"]}},
    "monday_create_item": {"fn": lambda a: monday_create_item(a["board_id"], a["item_name"], a.get("column_values"), a.get("group_id")),
                           "desc": "Create a new TOP-LEVEL item on a board. column_values optional (object of column_id->value). For a SUBITEM under a parent, use monday_create_subitem instead.",
                           "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "item_name": {"type": "string"}, "column_values": {"type": "object"}, "group_id": {"type": "string"}}, "required": ["board_id", "item_name"]}},
    "monday_get_subitems": {"fn": lambda a: monday_get_subitems(a["item_id"]),
                            "desc": "List a parent item's SUBITEMS (id, name, status columns). Use to dedup BEFORE creating a subitem (monday_get_item does NOT expand subitems).",
                            "schema": {"type": "object", "properties": {"item_id": {"type": "string"}}, "required": ["item_id"]}},
    "monday_create_subitem": {"fn": lambda a: monday_create_subitem(a["parent_item_id"], a["item_name"], a.get("column_values")),
                              "desc": "Create a SUBITEM linked under a parent item (create_subitem). NOT monday_create_item (that is top-level). Returns the new subitem id; comment on it via monday_add_update with that id. Dedup first with monday_get_subitems.",
                              "schema": {"type": "object", "properties": {"parent_item_id": {"type": "string"}, "item_name": {"type": "string"}, "column_values": {"type": "object"}}, "required": ["parent_item_id", "item_name"]}},
    "monday_change_value": {"fn": lambda a: monday_change_value(a["board_id"], a["item_id"], a["column_id"], a["value"]),
                            "desc": "Change one column value on an item (status label, text, date as simple string).",
                            "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "item_id": {"type": "string"}, "column_id": {"type": "string"}, "value": {"type": "string"}}, "required": ["board_id", "item_id", "column_id", "value"]}},
    "monday_change_status": {"fn": lambda a: monday_change_status(a["board_id"], a["item_id"], a["column_id"], a["label"]),
                             "desc": "Set a STATUS (or dropdown) column to `label`, CREATING the label if it does not exist yet (change_column_value + create_labels_if_missing). Use this instead of monday_change_value when the status label may be new (e.g. a fresh status column whose only labels are the defaults) -- monday_change_value cannot create labels and throws 'This status label doesn't exist'.",
                             "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "item_id": {"type": "string"}, "column_id": {"type": "string"}, "label": {"type": "string"}}, "required": ["board_id", "item_id", "column_id", "label"]}},
    "monday_change_multiple": {"fn": lambda a: monday_change_multiple(a["board_id"], a["item_id"], a["column_values"]),
                               "desc": "Update SEVERAL columns of an item in ONE call (change_multiple_column_values + create_labels_if_missing). column_values is a JSON object keyed by column_id in Monday's per-type value form (e.g. {\"status\":{\"label\":\"Kesz\"},\"date4\":{\"date\":\"2026-09-08\"},\"text\":\"note\"}). Prefer over repeated monday_change_value.",
                               "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "item_id": {"type": "string"}, "column_values": {"type": "object"}}, "required": ["board_id", "item_id", "column_values"]}},
    "monday_move_item_to_group": {"fn": lambda a: monday_move_item_to_group(a["item_id"], a["group_id"]),
                                  "desc": "Move an existing item into another GROUP (section) of the same board. group_id from monday_list_groups. WRITE (no delete).",
                                  "schema": {"type": "object", "properties": {"item_id": {"type": "string"}, "group_id": {"type": "string"}}, "required": ["item_id", "group_id"]}},
    "monday_create_group": {"fn": lambda a: monday_create_group(a["board_id"], a["group_name"]),
                            "desc": "Create a new GROUP (section) on a board; returns the new group id (usable as group_id for create/move). WRITE (no delete).",
                            "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "group_name": {"type": "string"}}, "required": ["board_id", "group_name"]}},
    "monday_duplicate_item": {"fn": lambda a: monday_duplicate_item(a["board_id"], a["item_id"], a.get("with_updates", False)),
                              "desc": "Duplicate an existing item on the same board (optionally copying updates). Returns the new item. WRITE (no delete).",
                              "schema": {"type": "object", "properties": {"board_id": {"type": "string"}, "item_id": {"type": "string"}, "with_updates": {"type": "boolean"}}, "required": ["board_id", "item_id"]}},
    "monday_add_file_to_update": {"fn": lambda a: monday_add_file_to_update(a["update_id"], a["file_path"]),
                                  "desc": "Attach a local FILE (PDF/DOCX/image) to an existing UPDATE (comment) on a Monday item (add_file_to_update, multipart). Use to put an email attachment (fetched via the Gmail MCP's gmail_get_attachment) onto a Monday item's update. Needs the update_id (from monday_add_update / monday_get_item) + an absolute file_path. Insert-only.",
                                  "schema": {"type": "object", "properties": {"update_id": {"type": "string"}, "file_path": {"type": "string"}}, "required": ["update_id", "file_path"]}},
    "monday_add_update": {"fn": lambda a: monday_add_update(a["item_id"], a["body"], a.get("mentions"), a.get("reply_to_update_id")),
                          "desc": "Post an update/comment on an item. Optional 'mentions': list of {id,name} INTERNAL (own-domain) users for a REAL CLICKABLE @mention (via create_update mentions_list, API 2025-07+) that also triggers the user's Monday notification (never mention externals). Optional 'reply_to_update_id': parent update id to reply UNDER as a THREAD REPLY (create_update parent_id) instead of a new top-level post -- use to answer someone's comment (e.g. someone's update on a subtask) keeping context. Without either, the body is a plain top-level update (unchanged). FORMATTING: the body accepts HTML, so a BULLET LIST is '<ul><li>First</li><li>Second</li></ul>'; also '<b>bold</b>', '<br> line break, numbered '<ol><li>..</li></ol>'. Use HTML markup (not markdown '-' dashes) when someone wants a bulleted breakdown under a task.",
                          "schema": {"type": "object", "properties": {"item_id": {"type": "string"}, "body": {"type": "string"}, "mentions": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "name": {"type": "string"}}}}, "reply_to_update_id": {"type": "string", "description": "Parent update id for a thread reply (create_update parent_id)."}}, "required": ["item_id", "body"]}},
    "monday_get_columns": {"fn": lambda a: monday_get_columns(a["board_id"]),
                           "desc": "List a board's columns with settings; for status/dropdown columns returns the FULL defined label list + index (authoritative, includes unused labels).",
                           "schema": {"type": "object", "properties": {"board_id": {"type": "string"}}, "required": ["board_id"]}},
    "monday_edit_update": {"fn": lambda a: monday_edit_update(a["update_id"], a["body"]),
                           "desc": "Edit an EXISTING update/comment's body in place (edit_update mutation). For an accent/grammar-only fix, pass the full corrected text (replaces the old body -- fetch the current body first via monday_get_item, don't retype from memory). For a substantive content change, fetch the current body and pass it back with an appended '<br><br><b>Update (date):</b> ...' section instead of overwriting it, so the original stays visible. No delete tool exists (see note below) -- this is edit-in-place, not erase.",
                           "schema": {"type": "object", "properties": {"update_id": {"type": "string"}, "body": {"type": "string"}}, "required": ["update_id", "body"]}},
    # NOTE: intentionally NO delete tool -- the agent must not be able to delete.
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
                "serverInfo": {"name": "monday-mcp", "version": "0.1.0"}}})
        elif method == "notifications/initialized":
            pass
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
                {"name": n, "description": t["desc"], "inputSchema": t["schema"]} for n, t in TOOLS.items()]}})
        elif method == "tools/call":
            p = msg.get("params", {})
            name = p.get("name")
            tool = TOOLS.get(name)
            if not tool:
                _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Unknown tool: {name}"}})
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
