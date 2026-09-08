#!/usr/bin/env python3
"""fleet-state -- the one page that says how this fleet is actually put together.

WHY THIS EXISTS. Balázs, 2026-09-01: *"ossze vissza epitettunk mindent es nincs egy rendszer
az egesz mogott"*. The diagnosis is right, and the 09:22 outage showed the shape of it: which
agent runs as which OS user, which profile that resolves to, where our own patches live and
whether they are pushed anywhere -- every one of those was knowledge in one head or one file,
and answering each took a separate manual measurement.

A hand-written document would answer them once and then rot. This one is GENERATED, so a
stale line is impossible: if the fleet changes, the next run says so.

USAGE
  python3 scripts/fleet-state.py            # print
  python3 scripts/fleet-state.py --write    # also write docs/FLOTTA-ALLAPOT.md

WHAT IT CANNOT SEE, and says so rather than leaving a confident blank: anything owned by an
agent's own OS user that our uid cannot read (transcripts, some configs). Those print as
`nincs jogosultsag`, never as zero -- reading a failed capture as zero is the exact mistake
that cost two hours that morning.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.environ.get("FLEET_ROOT", "/home/marveen/marveen")
DASH = "http://localhost:3420"
OUT = os.path.join(ROOT, "docs", "FLOTTA-ALLAPOT.md")


def run(cmd, timeout=20):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip()
    except Exception:
        return 1, ""


def git(*args):
    return run(["git", "-C", ROOT] + list(args))[1]


def api(path):
    try:
        tok = open(os.path.join(ROOT, "store", ".dashboard-token")).read().strip()
        req = urllib.request.Request(DASH + path, headers={"Authorization": "Bearer " + tok})
        return json.load(urllib.request.urlopen(req, timeout=10))
    except Exception:
        return None


def now():
    rc, out = run(["bash", os.path.join(ROOT, "scripts", "local-now.sh"), "full"])
    return out or time.strftime("%Y-%m-%d %H:%M:%S")


def profile_mode(pid):
    p = os.path.join(ROOT, "templates", "profiles", (pid or "") + ".json")
    if not pid:
        return "-", "-"
    if not os.path.isfile(p):
        return "HIÁNYZIK", "?"
    try:
        return "ok", json.load(open(p)).get("permissionMode") or "?"
    except Exception:
        return "olvashatatlan", "?"


def section_agents():
    L = ["## Ágensek", "",
         "Ki fut, milyen felhasználó alatt, milyen jogosultsági profillal. A felhasználó és a",
         "profil együtt dönti el, mit tud csinálni; 2026-09-01-én ez a kettő csúszott szét.",
         "",
         "| ágens | OS felhasználó | profil | profil fájl | mód | modell |",
         "|---|---|---|---|---|---|"]
    adir = os.path.join(ROOT, "agents")
    for name in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
        cfg = os.path.join(adir, name, "agent-config.json")
        if not os.path.isfile(cfg):
            continue
        try:
            d = json.load(open(cfg))
        except Exception:
            continue
        ok, mode = profile_mode(d.get("securityProfile"))
        L.append("| %s | %s | %s | %s | %s | %s |" % (
            name, d.get("runAsUser") or "marveen", d.get("securityProfile") or "-",
            ok, mode, d.get("model") or "-"))
    L += ["",
          "A `permissionMode` nem kozmetika: a `strict` profil nélkül indított ágens az",
          "engedélykérések kihagyásával fut. Ez 2026-09-01-én meg is történt, mert két profil",
          "fájl eltűnt egy frissítéssel.", ""]
    return L


def section_patches():
    L = ["## Hol laknak a saját javításaink", "",
         "Ez a szakasz azért van itt, mert 2026-09-01-én kizárólag egy fejben létezett. Egy",
         "frissítés elvitte a `runAsUser` támogatást, és óráig tartott kideríteni, hogy a",
         "javítás egy helyi ágon ül, ahová soha senki nem tolta fel.", "",
         "| ág | commit a develop felett | feltöltve a forkra |", "|---|---|---|"]
    branches = [b.strip().lstrip("* ").split()[0]
                for b in git("branch", "--format=%(refname:short)").splitlines() if b.strip()]
    for b in branches:
        if b in ("main", "master"):
            continue
        cnt = git("rev-list", "--count", "origin/develop..%s" % b) or "?"
        rc, out = run(["git", "-C", ROOT, "ls-remote", "--heads", "fork", b])
        pushed = "igen" if out.strip() else "**NEM**"
        L.append("| %s | %s | %s |" % (b, cnt, pushed))
    L += ["",
          "Ami nincs feltöltve, az egyetlen példányban létezik ezen a gépen. Egy frissítés",
          "vagy egy lemezhiba visszavonhatatlanul elviszi.", ""]
    return L


def section_repos():
    L = ["## Repók és jogosultság", "",
         "| távoli | cím | mit tudunk vele |", "|---|---|---|"]
    for line in git("remote", "-v").splitlines():
        if "(fetch)" not in line:
            continue
        parts = line.split()
        name, url = parts[0], parts[1]
        note = "sajátunk, ide tolunk" if name == "fork" else "upstream, ide csak pull request megy"
        L.append("| %s | %s | %s |" % (name, url, note))
    L += ["",
          "**A beolvasztás nem a miénk.** Balázs, 2026-09-01: a `Szotasz/marveen` repóban a",
          "tulajdonos nyomja meg a merge gombot. Ezért egy javításunk nem attól marad meg,",
          "hogy pull requestet nyitunk rá, hanem attól, hogy frissítés után visszatesszük és",
          "leellenőrizzük.", ""]
    return L


def section_services():
    L = ["## Szolgáltatások", "", "```"]
    rc, out = run(["supervisorctl", "status"])
    L.append(out if out else "supervisorctl nem elérhető")
    L += ["```", "",
          "Nincs systemd ebben a konténerben. A vezérlőpult újraindítása nem érinti a",
          "csatornákat, és fordítva; 2026-09-01-én ez a különbség mentett meg egy kiesést.", ""]
    return L


def section_tools():
    L = ["## A flotta saját eszközei", "",
         "Mindegyik egy konkrét kérdésre válaszol, és egyik sem javít semmit magától.", "",
         "| parancs | mire válaszol |", "|---|---|",
         "| `bash scripts/fleet-patch-check.sh` | benne vannak-e a saját javításaink a buildben |",
         "| `python3 scripts/fleet-snapshot.py before\\|after` | mit vett el egy frissítés |",
         "| `python3 scripts/fleet-doctor.py` | egészséges-e a hat ágens, hat szempontból |",
         "| `bash scripts/fleet-update.sh before\\|after` | a frissítés menete, kapukkal |",
         "| `python3 scripts/fleet-state.py` | ez a lap |", "",
         "Egyik sem javít. Ez tudatos: 2026-09-01-én egy csendes automatikus lépés törte el a",
         "flottát, és egy őrző, ami maga is javít, egy második ilyen lépés.", ""]
    return L


def section_autoupdate():
    """Is an UNATTENDED update armed? After 2026-09-01 this is the single most important
    yes/no on the page: the scheduler carries an `auto-update` task, but it exits early
    unless a flag is set in .env. The task existing is not the same as it being armed, and
    reading the cron line alone would answer the wrong question."""
    L = ["## Automatikus frissítés: fegyverben van-e?", ""]
    d = api("/api/schedules")
    rows = d if isinstance(d, list) else (d or {}).get("schedules", [])
    task = next((r for r in rows if r.get("name") == "auto-update"), None)
    env = os.path.join(ROOT, ".env")
    armed = False
    readable = os.path.isfile(env) and os.access(env, os.R_OK)
    if readable:
        try:
            for line in open(env, encoding="utf-8", errors="replace"):
                if line.startswith("AUTO_UPDATE_ENABLED="):
                    armed = line.split("=", 1)[1].strip().strip('"') == "1"
        except Exception:
            readable = False

    if task is None:
        L += ["Ütemezett `auto-update` feladat nincs, vagy a vezérlőpult nem válaszolt.", ""]
        return L
    L += ["Ütemezett feladat: **van**, `%s`, ágens `%s`, engedélyezve: `%s`." % (
        task.get("schedule"), task.get("agent"), task.get("enabled")), ""]
    if not readable:
        L += ["A `.env` nem olvasható innen, tehát **nem tudom megmondani**, hogy fegyverben",
              "van-e. Ez nem nem, hanem ismeretlen.", ""]
        return L
    if armed:
        L += ["**FEGYVERBEN VAN.** Az `AUTO_UPDATE_ENABLED=1` be van állítva, tehát a",
              "frissítés felügyelet nélkül lefut a fenti időpontban. 2026-09-01 után ez",
              "kockázat: aznap egy frissítés két órára megállította a flottát, és a",
              "helyreállításhoz emberi döntések kellettek.", ""]
    else:
        L += ["**Nincs fegyverben.** Az `AUTO_UPDATE_ENABLED` kulcs nincs beállítva, ezért a",
              "feladat lefut ugyan, de azonnal kilép, és nem frissít.", "",
              "Ennek a következménye, és ezért áll itt: a frissítéseket **ember indítja**.",
              "Tehát a `scripts/fleet-update.sh` menete nem elméleti, hanem az az út, amin",
              "a következő frissítés is menni fog.", ""]
    return L


def section_scheduled():
    L = ["## Ütemezett feladatok", ""]
    d = api("/api/schedules")
    rows = d if isinstance(d, list) else (d or {}).get("schedules", [])
    if not rows:
        L += ["A vezérlőpult nem válaszolt, vagy nincs ütemezett feladat. Ez **nem** azt",
              "jelenti, hogy nincs: a lekérdezés hibája is ide vezet.", ""]
        return L
    L += ["| név | ütemezés | ágens | típus |", "|---|---|---|---|"]
    for r in rows:
        L.append("| %s | `%s` | %s | %s |" % (
            r.get("name"), r.get("schedule"), r.get("agent"), r.get("type")))
    L.append("")
    return L


def build():
    L = ["# A flotta állapota", "",
         "**Generált lap. Ne szerkeszd kézzel.** Újragenerálás:",
         "`python3 scripts/fleet-state.py --write`", "",
         "Mért idő: %s" % now(), "",
         "Azért generált, mert egy kézzel írt rendszerleírás az első változásnál elavul, és",
         "onnantól magabiztosan hazudik. Ami itt áll, azt a futó rendszerből olvastuk ki.", ""]
    for f in (section_agents, section_patches, section_repos,
              section_services, section_autoupdate, section_scheduled, section_tools):
        try:
            L += f()
        except Exception as e:
            L += ["## (egy szakasz nem készült el)", "",
                  "`%s` hibára futott: %s" % (f.__name__, e),
                  "Ez a szakasz hiányzik, nem üres.", ""]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    text = build()
    if "--write" in sys.argv:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        open(OUT, "w").write(text)
        print("megirva: %s (%d sor)" % (OUT, len(text.splitlines())))
    else:
        print(text)
