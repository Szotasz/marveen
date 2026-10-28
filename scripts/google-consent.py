#!/usr/bin/env python3
"""One Google consent for every Google token consumer of an installation.

Several Google clients on one machine (the Gmail, Calendar and Drive MCP servers,
small API scripts) each keep their own token file, and each one normally asks for
its own consent. With one OAuth client that means several refresh tokens that
expire, get revoked or drift apart independently. This helper asks for ONE consent
(phone friendly: the owner opens a URL, approves, and copies the
http://localhost/?state=...&code=... address back) and writes the resulting refresh token
into every configured consumer file, each in that file's own format.

CONFIG (required, untracked, install-specific): store/google-consent.json, or the
path in GOOGLE_CONSENT_CONFIG / --config. The code holds no install-specific path,
client or scope list. Example: scripts/google-consent.example.json. Keys:

  client_file   path of the OAuth client JSON downloaded from Google Cloud
                ("installed" or "web" section with client_id + client_secret)
  state_dir     where the PKCE/state and parking files go (default: store/ of the
                install; relative paths are relative to the install root)
  mcp_scan_root directory whose .mcp.json (and agents/*/.mcp.json) is checked for
                MCP servers that use a DIFFERENT OAuth client (default: install root)
  consumers     {name: {format, path, scopes, label?, account?, process?, separate?}}
      format    gmail-mcp     {"tokens": {...}, "scopes": [short names]}
                google-auth   google-auth-library token dict; with "account" the dict
                              sits under that key (e.g. the Calendar MCP's "normal")
                drive-mcp-v2  {"version": 2, "accounts": {alias: {...}}, "defaultAccount"}
                raw           the token endpoint response + obtained_at (seconds)
      scopes    the floor of scopes this consumer needs. Full URLs, or short names
                that get the https://www.googleapis.com/auth/ prefix. The scopes a
                consumer file already carries are added on top, so `link` never
                drops a scope a consumer uses today.
      process   optional node binary name (e.g. "google-drive-mcp"): running copies
                are listed after a write, because they keep the old token in memory
      separate  true: this consumer gets its OWN consent (`--only NAME`), never part
                of the union. Use it for scopes Google refuses to combine with the
                union in one request (seen: drive.file together with youtube.upload
                -> "400 invalid_request ... scopes that cannot be requested together").

Commands:

  google-consent.py link [--only NAME]
      Prints ONE consent URL on stdout (PKCE S256 + state). The verifier and state
      go to <state_dir>/.google-consent[-NAME]-pkce.json (0600). The last 5 links
      stay redeemable, each for 60 minutes. No network call.

  google-consent.py redeem '<pasted http://localhost/?state=...&code=... URL>' [--only NAME] [--dry-run] [--partial]
      Refuses a code that is not bound to a link this helper issued (no state, a
      state no `link` issued, or a link older than 60 minutes: exit 2, no network
      call, nothing written), and refuses to write through a symlinked token path; the exchange
      always sends that link's PKCE code_verifier. Then redeems the code, checks the
      granted scopes against every consumer, and warns when the response carries
      refresh_token_expires_in (the OAuth app is still in "Testing": the token dies
      in 7 days). Then backs up each consumer file (0600, timestamped, byte copy) and
      rewrites it (atomic, 0600).
      --dry-run  every check plus the list of files and keys that would change, but
                 NO token file is written. The code is single use, so the exchanged
                 response is parked in <state_dir>/.google-consent[-NAME]-pending.json
                 (0600) and the next `redeem` of the SAME URL reuses it.
      --partial  on a scope shortfall still write the consumers that ARE covered
                 (default: write nothing). Refused with --only.
      --only     a separate consumer: the grant must carry EXACTLY its scopes, and
                 only its file is written.

  google-consent.py status
      Offline report: per consumer file its mode, which files share one refresh
      token (group letters, no token material), whether an expiry field is present,
      and scope coverage. No network call.

Exit codes: 0 ok, 1 error (also config error), 2 usage or a refused code (no state, or a
state that belongs to no issued link: nothing is redeemed or written), 3 scope shortfall (separate
consent: granted scopes not exactly the requested ones), 4 written/checked but the
response carries refresh_token_expires_in.

Secrets (client secret, access/refresh tokens, PKCE verifier) are never printed.
Only `redeem` makes a network call (to oauth2.googleapis.com).
GOOGLE_CONSENT_TOKEN_URL may point the token exchange at a loopback http:// test
endpoint; any other value is refused.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
DEFAULT_REDIRECT = "http://localhost"
G = "https://www.googleapis.com/auth/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FORMATS = ("gmail-mcp", "google-auth", "drive-mcp-v2", "raw")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
KEEP_LINKS = 5
LINK_TTL = 3600  # seconds a consent link stays redeemable

# The Gmail MCP keeps short scope names in its top-level "scopes" list (tool filter).
GMAIL_SHORT = {
    "gmail.readonly": G + "gmail.readonly",
    "gmail.modify": G + "gmail.modify",
    "gmail.compose": G + "gmail.compose",
    "gmail.send": G + "gmail.send",
    "gmail.labels": G + "gmail.labels",
    "gmail.full": "https://mail.google.com/",
    "gmail.settings.basic": G + "gmail.settings.basic",
    "gmail.settings.sharing": G + "gmail.settings.sharing",
}

# Env keys of the public Google MCP packages that name an OAuth client file, and the
# ones that move the token file somewhere this helper does not write.
MCP_CLIENT_KEYS = ("GOOGLE_DRIVE_OAUTH_CREDENTIALS", "GOOGLE_OAUTH_CREDENTIALS", "GMAIL_OAUTH_PATH")
MCP_PATH_OVERRIDES = ("GOOGLE_DRIVE_MCP_TOKEN_PATH", "GOOGLE_CALENDAR_MCP_TOKEN_PATH",
                      "GMAIL_CREDENTIALS_PATH", "GOOGLE_DRIVE_MCP_CLIENT_ID",
                      "GOOGLE_DRIVE_MCP_REFRESH_TOKEN")


class ConfigError(Exception):
    pass


class UnsafePath(Exception):
    """A path this helper would write through is a symlink."""


# ---------------------------------------------------------------- small io helpers

def err(*a):
    print(*a, file=sys.stderr)


def read_json(path):
    with open(path) as f:
        return json.load(f)


def makedirs_private(d):
    """Create every MISSING level of d with mode 0700 (os.makedirs applies its mode to
    the leaf only). Existing directories are left as they are."""
    if not d or os.path.isdir(d):
        return
    missing = []
    while d and not os.path.isdir(d):
        missing.append(d)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    for p in reversed(missing):
        try:
            os.mkdir(p, 0o700)
        except FileExistsError:
            if not os.path.isdir(p):
                raise
            continue
        os.chmod(p, 0o700)  # mkdir's mode is masked by the umask


def refuse_symlink(path):
    if os.path.islink(path):
        raise UnsafePath("refusing to write through a symlink: %s" % path)


def write_private(path, text):
    """Atomic write, final mode 0600, missing parent dirs created 0700. The temp file is
    a fresh mkstemp name in the same dir (O_EXCL, never follows a planted link), and a
    target that is a symlink is refused instead of being replaced or followed."""
    d = os.path.dirname(path) or "."
    makedirs_private(d)
    refuse_symlink(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".%s.tmp." % os.path.basename(path))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def backup(path, stamp):
    """Byte-exact copy next to the original, mode 0600, never overwrites."""
    refuse_symlink(path)
    with open(path, "rb") as f:
        raw = f.read()
    base = "%s.bak-%s" % (path, stamp)
    target, n = base, 1
    while True:
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            target = "%s.%d" % (base, n)
            n += 1
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    os.chmod(target, 0o600)
    return target


def dump_like(original_text, data):
    """Keep the file's layout: pretty (indent 2) if it was multi-line, else compact."""
    if original_text is None or "\n" in original_text.strip():
        return json.dumps(data, indent=2)
    return json.dumps(data)


def split_scope(s):
    return [x for x in (s or "").split() if x] if isinstance(s, str) else []


def full_scope(s):
    return s if "://" in s else G + s


def short_scope(s):
    return s[len(G):] if s.startswith(G) else s


def uniq(seq):
    out = []
    for s in seq:
        if s not in out:
            out.append(s)
    return out


# ---------------------------------------------------------------- config

def config_path(cli_value=None):
    return cli_value or os.environ.get("GOOGLE_CONSENT_CONFIG") or os.path.join(
        ROOT, "store", "google-consent.json")


def _path(value, base):
    p = os.path.expanduser(value)
    return p if os.path.isabs(p) else os.path.join(base, p)


def load_config(path):
    """Validated config: {client_file, state_dir, scan_root, redirect, consumers, union, separate}."""
    if not os.path.isfile(path):
        raise ConfigError("no config: %s (example: scripts/google-consent.example.json)" % path)
    try:
        raw = read_json(path)
    except (OSError, ValueError) as e:
        raise ConfigError("config not readable as JSON: %s (%s)" % (path, type(e).__name__))
    if not isinstance(raw, dict):
        raise ConfigError("config must be a JSON object: %s" % path)
    if not isinstance(raw.get("client_file"), str) or not raw["client_file"]:
        raise ConfigError("client_file is required")
    cons = raw.get("consumers")
    if not isinstance(cons, dict) or not cons:
        raise ConfigError("consumers must be a non-empty object")
    out = {
        "client_file": _path(raw["client_file"], ROOT),
        "state_dir": _path(raw.get("state_dir") or "store", ROOT),
        "scan_root": _path(raw.get("mcp_scan_root") or ".", ROOT),
        "redirect": raw.get("redirect_uri") or DEFAULT_REDIRECT,
        "consumers": {},
    }
    paths = {}
    for name, c in cons.items():
        if name.startswith("_"):
            continue
        if not NAME_RE.match(name):
            raise ConfigError("consumer name %r: use a-z, 0-9, '-' or '_'" % name)
        if not isinstance(c, dict):
            raise ConfigError("consumer %s: must be an object" % name)
        fmt = c.get("format")
        if fmt not in FORMATS:
            raise ConfigError("consumer %s: format must be one of %s" % (name, ", ".join(FORMATS)))
        if not isinstance(c.get("path"), str) or not c["path"]:
            raise ConfigError("consumer %s: path is required" % name)
        scopes = c.get("scopes")
        if not isinstance(scopes, list) or not scopes or not all(
                isinstance(s, str) and s.strip() and " " not in s for s in scopes):
            raise ConfigError("consumer %s: scopes must be a non-empty list of scope strings" % name)
        p = os.path.abspath(_path(c["path"], ROOT))
        if p in paths:
            raise ConfigError("consumers %s and %s share one path" % (paths[p], name))
        paths[p] = name
        if fmt != "google-auth" and "account" in c:
            raise ConfigError("consumer %s: account only applies to format google-auth" % name)
        if "account" in c and (not isinstance(c["account"], str) or not c["account"]):
            raise ConfigError("consumer %s: account must be a non-empty string" % name)
        separate = c.get("separate", False)
        if not isinstance(separate, bool):
            raise ConfigError("consumer %s: separate must be true or false" % name)
        if separate and fmt != "raw":
            raise ConfigError("consumer %s: a separate consumer must use format raw" % name)
        out["consumers"][name] = {
            "name": name, "label": str(c.get("label") or name), "format": fmt, "path": p,
            "scopes": uniq(full_scope(s.strip()) for s in scopes),
            "account": c.get("account"), "process": c.get("process"), "separate": separate,
        }
    out["union"] = [n for n, c in out["consumers"].items() if not c["separate"]]
    out["separate"] = [n for n, c in out["consumers"].items() if c["separate"]]
    union_floor = {s for n in out["union"] for s in out["consumers"][n]["scopes"]}
    for n in out["separate"]:
        clash = [s for s in out["consumers"][n]["scopes"] if s in union_floor]
        if clash:
            raise ConfigError("separate consumer %s shares scopes with the union: %s"
                              % (n, ", ".join(clash)))
    if not out["union"] and not out["separate"]:
        raise ConfigError("consumers must name at least one consumer")
    return out


def separate_scopes(cfg):
    return {s for n in cfg["separate"] for s in cfg["consumers"][n]["scopes"]}


def pkce_file(cfg, only=None):
    return os.path.join(cfg["state_dir"], ".google-consent%s-pkce.json" % ("-" + only if only else ""))


def pending_file(cfg, only=None):
    return os.path.join(cfg["state_dir"], ".google-consent%s-pending.json" % ("-" + only if only else ""))


# ---------------------------------------------------------------- client

def load_client(cfg):
    """(client_id, client_secret). Raises ConfigError without echoing the file."""
    try:
        d = read_json(cfg["client_file"])
        c = d.get("installed") or d.get("web") or d[next(iter(d))]
        return c["client_id"], c["client_secret"]
    except (OSError, ValueError, KeyError, TypeError, StopIteration, AttributeError) as e:
        raise ConfigError("OAuth client file not usable: %s (%s)" % (cfg["client_file"], type(e).__name__))


# ---------------------------------------------------------------- consumer formats
#
# `tok` is the normalized token response:
#   access_token, refresh_token, scope, token_type, expires_in, expiry_date (ms),
#   obtained_at (s), refresh_token_expires_in (only if Google sent it).

def _set_snake(entry, tok, prefix, changed):
    """Update a google-auth-library style token dict in place."""
    for k in ("access_token", "refresh_token", "scope", "token_type", "expiry_date"):
        if entry.get(k) != tok[k]:
            entry[k] = tok[k]
            changed.append(prefix + k)
    if "refresh_token_expires_in" in tok:
        entry["refresh_token_expires_in"] = tok["refresh_token_expires_in"]
        changed.append(prefix + "refresh_token_expires_in")
    elif "refresh_token_expires_in" in entry:
        del entry["refresh_token_expires_in"]
        changed.append("-" + prefix + "refresh_token_expires_in")


def _gmail_entry(c, data):
    return data.get("tokens") if isinstance(data.get("tokens"), dict) else data


def _gmail_scopes(c, data):
    out = split_scope(_gmail_entry(c, data).get("scope"))
    short = data.get("scopes")
    for s in short if isinstance(short, list) else []:
        if s in GMAIL_SHORT:
            out.append(GMAIL_SHORT[s])
    return out


def _gmail_apply(c, data, tok):
    changed = []
    if data is None:
        inv = {v: k for k, v in GMAIL_SHORT.items()}
        data = {"tokens": {}, "scopes": [inv[s] for s in c["scopes"] if s in inv]}
        changed.append("+scopes")
    if isinstance(data.get("tokens"), dict):
        _set_snake(data["tokens"], tok, "tokens.", changed)
    else:
        _set_snake(data, tok, "", changed)
    return data, changed


def _ga_entry(c, data):
    acct = c.get("account")
    if acct and isinstance(data.get(acct), dict):
        return data[acct]
    if "access_token" in data or "refresh_token" in data:  # flat file
        return data
    return {}


def _ga_apply(c, data, tok):
    changed = []
    acct = c.get("account")
    if data is None:
        data = {}
    if acct and isinstance(data.get(acct), dict):
        _set_snake(data[acct], tok, acct + ".", changed)
    elif "access_token" in data or "refresh_token" in data or not acct:
        _set_snake(data, tok, "", changed)
    else:
        data[acct] = {}
        _set_snake(data[acct], tok, acct + ".", changed)
    return data, changed


def _drive_alias(data):
    accounts = data.get("accounts") if isinstance(data.get("accounts"), dict) else {}
    alias = data.get("defaultAccount")
    if alias in accounts:
        return alias
    if len(accounts) == 1:
        return next(iter(accounts))
    return "default"


def _drive_entry(c, data):
    accounts = data.get("accounts") if isinstance(data.get("accounts"), dict) else {}
    rec = accounts.get(_drive_alias(data))
    return rec if isinstance(rec, dict) else {}


def _drive_apply(c, data, tok):
    changed = []
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(tok["obtained_at"]))
    if data is None:
        data = {"version": 2, "accounts": {}, "defaultAccount": "default"}
        changed.append("+defaultAccount")
    if not isinstance(data.get("accounts"), dict):
        data["accounts"] = {}
    alias = _drive_alias(data)
    rec = data["accounts"].get(alias)
    if not isinstance(rec, dict):
        # Same shape the Drive MCP itself builds when migrating a v1 file.
        rec = {"alias": alias, "email": "unknown",
               "sub": hashlib.sha256(tok["refresh_token"].encode()).hexdigest()[:24],
               "addedAt": now_iso, "pendingIdentity": True}
        data["accounts"][alias] = rec
        changed.append("+accounts.%s" % alias)
    mapping = {"accessToken": tok["access_token"], "refreshToken": tok["refresh_token"],
               "scope": tok["scope"], "tokenType": tok["token_type"],
               "expiryDate": tok["expiry_date"], "lastRefreshedAt": now_iso}
    for k, v in mapping.items():
        if rec.get(k) != v:
            rec[k] = v
            changed.append("accounts.%s.%s" % (alias, k))
    return data, changed


def _raw_apply(c, data, tok):
    changed = []
    if data is None:
        data = {}
    for k in ("access_token", "expires_in", "refresh_token", "scope", "token_type", "obtained_at"):
        if data.get(k) != tok[k]:
            data[k] = tok[k]
            changed.append(k)
    if "refresh_token_expires_in" in tok:
        data["refresh_token_expires_in"] = tok["refresh_token_expires_in"]
        changed.append("refresh_token_expires_in")
    elif "refresh_token_expires_in" in data:
        del data["refresh_token_expires_in"]
        changed.append("-refresh_token_expires_in")
    return data, changed


FORMAT_IMPL = {
    "gmail-mcp": {"entry": _gmail_entry, "scopes": _gmail_scopes,
                  "refresh_key": "refresh_token", "apply": _gmail_apply},
    "google-auth": {"entry": _ga_entry,
                    "scopes": lambda c, d: split_scope(_ga_entry(c, d).get("scope")),
                    "refresh_key": "refresh_token", "apply": _ga_apply},
    "drive-mcp-v2": {"entry": _drive_entry,
                     "scopes": lambda c, d: split_scope(_drive_entry(c, d).get("scope")),
                     "refresh_key": "refreshToken", "apply": _drive_apply},
    "raw": {"entry": lambda c, d: d, "scopes": lambda c, d: split_scope(d.get("scope")),
            "refresh_key": "refresh_token", "apply": _raw_apply},
}


def load_token_file(path):
    """Returns (data or None, raw_text or None, problem or None)."""
    if not os.path.exists(path):
        return None, None, "missing"
    try:
        with open(path) as f:
            text = f.read()
        data = json.loads(text)
        if not isinstance(data, dict):
            return None, text, "not a JSON object"
        return data, text, None
    except (OSError, ValueError) as e:
        return None, None, "unreadable (%s)" % type(e).__name__


def required_scopes(cfg, name, data):
    c = cfg["consumers"][name]
    req = list(c["scopes"])
    if data is not None:
        try:
            # A separate-consent scope found in a union file (Google returns every
            # scope ever granted to the client when include_granted_scopes=true) must
            # not leak back into the union request: Google refuses the combination.
            sep = separate_scopes(cfg)
            req += [s for s in FORMAT_IMPL[c["format"]]["scopes"](c, data) if s not in sep]
        except Exception:  # a malformed file must not hide the configured floor
            pass
    return uniq(req)


def union_scopes(cfg):
    out = []
    for n in cfg["union"]:
        data, _, _ = load_token_file(cfg["consumers"][n]["path"])
        out += required_scopes(cfg, n, data)
    return uniq(out)


# ---------------------------------------------------------------- PKCE / state store

def load_pkce(path):
    try:
        d = read_json(path)
    except (OSError, ValueError):
        return {"entries": []}
    if not isinstance(d, dict) or not isinstance(d.get("entries"), list):
        return {"entries": []}
    d["entries"] = [e for e in d["entries"] if isinstance(e, dict)]  # a malformed entry is dropped
    return d


def save_pkce(d, path):
    d["entries"] = d["entries"][-KEEP_LINKS:]
    write_private(path, json.dumps(d, indent=2))


def drop_pkce_state(state, path):
    d = load_pkce(path)
    d["entries"] = [e for e in d["entries"] if e.get("state") != state]
    save_pkce(d, path)


def new_pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge, secrets.token_urlsafe(16)


# ---------------------------------------------------------------- link

def cmd_link(cfg, args):
    only = args.only
    if only:
        scopes = list(cfg["consumers"][only]["scopes"])
    else:
        if not cfg["union"]:
            err("ERROR: every configured consumer is separate; use `link --only NAME`.")
            return 2
        scopes = union_scopes(cfg)
        leaked = [s for s in scopes if s in separate_scopes(cfg)]
        if leaked:
            # Google refuses the whole consent with these together (400 invalid_request).
            err("INTERNAL ERROR: a separate-consent scope in the union link: %s" % ", ".join(leaked))
            return 1
    cid, _ = load_client(cfg)
    verifier, challenge, state = new_pkce()
    path = pkce_file(cfg, only)
    d = load_pkce(path)
    d["entries"].append({"state": state, "verifier": verifier,
                         "created": int(time.time()), "scopes": scopes})
    save_pkce(d, path)
    q = urllib.parse.urlencode({
        "client_id": cid,
        "redirect_uri": cfg["redirect"],
        "response_type": "code",
        "scope": " ".join(scopes),
        "access_type": "offline",
        "prompt": "consent",
        # A separate token must not pick up the union scopes granted earlier.
        "include_granted_scopes": "false" if only else "true",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    print(AUTH_URL + "?" + q)
    err("%s%d scopes requested:" % ("SEPARATE consent (%s), " % only if only else "", len(scopes)))
    for s in scopes:
        err("  " + s)
    err("PKCE verifier + state: %s (0600). Redeem with: redeem %s'<URL>'. The last %d links stay"
        " valid, each for %d minutes." % (path, "--only %s " % only if only else "", KEEP_LINKS, LINK_TTL // 60))
    return 0


# ---------------------------------------------------------------- redeem

def parse_pasted(raw):
    """Returns (code, state, error). Input without a state (a bare code, or a URL with the
    state stripped) is parsed with state None, and every caller refuses it (_obtain)."""
    raw = raw.strip().replace("&amp;", "&")
    if "://" in raw or raw.startswith("localhost"):
        if not raw.startswith("http"):
            raw = "http://" + raw
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query)
        if "error" in qs:
            return None, None, "Google returned an error: %s" % qs["error"][0]
        if "code" not in qs:
            return None, None, "no code in the pasted URL"
        return qs["code"][0], (qs.get("state") or [None])[0], None
    if not raw:
        return None, None, "empty input"
    return raw, None, None


def token_url():
    override = os.environ.get("GOOGLE_CONSENT_TOKEN_URL")
    if not override:
        return TOKEN_URL
    host = urllib.parse.urlparse(override).hostname
    if not override.startswith("http://") or host not in ("127.0.0.1", "localhost", "::1"):
        raise ConfigError("GOOGLE_CONSENT_TOKEN_URL must be a loopback http:// test endpoint")
    return override


def exchange_code(cfg, code, verifier):
    """POST to the token endpoint. Returns the parsed JSON response or raises SystemExit."""
    if not verifier:
        # Never redeem a code that is not bound to an issued PKCE link (see _obtain).
        raise ConfigError("refusing a token exchange without a PKCE code_verifier")
    cid, secret = load_client(cfg)
    data = {"code": code, "client_id": cid, "client_secret": secret,
            "redirect_uri": cfg["redirect"], "grant_type": "authorization_code",
            "code_verifier": verifier}
    req = urllib.request.Request(token_url(), data=urllib.parse.urlencode(data).encode(),
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
            detail = "%s: %s" % (body.get("error"), body.get("error_description", ""))
        except Exception:
            detail = "HTTP %s" % e.code
        err("ERROR redeeming the code: %s" % detail)
        if "invalid_grant" in detail:
            err("  (a code is single use and expires within minutes; run `link` again and"
                " approve the NEW link)")
        raise SystemExit(1)
    except (urllib.error.URLError, OSError, ValueError) as e:
        err("ERROR redeeming the code: token endpoint not usable (%s)" % type(e).__name__)
        raise SystemExit(1)
    if not isinstance(resp, dict):
        err("ERROR redeeming the code: the token endpoint did not return a JSON object")
        raise SystemExit(1)
    return resp


def code_key(code):
    return hashlib.sha256(code.encode()).hexdigest()[:24]


def load_pending(path):
    try:
        d = read_json(path)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_pending(d, path):
    write_private(path, json.dumps(d))


def normalize(resp, obtained_at):
    tok = {
        "access_token": resp["access_token"],
        "refresh_token": resp["refresh_token"],
        "scope": resp.get("scope", ""),
        "token_type": resp.get("token_type", "Bearer"),
        "expires_in": int(resp.get("expires_in", 3599)),
        "obtained_at": int(obtained_at),
    }
    tok["expiry_date"] = tok["obtained_at"] * 1000 + tok["expires_in"] * 1000
    if "refresh_token_expires_in" in resp:
        tok["refresh_token_expires_in"] = resp["refresh_token_expires_in"]
    return tok


def check_client_consistency(cfg):
    """A refresh token only works with the client_id it was issued to, so every Google
    MCP of the install must use the same OAuth client as this helper."""
    problems = []
    our_cid, _ = load_client(cfg)
    ours = os.path.abspath(cfg["client_file"])
    root = cfg["scan_root"]
    files = [os.path.join(root, ".mcp.json")]
    adir = os.path.join(root, "agents")
    if os.path.isdir(adir):
        files += [os.path.join(adir, a, ".mcp.json") for a in sorted(os.listdir(adir))]
    for f in files:
        if not os.path.isfile(f):
            continue
        try:
            servers = read_json(f).get("mcpServers") or {}
        except (OSError, ValueError, AttributeError):
            continue
        if not isinstance(servers, dict):
            continue
        for sname, conf in servers.items():
            env = (conf or {}).get("env") if isinstance(conf, dict) else None
            if not isinstance(env, dict):
                continue
            for k in MCP_CLIENT_KEYS:
                p = env.get(k)
                if not isinstance(p, str) or not p or os.path.abspath(os.path.expanduser(p)) == ours:
                    continue
                try:
                    d = read_json(os.path.expanduser(p))
                    c = d.get("installed") or d.get("web") or {}
                    if c.get("client_id") != our_cid:
                        problems.append("%s / %s: uses a different OAuth client (%s)" % (f, sname, p))
                except (OSError, ValueError, AttributeError):
                    problems.append("%s / %s: OAuth client file not readable (%s)" % (f, sname, p))
            for k in MCP_PATH_OVERRIDES:
                if k in env:
                    problems.append("%s / %s: %s is set; the MCP may ignore the token file this helper writes"
                                    % (f, sname, k))
    return problems


def running_mcp_sessions(cfg):
    """cwd -> sorted process names, for running copies of the configured `process`es (Linux /proc)."""
    names = uniq(c["process"] for c in cfg["consumers"].values()
                 if isinstance(c.get("process"), str) and c["process"])
    out = {}
    if not names:
        return out
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return out
    for pid in pids:
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace")
            if not cmd.startswith("node "):
                continue
            hit = [n for n in names if "/.bin/" + n in cmd]
            if not hit:
                continue
            cwd = os.readlink("/proc/%s/cwd" % pid)
        except OSError:
            continue
        out.setdefault(cwd, set()).update(hit)
    return {k: sorted(v) for k, v in out.items()}


def _obtain(cfg, code, state, only):
    """(resp, obtained_at, pending, key) or an int exit code. Reuses a parked response."""
    pend_path, pkce_path = pending_file(cfg, only), pkce_file(cfg, only)
    pending = load_pending(pend_path)
    key = code_key(code)
    # A code is redeemed ONLY when it is bound to a link this helper issued: the pasted
    # URL's state must match a stored PKCE entry, and the exchange always sends that
    # entry's code_verifier. A bare code (or a URL with the state stripped) could be a
    # code someone obtained for THEIR OWN account on this client id; redeeming it would
    # bind every consumer to that account.
    if not state:
        err("ERROR: the pasted input carries no state, so it cannot be tied to a link this"
            " helper issued. Nothing was redeemed. Paste the WHOLE http://localhost/?state=...&code=..."
            " address of the link from `link%s`." % (" --only " + only if only else ""))
        return 2
    if key in pending and isinstance(pending[key], dict) and isinstance(pending[key].get("response"), dict):
        if pending[key].get("state") != state:
            err("ERROR: this code was already redeemed for a different link (state mismatch)."
                " Nothing was written.")
            return 2
        err("This code was already redeemed (--dry-run); reusing the parked response.")
        return pending[key]["response"], pending[key].get("obtained_at", int(time.time())), pending, key
    entries = load_pkce(pkce_path)["entries"]
    entry = next((e for e in entries if e.get("state") == state), None)
    if entry is None:
        err("ERROR: the state of the pasted URL belongs to no link issued by `link%s`."
            " Nothing was redeemed." % (" --only " + only if only else ""))
        other = [o for o in [None] + cfg["separate"] if o != only
                 and any(e.get("state") == state for e in load_pkce(pkce_file(cfg, o))["entries"])]
        if other:
            o = other[0]
            err("  It answers %s: redeem it %s." % (
                "the UNION link" if o is None else "`link --only %s`" % o,
                "without --only" if o is None else "with --only %s" % o))
        else:
            err("  Run `link` again and approve the NEW link.")
        return 2
    created = entry.get("created")
    if (not isinstance(created, (int, float)) or isinstance(created, bool)
            or not -300 < time.time() - created <= LINK_TTL):
        err("ERROR: this link is older than %d minutes (or has no valid creation time)."
            " Nothing was redeemed; run `link` again and approve the NEW link." % (LINK_TTL // 60))
        return 2
    verifier = entry.get("verifier")
    if not isinstance(verifier, str) or not verifier:
        err("ERROR: the issued link has no PKCE verifier on record (%s). Nothing was redeemed;"
            " run `link` again." % pkce_path)
        return 2
    resp = exchange_code(cfg, code, verifier)
    obtained_at = int(time.time())
    pending[key] = {"obtained_at": obtained_at, "state": state, "response": resp}
    save_pending(pending, pend_path)
    return resp, obtained_at, pending, key


def _testing_warning(resp, relink):
    if "refresh_token_expires_in" in resp:
        try:
            days = "%.1f days" % (float(resp["refresh_token_expires_in"]) / 86400)
        except (TypeError, ValueError):
            days = "unknown"
        err("")
        err("!!! WARNING: the response carries refresh_token_expires_in (%s)." % days)
        err("!!! The OAuth app is still in 'Testing' (or time-limited access was chosen).")
        err("!!! This token will expire too. Publish the app, then a new `%s` + consent." % relink)
        return True
    print("Durability: no refresh_token_expires_in in the response (not a 7-day token).")
    return False


def _cleanup(cfg, pending, key, state, only):
    pend_path = pending_file(cfg, only)
    pending.pop(key, None)
    if pending:
        save_pending(pending, pend_path)
    elif os.path.exists(pend_path):
        os.unlink(pend_path)
    drop_pkce_state(state, pkce_file(cfg, only))


def _write_one(c, data, text, problem, tok, stamp, dry_run):
    if problem is not None and problem != "missing":
        # Unreadable file: keep a byte copy, then rebuild it in the consumer's format.
        text = None
    old = json.loads(json.dumps(data)) if data is not None else None
    new, changed = FORMAT_IMPL[c["format"]]["apply"](c, old, tok)
    path = c["path"]
    print("  %s %s" % ("NEW FILE" if data is None else "changes", path))
    print("      keys: %s" % (", ".join(changed) if changed else "(no change)"))
    if dry_run:
        if os.path.exists(path):
            print("      backup would be: %s.bak-%s (0600)" % (path, stamp))
        return
    if os.path.exists(path):
        print("      backup: %s (0600)" % backup(path, stamp))
    write_private(path, dump_like(text, new))


def _no_tokens(resp):
    if not all(isinstance(resp.get(k), str) and resp.get(k) for k in ("refresh_token", "access_token")):
        err("ERROR: the response has no refresh_token/access_token. Fields: %s"
            % sorted(k for k in resp if "token" not in k or k.endswith("expires_in")))
        return True
    return False


def _token(resp, obtained_at):
    """normalize(), or None with a clean error when a field has the wrong type."""
    try:
        return normalize(resp, obtained_at)
    except (TypeError, ValueError, OverflowError):
        err("ERROR: the token response has a malformed field (expires_in / obtained_at)."
            " Nothing was written; run `link` again.")
        return None


def _refuse_symlinked_targets(paths):
    """Before the first write: a symlinked token path is refused (exit 2), nothing written."""
    bad = [p for p in paths if os.path.islink(p)]
    for p in bad:
        err("ERROR: %s is a symlink; this helper does not write through links. Point the"
            " consumer's path at the real file." % p)
    if bad:
        err("NOTHING was written.")
        return True
    return False


def cmd_redeem_separate(cfg, args):
    only = args.only
    c = cfg["consumers"][only]
    if args.partial:
        err("ERROR: --partial has no meaning for a separate consent (--only %s)." % only)
        return 2
    code, state, perr = parse_pasted(args.url)
    if perr:
        err("ERROR:", perr)
        return 1
    got = _obtain(cfg, code, state, only)
    if isinstance(got, int):
        return got
    resp, obtained_at, pending, key = got
    if _no_tokens(resp):
        return 1
    tok = _token(resp, obtained_at)
    if tok is None:
        return 1
    granted = set(split_scope(tok["scope"]))

    # The grant must be EXACTLY this consumer's scopes (no union scope merged in).
    want = list(c["scopes"])
    missing = [s for s in want if s not in granted]
    extra = sorted(granted - set(want))
    print("Scope check, separate consent (%s, %d scopes granted):" % (only, len(granted)))
    print("  %-12s %-28s %s" % (only, c["label"], "OK" if not missing and not extra else "MISMATCH"))
    for s in missing:
        print("      MISSING: %s" % s)
    for s in extra:
        print("      NOT REQUESTED: %s" % s)
    if missing or extra:
        err("")
        err("!!! SCOPE MISMATCH: the %s token must carry exactly the %d requested scopes."
            % (only, len(want)))
        err("NOTHING was written. The redeemed response is parked: %s (0600)." % pending_file(cfg, only))
        err("A new `link --only %s` + consent is needed (every checkbox ticked)." % only)
        return 3
    testing = _testing_warning(resp, "link --only %s" % only)

    if _refuse_symlinked_targets([c["path"]]):
        return 2
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    print("")
    print("DRY RUN, nothing is written:" if args.dry_run else "Writing:")
    data, text, problem = load_token_file(c["path"])
    _write_one(c, data, text, problem, tok, stamp, args.dry_run)
    if args.dry_run:
        print("")
        print("Dry run done. To write: the same command without --dry-run (the code is not redeemed again).")
        return 4 if testing else 0
    _cleanup(cfg, pending, key, state, only)
    return 4 if testing else 0


def cmd_redeem(cfg, args):
    if args.only:
        return cmd_redeem_separate(cfg, args)
    if not cfg["union"]:
        err("ERROR: every configured consumer is separate; use `redeem --only NAME`.")
        return 2
    code, state, perr = parse_pasted(args.url)
    if perr:
        err("ERROR:", perr)
        return 1
    got = _obtain(cfg, code, state, None)
    if isinstance(got, int):
        return got
    resp, obtained_at, pending, key = got
    if _no_tokens(resp):
        return 1
    tok = _token(resp, obtained_at)
    if tok is None:
        return 1
    granted = set(split_scope(tok["scope"]))

    loaded = {n: load_token_file(cfg["consumers"][n]["path"]) for n in cfg["union"]}
    missing = {}
    print("Scope coverage (%d scopes granted):" % len(granted))
    for n in cfg["union"]:
        data, _, problem = loaded[n]
        miss = [s for s in required_scopes(cfg, n, data) if s not in granted]
        if miss:
            missing[n] = miss
        note = "" if problem is None else "  (file %s, measured against the configured scopes)" % problem
        print("  %-12s %-28s %s%s" % (n, cfg["consumers"][n]["label"],
                                      "OK" if not miss else "MISSING: " + ", ".join(miss), note))
    if missing:
        err("")
        err("!!! SCOPE SHORTFALL: %s. Not every checkbox was ticked on the consent screen"
            " (or 'Select all' was not chosen)." % ", ".join(sorted(missing)))
    testing = _testing_warning(resp, "link")

    for p in check_client_consistency(cfg):
        err("WARNING: " + p)

    if missing and not args.partial:
        err("")
        err("NOTHING was written. The redeemed response is parked: %s (0600)." % pending_file(cfg))
        err("To write the covered consumers: the same command with --partial;"
            " for all of them a new `link` + consent is needed.")
        return 3

    if _refuse_symlinked_targets([cfg["consumers"][n]["path"] for n in cfg["union"] if n not in missing]):
        return 2
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    print("")
    print("DRY RUN, nothing is written:" if args.dry_run else "Writing:")
    for n in cfg["union"]:
        if n in missing:
            continue
        data, text, problem = loaded[n]
        _write_one(cfg["consumers"][n], data, text, problem, tok, stamp, args.dry_run)
    if args.dry_run:
        print("")
        print("Dry run done. To write: the same command without --dry-run (the code is not redeemed again).")
        return 3 if missing else (4 if testing else 0)

    if not missing:
        _cleanup(cfg, pending, key, state, None)
    sessions = running_mcp_sessions(cfg)
    if sessions:
        print("")
        print("IMPORTANT: these running sessions still hold the OLD refresh token in memory, and an")
        print("MCP that refreshes its token may write the old one back into its file. Restart them")
        print("now, then run `status`:")
        for cwd, names in sorted(sessions.items()):
            print("  %s  (%s)" % (cwd, ", ".join(names)))
    if missing:
        return 3
    return 4 if testing else 0


# ---------------------------------------------------------------- status

def _status_row(cfg, n, labels):
    c = cfg["consumers"][n]
    data, _, problem = load_token_file(c["path"])
    if data is None:
        return (n, c["path"], None, "-", "-", "file " + problem), None
    impl = FORMAT_IMPL[c["format"]]
    entry = impl["entry"](c, data) or {}
    rt = entry.get(impl["refresh_key"])
    grp = "NONE"
    if isinstance(rt, str) and rt:
        h = hashlib.sha256(rt.encode()).hexdigest()
        if h not in labels:
            labels[h] = chr(ord("A") + len(labels)) if len(labels) < 26 else "#%d" % len(labels)
        grp = labels[h]
    mode = oct(os.stat(c["path"]).st_mode & 0o777)
    exp = "YES (7-day?)" if "refresh_token_expires_in" in entry else "no"
    have = set(impl["scopes"](c, data))
    miss = [s for s in c["scopes"] if s not in have]
    parts = ["missing: " + ", ".join(short_scope(s) for s in miss)] if miss else []
    if c["separate"]:
        extra = sorted(have - set(c["scopes"]))
        if extra:
            parts.append("not requested: " + ", ".join(short_scope(s) for s in extra))
    return (n, c["path"], mode, grp, exp, "; ".join(parts) or "OK"), (grp if grp != "NONE" else None)


def _print_row(row):
    n, path, mode, grp, exp, cov = row
    print("%-12s %-5s %-6s %-14s %s" % (n, mode[-3:] if mode else "-", grp, exp, cov))
    print("             %s" % path)


def cmd_status(cfg, _args):
    labels, groups = {}, {}
    print("%-12s %-5s %-6s %-14s %s" % ("consumer", "mode", "token", "expiry-field", "scopes"))
    for n in cfg["union"]:
        row, grp = _status_row(cfg, n, labels)
        if grp:
            groups.setdefault(grp, []).append(n)
        _print_row(row)
    if len(groups) > 1:
        print("")
        print("WARNING: the files hold different refresh tokens (%s)."
              % "; ".join("%s=%s" % (g, ",".join(ns)) for g, ns in sorted(groups.items())))
    if cfg["separate"]:
        print("")
        print("Separate consents (not part of the shared token, `link --only NAME`):")
        for n in cfg["separate"]:
            row, grp = _status_row(cfg, n, labels)
            _print_row(row)
            if grp and grp in groups:
                print("WARNING: %s holds the same refresh token as %s (it should come from its"
                      " own consent)." % (n, ",".join(groups[grp])))
    sessions = running_mcp_sessions(cfg)
    if sessions:
        print("")
        print("Running Google MCPs (cwd):")
        for cwd, names in sorted(sessions.items()):
            print("  %s  (%s)" % (cwd, ", ".join(names)))
    return 0


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="One Google consent for every configured Google token consumer.")
    ap.add_argument("--config", help="config file (default: GOOGLE_CONSENT_CONFIG or store/google-consent.json)")
    sub = ap.add_subparsers(dest="cmd")
    lk = sub.add_parser("link", help="print the consent URL")
    lk.add_argument("--only", metavar="NAME", help="separate consent for one separate consumer")
    rd = sub.add_parser("redeem", help="redeem the pasted URL and write the token files")
    rd.add_argument("url", help="the whole http://localhost/?state=...&code=... address the browser"
                    " landed on after the consent (the state must stay in it)")
    rd.add_argument("--only", metavar="NAME", help="redeem a `link --only NAME` consent")
    rd.add_argument("--dry-run", action="store_true", help="every check, no token file written")
    rd.add_argument("--partial", action="store_true",
                    help="on a scope shortfall still write the covered consumers")
    sub.add_parser("status", help="offline report on the token files")
    args = ap.parse_args(argv)
    if args.cmd not in ("link", "redeem", "status"):
        ap.print_help(sys.stderr)
        return 2
    try:
        cfg = load_config(config_path(args.config))
        only = getattr(args, "only", None)
        if only is not None and only not in cfg["separate"]:
            err("ERROR: --only takes a separate consumer (%s)."
                % (", ".join(cfg["separate"]) or "none configured"))
            return 2
        if args.cmd == "link":
            return cmd_link(cfg, args)
        if args.cmd == "redeem":
            return cmd_redeem(cfg, args)
        return cmd_status(cfg, args)
    except ConfigError as e:
        err("CONFIG ERROR: %s" % e)
        return 1
    except UnsafePath as e:
        err("ERROR: %s. Nothing more was written." % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())
