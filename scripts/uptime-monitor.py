#!/usr/bin/env python3
"""Uptime monitor: a light, browser-free measurement of one or more websites and embedded services that alerts the
owner WITHOUT the tmux sessions, the dashboard or the dashboard scheduler. Linux/systemd only: a systemd --user timer
runs it (templates: scripts/systemd/uptime-monitor.{service,timer}); one run is one measurement round, then it exits.

INVARIANTS (each with its test case and mutant control in scripts/__tests__/uptime-monitor.test.py):
  I1  A target is alerted only if, IN THE SAME RUN, both the first and the confirming measurement failed
      (T2, T3, T20; M-confirm for the confirming strike, M-first-strike for the first one).
  I2  A send failure is never green: if an attempted send does not go out, or the send path (token, chat_id, helper,
      outgoing-copy gate) is unusable at the start of the run, the exit code is 4, which the unit does not treat as
      success (OnFailure) (T6, T9f, T11b, T15, T15b, T15c, T21, T22c; M-send-code, M-blind-code, M-preflight,
      M-gate-error, M-recovery-code, M-recovery-retry).
  I3  One event, one alert: the "alerted" stamp is written only AFTER a successful send, and a lasting outage over
      several runs gives one alert (T4, T6; M-dedup, M-stamp).
  I4  The whole run stays within the unit's budget, computed: for N targets (2N+1) requests x UPTIME_TIMEOUT +
      wait_seconds + (N+1) sends x SEND_TIMEOUT <= UNIT_BUDGET (410 s; the unit's TimeoutStartSec=420, 10 s margin).
      Checked when the config is loaded, exit 1 otherwise (T19; M-budget, M-wait-env, M-budget-timeout, M-budget-n).
      Its limit: the per-request TIMEOUT is an approximation (urllib applies it per socket operation, does not bound
      DNS, and one measurement follows at most 10 redirects, each with its own timeout); the service template says so
      too. An overrun is not silent: the unit's TimeoutStartSec stops the run, and OnFailure reports it.

CONFIG (required, untracked, install-specific): store/uptime-targets.json -- the targets and their content signals. The
code holds no install-specific address. Example: scripts/uptime-targets.example.json. A missing or invalid config is
exit 1 (internal error), because then the monitor watches nothing.

  {"targets": [{"name": "site", "url": "https://...", "title_contains": "...", "contains": ["...", "..."]},
               {"name": "widget", "url": "https://...", "next_data": {"equals": {"page": "...", "query.slug": "..."},
                                                                      "non_empty": ["buildId", "props.pageProps.x"],
                                                                      "false": ["isFallback"]}}],
   "reference": "https://www.google.com/generate_204", "wait_seconds": 90, "blind_notice_runs": 6}

WHAT IT MEASURES: HTTP 200 plus the content signals listed in the config (part of the <title>, required text snippets,
given fields of the Next.js __NEXT_DATA__). There is no browser: the "loaded but empty" state of a client-side rendered
frame is not visible to this measurement.

The behaviours below are measured by the cases named in brackets in scripts/__tests__/uptime-monitor.test.py, against a
local HTTP server; for any other situation nothing more is claimed than what the code lines say.

TWO STRIKES: a target is "down" if both the first and the confirming measurement fail, wait_seconds apart (T2, T3). The
confirming round measures EVERY target again, then the reference URL. The round is NOT MEASURABLE (no alert, exit 2) if
in the confirming round no target gave an HTTP answer and neither did the reference (T7, T7d). If any did (even with an
error status), the round is measurable: so a failing target is alerted even next to a bad or dead reference (T7b, T7c;
the log gets a "reference-error" line). The reference should not sit behind the same CDN as the targets.

ONE ALERT PER EVENT: a state file per target (down or not, since when, whether the alert went out). The "alerted" flag
is written only after a successful send (the contract of scripts/lib/send-telegram.sh); a failed send is retried by the
next run (T6). A lasting outage over two runs gives one alert (T4). On recovery one notice goes out with the length of
the outage, if the outage was alerted (T5); if the recovery notice fails to send, the exit code is 4, the state stays,
and the next run resends it (T21); if the outage alert never went out, there is no recovery notice either, and the log
gets an "outage-not-reported" line (T18).
BLIND STREAK: if blind_notice_runs consecutive runs are NOT MEASURABLE, the run that reaches the threshold tries to send
one "cannot measure" notice, once per streak (T9, T9c); if that send fails, the next NOT MEASURABLE run retries it (code
reading, not measured by a test). The first measurable run sends a "could not measure for X, measuring again now"
notice (T9). A streak below the threshold sends nothing (T9b). If this "measuring again" notice does not go out, it stays
pending and later runs retry it (T9d); if a second streak closes while the first one's notice is still pending, the two
streaks' minutes are summed into one pending notice, so the first streak's notice is not lost (T9e).
RECOVERY: the first successful measurement of a target marked down (in the first round, or, if it failed there, in the
confirming one) already counts as recovery (no hysteresis); a flapping outage can therefore produce alert/recovery
pairs. This is deliberate: the two strikes protect the alert, not the recovery.

OUTGOING TEXT: every message passes the outgoing-copy gate before it is sent (scripts/hooks/sender_check.py
_copy_check(), the same audit as the hook's). The fixed templates (the TEXTS table below) pass the gate for the names
and error texts listed in G1; the same alert with an em dash is refused (G1k). If the gate refuses the detailed text,
the fallback text without details is sent (T10); if that is stuck too, nothing is sent, the log names it, exit 4 (T11b).
A target name with which not even the fallback text would pass is an error at the start of the run (exit 1, T11), but
only if the gate itself works; a gate failure is exit 4 (T15b). If the gate lets a text through with a warning (e.g. a
missing name-rules file), the warning goes to stderr and the log (code reading, not measured by a test).

CHANNEL: a direct Telegram Bot API sendMessage through scripts/lib/send-telegram.sh (T22). The chat is the owner chat
of the alert resolver, scripts/lib/owner_chat.py resolve_owner_chat(<install>/.env): ALLOWED_CHAT_ID from the install's
.env first, else the main channel dir's access.json, and only when it holds exactly one DM entry (several DM entries,
group or channel ids, or the "0" placeholder give no chat, and the resolver's reason is named in the exit-4 preflight
line, T22c, T22d). MARVEEN_ALERT_CHAT_ID is an explicit override in front of the resolver (T22e). The bot token is read
at run time from TELEGRAM_BOT_TOKEN in that same main channel dir's .env (the resolver's own state-dir rule; an inherited
TELEGRAM_STATE_DIR is not honoured, T22), or from the file TELEGRAM_ENV names, an explicit override as in
scripts/unit-fail-notify.sh. It is never copied: it travels in the helper process's environment, not in this script's
argv or log (the helper keeps it out of curl's argv as well). The code never calls getUpdates, setWebhook or
deleteWebhook, and starts no channel plugin: those are what collide with the running channel session's poller (#1770).

EXIT CODE:
  0 = every target fine (there may have been flapping, T3);
  3 = at least one target confirmed down, and every send attempted in this run went out (T2, T4, T7b, T7c, T8, T22);
  2 = NOT MEASURABLE (see TWO STRIKES), and no send failed (T7);
  4 = a send attempted in this run did not go out (T6, T11b), or the send path is already incomplete at the start of
      the run (token, chat_id, helper: an offline check, T15, T22c, T22d), or the outgoing-copy gate does not load /
      refuses its fixed probe text (T15b); it takes precedence over 0/2/3. The measurement still runs. A lasting 4 (or 1) starts
      OnFailure on every timer run, so it reports every 5 minutes while the fault lasts (no thinning);
  1 = internal error, or a missing/invalid config (T12, T13, T13b, T13c, T13d), or a target name with which, next to a
      working gate, not even the fallback notice would pass (T11).
The unit (scripts/systemd/uptime-monitor.service) has SuccessExitStatus=2 3, so exit 1 and 4, and a stop past
TimeoutStartSec, start OnFailure.

ENVIRONMENT (the test is hermetic with these): UPTIME_CONFIG, UPTIME_STATE, UPTIME_LOG, UPTIME_SENDER ("telegram" |
"file:<path>" | "fail"), UPTIME_TIMEOUT (finite, positive; part of the I4 computation), UPTIME_MAX_BYTES; for the
channel: TELEGRAM_ENV and MARVEEN_ALERT_CHAT_ID (explicit overrides, see CHANNEL), and TELEGRAM_API_BASE (the
send-telegram.sh test seam: a local Bot API stub).
"""
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.environ.get("UPTIME_CONFIG", os.path.join(ROOT, "store", "uptime-targets.json"))
STATE = os.environ.get("UPTIME_STATE", os.path.join(ROOT, "store", "uptime-state.json"))
LOG = os.environ.get("UPTIME_LOG", os.path.join(ROOT, "store", "uptime-log.jsonl"))
SENDER = os.environ.get("UPTIME_SENDER", "telegram")
try:
    TIMEOUT = float(os.environ.get("UPTIME_TIMEOUT", "20"))
except ValueError:
    TIMEOUT = float("nan")   # load_config stops on it with a loud CONFIG ERROR, not a traceback
SEND_TIMEOUT = 60        # upper bound of the send-telegram.sh helper process (subprocess timeout)
UNIT_BUDGET = 410        # the unit's TimeoutStartSec=420, 10 s margin (I4)
SEND_HELPER = os.path.join(ROOT, "scripts", "lib", "send-telegram.sh")
INSTALL_ENV = os.path.join(ROOT, ".env")
# The owner chat comes from upstream's one alert resolver (scripts/lib/owner_chat.py), imported the way the other
# scripts import it. A tree without it does not crash: the preflight names it, and the run exits 4.
sys.path.insert(0, os.path.join(ROOT, "scripts", "lib"))
try:
    import owner_chat  # noqa: E402
    OWNER_CHAT_ERROR = None
except Exception as _e:  # noqa: BLE001
    owner_chat = None
    OWNER_CHAT_ERROR = "the owner-chat resolver (scripts/lib/owner_chat.py) cannot load (%r)" % _e
# The token lives in the MAIN install's channel dir, the same dir the resolver reads access.json from (install-scoped,
# else the legacy ~/.claude/channels/telegram; an inherited TELEGRAM_STATE_DIR is not honoured). TELEGRAM_ENV stays an
# explicit override, as in unit-fail-notify.sh.
_MAIN_TG_DIR = (owner_chat._state_dir(INSTALL_ENV, "telegram") if owner_chat
                else os.path.join(ROOT, ".claude", "channels", "telegram"))
TELEGRAM_ENV = os.environ.get("TELEGRAM_ENV") or os.path.join(_MAIN_TG_DIR, ".env")
# sender_check._copy_check(text) runs the outgoing-copy-gate audit and raises Refused
SENDER_CHECK = os.path.join(ROOT, "scripts", "hooks", "sender_check.py")
UA = "Mozilla/5.0 (marveen-uptime-monitor)"
# upper bound of an answer's transferred and decompressed size (well above a typical page); the test lowers it with
# UPTIME_MAX_BYTES
try:
    MAX_BYTES = int(os.environ.get("UPTIME_MAX_BYTES", str(8 * 1024 * 1024)))
except ValueError:
    MAX_BYTES = 0            # load_config stops on it with a loud CONFIG ERROR

# ---------------------------------------------------------------------------------------------------------------------
# OWNER-FACING TEXTS. Everything that can reach the owner's chat is here, and only here: the alert / recovery / blind
# notices, the error descriptions that an alert quotes, and the gate probe. Each is checked by the outgoing-copy gate
# before sending (G1 in the test). The error descriptions are FIXED forms: no text from the server ends up in them.
# ---------------------------------------------------------------------------------------------------------------------
TEXTS = {
    "alert": ("Uptime alert: %(name)s is not working properly (%(time)s). "
              "Reason: %(error)s. Two measurements, %(wait)d seconds apart. URL: %(url)s"),
    "alert_fallback": ("Uptime alert: %(name)s is not working properly (%(time)s). "
                       "The details are in the monitor's log."),
    "recovery": "Recovered: %(name)s is fine again (%(time)s); the outage lasted about %(duration)s. URL: %(url)s",
    "recovery_fallback": "Recovered: %(name)s is fine again (%(time)s).",
    "blind_over": ("The uptime monitor could not measure for about %s: in that time no target and not the reference "
                   "URL gave an answer. It is measuring again now."),
    "blind_now": ("The uptime monitor has not been able to measure for about %s: no target and not the reference URL "
                  "gives an answer. While this lasts, it cannot report an outage."),
    "gate_probe": "This is the uptime monitor's probe text; it checks that the outgoing-copy gate works.",
    "minutes": "%d min",
    "err_http": "HTTP %s",
    "err_title": "the page title is not the expected one",
    "err_contains": "required content signal #%d is missing",
    "err_no_next_data": "no __NEXT_DATA__",
    "err_next_data_parse": "the __NEXT_DATA__ is not parseable",
    "err_next_data_equals": "the __NEXT_DATA__ field %s is not the expected value",
    "err_next_data_empty": "the __NEXT_DATA__ field %s is empty",
    "err_next_data_true": "the __NEXT_DATA__ field %s is true",
    "err_too_large": "the answer is too large",
    "err_unreadable": "the answer is unreadable (%s)",
    "err_no_answer": "no answer (%s%s)",
}


class Answered(Exception):
    """The server gave an HTTP answer (the status line arrived), but the body is not acceptable: this is an ANSWER, not
    "no answer" (a corrupt gzip, a truncated body)."""


class TooLarge(Answered):
    """The answer exceeded MAX_BYTES."""


class ConfigError(Exception):
    pass


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            k = json.load(fh)
    except FileNotFoundError:
        raise ConfigError("no config: %s (example: scripts/uptime-targets.example.json)" % CONFIG)
    except ValueError as e:
        raise ConfigError("the config is not valid JSON (%s): %s" % (CONFIG, e))
    targets = k.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ConfigError("the config has no target ('targets' is empty or missing)")
    names = set()
    for c in targets:
        if (not isinstance(c, dict) or not isinstance(c.get("name"), str) or not c["name"]
                or not str(c.get("url", "")).startswith(("http://", "https://")) or not str(c["url"]).isascii()):
            raise ConfigError("invalid target (a name and an ASCII http(s) url are required; percent-encode a "
                              "non-ASCII path or IDN): %r" % (c,))
        if str(c["name"]).startswith("_"):
            raise ConfigError("a target name must not start with '_' (internal keys of the state file): %r" % c["name"])
        if c["name"] in names:
            raise ConfigError("duplicate target name: %r" % c["name"])
        names.add(c["name"])
        t = c.get("contains")
        if t is not None and (not isinstance(t, list) or not all(isinstance(x, str) and x for x in t)):
            raise ConfigError("the 'contains' field of target %r is not a list of non-empty strings" % c["name"])
        if not (c.get("title_contains") or c.get("contains") or c.get("next_data")):
            raise ConfigError("target %r has no content signal (measuring the status alone is not enough)" % c["name"])
    if not str(k.get("reference", "")).startswith(("http://", "https://")) or not str(k["reference"]).isascii():
        raise ConfigError("no reference URL")
    if not math.isfinite(TIMEOUT) or TIMEOUT <= 0:
        raise ConfigError("UPTIME_TIMEOUT is not a finite positive number: %r" % os.environ.get("UPTIME_TIMEOUT"))
    if MAX_BYTES <= 0:
        raise ConfigError("UPTIME_MAX_BYTES is not a positive integer: %r" % os.environ.get("UPTIME_MAX_BYTES"))
    v = k.get("wait_seconds", 90)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0:
        raise ConfigError("wait_seconds is not a non-negative finite number: %r" % (v,))
    # I4: the worst-case run stays within the unit's budget
    budget = run_budget(len(targets), v)
    if budget > UNIT_BUDGET:
        raise ConfigError("the worst-case run is %.0f s, more than the unit budget (%d s): (2N+1) x %.0f s + %.0f s wait"
                          " + (N+1) x %d s send, N=%d; reduce the wait or the number of targets"
                          % (budget, UNIT_BUDGET, TIMEOUT, v, SEND_TIMEOUT, len(targets)))
    v = k.get("blind_notice_runs", 6)
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ConfigError("blind_notice_runs is not a positive integer: %r" % (v,))
    for c in targets:
        if "title_contains" in c and not (isinstance(c["title_contains"], str) and c["title_contains"]):
            raise ConfigError("the 'title_contains' field of target %r is not a non-empty string" % c["name"])
        nd = c.get("next_data")
        if nd is not None:
            # only known sub-keys, each with its own type, and at least one non-empty signal: otherwise the target
            # would be measured on its status alone, or a string list would be iterated character by character
            err = None
            if not isinstance(nd, dict) or set(nd) - {"equals", "non_empty", "false"}:
                err = "only the equals / non_empty / false sub-keys are allowed"
            elif "equals" in nd and not (isinstance(nd["equals"], dict)
                                         and all(isinstance(x, str) and x for x in nd["equals"])
                                         and all(isinstance(e, (str, int, float, bool)) for e in nd["equals"].values())):
                # null cannot be an expected value (a missing field is read as None too)
                err = "equals is not an object with string keys and scalar (non-null) values"
            elif any(key in nd and not (isinstance(nd[key], list) and all(isinstance(x, str) and x for x in nd[key]))
                     for key in ("non_empty", "false")):
                err = "non_empty / false is not a list of non-empty strings"
            elif not (nd.get("equals") or nd.get("non_empty") or nd.get("false")):
                err = "it holds no signal at all"
            if err:
                raise ConfigError("the 'next_data' field of target %r is invalid: %s" % (c["name"], err))
    return k


def run_budget(n, wait):
    """I4: the worst-case duration of a run for N targets: first round N requests, confirming round N requests, 1
    reference; at most N alert/recovery sends + 1 blind notice. One TIMEOUT per request (an approximation, see the
    docstring)."""
    return (2 * n + 1) * TIMEOUT + wait + (n + 1) * SEND_TIMEOUT


def target_name_gate_error(targets):
    """A target name with which not even the detail-free fallback alert or recovery passes the outgoing-copy gate could
    never be reported. Called ONLY next to a working gate (a gate failure is not the target name's fault)."""
    for c in targets:
        for text in (alert_text(c["name"], c["url"], "HTTP 503", 90)[1],
                     recovery_text(c["name"], c["url"], "1 min")[1]):
            ok, reason = gate_check(text)
            if not ok:
                return "with target name %r a notice would not pass the outgoing-copy gate: %s" % (c["name"],
                                                                                                 str(reason)[:300])
    return None


def fetch(url):
    """(status, body); a non-2xx answer is (status, body) too. Asks for gzip and decompresses it."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, read_body_as_answer(r)
    except urllib.error.HTTPError as e:
        return e.code, read_body_as_answer(e)


def read_body_as_answer(r):
    """The status line has already arrived: any failure while reading the body is Answered."""
    try:
        return read_body(r)
    except Answered:
        raise
    except Exception as e:  # noqa: BLE001 -- zlib.error, IncompleteRead, a timeout in the middle of the body
        raise Answered(type(e).__name__)


def read_body(r):
    """The body, with at most MAX_BYTES transferred AND at most MAX_BYTES decompressed bytes (a gzip bomb and an error
    answer are bounded too). Content-Encoding is matched case-insensitively."""
    b = r.read(MAX_BYTES + 1) or b""
    if len(b) > MAX_BYTES:
        raise TooLarge("transferred")
    if (r.headers.get("Content-Encoding") or "").strip().lower() == "gzip":
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        b = d.decompress(b, MAX_BYTES + 1)
        if len(b) > MAX_BYTES or d.unconsumed_tail:
            raise TooLarge("decompressed")
        if not d.eof:   # a truncated gzip stream is not an error for zlib, but it is for us
            raise Answered("truncated gzip")
    return b.decode("utf-8", "replace")


def path_value(d, path):
    for part in path.split("."):
        if not isinstance(d, dict) or part not in d:
            return None
        d = d[part]
    return d


def content_error(target, status, body):
    """None if the target is fine; otherwise a short description of the fault in a FIXED form (no server text in it)."""
    if status != 200:
        return TEXTS["err_http"] % status
    if target.get("title_contains"):
        m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
        if not m or target["title_contains"] not in m.group(1):
            return TEXTS["err_title"]
    for i, part in enumerate(target.get("contains") or [], 1):
        if part not in body:
            return TEXTS["err_contains"] % i
    nd = target.get("next_data")
    if nd:
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', body, re.S)
        if not m:
            return TEXTS["err_no_next_data"]
        try:
            d = json.loads(m.group(1))
        except ValueError:
            return TEXTS["err_next_data_parse"]
        for path, expected in (nd.get("equals") or {}).items():
            if path_value(d, path) != expected:
                return TEXTS["err_next_data_equals"] % path
        for path in nd.get("non_empty") or []:
            if not path_value(d, path):
                return TEXTS["err_next_data_empty"] % path
        for path in nd.get("false") or []:
            if path_value(d, path):
                return TEXTS["err_next_data_true"] % path
    return None


def measure(target):
    """(error or None, whether it gave an HTTP answer). The 'answered' flag decides whether the host's network works."""
    try:
        status, body = fetch(target["url"])
    except TooLarge:
        return TEXTS["err_too_large"], True
    except Answered as e:
        return TEXTS["err_unreadable"] % e, True
    except Exception as e:  # noqa: BLE001 -- a network error is a failed measurement, without an HTTP answer
        cause = getattr(e, "reason", None)   # URLError: show the class of the real cause too (e.g. a certificate error)
        return TEXTS["err_no_answer"] % (type(e).__name__,
                                         ", " + type(cause).__name__ if isinstance(cause, Exception) else ""), False
    return content_error(target, status, body), True


def check_reference(url):
    """'ok' (2xx/3xx), 'bad-answer' (another status: the network works, the reference is bad) or 'no-answer'."""
    try:
        status, _ = fetch(url)
    except Answered:
        return "bad-answer"
    except Exception:  # noqa: BLE001
        return "no-answer"
    return "ok" if 200 <= status < 400 else "bad-answer"


def log_event(**data):
    data["time"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(data, ensure_ascii=False) + "\n")
    except OSError as e:
        print("log not writable: %s" % e, file=sys.stderr)


def read_state():
    """The previous state. A corrupt file: a loud line on stderr and in the log, the file set aside (.corrupt), and the
    run goes on with an empty state -- otherwise every run would stop with 1, and the monitor would watch nothing."""
    try:
        with open(STATE, encoding="utf-8") as fh:
            a = json.load(fh)
        if not isinstance(a, dict) or not all(isinstance(v, dict) for v in a.values()):
            raise ValueError("not an object of objects")
        for v in a.values():
            for key in ("down_since", "since"):
                if key in v and (not isinstance(v[key], (int, float)) or isinstance(v[key], bool)
                                 or not math.isfinite(v[key])):
                    raise ValueError("field %r is not a finite number" % key)
            for key in ("down", "alerted", "notified"):
                if key in v and not isinstance(v[key], bool):
                    raise ValueError("field %r is not a boolean" % key)
            if "runs" in v and (not isinstance(v["runs"], int) or isinstance(v["runs"], bool)):
                raise ValueError("field 'runs' is not an integer")
            if "minutes" in v and (not isinstance(v["minutes"], int) or isinstance(v["minutes"], bool)):
                raise ValueError("field 'minutes' is not an integer")
        return a
    except FileNotFoundError:
        return {}
    except ValueError as e:
        print("CORRUPT STATE FILE (%s): %s -- setting it aside (.corrupt), continuing with an empty state" % (STATE, e),
              file=sys.stderr)
        log_event(event="corrupt-state", error=str(e)[:200])
        try:
            os.replace(STATE, STATE + ".corrupt")
        except OSError as e2:
            print("the corrupt state file could NOT be set aside: %s" % e2, file=sys.stderr)
            log_event(event="corrupt-state-move-error", error=str(e2)[:200])
        return {}


def write_state(a):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STATE), prefix=".uptime-state-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(a, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


_gate = None


def gate_check(text):
    """(ok, reason) from the outgoing-copy gate (sender_check._copy_check). A load failure is fail-closed."""
    global _gate
    try:
        if _gate is None:
            spec = importlib.util.spec_from_file_location("uptime_sender_check", SENDER_CHECK)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _gate = mod
        try:
            warning = _gate._copy_check(text)
        except _gate.Refused as refusal:
            return False, str(refusal)
        return True, warning or ""
    except BaseException as e:  # noqa: BLE001 -- the gate cannot load: no unchecked text goes out
        return False, "the outgoing-copy gate cannot load (%r)" % e


def resolve_chat():
    """(chat_id, None), or ("", reason) when there is no owner chat to alert. MARVEEN_ALERT_CHAT_ID is an explicit
    override; otherwise scripts/lib/owner_chat.py decides (see CHANNEL in the docstring)."""
    c = os.environ.get("MARVEEN_ALERT_CHAT_ID", "").strip()
    if c and c != "0":
        return c, None
    if owner_chat is None:
        return "", OWNER_CHAT_ERROR
    chat, reason = owner_chat.resolve_owner_chat(INSTALL_ENV)
    return (chat, None) if chat else ("", reason or "no owner chat")


def bot_token():
    try:
        for line in open(TELEGRAM_ENV, encoding="utf-8"):
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


def telegram_send(text):
    token, (chat, chat_reason) = bot_token(), resolve_chat()
    if not token or not chat:
        print("not sending: missing%s%s" % (" TELEGRAM_BOT_TOKEN" if not token else "",
                                             " chat_id (%s)" % chat_reason if not chat else ""), file=sys.stderr)
        return False
    env = dict(os.environ, TG_TOKEN=token, TG_CHAT=chat, TG_TEXT=text, TG_HELPER=SEND_HELPER)
    try:
        p = subprocess.run(["bash", "-c", '. "$TG_HELPER" && send_telegram_message "$TG_TOKEN" "$TG_CHAT" "$TG_TEXT"'],
                           env=env, capture_output=True, text=True, timeout=SEND_TIMEOUT)
    except subprocess.TimeoutExpired:
        print("telegram send: timeout", file=sys.stderr)
        return False
    if p.returncode != 0:
        print("telegram send error: %s" % (p.stderr or "").replace(token, "<token>")[:500], file=sys.stderr)
    return p.returncode == 0


def raw_send(text):
    if SENDER == "telegram":
        return telegram_send(text)
    if SENDER == "fail":
        return False
    if SENDER.startswith("file:"):
        with open(SENDER[5:], "a", encoding="utf-8") as fh:
            fh.write(text.replace("\n", " | ") + "\n")
        return True
    print("unknown UPTIME_SENDER: %r" % SENDER, file=sys.stderr)
    return False


def send(text, fallback):
    """Sends the text that passed the gate; if the gate refuses it, the detail-free fallback; True only on success."""
    for candidate in (text, fallback):
        ok, reason = gate_check(candidate)
        if ok:
            if reason:   # the gate let it through, but warns (e.g. a missing name-rules file): make it visible
                print("outgoing-copy gate warning: %s" % str(reason)[:300], file=sys.stderr)
                log_event(event="gate-warning", reason=str(reason)[:300])
            return raw_send(candidate)
        log_event(event="gate-refused", text=candidate[:200], reason=str(reason)[:300])
        print("the outgoing-copy gate refused it: %s" % reason, file=sys.stderr)
    return False


def minutes_text(seconds):
    return TEXTS["minutes"] % max(1, round(seconds / 60))


def alert_text(name, url, error, wait):
    f = {"name": name, "url": url, "error": error, "wait": wait, "time": time.strftime("%H:%M")}
    return TEXTS["alert"] % f, TEXTS["alert_fallback"] % f


def recovery_text(name, url, duration):
    f = {"name": name, "url": url, "duration": duration, "time": time.strftime("%H:%M")}
    return TEXTS["recovery"] % f, TEXTS["recovery_fallback"] % f


def blind_over_text(duration):
    return (TEXTS["blind_over"] % duration,) * 2


def blind_now_text(duration):
    return (TEXTS["blind_now"] % duration,) * 2


def preflight_error():
    """A cheap, offline check in every run: an incomplete send path must not come to light only at the moment of an
    outage. Returns: a description of what is missing, or None."""
    if SENDER in ("fail",) or SENDER.startswith("file:"):
        return None   # test senders
    if SENDER != "telegram":
        return "unknown UPTIME_SENDER: %r" % SENDER   # a mistyped value must not give a silent green
    chat, chat_reason = resolve_chat()
    missing = [n for n, v in (("TELEGRAM_BOT_TOKEN (%s)" % TELEGRAM_ENV, bot_token()),
                              ("chat_id (%s)" % chat_reason, chat),
                              ("send-telegram.sh", os.path.isfile(SEND_HELPER))) if not v]
    return ", ".join(missing) or None


def gate_error():
    """Whether the gate LOADS and WORKS (on a fixed, correct text): the mere existence of the file is not enough, and a
    gate failure is not a config error. Returns: a description of the fault, or None."""
    ok, reason = gate_check(TEXTS["gate_probe"])
    return None if ok else "the outgoing-copy gate is not usable: %s" % str(reason)[:300]


def main():
    k = load_config()
    targets = k["targets"]
    wait = float(k.get("wait_seconds", 90))   # from the config only: this is the value I4 checked
    state = read_state()
    now = time.time()
    threshold = int(k.get("blind_notice_runs", 6))
    send_failed = False
    missing = preflight_error()
    ge = gate_error()
    if ge:
        missing = (missing + "; " if missing else "") + ge
    if missing:
        # the measurement still runs (state, log), but the code is 4: the unit's OnFailure reports it
        print("THE SEND PATH IS INCOMPLETE: %s -- alerts could not be sent" % missing, file=sys.stderr)
        log_event(event="send-path-incomplete", missing=missing)
        send_failed = True
    if not ge:
        ne = target_name_gate_error(targets)
        if ne:
            raise ConfigError(ne)
    first_v = {c["name"]: measure(c) for c in targets}
    first = {n: e for n, (e, _) in first_v.items()}
    final = dict(first)
    if any(first.values()):
        time.sleep(wait)
        # the confirming round measures EVERY target again: the state of the network is decided by the current answers
        # and the reference, not by the first round ~wait_seconds earlier; a fine target keeps its first-round verdict
        # (a single failure is not an outage)
        answered = False
        for c in targets:
            e2, a2 = measure(c)
            answered = answered or a2
            if first[c["name"]]:
                final[c["name"]] = e2
        # the reference AFTER the second measurement: that is the state of the network at confirmation time
        ref = check_reference(k["reference"])
        if ref != "ok":
            log_event(event="reference-error", state=ref)
        # NOT MEASURABLE only if in the confirming round no target gave an HTTP answer and neither did the reference:
        # if a target in the confirming round or the reference answered, the round is measurable.
        if ref == "no-answer" and not answered:
            v = state.get("_blind", {"runs": 0, "since": now})
            v["runs"] = v.get("runs", 0) + 1
            v.setdefault("since", now)
            if v["runs"] >= threshold and not v.get("notified"):
                ok = send(*blind_now_text(minutes_text(now - v["since"])))
                v["notified"] = ok
                send_failed = send_failed or not ok
                log_event(event="blind-now-notice", sent=ok)
            state["_blind"] = v
            write_state(state)
            log_event(verdict="not-measurable", reason="no target and not the reference gave an HTTP answer",
                      first=first)
            print("NOT MEASURABLE: no target and not the reference gave an HTTP answer")
            return 4 if send_failed else 2
    blind = state.pop("_blind", None)
    if blind and blind.get("runs", 0) >= threshold:
        # the streak CLOSES here (a later new streak must not merge into it); the "measuring again" notice is a
        # separate pending item, retried by the next runs until it goes out
        prev = state.get("_blind_pending", {}).get("minutes", 0)
        state["_blind_pending"] = {"minutes": prev + max(1, round((now - blind.get("since", now)) / 60))}
    pending = state.get("_blind_pending")
    if pending:
        ok = send(*blind_over_text(TEXTS["minutes"] % pending.get("minutes", 1)))
        log_event(event="blind-notice", sent=ok)
        if ok:
            state.pop("_blind_pending", None)
        else:
            send_failed = True
    code = 0
    for c in targets:
        name, url = c["name"], c["url"]
        a = state.get(name, {"down": False})
        err = final[name]
        if err:
            code = 3
            if not a.get("down"):
                a = {"down": True, "down_since": now, "alerted": False, "error": err}
            if not a.get("alerted"):
                ok = send(*alert_text(name, url, err, wait))
                a["alerted"] = ok
                send_failed = send_failed or not ok
                log_event(target=name, event="alert", sent=ok, error=err)
        else:
            if first[name]:
                log_event(target=name, event="flapping", first_error=first[name])
            if a.get("down"):
                if a.get("alerted"):
                    ok = send(*recovery_text(name, url, minutes_text(now - a.get("down_since", now))))
                    log_event(target=name, event="recovery", sent=ok)
                    if not ok:
                        send_failed = True
                        state[name] = a   # the notice is sent again in the next run
                        continue
                else:
                    log_event(target=name, event="outage-not-reported", down_since=a.get("down_since"))
                a = {"down": False}
        state[name] = a
    write_state(state)
    print("verdict: %s" % ", ".join("%s=%s" % (c["name"], "down (%s)" % final[c["name"]] if final[c["name"]] else "ok")
                                    for c in targets))
    return 4 if send_failed else code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ConfigError as e:
        print("CONFIG ERROR: %s" % e, file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 -- internal error: the unit's OnFailure reports it
        print("INTERNAL ERROR: %r" % e, file=sys.stderr)
        sys.exit(1)
