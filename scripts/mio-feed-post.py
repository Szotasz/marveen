#!/usr/bin/env python3
"""marveen.io FEED-POSZT bekuldese -- a mio-feed-comment.py szerkezetet koveti.

Miert ilyen alakban (es nem ad-hoc fetch-csel):
a szentesitett komment-szkript doktrinaja szerint a szuksegesseget a SZERKEZET adja, nem az
igeret. Ezert itt is:
  - a HOST es a VEGPONT-ALAK be van egetve; nincs host-parameter,
  - a cim es a szoveg FAJLBOL jon, sosem parancssori argumentumbol,
  - a kapuk a kuldes FUGGVENYEI: bukas eseten a POST el sem indul,
  - a kozzetetel visszavonhatatlan, ezert explicit --confirm kell.
A sema a SAJAT doksinkbol: POST /feed/posts -> channel_id (UUID), title (3-200),
content (1-20000). Forras: https://api.marveen.io/agent/v1/docs, olvasva 2026-09-22.
"""
import json, os, re, sys, urllib.request, urllib.error

HOST = "https://api.marveen.io"      # EGYETLEN megengedett host, nem parameter
PATH = "/agent/v1/feed/posts"        # ZART vegpont-lista: egyetlen iro utvonal
CONTENT_MAX = 20000
TITLE_MIN, TITLE_MAX = 3, 200
AGENT_NEVEK = ("Marveen", "Mira", "Orsi", "Samu", "Dani", "Geri", "Boni", "Iris", "Zara",
               "Tomi", "Vera", "Jumanji", "Deeper", "Qwen")

_RAG_BASE = ("ként", "nak", "nek", "val", "vel", "ról", "ről", "ból", "ből", "ban", "ben",
             "hoz", "hez", "höz", "tól", "től", "nál", "nél", "ig", "ra", "re", "on", "en",
             "ön", "ot", "et", "at", "öt", "ok", "ek", "ök", "ak", "ja", "je", "ék", "é",
             "t", "n", "k", "m", "d", "i")
_EKEZET_LE = str.maketrans("áéíóöőúüű", "aeiooouuu")
_RAGOK = sorted({r for b in _RAG_BASE for r in (b, b.translate(_EKEZET_LE))},
                key=len, reverse=True)
_RAG_ALT = "|".join(re.escape(r) for r in _RAGOK)

def _nev_minta(n: str) -> str:
    tove = n + ("t" if n[-1] in "ae" else "")
    return rf"\b(?:{re.escape(n)}|{re.escape(tove)})(?:{_RAG_ALT})?\b"

def gates(title: str, text: str) -> list:
    bad = []
    egyben = title + "\n" + text
    for ch in ("—", "–", "―"):
        if ch in egyben:
            bad.append(f"gondolatjel (U+{ord(ch):04X})")
    for ent in ("&mdash;", "&ndash;", "&#8212;", "&#8211;"):
        if ent in egyben:
            bad.append(f"gondolatjel-entitas ({ent})")
    ek = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ")
    idegen = sorted({c for c in egyben if ord(c) > 127 and c not in ek})
    if idegen:
        bad.append("nem-latin karakter: " + ", ".join(f"U+{ord(c):04X}" for c in idegen))
    if not (TITLE_MIN <= len(title) <= TITLE_MAX):
        bad.append(f"cim hossza {len(title)}, a megengedett {TITLE_MIN}-{TITLE_MAX}")
    if not (1 <= len(text) <= CONTENT_MAX):
        bad.append(f"torzs hossza {len(text)}, a megengedett 1-{CONTENT_MAX}")
    for n in AGENT_NEVEK:
        m = re.search(_nev_minta(n), egyben)
        if m:
            i, j = m.span()
            kornyezet = egyben[max(0, i - 30):j + 30].replace("\n", " ")
            bad.append(f"agens-nev a szovegben: {n} (talalt: {m.group(0)!r}) ... {kornyezet} ...")
    if not text.strip():
        bad.append("ures szoveg")
    return bad

def vault(key: str) -> str:
    tok = open(os.path.expanduser("~/ClaudeClaw/store/.dashboard-token")).read().strip()
    req = urllib.request.Request(f"http://localhost:3420/api/vault/{key}",
                                 headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r).get("value", "")

def main() -> int:
    if len(sys.argv) < 4:
        print("hasznalat: mio-feed-post.py <channel-uuid> <cim-fajl> <torzs-fajl> [--confirm]",
              file=sys.stderr)
        return 2
    channel_id, title_file, body_file = sys.argv[1], sys.argv[2], sys.argv[3]
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", channel_id):
        print(f"STOP: ervenytelen channel-uuid: {channel_id!r}", file=sys.stderr)
        return 2
    title = open(title_file, encoding="utf-8").read().strip()
    text = open(body_file, encoding="utf-8").read().strip()

    problems = gates(title, text)
    if problems:
        print("KAPU BUKOTT -- a bekuldes NEM indult el:", file=sys.stderr)
        for p in problems:
            print("  -", p, file=sys.stderr)
        return 1
    print(f"kapu OK (cim {len(title)}, torzs {len(text)} karakter)", file=sys.stderr)

    if "--confirm" not in sys.argv:
        print("STOP: a kozzetetel VISSZAVONHATATLAN. Add hozza a --confirm kapcsolot.",
              file=sys.stderr)
        return 3

    key = vault("MARVEEN_IO_API_KULCS")
    if not key:
        print("STOP: nincs API-kulcs a vaultban", file=sys.stderr)
        return 4
    req = urllib.request.Request(
        HOST + PATH,
        data=json.dumps({"channel_id": channel_id, "title": title, "content": text}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"HTTP {r.status}")
            print(r.read().decode()[:900])
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}")
        print(e.read().decode()[:900])
        return 5
    return 0

if __name__ == "__main__":
    sys.exit(main())
