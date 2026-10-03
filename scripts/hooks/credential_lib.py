#!/usr/bin/env python3
"""Credential detection and state for outgoing letters (CREDGATE1003).

Shared by scripts/hooks/credential-gate.py (the PreToolUse gate) and
scripts/credential-gate-cli.py (the operator CLI). Two parts:

  - detect(text, cfg, fingerprint): finds a credential KEYWORD (password, PIN,
    Wi-Fi key, login data ...) followed on the same line by a VALUE-SHAPED
    token. Pure, no I/O. A found value never leaves this module in clear: a
    hit carries the keyword, the line number, the value's length and its
    fingerprint, nothing else.
  - the state (shared list, acknowledgements, first-recipient map, aliases):
    one JSON file per install under the store directory, read-modify-written
    under an exclusive lock.

Fingerprints are HMAC-SHA256 under ONE install-level key (store, 0600), never a
plain hash: a short password's plain sha256 is recoverable by brute force, so a
plain-hash list or log line would itself leak the value. One key per INSTALL,
not per agent: the same value must give the same fingerprint for every agent of
the install, otherwise the shared list and the cross-recipient check would be
blind between two agents writing to the same customers.
"""
import email.utils
import fcntl
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
import unicodedata

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))


def store_dir() -> str:
    return os.environ.get("CREDENTIAL_GATE_STORE") or os.path.join(_ROOT, "store")


def _path(env_key: str, name: str) -> str:
    return os.environ.get(env_key) or os.path.join(store_dir(), name)


def config_path() -> str:
    return _path("CREDENTIAL_GATE_CONFIG", "credential-gate.json")


def key_path() -> str:
    return _path("CREDENTIAL_GATE_KEY_FILE", "credential-gate.key")


def state_path() -> str:
    return _path("CREDENTIAL_GATE_STATE", "credential-gate-state.json")


def log_path() -> str:
    return _path("CREDENTIAL_GATE_LOG", "credential-gate.log")


class GateConfigError(Exception):
    """A configuration, key or state problem. The gate turns it into a named
    deny: "cannot check" never means "nothing to find"."""


# --- configuration ------------------------------------------------------------
# Keywords are case-insensitive regexes, matched as whole words. The defaults
# cover Hungarian and English; an install adds its own with "extra_keywords".
DEFAULT_KEYWORDS = (
    r"jelsz\w*",
    r"pass(?:word|wd|wort|code|phrase)\w*",
    r"pwd?",
    r"pin(?:[- ]?k[oó]d\w*)?",
    r"(?:wi-?fi|wlan|wpa[23]?|h[aá]l[oó]zati)[- ]?(?:kulcs\w*|key)",
    r"admin",
    r"login",
    r"credentials?",
    r"(?:bel[eé]p[eé]si|bejelentkez[eé]si|hozz[aá]f[eé]r[eé]si)\s+(?:adat\w*|k[oó]d\w*)",
)
# Words skipped between the keyword and the value ("a jelszava a kovetkezo: X",
# "the password is X"). Compared lowercased, without trailing punctuation.
DEFAULT_GLUE = (
    "a", "az", "is", "pedig", "lesz", "volt", "most", "uj", "új", "kovetkezo", "következő",
    "alabbi", "alábbi", "the", "was", "your", "new", "for", "to", "be", "will",
)
DEFAULTS = {
    "mode": "block",          # block | warn
    "keywords": list(DEFAULT_KEYWORDS),
    "extra_keywords": [],
    "glue_words": list(DEFAULT_GLUE),
    "window": 40,             # characters after the keyword in which the value may start
    "min_length": 4,          # a shorter token is not taken for a credential
    "scan_tokens": 3,         # tokens read after the keyword (glue words not counted)
    "auto_shared": True,      # the same value to a second, unrelated recipient = shared
}


def load_config() -> dict:
    """Defaults, overridden by the install's JSON file and by
    CREDENTIAL_GATE_MODE. A missing file means the defaults; a file that
    exists but is not a valid config raises GateConfigError."""
    cfg = json.loads(json.dumps(DEFAULTS))
    path = config_path()
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                user = json.load(fh)
        except (OSError, ValueError) as exc:
            raise GateConfigError(f"a konfig nem olvashato ({path}: {exc})")
        if not isinstance(user, dict):
            raise GateConfigError(f"a konfig nem JSON-objektum ({path})")
        unknown = sorted(set(user) - set(DEFAULTS))
        if unknown:
            raise GateConfigError(f"ismeretlen konfig-kulcs(ok): {', '.join(unknown)} ({path})")
        cfg.update(user)
    env_mode = os.environ.get("CREDENTIAL_GATE_MODE")
    if env_mode:
        cfg["mode"] = env_mode.strip()
    if cfg["mode"] not in ("block", "warn"):
        raise GateConfigError(f"a mode csak 'block' vagy 'warn' lehet, nem {cfg['mode']!r}")
    for key in ("keywords", "extra_keywords", "glue_words"):
        if not isinstance(cfg[key], list) or not all(isinstance(x, str) and x for x in cfg[key]):
            raise GateConfigError(f"a {key} nem-ures szovegek listaja kell legyen")
    for key in ("window", "min_length", "scan_tokens"):
        if not isinstance(cfg[key], int) or isinstance(cfg[key], bool) or cfg[key] < 1:
            raise GateConfigError(f"a {key} pozitiv egesz kell legyen")
    if not isinstance(cfg["auto_shared"], bool):
        raise GateConfigError("az auto_shared true vagy false lehet")
    try:
        cfg["_kw_re"] = re.compile(
            r"(?<!\w)(?:" + "|".join(f"(?:{k})" for k in cfg["keywords"] + cfg["extra_keywords"]) + r")(?!\w)",
            re.IGNORECASE)
    except re.error as exc:
        raise GateConfigError(f"hibas kulcsszo-minta: {exc}")
    cfg["_glue"] = {g.lower() for g in cfg["glue_words"]}
    return cfg


# --- install-level key and fingerprint ----------------------------------------
def load_key(create: bool = True) -> bytes:
    """The install's HMAC key. Created on first use (0600, never overwritten);
    a key file readable by group or others is refused, because whoever reads
    it can test guesses against every stored fingerprint."""
    path = key_path()
    if not os.path.exists(path):
        if not create:
            raise GateConfigError(f"a kulcsfajl hianyzik ({path})")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass  # created concurrently: read it below
        except OSError as exc:
            raise GateConfigError(f"a kulcsfajl nem hozhato letre ({path}: {exc})")
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(secrets.token_hex(32) + "\n")
    try:
        st = os.stat(path)
        if st.st_mode & 0o077:
            raise GateConfigError(
                f"a kulcsfajl jogosultsaga tul nyitott ({oct(st.st_mode & 0o777)}, {path}); 0600 kell")
        with open(path, encoding="utf-8") as fh:
            raw = fh.read().strip()
        if not raw:
            time.sleep(0.1)  # created a moment ago by a concurrent first run
            with open(path, encoding="utf-8") as fh:
                raw = fh.read().strip()
    except OSError as exc:
        raise GateConfigError(f"a kulcsfajl nem olvashato ({path}: {exc})")
    if not re.fullmatch(r"[0-9a-f]{64}", raw):
        raise GateConfigError(f"a kulcsfajl tartalma nem 64 hex jegy ({path})")
    return bytes.fromhex(raw)


# Typographic marks from code points, so this source stays ASCII here.
_TYPO_OPEN = "".join(map(chr, (0x00AB, 0x201E, 0x201C, 0x2018)))   # guillemet, low and high quotes
_TYPO_CLOSE = "".join(map(chr, (0x00BB, 0x201D, 0x2019)))
_DASHES = "".join(map(chr, (0x2013, 0x2014)))                    # en and em dash
_ELLIPSIS = chr(0x2026)
_STRIP_LEAD = "\"'([{<" + _TYPO_OPEN
_STRIP_TAIL = "\"')]}>.,;:" + _TYPO_CLOSE


def normalize_value(token: str) -> str:
    """The canonical form of a value: surrounding quotes and brackets and a
    trailing sentence mark removed. The SAME function feeds the detector and
    the shared-list CLI, so a listed value and the value in a letter always
    meet on the same fingerprint."""
    return token.strip().lstrip(_STRIP_LEAD).rstrip(_STRIP_TAIL)


def make_fingerprint(key: bytes):
    def fingerprint(value: str) -> str:
        return hmac.new(key, normalize_value(value).encode("utf-8"), hashlib.sha256).hexdigest()
    return fingerprint


# --- detector -----------------------------------------------------------------
_TAG = re.compile(r"<[^<>\n]{1,300}>")
_URL_USERINFO = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s/:@]+:([^\s/@]+)@")
_PLACEHOLDER = re.compile(
    r"^(?:\[[^\]]*\]|<[^>]*>|\{[^}]*\}|\*{3,}|[xX]{3,}|\.{3,}|_{3,}|-{3,}|" + _ELLIPSIS + r"|\$\{?\w+\}?|%\w+%)[.,;:]?$")
_SYMBOLS = set("!#$%&*+/=?@^_|~\\")
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$")
_SEPARATORS = " \t:=-/,()\"'" + _DASHES + _TYPO_OPEN + _TYPO_CLOSE


def _has_accent(word: str) -> bool:
    return any(unicodedata.combining(c) for c in unicodedata.normalize("NFD", word))


def _value_shaped(core: str, after_colon: bool, clause_end: bool, cfg: dict) -> bool:
    if len(core) < cfg["min_length"]:
        return False
    if "://" in core or _EMAIL.match(core):
        return False
    if any(c.isdigit() for c in core):
        return True
    if any(c in _SYMBOLS for c in core):
        return True
    letters = [c for c in core if c.isalpha()]
    if len(letters) != len(core):
        return False  # letters with a hyphen, apostrophe or dot: a word, not a key
    if core.isupper():
        return False  # an all-caps word is a label or a shout, not a value
    if any(c.isupper() for c in core[1:]) and any(c.islower() for c in core):
        return True   # internal capital (SolarPanel-like)
    # a bare word counts only right after a colon, alone in its clause, and
    # not as a common accented word or a glue word
    return after_colon and clause_end and not _has_accent(core) and core.lower() not in cfg["_glue"]


def _candidate(text: str, start: int, line_end: int, cfg: dict):
    """Scan the window after a keyword: at most `scan_tokens` tokens (glue
    words not counted), the first value-shaped one wins. Returns
    (value_start, value) or None. A placeholder ends the scan: a masked value
    is nothing to find."""
    stop = min(line_end, start + cfg["window"])
    i = start
    after_colon = False
    since_colon = 0      # non-glue tokens read since the last colon
    examined = 0
    wrapped = False
    while i < stop and examined < cfg["scan_tokens"]:
        while i < line_end and text[i] in _SEPARATORS:
            if text[i] in ":=":
                after_colon, since_colon = True, 0
            i += 1
        if i >= line_end and after_colon and examined == 0 and not wrapped and line_end < len(text):
            # "Jelszo:" alone at the end of its line: the value is on the next
            # line. One line only, and only when nothing but the label preceded.
            wrapped = True
            i = line_end + 1
            nxt = text.find("\n", i)
            line_end = len(text) if nxt < 0 else nxt
            stop = min(line_end, i + cfg["window"])
            continue
        if i >= stop:
            return None
        j = i
        while j < line_end and not text[j].isspace():
            j += 1
        raw = text[i:j]
        if text[i - 1:i] == "=":
            # a query parameter ends at & or #: "?password=abc123&next=1"
            raw = re.split(r"[&#]", raw, 1)[0]
            j = i + len(raw)
        if _PLACEHOLDER.match(raw):
            return None
        labelish = raw.endswith((":", "="))
        bare = raw.rstrip(_STRIP_TAIL).lower()
        if bare in cfg["_glue"]:
            if labelish:
                after_colon, since_colon = True, 0
            i = j
            continue
        core = normalize_value(raw)
        if labelish and core and not any(c.isdigit() for c in core):
            # a label continues the key ("jelszo a routerhez: X"): read on
            after_colon, since_colon = True, 0
            examined += 1
            i = j
            continue
        rest = text[j:line_end].lstrip(" \t")
        clause_end = rest == "" or rest[0] in ",;)"
        if core and _value_shaped(core, after_colon and since_colon == 0, clause_end, cfg):
            return (i + max(raw.find(core), 0), core)
        examined += 1
        since_colon += 1
        i = j
    return None


def prepare_text(text: str) -> str:
    """HTML tags out (each replaced by a space, newlines kept, so line numbers
    stay), entities decoded. A plain-text letter passes unchanged apart from
    the entity decoding."""
    return html.unescape(_TAG.sub(" ", text or ""))


def detect(text: str, cfg: dict, fingerprint) -> list:
    """Hits in the letter: [{"keyword", "line", "length", "fp"}], sorted by
    position, one per value. The value itself is never returned."""
    text = prepare_text(text)
    found = {}
    for m in cfg["_kw_re"].finditer(text):
        # inside a URL ("/login?next=..."), a keyword is a path or a parameter
        # name: only "keyword=value" there is a credential
        tok_start = max(text.rfind(ws, 0, m.start()) for ws in (" ", "\n", "\t")) + 1
        head = text[tok_start:m.start()].lower()
        if ("://" in head or head.startswith("www.")) and text[m.end():m.end() + 1] != "=":
            continue
        line_end = text.find("\n", m.end())
        line_end = len(text) if line_end < 0 else line_end
        got = _candidate(text, m.end(), line_end, cfg)
        if got and got[0] not in found:
            found[got[0]] = (m.group(0).lower(), got[1])
    for m in _URL_USERINFO.finditer(text):
        value = normalize_value(m.group(1))
        if len(value) >= cfg["min_length"] and m.start(1) not in found:
            found[m.start(1)] = ("url", value)
    hits = []
    for pos in sorted(found):
        keyword, value = found[pos]
        hits.append({"keyword": keyword, "line": text.count("\n", 0, pos) + 1,
                     "length": len(value), "fp": fingerprint(value)})
    return hits


# --- state --------------------------------------------------------------------
EMPTY_STATE = {"version": 1, "shared": {}, "acks": [], "seen": {}, "aliases": {}}


class State:
    """`with State() as st:` holds an exclusive lock for the whole
    read-modify-write; `st.data` is written back atomically on a clean exit."""

    def __init__(self, write: bool = True):
        self.write = write
        self.path = state_path()
        self.data = None
        self._lock = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self._lock = open(self.path + ".lock", "a")
        fcntl.flock(self._lock, fcntl.LOCK_EX)
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError) as exc:
                self.__exit__(None, None, None)
                raise GateConfigError(f"az allapotfajl nem olvashato ({self.path}: {exc})")
            if not isinstance(data, dict) or any(not isinstance(data.get(k), type(v))
                                                 for k, v in EMPTY_STATE.items() if k != "version"):
                self.__exit__(None, None, None)
                raise GateConfigError(f"az allapotfajl szerkezete hibas ({self.path})")
            self.data = data
        else:
            self.data = json.loads(json.dumps(EMPTY_STATE))
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None and self.write and self.data is not None:
                tmp = f"{self.path}.tmp.{os.getpid()}"
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self.data, fh, ensure_ascii=False, indent=1, sort_keys=True)
                os.replace(tmp, self.path)
        finally:
            if self._lock:
                fcntl.flock(self._lock, fcntl.LOCK_UN)
                self._lock.close()
                self._lock = None
        return False


def recipients_of(env: dict) -> list:
    """Every recipient (to, cc, bcc) as a bare, lowercased address: a display
    name or a different spelling of the same address must not make one
    customer look like two."""
    out = set()
    for key in ("to", "cc", "bcc"):
        for raw in env.get(key) or []:
            raw = str(raw).strip()
            if raw.lower().startswith("messageid:"):
                out.add(raw.lower())
                continue
            for _name, addr in email.utils.getaddresses([raw]):
                addr = (addr or "").strip().lower()
                if addr:
                    out.add(addr)
    return sorted(out)


def alias_anchor(fp: str, recipients) -> str:
    """The approval hash of an alias: the fingerprint and the allowed
    recipient set, canonical. An approval for one set cannot answer another."""
    canon = json.dumps({"fp": fp, "recipients": sorted({r.strip().lower() for r in recipients})},
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def resolve_fp(data: dict, prefix: str) -> str:
    """A full fingerprint from the 8-hex prefix shown in logs and deny
    messages. Unknown or ambiguous prefixes raise; nothing is guessed."""
    prefix = prefix.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8,64}", prefix):
        raise GateConfigError(f"az ujjlenyomat 8-64 hex jegy kell legyen: {prefix!r}")
    pool = set(data["seen"]) | set(data["shared"]) | set(data["aliases"])
    for ack in data["acks"]:
        pool.update(ack.get("fps") or [])
    matches = sorted(fp for fp in pool if fp.startswith(prefix))
    if not matches:
        raise GateConfigError(f"ismeretlen ujjlenyomat: {prefix}")
    if len(matches) > 1:
        raise GateConfigError(f"az elotag tobb ujjlenyomatra illik: {prefix}")
    return matches[0]


def now_stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def append_log(entry: dict) -> None:
    """One JSON line. Never a value or the letter's text: hits carry keyword,
    line, length and the 8-hex fingerprint prefix only. OSError propagates;
    the gate turns an unlogged decision into a deny."""
    entry = dict(entry, ts=now_stamp())
    path = log_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def public_hits(hits: list) -> list:
    return [{"keyword": h["keyword"], "line": h["line"], "length": h["length"], "fp8": h["fp"][:8]}
            for h in hits]
