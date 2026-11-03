#!/usr/bin/env python3
"""Hermetic test of scripts/uptime-monitor.py.

A local HTTP server (127.0.0.1) stands in for the targets and the reference; the config is written to a temporary
directory; messages go to a file (UPTIME_SENDER=file:), so there is no Telegram call and no external network. Every
message still passes through the real outgoing-copy gate (scripts/hooks/sender_check.py). The T22 cases run the real
Telegram path (UPTIME_SENDER=telegram) in a throwaway install tree against the same local server acting as the Bot API
(TELEGRAM_API_BASE, the send-telegram.sh test seam); every other run points TELEGRAM_API_BASE at a closed port, HOME at
its temporary directory, and has the proxy variables cleared, so the real API is never reachable from this test.

Cases:
  T1  all targets fine: exit 0, no message
  T2  the site answers 200 with an empty body: after two strikes exit 3, EXACTLY one alert, naming 'site' (content
      is measured, not only the status)
  T3  flapping: the first measurement fails, the second is fine: exit 0, no message, 'flapping' in the log
  T4  a lasting outage over two runs: EXACTLY one alert in total (one alert per event)
  T5  recovery after T4: EXACTLY one 'Recovered' message; a further run sends nothing
  T6  failed send: the first run's send fails (UPTIME_SENDER=fail) and exits 4 (not a unit success: OnFailure fires),
      the second run (still down, sending works) sends the alert: the state stamp did not bury it
  T7  nothing gives an HTTP answer (targets and reference on a closed port): exit 2 (NOT MEASURABLE), no message, no
      target marked down; T7b every target AND the reference answer 503: the network works, so the run is measurable
      and both targets are alerted (exit 3); T7c one target fine, the other 503, the reference gives no answer: the run
      is measurable (a dead reference does not silence a real outage), the 503 target is alerted and the log names the
      reference problem
  T8  the embedded widget returns the wrong slug in __NEXT_DATA__: exit 3, alert naming 'widget'
  T9  blind streak: two NOT MEASURABLE runs (blind_notice_runs=2, nothing answers), then a measurable one: the text
      says exactly what was measured (no target and not the reference URL gave an answer); the second blind run sends
      EXACTLY one "not been able to measure" notice already during the streak (a dead reference must not silence
      everything), and the measurable run sends EXACTLY one "could not measure ... measuring again now"; one NOT
      MEASURABLE run below the threshold sends nothing (T9b); a third blind run does not repeat the in-streak notice
      (T9c)
  T10 the outgoing-copy gate refuses the detailed alert (a variant script puts an em dash into the detailed template;
      a config cannot produce one any more, since target URLs must be ASCII): the fixed fallback text without the URL is
      sent instead
  T11 a target NAME with which even the fallback alert cannot pass the gate (an em dash): a config error at load,
      exit 1, nothing sent (not at the first outage); T11b the gate refuses both texts during the run (the send-side
      gate call is mutated to refuse): nothing is sent, exit 4, the log names both refusals, and the target stays
      un-alerted (alerted false), so a later run retries
  T12 missing config: exit 1 (the unit's OnFailure fires: a monitor without config watches nothing)
  T13 a target without any content signal: exit 1; T13b a target named '_blind' (an internal state key): exit 1;
  T13c a non-string target name, and a 'contains' given as a plain string: exit 1 each
  T16 a gzip answer under the transfer cap that decompresses over it (UPTIME_MAX_BYTES=20000): treated as an answer
      that is too large, not as 'no answer', and alerted; T16b a plain answer over the TRANSFER cap: the same
  T7d the target that was fine in the first round and the reference both give no HTTP answer in the confirming round
      (the server drops the connection): NOT MEASURABLE (exit 2), no alert -- a first-round answer ~90 s earlier does
      not prove the network works now
  T14 corrupt state file: the run goes on with an empty state (exit 0), the file is moved to .corrupt, the log names
      it; T14b a state file that parses but has the wrong shape (a non-object entry): handled the same way
  T15b the outgoing-copy gate cannot load (the script copied into a tree without scripts/hooks/): exit 4, not 1; the
      measurement still runs, nothing is sent, the log names the gate
  T17 a target answers HTTP with an unreadable body (marked gzip, not gzip) while the other target and the reference
      give no answer: the run is measurable and the target is alerted as 'unreadable' (an error after the status line
      is an answer)
  T9d the post-streak "measuring again" notice fails to send: the next (fine) run sends it, exactly once, and the blind
      state is closed
  T13d a negative wait_seconds, a blind_notice_runs of 0, a non-string title_contains, a non-object next_data, a
      next_data with no signal ({"equals": {}}, {"non_empty": []}), a misspelled sub-key, or non_empty/false given as
      plain strings, a NaN or too large (300 s: over the I4 run budget) wait_seconds, a non-ASCII target URL, and a
      null expected value in equals: exit 1 each
  T9e the first streak's "measuring again" notice fails, then a second full blind streak follows, then a measurable
      run: ONE notice goes out with the summed minutes ("about 2 min"); the first streak's notice is not lost
  T14c a state file made of objects but with a wrong-typed field (down_since as text): treated as corrupt, set aside,
      exit 0
  T14d wrong-typed state fields one by one: a non-boolean 'down', a NaN down_since, a text since, runs or minutes: each
      treated as corrupt, set aside, exit 0
  T15c an unknown UPTIME_SENDER value (a typo): even a fine run exits 4
  T19 invariant I4, the run budget at config load (UPTIME_TIMEOUT=20): two targets + 130 s wait = 410 s loads (exit
      0); two targets + 131 s = 411 s and three targets + 90 s = 470 s are config errors (exit 1); two targets with
      UPTIME_TIMEOUT=60 (480.2 s) are a config error, three targets at exactly 410 s load, at 411 s do not; a NaN
      UPTIME_TIMEOUT is a config error; an UPTIME_WAIT of 30 s in the environment is not read: with a target failing
      the first round (so the wait is reached) and a 0.2 s config wait the run ends within 10 s
  T20 invariant I1, first strike: the widget fails both rounds (so a confirming round runs), the site is fine in the
      first round and fails the confirming one: only the widget is alerted
  T9f invariant I2 on the NOT MEASURABLE branch: the in-streak notice fails to send -> exit 4, not 2
  T21 I2/I3 on the recovery branch: the outage alert went out, the recovering run's send fails -> exit 4, nothing sent,
      state still down + alerted; the next run sends exactly one 'Recovered'
  T18 the alert about an outage never went out (sending failed), then the target recovers: no recovery message, and
      the log gets an 'outage-not-reported' line
  T15 the send path is incomplete (UPTIME_SENDER=telegram, no .env): even with every target fine the run exits 4 (the
      broken delivery path shows before the first outage) and contacts nobody
  T22 the real send path in a throwaway install tree: the install .env has ALLOWED_CHAT_ID, the main channel dir has the
      bot token (quoted) and an access.json with a different DM id, and an inherited TELEGRAM_STATE_DIR points at a
      decoy dir with another token and chat: the Bot API stub receives exactly one sendMessage, on the main channel's
      token, to the .env chat id (the env id wins over access.json, the inherited state dir is ignored), with the alert
      text; T22b ALLOWED_CHAT_ID is the "0" placeholder and access.json holds one DM entry next to a group id: the alert
      goes to that DM entry; T22c access.json holds two DM entries: no chat (exit 4, nothing reaches the stub, the
      preflight log line carries the resolver's "refusing to guess" reason); T22d access.json holds only a group id: the
      same, with the "no DM entry" reason; T22e MARVEEN_ALERT_CHAT_ID is an explicit override over the .env id
  G1  every alert/recovery/blind text the script can build for the target names 'site', 'widget', 'website' and
      'caf\u00e9-booking' (example URLs only), with every error text in G1's own list (not every exception name the script
      can print), passes the outgoing-copy gate; G1k: the same alert with an em dash in it is REFUSED (the gate is
      really applied to this kind of text)
Controls (a mutant copy of the script; the named case must fail on it):
  M-confirm (T3), M-dedup (T4), M-content (T2), M-stamp (T6), M-reference (T7), M-gzip (T1, the /widget answer is gzip
  as on a typical live service), M-gate (T10: without the gate the detailed text with the URL goes out), M-blind-over
  (T9: without the recovery blind notice it is missing), M-blind-now (T9: without the in-streak notice it is missing),
  M-send-code (T6: without the exit-4 rule the failed send exits 3), M-preflight (T15: without the preflight the run
  exits 0), M-answer (T7c: if a dead reference alone made the run NOT MEASURABLE, the 503 target would go unreported),
  M-decompressed-cap (T16: without the decompressed-size cap the oversized answer passes), M-transfer-cap (T16b:
  without the transfer cap it passes), M-second-round (T7d: if a first-round pass counted as an answer, the 503 target
  would be alerted although nothing answered in the confirming round), M-blind-pending (T9d), M-budget (T19: without
  the I4 budget check the 470 s config loads), M-wait-env (T19: if the wait came from UPTIME_WAIT, the k5 run would
  take over 30 s), M-budget-timeout and M-budget-n (T19: a budget formula with a fixed 20 s timeout or a fixed 5
  requests would load the 480.2 s / 411 s configs), M-recovery-code and M-recovery-retry (T21: a failed recovery send
  would exit non-4, or the recovery message would never be resent), M-first-strike (T20: without the first-strike guard
  the confirming-round failure alone alerts), M-blind-code (T9f: the NOT MEASURABLE branch exits 2 despite the failed
  send), M-next-data (T13d: without the "at least one signal" rule a content-less next_data loads), M-blind-sum (T9e:
  without summing, the merged notice says the second streak's minutes only), M-state-type (T14c: without the field
  type check the run exits 1), M-gate-error (T15b: without the gate preflight the target-name check meets the broken
  gate and the run exits 1, not 4), M-answered (T17: if an unreadable answer counted as no answer, the run would be NOT
  MEASURABLE).
A mutant whose anchor does not occur exactly once is NOT MEASURABLE (FAIL). The temporary directory is removed; a
leftover is a FAIL.
Run: python3 scripts/__tests__/uptime-monitor.test.py   (exit 0 = every case and control as expected, 1 = a mismatch)
"""
import gzip
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "uptime-monitor.py")
FAILS = []

SITE_OK = ('<html><head><title>Example Site Home</title></head><body>'
           '<iframe src="https://booking.example/example-slug/embed"></iframe>'
           '<script>GTM-TEST</script></body></html>')
NEXT = {"props": {"pageProps": {"_nextI18Next": {"initialI18nStore": {"en": {"common": {"a": "b"}}}}}},
        "page": "/[slug]/embed", "query": {"slug": "example-slug"}, "buildId": "x1", "isFallback": False}


def widget_html(next_data):
    return ('<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">%s</script>'
            '</body></html>' % json.dumps(next_data))


WIDGET_OK = widget_html(NEXT)
WIDGET_BAD = widget_html(dict(NEXT, query={"slug": "other-slug"}))
OK, WOK, REF, DOWN = (200, SITE_OK), (200, WIDGET_OK), (204, ""), (503, "")


class Server:
    """Per path a queue of (status, body); the last item repeats."""

    def __init__(self):
        self.answers = {}
        self.posts = []   # (path, form fields) of every POST: the Bot API stub's record
        srv = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                queue = srv.answers.get(self.path.split("?")[0], [(404, "")])
                status, body = queue.pop(0) if len(queue) > 1 else queue[0]
                if status is None:   # "no answer": the connection is dropped without an HTTP answer
                    self.close_connection = True
                    self.connection.shutdown(2)
                    return
                b = body.encode()
                self.send_response(status)
                if self.path.startswith("/badgzip"):   # marked gzip, but the body is not gzip: an answer, unreadable
                    b = b"this is not gzip"
                    self.send_header("Content-Encoding", "gzip")
                elif self.path.startswith("/widget") and "gzip" in (self.headers.get("Accept-Encoding") or ""):
                    b = gzip.compress(b)
                    self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_POST(self):   # the Bot API stub (TELEGRAM_API_BASE): records the call, answers "ok":true
                n = int(self.headers.get("Content-Length") or 0)
                srv.posts.append((self.path, urllib.parse.parse_qs(self.rfile.read(n).decode())))
                b = b'{"ok":true,"result":{"message_id":1}}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def log_message(self, *a):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def set(self, site, widget, ref):
        self.answers = {"/site": list(site), "/widget": list(widget), "/ref": list(ref)}


def dead_port():
    """A port nothing listens on (bound, then released): the connection is refused at once and there is no HTTP
    answer -- this is the 'gave no answer' state."""
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


DEAD = dead_port()


def config(srv, folder, site_name="site", site_path="/site", blind=6, widget_signal=True, dead=(), extra=None):
    """dead: which of 'site'/'widget'/'ref' points to the dead port (no HTTP answer)."""
    def addr(name, path):
        return "http://127.0.0.1:%d%s" % (DEAD if name in dead else srv.port, path)
    k = {"targets": [
        {"name": site_name, "url": addr("site", site_path), "title_contains": "Example Site",
         "contains": ["example-slug/embed", "GTM-TEST"]},
        {"name": "widget", "url": addr("widget", "/widget")}],
        "reference": addr("ref", "/ref"), "wait_seconds": 0.2, "blind_notice_runs": blind}
    if widget_signal:
        k["targets"][1]["next_data"] = {"equals": {"page": "/[slug]/embed", "query.slug": "example-slug"},
                                        "non_empty": ["buildId", "props.pageProps._nextI18Next.initialI18nStore.en"],
                                        "false": ["isFallback"]}
    if extra:
        extra(k)
    path = os.path.join(folder, "targets.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(k, fh)
    return path


PROXY_VARS = ("http_proxy", "https_proxy", "all_proxy", "no_proxy",
              "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")


def run(script, folder, config_path, sender="file", env_extra=None, env_drop=()):
    messages = os.path.join(folder, "messages.txt")
    env = dict(os.environ, UPTIME_CONFIG=config_path, UPTIME_STATE=os.path.join(folder, "state.json"),
               UPTIME_LOG=os.path.join(folder, "log.jsonl"), UPTIME_TIMEOUT="5",
               UPTIME_SENDER=("file:" + messages) if sender == "file" else sender,
               TELEGRAM_ENV="/nonexistent", TELEGRAM_STATE_DIR="/nonexistent", MARVEEN_ALERT_CHAT_ID="",
               TELEGRAM_API_BASE="http://127.0.0.1:%d" % DEAD, HOME=folder, PYTHONDONTWRITEBYTECODE="1")
    for v in ("UPTIME_MAX_BYTES",) + PROXY_VARS + tuple(env_drop):
        env.pop(v, None)
    env.update(env_extra or {})
    p = subprocess.run([sys.executable, script], env=env, capture_output=True, text=True, timeout=90)
    try:
        msgs = open(messages, encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        msgs = []
    return p.returncode, msgs, p.stdout + p.stderr


def log(folder):
    try:
        return [json.loads(s) for s in open(os.path.join(folder, "log.jsonl"), encoding="utf-8")]
    except FileNotFoundError:
        return []


def state(folder):
    try:
        return json.load(open(os.path.join(folder, "state.json"), encoding="utf-8"))
    except FileNotFoundError:
        return {}


def t1(s, srv, m):
    srv.set([OK], [WOK], [REF])
    code, msgs, out = run(s, m, config(srv, m))
    return code == 0 and msgs == [], "code %s, messages %s, %s" % (code, msgs, out[-300:])


def t2(s, srv, m):
    srv.set([(200, "")], [WOK], [REF])
    code, msgs, _ = run(s, m, config(srv, m))
    return code == 3 and len(msgs) == 1 and msgs[0].startswith("Uptime alert: site "), "code %s, %s" % (code, msgs)


def t3(s, srv, m):
    srv.set([DOWN, OK], [WOK], [REF])
    code, msgs, _ = run(s, m, config(srv, m))
    flap = any(n.get("event") == "flapping" for n in log(m))
    return code == 0 and msgs == [] and flap, "code %s, %s, flapping %s" % (code, msgs, flap)


def t4(s, srv, m):
    srv.set([DOWN], [WOK], [REF])
    k = config(srv, m)
    code1, _, _ = run(s, m, k)
    code2, msgs, _ = run(s, m, k)
    return code1 == 3 and code2 == 3 and len(msgs) == 1, "codes %s/%s, %s" % (code1, code2, msgs)


def t5(s, srv, m):
    srv.set([DOWN], [WOK], [REF])
    k = config(srv, m)
    run(s, m, k)
    srv.set([OK], [WOK], [REF])
    code, msgs, _ = run(s, m, k)
    _, msgs3, _ = run(s, m, k)
    rec = [u for u in msgs if u.startswith("Recovered: site ")]
    return code == 0 and len(msgs) == 2 and len(rec) == 1 and msgs3 == msgs, "%s / %s" % (msgs, msgs3)


def t6(s, srv, m):
    srv.set([DOWN], [WOK], [REF])
    k = config(srv, m)
    code1, msgs1, _ = run(s, m, k, sender="fail")
    code2, msgs2, _ = run(s, m, k)
    return code1 == 4 and msgs1 == [] and code2 == 3 and len(msgs2) == 1 and msgs2[0].startswith("Uptime alert"), \
        "codes %s/%s, %s / %s" % (code1, code2, msgs1, msgs2)


def t7(s, srv, m):
    code, msgs, _ = run(s, m, config(srv, m, dead=("site", "widget", "ref")))
    down = [n for n, a in state(m).items() if isinstance(a, dict) and a.get("down")]
    return code == 2 and msgs == [] and not down, "code %s, %s, down %s" % (code, msgs, down)


def t7b(s, srv, m):
    srv.set([DOWN], [DOWN], [DOWN])
    code, msgs, _ = run(s, m, config(srv, m))
    return code == 3 and len(msgs) == 2, "code %s, %s" % (code, msgs)


def t7c(s, srv, m):
    srv.set([OK], [DOWN], [REF])
    code, msgs, _ = run(s, m, config(srv, m, dead=("ref",)))
    ref_err = any(n.get("event") == "reference-error" for n in log(m))
    return code == 3 and len(msgs) == 1 and msgs[0].startswith("Uptime alert: widget ") and ref_err, \
        "code %s, %s, reference-error %s" % (code, msgs, ref_err)


def t8(s, srv, m):
    srv.set([OK], [(200, WIDGET_BAD)], [REF])
    code, msgs, _ = run(s, m, config(srv, m))
    return code == 3 and len(msgs) == 1 and msgs[0].startswith("Uptime alert: widget ") and "query.slug" in msgs[0], \
        "code %s, %s" % (code, msgs)


def t9(s, srv, m):
    k = config(srv, m, blind=2, dead=("site", "widget", "ref"))
    code1, msgs1, _ = run(s, m, k)
    code2, msgs2, _ = run(s, m, k)
    srv.set([OK], [WOK], [REF])
    code, msgs, _ = run(s, m, config(srv, m, blind=2))
    now = [u for u in msgs if "has not been able to measure" in u
           and "no target and not the reference URL gives an answer" in u]
    over = [u for u in msgs if "could not measure" in u
            and "no target and not the reference URL gave an answer" in u and "measuring again now" in u]
    return (code1 == 2 and msgs1 == [] and code2 == 2 and len(msgs2) == 1 and len(now) == 1 and code == 0
            and len(msgs) == 2 and len(over) == 1), "codes %s/%s/%s, %s" % (code1, code2, code, msgs)


def t9c(s, srv, m):
    k = config(srv, m, blind=2, dead=("site", "widget", "ref"))
    for _ in range(3):
        code, msgs, _ = run(s, m, k)
    return code == 2 and len(msgs) == 1, "code %s, %s" % (code, msgs)


def t9b(s, srv, m):
    run(s, m, config(srv, m, blind=2, dead=("site", "widget", "ref")))
    srv.set([OK], [WOK], [REF])
    code, msgs, _ = run(s, m, config(srv, m, blind=2))
    return code == 0 and msgs == [] and "_blind" not in state(m), "code %s, %s, %s" % (code, msgs, state(m))


def t10(s, srv, m):
    """The gate refuses the DETAILED alert and lets the fallback through: the fallback goes out. A variant script puts
    an em dash into the detailed template (since target URLs must be ASCII, a config cannot produce one any more)."""
    srv.set([DOWN], [WOK], [REF])
    src = open(s, encoding="utf-8").read()
    old = "Reason: %(error)s. Two measurements"
    if src.count(old) != 1:
        return False, "the detailed template does not occur exactly once"
    mut = os.path.join(os.path.dirname(s), ".uptime-t10-%d.py" % os.getpid())
    try:
        with open(mut, "w", encoding="utf-8") as fh:
            fh.write(src.replace(old, "Reason: %(error)s \u2014 Two measurements"))
        code, msgs, _ = run(mut, m, config(srv, m))
    finally:
        os.remove(mut)
    refused = any(n.get("event") == "gate-refused" for n in log(m))
    return code == 3 and len(msgs) == 1 and "URL:" not in msgs[0] and "monitor's log" in msgs[0] and refused, \
        "code %s, %s, refused %s" % (code, msgs, refused)


def t11(s, srv, m):
    srv.set([DOWN], [WOK], [REF])
    code, msgs, out = run(s, m, config(srv, m, site_name="site\u2014x"))
    return code == 1 and msgs == [] and "outgoing-copy gate" in out, "code %s, %s, %s" % (code, msgs, out[-200:])


def t11b(s, srv, m):
    """The alert does not pass DURING the run either (the gate refuses both texts): exit 4, nothing goes out, the target
    stays un-alerted. The load check would already reject such a name, so the send-side gate call is mutated to refuse
    (the load check uses the real gate, which lets the name through)."""
    srv.set([DOWN], [WOK], [REF])
    src = open(s, encoding="utf-8").read()
    old = "        ok, reason = gate_check(candidate)\n"
    if src.count(old) != 1:
        return False, "the gate call does not occur exactly once"
    mut = os.path.join(os.path.dirname(s), ".uptime-t11b-%d.py" % os.getpid())
    try:
        with open(mut, "w", encoding="utf-8") as fh:
            fh.write(src.replace(old, "        ok, reason = False, 'test: the gate refuses it'\n"))
        code, msgs, _ = run(mut, m, config(srv, m))
    finally:
        os.remove(mut)
    refused = sum(1 for n in log(m) if n.get("event") == "gate-refused")
    a = state(m).get("site", {})
    return code == 4 and msgs == [] and refused == 2 and a.get("down") and not a.get("alerted"), \
        "code %s, %s, refused %s, state %s" % (code, msgs, refused, a)


def t12(s, srv, m):
    code, msgs, out = run(s, m, os.path.join(m, "missing.json"))
    return code == 1 and msgs == [] and "CONFIG ERROR" in out, "code %s, %s" % (code, out[-200:])


def t13(s, srv, m):
    code, msgs, out = run(s, m, config(srv, m, widget_signal=False))
    return code == 1 and "no content signal" in out, "code %s, %s" % (code, out[-200:])


def t13c(s, srv, m):
    def non_string(k):
        k["targets"][1]["name"] = 123
    code1, _, out1 = run(s, m, config(srv, m, extra=non_string))

    def string_contains(k):
        k["targets"][0]["contains"] = "GTM-TEST"
    code2, _, out2 = run(s, m, config(srv, m, extra=string_contains))
    return code1 == 1 and code2 == 1 and "contains" in out2, \
        "codes %s/%s, %s | %s" % (code1, code2, out1[-120:], out2[-120:])


def t16(s, srv, m):
    big = widget_html(dict(NEXT, buildId="x" * 50000))   # compresses well: transferred < 20000, decompressed > 20000
    srv.set([OK], [(200, big)], [REF])
    code, msgs, out = run(s, m, config(srv, m), env_extra={"UPTIME_MAX_BYTES": "20000"})
    return code == 3 and len(msgs) == 1 and "too large" in msgs[0], "code %s, %s, %s" % (code, msgs, out[-200:])


def t16b(s, srv, m):
    big = (200, SITE_OK + "x" * 30000)   # not gzip (only /widget is): the TRANSFERRED size exceeds the cap
    srv.set([big], [WOK], [REF])
    code, msgs, out = run(s, m, config(srv, m), env_extra={"UPTIME_MAX_BYTES": "20000"})
    return code == 3 and len(msgs) == 1 and msgs[0].startswith("Uptime alert: site ") and "too large" in msgs[0], \
        "code %s, %s, %s" % (code, msgs, out[-200:])


def t7d(s, srv, m):
    """In the confirming round neither the target that was fine (site) nor the reference answers: the network is down
    at confirmation time -- NOT MEASURABLE, not an alert (a first-round answer does not prove the current network)."""
    # first round: the site fine, the widget 503; confirming round: nothing gives an HTTP answer (the server drops)
    srv.set([OK, (None, "")], [DOWN, (None, "")], [(None, "")])
    code, msgs, _ = run(s, m, config(srv, m))
    return code == 2 and msgs == [], "code %s, %s" % (code, msgs)


def t13d(s, srv, m):
    bad = [lambda k: k.update(wait_seconds=-1), lambda k: k.update(blind_notice_runs=0),
           lambda k: k["targets"][0].update(title_contains=5), lambda k: k["targets"][1].update(next_data=["x"]),
           # a next_data without a content signal, with a misspelled sub-key, and with string lists
           lambda k: k["targets"][1].update(next_data={"equals": {}}),
           lambda k: k["targets"][1].update(next_data={"non_empty": []}),
           lambda k: k["targets"][1].update(next_data={"equal": {"page": "x"}}),
           lambda k: k["targets"][1].update(next_data={"non_empty": "buildId", "false": "isFallback"}),
           # a non-finite / too large wait, a non-ASCII target URL
           lambda k: k.update(wait_seconds=float("nan")), lambda k: k.update(wait_seconds=300),
           lambda k: k["targets"][0].update(url="http://127.0.0.1:1/caf\u00e9"),
           # a null expected value in equals
           lambda k: k["targets"][1].update(next_data={"equals": {"page": None}})]
    codes = [run(s, m, config(srv, m, extra=f))[0] for f in bad]
    return codes == [1] * len(bad), "codes %s" % codes


def t9e(s, srv, m):
    """The first streak's "measuring again" notice does not go out, then a second full blind streak follows, then a
    measurable run: ONE notice goes out, with the summed minutes of both streaks -- the first streak's notice is not
    lost. The streaks are short (rounded to 1 minute each), so the notice says 'about 2 min'."""
    md, mf = os.path.join(m, "d"), os.path.join(m, "f")
    os.makedirs(md)
    os.makedirs(mf)
    dead = config(srv, md, blind=2, dead=("site", "widget", "ref"))
    srv.set([OK], [WOK], [REF])
    fine = config(srv, mf, blind=2)
    run(s, m, dead)
    run(s, m, dead)
    run(s, m, fine, sender="fail")              # the first streak's notice fails: pending
    run(s, m, dead)
    run(s, m, dead)                             # the second streak closes in the next measurable run as well
    code, msgs, _ = run(s, m, fine)
    over = [u for u in msgs if "measuring again now" in u]
    return code == 0 and len(over) == 1 and "about 2 min" in over[0], "code %s, %s" % (code, msgs)


def t14c(s, srv, m):
    """The state file is made of objects, but a field has the wrong type (down_since as text): it counts as corrupt, is
    set aside, exit 0 -- otherwise every run would stop with a TypeError (exit 1)."""
    srv.set([OK], [WOK], [REF])
    with open(os.path.join(m, "state.json"), "w") as fh:
        json.dump({"site": {"down": True, "alerted": True, "down_since": "x"}}, fh)
    code, msgs, out = run(s, m, config(srv, m))
    corrupt = any(n.get("event") == "corrupt-state" for n in log(m))
    return code == 0 and corrupt and os.path.exists(os.path.join(m, "state.json.corrupt")), \
        "code %s, %s, corrupt %s, %s" % (code, msgs, corrupt, out[-200:])


def t14d(s, srv, m):
    """Wrong-typed state fields one by one: a boolean field with a non-boolean value, a non-finite down_since (json.load
    accepts NaN), a text since / runs / minutes. Each is corrupt: set aside, exit 0."""
    bad = [{"site": {"down": "yes"}}, {"site": {"down": True, "alerted": True, "down_since": float("nan")}},
           {"_blind": {"runs": 1, "since": "x"}}, {"_blind": {"runs": "1", "since": 1}},
           {"_blind_pending": {"minutes": "2"}}]
    srv.set([OK], [WOK], [REF])
    results = []
    for i, a in enumerate(bad):
        mm = os.path.join(m, str(i))
        os.makedirs(mm)
        with open(os.path.join(mm, "state.json"), "w") as fh:
            json.dump(a, fh)
        code, _, _ = run(s, mm, config(srv, mm))
        results.append((code, os.path.exists(os.path.join(mm, "state.json.corrupt"))))
    return results == [(0, True)] * len(bad), "results %s" % results


def t15c(s, srv, m):
    """An unknown UPTIME_SENDER (a typo): even a fine run exits 4."""
    srv.set([OK], [WOK], [REF])
    code, msgs, _ = run(s, m, config(srv, m), sender="telegarm")
    return code == 4 and msgs == [], "code %s, %s" % (code, msgs)


def t19(s, srv, m):
    """I4: the run budget at config load. With UPTIME_TIMEOUT=20: two targets + 130 s wait = 5x20+130+3x60 = 410 s,
    fits (exit 0); two targets + 131 s = 411 s, exit 1; three targets + 90 s = 7x20+90+4x60 = 470 s, exit 1."""
    srv.set([OK], [WOK], [REF])
    env = {"UPTIME_TIMEOUT": "20"}

    def three(k):
        k["targets"].append(dict(k["targets"][0], name="third"))
        k["wait_seconds"] = 90
    k1, _, out1 = run(s, m, config(srv, m, extra=lambda k: k.update(wait_seconds=130)), env_extra=env)
    k2, _, out2 = run(s, m, config(srv, m, extra=lambda k: k.update(wait_seconds=131)), env_extra=env)
    k3, _, out3 = run(s, m, config(srv, m, extra=three), env_extra=env)
    # a non-finite UPTIME_TIMEOUT (NaN > 410 would be false) and a wait override from the environment cannot get
    # around I4 (UPTIME_WAIT: the script does not read it)
    k4, _, out4 = run(s, m, config(srv, m), env_extra={"UPTIME_TIMEOUT": "nan"})
    # k5: the site FAILS the first round, so the run reaches the wait; the config says 0.2 s, the environment 30 s. If
    # the script read the environment, the run would take over 30 s -- expected: done within 10 s.
    srv.set([DOWN, OK], [WOK], [REF])
    t0 = time.monotonic()
    k5, _, _ = run(s, m, config(srv, m), env_extra={"UPTIME_TIMEOUT": "20", "UPTIME_WAIT": "30"})
    k5_s = time.monotonic() - t0
    # the formula uses the CONFIGURED timeout and the number of targets, not a default timeout (k6: two targets,
    # UPTIME_TIMEOUT=60, 0.2 s wait: 5x60+0.2+3x60 = 480.2 s, exit 1), and three targets exactly at the limit (k7:
    # 7x20+30+4x60 = 410 s, exit 0; k8: a 31 s wait = 411 s, exit 1)
    srv.set([OK], [WOK], [REF])
    k6, _, _ = run(s, m, config(srv, m), env_extra={"UPTIME_TIMEOUT": "60"})

    def three_w(w):
        def f(k):
            k["targets"].append(dict(k["targets"][0], name="third"))
            k["wait_seconds"] = w
        return f
    k7, _, out7 = run(s, m, config(srv, m, extra=three_w(30)), env_extra=env)
    k8, _, _ = run(s, m, config(srv, m, extra=three_w(31)), env_extra=env)
    return (k1 == 0 and k2 == 1 and "unit budget" in out2 and k3 == 1 and "N=3" in out3 and k4 == 1
            and "UPTIME_TIMEOUT" in out4 and k5 == 0 and k5_s < 10 and k6 == 1 and k7 == 0 and k8 == 1), \
        "codes %s/%s/%s/%s/%s/%s/%s/%s, k5 %.1f s, %s | %s" % (k1, k2, k3, k4, k5, k6, k7, k8, k5_s, out2[-150:],
                                                               out7[-150:])


def t20(s, srv, m):
    """I1, the FIRST strike: the widget fails both rounds (this starts the confirming round), the site is fine in the
    first round and fails the confirming one. For the site that is a single failure: only the widget is alerted."""
    srv.set([OK, DOWN], [DOWN], [REF])
    code, msgs, _ = run(s, m, config(srv, m))
    return code == 3 and len(msgs) == 1 and msgs[0].startswith("Uptime alert: widget "), "code %s, %s" % (code, msgs)


def t9f(s, srv, m):
    """I2 on the NOT MEASURABLE branch: the blind notice fails to send (threshold 1, UPTIME_SENDER=fail) -> exit 4,
    not 2."""
    code, msgs, _ = run(s, m, config(srv, m, blind=1, dead=("site", "widget", "ref")), sender="fail")
    return code == 4 and msgs == [], "code %s, %s" % (code, msgs)


def t21(s, srv, m):
    """I2/I3 on the recovery branch: the outage alert went out; in the recovering run the send fails -> exit 4, nothing
    goes out, the state stays down + alerted; the next (working) run sends exactly one 'Recovered'."""
    srv.set([DOWN], [WOK], [REF])
    k = config(srv, m)
    run(s, m, k)
    srv.set([OK], [WOK], [REF])
    code2, msgs2, _ = run(s, m, k, sender="fail")
    a = state(m).get("site", {})
    code3, msgs3, _ = run(s, m, k)
    rec = [u for u in msgs3 if u.startswith("Recovered: site ")]
    return (code2 == 4 and a.get("down") is True and a.get("alerted") is True and code3 == 0 and len(rec) == 1
            and len(msgs3) == 2), "codes %s/%s, state %s, %s" % (code2, code3, a, msgs3)


def t18(s, srv, m):
    """The alert about the outage did not go out (UPTIME_SENDER=fail), then the target recovers: NO recovery notice, the
    log gets an 'outage-not-reported' line."""
    srv.set([DOWN], [WOK], [REF])
    k = config(srv, m)
    run(s, m, k, sender="fail")
    srv.set([OK], [WOK], [REF])
    code, msgs, _ = run(s, m, k)
    nrep = any(n.get("event") == "outage-not-reported" for n in log(m))
    return code == 0 and msgs == [] and nrep, "code %s, %s, not-reported %s" % (code, msgs, nrep)


def t15b(s, srv, m):
    """The gate does not load (a copy of the script in the scripts/ folder of a tree without hooks/): exit 4, not 1 --
    the measurement runs, no message goes out, the log names the gate."""
    tree = tempfile.mkdtemp(dir=os.path.dirname(m))
    os.makedirs(os.path.join(tree, "scripts"))
    copy = os.path.join(tree, "scripts", "uptime-monitor.py")
    shutil.copy(s, copy)
    srv.set([OK], [WOK], [REF])
    code, msgs, out = run(copy, m, config(srv, m))
    incomplete = [n for n in log(m) if n.get("event") == "send-path-incomplete" and "gate" in n.get("missing", "")]
    return code == 4 and msgs == [] and incomplete and "verdict:" in out, "code %s, %s, %s" % (code, msgs, out[-250:])


def t17(s, srv, m):
    """The target gives an HTTP answer, but with an unreadable body (marked gzip, not gzip); everything else is dead:
    the round is measurable, and the target is alerted as 'unreadable' (an error after the status line is an answer)."""
    def bad_widget(k):
        k["targets"][1]["url"] = "http://127.0.0.1:%d/badgzip" % srv.port
    srv.set([OK], [WOK], [REF])
    code, msgs, _ = run(s, m, config(srv, m, dead=("site", "ref"), extra=bad_widget))
    wid = [u for u in msgs if u.startswith("Uptime alert: widget ") and "unreadable" in u]
    return code == 3 and len(wid) == 1, "code %s, %s" % (code, msgs)


def t9d(s, srv, m):
    """The post-streak "measuring again" notice fails to send; the next (fine) run sends it, and only once."""
    k = config(srv, m, blind=2, dead=("site", "widget", "ref"))
    run(s, m, k)
    run(s, m, k)
    srv.set([OK], [WOK], [REF])
    k2 = config(srv, m, blind=2)
    code1, msgs1, _ = run(s, m, k2, sender="fail")
    code2, msgs2, _ = run(s, m, k2)
    code3, msgs3, _ = run(s, m, k2)
    over = [u for u in msgs2 if "measuring again now" in u]
    return code1 == 4 and code2 == 0 and len(over) == 1 and msgs3 == msgs2 and "_blind" not in state(m), \
        "codes %s/%s/%s, %s" % (code1, code2, code3, msgs2)


def t13b(s, srv, m):
    code, msgs, out = run(s, m, config(srv, m, site_name="_blind"))
    return code == 1 and "'_'" in out, "code %s, %s" % (code, out[-200:])


def t14(s, srv, m):
    srv.set([OK], [WOK], [REF])
    with open(os.path.join(m, "state.json"), "w") as fh:
        fh.write("{not json")
    code, msgs, out = run(s, m, config(srv, m))
    corrupt = any(n.get("event") == "corrupt-state" for n in log(m))
    return (code == 0 and msgs == [] and corrupt and os.path.exists(os.path.join(m, "state.json.corrupt"))), \
        "code %s, %s, corrupt %s, %s" % (code, msgs, corrupt, out[-200:])


def t14b(s, srv, m):
    srv.set([OK], [WOK], [REF])
    with open(os.path.join(m, "state.json"), "w") as fh:
        json.dump({"site": "not an object"}, fh)
    code, msgs, out = run(s, m, config(srv, m))
    return code == 0 and msgs == [] and os.path.exists(os.path.join(m, "state.json.corrupt")), \
        "code %s, %s, %s" % (code, msgs, out[-200:])


def t15(s, srv, m):
    srv.set([OK], [WOK], [REF])
    code, msgs, out = run(s, m, config(srv, m), sender="telegram")
    incomplete = any(n.get("event") == "send-path-incomplete" for n in log(m))
    return code == 4 and msgs == [] and incomplete, "code %s, incomplete %s, %s" % (code, incomplete, out[-200:])


def install_tree(s, m, install_env, access, token_line='TELEGRAM_BOT_TOKEN="123:main-token"\n'):
    """A throwaway install: <m>/inst with the script under test, the real scripts/lib (owner_chat.py, send-telegram.sh)
    and scripts/hooks (the copy gate), the install .env, and the main channel dir .claude/channels/telegram with the bot
    token and access.json. Returns the script path inside it."""
    repo_scripts = os.path.dirname(HERE)
    root = os.path.join(m, "inst")
    ignore = shutil.ignore_patterns("__pycache__", "__tests__")
    os.makedirs(os.path.join(root, "scripts"))
    shutil.copytree(os.path.join(repo_scripts, "lib"), os.path.join(root, "scripts", "lib"), ignore=ignore)
    shutil.copytree(os.path.join(repo_scripts, "hooks"), os.path.join(root, "scripts", "hooks"), ignore=ignore)
    script = os.path.join(root, "scripts", "uptime-monitor.py")
    shutil.copy(s, script)
    with open(os.path.join(root, ".env"), "w") as fh:
        fh.write(install_env)
    ch = os.path.join(root, ".claude", "channels", "telegram")
    os.makedirs(ch)
    with open(os.path.join(ch, ".env"), "w") as fh:
        fh.write(token_line)
    with open(os.path.join(ch, "access.json"), "w") as fh:
        json.dump(access, fh)
    return script


def decoy_state_dir(m):
    """An inherited TELEGRAM_STATE_DIR (a sub-agent's channel): another token and another paired chat."""
    d = os.path.join(m, "decoy")
    os.makedirs(d)
    with open(os.path.join(d, ".env"), "w") as fh:
        fh.write("TELEGRAM_BOT_TOKEN=999:decoy-token\nALLOWED_CHAT_ID=999\n")
    with open(os.path.join(d, "access.json"), "w") as fh:
        json.dump({"allowFrom": ["999"]}, fh)
    return d


def send_path(s, srv, m, install_env, access, env_extra=None):
    """One run on the real Telegram path with the site down; returns (code, the stub's sendMessage calls, output)."""
    script = install_tree(s, m, install_env, access)
    srv.set([DOWN], [WOK], [REF])
    srv.posts = []
    env = {"TELEGRAM_API_BASE": "http://127.0.0.1:%d" % srv.port, "TELEGRAM_STATE_DIR": decoy_state_dir(m)}
    env.update(env_extra or {})
    code, _, out = run(script, m, config(srv, m), sender="telegram", env_extra=env, env_drop=("TELEGRAM_ENV",))
    calls = [(p, {k: v[0] for k, v in f.items()}) for p, f in srv.posts]
    return code, calls, out


def sent_to(calls, chat):
    return (len(calls) == 1 and calls[0][0] == "/bot123:main-token/sendMessage" and calls[0][1].get("chat_id") == chat
            and calls[0][1].get("text", "").startswith("Uptime alert: site "))


def preflight_missing(m):
    return " | ".join(n.get("missing", "") for n in log(m) if n.get("event") == "send-path-incomplete")


def t22(s, srv, m):
    code, calls, out = send_path(s, srv, m, "ALLOWED_CHAT_ID=111\n", {"allowFrom": ["222"]})
    return code == 3 and sent_to(calls, "111"), "code %s, calls %s, %s" % (code, calls, out[-300:])


def t22b(s, srv, m):
    code, calls, out = send_path(s, srv, m, "ALLOWED_CHAT_ID=0\n",
                                 {"allowFrom": ["222", "-100777"], "groups": {"-100888": {}}})
    return code == 3 and sent_to(calls, "222"), "code %s, calls %s, %s" % (code, calls, out[-300:])


def t22c(s, srv, m):
    code, calls, out = send_path(s, srv, m, "ALLOWED_CHAT_ID=\n", {"allowFrom": ["222", "333"]})
    miss = preflight_missing(m)
    return code == 4 and calls == [] and "chat_id" in miss and "refusing to guess" in miss, \
        "code %s, calls %s, missing %r, %s" % (code, calls, miss, out[-200:])


def t22d(s, srv, m):
    code, calls, out = send_path(s, srv, m, "", {"allowFrom": ["-100777"]})
    miss = preflight_missing(m)
    return code == 4 and calls == [] and "chat_id" in miss and "no DM entry" in miss, \
        "code %s, calls %s, missing %r, %s" % (code, calls, miss, out[-200:])


def t22e(s, srv, m):
    code, calls, out = send_path(s, srv, m, "ALLOWED_CHAT_ID=111\n", {"allowFrom": ["222"]},
                                 env_extra={"MARVEEN_ALERT_CHAT_ID": "555"})
    return code == 3 and sent_to(calls, "555"), "code %s, calls %s, %s" % (code, calls, out[-300:])


CASES = {"T1": t1, "T2": t2, "T3": t3, "T4": t4, "T5": t5, "T6": t6, "T7": t7, "T8": t8, "T9": t9, "T9b": t9b,
         "T9c": t9c, "T10": t10, "T11": t11, "T12": t12, "T13": t13, "T13b": t13b, "T13c": t13c, "T14": t14,
         "T15": t15, "T16": t16, "T7b": t7b, "T7c": t7c, "T11b": t11b, "T14b": t14b, "T16b": t16b, "T7d": t7d,
         "T13d": t13d, "T15b": t15b, "T17": t17, "T9d": t9d, "T18": t18, "T9e": t9e, "T14c": t14c, "T14d": t14d,
         "T15c": t15c, "T19": t19, "T20": t20, "T9f": t9f, "T21": t21, "T22": t22, "T22b": t22b, "T22c": t22c,
         "T22d": t22d, "T22e": t22e}

MUTANTS = [
    ("M-confirm", "                final[c[\"name\"]] = e2\n", "                pass\n", "T3"),
    ("M-dedup", "            if not a.get(\"alerted\"):\n", "            if True:\n", "T4"),
    ("M-content", "    if target.get(\"title_contains\"):\n",
     "    return None\n    if target.get(\"title_contains\"):\n", "T2"),
    ("M-stamp", "                a[\"alerted\"] = ok\n", "                a[\"alerted\"] = True\n", "T6"),
    ("M-reference", "        if ref == \"no-answer\" and not answered:\n", "        if False:\n", "T7"),
    ("M-answer", "        if ref == \"no-answer\" and not answered:\n", "        if ref == \"no-answer\":\n", "T7c"),
    ("M-gzip", "        b = d.decompress(b, MAX_BYTES + 1)\n", "        pass\n", "T1"),
    ("M-decompressed-cap", "        if len(b) > MAX_BYTES or d.unconsumed_tail:\n", "        if False:\n", "T16"),
    ("M-transfer-cap", "    if len(b) > MAX_BYTES:\n        raise TooLarge(\"transferred\")\n", "", "T16b"),
    ("M-second-round", "            answered = answered or a2\n",
     "            answered = answered or a2 or not first[c[\"name\"]]\n", "T7d"),
    ("M-gate", "        ok, reason = gate_check(candidate)\n", "        ok, reason = True, ''\n", "T10"),
    ("M-blind-over", "        ok = send(*blind_over_text(TEXTS[\"minutes\"] % pending.get(\"minutes\", 1)))\n",
     "        ok = True\n", "T9"),
    ("M-blind-sum", "        prev = state.get(\"_blind_pending\", {}).get(\"minutes\", 0)\n", "        prev = 0\n", "T9e"),
    ("M-state-type", "                    raise ValueError(\"field %r is not a finite number\" % key)\n",
     "                    pass\n", "T14c"),
    ("M-blind-pending",
     "        state[\"_blind_pending\"] = {\"minutes\": prev + max(1, round((now - blind.get(\"since\", now)) / 60))}\n",
     "        pass\n", "T9d"),
    ("M-first-strike", "            if first[c[\"name\"]]:\n                final[c[\"name\"]] = e2\n",
     "            final[c[\"name\"]] = e2\n", "T20"),
    ("M-blind-code", "            return 4 if send_failed else 2\n", "            return 2\n", "T9f"),
    ("M-budget", "    if budget > UNIT_BUDGET:\n", "    if False:\n", "T19"),
    ("M-budget-timeout", "    return (2 * n + 1) * TIMEOUT + wait", "    return (2 * n + 1) * 20 + wait", "T19"),
    ("M-budget-n", "    return (2 * n + 1) * TIMEOUT + wait", "    return 5 * TIMEOUT + wait", "T19"),
    ("M-recovery-code",
     "                    if not ok:\n                        send_failed = True\n                        state[name] = a",
     "                    if not ok:\n                        state[name] = a", "T21"),
    ("M-recovery-retry",
     "                        state[name] = a   # the notice is sent again in the next run\n"
     "                        continue\n", "", "T21"),
    ("M-wait-env", "    wait = float(k.get(\"wait_seconds\", 90))",
     "    wait = float(os.environ.get(\"UPTIME_WAIT\", k.get(\"wait_seconds\", 90)))", "T19"),
    ("M-next-data", "            elif not (nd.get(\"equals\") or nd.get(\"non_empty\") or nd.get(\"false\")):\n",
     "            elif False:\n", "T13d"),
    ("M-gate-error", "    ge = gate_error()\n", "    ge = None\n", "T15b"),
    ("M-answered", "        return TEXTS[\"err_unreadable\"] % e, True\n",
     "        return TEXTS[\"err_unreadable\"] % e, False\n", "T17"),
    ("M-blind-now", "            if v[\"runs\"] >= threshold and not v.get(\"notified\"):\n", "            if False:\n",
     "T9"),
    ("M-send-code", "    return 4 if send_failed else code\n", "    return code\n", "T6"),
    ("M-preflight", "    missing = preflight_error()\n", "    missing = None\n", "T15"),
]


def check(name, ok, detail=""):
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok or not detail else " (%s)" % detail[:300]))
    if not ok:
        FAILS.append(name)


def gate_probe():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("uptime_monitor_test", SCRIPT)
    u = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(u)
    errors = ["HTTP 503", "no answer (URLError)", "no answer (URLError, SSLCertVerificationError)",
              "the page title is not the expected one", "required content signal #2 is missing", "no __NEXT_DATA__",
              "the __NEXT_DATA__ is not parseable", "the __NEXT_DATA__ field query.slug is not the expected value",
              "the __NEXT_DATA__ field buildId is empty", "the __NEXT_DATA__ field isFallback is true",
              "the answer is too large", "the answer is unreadable (error)",
              "the answer is unreadable (IncompleteRead)"]
    bad = []
    for name, url in (("site", "https://example.com/"), ("widget", "https://booking.example.com/slug/embed"),
                      ("website", "https://example.com/"), ("caf\u00e9-booking", "https://booking.example.com/slug/embed")):
        texts = (list(u.recovery_text(name, url, "12 min")) + list(u.blind_over_text("35 min"))
                 + list(u.blind_now_text("30 min")) + [u.TEXTS["gate_probe"]])
        for e in errors:
            texts += list(u.alert_text(name, url, e, 90))
        bad += [(t, r) for t in texts for ok, r in [u.gate_check(t)] if not ok]
    check("G1 every alert/recovery/blind text passes the outgoing-copy gate", not bad, repr(bad[:2]))
    dashed = u.alert_text("site", "https://example.com/", "the page title is not the expected one", 90)[0].replace(
        ". Two measurements", " \u2014 Two measurements")
    ok, r = u.gate_check(dashed)
    check("G1k the same with an em dash: the gate refuses it (the gate is really applied)",
          not ok and "U+2014" in r, "%s | %s" % (dashed, r[:200]))


def main():
    srv = Server()
    root = tempfile.mkdtemp(prefix="uptime-monitor-test-")
    try:
        gate_probe()
        for name, f in CASES.items():
            ok, detail = f(SCRIPT, srv, tempfile.mkdtemp(dir=root))
            check(name, ok, detail)
        src = open(SCRIPT, encoding="utf-8").read()
        for name, old, new, case in MUTANTS:
            if src.count(old) != 1:
                check("%s measurable (the part to replace occurs exactly once)" % name, False, repr(old))
                continue
            mut = os.path.join(os.path.dirname(SCRIPT), ".uptime-mutant-%s-%d.py" % (name, os.getpid()))
            try:
                with open(mut, "w", encoding="utf-8") as fh:
                    fh.write(src.replace(old, new))
                ok, detail = CASES[case](mut, srv, tempfile.mkdtemp(dir=root))
            finally:
                os.remove(mut)
            if ok:
                check("%s: %s is as expected on the mutant too -- the case is blind" % (name, case), False, detail)
            else:
                print("%s-KILLED: %s differs on the mutant (%s)" % (name, case, detail[:140].replace("\n", " ")))
    finally:
        srv.httpd.shutdown()
        shutil.rmtree(root, ignore_errors=True)
        if os.path.exists(root):
            check("the temporary directory can be removed", False, root)
    print("VERDICT: %s" % ("every case and control as expected" if not FAILS else "%d mismatches: %s" % (len(FAILS),
                                                                                                         FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
