#!/usr/bin/env python3
"""SMS kuldes a SeeMe (LINK Mobility) atjaron, BEEPITETT jovahagyas-kapuval.

>>> EZ SZANKCIONALT UT, NEM KIKENYSZERITETT KAPU. OLVASD EL, MIELOTT AZT HISZED,
    HOGY EZ A SZKRIPT MAGA A VEDELEM. <<<
Ez a fajl EGY HELYES modja annak, hogy egy fleet-agens SeeMe-n keresztul SMS-t
kuldjon -- NEM az EGYETLEN technikai ut. Egy agens ezutan is irhat nyers HTTP GET-et
a `https://seeme.hu/gateway`-re, es SEMMI nem allitja meg gepileg: a kredencialis
(store/seeme-gateway.env) olvashato annak, aki idaig eljut, es a SeeMe API maga nem
ismeri az `external_message` fogalmat. UGYANEZ A HIANY ALL FENN AZ `sms-send.py`
TESTVERENEL IS (sms-gate.app), es ott korabban nem lett kimondva -- itt potoljuk.
A kapu erteke tehat NEM az, hogy a rossz ut lehetetlen, hanem hogy VAN helyes ut, es
ha valaki azt hasznalja, a jovahagyas es a naplo garantalt. (marveen am#19092, kartya
`adbabf7f`, 1. kikotes.)

MIERT KuLoN FAJL, ES NEM AZ `sms-send.py` BoVITESE: az `sms-send.py` az sms-gate.app
(sajat, fizikai Android-telefon atjaro) API-jat beszeli (Basic auth, POST, JSON body,
opcionalis vegpontok-kozotti AES-titkositas). A SeeMe egy MASIK, felhos szolgaltato,
MAS API-alakkal (GET, kulcs a query-stringben, nincs kliens-oldali titkositasi
lehetoseg) -- ket kulonbozo protokoll egy fajlba eroltetese tobb elagazast adna, mint
ket olvashato fajl. A KoVETKEZo negy bekezdes minden atvett vedelmi elemet EGYENKENT
indokol -- ez a masodik kikotes (ne masold vakon).

ATVETT ELEMEK, ES MIERT (ellenorizve a sajat testverenel, nem feltetelezve):
  1. STDIN-rol jovo szoveg, nem argumentumkent. UGYANAZ A KOCKAZAT: a magyar szoveg
     idezojelet tartalmaz, arg-modban a shell szettori.
  2. Belso/kulso osztalyozas + default-deny lista. UGYANAZ AZ ELV (a `external_message`
     kategoria level=1 ES maxLevel=1, locked -- SOHA nem autonom), DE A LISTA MAGA
     KuLoN FAJL, MERT NEM oRoKoLHETo VALTOZATLANUL -- lasd store/seeme-internal-numbers.json
     sajat fejleceben, miert (a ket sms-gate.app-os bejegyzesbol csak EGY vonatkozik ide).
  3. `external_message` approval lekerdezese a `/api/approvals/<id>`-n, es hogy a
     cimzett szama SZEREPELJEN a jovahagyas leirasaban. VALTOZATLANUL atvett: ugyanaz
     a kormanyzasi API, ugyanaz a kategoria, a governance-nak nincs koze ahhoz, MELYIK
     gateway viszi tovabb az uzenetet.
  4. NINCS UJRAKuLDES (retry). VALTOZATLANUL atvett: egy kimeno SMS nem idempotens
     FUGGETLENuL attol, melyik gateway kuldi -- egy nema halozati hiba utani "biztos
     ami biztos" ujraprobalkozas itt is ket SMS-t jelenthet.
  5. Naplo egy sima fajlba (store/seeme-send.log). VALTOZATLANUL atvett: retry nelkul
     a nyom az EGYETLEN mod annak eldontesere utolag, mi tortent.
  6. Hosszkorlat (1600 karakter) vak kuldes ellen. VALTOZATLANUL atvett: ugyanaz a
     sanity-check, ha valaki veletlenul egy tobbezer karakteres szoveget csovezetne be.

TUDATOSAN NEM ATVETT ELEMEK, ES MIERT:
  - KLIENS-OLDALI TITKOSITAS (sms_crypto.py): az sms-gate.app tamogatja, mert egy
    HARMADIK FEL FELHOJEN at egy FIZIKAI telefonra jut el az uzenet, es a szolgaltato
    sajat specifikacioja szerint be lehet kotni vegpontok kozotti titkositast. A SeeMe
    API-nak NINCS ilyen funkcioja -- egy sima GET query-stringben viszi a szoveget,
    ES a Cirmi CRM SAJAT, MAR ELESBEN FUTo kodja (`src/lib/sms.ts`) IS igy kuld, ma is,
    minden ugyfelnek meno automatikus SMS-nel. Ha itt titkositast probalnank epiteni, a
    SeeMe oldal nem tudna dekodolni -- ez nem hianyossag, hanem MAS PROTOKOLL.
  - EGYEDI USER-AGENT Cloudflare-blokk ellen: az sms-gate.app-nal EZT MERVE talaltak meg
    (403 "error code: 1010" alapertelmezett urllib UA-val). A `seeme.hu/gateway`-re ez
    NINCS MERVE -- sem megerositve, sem cafolva. Ala teszek egy sajat, azonosithato
    User-Agentet ELoVIGYAZATOSSAGBOL (olcso, artalmatlan), DE HA EZ MEGIS ELoALL, NE
    ISMETELD A SMS-GATE.APP DIAGNoZISAT VAKON -- merd le UJRA erre a hostra.

EGY JOVAHAGYAS = EGY SMS (kartya `db121902`, a `f2c5edb0` kovetoje):
  A kapu (3. pont) a jovahagyast korabban csak OLVASTA, igy ugyanaz a jovahagyott sor
  barmennyi kuldest atengedett. Kulso cimzettnel a szkript most a SeeMe-hivas ELOTT
  ELFOGYASZTJA a jovahagyast: POST /api/approvals/<id>/consume (category
  external_message, consumer seeme-send, ref = a SeeMe reference), a
  scripts/approval-consume.py consume()-jan at, es CSAK 200 utan kuld. 409 (mar
  felhasznalva, lejart, nem jovahagyott, mas kategoria), 404 vagy barmilyen hiba:
  NEM kuld, es a naplo (store/seeme-send.log) NEM-KULDVE sort kap. Az ablak ugyanaz,
  mint a leveleke: a jovahagyastol (resolved_at) 1800 s, az EMAIL_APPROVAL_WINDOW_S
  szerint (a kartya D1 dontese).
  Sorrend: kapu (GET) -> a dry-run itt kilep, NEM fogyaszt -> credentials (elobb, hogy
  egy hianyzo kulcs ne egessen el jovahagyast) -> fogyasztas -> SeeMe. Ami a fogyasztas
  UTAN bukik el (SeeMe-hiba, ketertelmu halozati hiba), az a jovahagyast mar
  elhasznalta: uj kuldeshez UJ jovahagyas kell. Ez szandekos: a ketertelmu esetben az
  SMS kimehetett. Belso cimzettnel valtozatlan: nincs jovahagyas, nincs fogyasztas.

HASZNALAT:
  printf '%s' "A szoveg" | python3 scripts/sms/seeme-send.py --to 36301234567 [--approval <uuid>]
  printf '%s' "A szoveg" | python3 scripts/sms/seeme-send.py --to 36305552860 --dry-run

  --dry-run    : a cimzett-alakot, az osztalyozast es a KAPUT ellenorzi, kiirja, van-e
                 credentials -- de NEM kuld es NEM fogyaszt, credentials nelkul is lefut.
  --approval   : kulso cimzettnel KOTELEZO. A szkript lekerdezi, es CSAK `approved`
                 statusznal kuld, ES csak ha a cimzett szama SZEREPEL a keres
                 leirasaban. A valodi kuldes elott elfogyasztja: egy jovahagyas EGY SMS.
  --reference  : sajat azonosito a SeeMe fele (opcionalis, alapertelmezetten
                 `fleet-adhoc-<unix-ido>`).

CREDENTIALS: store/seeme-gateway.env (0600), sorai:
  SEEME_API_KEY=...
  SEEME_SENDER=...              # a felado-azonosito, pl. 36305555091
  SEEME_BASE=https://seeme.hu/gateway   # opcionalis, alapertelmezett ugyanez
BELSO SZAMOK: store/seeme-internal-numbers.json -> {"internal": ["36305552860", ...]}
  Ami ITT nincs benne, az KULSO, es approval-kotelesse valik. Default-deny.
  A SZAMFORMATUM ITT ES A KULDESNEL IS: '+' NELKuLI nemzetkozi alak (36...), ahogy a
  SeeMe API varja -- lasd kaszap-crm/src/lib/sms.ts normalizeHungarianMobile().
"""
import argparse, importlib.util, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV_FILE = os.environ.get("SEEME_ENV_FILE") or os.path.join(ROOT, "store", "seeme-gateway.env")
# INTERNAL_FILE es DASH_TOKEN_FILE felulirhato env-valtozoval -- KIZAROLAG a
# hermetikus teszt (seeme-send.test.sh) miatt, ami egy fris checkoutban (CI,
# uj worktree) SOSEM latja a valodi store/ tartalmat (gitignore-olt). Alapertelmezett
# viselkedes valtozatlan: eles hasznalatnal egyik env-valtozo sincs beallitva, tehat
# a ROOT-hoz kepesti utvonal marad ervenyben. Mert eset: script-tests-runner.test.ts
# a CI-n PIROSAT adott (`osztalyozas` mindig KULSO -- "a fajl NEM LETEZIK"), mert a
# +36305552860 teszt-szam csak az EN sajat, nem-committolt store/seeme-internal-
# numbers.json-omban szerepelt -- egy fris checkout ezt sosem latja.
# db121902: ugyanigy felulirhato a fenti ENV_FILE (SEEME_ENV_FILE), a LOG_FILE
# (SEEME_LOG_FILE) es a DASH_BASE (SEEME_DASH_BASE): a VALODI kuldest es a fogyasztast
# mero teszt (seeme-send-consume.test.py) csonk dashboarddal, csonk SeeMe-vel es
# labor-naploval fut, az eles store/-hoz es a futo dashboardhoz nem nyul. Eles
# hasznalatnal egyik sincs beallitva. Aki beallitja, a kaput egy masik szerverre
# iranyitja -- ugyanaz az osztaly, mint a SEEME_DASH_TOKEN_FILE: ez a fajl a fejlece
# szerint szankcionalt ut, nem kikenyszeritett kapu.
INTERNAL_FILE = os.environ.get("SEEME_INTERNAL_FILE") or os.path.join(ROOT, "store", "seeme-internal-numbers.json")
LOG_FILE = os.environ.get("SEEME_LOG_FILE") or os.path.join(ROOT, "store", "seeme-send.log")
DASH_TOKEN_FILE = os.environ.get("SEEME_DASH_TOKEN_FILE") or os.path.join(ROOT, "store", ".dashboard-token")
DASH_BASE = os.environ.get("SEEME_DASH_BASE") or "http://localhost:3420"
# db121902: a fogyaszto seged (ugyanaz, amit a levelkuldok hasznalnak) es a nev, amivel
# a jovahagyas soran (consumed_by) es az esemenynaploban szerepelunk.
CONSUME_HELPER = os.path.join(ROOT, "scripts", "approval-consume.py")
CONSUMER = "seeme-send"
DEFAULT_BASE = "https://seeme.hu/gateway"
# Elovigyazatossagbol, NEM mert protekcio -- lasd a fejlecet.
USER_AGENT = "kaszap-jobs-seeme-gateway/1.0 (+marveen)"

# A SeeMe a magyar mobilszamot NEMZETKoZI ALAKBAN, '+' NELKuL varja: 36301234567.
# Ez SZANDEKOSAN MAS mintat hasznal, mint az sms-send.py E.164 (+...) ellenorzese --
# a ket gateway MAS vezetekes formatumot var, es ezt NEM eltus rossz iranyba tenne.
HU_MOBILE = re.compile(r"^36(20|30|31|50|70)\d{7}$")


def die(msg, code=1):
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(code)


def normalize_number(raw):
    """+36/06/36 barmely alakot 36XXXXXXXXX-re hoz, vagy None, ha nem magyar mobil."""
    digits = re.sub(r"[^\d]", "", raw)
    if raw.strip().startswith("+"):
        pass  # a '+' mar a digits-bol kiesett, digits maga a szam orszaghivoval
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("06"):
        digits = "36" + digits[2:]
    if not digits.startswith("36"):
        return None
    return digits if HU_MOBILE.match(digits) else None


def read_env():
    if not os.path.exists(ENV_FILE):
        die(f"nincs credentials-fajl: {ENV_FILE}\n"
            f"      A vaultban 'seeme SMS Gateway API kulcs' neven all a kulcs -- oda kell.")
    env = {}
    with open(ENV_FILE, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    for k in ("SEEME_API_KEY", "SEEME_SENDER"):
        if not env.get(k):
            die(f"a {k} hianyzik vagy ures a {ENV_FILE}-ben")
    return env


def load_internal():
    """A belso szamok listaja EBBEN a normalizalt (36...) alakban.
    HIANYZO FAJL = NINCS belso szam, tehat MINDEN cimzett kulsonek szamit -- szandekos,
    ugyanaz az indok, mint az sms-send.py-nal: a hianyzo allowlist ne nyisson kaput."""
    if not os.path.exists(INTERNAL_FILE):
        return set(), "a fajl NEM LETEZIK -> minden cimzett kulsonek szamit"
    try:
        d = json.load(open(INTERNAL_FILE, encoding="utf-8"))
    except Exception as exc:
        die(f"a {INTERNAL_FILE} nem olvashato ({exc}) -- ilyenkor NEM tippelek, megallok")
    nums = {str(x).strip() for x in d.get("internal", [])}
    return nums, f"{len(nums)} belso szam betoltve"


def check_approval(approval_id, to_number):
    if not os.path.exists(DASH_TOKEN_FILE):
        die(f"nincs dashboard-token ({DASH_TOKEN_FILE}), az approval nem ellenorizhető")
    tok = open(DASH_TOKEN_FILE, encoding="utf-8").read().strip()
    req = urllib.request.Request(
        f"{DASH_BASE}/api/approvals/{approval_id}",
        headers={"Authorization": f"Bearer {tok}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            code = resp.status
    except urllib.error.HTTPError as exc:
        die(f"az approval lekerdezese HTTP {exc.code} -- a kapu ZARVA marad")
    except Exception as exc:
        die(f"az approval lekerdezese nem sikerult ({exc}) -- a kapu ZARVA marad")
    if code != 200:
        die(f"az approval lekerdezese HTTP {code}")
    try:
        rec = json.loads(body)
    except Exception:
        die("az approval valasza nem JSON")
    if isinstance(rec, list):
        rec = rec[0] if rec else {}
    status = str(rec.get("status", "")).lower()
    if status != "approved":
        die(f"az approval statusza '{status or 'ISMERETLEN'}', nem 'approved' -- NEM kuldok.\n"
            f"      (pending eseten VARJ, ne kuldj; a level-1 kategoria sosem lesz autonom)")
    if str(rec.get("category")) != "external_message":
        die(f"az approval kategoriaja '{rec.get('category')}', nem 'external_message' -- "
            f"egy mas celra kapott engedely NEM ervenyes ide")
    desc = str(rec.get("action_description") or "")
    if to_number not in desc.replace(" ", "").replace("-", "").replace("+", ""):
        die(f"az approval leirasaban NEM szerepel a cimzett szama ({to_number}).\n"
            f"      Egy jovahagyas EGY cimzettre szol; nem hasznalom ujra masra.")
    return rec


def log(line):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line.rstrip() + "\n")
    except Exception as exc:
        print(f"FIGYELEM: a naplo-iras nem sikerult ({exc})", file=sys.stderr)


# Mit jelent a fogyasztas visszautasitasa (409 reason) annak, aki a hibat olvassa.
REFUSAL_HINT = {
    "already_consumed": "ezzel a jovahagyassal mar ment (vagy indult) SMS. Mielott ujat kersz, "
                        "nezd meg a naploban es a SeeMe portalon az elozo reference-t.",
    "expired": "a jovahagyas az ablakon kivul van (EMAIL_APPROVAL_WINDOW_S, alapbol 1800 s a "
               "dontestol) -- uj jovahagyas kell.",
    "not_approved": "a jovahagyas statusza a fogyasztas pillanataban nem approved.",
    "wrong_category": "a jovahagyas nem external_message kategoriaju.",
}


def consume_approval(approval_id, to, reference):
    """db121902: EGY jovahagyas = EGY SMS. A SeeMe-hivas ELOTT elfogyasztja a jovahagyast
    (POST /api/approvals/<id>/consume, category external_message, ref = a SeeMe reference), es
    CSAK igen (200) eseten ter vissza. Minden mas -- 409, 404, elerhetetlen dashboard, hianyzo
    seged -- naplosor + die: NEM kuldunk."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        spec = importlib.util.spec_from_file_location("approval_consume", CONSUME_HELPER)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        tok = open(DASH_TOKEN_FILE, encoding="utf-8").read().strip()
    except Exception as exc:
        log(f"{stamp}\tNEM-KULDVE\tfogyasztas elott: {type(exc).__name__}\t{to}\treference={reference}\tapproval={approval_id}")
        die(f"a jovahagyas fogyasztasa el sem indulhatott ({type(exc).__name__}: {exc}) -- NEM kuldok")
    rc, body = helper.consume(DASH_BASE, tok, approval_id, None, CONSUMER, category="external_message", ref=reference)
    if rc != 0:
        reason = str(body.get("reason") or body.get("error") or "-")
        log(f"{stamp}\tNEM-KULDVE\tfogyasztas rc={rc} {reason}\t{to}\treference={reference}\tapproval={approval_id}")
        hint = REFUSAL_HINT.get(reason, "a kapu ZARVA marad.")
        die(f"a jovahagyas NEM fogyaszthato (rc={rc}, {reason}) -- NEM kuldok.\n      {hint}")
    return body


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--to", required=True, help="cimzett, magyar mobil, barmilyen szokasos alakban")
    ap.add_argument("--approval", default=None, help="approval UUID (kulso cimzettnel KOTELEZO)")
    ap.add_argument("--reference", default=None, help="sajat azonosito a SeeMe fele")
    ap.add_argument("--dry-run", action="store_true", help="mindent ellenoriz, de nem kuld")
    args = ap.parse_args()

    to = normalize_number(args.to)
    if not to:
        die(f"a cimzett nem magyar mobilszam ertelmezheto ({args.to!r}) -- "
            f"vart alak: 36301234567 (barmilyen bemeneti formabol normalizalva)")

    if sys.stdin.isatty():
        die("a szoveg STDIN-rol jon, nem argumentumkent.\n"
            "      pl.: printf '%s' \"A szoveg\" | python3 scripts/sms/seeme-send.py --to 3630...")
    text = sys.stdin.read()
    if not text.strip():
        die("ures a szoveg (STDIN)")
    if len(text) > 1600:
        die(f"a szoveg {len(text)} karakter -- 1600 folott nem kuldok el vakon, ossze kell vonni")

    # A KAPU ELoBB FUT, MINT A TITOK BETOLTESE -- ugyanaz a ket ok, mint az sms-send.py-ban:
    # (1) default-deny: egy tiltott kuldes ne is erjen hozza a credentialshoz;
    # (2) a kapu igy TESZTELHETo credentials nelkul is.
    internal, internal_note = load_internal()
    is_internal = to in internal

    print(f"cimzett     : {to}")
    print(f"osztalyozas : {'BELSO' if is_internal else 'KULSO'}  ({internal_note})")
    print(f"hossz       : {len(text)} karakter")

    if not is_internal:
        if not args.approval:
            die("KULSO cimzett, es nincs --approval.\n"
                "      Az `external_message` level=1 ES maxLevel=1 (locked), tehat ez SOHA nem\n"
                "      autonom. Elobb kerj jovahagyast, a cimzett szamaval a leirasban:\n"
                "        bash scripts/approval-request.sh --category external_message <<'EOF'\n"
                f"        SMS-t kuldenek a {to} szamra (SeeMe). A szoveg: \"...\". Indok: ...\n"
                "        EOF")
        rec = check_approval(args.approval, to)
        print(f"approval    : {args.approval} -> approved "
              f"(kert: {rec.get('requested_at')}, dontott: {rec.get('resolved_at')})")
    elif args.approval:
        print("approval    : megadva, de a cimzett BELSO -- nem kotelezo, nem is hasznalom kapunak")

    if args.dry_run:
        creds = "megvan" if os.path.exists(ENV_FILE) else f"NINCS ({ENV_FILE})"
        print(f"credentials : {creds}")
        print("DRY-RUN: a kapu-ellenorzesek lefutottak, NEM kuldtem el.")
        return

    env = read_env()
    base = env.get("SEEME_BASE") or DEFAULT_BASE
    reference = args.reference or f"fleet-adhoc-{int(time.time())}"

    # db121902: a credentials MAR betoltve (egy hianyzo kulcs ne egessen el jovahagyast);
    # a fogyasztas a SeeMe-hivas ELOTT, es csak igen utan megyunk tovabb.
    if not is_internal:
        consume_approval(args.approval, to, reference)
        print(f"fogyasztva  : {args.approval} (consumer {CONSUMER}, reference {reference})")

    params = {
        "key": env["SEEME_API_KEY"],
        "sender": env["SEEME_SENDER"],
        "number": to,
        "message": text,
        "reference": reference,
        "format": "json",
    }
    url = f"{base}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})

    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        # IDoKORLAT KOTELEZo, ugyanaz az indok, mint az sms-send.py-ban: egy
        # valaszolatlan atjaro ne fagyassza be a hivo folyamatot vegtelenul.
        with urllib.request.urlopen(req, timeout=20) as resp:
            code_http, body = resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        log(f"{stamp}\tFAIL\tHTTP {exc.code}\t{to}\treference={reference}\t{body}")
        die(f"HTTP {exc.code} -- NEM kuldtem el, es NEM probalom ujra.\n      valasz: {body}")
    except Exception as exc:
        # KETERTELMU AG: a kimeno kereslet UTAZOTT, de a valasz nem erkezett vissza
        # ertelmezhetoen. Ugyanaz a dontes, mint az sms-send.py-ban: NEM retry, ember dont.
        log(f"{stamp}\tKETERTELMU\t{exc}\t{to}\treference={reference}\t-")
        die(f"halozati hiba a kuldes kozben: {exc}\n"
            f"      KETERTELMU: nem tudom, kimen-e. NEM kuldok ujra (duplikatum-veszely).\n"
            f"      Ellenorizd a SeeMe portalon a `reference={reference}` alapjan, mielott "
            f"ujraprobalod.")

    try:
        payload = json.loads(body)
    except Exception:
        log(f"{stamp}\tFAIL\tnem-JSON\t{to}\treference={reference}\t{body[:400]}")
        die(f"a valasz nem JSON (HTTP {code_http}): {body[:400]}")

    # A SZOLGALTATO HIBAT IS HTTP 200-ZAL AD (a `code` mezoben) -- ugyanaz a szerzodes,
    # amit a Cirmi CRM sajat, elesben mukodo kliense (src/lib/sms.ts) mar hasznal es
    # MERT: code "0" vagy ures, VAGY result=="OK" jelenti a sikert.
    code = str(payload.get("code", ""))
    ok = code == "0" or code == "" or payload.get("result") == "OK"
    if not ok:
        message = str(payload.get("message") or payload.get("error") or json.dumps(payload)[:200])
        log(f"{stamp}\tFAIL\tcode={code}\t{to}\treference={reference}\t{message}")
        die(f"a SeeMe elutasitotta (code={code}): {message}")

    segments = payload.get("split")
    price = payload.get("price")
    log(f"{stamp}\tOK\t{to}\treference={reference}\trészek={segments}\tár={price}\tapproval={args.approval or '-'}\tlen={len(text)}")
    print(f"OK reference={reference} részek={segments} ár={price}")


if __name__ == "__main__":
    main()
