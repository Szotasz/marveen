#!/usr/bin/env python3
"""Route-halmaz drift-mero: QuantumAE [Route(...)] attributumok  <->  JokerQ-SDK mockoon.

MIERT: a mockoon/validate_mockoon.py 2651 ellenorzest futtat ALL GREEN eredmennyel, de a
valasz-BODY alakjat ellenorzi, nem a ROUTE-HALMAZ teljesseget -- es az igazsag-forrasa
markdown doksi, nem a forraskod. Ez a mero a HIANYZO oldalt adja: a ket halmaz osszevetese,
a QuantumAE attributumaibol mint igazsag-forrasbol.

A KARTYA (mockroutekapu) NEGY KIKOTESE, MIND BEEPITVE:
  1. a parser mintaja maga is mintavetel -> az onteszt tartalmazza a NYERS `[Route` szamlalast is,
     es osszeveti a felismertek szamaval; a kulonbseget TETELESEN kiirja (nem csak a szamot).
  2. a mockoon regex-endpointjait normalizalni kell (a `[^/]` karakterosztaly maga tartalmaz "/"-t).
  3. HAROM listat kell adni, nem csak a hibat: mindkettoben / csak mock / csak valosag.
  4. a DEBUG-only utakat ne szamolja a hianyba.

ES EGY OTODIK, a flotta mai tapasztalatabol: minden NULLA-alapu ellen-proba melle kell egy
POZITIV ag UGYANABBOL a futasbol -- kulonben a "nem talaltam" es a "el sem indultam" megkulon-
boztethetetlen.

A FORRAS A COMMIT, NEM A MUNKAFA: `git grep`/`git show` HEAD-rol olvas.

Hasznalat:
  python3 route_drift.py                 # a harom lista + onteszt
  python3 route_drift.py --self-test     # csak az onteszt (bukas-eloallitassal)
"""

import json
import re
import subprocess
import sys

import os
# A ket repo utvonala kornyezeti valtozoval felulbirhato -- a kapu a CI-ben mas
# gyokerbol fut, mint a fejlesztoi gepen. Alapertelmezes: a szokasos munkahely.
QAE_REPO = os.environ.get("QAE_REPO", "/Users/ceo/Source/github.com/QCassa.com/QuantumAE")
SDK_REPO = os.environ.get("SDK_REPO", "/Users/ceo/Source/github.com/QCassa.com/JokerQ-SDK")
MOCK_FILES = ["mockoon/hu/JokerQ-API.json", "mockoon/en/JokerQ-API.json"]

# A prefix az OSOSZTALYTOL fugg -- TApiServerHostedService.ScanPublicRoutes hivasaibol merve:
#   ScanPublicRoutes(typeof(TQaeWebservice),  "/api/v1",  routes);
#   ScanPublicRoutes(typeof(TMhmiWebservice), "/mhmi/v1", routes);
BASE_PREFIX = {"TQaeWebservice": "/api/v1", "TMhmiWebservice": "/mhmi/v1"}

# Ami nem eles felulet: teszt- es sandbox-fak.
EXCLUDE_PATH = re.compile(r"(^|/)(tests?|sandbox)/", re.I)

RE_ROUTE_ANY = re.compile(r"\[Route\(")
RE_ROUTE_CLASS = re.compile(r'\[Route\(\s*"([^"]*)"\s*\)\s*\]')
RE_ROUTE_METHOD = re.compile(
    r'\[Route\(\s*"([A-Z]+)"\s*,\s*"([^"]*)"\s*(,[^\]]*)?\)\s*\]'
)
RE_CLASS_DECL = re.compile(r"\bclass\s+(\w+)\s*:\s*([\w<>, ]+)")
RE_ABSOLUTE = re.compile(r"IsAbsolutePath\s*=\s*true", re.I)


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, text=True, check=False
    ).stdout


def cs_files_from_commit():
    """A commitban levo azon .cs fajlok, amelyekben van [Route( ."""
    out = git(QAE_REPO, "grep", "-l", "--fixed-strings", "[Route(", "HEAD", "--", "*.cs")
    files = []
    for line in out.splitlines():
        # alak: "HEAD:src/.../TFoo.cs"
        if ":" not in line:
            continue
        path = line.split(":", 1)[1]
        files.append(path)
    return files


def parse_routes():
    """Vissza: (routes, stats). routes = {(IGE, ut)}; stats a parser onmegfigyelese."""
    routes = set()
    stats = {"files": 0, "raw_route_attrs": 0, "class_routes": 0, "method_routes": 0,
             "absolute": 0, "skipped_no_base": 0, "excluded_files": 0}
    unmatched = []

    for path in cs_files_from_commit():
        if EXCLUDE_PATH.search(path):
            stats["excluded_files"] += 1
            continue
        src = git(QAE_REPO, "show", f"HEAD:{path}")
        if not src:
            continue
        stats["files"] += 1
        lines = src.splitlines()
        stats["raw_route_attrs"] += sum(1 for l in lines if RE_ROUTE_ANY.search(l))

        class_path = ""
        prefix = None
        pending_class_route = None

        for line in lines:
            m_cls_route = RE_ROUTE_CLASS.search(line)
            m_method = RE_ROUTE_METHOD.search(line)
            m_class = RE_CLASS_DECL.search(line)

            # Osztaly-szintu route: EGY argumentum, ige nelkul -> a kovetkezo class-deklaracioe.
            if m_cls_route and not m_method:
                pending_class_route = m_cls_route.group(1)
                stats["class_routes"] += 1
                continue

            if m_class:
                bases = [b.strip() for b in m_class.group(2).split(",")]
                prefix = next((BASE_PREFIX[b] for b in bases if b in BASE_PREFIX), None)
                class_path = pending_class_route or ""
                pending_class_route = None
                continue

            if m_method:
                stats["method_routes"] += 1
                verb, mpath, tail = m_method.group(1), m_method.group(2), m_method.group(3) or ""
                if RE_ABSOLUTE.search(tail):
                    stats["absolute"] += 1
                    full = mpath
                else:
                    if prefix is None:
                        # Nem TQae/TMhmi leszarmazott -> nem eles felulet, de JELEZZUK.
                        stats["skipped_no_base"] += 1
                        continue
                    full = f"{prefix}{class_path}{mpath}"
                routes.add((verb.upper(), normalize(full)))
                continue

            if RE_ROUTE_ANY.search(line):
                unmatched.append((path, line.strip()))

    stats["unmatched"] = unmatched
    return routes, stats


def normalize(path):
    """Osszevetheto alak: vezeto perjel, nincs zaro perjel, a parameterek egysegesitve."""
    if not path.startswith("/"):
        path = "/" + path
    # A mockoon regex-endpointjai (`:id([^/]+)` es tarsai) es a C# `:Id` / `:Id*` alakok
    # ugyanarra a helyorzore vezetnek. A KARAKTEROSZTALY MAGA TARTALMAZ "/"-t, ezert
    # a zarojeles reszt ELOBB dobjuk el, es csak utana vagunk szegmensre.
    path = re.sub(r"\(([^()]|\([^()]*\))*\)", "", path)   # (...) blokkok, egy szint beagyazassal
    segs = []
    for seg in path.split("/"):
        if not seg:
            continue
        if seg.startswith(":") or (seg.startswith("{") and seg.endswith("}")):
            segs.append(":param")
        else:
            segs.append(seg.rstrip("*").lower())
    return "/" + "/".join(segs)


def parse_mock():
    routes = set()
    stats = {"files": 0, "raw": 0}
    for rel in MOCK_FILES:
        raw = git(SDK_REPO, "show", f"HEAD:{rel}")
        if not raw:
            continue
        stats["files"] += 1
        data = json.loads(raw)
        for r in data.get("routes", []):
            if r.get("type") not in (None, "http"):
                continue
            ep = r.get("endpoint")
            method = (r.get("method") or "").upper()
            if ep is None or not method:
                continue
            stats["raw"] += 1
            routes.add((method, normalize(ep)))
    return routes, stats


def is_debug(path):
    return path.startswith("/debug/") or "/debug/" in path


# A "csak a mockban" irany NEM egyszeru hiba: a mock SZANDEKOSAN hirdet olyan utakat, amiknek
# nincs valosag-parjuk (szimulator-vegpontok a hibaagak probaltatasara, doku-felulet). Merve
# 2026-08-14: 56 ilyen tetelbol 55 szandekos volt.
# A LISTA SZuK ES NEVESITETT, SZANDEKOSAN. Egy altalanos "ismert elteresek" lista csendben
# elnyelne a valodi drifteket is -- ezert nincs joker es nincs gyujto-minta.
# ES MERHETo: minden minta melle kiirjuk, HANY tetelt fed. A nulla fedesu minta AVULT -> kikerul.
MOCK_ONLY_PREFIXES = (
    "/api/v1/sim",      # szimulator-vegpontok (hibaagak probaltatasa)
    "/api/docs",        # OpenAPI-doku felulet
    "/sdk-guide",
    "/sdk-generators",
    "/docs",
)


def split_mock_only(only_mock):
    """Bontja a 'csak a mockban' halmazt szandekosra es VALODI driftre, es meri a minta-fedest."""
    coverage = {p: 0 for p in MOCK_ONLY_PREFIXES}
    intended, drift = [], []
    for verb, path in only_mock:
        hit = next((p for p in MOCK_ONLY_PREFIXES if path == p or path.startswith(p + "/")), None)
        if hit:
            coverage[hit] += 1
            intended.append((verb, path))
        else:
            drift.append((verb, path))
    return intended, drift, coverage


def report():
    real, rstats = parse_routes()
    mock, mstats = parse_mock()

    # POZITIV AG: jott-e egyaltalan kimenet? Nulla melle ez a bizonyitek.
    print("=== A MERES HATOKORE (a nulla-allitasok bizonyiteka) ===")
    print(f"  QuantumAE: {rstats['files']} fajl olvasva a COMMITBOL "
          f"({rstats['excluded_files']} teszt/sandbox kihagyva)")
    print(f"  nyers [Route( elofordulas: {rstats['raw_route_attrs']}  ->  "
          f"felismert: osztaly-szintu {rstats['class_routes']}, metodus-szintu {rstats['method_routes']}")
    print(f"  ebbol abszolut ut (IsAbsolutePath): {rstats['absolute']}, "
          f"ismeretlen ososztaly miatt kihagyva: {rstats['skipped_no_base']}")
    print(f"  mockoon: {mstats['files']} fajl, {mstats['raw']} route-bejegyzes")
    print(f"  OSSZEVETHETo HALMAZ: valosag {len(real)}, mock {len(mock)}")

    if rstats["unmatched"]:
        print(f"\n  !! {len(rstats['unmatched'])} [Route sor EGYIK mintara sem illett -- "
              f"a parser vak lehet ra:")
        for p, l in rstats["unmatched"][:10]:
            print(f"     {p}: {l}")

    if not real or not mock:
        print("\n!! A HALMAZOK EGYIKE URES -- a kovetkezo listak NEM ertelmezhetok. "
              "Elobb a bejarast kell javitani, nem a driftet olvasni.")
        return 2

    both = sorted(real & mock)
    only_real = sorted(real - mock)
    only_mock = sorted(mock - real)
    only_real_nondebug = [r for r in only_real if not is_debug(r[1])]
    only_real_debug = [r for r in only_real if is_debug(r[1])]

    print(f"\n=== 1. MINDKETToBEN ({len(both)}) ===")
    print(f"\n=== 2. CSAK A VALOSAGBAN -- a mock KEVESEBBET fed ({len(only_real_nondebug)} "
          f"+ {len(only_real_debug)} debug, ami NEM szamit hianynak) ===")
    for verb, p in only_real_nondebug:
        print(f"  {verb:6} {p}")
    if only_real_debug:
        print("  -- debug-only (kihagyva a hianybol):")
        for verb, p in only_real_debug:
            print(f"     {verb:6} {p}")

    intended, drift, coverage = split_mock_only(only_mock)

    print(f"\n=== 3. CSAK A MOCKBAN ({len(only_mock)}) -- ebbol SZANDEKOS {len(intended)}, "
          f"VALODI DRIFT {len(drift)} ===")
    for verb, p in drift:
        print(f"  {verb:6} {p}")
    if not drift:
        print("  (nincs)")

    print("\n  -- szandekos, mock-only csaladok (a kivetel-szabaly fedese) --")
    for pattern, n in coverage.items():
        mark = "  !! NULLA TETEL -- a minta AVULT, kiveendo" if n == 0 else ""
        print(f"     {pattern:24} {n:3} tetel{mark}")

    return 1 if (only_real_nondebug or drift) else 0


def self_test():
    rc = 0
    # 1. POZITIV: a normalizalas a ket oldal eltero alakjait EGY alakra hozza.
    cases = [
        ("api/docs", "/api/docs"),
        ("/api/v1/user/:Id", "/api/v1/user/:param"),
        ("/api/v1/user/:id([^/]+)", "/api/v1/user/:param"),
        ("/api/v1/document/:DocumentId*", "/api/v1/document/:param"),
        ("/api/v1/User/", "/api/v1/user"),
    ]
    for src, want in cases:
        got = normalize(src)
        if got != want:
            print(f"BUKIK 1: normalize({src!r}) = {got!r}, varva {want!r}")
            rc = 1

    # 2. NEGATIV + POZITIV AG EGYUTT: a commit-olvasas ad-e egyaltalan fajlt?
    files = cs_files_from_commit()
    if not files:
        print("BUKIK 2: a commit-olvasas NULLA fajlt adott -- a mero el sem indult "
              "(ez NEM ugyanaz, mint hogy nincs [Route a repoban)")
        rc = 1
    else:
        print(f"  pozitiv ag: a commit-olvasas {len(files)} fajlt adott -- a bejaras fut")

    # 2/b. A KIVETEL-SZABALY MERHEToSEGE: egy nulla tetelt fedo minta AVULT, es ezt ki kell irni.
    #      Bukas-eloallitassal igazolva, nem feltetelezessel.
    fake = [("GET", "/api/v1/sim/x"), ("GET", "/api/v1/qr/documents")]
    intended, drift, cov = split_mock_only(fake)
    if [d[1] for d in drift] != ["/api/v1/qr/documents"]:
        print(f"BUKIK 2/b: a valodi drift rosszul valt szet: {drift}")
        rc = 1
    if cov.get("/api/v1/sim") != 1:
        print(f"BUKIK 2/b: a sim-minta fedese {cov.get('/api/v1/sim')}, varva 1")
        rc = 1
    if cov.get("/sdk-guide") != 0:
        print(f"BUKIK 2/b: a nem hasznalt minta fedese nem nulla ({cov.get('/sdk-guide')})")
        rc = 1
    # a prefix-egyezes NE fogjon meg egy hasonlo kezdetu, de MAS utat
    if split_mock_only([("GET", "/api/v1/simulation")])[1] == []:
        print("BUKIK 2/b: a '/api/v1/simulation' tevesen szandekosnak minosult")
        rc = 1

    # 3. A PARSER ONMEGFIGYELESE: a felismertek szama ne legyen ellentmondasos a nyerssel.
    real, st = parse_routes()
    recognized = st["class_routes"] + st["method_routes"]
    if st["raw_route_attrs"] and recognized > st["raw_route_attrs"]:
        print(f"BUKIK 3: tobb felismert ({recognized}) mint nyers ({st['raw_route_attrs']})")
        rc = 1
    elif st["raw_route_attrs"] == 0:
        print("BUKIK 3: nulla nyers [Route a commitban -- a poziciv kontroll bukott")
        rc = 1
    else:
        print(f"  pozitiv ag: nyers {st['raw_route_attrs']}, felismert {recognized}, "
              f"eredmeny-halmaz {len(real)}")

    print("ONTESZT OK" if rc == 0 else "ONTESZT BUKOTT")
    return rc


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else report())
