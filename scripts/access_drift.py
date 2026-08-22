#!/usr/bin/env python3
"""HOZZAFERES-drift: a valosagban session-kotelezo utak <-> a mockban session nelkul elerhetok.

MIERT KULON MEROBEN: a route_drift.py azt meri, MELY utak leteznek. Ez azt, hogy MILYEN
FELTETELLEL erhetok el. Ha egy ut a valosagban session-t ker, a mockban meg publikus, az
integrator ROSSZ FELTEVESSEL fejleszt zoldre -- es a 200-as valasz meg meg is erositi benne.

A KET OLDAL MERoSZAMA:
  valosag: a `[PublicEndpoint]` attributum (PublicEndpointAttribute.cs: "session validáció
           nélkül elérhető"). Ami NEM publikus, az session-kotelezo.
  mock:    a route-hoz tartozik-e 401/403 valasz. A mockoon ezt `rules`-szal koti a
           `Session-Id` fejlechez (merve: 63 route-nak van ilyen a 133-bol).

🛑 EGY BUKTATO, AMI MIATT A NYERS SZAMLALAS HAROMSZOROS HIBAT AD:
   a `[PublicEndpoint]` a forrasban 35-szor fordul elo, de ebbol 23 KOMMENTBEN all
   (a doksi-blokkok idezik, tobbnyire azt allitva, hogy az adott vegpont NEM publikus).
   VALODI attributum csak 12. Ez a mero ezert CSAK az onallo attributum-sort fogadja el,
   es az onteszt ezt a ket szamot KULON kiirja.
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
MOCK_FILE = "mockoon/hu/JokerQ-API.json"

BASE_PREFIX = {"TQaeWebservice": "/api/v1", "TMhmiWebservice": "/mhmi/v1"}
EXCLUDE_PATH = re.compile(r"(^|/)(tests?|sandbox)/", re.I)

RE_ROUTE_METHOD = re.compile(r'\[Route\(\s*"([A-Z]+)"\s*,\s*"([^"]*)"\s*(,[^\]]*)?\)\s*\]')
RE_ROUTE_CLASS = re.compile(r'\[Route\(\s*"([^"]*)"\s*\)\s*\]')
RE_CLASS_DECL = re.compile(r"\bclass\s+(\w+)\s*:\s*([\w<>, ]+)")
RE_ABSOLUTE = re.compile(r"IsAbsolutePath\s*=\s*true", re.I)
# CSAK az onallo attributum-sor szamit -- a kommentbeli emlites NEM.
RE_PUBLIC_ATTR = re.compile(r"^\s*\[PublicEndpoint\]\s*$")
RE_PUBLIC_ANY = re.compile(r"\[PublicEndpoint")


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True,
                          check=False).stdout


def normalize(path):
    if not path.startswith("/"):
        path = "/" + path
    path = re.sub(r"\(([^()]|\([^()]*\))*\)", "", path)
    segs = []
    for seg in path.split("/"):
        if not seg:
            continue
        segs.append(":param" if seg.startswith(":") or (seg.startswith("{") and seg.endswith("}"))
                    else seg.rstrip("*").lower())
    return "/" + "/".join(segs)


def parse_real():
    """Vissza: {(IGE, ut): is_public}, plusz a parser onmegfigyelese."""
    access, stats = {}, {"raw_public_any": 0, "public_attr": 0, "class_public": 0,
                         "routes": 0, "files": 0}
    out = git(QAE_REPO, "grep", "-l", "--fixed-strings", "[Route(", "HEAD", "--", "*.cs")
    for line in out.splitlines():
        if ":" not in line:
            continue
        path = line.split(":", 1)[1]
        if EXCLUDE_PATH.search(path):
            continue
        src = git(QAE_REPO, "show", f"HEAD:{path}")
        if not src:
            continue
        stats["files"] += 1
        lines = src.splitlines()
        stats["raw_public_any"] += sum(1 for l in lines if RE_PUBLIC_ANY.search(l))
        stats["public_attr"] += sum(1 for l in lines if RE_PUBLIC_ATTR.match(l))

        class_path, prefix, class_public = "", None, False
        pending_class_route, pending_public = None, False

        for i, line_txt in enumerate(lines):
            if RE_PUBLIC_ATTR.match(line_txt):
                pending_public = True
                continue

            m_cls_route = RE_ROUTE_CLASS.search(line_txt)
            m_method = RE_ROUTE_METHOD.search(line_txt)
            m_class = RE_CLASS_DECL.search(line_txt)

            if m_cls_route and not m_method:
                pending_class_route = m_cls_route.group(1)
                continue

            if m_class:
                bases = [b.strip() for b in m_class.group(2).split(",")]
                prefix = next((BASE_PREFIX[b] for b in bases if b in BASE_PREFIX), None)
                class_path = pending_class_route or ""
                class_public = pending_public
                if class_public:
                    stats["class_public"] += 1
                pending_class_route, pending_public = None, False
                continue

            if m_method:
                verb, mpath, tail = m_method.group(1), m_method.group(2), m_method.group(3) or ""
                if RE_ABSOLUTE.search(tail):
                    full = mpath
                elif prefix is None:
                    pending_public = False
                    continue
                else:
                    full = f"{prefix}{class_path}{mpath}"
                # A metodus-szintu jeloles a blokkban allhat a [Route] ELoTT vagy UTAN is,
                # ezert a kovetkezo ket sort is megnezzuk (a deklaracioig).
                near_public = pending_public or any(
                    RE_PUBLIC_ATTR.match(l) for l in lines[i + 1:i + 3]
                )
                access[(verb.upper(), normalize(full))] = class_public or near_public
                stats["routes"] += 1
                pending_public = False
    return access, stats


def parse_mock(from_worktree=False):
    """Vissza: {(IGE, ut): requires_session} -- a 401/403 valasz letezese alapjan.

    Alapertelmezesben a COMMITBOL olvas. A `--worktree` a MEG NEM COMMITOLT allapotot meri --
    ez kell a javitas ellenorzesehez es a kapu CI-beli hasznalatahoz, ahol a munkafa a targy.
    """
    if from_worktree:
        with open(f"{SDK_REPO}/{MOCK_FILE}", encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = git(SDK_REPO, "show", f"HEAD:{MOCK_FILE}")
    if not raw:
        return {}, {"routes": 0}
    data = json.loads(raw)
    out = {}
    for r in data.get("routes", []):
        method = (r.get("method") or "").upper()
        ep = r.get("endpoint")
        if not method or ep is None:
            continue
        codes = {str(x.get("statusCode")) for x in r.get("responses", [])}
        out[(method, normalize(ep))] = bool(codes & {"401", "403"})
    return out, {"routes": len(out)}


def report(from_worktree=False):
    real, rst = parse_real()
    mock, mst = parse_mock(from_worktree)

    print("=== A MERES HATOKORE ===")
    print(f"  QuantumAE: {rst['files']} fajl a commitbol, {rst['routes']} ut")
    print(f"  [PublicEndpoint] nyers elofordulas: {rst['raw_public_any']}  ->  "
          f"VALODI attributum-sor: {rst['public_attr']}  "
          f"(a kulonbseg KOMMENT, es tobbnyire azt allitja, hogy NEM publikus)")
    print(f"  ebbol osztaly-szintu jeloles: {rst['class_public']}")
    print(f"  mockoon: {mst['routes']} ut" + ("  [MUNKAFA, nem commit]" if from_worktree else ""))

    common = sorted(set(real) & set(mock))
    print(f"  MINDKET oldalon meglevo ut: {len(common)}")
    if not common:
        print("!! NINCS kozos ut -- a normalizalast kell javitani, nem a driftet olvasni.")
        return 2

    real_public = [k for k in common if real[k]]
    mock_open = [k for k in common if not mock[k]]

    danger = [k for k in common if not real[k] and not mock[k]]
    strict = [k for k in common if real[k] and mock[k]]

    print(f"\n  valosag szerint publikus: {len(real_public)} | "
          f"mock szerint session nelkul elerheto: {len(mock_open)}")

    print(f"\n=== 1. VESZELYES IRANY -- a valosag SESSION-T KER, a mock NEM ({len(danger)}) ===")
    print("    (az integrator zoldre fejleszt, aztan az eles rendszer 401-gyel valaszol)")
    for verb, p in danger:
        print(f"  {verb:6} {p}")
    if not danger:
        print("  (nincs)")

    print(f"\n=== 2. FORDITOTT IRANY -- a mock szigorubb, mint a valosag ({len(strict)}) ===")
    for verb, p in strict:
        print(f"  {verb:6} {p}")
    if not strict:
        print("  (nincs)")

    return 1 if danger else 0


def self_test():
    rc = 0
    for src, want in [("api/docs", "/api/docs"), ("/api/v1/user/:Id", "/api/v1/user/:param")]:
        if normalize(src) != want:
            print(f"BUKIK: normalize({src!r}) = {normalize(src)!r}")
            rc = 1

    real, st = parse_real()
    if not real:
        print("BUKIK: a valosag-oldal URES -- a mero el sem indult")
        rc = 1
    else:
        print(f"  pozitiv ag: {st['routes']} ut, {st['files']} fajl a commitbol")

    # A KOMMENT-CSAPDA MERESE: a nyers szamlalas TOBB kell legyen a valodinal, kulonben
    # vagy nincs komment-emlites (gyanus), vagy a szuro nem mukodik.
    if st["raw_public_any"] <= st["public_attr"]:
        print(f"BUKIK: nyers [PublicEndpoint {st['raw_public_any']} <= valodi {st['public_attr']} "
              f"-- a komment-szuro nem szurt semmit, ellenorizni kell")
        rc = 1
    else:
        print(f"  pozitiv ag: nyers {st['raw_public_any']} -> valodi {st['public_attr']} "
              f"({st['raw_public_any'] - st['public_attr']} kommentbeli emlites kiszurve)")

    mock, mst = parse_mock()
    if not mock:
        print("BUKIK: a mock-oldal URES")
        rc = 1
    else:
        need = sum(1 for v in mock.values() if v)
        print(f"  pozitiv ag: mock {mst['routes']} ut, ebbol {need} ker session-t (401/403)")

    # BUKAS-ELoALLITAS: ha egy session-kotelezo utrol ELTuNIK a 401 a mockban, a mero
    # JELEZZE. Enelkul a "nulla drift" allitas nem bizonyithato -- ugyanugy nezne ki egy
    # helyes nulla es egy olyan mero, ami sosem talal semmit.
    if real and mock:
        probe = next((k for k in set(real) & set(mock) if not real[k] and mock[k]), None)
        if probe is None:
            print("BUKIK: nincs egyetlen session-kotelezo kozos ut sem -- a bukas-eloallitas "
                  "nem vegezheto el, tehat a nulla-allitas sem bizonyitott")
            rc = 1
        else:
            broken = dict(mock)
            broken[probe] = False          # mintha kivettuk volna a 401-et a mockbol
            danger = [k for k in set(real) & set(broken) if not real[k] and not broken[k]]
            if probe not in danger:
                print(f"BUKIK: a 401 eltavolitasa utan a mero NEM jelezte a driftet ({probe})")
                rc = 1
            else:
                print(f"  bukas-eloallitas: a 401 elvetele utan a mero jelez -- {probe[0]} {probe[1]}")

    print("ONTESZT OK" if rc == 0 else "ONTESZT BUKOTT")
    return rc


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv
             else report("--worktree" in sys.argv))
