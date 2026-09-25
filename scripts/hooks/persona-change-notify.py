#!/usr/bin/env python3
"""
PERSONA-VALTOZAS ERTESITO (PostToolUse hook, a keret hivja, nem az agens).

MIERT LETEZIK (2026-09-14, Laci kerdesere). A CLAUDE.md es a SOUL.md a fo agens
sajat termeszetet irja le, es az agens ezekbe IRHAT. Egyik fajl sincs
verziokovetve (mindketto gitignore-olt), es nincs elottuk jovahagyasi kapu, tehat
technikailag semmi nem allja utjat annak, hogy az agens csendben athangolja magat.
Ket vedelem kesz ellene:

  1. `persona_change` kategoria az autonomy-config.json-ban, jovahagyas-kotelesen.
     Ez SZABALY: addig er, amig az agens be akarja tartani.
  2. EZ A HOOK. Nem az agens hivja meg, hanem a keret, minden Write/Edit utan.
     Ettol nem az a kerdes, hogy meg tudja-e valtoztatni magat, hanem hogy meg
     tudja-e tenni UGY, HOGY NE TUDJ ROLA. A valasz igy nem.

Amit csinal: MINDEN eszkozhivas utan osszehasonlitja a ket fajl jelenlegi
lenyomatat a store/.persona-hashes.json-ban tarolttal. Ha valtozott, azonnal kuld
egy Telegram uzenetet a tulajdonosnak, es sort ir a store/persona-changes.log-ba.
Nem blokkol es nem itel: a dolga a LATHATOSAG.

MIERT ALLAPOTOT NEZ, NEM ESZKOZT (2026-09-14, az elso valtozat rese). Eloszor a
Write/Edit eszkozok `file_path` mezojere szurt. Sajat teszt buktatta le meg
aznap: a `python3` heredoc-kal irt CLAUDE.md-modositas NEM valtotta ki, mert az
Bash volt, nem Write. Egy eszkoz-nevre szuro or pontosan azt engedi at, aki
szandekosan keruli meg. A lenyomat-osszevetes ezzel szemben azt meri, ami
SZAMIT: megvaltozott-e a fajl. Mindegy, mi irta.

Fail-open: ha barmi hibazik (nincs token, halozat), a hook csendben kilep 0-val.
Egy ertesites-kuldesi hiba soha ne akadalyozzon meg egy szerkesztest; a naplo
sor ilyenkor is megprobal megszuletni, es az utolag elarulja a valtozast.
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# A fo agens ket persona-fajlja, ROOT-hoz kepesti uttal.
_MAIN_WATCHED = ("CLAUDE.md", "SOUL.md")


def watched():
    """A figyelt persona-fajlok, ROOT-hoz kepesti uttal.

    2026-09-19: korabban CSAK a fo agens ket fajlja szerepelt itt, tehat az
    `agents/<nev>/CLAUDE.md` es `SOUL.md` fajlokat SEMMI nem figyelte. Egy
    sub-agens at tudta irni a sajat szemelyiseget anelkul, hogy a gazda
    ertesult volna rola -- pontosan az a rés, ami ellen ez a hook a fo agensnel
    letezik. Igor letrehozasa utan derult ki, az o sajat jelentesebol.

    A visszatert nevek ROOT-hoz kepesti UTAK (pl. "agents/igor/SOUL.md"), mert
    a hivo oldal `os.path.join(ROOT, name)`-mel nyitja oket, es ugyanez a nev a
    lenyomat-tabla kulcsa es az ertesites szovege is. Igy a kiterjesztes egyetlen
    helyen tortenik, a tobbi logika valtozatlan.
    """
    names = list(_MAIN_WATCHED)
    agents_dir = os.path.join(ROOT, "agents")
    try:
        for agent in sorted(os.listdir(agents_dir)):
            for fn in ("CLAUDE.md", "SOUL.md"):
                if os.path.isfile(os.path.join(agents_dir, agent, fn)):
                    names.append(os.path.join("agents", agent, fn))
    except Exception:
        pass
    return names
LOG = os.path.join(ROOT, "store", "persona-changes.log")
HASHES = os.path.join(ROOT, "store", ".persona-hashes.json")


def state_dir():
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    inst = os.path.join(ROOT, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(inst, ".env")):
        return inst
    return os.path.expanduser("~/.claude/channels/telegram")


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def owner_chat(sd):
    """A tulajdonos chat-azonositoja az allowFrom elso eleme.

    Ugyanaz a forras, amibol a fo agens is dolgozik, amikor a `chat_id: 0`
    nem oldodik fel (lasd a scheduled-task-lifecycle skillt).
    """
    for path in (os.path.join(sd, "access.json"),
                 os.path.join(ROOT, ".claude", "channels", "telegram", "access.json")):
        try:
            allow = json.load(open(path, encoding="utf-8")).get("allowFrom") or []
            if allow:
                return str(allow[0])
        except Exception:
            continue
    return None


def digest(path):
    """A fajl tartalmanak lenyomata, vagy None ha nincs/olvashatatlan."""
    import hashlib
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except Exception:
        return None


def load_known():
    try:
        return json.load(open(HASHES, encoding="utf-8"))
    except Exception:
        return {}


def save_known(d):
    try:
        os.makedirs(os.path.dirname(HASHES), exist_ok=True)
        tmp = HASHES + ".tmp"
        json.dump(d, open(tmp, "w", encoding="utf-8"))
        os.replace(tmp, HASHES)
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    tool = payload.get("tool_name") or "?"

    known = load_known()
    changed = []
    current = {}
    for name in watched():
        full = os.path.join(ROOT, name)
        d = digest(full)
        if d is None:
            continue
        current[name] = d
        if name in known and known[name] != d:
            changed.append(name)

    # Elso futas: csak rogzitunk. Nincs mihez hasonlitani, tehat nincs lelet.
    first_run = not known
    save_known({**known, **current})
    if first_run or not changed:
        return 0

    stamp = time.strftime("%F %H:%M:%S")
    rows = []
    for name in changed:
        try:
            lines = sum(1 for _ in open(os.path.join(ROOT, name), encoding="utf-8", errors="replace"))
        except Exception:
            lines = -1
        rows.append((name, lines))
        try:
            os.makedirs(os.path.dirname(LOG), exist_ok=True)
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(f"{stamp}\t{name}\t{tool}\t{lines} sor\n")
        except Exception:
            pass

    sd = state_dir()
    tok, chat = token(sd), owner_chat(sd)
    if not tok or not chat:
        return 0
    what = ", ".join(f"{n} ({l} sor)" for n, l in rows)
    text = (
        f"[PERSONA-VALTOZAS] {stamp}\n"
        f"Modosult: {what}\n"
        f"Az utolso eszkozhivas: {tool}.\n"
        f"Ez az ertesito a keretbol megy, nem az agens kuldi, es a fajl "
        f"LENYOMATAT figyeli, nem az eszkozt. Ha nem te kerted es nem "
        f"beszeltuk meg, kerdezz ra."
    )
    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{tok}/sendMessage",
            data=json.dumps({"chat_id": chat, "text": text}).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=8)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
