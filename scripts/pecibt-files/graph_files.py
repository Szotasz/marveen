#!/usr/bin/env python3
"""Graph file access for the pecibt havizaras workflow (card #198).

App-only (client credentials) access with the pecibt-files app, whose
Sites.Selected grant is scoped to Viktor's personal OneDrive site (verified
end-to-end on card #226: site 200, drive 200, target folder listable). The
monthly-close documents live under "projekt dokumentaciok/abci/..."; Viktor
edits them in web M365, agents read/write through this helper.

Credentials resolve from the vault at call time (pecibt-files-client-id,
pecibt-files-secret, pecibt-files-tenant-id) via scripts/vault-resolve.mjs --
never stored in this file, never printed.

Usage:
  python3 graph_files.py verify
  python3 graph_files.py list  "<folder path>"
  python3 graph_files.py get   "<remote file path>" <local path>
  python3 graph_files.py put   <local path> "<remote file path>"
  python3 graph_files.py rm    "<remote file path>"      (explicit cleanup only)

Paths are relative to the drive root of the personal site's "Dokumentumok"
drive, e.g. "projekt dokumentaciok/abci/bb 2022".
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

SITE = "pecibt-my.sharepoint.com:/personal/viktor_tolnai_pecibt_hu:"
GRAPH = "https://graph.microsoft.com/v1.0"
MARVEEN_ROOT = "/home/viktor/Projects/marveen"


def _vault(env_map):
    lines = "\n".join(f"{k}={v}" for k, v in env_map.items())
    out = subprocess.run(
        ["node", os.path.join(MARVEEN_ROOT, "scripts", "vault-resolve.mjs")],
        input=lines, capture_output=True, text=True, cwd=MARVEEN_ROOT, timeout=30)
    if out.returncode != 0:
        raise SystemExit(f"vault resolve failed: {out.stderr.strip()[:120]}")
    got = {}
    for line in out.stdout.strip().splitlines():
        k, _, v = line.partition("=")
        got[k] = v
    missing = [k for k in env_map if not got.get(k)]
    if missing:
        raise SystemExit(f"vault: missing values for {missing}")
    return got


def token():
    c = _vault({"CID": "pecibt-files-client-id",
                "SECRET": "pecibt-files-secret",
                "TENANT": "pecibt-files-tenant-id"})
    body = urllib.parse.urlencode({
        "client_id": c["CID"], "client_secret": c["SECRET"],
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        f"https://login.microsoftonline.com/{c['TENANT']}/oauth2/v2.0/token", data=body)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["access_token"]


def _req(tok, method, url, data=None, content_type=None):
    headers = {"Authorization": f"Bearer {tok}"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=120)


def _drive_url(tok):
    with _req(tok, "GET", f"{GRAPH}/sites/{SITE}/drive") as r:
        return f"{GRAPH}/drives/{json.loads(r.read())['id']}"


def _enc(path):
    return urllib.parse.quote(path.strip("/"))


def cmd_verify():
    tok = token()
    with _req(tok, "GET", f"{GRAPH}/sites/{SITE}") as r:
        site = json.loads(r.read())
    drive = _drive_url(tok)
    with _req(tok, "GET", drive) as r:
        d = json.loads(r.read())
    print(f"OK -- site: {site.get('displayName')}, drive: {d.get('name')} ({d.get('id')[:12]}...)")


def cmd_list(folder):
    tok = token()
    drive = _drive_url(tok)
    url = f"{drive}/root:/{_enc(folder)}:/children?$top=200&$select=name,size,lastModifiedDateTime,folder"
    with _req(tok, "GET", url) as r:
        items = json.loads(r.read()).get("value", [])
    print(f"{folder}: {len(items)} elem")
    for it in items:
        kind = "mappa" if "folder" in it else "fajl "
        print(f"  {kind}  {it['name']}  ({it.get('size', 0)} B, mod: {it.get('lastModifiedDateTime', '?')})")


def cmd_get(remote, local):
    tok = token()
    drive = _drive_url(tok)
    with _req(tok, "GET", f"{drive}/root:/{_enc(remote)}:/content") as r:
        data = r.read()
    with open(local, "wb") as f:
        f.write(data)
    print(f"letoltve -> {local} ({len(data)} B)")


def cmd_put(local, remote):
    tok = token()
    drive = _drive_url(tok)
    with open(local, "rb") as f:
        data = f.read()
    if len(data) > 4 * 1024 * 1024:
        raise SystemExit("4 MB folott upload-session kell -- ez a helper kis fajlokra valo (docx/xlsx ok)")
    with _req(tok, "PUT", f"{drive}/root:/{_enc(remote)}:/content", data=data,
              content_type="application/octet-stream") as r:
        it = json.loads(r.read())
    print(f"feltoltve -> {remote} ({it.get('size')} B, uj meret a szerveren: {it.get('size')})")


def cmd_rm(remote):
    tok = token()
    drive = _drive_url(tok)
    with _req(tok, "DELETE", f"{drive}/root:/{_enc(remote)}") as r:
        pass
    print(f"torolve -> {remote}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "verify":
        cmd_verify()
    elif cmd == "list" and len(sys.argv) == 3:
        cmd_list(sys.argv[2])
    elif cmd == "get" and len(sys.argv) == 4:
        cmd_get(sys.argv[2], sys.argv[3])
    elif cmd == "put" and len(sys.argv) == 4:
        cmd_put(sys.argv[2], sys.argv[3])
    elif cmd == "rm" and len(sys.argv) == 3:
        cmd_rm(sys.argv[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
