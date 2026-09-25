#!/usr/bin/env python3
"""Minimal, dependency-free Google Workspace MCP server (stdio, line-delimited JSON-RPC 2.0).

Per-bot isolation is achieved purely through two env vars -- there is no shared
global state, so every agent runs the same script pointed at its OWN token file:

    GOOGLE_CLIENT_JSON  path to the OAuth *desktop client* JSON (shared across bots)
                        format: {"installed": {"client_id", "client_secret", ...}}
    GOOGLE_TOKEN_JSON   path to THIS bot's token file (unique per bot)
                        format: {"refresh_token": "...", "scope": "..."}
    GOOGLE_ACCOUNT      (optional) expected account email, for a startup sanity note
    GOOGLE_MCP_OWNER_CWD (optional) only serve tools when launched from THIS
                        directory. Set on the project-root entry so the main
                        agent's account is not inherited by every sub-agent
                        that has no Google entry of its own (see OWNER_CWD).

Scopes currently provisioned: gmail.modify, calendar, drive (no gmail.send).
Note: the Sheets API (sheets_create/append/read) authorizes with the existing
'drive' scope -- no extra spreadsheets scope / re-auth needed -- but the Sheets
API must be ENABLED on the Cloud project.

Exposes read-oriented tools first (the immediate goal is that a bot can SEE its
mailbox / calendar / drive). Write tools can be added later behind the same auth.
"""
import json
import os
import sys
import time
import tempfile
import urllib.parse
import urllib.request
import urllib.error

CLIENT_PATH = os.environ.get("GOOGLE_CLIENT_JSON", "")
TOKEN_PATH = os.environ.get("GOOGLE_TOKEN_JSON", "")
ACCOUNT = os.environ.get("GOOGLE_ACCOUNT", "")

# OWNER_CWD (GOOGLEROOT923). Claude Code merges .mcp.json from parent dirs, so
# the project-root "google" entry (the main agent's own account) was loaded by
# every sub-agent under agents/<name>/ that has no "google" entry of its own.
# Measured 2026-09-23: 10 sub-agents ran this server as the main agent's
# account, and two of them had searched/uploaded through it that day. A fleet
# may well decide that sub-agents get no Google account of their own and that
# Google data goes through the main agent. So when GOOGLE_MCP_OWNER_CWD is set and we were
# launched elsewhere, we expose NO tools. An empty tool list, not an exit, so
# health checks do not see ten "failed" MCP servers.
OWNER_CWD = os.environ.get("GOOGLE_MCP_OWNER_CWD", "").strip()


def _owner_cwd_ok() -> bool:
    if not OWNER_CWD:
        return True
    try:
        return os.path.realpath(os.getcwd()) == os.path.realpath(OWNER_CWD)
    except OSError:
        return False


SERVE_TOOLS = _owner_cwd_ok()
if not SERVE_TOOLS:
    sys.stderr.write(
        f"google-mcp: launched from {os.getcwd()}, not the owner dir {OWNER_CWD} -- "
        "exposing no tools (Google access goes through the main agent)\n"
    )

_access = {"token": None, "exp": 0}


def _client():
    with open(CLIENT_PATH) as f:
        return json.load(f)["installed"]


def _refresh_token():
    with open(TOKEN_PATH) as f:
        return json.load(f)["refresh_token"]


def _access_token():
    """Return a valid access token, refreshing (and caching) as needed."""
    if _access["token"] and time.time() < _access["exp"] - 300:
        return _access["token"]
    c = _client()
    data = urllib.parse.urlencode({
        "client_id": c["client_id"],
        "client_secret": c["client_secret"],
        "refresh_token": _refresh_token(),
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    resp = json.load(urllib.request.urlopen(req, timeout=30))
    _access["token"] = resp["access_token"]
    _access["exp"] = time.time() + int(resp.get("expires_in", 3600))
    return _access["token"]


def _api(method, url, body=None):
    headers = {"Authorization": "Bearer " + _access_token()}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode("utf-8").strip()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:500]
        raise RuntimeError(f"Google API {e.code}: {detail}")


# ---- tool implementations -------------------------------------------------

def _hdr(payload, name):
    for h in payload.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def gmail_search(query="", max_results=10):
    q = urllib.parse.urlencode({"q": query, "maxResults": max_results})
    lst = _api("GET", f"https://gmail.googleapis.com/gmail/v1/users/me/messages?{q}")
    out = []
    for m in lst.get("messages", [])[:max_results]:
        full = _api("GET", f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m['id']}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date")
        out.append({
            "id": m["id"],
            "from": _hdr(full, "From"),
            "subject": _hdr(full, "Subject"),
            "date": _hdr(full, "Date"),
            "snippet": full.get("snippet", ""),
        })
    return {"account": _profile_email(), "count": len(out), "messages": out}


def gmail_get(message_id):
    full = _api("GET", f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}?format=full")
    # extract plain text body
    import base64
    def walk(part):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", "replace")
        for p in part.get("parts", []) or []:
            t = walk(p)
            if t:
                return t
        return ""
    body = walk(full.get("payload", {}))
    # collect attachments (filename + attachment_id) so the caller can download them
    atts = []
    def walk_att(part):
        b = part.get("body", {}) or {}
        fn = part.get("filename") or ""
        if fn and b.get("attachmentId"):
            atts.append({"filename": fn, "mimeType": part.get("mimeType"),
                         "attachment_id": b["attachmentId"], "size": b.get("size")})
        for p in part.get("parts", []) or []:
            walk_att(p)
    walk_att(full.get("payload", {}))
    # Two DIFFERENT timestamps, deliberately both exposed. `date` is the Date
    # header the SENDER's client wrote (when it was sent); `internal_date` is
    # what Gmail recorded when the message ARRIVED on the server. They differ by
    # the delivery delay -- except that on this host they do NOT. Measured
    # 2026-09-11 across three messages: Date and internalDate were identical to
    # the second. Both are exposed anyway, because that measurement is exactly
    # what settled an afternoon-long argument: a "10:06" rendered quote line
    # against a 10:05:54 header is NOT explained by arrival lag, and the real
    # cause remains unknown. The first version of this comment asserted the
    # delivery-lag explanation as fact BEFORE it was measured, and that claim
    # then sat in the tool description every agent reads -- caught by another agent,
    # same day. Nothing here is inferred: internalDate comes straight from the
    # API, and the claim it disproved is now stated as disproved.
    internal_ms = full.get("internalDate")
    internal_iso = None
    if internal_ms:
        try:
            import datetime as _dt
            internal_iso = _dt.datetime.fromtimestamp(
                int(internal_ms) / 1000).astimezone().isoformat(timespec="seconds")
        except Exception:
            internal_iso = None
    return {
        "id": message_id,
        "from": _hdr(full, "From"),
        "to": _hdr(full, "To"),
        "subject": _hdr(full, "Subject"),
        "date": _hdr(full, "Date"),                 # sender's clock: when SENT
        "internal_date": internal_iso,              # Gmail's clock: when RECEIVED
        "internal_date_ms": internal_ms,
        "body": body[:20000],
        "attachments": atts,
    }


def gmail_get_attachment(message_id, attachment_id, filename=None):
    """Download a Gmail attachment's bytes to a local file; return the path. Get the
    message_id + attachment_id from gmail_get's 'attachments' list. READ-only (works
    with the existing gmail.modify scope -- NO extra login/connector needed)."""
    import base64
    import re as _re
    d = _api("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages/"
             + urllib.parse.quote(str(message_id)) + "/attachments/"
             + urllib.parse.quote(str(attachment_id)))
    data_b64 = d.get("data")
    if not data_b64:
        return {"saved": False, "reason": "no data in attachment response"}
    raw = base64.urlsafe_b64decode(data_b64)
    att_dir = os.path.join(tempfile.gettempdir(), "marveen-gmail-att")
    os.makedirs(att_dir, exist_ok=True)
    safe = _re.sub(r"[^A-Za-z0-9._-]", "_", (filename or (str(attachment_id)[:16] + ".bin")))[:120] or "attachment.bin"
    path = os.path.join(att_dir, safe)
    with open(path, "wb") as f:
        f.write(raw)
    return {"saved": True, "saved_to": path, "bytes": len(raw), "filename": filename or safe}


def _profile_email():
    p = _api("GET", "https://gmail.googleapis.com/gmail/v1/users/me/profile")
    return p.get("emailAddress", "")


def _build_raw(to, subject, body, cc=None):
    """Build a base64url-encoded RFC822 message from this account."""
    import base64
    from email.mime.text import MIMEText
    msg = MIMEText(body, "plain", "utf-8")
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    msg["From"] = _profile_email()
    msg["Subject"] = subject
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def gmail_create_draft(to, subject, body, cc=None):
    """Create a DRAFT (does not send). Allowed by gmail.modify scope."""
    raw = _build_raw(to, subject, body, cc)
    r = _api("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
             {"message": {"raw": raw}})
    return {"created": "draft", "draft_id": r.get("id"), "from": _profile_email(), "to": to, "subject": subject}


def _internal_domains():
    # Default: the bot's own account domain is "internal".
    envd = os.environ.get("GOOGLE_INTERNAL_DOMAINS", "").strip()
    if envd:
        return [d.strip().lower() for d in envd.split(",") if d.strip()]
    acct = ACCOUNT or _profile_email()
    return [acct.split("@", 1)[1].lower()] if "@" in acct else []


def _external_recipients(to, cc=None):
    import re as _re
    addrs = []
    for field in (to, cc):
        if field:
            addrs += _re.findall(r"[\w.+-]+@[\w.-]+", field)
    doms = _internal_domains()
    return [a for a in addrs if a.split("@", 1)[1].lower() not in doms]


def gmail_send(to, subject, body, cc=None):
    """SEND an email now. Requires the gmail.send scope. GUARDRAIL: only internal
    recipients are sent autonomously; any external recipient is refused (the bot
    must get owner approval and/or use gmail_create_draft instead)."""
    ext = _external_recipients(to, cc)
    if ext:
        return {"sent": False, "blocked": True, "reason":
                "external recipient(s) are not allowed without approval: " + ", ".join(ext) +
                ". Create a draft instead (gmail_create_draft) and ask the owner / main agent for approval, "
                "or send only to internal (@" + ",".join(_internal_domains()) + ") addresses."}
    raw = _build_raw(to, subject, body, cc)
    r = _api("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
             {"raw": raw})
    return {"sent": True, "message_id": r.get("id"), "from": _profile_email(), "to": to, "subject": subject}


def _attendees_list(attendees):
    if not attendees:
        return []
    if isinstance(attendees, str):
        import re as _re
        attendees = _re.findall(r"[\w.+-]+@[\w.-]+", attendees)
    return [{"email": a} for a in attendees]


def calendar_create_event(summary, start, end, attendees=None, description=None,
                          location=None, calendar_id="primary", tz="Europe/Budapest"):
    body = {
        "summary": summary,
        "start": {"dateTime": start, "timeZone": tz},
        "end": {"dateTime": end, "timeZone": tz},
    }
    if description:
        body["description"] = description
    if location:
        body["location"] = location
    att = _attendees_list(attendees)
    if att:
        body["attendees"] = att
    url = (f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}"
           f"/events?sendUpdates=all")
    r = _api("POST", url, body)
    return {"created": True, "event_id": r.get("id"), "htmlLink": r.get("htmlLink"),
            "summary": summary, "start": start, "attendees": [a["email"] for a in att]}


def calendar_update_event(event_id, summary=None, start=None, end=None, attendees=None,
                          description=None, location=None, calendar_id="primary", tz="Europe/Budapest"):
    body = {}
    if summary is not None:
        body["summary"] = summary
    if start is not None:
        body["start"] = {"dateTime": start, "timeZone": tz}
    if end is not None:
        body["end"] = {"dateTime": end, "timeZone": tz}
    if description is not None:
        body["description"] = description
    if location is not None:
        body["location"] = location
    if attendees is not None:
        body["attendees"] = _attendees_list(attendees)
    url = (f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}"
           f"/events/{urllib.parse.quote(event_id)}?sendUpdates=all")
    r = _api("PATCH", url, body)
    return {"updated": True, "event_id": r.get("id"), "htmlLink": r.get("htmlLink")}


def calendar_delete_event(event_id, calendar_id="primary"):
    url = (f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}"
           f"/events/{urllib.parse.quote(event_id)}?sendUpdates=all")
    _api("DELETE", url)
    return {"deleted": True, "event_id": event_id}


def calendar_freebusy(attendees, time_min, time_max):
    """Free/busy query across the given people (or self). Returns busy blocks so a
    conflict-free slot can be chosen before creating an event. Uses calendar scope."""
    emails = [a["email"] for a in _attendees_list(attendees)] or [_profile_email()]
    body = {"timeMin": time_min, "timeMax": time_max, "items": [{"id": e} for e in emails]}
    r = _api("POST", "https://www.googleapis.com/calendar/v3/freeBusy", body)
    cals = r.get("calendars", {})
    return {"range": [time_min, time_max], "busy": {k: v.get("busy", []) for k, v in cals.items()}}


def _upload(url, body_bytes, content_type):
    headers = {"Authorization": "Bearer " + _access_token(), "Content-Type": content_type}
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8").strip()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Google upload {e.code}: {e.read().decode()[:400]}")


def drive_create_doc(name, content="", folder_id=None):
    """Create a Google Doc from HTML/plain content. Uses drive scope."""
    boundary = "marveenmcpboundary7be1"
    meta = {"name": name, "mimeType": "application/vnd.google-apps.document"}
    if folder_id:
        meta["parents"] = [folder_id]
    body = (
        "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
        + json.dumps(meta) + "\r\n"
        + "--" + boundary + "\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n"
        + (content or "") + "\r\n"
        + "--" + boundary + "--"
    )
    r = _upload(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
        body.encode("utf-8"), "multipart/related; boundary=" + boundary)
    return {"created": True, "file_id": r.get("id"), "name": r.get("name"), "link": r.get("webViewLink")}


def drive_share(file_id, email, role="reader", notify=True):
    """Share a Drive file with someone. role: reader|commenter|writer. Uses drive scope."""
    body = {"type": "user", "role": role, "emailAddress": email}
    url = (f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(file_id)}/permissions"
           f"?sendNotificationEmail={'true' if notify else 'false'}&supportsAllDrives=true&fields=id")
    _api("POST", url, body)
    return {"shared": True, "file_id": file_id, "to": email, "role": role}


def drive_upload(file_path, name=None, folder_id=None, mime_type=None):
    """Upload a LOCAL file to Drive AS-IS (binary, NO Google-Doc conversion), so
    .docx/.xlsx/.pdf/pptx keep their exact formatting. Uses drive scope."""
    import os as _os
    import mimetypes as _mt
    if not _os.path.isfile(file_path):
        return {"error": f"file not found: {file_path}"}
    with open(file_path, "rb") as f:
        data = f.read()
    fname = name or _os.path.basename(file_path)
    mt = mime_type or _mt.guess_type(fname)[0] or "application/octet-stream"
    meta = {"name": fname}
    if folder_id:
        meta["parents"] = [folder_id]
    boundary = "marveenmcpbinup9c2f"
    pre = ("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
           + json.dumps(meta) + "\r\n"
           + "--" + boundary + "\r\nContent-Type: " + mt + "\r\n\r\n").encode("utf-8")
    post = ("\r\n--" + boundary + "--").encode("utf-8")
    body = pre + data + post
    r = _upload(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,mimeType,size",
        body, "multipart/related; boundary=" + boundary)
    return {"uploaded": True, "file_id": r.get("id"), "name": r.get("name"),
            "mimeType": r.get("mimeType"), "size": r.get("size"), "link": r.get("webViewLink")}


def gmail_labels():
    r = _api("GET", "https://gmail.googleapis.com/gmail/v1/users/me/labels")
    return {"labels": [{"id": l["id"], "name": l["name"]} for l in r.get("labels", [])]}


def _ensure_label(name):
    for l in _api("GET", "https://gmail.googleapis.com/gmail/v1/users/me/labels").get("labels", []):
        if l["name"].lower() == name.lower():
            return l["id"]
    c = _api("POST", "https://gmail.googleapis.com/gmail/v1/users/me/labels",
             {"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"})
    return c["id"]


def gmail_apply_label(message_id, label=None, remove=None):
    """Apply (creating if needed) and/or remove labels on a message. Email-triage. Uses gmail.modify."""
    add_ids = [_ensure_label(label)] if label else []
    rem_ids = []
    if remove:
        alll = {l["name"].lower(): l["id"] for l in _api("GET", "https://gmail.googleapis.com/gmail/v1/users/me/labels").get("labels", [])}
        for x in ([remove] if isinstance(remove, str) else remove):
            if x.lower() in alll:
                rem_ids.append(alll[x.lower()])
    r = _api("POST", f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}/modify",
             {"addLabelIds": add_ids, "removeLabelIds": rem_ids})
    return {"message_id": message_id, "labels_now": r.get("labelIds", [])}


def _fold(s):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFKD", (s or "").lower()) if not unicodedata.combining(c))


def people_search(query, max_results=10):
    """Resolve a name to email(s) from the Workspace directory. Requires
    directory.readonly scope, People API enabled, and Admin 'Contact sharing' ON.
    Uses listDirectoryPeople (reliable for small orgs) + accent-insensitive
    substring match, so 'anna' matches 'Anna Kovács'."""
    params = {"readMask": "names,emailAddresses",
              "sources": "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE", "pageSize": 200}
    r = _api("GET", "https://people.googleapis.com/v1/people:listDirectoryPeople?" + urllib.parse.urlencode(params))
    q = _fold(query)
    out = []
    for p in r.get("people", []):
        name = (p.get("names") or [{}])[0].get("displayName")
        emails = [e.get("value") for e in (p.get("emailAddresses") or [])]
        hay = _fold(name) + " " + _fold(" ".join(emails))
        if not q or q in hay:
            out.append({"name": name, "emails": emails})
    return {"query": query, "results": out[:max_results]}


def calendar_list_events(time_min=None, time_max=None, max_results=10, calendar_id="primary"):
    params = {"singleEvents": "true", "orderBy": "startTime", "maxResults": max_results}
    if time_min:
        params["timeMin"] = time_min
    if time_max:
        params["timeMax"] = time_max
    q = urllib.parse.urlencode(params)
    url = f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}/events?{q}"
    r = _api("GET", url)
    events = [_event_summary(e) for e in r.get("items", [])]
    return {"count": len(events), "events": events}


def _attendees(e):
    """Attendee list trimmed to what an assistant actually reasons about.

    responseStatus is the whole point: without it no bot can answer "did my
    owner accept this invite?" -- the question that used to be unanswerable
    from this MCP at all.
    """
    out = []
    for a in (e.get("attendees") or []):
        out.append({
            "email": a.get("email"),
            "name": a.get("displayName"),
            "response": a.get("responseStatus"),  # needsAction|declined|tentative|accepted
            "organizer": bool(a.get("organizer")),
            "self": bool(a.get("self")),
            "optional": bool(a.get("optional")),
        })
    return out


def _event_summary(e):
    """One event, shaped the same way by list and get so callers need one parser.

    `my_response` is lifted out of the attendee list because it is the field
    that gets asked for, and digging it back out of `attendees` by the `self`
    flag is exactly the step a caller would get wrong.
    """
    att = _attendees(e)
    mine = next((a for a in att if a.get("self")), None)
    return {
        "id": e.get("id"),
        "summary": e.get("summary"),
        "start": (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date"),
        "end": (e.get("end") or {}).get("dateTime") or (e.get("end") or {}).get("date"),
        "location": e.get("location"),
        "status": e.get("status"),  # confirmed|tentative|cancelled
        "organizer": (e.get("organizer") or {}).get("email"),
        "my_response": (mine or {}).get("response"),
        "attendees": att,
    }


def calendar_get_event(event_id, calendar_id="primary"):
    """Full detail for ONE event, including the description and conference link.

    Kept separate from list because the description can be long; list stays
    cheap to scan, get is what you call once you know which event matters.
    """
    url = (f"https://www.googleapis.com/calendar/v3/calendars/"
           f"{urllib.parse.quote(calendar_id)}/events/{urllib.parse.quote(event_id)}")
    e = _api("GET", url)
    out = _event_summary(e)
    out["description"] = e.get("description")
    out["hangout_link"] = e.get("hangoutLink")
    out["html_link"] = e.get("htmlLink")
    out["recurring_event_id"] = e.get("recurringEventId")
    out["created"] = e.get("created")
    out["updated"] = e.get("updated")
    return out


def drive_search(query="", max_results=15):
    # includeItemsFromAllDrives + supportsAllDrives + corpora=allDrives so that
    # files in Shared Drives (e.g. shared template folders) are also returned,
    # not just the account's My Drive.
    params = {"pageSize": max_results,
              "fields": "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))",
              "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
              "corpora": "allDrives"}
    if query:
        params["q"] = query
    q = urllib.parse.urlencode(params)
    r = _api("GET", f"https://www.googleapis.com/drive/v3/files?{q}")
    return {"count": len(r.get("files", [])), "files": r.get("files", [])}


def _download_bytes(url):
    headers = {"Authorization": "Bearer " + _access_token()}
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:500]
        raise RuntimeError(f"Google API {e.code}: {detail}")


def drive_download(file_id, export_mime=None):
    """Download a Drive file to a LOCAL path so the caller can Read it (PNG/JPG/PDF via
    vision; Google Docs/Sheets/Slides exported to text/CSV/PDF). READ-ONLY. Returns
    {path, name, mime, bytes}. The caller then uses the Read tool on `path`."""
    meta = _api("GET", "https://www.googleapis.com/drive/v3/files/"
                + urllib.parse.quote(file_id)
                + "?fields=id,name,mimeType&supportsAllDrives=true")
    name = meta.get("name") or file_id
    mime = meta.get("mimeType") or ""
    if mime.startswith("application/vnd.google-apps"):
        default_exports = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.presentation": "application/pdf",
            "application/vnd.google-apps.drawing": "image/png",
        }
        em = export_mime or default_exports.get(mime, "application/pdf")
        url = ("https://www.googleapis.com/drive/v3/files/" + urllib.parse.quote(file_id)
               + "/export?mimeType=" + urllib.parse.quote(em) + "&supportsAllDrives=true")
        out_mime = em
    else:
        url = ("https://www.googleapis.com/drive/v3/files/" + urllib.parse.quote(file_id)
               + "?alt=media&supportsAllDrives=true")
        out_mime = mime
    data = _download_bytes(url)
    ext = {"text/plain": ".txt", "text/csv": ".csv", "application/pdf": ".pdf",
           "image/png": ".png", "image/jpeg": ".jpg"}.get(out_mime, "")
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in name)[:80]
    d = os.path.join(tempfile.gettempdir(), "google-mcp-drive")
    os.makedirs(d, exist_ok=True)
    fname = file_id + "_" + safe
    if ext and not fname.endswith(ext):
        fname += ext
    path = os.path.join(d, fname)
    with open(path, "wb") as f:
        f.write(data)
    return {"path": path, "name": name, "mime": out_mime, "bytes": len(data)}


def _norm_rows(rows):
    """Coerce rows into a list-of-lists of primitive cell values."""
    norm = []
    for row in (rows or []):
        if not isinstance(row, list):
            row = [row]
        norm.append(["" if c is None else (c if isinstance(c, (str, int, float)) else str(c)) for c in row])
    return norm


def sheets_create(name, headers=None, folder_id=None):
    """Create a NEW Google Sheet (spreadsheet) on Drive, optionally with a header row.
    Works with the existing 'drive' scope (no spreadsheets scope needed). Returns
    {spreadsheet_id, link}. Use sheets_append afterwards to add data rows."""
    meta = {"name": name, "mimeType": "application/vnd.google-apps.spreadsheet"}
    if folder_id:
        meta["parents"] = [folder_id]
    r = _api("POST", "https://www.googleapis.com/drive/v3/files"
             "?supportsAllDrives=true&fields=id,name,webViewLink", meta)
    sid = r.get("id")
    out = {"created": True, "spreadsheet_id": sid, "name": r.get("name"), "link": r.get("webViewLink")}
    if headers:
        try:
            sheets_append(sid, [headers])
        except Exception as e:
            out["header_warning"] = f"sheet created but header row failed (Sheets API enabled?): {e}"
    return out


# SHEETSRAW924. USER_ENTERED parses a leading '+', '=', '-' or '@' as a
# formula: international phone numbers ('+1 555 ...') and values like '-5 C'
# became #ERROR! in a delivered table (5 of 6 rows, 2026-09-15), and the
# FORMATTED_VALUE read then showed only '#ERROR!', so the damage could not even
# be inspected. Both modes are now selectable; defaults are unchanged.
_VALUE_INPUT = ("USER_ENTERED", "RAW")
_VALUE_RENDER = ("FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA")


def _pick(value, allowed, default):
    v = (value or default).strip().upper()
    if v not in allowed:
        raise ValueError("must be one of %s, got %r" % (", ".join(allowed), value))
    return v


def sheets_append(spreadsheet_id, rows, sheet_name=None, value_input=None):
    """APPEND rows to the end of a Google Sheet via the Sheets API values.append.
    rows: a list of rows, each row a list of cells. Existing content is preserved
    (INSERT_ROWS). Works with the existing 'drive' scope. Requires the Sheets API to
    be enabled on the Cloud project. Returns the updated range + row count."""
    rng = (sheet_name + "!A1") if sheet_name else "A1"
    url = ("https://sheets.googleapis.com/v4/spreadsheets/" + urllib.parse.quote(spreadsheet_id)
           + "/values/" + urllib.parse.quote(rng)
           + ":append?valueInputOption=" + _pick(value_input, _VALUE_INPUT, "USER_ENTERED")
           + "&insertDataOption=INSERT_ROWS")
    r = _api("POST", url, {"values": _norm_rows(rows)})
    upd = r.get("updates", {})
    return {"appended": True, "spreadsheet_id": spreadsheet_id,
            "updated_range": upd.get("updatedRange"), "updated_rows": upd.get("updatedRows")}


def sheets_read(spreadsheet_id, range="A1:Z1000", sheet_name=None, value_render=None):
    """Read a cell range from a Google Sheet via the Sheets API (values.get). Returns
    {values: [[...]]}. Useful for de-duplication before append (e.g. skip a news URL
    already present). Works with the existing 'drive' scope."""
    rng = (sheet_name + "!" + range) if sheet_name else range
    url = ("https://sheets.googleapis.com/v4/spreadsheets/" + urllib.parse.quote(spreadsheet_id)
           + "/values/" + urllib.parse.quote(rng)
           + "?valueRenderOption=" + _pick(value_render, _VALUE_RENDER, "FORMATTED_VALUE"))
    r = _api("GET", url)
    return {"spreadsheet_id": spreadsheet_id, "range": r.get("range"), "values": r.get("values", [])}


def sheets_update(spreadsheet_id, range, values, sheet_name=None, value_input=None):
    """WRITE values into a SPECIFIC range of a Google Sheet via the Sheets API
    values.update (PUT). Overwrites the cells in `range` with `values` (a list of rows,
    each a list of cells). Unlike sheets_append (which only adds to the bottom), this
    places rows at an exact location, e.g. 'Menetlevelek!Y5:AH5'. USER_ENTERED so
    formulas/dates parse. Works with the existing 'drive' scope. Returns updated range +
    counts."""
    rng = (sheet_name + "!" + range) if sheet_name else range
    url = ("https://sheets.googleapis.com/v4/spreadsheets/" + urllib.parse.quote(spreadsheet_id)
           + "/values/" + urllib.parse.quote(rng)
           + "?valueInputOption=" + _pick(value_input, _VALUE_INPUT, "USER_ENTERED"))
    r = _api("PUT", url, {"values": _norm_rows(values)})
    return {"updated": True, "spreadsheet_id": spreadsheet_id,
            "updated_range": r.get("updatedRange"), "updated_rows": r.get("updatedRows"),
            "updated_columns": r.get("updatedColumns"), "updated_cells": r.get("updatedCells")}


def whoami():
    return {"gmail": _profile_email(), "expected": ACCOUNT}


TOOLS = {
    "whoami": {
        "fn": lambda a: whoami(),
        "desc": "Return the Google account this bot is actually connected to (sanity check).",
        "schema": {"type": "object", "properties": {}},
    },
    "gmail_search": {
        "fn": lambda a: gmail_search(a.get("query", ""), int(a.get("max_results", 10))),
        "desc": "Search this account's Gmail. Gmail query syntax (e.g. 'is:unread newer_than:2d').",
        "schema": {"type": "object", "properties": {
            "query": {"type": "string"}, "max_results": {"type": "integer"}}},
    },
    "gmail_get": {
        "fn": lambda a: gmail_get(a["message_id"]),
        "desc": "Fetch one Gmail message (headers + plain-text body + ATTACHMENTS list) by id. The 'attachments' field lists filename + attachment_id for each attached file; pass those to gmail_get_attachment to download the bytes. TWO timestamps come back and they are NOT the same quantity: 'date' is the sender's Date header (when it was SENT) and 'internal_date' is Gmail's own record of when it ARRIVED. Measured on this host 2026-09-11 across three messages, the two were IDENTICAL to the second -- so on internal mail do not expect a delivery gap, and do not use one to explain away a discrepancy. If a Gmail RENDERED quote line disagrees with the header (observed: header 10:05:54, quote line '10:06'), the cause is NOT established -- delivery delay is ruled out by the above and rounding does not fit either. Treat it as unexplained, not as two events. When a timestamp goes into a document, a report or a Monday comment AS FACT, take it from 'date'.",
        "schema": {"type": "object", "properties": {"message_id": {"type": "string"}}, "required": ["message_id"]},
    },
    "gmail_get_attachment": {
        "fn": lambda a: gmail_get_attachment(a["message_id"], a["attachment_id"], a.get("filename")),
        "desc": "Download a Gmail attachment (PDF/image/doc) to a local file and return its path. Get message_id + attachment_id from gmail_get's 'attachments' list. Use to fetch e.g. invoice/contract PDFs for further processing. READ-only; works with the existing scope (no extra login/connector).",
        "schema": {"type": "object", "properties": {"message_id": {"type": "string"}, "attachment_id": {"type": "string"}, "filename": {"type": "string"}}, "required": ["message_id", "attachment_id"]},
    },
    "calendar_list_events": {
        "fn": lambda a: calendar_list_events(a.get("time_min"), a.get("time_max"), int(a.get("max_results", 10)), a.get("calendar_id", "primary")),
        "desc": "List calendar events. time_min/time_max are ISO 8601 (e.g. 2026-07-23T00:00:00+02:00). Each event includes attendees with their responseStatus, plus `my_response` (this account's own accepted/declined/tentative/needsAction) and `status`.",
        "schema": {"type": "object", "properties": {
            "time_min": {"type": "string"}, "time_max": {"type": "string"},
            "max_results": {"type": "integer"}, "calendar_id": {"type": "string"}}},
    },
    "calendar_get_event": {
        "fn": lambda a: calendar_get_event(a["event_id"], a.get("calendar_id", "primary")),
        "desc": "Full detail for ONE calendar event by id: description, conference link, attendees with responseStatus, and `my_response` (did THIS account accept the invite). Use after calendar_list_events picks out the event. Read-only.",
        "schema": {"type": "object", "properties": {
            "event_id": {"type": "string"}, "calendar_id": {"type": "string"}},
            "required": ["event_id"]},
    },
    "drive_search": {
        "fn": lambda a: drive_search(a.get("query", ""), int(a.get("max_results", 15))),
        "desc": "Search/list Drive files. Optional 'query' uses Drive query syntax (e.g. \"name contains 'arajanlat'\").",
        "schema": {"type": "object", "properties": {
            "query": {"type": "string"}, "max_results": {"type": "integer"}}},
    },
    "drive_download": {
        "fn": lambda a: drive_download(a["file_id"], a.get("export_mime")),
        "desc": "Download a Drive file to a LOCAL path so it can be Read (PNG/JPG/PDF via vision; Google Docs/Sheets/Slides exported to text/CSV/PDF). Returns {path,name,mime,bytes}; then use the Read tool on `path`. Read-only.",
        "schema": {"type": "object", "properties": {
            "file_id": {"type": "string"}, "export_mime": {"type": "string"}}, "required": ["file_id"]},
    },
    "gmail_create_draft": {
        "fn": lambda a: gmail_create_draft(a["to"], a.get("subject", ""), a.get("body", ""), a.get("cc")),
        "desc": "Create a Gmail DRAFT in this account (does NOT send). Sender is this bot's own account.",
        "schema": {"type": "object", "properties": {
            "to": {"type": "string"}, "subject": {"type": "string"},
            "body": {"type": "string"}, "cc": {"type": "string"}}, "required": ["to", "body"]},
    },
    "gmail_send": {
        "fn": lambda a: gmail_send(a["to"], a.get("subject", ""), a.get("body", ""), a.get("cc")),
        "desc": "SEND an email now from this bot's own account. Requires the gmail.send scope. GUARDRAIL: internal recipients only; external recipients are refused (draft + get approval instead).",
        "schema": {"type": "object", "properties": {
            "to": {"type": "string"}, "subject": {"type": "string"},
            "body": {"type": "string"}, "cc": {"type": "string"}}, "required": ["to", "body"]},
    },
    "calendar_create_event": {
        "fn": lambda a: calendar_create_event(a["summary"], a["start"], a["end"], a.get("attendees"),
                                              a.get("description"), a.get("location"),
                                              a.get("calendar_id", "primary")),
        "desc": "Create a calendar event and (optionally) invite attendees. start/end ISO 8601 (e.g. 2026-07-24T14:00:00+02:00). attendees: list or comma-separated emails. Invitations are sent (sendUpdates=all).",
        "schema": {"type": "object", "properties": {
            "summary": {"type": "string"}, "start": {"type": "string"}, "end": {"type": "string"},
            "attendees": {"type": "array", "items": {"type": "string"}},
            "description": {"type": "string"}, "location": {"type": "string"},
            "calendar_id": {"type": "string"}}, "required": ["summary", "start", "end"]},
    },
    "calendar_update_event": {
        "fn": lambda a: calendar_update_event(a["event_id"], a.get("summary"), a.get("start"), a.get("end"),
                                              a.get("attendees"), a.get("description"), a.get("location"),
                                              a.get("calendar_id", "primary")),
        "desc": "Update/reschedule an existing event (only pass the fields to change). Notifies attendees.",
        "schema": {"type": "object", "properties": {
            "event_id": {"type": "string"}, "summary": {"type": "string"},
            "start": {"type": "string"}, "end": {"type": "string"},
            "attendees": {"type": "array", "items": {"type": "string"}},
            "description": {"type": "string"}, "location": {"type": "string"},
            "calendar_id": {"type": "string"}}, "required": ["event_id"]},
    },
    "calendar_delete_event": {
        "fn": lambda a: calendar_delete_event(a["event_id"], a.get("calendar_id", "primary")),
        "desc": "Delete a calendar event by id. Notifies attendees.",
        "schema": {"type": "object", "properties": {
            "event_id": {"type": "string"}, "calendar_id": {"type": "string"}}, "required": ["event_id"]},
    },
    "calendar_freebusy": {
        "fn": lambda a: calendar_freebusy(a.get("attendees"), a["time_min"], a["time_max"]),
        "desc": "Free/busy across people (or self) in a time range -> pick a conflict-free slot before scheduling. attendees: list/comma emails. time_min/time_max ISO 8601.",
        "schema": {"type": "object", "properties": {
            "attendees": {"type": "array", "items": {"type": "string"}},
            "time_min": {"type": "string"}, "time_max": {"type": "string"}}, "required": ["time_min", "time_max"]},
    },
    "drive_create_doc": {
        "fn": lambda a: drive_create_doc(a["name"], a.get("content", ""), a.get("folder_id")),
        "desc": "Create a Google Doc (content may be HTML or plain text). Optional folder_id to place it. Returns link.",
        "schema": {"type": "object", "properties": {
            "name": {"type": "string"}, "content": {"type": "string"}, "folder_id": {"type": "string"}}, "required": ["name"]},
    },
    "drive_share": {
        "fn": lambda a: drive_share(a["file_id"], a["email"], a.get("role", "reader"), a.get("notify", True)),
        "desc": "Share a Drive file with someone. role: reader|commenter|writer.",
        "schema": {"type": "object", "properties": {
            "file_id": {"type": "string"}, "email": {"type": "string"},
            "role": {"type": "string"}, "notify": {"type": "boolean"}}, "required": ["file_id", "email"]},
    },
    "drive_upload": {
        "fn": lambda a: drive_upload(a["file_path"], a.get("name"), a.get("folder_id"), a.get("mime_type")),
        "desc": "Upload a LOCAL file to Drive AS-IS (binary, NO Google-Doc conversion) so .docx/.xlsx/.pdf/pptx keep their exact formatting. Optional name (default basename), folder_id, mime_type (auto-detected from extension). Returns file_id + link. Use THIS (not drive_create_doc) for finished .docx/.pdf/.xlsx deliverables.",
        "schema": {"type": "object", "properties": {
            "file_path": {"type": "string"}, "name": {"type": "string"},
            "folder_id": {"type": "string"}, "mime_type": {"type": "string"}}, "required": ["file_path"]},
    },
    "sheets_create": {
        "fn": lambda a: sheets_create(a["name"], a.get("headers"), a.get("folder_id")),
        "desc": "Create a NEW Google Sheet on Drive (optionally with a header row + target folder). Returns spreadsheet_id + link. Then use sheets_append to add rows. Uses the existing drive scope.",
        "schema": {"type": "object", "properties": {
            "name": {"type": "string"},
            "headers": {"type": "array", "items": {"type": "string"}},
            "folder_id": {"type": "string"}}, "required": ["name"]},
    },
    "sheets_append": {
        "fn": lambda a: sheets_append(a["spreadsheet_id"], a["rows"], a.get("sheet_name"), a.get("value_input")),
        "desc": "APPEND rows to the end of a Google Sheet (existing data preserved). rows: list of rows, each a list of cells. Optional sheet_name (tab). Uses the existing drive scope; needs the Sheets API enabled on the Cloud project. value_input=RAW for literal text (phone numbers, leading +/=/-/@).",
        "schema": {"type": "object", "properties": {
            "value_input": {"type": "string", "enum": ["USER_ENTERED", "RAW"], "description": "USER_ENTERED (default) parses formulas/dates; RAW stores text as-is -- use RAW for phone numbers (+1...) and values starting with =, -, @."},
            "spreadsheet_id": {"type": "string"},
            "rows": {"type": "array", "items": {"type": "array"}},
            "sheet_name": {"type": "string"}}, "required": ["spreadsheet_id", "rows"]},
    },
    "sheets_read": {
        "fn": lambda a: sheets_read(a["spreadsheet_id"], a.get("range", "A1:Z1000"), a.get("sheet_name"), a.get("value_render")),
        "desc": "Read a cell range from a Google Sheet (values.get) -> {values:[[...]]}. Use for de-dup before append. Uses the existing drive scope. value_render=FORMULA to see what is really stored in a cell.",
        "schema": {"type": "object", "properties": {
            "value_render": {"type": "string", "enum": ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"], "description": "FORMATTED_VALUE (default) as displayed; FORMULA shows the stored formula/text, e.g. to inspect a #ERROR! cell."},
            "spreadsheet_id": {"type": "string"}, "range": {"type": "string"},
            "sheet_name": {"type": "string"}}, "required": ["spreadsheet_id"]},
    },
    "sheets_update": {
        "fn": lambda a: sheets_update(a["spreadsheet_id"], a["range"], a["values"], a.get("sheet_name"), a.get("value_input")),
        "desc": "WRITE values into a SPECIFIC range of a Google Sheet (values.update, overwrites those cells). range e.g. 'Y5:AH5' or with sheet_name tab. values: list of rows, each a list of cells. Unlike sheets_append (bottom-only), this places rows at an exact location. Uses the existing drive scope. value_input=RAW for literal text (phone numbers, leading +/=/-/@).",
        "schema": {"type": "object", "properties": {
            "value_input": {"type": "string", "enum": ["USER_ENTERED", "RAW"], "description": "USER_ENTERED (default) parses formulas/dates; RAW stores text as-is -- use RAW for phone numbers (+1...) and values starting with =, -, @."},
            "spreadsheet_id": {"type": "string"}, "range": {"type": "string"},
            "values": {"type": "array", "items": {"type": "array"}},
            "sheet_name": {"type": "string"}}, "required": ["spreadsheet_id", "range", "values"]},
    },
    "gmail_labels": {
        "fn": lambda a: gmail_labels(),
        "desc": "List this account's Gmail labels (id + name).",
        "schema": {"type": "object", "properties": {}},
    },
    "gmail_apply_label": {
        "fn": lambda a: gmail_apply_label(a["message_id"], a.get("label"), a.get("remove")),
        "desc": "Email-triage: apply a label (auto-created if missing) and/or remove labels on a message.",
        "schema": {"type": "object", "properties": {
            "message_id": {"type": "string"}, "label": {"type": "string"},
            "remove": {"type": "array", "items": {"type": "string"}}}, "required": ["message_id"]},
    },
    "people_search": {
        "fn": lambda a: people_search(a["query"], int(a.get("max_results", 10))),
        "desc": "Resolve a person's NAME to their email(s) from the company directory (e.g. 'Anna' -> anna@...). Requires directory.readonly scope + People API.",
        "schema": {"type": "object", "properties": {
            "query": {"type": "string"}, "max_results": {"type": "integer"}}, "required": ["query"]},
    },
}


# ---- MCP stdio loop -------------------------------------------------------

def _send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _result(rid, result):
    _send({"jsonrpc": "2.0", "id": rid, "result": result})


def _error(rid, code, message):
    _send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method")
        rid = msg.get("id")
        if method == "initialize":
            _result(rid, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "google-mcp", "version": "0.1.0"},
            })
        elif method == "notifications/initialized":
            pass  # notification, no reply
        elif method == "ping":
            _result(rid, {})
        elif method == "tools/list":
            _result(rid, {"tools": [
                {"name": n, "description": t["desc"], "inputSchema": t["schema"]}
                for n, t in TOOLS.items()
            ] if SERVE_TOOLS else []})
        elif method == "tools/call":
            params = msg.get("params", {})
            name = params.get("name")
            args = params.get("arguments", {}) or {}
            tool = TOOLS.get(name) if SERVE_TOOLS else None
            if not tool:
                _error(rid, -32601, f"Unknown tool: {name}")
                continue
            try:
                res = tool["fn"](args)
                _result(rid, {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]})
            except Exception as e:
                _result(rid, {"content": [{"type": "text", "text": f"ERROR: {e}"}], "isError": True})
        elif rid is not None:
            _error(rid, -32601, f"Method not found: {method}")


if __name__ == "__main__":
    main()
