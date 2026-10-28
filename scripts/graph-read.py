#!/usr/bin/env python3
"""A read-only way to query the Meta Graph API from a command.

Usage:
  python3 scripts/graph-read.py <path> [key=value ...] [--page PAGE_ID]

  python3 scripts/graph-read.py me/accounts fields=id,name
  python3 scripts/graph-read.py <PAGE_ID>/feed fields=id,message,created_time limit=5 --page <PAGE_ID>
  python3 scripts/graph-read.py <VIDEO_ID> fields=source --page <PAGE_ID>
  python3 scripts/graph-read.py <IG_USER_ID>/media fields=id,caption,permalink limit=10

Why it exists: an agent that reads a page feed, a video's source or an
Instagram media list with an inline curl names the Graph host and puts the
token on the command line, and a text check in front of the shell cannot tell
that read from a publish once the verb can be hidden. This helper is the read
path a hook can allow by name (the command names no host), and THIS file
guarantees it is a read:

  - GET only: every request is built with data=None and method="GET"; there
    is no code path that sends a body;
  - the host is fixed (graph.facebook.com, v21.0 unless the path names a
    version) and re-checked on the final URL;
  - the path is plain ([A-Za-z0-9_/-] after an optional vNN.N/ prefix: no
    dot, so no host and no "..", no "?"); query parameters only as key=value
    arguments, and the key must be on the READ_PARAMS allowlist (fields,
    limit, after, before, since, until, metadata, summary, date_preset,
    period, metric, breakdowns);
  - write-marker parameters are refused before any network call (WRITE_PARAMS:
    message, caption, method, batch, published, is_hidden ...): Graph honours a
    `method=` override on GET, and the rest have no business in a read;
  - access_token is never taken from the command line: the stored user token
    (store/.meta-token), or with --page the page token derived from it via
    GET me/accounts. No token is ever printed: error text is redacted, and
    every access_token key in the response is masked.

Rate limits (stdlib only, because this runs on the system python3): a Graph
error whose code is in LIMIT_CODES (17 user request limit, 80004 ad account,
613, 80000, 80003, 80014) is retried, at most ATTEMPTS calls in all. The wait
comes from the error's headers when they carry one (X-Business-Use-Case-Usage
estimated_time_to_regain_access in minutes, X-Ad-Account-Usage
reset_time_duration in seconds; the largest + PAD_SEC), else 60 * 2^(n-1) s,
at most 600. A wait over MAX_ONE_WAIT_SEC, or one that would take the
INVOCATION's total sleeping past GRAPH_READ_MAX_WAIT_SEC (default 300, so it
fits a Bash tool call), fails at once with exit 1 instead of sleeping. The cap
is one WaitBudget created once in main() and passed to every fetch_retry()
call (--page makes two requests; they share it), and WaitBudget.sleep() is the
only place a retry sleeps, so the sum of all sleeps of one run never exceeds
the cap however many requests the run makes. Every limit error
pushes the shared pause file (see below; {"blocked_until": epoch}, only
ever raised, flock + atomic rename) forward, and every attempt
first waits out a pause another process wrote: all callers share one user
token, so one blocked caller holds the rest back instead of each extending
the block. A successful answer whose usage headers are at or above
THRESHOLD_PCT writes a pause for the next caller (no sleep here). Any other
HTTP error is not retried. Progress lines go to stderr.

The pause file: META_GRAPH_PAUSE_FILE (process environment first, then the
install .env; a relative path is taken from the install root), default
store/meta-graph-pause.json. Point it at the file another Graph client of the
same token already uses, so they hold each other back. Schema and locking:
{"blocked_until": <epoch float>, "ok": <why>, "irta_pid": <pid>}, written
under flock on "<file>.lock" via "<file>.<pid>.tmp" + os.replace, only ever
raised, a value more than an hour out treated as stale. If the file's
directory is missing, the pause is skipped (best effort).

Callers: with the default 300 s cap, give the Bash tool call a timeout of at
least 400000 ms (300 s of retry sleep plus the requests themselves, each with
a 60 s socket timeout); a shorter tool timeout can kill the run mid-sleep.

Output: the JSON response, pretty-printed, on stdout.
Exit codes: 0 ok, 2 refused / usage (nothing sent), 1 token / network / API error
(including a rate limit that does not clear within the wait budget).
"""
import fcntl
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(_ROOT, "store", ".meta-token")
HOST = "graph.facebook.com"
DEFAULT_VERSION = "v21.0"
PAUSE_SETTING = "META_GRAPH_PAUSE_FILE"
DEFAULT_PAUSE_RELATIVE = os.path.join("store", "meta-graph-pause.json")


def pause_path(root=_ROOT, environ=None):
    """The shared pause file: META_GRAPH_PAUSE_FILE from the process
    environment, else from <root>/.env, else store/meta-graph-pause.json. A
    relative value is taken from the install root. An unreadable .env means
    the default (the pause is a courtesy between callers, not a gate)."""
    env = os.environ if environ is None else environ
    val = (env.get(PAUSE_SETTING) or "").strip()
    if not val:
        try:
            with open(os.path.join(root, ".env"), encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith(PAUSE_SETTING + "="):
                        val = line.split("=", 1)[1].strip().strip("'\"")
        except (OSError, UnicodeDecodeError):
            val = ""
    val = val or DEFAULT_PAUSE_RELATIVE
    return val if os.path.isabs(val) else os.path.join(root, val)


PAUSE_PATH = pause_path()

# Rate-limit retry (see the module docstring).
LIMIT_CODES = (17, 80004, 613, 80000, 80003, 80014)
ATTEMPTS = 6
PAD_SEC = 5
THRESHOLD_PCT = 95
FALLBACK_BASE_SEC = 60
FALLBACK_MAX_SEC = 600
MAX_ONE_WAIT_SEC = 1800
DEFAULT_MAX_WAIT_SEC = 300
PAUSE_HORIZON_SEC = 3600   # a pause further out than this is stale/broken: ignored
_SLEEP = time.sleep        # tests replace these
_NOW = time.time

# Parameters that write, override the verb or smuggle a request: refused.
WRITE_PARAMS = frozenset((
    "message", "caption", "is_published", "is_hidden", "video_state",
    "upload_phase", "method", "_method", "batch", "published",
    "scheduled_publish_time", "unpublished_content_type", "description", "link",
    "source", "url", "file_url", "video_url", "image_url", "media_type",
    "creation_id", "children", "upload_type", "share_to_feed", "title",
    "attached_media", "privacy", "targeting", "backdated_time", "status",
    "access_token", "appsecret_proof", "relative_url", "body",
))
# v2-R1: the ONLY query keys a read may carry (an allowlist; WRITE_PARAMS
# above stays for the clearer refusal message).
READ_PARAMS = frozenset((
    "fields", "limit", "after", "before", "since", "until", "metadata",
    "summary", "date_preset", "period", "metric", "breakdowns",
))
_PATH_OK = re.compile(r"[A-Za-z0-9_/-]+")
_KEY_OK = re.compile(r"[a-z0-9_]+")
_VERSION = re.compile(r"v\d+\.\d+/")


class Refused(Exception):
    """A request this helper will not send (exit 2, nothing on the wire)."""


def _redact(text, secrets):
    for s in secrets:
        if s:
            text = text.replace(s, "<token>").replace(urllib.parse.quote(s, safe=""), "<token>")
    return text


def _scrub(obj):
    """Drop every access_token key from the response (me/accounts with
    fields=access_token returns page tokens): no token reaches stdout."""
    if isinstance(obj, dict):
        return {k: ("<token>" if k == "access_token" else _scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


def build_url(path, params, token):
    """The full GET URL, or Refused. Pure: no I/O."""
    raw = path.strip()
    p = raw[1:] if raw.startswith("/") and not raw.startswith("//") else raw
    ver = _VERSION.match(p)
    rest = p[ver.end():] if ver else p
    # no dots outside the version prefix: a Graph path has none, a host has
    if not rest or not _PATH_OK.fullmatch(rest) or "//" in rest:
        raise Refused("nem engedelyezett utvonal: %r (csak [A-Za-z0-9_/-], "
                      "opcionalisan vNN.N/ elotaggal; host, pont, '?' nelkul)" % path)
    q = {}
    for k, v in params:
        if not _KEY_OK.fullmatch(k):
            raise Refused("nem engedelyezett parameter-nev: %r" % k)
        if k in WRITE_PARAMS:
            raise Refused("iro / tiltott parameter: %s= (ez az eszkoz csak olvas)" % k)
        if k not in READ_PARAMS:
            raise Refused("ismeretlen olvasasi parameter: %s= (engedelyezett: %s)"
                          % (k, ", ".join(sorted(READ_PARAMS))))
        q[k] = v
    q["access_token"] = token
    if not _VERSION.match(p):
        p = DEFAULT_VERSION + "/" + p
    url = "https://%s/%s?%s" % (HOST, p, urllib.parse.urlencode(q))
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.netloc != HOST:
        raise Refused("nem Graph host: %r" % u.netloc)
    return url


class RateLimited(RuntimeError):
    """A Graph rate-limit error (code in LIMIT_CODES); carries the headers."""

    def __init__(self, text, code, headers):
        RuntimeError.__init__(self, text)
        self.code = code
        self.headers = headers


def _lower_headers(h):
    try:
        return {str(k).lower(): v for k, v in h.items()} if h else {}
    except AttributeError:
        return {}


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def _json_header(headers, name):
    try:
        v = json.loads(headers.get(name) or "{}")
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def _usage(headers):
    """(highest usage %, header wait in seconds or None) from the usage headers."""
    pct, waits = 0.0, []
    for rows in _json_header(headers, "x-business-use-case-usage").values():
        for r in rows if isinstance(rows, list) else []:
            if isinstance(r, dict):
                pct = max(pct, _num(r.get("call_count")), _num(r.get("total_cputime")),
                          _num(r.get("total_time")))
                if _num(r.get("estimated_time_to_regain_access")) > 0:
                    waits.append(_num(r.get("estimated_time_to_regain_access")) * 60)
    acc = _json_header(headers, "x-ad-account-usage")
    pct = max(pct, _num(acc.get("acc_id_util_pct")))
    if _num(acc.get("reset_time_duration")) > 0:
        waits.append(_num(acc.get("reset_time_duration")))
    app = _json_header(headers, "x-app-usage")
    pct = max(pct, _num(app.get("call_count")), _num(app.get("total_cputime")),
              _num(app.get("total_time")))
    return pct, (max(waits) + PAD_SEC if waits else None)


def wait_sec(headers, attempt):
    """Seconds to wait after the attempt-th limit error: the headers' figure, else backoff."""
    w = _usage(headers)[1]
    return w if w is not None else min(FALLBACK_BASE_SEC * 2 ** (attempt - 1), FALLBACK_MAX_SEC)


def max_wait_sec():
    v = _num(os.environ.get("GRAPH_READ_MAX_WAIT_SEC", DEFAULT_MAX_WAIT_SEC))
    return v if v >= 0 else 0.0


class WaitBudget:
    """The total retry sleep of ONE invocation (GRAPH_READ_MAX_WAIT_SEC).
    Created once per run and shared by every fetch_retry() call; sleep() is
    the only way a retry sleeps, and it refuses a sleep past the cap."""

    def __init__(self, cap=None):
        self.cap = max_wait_sec() if cap is None else cap
        self.slept = 0.0

    def left(self):
        return max(self.cap - self.slept, 0.0)

    def fits(self, sec):
        return self.slept + sec <= self.cap

    def sleep(self, sec):
        if not self.fits(sec):
            raise RuntimeError("varakozasi keret: %.0f mp alvas kellene, a futas keretebol "
                               "%.0f mp maradt (GRAPH_READ_MAX_WAIT_SEC emeli)" % (sec, self.left()))
        _SLEEP(sec)
        self.slept += sec


def pause_write(until, why):
    """Raise the shared blocked_until to `until` (never lowers it). Best effort."""
    tmp = "%s.%d.tmp" % (PAUSE_PATH, os.getpid())
    try:
        with open(PAUSE_PATH + ".lock", "a") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            old = pause_until()
            if until <= old:
                return
            with open(tmp, "w") as f:   # the pause-file schema (module docstring)
                json.dump({"blocked_until": until, "ok": why, "irta_pid": os.getpid()}, f)
            os.replace(tmp, PAUSE_PATH)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def pause_until():
    """The shared blocked_until (epoch), 0 when absent, unreadable or stale."""
    try:
        with open(PAUSE_PATH) as f:
            v = _num(json.load(f).get("blocked_until"))
    except (OSError, ValueError, AttributeError):
        return 0.0
    return v if v <= _NOW() + PAUSE_HORIZON_SEC else 0.0


def fetch(url, opener, secrets, with_headers=False):
    """ONE GET, no body. opener(request, timeout) -> response (urlopen's shape).
    A rate-limit error raises RateLimited, any other failure RuntimeError."""
    req = urllib.request.Request(url, data=None, method="GET")
    if req.data is not None or req.get_method() != "GET":  # belt and braces
        raise Refused("nem GET keres")
    try:
        with opener(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
            hdrs = _lower_headers(getattr(r, "headers", None))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:800]
        text = _redact("Graph API HTTP %s: %s" % (exc.code, body), secrets)
        try:
            err = json.loads(body).get("error")
        except (ValueError, AttributeError):
            err = None
        code = err.get("code") if isinstance(err, dict) else None
        if code in LIMIT_CODES:
            raise RateLimited(text, code, _lower_headers(exc.headers))
        raise RuntimeError(text)
    except Refused:
        raise
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(_redact("halozati hiba: %r" % (exc,), secrets))
    return (data, hdrs) if with_headers else data


def fetch_retry(url, opener, secrets, note, budget):
    """fetch() with the rate-limit retry and the shared pause (module docstring).
    `budget` is the invocation's WaitBudget (required: a call must never get a
    fresh cap of its own); every sleep goes through budget.sleep()."""
    for attempt in range(1, ATTEMPTS + 1):
        left = pause_until() - _NOW()
        if left > 0:
            if not budget.fits(left):
                raise RuntimeError("Meta hivasszam-korlat: a kozos szunet-fajl szerint meg %.0f mp "
                                   "a tiltas, tobb a futas maradek varakozasi keretenel (%.0f mp); "
                                   "nem hivtam" % (left, budget.left()))
            note("graph-read: kozos szunet-fajl: %.0f mp varakozas a hivas elott" % left)
            budget.sleep(left)
        try:
            data, hdrs = fetch(url, opener, secrets, with_headers=True)
        except RateLimited as exc:
            w = wait_sec(exc.headers, attempt)
            pause_write(_NOW() + min(w, PAUSE_HORIZON_SEC), "code %s" % exc.code)
            if attempt == ATTEMPTS:
                raise RuntimeError("%s (hivasszam-korlat, %d proba utan feladva)" % (exc, ATTEMPTS))
            if w > MAX_ONE_WAIT_SEC or not budget.fits(w):
                raise RuntimeError("%s (hivasszam-korlat, code %s: %.0f mp varakozas kellene, a futas "
                                   "maradek kerete %.0f mp a %.0f-bol; GRAPH_READ_MAX_WAIT_SEC emeli)"
                                   % (exc, exc.code, w, budget.left(), budget.cap))
            note("graph-read: hivasszam-korlat (code %s): %.0f mp varakozas, %d/%d"
                 % (exc.code, w, attempt, ATTEMPTS - 1))
            budget.sleep(w)
            continue
        pct, w = _usage(hdrs)
        if pct >= THRESHOLD_PCT:
            w = min(w if w is not None else FALLBACK_BASE_SEC, MAX_ONE_WAIT_SEC)
            pause_write(_NOW() + w, "siker-utan-%d" % THRESHOLD_PCT)
            note("graph-read: hasznalat %.0f%% >= %d%%: %.0f mp szunet a kovetkezo hivasig "
                 "(szunet-fajl)" % (pct, THRESHOLD_PCT, w))
        return data
    raise RuntimeError("unreachable")


def user_token():
    try:
        tok = open(TOKEN_PATH, encoding="utf-8").read().strip()
    except OSError as exc:
        raise RuntimeError("a Meta-token nem olvashato (%s): %s"
                           % (TOKEN_PATH, exc.__class__.__name__))
    if not tok:
        raise RuntimeError("a Meta-token ures: %s" % TOKEN_PATH)
    return tok


def parse_args(argv):
    path, params, page = None, [], None
    it = iter(argv)
    for a in it:
        if a == "--page":
            page = next(it, None)
            if not page or not page.isdigit():
                raise Refused("--page utan oldal-azonosito (szamjegyek) kell")
        elif a.startswith("-"):
            raise Refused("ismeretlen kapcsolo: %r" % a)
        elif path is None:
            path = a
        elif "=" in a:
            k, v = a.split("=", 1)
            params.append((k, v))
        else:
            raise Refused("parameter csak key=value alakban: %r" % a)
    if path is None:
        raise Refused("hianyzik az utvonal")
    return path, params, page


def main(argv=None, opener=None, out=None, err=None):
    argv = sys.argv[1:] if argv is None else argv
    opener = opener or urllib.request.urlopen
    out = out or sys.stdout
    err = err or sys.stderr
    secrets = []

    def note(msg):
        err.write(msg + "\n")
    budget = WaitBudget()   # ONE per invocation: every request below shares it
    try:
        path, params, page = parse_args(argv)
        build_url(path, params, "x")          # refuse BEFORE reading any token
        tok = user_token()
        secrets.append(tok)
        if page:
            d = fetch_retry(build_url("me/accounts", [("fields", "id,access_token"),
                                                      ("limit", "200")], tok), opener, secrets, note,
                            budget)
            ptok = next((p.get("access_token") for p in d.get("data", [])
                         if str(p.get("id")) == page), None)
            if not ptok:
                raise RuntimeError("a(z) %s oldalhoz nincs token ezen a fiokon" % page)
            secrets.append(ptok)
            tok = ptok
        data = fetch_retry(build_url(path, params, tok), opener, secrets, note, budget)
    except Refused as exc:
        err.write("graph-read: MEGTAGADVA, semmi nem ment ki: %s\n" % exc)
        if not argv:
            err.write(__doc__)
        return 2
    except RuntimeError as exc:
        err.write("graph-read: %s\n" % _redact(str(exc), secrets))
        return 1
    out.write(_redact(json.dumps(_scrub(data), indent=2, ensure_ascii=False), secrets) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
