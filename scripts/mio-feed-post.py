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

CSATOLMANY (MIOFEEDATTACH1014): --attach <fajl> egy .md fajlt kuld a poszt melle, a
marveen.io #312-es multipart alakjaban (ugyanaz a harom mezo + egy "file" resz). A fajl
TARTALMA ugyanazokon a tartalmi kapukon megy at, mint a torzs (gondolatjel, nem-latin
karakter, agens-nev), mert ugyanugy nyilvanos; a hossz-kapu ra nem vonatkozik. A rossz
fajl HELYBEN all meg (kiterjesztes, meret, UTF-8, ures), nem a szerver 413/415-je fogja meg.
Csatolmany nelkul a kuldes BAJTRA a regi JSON-keres (scripts/__tests__/mio-feed-post.test.py).

KET SZUK KIVETEL (MIOFEEDMARVEEN1014, Marveen dontese): a "Marveen" TERMEKNEV a csatolmany
tartalmaban es neveben nem bukik az agens-nev kapun (egy termek-leiras kenytelen kimondani);
a cimben es a torzsben igen, valtozatlanul. A magyar idezojel (U+201E es U+201D) mindenhol
atmegy; minden mas nem-latin karakter tovabbra is bukik. Futasonkenti felulbiralo kapcsolo
SZANDEKOSAN nincs.
"""
import hashlib, json, os, re, sys, urllib.request, urllib.error, uuid

HOST = "https://api.marveen.io"      # EGYETLEN megengedett host, nem parameter
PATH = "/agent/v1/feed/posts"        # ZART vegpont-lista: egyetlen iro utvonal
CONTENT_MAX = 20000
TITLE_MIN, TITLE_MAX = 3, 200
# A csatolmany felso hatara a szerver alapertelmezese: marveen-io main,
# supabase/functions/_shared/md-upload-gate.ts uploadLimits(), maxBytes =
# envInt('MAX_WEB_UPLOAD_BYTES', 1_000_000); a /docs "Csatolmany" szakasza ugyanezt
# irja ("alapertelmezesben legfeljebb 1 000 000 bajt"). Olvasva 2026-10-14, d077eb3a.
# Ha az eles kornyezet a MAX_WEB_UPLOAD_BYTES-t ennel kisebbre allitja, a szerver
# 413 file_too_large-dzsel tovabbra is megfogja; ez itt elo-ellenorzes.
ATTACH_MAX_BYTES = 1_000_000
ATTACH_EXT = ".md"
# A csatolmany nev-kapujabol kivett nevek (lasd a modul-docstringet). Csak itt, csak ez.
ATTACH_NEV_KIVETEL = ("Marveen",)
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

def _jel_kapuk(egyben: str) -> list:
    bad = []
    for ch in ("—", "–", "―"):
        if ch in egyben:
            bad.append(f"gondolatjel (U+{ord(ch):04X})")
    for ent in ("&mdash;", "&ndash;", "&#8212;", "&#8211;"):
        if ent in egyben:
            bad.append(f"gondolatjel-entitas ({ent})")
    ek = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ\u201e\u201d")  # + a magyar idezojel-par
    idegen = sorted({c for c in egyben if ord(c) > 127 and c not in ek})
    if idegen:
        bad.append("nem-latin karakter: " + ", ".join(f"U+{ord(c):04X}" for c in idegen))
    return bad

def _nev_kapuk(egyben: str, kivetel: tuple = ()) -> list:
    bad = []
    for n in AGENT_NEVEK:
        if n in kivetel:
            continue
        m = re.search(_nev_minta(n), egyben)
        if m:
            i, j = m.span()
            kornyezet = egyben[max(0, i - 30):j + 30].replace("\n", " ")
            bad.append(f"agens-nev a szovegben: {n} (talalt: {m.group(0)!r}) ... {kornyezet} ...")
    return bad

def gates(title: str, text: str) -> list:
    egyben = title + "\n" + text
    bad = _jel_kapuk(egyben)
    if not (TITLE_MIN <= len(title) <= TITLE_MAX):
        bad.append(f"cim hossza {len(title)}, a megengedett {TITLE_MIN}-{TITLE_MAX}")
    if not (1 <= len(text) <= CONTENT_MAX):
        bad.append(f"torzs hossza {len(text)}, a megengedett 1-{CONTENT_MAX}")
    bad += _nev_kapuk(egyben)
    if not text.strip():
        bad.append("ures szoveg")
    return bad

def attachment_gates(path: str):
    """(nev, bajtok, hibak). A nev es a tartalom is nyilvanos, ezert mindketto a tartalmi
    kapukon megy at; hossz-kapu nincs, a meret-plafon a bajtokra vonatkozik."""
    name = os.path.basename(path)
    if not name.lower().endswith(ATTACH_EXT):
        return name, b"", [f"csak {ATTACH_EXT} fajl csatolhato: {name!r}"]
    if any(c in name for c in '"\r\n'):
        return name, b"", [f"a fajlnevben idezojel vagy sortores all: {name!r}"]
    try:
        data = open(path, "rb").read()
    except OSError as e:
        return name, b"", [f"a csatolmany nem olvashato: {e.strerror}"]
    if len(data) > ATTACH_MAX_BYTES:
        return name, data, [f"csatolmany merete {len(data)} bajt, a plafon {ATTACH_MAX_BYTES}"]
    if not data.strip():
        return name, data, ["ures csatolmany"]
    try:
        tartalom = data.decode("utf-8")
    except UnicodeDecodeError:
        return name, data, ["a csatolmany nem ervenyes UTF-8 szoveg"]
    egyben = name + "\n" + tartalom
    return name, data, [f"csatolmany: {p}" for p in _jel_kapuk(egyben) + _nev_kapuk(egyben, ATTACH_NEV_KIVETEL)]

def multipart(fields: list, file_name: str, file_bytes: bytes):
    """(torzs, content-type) a #312-es alakhoz: szoveges mezok + EGY "file" resz."""
    boundary = "----mio-feed-post-" + uuid.uuid4().hex
    parts = []
    for k, v in fields:
        parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                      ).encode() + v.encode("utf-8") + b"\r\n")
    parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                  f"filename=\"{file_name}\"\r\nContent-Type: text/markdown\r\n\r\n").encode("utf-8")
                 + file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"

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
    attach = None
    if "--attach" in sys.argv[4:]:
        i = sys.argv.index("--attach", 4)
        if i + 1 >= len(sys.argv) or sys.argv[i + 1].startswith("--"):
            print("hasznalat: --attach <fajl.md>", file=sys.stderr)
            return 2
        attach = sys.argv[i + 1]
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

    if attach is not None:
        file_name, file_bytes, aproblems = attachment_gates(attach)
        if aproblems:
            print("CSATOLMANY-KAPU BUKOTT -- a bekuldes NEM indult el:", file=sys.stderr)
            for p in aproblems:
                print("  -", p, file=sys.stderr)
            return 1
        print(f"csatolmany OK: {file_name}, {len(file_bytes)} bajt, "
              f"sha256 {hashlib.sha256(file_bytes).hexdigest()}", file=sys.stderr)

    if "--confirm" not in sys.argv:
        print("STOP: a kozzetetel VISSZAVONHATATLAN. Add hozza a --confirm kapcsolot.",
              file=sys.stderr)
        return 3

    key = vault("MARVEEN_IO_API_KULCS")
    if not key:
        print("STOP: nincs API-kulcs a vaultban", file=sys.stderr)
        return 4
    if attach is None:
        req = urllib.request.Request(
            HOST + PATH,
            data=json.dumps({"channel_id": channel_id, "title": title, "content": text}).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST")
    else:
        body, ctype = multipart([("channel_id", channel_id), ("title", title), ("content", text)],
                                file_name, file_bytes)
        req = urllib.request.Request(
            HOST + PATH, data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": ctype},
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
