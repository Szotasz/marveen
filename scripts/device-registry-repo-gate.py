#!/usr/bin/env python3
"""
hu: A `device-registry.sh check` MUNKAFA-KAPUJA -- a merest ez a segedprogram vegzi.
en: Working-tree gate behind `device-registry.sh check` -- the measurement itself lives here.

hu: MIERT KULON FAJL, ES MIERT PYTHON (az ordog atmerese, 2026-08-14):
    a soronkenti `grep` HAROM XML-legalis `ProjectReference` alakra VAK volt (MSBuild-property az
    utban, egyszeres idezojel, tobbsoros tag), es a vaksag NEMA -- a nem feloldhato ut csendben
    atugrodott, vagyis FAIL-OPEN allt a legsulyosabb agon.

    KIMENET: a jelentes soronkent a stdout-ra.
    KILEPESI KOD: 0 = a kapu nem blokkol, 1 = ALLJ MEG.
"""
import datetime
import os
import re
import subprocess
import sys


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)


def _find_aapt2():
    """hu: a legfrissebb `aapt2` az Android SDK build-tools alatt. en: newest aapt2 in build-tools."""
    base = os.path.expanduser("~/Library/Android/sdk/build-tools")
    if not os.path.isdir(base):
        return None
    cands = sorted(os.listdir(base))
    for v in reversed(cands):
        p = os.path.join(base, v, "aapt2")
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _apk_version_code(aapt2, apk):
    """hu: a `versionCode` A CSOMAG MANIFESTJEBoL. Masolas/letoltes/`touch` nem irja at."""
    try:
        r = subprocess.run([aapt2, "dump", "badging", apk], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    m = re.search(r"versionCode='([^']*)'", r.stdout)
    return m.group(1) if m else None


def _buildnumber_last_change(repo, bf):
    """hu: mikor valtozott UTOLJARA a build-szam fajl (ISO-ido, git szerint). None, ha nem merheto."""
    if not repo or not bf:
        return None
    rel = os.path.relpath(bf, repo)
    if rel.startswith(".."):
        return None
    r = git(repo, "log", "-1", "--format=%cI", "--", rel)
    out = r.stdout.strip()
    return out if r.returncode == 0 and out else None


def _commits_since(repo, iso):
    """hu: hany commit tortent a repoban az adott ido ota. None, ha nem merheto."""
    r = git(repo, "log", "--since=%s" % iso, "--oneline")
    if r.returncode != 0:
        return None
    return len([l for l in r.stdout.splitlines() if l.strip()])


def main(argv):
    want_branch = argv[1]
    apk_path = argv[2]
    has_apk = argv[3] == "1"
    has_repo = argv[4] == "1"
    buildfile = argv[5]
    npaths = int(argv[6])
    paths = argv[7:7 + npaths]
    repos = argv[7 + npaths:]

    out, bad = [], False
    say = out.append

    pathscope = ",".join(paths) if paths else "(teljes repo)"
    roots = []
    for r in repos:
        try:
            roots.append(os.path.realpath(r))
        except OSError:
            roots.append(r)

    for r in repos:
        name = os.path.basename(os.path.normpath(r))
        if not os.path.isdir(r):
            say("  MUNKAFA: NEM MERHETo -- nincs ilyen konyvtar: %s" % r)
            bad = True
            continue
        if git(r, "rev-parse", "--is-inside-work-tree").returncode != 0:
            say("  MUNKAFA: NEM MERHETo -- nem git munkafa: %s" % r)
            bad = True
            continue

        # hu: A `--path` GLOBALIS minden repora. Ahol EGYETLEN nyomon kovetett fajlt sem illeszt, ott
        #     a szukites ertelmetlen -- es a regi alak ilyenkor "tiszta"-t irt, amivel HITELESITETTE
        #     egy meg nem mert repo allapotat. Eles fan igy adott MEHET-et harom repora, mikozben az
        #     egyikben kilenc commitolatlan bejegyzes allt, ebbol hat abban, ami BEEPUL az APK-ba.
        #     Fail-closed: 0 talalat NEM "tiszta", hanem "NEM MERT".
        if paths:
            hits = [l for l in git(r, "ls-files", "--", *paths).stdout.splitlines() if l.strip()]
            if not hits:
                say("  MUNKAFA: NEM MERT -- %s: a(z) '%s' szukites EGYETLEN nyomon kovetett fajlt" % (name, pathscope))
                say("           sem illeszt ebben a repoban, tehat a 'tiszta' itt nem allitas, hanem")
                say("           meres-hiany. Kosd a szukitest ahhoz a repohoz, amelyikben ertelme van.")
                bad = True
                continue
            st = git(r, "status", "--porcelain", "--", *paths)
        else:
            st = git(r, "status", "--porcelain")

        dirty = [l for l in st.stdout.splitlines() if l.strip()]
        br = git(r, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "(ismeretlen)"

        if dirty:
            say("  MUNKAFA: PISZKOS -- %s: %d eltero bejegyzes a HEAD-hez kepest. Hatokor: %s"
                % (name, len(dirty), pathscope))
            for l in dirty[:8]:
                say("       %s" % l)
            if len(dirty) > 8:
                say("       ... es meg %d sor" % (len(dirty) - 8))
            bad = True
        else:
            say("  MUNKAFA: tiszta -- %s (%s) megegyezik a HEAD-del. Hatokor: %s" % (name, br, pathscope))

        # hu: A KIKOTES NEM AZ AG NEVE, HANEM A BEHUZOTTSAG -- de a cel CSAK AG lehet.
        #     A `rev-parse --verify <barmi>` egy commit-hash-t vagy a `HEAD`-et is feloldja, es az
        #     `--is-ancestor HEAD HEAD` trivialisan igaz: egyetlen szoval kikapcsolhato lenne az
        #     egesz ellenorzes, ugy hogy a "CEL-AG FELULIRVA" sor szabalyos agnev-felulirasnak
        #     latszik. Ezert a cel `refs/heads/` ala kell essen.
        if git(r, "rev-parse", "--verify", "--quiet", "refs/heads/%s" % want_branch).returncode != 0:
            say("  AG: NEM MERHETo -- %s: nincs `%s` nevu HELYI ag. A cel csak AG lehet (commit-hash"
                % (name, want_branch))
            say("      vagy HEAD nem) -- add meg a repo fo agat: --branch <nev>.")
            bad = True
        elif git(r, "merge-base", "--is-ancestor", "HEAD", want_branch).returncode == 0:
            say("  AG: BEHUZVA -- %s HEAD-je (%s) benne van a(z) `%s` agban." % (name, br, want_branch))
        else:
            say("  AG: NINCS BEHUZVA -- %s HEAD-je (%s) NEM resze a(z) `%s` agnak." % (name, br, want_branch))
            say("      A gazda kikotese szerint csak a `%s` agba behuzott kodot szabad telepiteni." % want_branch)
            bad = True

        # hu: A REPON KIVULRE MUTATO `ProjectReference` MERETLEN FUGGoSEG. Merve: a JokerQ APK HAROM
        #     git-repobol fordul. A DARABSZAM KIIRASA a lenyeg: ma minden hivatkozas feloldhato, es
        #     ha holnap bekerul egy nem feloldhato alak, a szam az, ami jelezni fog.
        resolved_n, csprojs = 0, []
        for dirpath, dirnames, filenames in os.walk(r):
            dirnames[:] = [d for d in dirnames if d not in (".git", "obj", "bin")]
            csprojs += [os.path.join(dirpath, f) for f in filenames
                        if f.endswith((".csproj", ".props", ".targets"))]
        for cs in csprojs:
            try:
                xml = open(cs, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            # hu: A kikommentezett hivatkozas NEM lelet -- egy kapu, ami zajt termel, kikerul a sorbol.
            xml = re.sub(r"<!--.*?-->", "", xml, flags=re.S)
            for m in re.finditer(r"<ProjectReference\b[^>]*?Include\s*=\s*(\"|')(.*?)\1", xml, re.S):
                inc = m.group(2).strip()
                if "$(" in inc:
                    say("  MERETLEN FUGGoSEG: NEM FELOLDHATO -- %s/%s -> %s" % (name, os.path.basename(cs), inc))
                    say("      MSBuild-valtozot tartalmaz, ezert a kapu nem tudja eldonteni, hova mutat.")
                    say("      Ez NEM 'nincs fuggoseg', hanem 'nem tudjuk' -- fail-closed.")
                    bad = True
                    continue
                abs_ = os.path.realpath(os.path.join(os.path.dirname(cs), inc.replace("\\", "/")))
                if any(abs_ == root or abs_.startswith(root + os.sep) for root in roots):
                    resolved_n += 1
                else:
                    say("  MERETLEN FUGGoSEG -- %s/%s ide hivatkozik: %s" % (name, os.path.basename(cs), abs_))
                    say("      Ez az ut EGYIK megadott repoban sincs benne, tehat a forditasi egysegnek")
                    say("      csak egy resze van megmerve. Add meg azt is: --repo <ut>.")
                    bad = True
        say("       %d projekt-fajl (.csproj/.props/.targets), %d hivatkozas feloldva a mert repokon belul"
            % (len(csprojs), resolved_n))


    # hu: A KAPU A TELEPITENDo CSOMAG TARTALMAT MERI, NEM A FAJL IDEJET.
    #     AZ MTIME-ALAPU ELSo VALTOZAT KET IRANYBAN ADOTT HAMIS ZOLDET (ordog merese, 2026-08-14),
    #     es ez volt a kapu EGYETLEN olyan aga, ahol a teves meres a MEHET irANYba vitt:
    #       (a) MASOLAS atirja az mtime-ot -- bajtra AZONOS APK a masolat utan "frissnek" latszott.
    #           Ez SZO SZERINT a szallitasi ut: FTP-feltoltes -> letoltes -> telepites, pendrive, scp.
    #       (b) UJ tartalom REGI mtime-mal (`mv`, `cp -p`, `tar -x`, `unzip`, `rsync --times`,
    #           `git stash pop`) -- a kapu igazolt volna egy elavult csomagot.
    #     A KOZOS GYOKER: AZ MTIME NEM A TARTALOM TULAJDONSAGA.
    #     A HELYES ALAK: az `aapt2 dump badging` a `versionCode`-ot A CSOMAG MANIFESTJEBoL olvassa --
    #     masolas, letoltes, `touch` nem irja at. Mert pelda 2026-08-14: a fan allo APK 771, a
    #     `BuildNumberV2.txt` 773 -> a csomag bizonyithatoan nem a mai fabol keszult.
    if has_apk:
        if not os.path.isfile(apk_path):
            say("  APK: NEM MERHETo -- nincs ilyen fajl: %s" % apk_path)
            bad = True
        else:
            # hu: A BUILD-SZAM FORRASA: az APP-REPO (az ELSo `--repo`), vagy explicit `--buildfile`.
            #     Minden repo SAJAT build-szamot vezet (merve: MIND AZ OTBEN all `BuildNumberV2.txt`,
            #     JokerQ 774 / QuantumAE 1021 / QCassa.MHMI 113) -- egy "valamelyikkel egyezik" szabaly
            #     hamis zoldet adna, es a HELYES SORREND a hivon mulik. Ezert kimondjuk, melyiket vettuk.
            bf = buildfile if buildfile else (os.path.join(repos[0], "BuildNumberV2.txt") if repos else "")
            if buildfile:
                say("  BUILD-SZAM FORRASA FELULIRVA: %s (nem az app-repo BuildNumberV2.txt-je)." % buildfile)
            elif repos:
                say("  APP-REPO (a build-szam forrasa): %s -- az ELSo `--repo`." % os.path.basename(os.path.normpath(repos[0])))
            # hu: A FIGYELEM-sor a `--buildfile` agon IS kell. Korabban `elif`-ben allt, tehat epp akkor
            #     nemult el, amikor a hivo KEZZEL valasztott forrast -- ott a legnagyobb a tevedes eselye. (ordog)
            if repos:
                skip = 0 if buildfile else 1
                others = [r for r in repos[skip:] if os.path.isfile(os.path.join(r, "BuildNumberV2.txt"))]
                if others:
                    say("       FIGYELEM: %d mert repoban is all build-szam fajl (%s)."
                        % (len(others), ", ".join(os.path.basename(os.path.normpath(r)) for r in others)))
                    say("       Ha nem a hasznalt forras az app-repoe, a meres MAST hasonlit ossze.")
            want = None
            if bf and os.path.isfile(bf):
                try:
                    want = open(bf).read().strip()
                except OSError:
                    want = None
            # hu: KETToS URES -- a `versionCode='([^']*)'` az URES stringet is illeszti, es ket ures
            #     string EGYENLo: a kapu "a mert fabol keszult"-et irt volna ures zarojelekkel. (ordog)
            if not want:
                say("  APK: NEM MERHETo -- nincs (vagy ures) build-szam, amihez merni lehetne (%s)."
                    % (bf if bf else "nincs megadva `--repo` sem `--buildfile`"))
                say("       Az APP-REPO az ELSo `--repo`; ha a build-szam maSHOL all: --buildfile <ut>.")
                bad = True
            else:
                env_aapt2 = os.environ.get("AAPT2")
                aapt2 = env_aapt2 or _find_aapt2()
                if env_aapt2:
                    # hu: A MERo FELULIRHATO -- es az atallitasnak LATSZANIA kell. Egy kapu, amit a hivo
                    #     csendben athangolhat, nem kapu. (Ugyanaz, mint a `CEL-AG FELULIRVA`.)
                    say("  MERo FELULIRVA: AAPT2=%s (nem a rendszer aapt2-je olvassa a csomagot)." % env_aapt2)
                got = _apk_version_code(aapt2, apk_path) if aapt2 else None
                if not got:
                    say("  APK: NEM MERHETo -- a csomag `versionCode`-ja nem olvashato ki vagy URES (aapt2: %s)."
                        % (aapt2 or "nem talalhato"))
                    say("       Fail-closed: ha a csomag tartalma nem merheto, a telepites NEM indulhat.")
                    bad = True
                elif not (want.isdigit() and got.isdigit()):
                    # hu: A `not want` / `not got` az URESET fogja, a SZEMETET nem. Eles alak: egy
                    #     `--buildfile`, ami veletlenul README-re vagy merge-konfliktusos fajlra mutat. (ordog)
                    say("  APK: NEM MERHETo -- a ket ertek nem szam (csomag: %r, fa: %r)." % (got, want))
                    say("       Fail-closed: ket nem-szam ertek veletlen egyezese nem bizonyitek.")
                    bad = True
                elif got == want:
                    say("  APK: a mert fabol keszult -- a csomag versionCode-ja (%s) egyezik a fa" % got)
                    say("       build-szamaval (%s, forras: %s)." % (want, bf))
                else:
                    say("  APK: A MERT FA NEM AZ, AMIBoL EZ A CSOMAG KESZULT.")
                    say("       csomag versionCode: %s   (%s)" % (got, apk_path))
                    say("       a fa build-szama:   %s   (%s)" % (want, bf))
                    say("       A telepitendo csomag tehat egy MASIK fa-allapotbol keszult. Forditsd ujra.")
                    bad = True

            # hu: 🛑 A HATAR KIMONDASA -- KET ISMERT LYUK, MINDKETTo MERVE (ordog, 4. atmeres).
            #     E nelkul a `MUNKAFA: tiszta` es az `APK: a mert fabol keszult` sor EGYUTT ugy
            #     olvasodik, mintha a HAROM repo egyutt lenne igazolva a csomaghoz -- ugyanaz a
            #     hitelesites-hatas, ami a regi "Hatokor:" sornal allt fenn.
            # hu: 🛑 A HATAR KIMONDASA KOTELEZo -- DE A BENNE ALLO SZAM NEM LEHET KONZERV.
            #     Az elso valtozat beegetett egy merest ("a QuantumAE 16 commitja"), es azt MINDEN
            #     futasnal kiirta -- meg olyan fan is, ahol az a repo nincs is jelen (az ordog a sajat
            #     padjan allitotta elo). A szam a merese pillanataban igaz volt, de a SZOVEG TULEL.
            #     Ez a sajat szabalyunk ELAVULO alakja, a sajat kimenetunkon.
            #     A helyes: MERD MEG FUTASKOR, es PONT a kockazat merteket add.
            say("  APK-HATAR (ket ismert lyuk, nem a meres hibaja):")
            since = _buildnumber_last_change(repos[0], bf) if repos else None
            if since and len(repos) > 1:
                for r in repos[1:]:
                    n = _commits_since(r, since)
                    nm = os.path.basename(os.path.normpath(r))
                    if n is None:
                        say("       (1) %s: NEM MERHETo, hany commit tortent a build-szam utolso valtozasa ota." % nm)
                    elif n == 0:
                        say("       (1) %s: 0 commit a build-szam utolso valtozasa ota -- MOST nincs ablak." % nm)
                    else:
                        # hu: 🛑 A SZAM MERT, DE A KOVETKEZTETES NEM LEHET EROSEBB A MERESNEL.
                        #     A korabbi szoveg azt allitotta, hogy a valtozas "NEM latszik ... pedig BEEPUL"
                        #     -- holott a kapu NEM tudhatja, benne van-e: az APK KESZITESI IDEJET
                        #     szandekosan elejtettuk (az mtime-lyuk miatt, 3. atmeres). Bukas-eloallitas
                        #     (ordog): build-szam 10:00, fuggoseg-commit 10:30, APK 11:00 -> BENNE VAN.
                        #     Az irany konzervativ volt (tulbecsul, NEM hamis zold), de a kapu igy olyat
                        #     allitott, amit nem mert -- es a zaj a kapu MEGKERULESEHEZ vezet.
                        say("       (1) %s: %d commit a build-szam utolso valtozasa ota. A csomag" % (nm, n))
                        say("           versionCode-ja NEM igazolja, hogy ezek benne vannak-e -- sem igy, sem ugy.")
            elif since is None and repos:
                # hu: A futaskori meres CSENDBEN elmaradt, ha a build-szam fajl a mert repokon KIVUL all
                #     (`--buildfile`). A kapu sajat elve szerint (MERo FELULIRVA / CEL-AG FELULIRVA) ezt
                #     KI KELL MONDANI -- kulonben a hianyzo szam ugy olvasodik, mintha nem lenne mit merni.
                say("       (1) a futaskori meres NEM FUT: a build-szam forrasa a mert repokon KIVUL all,")
                say("           tehat nem allapithato meg, mikor valtozott utoljara. A versionCode igy CSAK")
                say("           az app-repot azonositja; a fuggoseg-repok allapota ezen a soron nincs megmerve.")
            else:
                say("       (1) a versionCode CSAK az app-repot azonositja; a fuggoseg-repok commitjai")
                say("           NEM mozditjak, tehat azok valtozasa ezen a soron nem latszik.")
            # hu: A (2) megfogalmazasa PONTOSITVA (ordog merese: 829 commit, ebbol 459 erinti a
            #     BuildNumberV2.txt-t). Vagyis NEM commit-szamlalo -- a `/commit` FOLYAMAT irja.
            #     A pontos alak a kovetkeztetest EROSEBBE teszi: 370 commit ugy ment at, hogy nem mozditotta.
            say("       (2) egy PISZKOS fan forditott, majd stash-elt csomag ATMEGY: a fa tiszta lesz, a")
            say("           build-szam valtozatlan. A build-szam a COMMIT-FOLYAMAT mellékterméke, nem a")
            say("           tartalom fuggvenye -- commitolni lehet ugy is, hogy nem mozdul.")
            say("       Mindketto akkor szunik meg, ha a build a MERT REPOK HEAD-jeit beegeti a csomagba.")

    elif has_repo:
        say("  APK: NEM MERVE -- `--apk <ut>` nelkul a kapu a FAT meri, nem a telepitendo CSOMAGOT.")
        say("       Egy regebbi APK akkor is felmehet, ha a fa most tiszta. Ez a sor NEM engedely.")

    print("\n".join(out))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
