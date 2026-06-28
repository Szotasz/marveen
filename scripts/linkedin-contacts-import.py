#!/usr/bin/env python3
"""
LinkedIn Connections CSV -> kontakt-halo (warm memoria) importer.

Beolvassa a LinkedIn adat-exportbol szarmazo Connections.csv-t, es minden
kapcsolatbol egy warm memoria bejegyzest keszit a kontakt-halo-epites skill
fix KONTAKT formatumaban. Dedup: a meglevo warm bejegyzeseket (SQLite-bol
olvasva) email + ASCII nev alapjan nezi, hogy ne keletkezzen duplikatum.

Hasznalat:
  python3 scripts/linkedin-contacts-import.py path/to/Connections.csv [--dry-run] [--limit N]

A CSV-t a LinkedIn igy adja: van egy 2-3 soros "Notes:" preambulum, majd a
valodi fejlec: First Name,Last Name,URL,Email Address,Company,Position,Connected On
"""
import csv
import io
import json
import os
import sys
import sqlite3
import unicodedata
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, "store", "claudeclaw.db")
TOKEN_PATH = os.path.join(ROOT, "store", ".dashboard-token")
API = "http://localhost:3420/api/memories"
AGENT_ID = "attilaknowsthatteambot"


def ascii_fold(s: str) -> str:
    """Ekezet -> ASCII, lowercase, normalizalt whitespace."""
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", s)
    out = "".join(c for c in nfkd if not unicodedata.combining(c))
    return " ".join(out.lower().split())


def load_token() -> str:
    with open(TOKEN_PATH, "r") as f:
        return f.read().strip()


def find_header_and_rows(path: str):
    """LinkedIn preambulum atugrasa: a fejlec az a sor, ami 'First Name'-mel kezdodik."""
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        lines = f.readlines()
    start = None
    for i, line in enumerate(lines):
        if line.lstrip().startswith("First Name"):
            start = i
            break
    if start is None:
        raise SystemExit("Nem talalom a 'First Name' fejlec sort a CSV-ben. Ez tenyleg LinkedIn Connections export?")
    reader = csv.DictReader(io.StringIO("".join(lines[start:])))
    return list(reader)


def build_existing_index(con):
    """Meglevo warm KONTAKT bejegyzesek indexe email + ASCII nev kulcsra."""
    by_email = {}
    by_name = {}
    try:
        cur = con.execute(
            "SELECT id, content FROM memories WHERE agent_id = ? AND category IN ('warm','shared')",
            (AGENT_ID,),
        )
    except sqlite3.OperationalError as e:
        raise SystemExit(f"DB olvasasi hiba: {e}")
    for mid, content in cur.fetchall():
        if not content:
            continue
        low = content.lower()
        if "kontakt:" not in low:
            continue
        # nev az elso sorbol: "KONTAKT: <Nev>"
        first = content.splitlines()[0]
        name = first.split(":", 1)[1].strip() if ":" in first else ""
        if name:
            by_name[ascii_fold(name)] = mid
        # email a content-bol
        for line in content.splitlines():
            ls = line.strip().lower()
            if ls.startswith("email:"):
                em = ls.split(":", 1)[1].strip()
                if em and em != "-":
                    by_email[em] = mid
    return by_email, by_name


def make_record(row) -> dict:
    first = (row.get("First Name") or "").strip()
    last = (row.get("Last Name") or "").strip()
    name = (first + " " + last).strip()
    email = (row.get("Email Address") or "").strip()
    company = (row.get("Company") or "").strip() or "-"
    position = (row.get("Position") or "").strip() or "-"
    connected = (row.get("Connected On") or "").strip() or "-"
    url = (row.get("URL") or "").strip()
    return {
        "name": name,
        "email": email,
        "company": company,
        "position": position,
        "connected": connected,
        "url": url,
    }


def format_content(rec) -> str:
    ctx = "LinkedIn kapcsolat"
    if rec["connected"] != "-":
        ctx += f", csatlakozas: {rec['connected']}"
    if rec["url"]:
        ctx += f" ({rec['url']})"
    return (
        f"KONTAKT: {rec['name']}\n"
        f"  email: {rec['email'] or '-'}\n"
        f"  tel: -\n"
        f"  ceg: {rec['company']}\n"
        f"  szerep: {rec['position']}\n"
        f"  kapcsolat: linkedin-kapcsolat:Attila\n"
        f"  kontextus: {ctx}\n"
        f"  forras: linkedin\n"
        f"  utolso_erintkezes: -"
    )


def make_keywords(rec) -> str:
    parts = [ascii_fold(rec["name"]), "kontakt", "linkedin"]
    if rec["company"] != "-":
        parts.append(ascii_fold(rec["company"]))
    # egyedi, ures kiszurese
    seen, out = set(), []
    for p in parts:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return ", ".join(out)


def post_memory(token, content, keywords) -> tuple:
    payload = json.dumps({
        "agent_id": AGENT_ID,
        "content": content,
        "category": "warm",
        "keywords": keywords,
    }).encode()
    req = urllib.request.Request(API, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()
    except Exception as e:
        return False, str(e)


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("Hasznalat: linkedin-contacts-import.py Connections.csv [--dry-run] [--limit N]")
    dry = "--dry-run" in args
    limit = None
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    csv_path = next(a for a in args if not a.startswith("--") and a != str(limit))

    rows = find_header_and_rows(csv_path)
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    by_email, by_name = build_existing_index(con)
    con.close()
    token = "" if dry else load_token()

    stats = {"new": 0, "dup_email": 0, "dup_name": 0, "noname": 0, "fail": 0}
    seen_in_run = set()
    n = 0
    for row in rows:
        if limit and n >= limit:
            break
        rec = make_record(row)
        if not rec["name"]:
            stats["noname"] += 1
            continue
        em = rec["email"].lower()
        nk = ascii_fold(rec["name"])
        # dedup: meglevo DB + ezen futason belul
        if em and (em in by_email or em in seen_in_run):
            stats["dup_email"] += 1
            continue
        if nk in by_name or nk in seen_in_run:
            stats["dup_name"] += 1
            continue
        n += 1
        content = format_content(rec)
        keywords = make_keywords(rec)
        if dry:
            stats["new"] += 1
            if stats["new"] <= 5:
                print(f"--- [DRY] uj kontakt ---\n{content}\nkeywords: {keywords}\n")
        else:
            ok, resp = post_memory(token, content, keywords)
            if ok:
                stats["new"] += 1
            else:
                stats["fail"] += 1
                print(f"FAIL {rec['name']}: {resp}", file=sys.stderr)
        if em:
            seen_in_run.add(em)
        seen_in_run.add(nk)

    print("\n=== Osszegzes ===")
    print(f"CSV sorok:        {len(rows)}")
    print(f"Uj kontakt:       {stats['new']}")
    print(f"Dup (email):      {stats['dup_email']}")
    print(f"Dup (nev):        {stats['dup_name']}")
    print(f"Nev nelkul:       {stats['noname']}")
    print(f"Hiba:             {stats['fail']}")
    if dry:
        print("\n(DRY RUN -- semmi nem lett mentve. Futtasd --dry-run nelkul az importhoz.)")


if __name__ == "__main__":
    main()
