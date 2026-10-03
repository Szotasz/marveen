#!/usr/bin/env python3
"""
PERSONA-VALTOZAS ERTESITO (PostToolUse hook, a keret hivja, nem az agens).

MIERT LETEZIK (2026-09-14, Laci kerdesere). A CLAUDE.md es a SOUL.md a fo agens
sajat termeszetet irja le, es az agens ezekbe IRHAT. Egyik fajl sincs
verziokovetve (mindketto gitignore-olt), es nincs elottuk jovahagyasi kapu, tehat
technikailag semmi nem allja utjat annak, hogy az agens csendben athangolja magat.
A vedelem ellene ez a hook: nem az agens hivja meg, hanem a keret, minden
eszkozhivas utan. Ettol nem az a kerdes, hogy meg tudja-e valtoztatni magat,
hanem hogy meg tudja-e tenni UGY, HOGY NE TUDJ ROLA. A valasz igy nem.

Amit csinal: MINDEN eszkozhivas utan osszehasonlitja a ket fajl jelenlegi
lenyomatat a store/.persona-hashes.json-ban tarolttal. Ha valtozott, UJ fajl lett, vagy egy fajl eltunt, azonnal kuld egy Telegram
uzenetet a tulajdonosnak, es sort ir a store/persona-changes.log-ba.
Nem blokkol es nem itel: a dolga a LATHATOSAG.

MIERT ALLAPOTOT NEZ, NEM ESZKOZT (2026-09-14, az elso valtozat rese). Eloszor a
Write/Edit eszkozok `file_path` mezojere szurt. Sajat teszt buktatta le meg
aznap: a `python3` heredoc-kal irt CLAUDE.md-modositas NEM valtotta ki, mert az
Bash volt, nem Write. Egy eszkoz-nevre szuro or pontosan azt engedi at, aki
szandekosan keruli meg. A lenyomat-osszevetes ezzel szemben azt meri, ami
SZAMIT: megvaltozott-e a fajl. Mindegy, mi irta.

OPT-IN (a reviewer kerese, #1546): az ertesites ALAPBOL KI VAN KAPCSOLVA. Az
`PERSONA_GUARD_NOTIFY=1` (kornyezeti valtozo, vagy sor az install `.env`-jeben)
kapcsolja be. KI allapotban a hook MINDENT megmerint, ami nem kuldes: a lenyomatot
kiszamolja es elmenti, a valtozast a store/persona-changes.log-ba irja, de a
Telegram-hivast NEM inditja. A hook a csatorna-plugin es a kimeno ledger KORUL
hivja az api.telegram.org-ot, es minden jogos CLAUDE.md-iras utan jelezne, tehat
hogy egy telepites akar-e ilyen ertesito-folyamot, az a tulajdonos dontese.

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
# Fast-path cache: per watched file the stat() key and the time it was hashed. Kept apart from
# HASHES so that file's format (name -> sha256) does not change.
STATS = os.path.join(ROOT, "store", ".persona-stat.json")
# git's "racy" rule: a stat key is only trusted when the file's newest timestamp is older than the
# moment it was hashed by more than this. A write inside the same timestamp tick would otherwise
# leave the key unchanged.
RACY_NS = 2 * 10**9


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


# JavaScript's String.trim() set, which src/env-parse.ts uses. Python's str.strip() differs on
# both sides: it also strips \x1c-\x1f, and it does NOT strip U+FEFF (a BOM on the first line).
_JS_WS = " \t\n\v\f\r\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff" + "".join(
    chr(c) for c in range(0x2000, 0x200B))


def _env_file_value(path, key):
    """Value of `key` in an install .env, by the SAME grammar as src/env-parse.ts
    (parseEnvContent): blank and `#` lines skipped, the line, key and value
    trimmed, ONE pair of matching surrounding quotes stripped, the last line
    wins. There is no `export` prefix and no inline comment there either, so
    neither is understood here: one rule for the product and for this hook, or
    an owner who writes "1" gets no alert and no warning (Sam's review of
    #1546). src/__tests__/persona-guard-env-parity.test.ts pins the two together.
    """
    found = None
    try:
        # newline="": a lone \r is NOT a line break in src/env-parse.ts (it splits on \n only), and
        # Python's default universal newlines would make it one. errors="replace": Node decodes
        # invalid UTF-8 to U+FFFD and carries on; a strict decode would drop the whole file.
        with open(path, encoding="utf-8", errors="replace", newline="") as fh:
            content = fh.read()
    except Exception:
        return None
    for line in content.split("\n"):
        t = line.strip(_JS_WS)
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        k, v = k.strip(_JS_WS), v.strip(_JS_WS)
        if v and v[0] in ("'", '"') and v[0] == v[-1]:
            v = v[1:-1]
        if k == key:
            found = v
    return found


def notify_enabled():
    """Opt-in switch: env first, then the install .env, default OFF.

    Anything other than 1/true/yes/on (any case) counts as off, so a typo
    fails toward the quiet, detect-and-log-only state.
    """
    v = os.environ.get("PERSONA_GUARD_NOTIFY")
    if v is None or not v.strip():
        v = _env_file_value(os.path.join(ROOT, ".env"), "PERSONA_GUARD_NOTIFY") or ""
    return v.strip().lower() in ("1", "true", "yes", "on")


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


def stat_key(path):
    """Identity of the file's current bytes as far as stat() can tell, or None.

    mtime alone is not enough: os.utime()/`touch -r` set it to anything. ctime cannot be set from
    userspace (every write, rename and utime bumps it), so a rewrite that restores mtime and size
    still changes the key. An atomic replace changes the inode too.
    """
    try:
        st = os.stat(path)
    except Exception:
        return None
    return [st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino]


def load_stats():
    try:
        d = json.load(open(STATS, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_stats(d):
    try:
        os.makedirs(os.path.dirname(STATS), exist_ok=True)
        tmp = STATS + ".tmp"
        json.dump(d, open(tmp, "w", encoding="utf-8"))
        os.replace(tmp, STATS)
    except Exception:
        pass


def fingerprint(name, known, stats, fresh_stats):
    """sha256 of a watched file, skipping the read when no file-system signal says it changed.

    The skip applies only when the file is already in `known`, its cached stat key equals the
    current one, and that key is not racy (see RACY_NS). Everything else, including a missing or
    corrupt cache, falls through to the full hash: the cache can only make the hook faster, never
    quieter. Known limit: a stat key that survives a content change needs root (resetting the
    clock, writing the block device) or a file system without a meaningful ctime; a hook that
    watches for a careless or unaware writer does not defend against that, and neither did the
    full hash against a writer who also edits store/.persona-hashes.json.
    """
    path = os.path.join(ROOT, name)
    key = stat_key(path)
    cached = stats.get(name)
    if key is not None and name in known and isinstance(cached, dict) and cached.get("key") == key:
        seen = cached.get("seen")
        if isinstance(seen, int) and seen - max(key[0], key[1]) > RACY_NS:
            fresh_stats[name] = cached
            return known[name]
    seen = time.time_ns()
    d = digest(path)
    if d is not None and key is not None:
        fresh_stats[name] = {"key": key, "seen": seen}
    return d


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    tool = payload.get("tool_name") or "?"

    known = load_known()
    stats = load_stats()
    fresh_stats = {}
    # (nev, fajta): "modositva" | "letrehozva" | "torolve". A modositas volt az
    # egyetlen, amit az elso valtozat latott; egy UJ persona-fajl (agents/<uj>/SOUL.md)
    # es egy TOROLT fajl nema maradt (review a #1546-on). Mindketto ugyanaz a
    # kerdes a gazdanak: valaki a szemelyiseget alakitotta, es o nem tud rola.
    events = []
    current = {}
    for name in watched():
        d = fingerprint(name, known, stats, fresh_stats)
        if d is None:
            continue
        current[name] = d
        if name not in known:
            events.append((name, "letrehozva"))
        elif known[name] != d:
            events.append((name, "modositva"))
    for name in known:
        if name not in current and digest(os.path.join(ROOT, name)) is None:
            events.append((name, "torolve"))

    # Elso futas: csak rogzitunk. Nincs mihez hasonlitani, tehat nincs lelet.
    first_run = not known
    merged = {**known, **current}
    for name, kind in events:
        if kind == "torolve":
            merged.pop(name, None)  # egy ujrakeszitett fajl igy ujra "letrehozva" lesz
    save_known(merged)
    if fresh_stats != stats:
        save_stats(fresh_stats)
    if first_run or not events:
        return 0

    stamp = time.strftime("%F %H:%M:%S")
    rows = []
    for name, kind in events:
        try:
            lines = sum(1 for _ in open(os.path.join(ROOT, name), encoding="utf-8", errors="replace"))
        except Exception:
            lines = -1
        rows.append((name, kind, lines))
        try:
            os.makedirs(os.path.dirname(LOG), exist_ok=True)
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(f"{stamp}\t{name}\t{kind}\t{tool}\t{lines} sor\n")
        except Exception:
            pass

    if not notify_enabled():
        return 0

    sd = state_dir()
    tok, chat = token(sd), owner_chat(sd)
    if not tok or not chat:
        return 0
    what = ", ".join(f"{n} ({k}, {l} sor)" if k != "torolve" else f"{n} ({k})" for n, k, l in rows)
    text = (
        f"[PERSONA-VALTOZAS] {stamp}\n"
        f"Valtozas: {what}\n"
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
