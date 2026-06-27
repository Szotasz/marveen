#!/usr/bin/env python3
"""
ownCloud / Nextcloud WebDAV CLI for Boss (fiREGboss account).

Design goal: use the remote store OPTIMALLY -- never download everything.
- `list` / `tree` use PROPFIND (metadata only: name, size, mtime) -- cheap.
- `get` / `cat` download exactly ONE file when you actually need its content.
- `index` builds a flat manifest (path + size + mtime) you read FIRST to decide
  which single file is worth fetching.

Credentials live in store/.owncloud-creds (chmod 600, gitignored).

Usage:
  owncloud-cli.py list [REMOTE_DIR]          # one level, metadata only
  owncloud-cli.py tree [REMOTE_DIR] [--depth N]
  owncloud-cli.py index [REMOTE_DIR]         # flat manifest of everything under dir
  owncloud-cli.py search TERM [REMOTE_DIR]   # filename match (metadata only)
  owncloud-cli.py get REMOTE LOCAL           # download one file
  owncloud-cli.py cat REMOTE                 # print one file to stdout
  owncloud-cli.py put LOCAL REMOTE           # upload one file
  owncloud-cli.py mkdir REMOTE_DIR
  owncloud-cli.py info REMOTE                # size/mtime of one path

Paths are relative to the account root (e.g. "fiREG könyvelés/2026").
"""
import os
import sys
import base64
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

CREDS = os.path.join(os.path.dirname(__file__), "..", "store", ".owncloud-creds")


def load_creds():
    c = {}
    with open(CREDS) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                c[k] = v
    return c


C = load_creds()
DAV = C["OC_DAV"].rstrip("/")
AUTH = "Basic " + base64.b64encode(
    f"{C['OC_USER']}:{C['OC_PASS']}".encode()
).decode()


def _url(remote):
    remote = remote.strip("/")
    parts = [urllib.parse.quote(p) for p in remote.split("/") if p]
    return DAV + "/" + "/".join(parts) if parts else DAV + "/"


def _req(method, url, data=None, headers=None, expect=(200, 201, 204, 207),
         timeout=30, retries=2):
    h = {"Authorization": AUTH}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
    raise last


NS = "{DAV:}"


def _propfind(remote, depth="1"):
    body = (
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        "<d:getcontentlength/><d:getlastmodified/><d:resourcetype/>"
        "</d:prop></d:propfind>"
    ).encode()
    status, raw = _req(
        "PROPFIND", _url(remote), data=body,
        headers={"Depth": depth, "Content-Type": "application/xml"},
    )
    if status != 207:
        raise RuntimeError(f"PROPFIND {remote!r} -> HTTP {status}")
    root = ET.fromstring(raw)
    base = urllib.parse.urlsplit(DAV).path.rstrip("/")
    items = []
    for resp in root.findall(f"{NS}response"):
        href = resp.findtext(f"{NS}href") or ""
        path = urllib.parse.unquote(urllib.parse.urlsplit(href).path)
        rel = path[len(base):].strip("/") if path.startswith(base) else path
        is_dir = resp.find(f".//{NS}collection") is not None
        size = resp.findtext(f".//{NS}getcontentlength")
        mtime = resp.findtext(f".//{NS}getlastmodified") or ""
        items.append({
            "rel": rel, "dir": is_dir,
            "size": int(size) if size and size.isdigit() else 0,
            "mtime": mtime,
        })
    return items


def _walk(remote):
    """Client-side recursive walk via Depth:1 (server forbids Depth:infinity)."""
    out = []
    stack = [remote.strip("/")]
    seen = set()
    while stack:
        d = stack.pop()
        if d in seen:
            continue
        seen.add(d)
        try:
            items = _propfind(d, "1")
        except Exception as e:
            sys.stderr.write(f"skip {d!r}: {e}\n")
            continue
        for it in items:
            rel = it["rel"].strip("/")
            if rel == d:
                continue
            out.append(it)
            if it["dir"]:
                stack.append(rel)
    return out


def _human(n):
    for u in ("B", "K", "M", "G"):
        if n < 1024:
            return f"{n:.0f}{u}" if u == "B" else f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}T"


def cmd_list(args):
    remote = args[0] if args else ""
    items = _propfind(remote, "1")
    here = remote.strip("/")
    for it in items:
        if it["rel"].strip("/") == here:
            continue  # skip the dir itself
        kind = "d" if it["dir"] else "-"
        size = "" if it["dir"] else _human(it["size"])
        name = it["rel"].split("/")[-1] or it["rel"]
        print(f"{kind} {size:>8}  {name}")


def cmd_tree(args):
    if "--depth" in args:
        i = args.index("--depth")
        args = args[:i] + args[i + 2:]  # depth ignored; server forbids it
    remote = args[0] if args else ""
    items = _walk(remote)
    for it in sorted(items, key=lambda x: x["rel"]):
        kind = "d" if it["dir"] else "-"
        size = "" if it["dir"] else _human(it["size"])
        print(f"{kind} {size:>8}  {it['rel']}")


def cmd_index(args):
    remote = args[0] if args else ""
    items = _walk(remote)
    here = remote.strip("/")
    files = [i for i in items if not i["dir"] and i["rel"].strip("/") != here]
    total = sum(i["size"] for i in files)
    print(f"# Manifest of /{here}  ({len(files)} files, {_human(total)})")
    for it in sorted(files, key=lambda x: x["rel"]):
        print(f"{_human(it['size']):>8}  {it['rel']}")


MANIFEST = os.path.join(os.path.dirname(__file__), "..", "store", "owncloud-index.txt")


def cmd_search(args):
    # Default: grep the cached manifest (instant). Use --live to re-walk WebDAV.
    live = "--live" in args
    args = [a for a in args if a != "--live"]
    term = args[0].lower()
    remote = (args[1] if len(args) > 1 else "").strip("/")
    if not live and os.path.exists(MANIFEST):
        hits = 0
        with open(MANIFEST) as f:
            for line in f:
                line = line.rstrip("\n")
                if line.startswith("#") or not line.strip():
                    continue
                # manifest line: "   <size>  <relpath>"
                parts = line.split("  ", 1)
                rel = parts[1].strip() if len(parts) > 1 else line.strip()
                if remote and not rel.startswith(remote):
                    continue
                if term in rel.lower():
                    print(f"- {parts[0].strip():>8}  {rel}")
                    hits += 1
        sys.stderr.write(f"[manifest search, {hits} hits; use --live for fresh walk]\n")
        return
    items = _walk(remote)
    for it in sorted(items, key=lambda x: x["rel"]):
        if term in it["rel"].lower():
            kind = "d" if it["dir"] else "-"
            size = "" if it["dir"] else _human(it["size"])
            print(f"{kind} {size:>8}  {it['rel']}")


def cmd_get(args):
    remote, local = args[0], args[1]
    status, raw = _req("GET", _url(remote), expect=(200,))
    if status != 200:
        sys.stderr.write(f"GET {remote!r} -> HTTP {status}\n")
        sys.exit(1)
    with open(local, "wb") as f:
        f.write(raw)
    print(f"{len(raw)} bytes -> {local}")


def cmd_cat(args):
    status, raw = _req("GET", _url(args[0]), expect=(200,))
    if status != 200:
        sys.stderr.write(f"GET -> HTTP {status}\n")
        sys.exit(1)
    sys.stdout.buffer.write(raw)


def cmd_put(args):
    local, remote = args[0], args[1]
    with open(local, "rb") as f:
        data = f.read()
    status, _ = _req("PUT", _url(remote), data=data)
    print(f"PUT {remote} -> HTTP {status} ({len(data)} bytes)")


def cmd_mkdir(args):
    status, _ = _req("MKCOL", _url(args[0]))
    print(f"MKCOL {args[0]} -> HTTP {status}")


def cmd_info(args):
    items = _propfind(args[0], "0")
    for it in items:
        print(f"{'dir' if it['dir'] else 'file'}  {_human(it['size'])}  {it['mtime']}  {it['rel']}")


CMDS = {
    "list": cmd_list, "ls": cmd_list, "tree": cmd_tree, "index": cmd_index,
    "search": cmd_search, "get": cmd_get, "cat": cmd_cat, "put": cmd_put,
    "mkdir": cmd_mkdir, "info": cmd_info,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(__doc__)
        sys.exit(0 if len(sys.argv) < 2 else 1)
    try:
        CMDS[sys.argv[1]](sys.argv[2:])
    except RuntimeError as e:
        sys.stderr.write(f"error: {e}\n")
        sys.exit(1)
