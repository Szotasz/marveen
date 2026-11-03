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

ZIP (MIOFEEDZIP1016, gazda-keres): --attach egy .zip-et is visz, Content-Type application/zip.
A zip TARTALMAN a szoveges kapuk NEM futnak (kodfajlok, a gazda sajat README-je: merve a
2026-10-16-i motion-csomagon, a kapuk tobb jo fajlt is bukatnanak), csak a zip NEVE es a
bejegyzesek NEVEI mennek at rajtuk (ezeket a letolto latja). Helyben a szerver zip-kapujanak tukre fut, KICSOMAGOLAS NELKUL (csak a central
directory olvasasa): PK-magia, meret-plafon, legfeljebb ZIP_MAX_ENTRIES bejegyzes, a kibontott
osszmeret legfeljebb ZIP_MAX_UNCOMPRESSED, bejegyzesenkent a tomoritesi arany legfeljebb
ZIP_MAX_RATIO, nincs abszolut ut, "..", backslash, symlink vagy titkositott bejegyzes, minden
local header neve egyezik a central directory nevevel, es egyetlen end-of-central-directory
rekord van (a marveen-io zip-kapujaval iker).

KET SZUK KIVETEL (MIOFEEDMARVEEN1014, Marveen dontese): a "Marveen" TERMEKNEV a csatolmany
tartalmaban es neveben nem bukik az agens-nev kapun (egy termek-leiras kenytelen kimondani);
a cimben es a torzsben igen, valtozatlanul. A magyar idezojel (U+201E es U+201D) mindenhol
atmegy; minden mas nem-latin karakter tovabbra is bukik. Futasonkenti felulbiralo kapcsolo
SZANDEKOSAN nincs.
"""
import hashlib, json, os, re, stat, sys, urllib.request, urllib.error, uuid, zipfile

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
ZIP_EXT = ".zip"
# A szerver zip-kapujanak hatarai (marveen-io MIOFEEDZIP1016): helyben ugyanezek, hogy a rossz
# zip itt alljon meg, ne a szerver 422-je fogja meg.
ZIP_MAX_ENTRIES = 500
ZIP_MAX_UNCOMPRESSED = 20 * 1024 * 1024  # 20 MiB, a szerver DEFAULT_ZIP_LIMITS-ével azonosan
ZIP_MAX_RATIO = 100
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

def zip_gates(data: bytes) -> list:
    """A zip szerkezete, kicsomagolas nelkul: csak a central directory-t olvassuk."""
    if data[:4] != b"PK\x03\x04":
        return ["a csatolmany nem zip (hianyzik a PK-fejlec)"]
    import io
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        infos = zf.infolist()
    except (zipfile.BadZipFile, ValueError, NotImplementedError) as e:
        # NotImplementedError: a bejegyzes extract_version-je a zipfile altal tamogatott folott.
        return [f"a zip nem olvashato: {e}"]
    bad = []
    if len(infos) > ZIP_MAX_ENTRIES:
        bad.append(f"a zipben {len(infos)} bejegyzes van, a plafon {ZIP_MAX_ENTRIES}")
    total = sum(i.file_size for i in infos)
    if total > ZIP_MAX_UNCOMPRESSED:
        bad.append(f"a zip kibontva {total} bajt, a plafon {ZIP_MAX_UNCOMPRESSED}")
    # Az end-of-central-directory rekord: a szerver inspectZip-jevel azonosan PONTOSAN EGY olyan
    # rekord lehet, amelynek a kommentje a fajl vegen er veget. Kettő ilyen (egy rekord a valodi
    # kommentjeben) ketertelmu; egy sem (bajtok a rekord utan) olvashatatlan. Egy beagyazott,
    # tarolt zip szignaturaja a fajl belsejeben ezt nem erinti.
    lo = max(0, len(data) - 22 - 0xFFFF)
    vegen = [q for q in range(lo, len(data) - 21)
             if data[q:q + 4] == b"PK\x05\x06"
             and q + 22 + int.from_bytes(data[q + 20:q + 22], "little") == len(data)]
    if len(vegen) != 1:
        bad.append("a zip end-of-central-directory rekordja nem egyertelmu a fajl vegen")
    else:
        # A central directory kozvetlenul az end-rekord elott er veget. A zipfile egy elefuzott
        # masik zip (vagy barmi elotag) miatt eltolja az offseteket, es igy is olvas; a szerver
        # az eltolast nem vegzi el, es zip_unreadable-lel elutasit. A ZIP64-jelzo (0xffffffff)
        # is itt bukik el, a szerver azt sem fogadja. Az Info-ZIP stdin-bol csomagolva a konyvtar es
        # az end-rekord koze ZIP64 end-rekordot + lokatort ir, a sima mezokben a valodi ertekekkel;
        # ilyenkor a konyvtar a ZIP64 end-rekord elott er veget.
        q = vegen[0]
        cd_size = int.from_bytes(data[q + 12:q + 16], "little")
        cd_offset = int.from_bytes(data[q + 16:q + 20], "little")
        vege = q
        if q >= 20 and data[q - 20:q - 16] == b"PK\x06\x07":
            z64 = int.from_bytes(data[q - 12:q - 4], "little")
            if data[z64:z64 + 4] == b"PK\x06\x06":
                vege = z64
        if cd_offset + cd_size != vege:
            bad.append("a zip central directory-ja nem kozvetlenul az end-rekord elott er veget")
    for i in infos:
        # Bejegyzesenkenti arany, a szerver kapujaval azonosan: az archivum-szintu arany a
        # bejegyzesek sulyozott atlaga, sosem nagyobb a legnagyobbnal.
        if i.file_size > ZIP_MAX_RATIO * max(i.compress_size, 1):
            bad.append(f"a {i.filename!r} bejegyzes tomoritesi aranya a plafon ({ZIP_MAX_RATIO}x) folott")
        # A local header neve egyezzen a central directory nevevel: egy streamelo kicsomagolo
        # a local headert olvassa, nem a konyvtarat.
        h = i.header_offset
        if data[h:h + 4] != b"PK\x03\x04":
            bad.append(f"a {i.filename!r} bejegyzes local headere hianyzik")
        else:
            nl = int.from_bytes(data[h + 26:h + 28], "little")
            lflags = int.from_bytes(data[h + 6:h + 8], "little")
            raw = data[h + 30:h + 30 + nl]
            lname = raw.decode("utf-8" if lflags & 0x800 else "cp437", errors="replace")
            if lname != i.orig_filename:
                bad.append(f"a {i.filename!r} bejegyzes local headere mas nevet visel: {lname!r}")
            if lflags & 0x1:
                bad.append(f"titkositott bejegyzes a zipben: {i.filename!r}")
        # A TELJES nev: a zipfile a .filename-t a NUL-nal levagja, az orig_filename nem.
        n = i.orig_filename
        if not n:
            bad.append("ures bejegyzes-nev a zipben")
        if "\x00" in n:
            bad.append(f"NUL a bejegyzes neveben: {n!r}")
        rawname = n.encode("utf-8" if i.flag_bits & 0x800 else "cp437", errors="replace")
        try:
            rawname.decode("utf-8")
        except UnicodeDecodeError:
            bad.append(f"a bejegyzes neve nem UTF-8: {n!r}")
        if n.startswith("/") or re.match(r"^[A-Za-z]:", n) or "\\" in n or ".." in n.split("/"):
            bad.append(f"tiltott ut a zipben: {n!r}")
        if stat.S_ISLNK(i.external_attr >> 16):
            bad.append(f"symlink a zipben: {n!r}")
        if i.flag_bits & 0x1:
            bad.append(f"titkositott bejegyzes a zipben: {n!r}")
    return bad

def attachment_gates(path: str):
    """(nev, bajtok, hibak). Az .md neve es tartalma is nyilvanos, ezert mindketto a tartalmi
    kapukon megy at; hossz-kapu nincs, a meret-plafon a bajtokra vonatkozik. A .zip-nel a NEV
    megy at a tartalmi kapukon, a tartalom a szerkezeti kapun (zip_gates)."""
    name = os.path.basename(path)
    is_zip = name.lower().endswith(ZIP_EXT)
    if not (name.lower().endswith(ATTACH_EXT) or is_zip):
        return name, b"", [f"csak {ATTACH_EXT} vagy {ZIP_EXT} fajl csatolhato: {name!r}"]
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
    if is_zip:
        # A zip NEVE es a bejegyzesek NEVEI nyilvanosak (a letolto latja oket), ezert a szoveges
        # kapukon mennek at; a bejegyzesek TARTALMA nem (lasd a modul-docstringet).
        zprobs = zip_gates(data)
        nevek = name
        if not zprobs:
            import io
            nevek = name + "\n" + "\n".join(i.orig_filename for i in zipfile.ZipFile(io.BytesIO(data)).infolist())
        return name, data, [f"csatolmany: {p}" for p in zprobs
                            + _jel_kapuk(nevek) + _nev_kapuk(nevek, ATTACH_NEV_KIVETEL)]
    try:
        tartalom = data.decode("utf-8")
    except UnicodeDecodeError:
        return name, data, ["a csatolmany nem ervenyes UTF-8 szoveg"]
    egyben = name + "\n" + tartalom
    return name, data, [f"csatolmany: {p}" for p in _jel_kapuk(egyben) + _nev_kapuk(egyben, ATTACH_NEV_KIVETEL)]

def attach_content_type(file_name: str) -> str:
    return "application/zip" if file_name.lower().endswith(ZIP_EXT) else "text/markdown"

def multipart(fields: list, file_name: str, file_bytes: bytes):
    """(torzs, content-type) a #312-es alakhoz: szoveges mezok + EGY "file" resz."""
    boundary = "----mio-feed-post-" + uuid.uuid4().hex
    parts = []
    for k, v in fields:
        parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                      ).encode() + v.encode("utf-8") + b"\r\n")
    parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                  f"filename=\"{file_name}\"\r\nContent-Type: {attach_content_type(file_name)}\r\n\r\n").encode("utf-8")
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
            print("hasznalat: --attach <fajl.md|fajl.zip>", file=sys.stderr)
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
