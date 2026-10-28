#!/usr/bin/env python3
"""Behaviour tests for scripts/graph-read.py (the read-only Graph helper).

Run: python3 scripts/__tests__/graph-read.test.py

No network: every request goes to a FAKE opener that records it. The token
file and the shared pause file are temp files; the real store/.meta-token and
the install's pause file are never touched. Sleeping and the clock are faked.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HELPER = os.path.join(ROOT, "scripts", "graph-read.py")

USER_TOK = "EAAusertokenSECRET123"
PAGE_TOK = "EAApagetokenSECRET456"


def load():
    s = importlib.util.spec_from_file_location("graph_read", HELPER)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


class FakeResp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    """Records every request; answers me/accounts with a page token."""

    def __init__(self, fail_http=None):
        self.calls = []
        self.fail_http = fail_http

    def __call__(self, req, timeout=None):
        self.calls.append({"url": req.full_url, "method": req.get_method(),
                           "data": req.data, "timeout": timeout})
        if self.fail_http:
            raise urllib.error.HTTPError(req.full_url, self.fail_http, "x", {},
                                         io.BytesIO(("bad token %s" % USER_TOK).encode()))
        path = urllib.parse.urlsplit(req.full_url).path
        if path.endswith("/me/accounts"):
            return FakeResp({"data": [{"id": "111", "access_token": PAGE_TOK}]})
        return FakeResp({"data": [{"id": "1_2", "message": "szia"}],
                         "echo_token": "x", "access_token": "leaked?"})


class SeqOpener:
    """Answers from a script: ("limit", code, headers) -> HTTP 400 Graph error with
    that code and headers; ("ok", headers) -> a success with those headers."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, req, timeout=None):
        self.calls.append({"url": req.full_url, "method": req.get_method(), "data": req.data})
        step = self.script.pop(0) if self.script else ("ok", {})
        if step[0] == "limit":
            body = json.dumps({"error": {"message": "User request limit reached %s" % USER_TOK,
                                         "code": step[1], "error_subcode": 2446079}})
            raise urllib.error.HTTPError(req.full_url, 400, "x", step[2], io.BytesIO(body.encode()))
        r = FakeResp({"data": [{"id": "111", "access_token": PAGE_TOK}]})
        r.headers = step[1]
        return r


def run(m, argv, opener):
    out, err = io.StringIO(), io.StringIO()
    code = m.main(argv, opener=opener, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def main():
    fails = []

    def check(name, got, want):
        ok = got == want
        print(("  OK   " if ok else "  FAIL ") + name + " (kapott=%r, vart=%r)" % (got, want))
        if not ok:
            fails.append(name)

    m = load()
    # 0. the pause file comes from config: env, then the install .env, then the default
    with tempfile.TemporaryDirectory() as root:
        check("szunet-fajl alapertelmezes: store/meta-graph-pause.json",
              m.pause_path(root, {}), os.path.join(root, "store", "meta-graph-pause.json"))
        with open(os.path.join(root, ".env"), "w") as fh:
            fh.write("OTHER=1\nMETA_GRAPH_PAUSE_FILE=\"shared/pause.json\"\n")
        check("szunet-fajl a .env-bol, relativ ut a gyokerhez kepest",
              m.pause_path(root, {}), os.path.join(root, "shared", "pause.json"))
        check("szunet-fajl: a kornyezeti valtozo elsobbseget elvez",
              m.pause_path(root, {"META_GRAPH_PAUSE_FILE": "/abs/p.json"}), "/abs/p.json")
        check("szunet-fajl: ures kornyezeti ertek nem ir felul (.env marad)",
              m.pause_path(root, {"META_GRAPH_PAUSE_FILE": "  "}),
              os.path.join(root, "shared", "pause.json"))
        with open(os.path.join(root, ".env"), "wb") as fh:
            fh.write(b"\xff\xfe nem utf-8")
        check("szunet-fajl: olvashatatlan .env -> alapertelmezes",
              m.pause_path(root, {}), os.path.join(root, "store", "meta-graph-pause.json"))
    if os.environ.get("META_GRAPH_PAUSE_FILE", "").strip():
        print("  SKIP szunet-fajl a modulban (META_GRAPH_PAUSE_FILE be van allitva)")
    else:
        check("szunet-fajl a modulban, env nelkul: a telepites gyokere alatt",
              m.PAUSE_PATH.startswith(ROOT + os.sep), True)
    with tempfile.TemporaryDirectory() as td:
        tokf = os.path.join(td, ".meta-token")
        with open(tokf, "w") as fh:
            fh.write(USER_TOK + "\n")
        m.TOKEN_PATH = tokf
        pause = os.path.join(td, "meta-szunet.json")
        m.PAUSE_PATH = pause   # never the real store file

        # 1. a plain read: exactly one GET, no body, fixed host, token only in the query
        op = FakeOpener()
        code, out, err = run(m, ["123/feed", "fields=id,message", "limit=5"], op)
        check("olvasas: exit 0", code, 0)
        check("olvasas: egy hivas", len(op.calls), 1)
        c = op.calls[0] if op.calls else {}
        check("olvasas: GET", c.get("method"), "GET")
        check("olvasas: nincs torzs", c.get("data"), None)
        u = urllib.parse.urlsplit(c.get("url", ""))
        check("olvasas: host", u.netloc, "graph.facebook.com")
        check("olvasas: ut v21.0-val", u.path, "/v21.0/123/feed")
        q = urllib.parse.parse_qs(u.query)
        check("olvasas: fields atment", q.get("fields"), ["id,message"])
        check("olvasas: token a store-bol", q.get("access_token"), [USER_TOK])
        check("olvasas: kimenet JSON", json.loads(out)["data"][0]["message"], "szia")
        check("olvasas: token nincs a kimenetben", USER_TOK in out + err, False)
        check("olvasas: access_token kulcs maszkolva", json.loads(out)["access_token"], "<token>")

        # 2. --page: me/accounts then the read with the PAGE token; both GET, no body
        op = FakeOpener()
        code, out, err = run(m, ["111/videos", "fields=source", "--page", "111"], op)
        check("--page: exit 0", code, 0)
        check("--page: ket hivas", len(op.calls), 2)
        check("--page: minden GET, torzs nelkul",
              all(x["method"] == "GET" and x["data"] is None for x in op.calls), True)
        if len(op.calls) == 2:
            q2 = urllib.parse.parse_qs(urllib.parse.urlsplit(op.calls[1]["url"]).query)
            check("--page: oldal-token a masodik hivasban", q2.get("access_token"), [PAGE_TOK])
        check("--page: egyik token sincs a kimenetben",
              USER_TOK in out + err or PAGE_TOK in out + err, False)

        # 3. write-marker parameters: refused, exit 2, NOTHING sent
        for k in sorted(m.WRITE_PARAMS):
            op = FakeOpener()
            code, out, err = run(m, ["123_456", "%s=x" % k], op)
            check("iro parameter %s=: megtagadva, 0 hivas" % k,
                  (code, len(op.calls)), (2, 0))
        for label, argv in (
            ("method=post", ["123_456", "method=post"]),
            ("nagybetus kulcs Message=", ["123_456", "Message=x"]),
            ("kodolt kulcs m%65thod=", ["123_456", "m%65thod=post"]),
            ("kotojeles kulcs", ["123_456", "is-hidden=true"]),
        ):
            op = FakeOpener()
            code, _, _ = run(m, argv, op)
            check("tiltott kulcs (%s): megtagadva, 0 hivas" % label, (code, len(op.calls)), (2, 0))

        # 3b. v2-R1: query keys are an ALLOWLIST
        for k in sorted(m.READ_PARAMS):
            op = FakeOpener()
            code, _, _ = run(m, ["123", "%s=1" % k], op)
            check("olvasasi kulcs %s= engedelyezett" % k, (code, len(op.calls)), (0, 1))
        for k in ("foo", "ids", "q", "type", "debug", "locale"):
            op = FakeOpener()
            code, _, err = run(m, ["123", "%s=1" % k], op)
            check("ismeretlen kulcs %s=: megtagadva, 0 hivas" % k, (code, len(op.calls)), (2, 0))

        # 4. paths and hosts: only plain graph paths
        for label, path in (
            ("masik host", "https://evil.example/x"),
            ("graph host az utban", "graph.facebook.com/123/feed"),
            ("//host", "//evil.example/x"),
            ("query az utban", "123/feed?message=x"),
            ("..", "123/../me/feed"),
            ("szokoz", "123 feed"),
            ("ures", ""),
            ("rupload", "rupload.facebook.com/video-upload/v21.0/9"),
        ):
            op = FakeOpener()
            code, _, _ = run(m, [path, "fields=id"], op)
            check("ut/host (%s): megtagadva, 0 hivas" % label, (code, len(op.calls)), (2, 0))
        op = FakeOpener()
        code, _, _ = run(m, ["v19.0/123/feed", "fields=id"], op)
        check("sajat verzio-elotag megmarad",
              urllib.parse.urlsplit(op.calls[0]["url"]).path if op.calls else None,
              "/v19.0/123/feed")
        op = FakeOpener()
        code, _, _ = run(m, ["123", "fields=id", "--data", "x"], op)
        check("ismeretlen kapcsolo: megtagadva, 0 hivas", (code, len(op.calls)), (2, 0))
        op = FakeOpener()
        code, _, _ = run(m, ["123", "fields"], op)
        check("key=value nelkuli parameter: megtagadva", (code, len(op.calls)), (2, 0))

        # 5. a refused request never reads the token file
        os.chmod(tokf, 0)
        try:
            op = FakeOpener()
            code, _, err = run(m, ["123", "message=x"], op)
            check("megtagadas a token olvasasa elott (exit 2, nem 1)", code, 2)
        finally:
            os.chmod(tokf, 0o600)

        # 6. HTTP error: exit 1, token redacted from the error text
        op = FakeOpener(fail_http=400)
        code, out, err = run(m, ["123", "fields=id"], op)
        check("HTTP-hiba: exit 1", code, 1)
        check("HTTP-hiba: a token nincs a hibaszovegben", USER_TOK in err, False)

        # 7. missing token file: exit 1, nothing sent
        m.TOKEN_PATH = os.path.join(td, "nincs")
        op = FakeOpener()
        code, _, _ = run(m, ["123", "fields=id"], op)
        check("hianyzo token: exit 1, 0 hivas", (code, len(op.calls)), (1, 0))

        # 8. by construction: fetch() only ever builds a body-less GET
        m.TOKEN_PATH = tokf
        op = FakeOpener()
        m.fetch("https://graph.facebook.com/v21.0/me?fields=id", op, [])
        check("fetch: GET torzs nelkul", (op.calls[0]["method"], op.calls[0]["data"]), ("GET", None))

        # 9. Meta rate limits (code 17 / 80004 ...) are retried: header wait,
        # else 60*2^(n-1); shared blocked_until file.
        clock = [1_000_000.0]
        sleeps = []

        def fake_sleep(sec):
            sleeps.append(sec)
            clock[0] += sec
        m._NOW = lambda: clock[0]
        m._SLEEP = fake_sleep

        def fresh():
            del sleeps[:]
            for f in (pause, pause + ".lock"):
                if os.path.exists(f):
                    os.remove(f)

        def blocked_until():
            with open(pause) as f:
                return json.load(f)["blocked_until"]

        fresh()
        op = SeqOpener([("limit", 17, {}), ("ok", {})])
        code, out, err = run(m, ["123", "fields=id"], op)
        check("code 17 egyszer, aztan siker: exit 0", code, 0)
        check("code 17: ket hivas", len(op.calls), 2)
        check("code 17: fejlec nelkul 60 mp tartalek-varakozas", sleeps, [60])
        check("code 17: a kozos szunet-fajlba beirva (t0 + 60)",
              os.path.exists(pause) and blocked_until(), 1_000_000.0 + 60)
        check("code 17: halado sor a stderr-en", "hivasszam-korlat (code 17)" in err, True)
        check("code 17: a token nincs a kimenetben", USER_TOK in out + err, False)

        fresh()
        hdr = {"X-Business-Use-Case-Usage": json.dumps(
                   {"act_1": [{"type": "ads_management", "call_count": 100,
                               "estimated_time_to_regain_access": 2}]}),
               "X-Ad-Account-Usage": json.dumps({"acc_id_util_pct": 100, "reset_time_duration": 30})}
        op = SeqOpener([("limit", 80004, hdr), ("ok", {})])
        code, _, _ = run(m, ["123", "fields=id"], op)
        check("80004 fejleccel: a fejlec ideje (max(2 perc, 30 mp) + 5)", (code, sleeps), (0, [125]))

        fresh()
        os.environ["GRAPH_READ_MAX_WAIT_SEC"] = "100000"
        try:
            op = SeqOpener([("limit", 80004, {})] * 10)
            code, _, err = run(m, ["123", "fields=id"], op)
        finally:
            del os.environ["GRAPH_READ_MAX_WAIT_SEC"]
        check("tartos korlat: 6 hivas, exit 1", (len(op.calls), code), (6, 1))
        check("tartos korlat: 60, 120, 240, 480, 600 mp", sleeps, [60, 120, 240, 480, 600])
        check("tartos korlat: a hibaszovegben nincs token", USER_TOK in err, False)

        fresh()
        op = SeqOpener([("limit", 17, {})] * 10)
        code, _, err = run(m, ["123", "fields=id"], op)
        check("alap keret (300 mp): a 3. hiba utan nem alszik 240-et, exit 1",
              (len(op.calls), code, sleeps), (3, 1, [60, 120]))
        check("keret-tullepes: a hiba megnevezi a GRAPH_READ_MAX_WAIT_SEC-et",
              "GRAPH_READ_MAX_WAIT_SEC" in err, True)

        fresh()
        bad_calls = []

        def code100(req, timeout=None):
            bad_calls.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 400, "x", {}, io.BytesIO(
                json.dumps({"error": {"code": 100, "message": "Invalid parameter"}}).encode()))
        code, _, _ = run(m, ["123", "fields=id"], code100)
        check("nem-korlat hiba (code 100): egy hivas, nincs varakozas, exit 1",
              (len(bad_calls), sleeps, code), (1, [], 1))
        check("nem-korlat hiba: nincs szunet-fajl", os.path.exists(pause), False)

        fresh()
        with open(pause, "w") as f:
            json.dump({"blocked_until": clock[0] + 50}, f)
        op = SeqOpener([("ok", {})])
        code, _, _ = run(m, ["123", "fields=id"], op)
        check("kozos szunet (50 mp): elobb var, aztan egy hivas", (sleeps, len(op.calls), code), ([50], 1, 0))

        fresh()
        with open(pause, "w") as f:
            json.dump({"blocked_until": clock[0] + 1000}, f)
        op = SeqOpener([("ok", {})])
        code, _, _ = run(m, ["123", "fields=id"], op)
        check("kozos szunet a kereten tul: nem hiv, nem alszik, exit 1",
              (len(op.calls), sleeps, code), (0, [], 1))

        fresh()
        with open(pause, "w") as f:
            json.dump({"blocked_until": clock[0] + 99999}, f)
        op = SeqOpener([("ok", {})])
        code, _, _ = run(m, ["123", "fields=id"], op)
        check("elavult/elrontott szunet (> 1 ora): figyelmen kivul", (len(op.calls), sleeps, code), (1, [], 0))

        fresh()
        op = SeqOpener([("ok", {"X-App-Usage": json.dumps({"call_count": 96})})])
        code, _, err = run(m, ["123", "fields=id"], op)
        check("siker 96%-on: exit 0, nem alszik, de szunetet ir a kovetkezonek",
              (code, sleeps, os.path.exists(pause) and blocked_until()), (0, [], clock[0] + 60))

        fresh()
        if hasattr(m, "pause_write"):
            with open(pause, "w") as f:
                json.dump({"blocked_until": clock[0] + 500}, f)
            m.pause_write(clock[0] + 10, "teszt")
            check("szunet-fajl csak nohet", blocked_until(), clock[0] + 500)
        else:
            check("szunet-fajl csak nohet (pause_write letezik)", False, True)

        fresh()
        op = SeqOpener([("limit", 17, {}), ("ok", {}), ("ok", {})])
        code, _, _ = run(m, ["111/videos", "fields=source", "--page", "111"], op)
        check("--page: a me/accounts hivas is ujraprobal (3 hivas, exit 0)", (len(op.calls), code), (3, 0))

        # 10. the wait cap is per INVOCATION, not per request.
        # (a) --page, both requests rate-limited: me/accounts 60 + 120 then ok,
        # the read 60, then 120 would pass 300 in all: give up, exit 1. A per-call
        # cap sleeps 60, 120, 60, 120 = 360.
        fresh()
        op = SeqOpener([("limit", 17, {}), ("limit", 17, {}), ("ok", {})] + [("limit", 17, {})] * 10)
        code, _, err = run(m, ["111/videos", "fields=source", "--page", "111"], op)
        check("--page, ket korlatos keres: alvas osszesen (%s mp) <= 300, a keret a futasra szol"
              % sum(sleeps), sum(sleeps) <= 300, True)
        check("--page, ket korlatos keres: 60, 120, 60, aztan feladva exit 1, 5 hivas",
              (sleeps, code, len(op.calls)), ([60, 120, 60], 1, 5))
        check("--page, ket korlatos keres: a hiba megnevezi a GRAPH_READ_MAX_WAIT_SEC-et",
              "GRAPH_READ_MAX_WAIT_SEC" in err, True)

        # (b) generic: however many sequential fetch_retry calls one invocation
        # makes (a future code path), their sleeps together stay within the cap.
        # main() is run with fetch_retry wrapped to call the real one N times
        # with the SAME arguments main() gave it; every request is rate-limited.
        orig = m.fetch_retry
        for cap, n in (("300", 1), ("300", 2), ("300", 5), ("150", 7), ("1000", 9), ("0", 3)):
            fresh()

            def many(*a, **kw):
                last = None
                for _ in range(n):
                    try:
                        last = orig(*a, **kw)
                    except RuntimeError as exc:
                        last = exc
                if isinstance(last, RuntimeError):
                    raise last
                return last
            m.fetch_retry = many
            os.environ["GRAPH_READ_MAX_WAIT_SEC"] = cap
            try:
                op = SeqOpener([("limit", 17, {})] * 200)
                code, _, _ = run(m, ["123", "fields=id"], op)
            finally:
                m.fetch_retry = orig
                del os.environ["GRAPH_READ_MAX_WAIT_SEC"]
            check("%d egymas utani fetch_retry, keret %s: alvas osszesen <= keret, exit 1"
                  % (n, cap), (sum(sleeps) <= float(cap), code), (True, 1))

        # (c) the shared pause counts against the same invocation budget
        fresh()
        with open(pause, "w") as f:
            json.dump({"blocked_until": clock[0] + 250}, f)
        op = SeqOpener([("ok", {}), ("limit", 17, {}), ("ok", {})])
        code, _, _ = run(m, ["111/videos", "fields=source", "--page", "111"], op)
        check("kozos szunet 250 + a masodik keres 60-as varakozasa: nem fer a 300-ba, exit 1",
              (sleeps, code, len(op.calls)), ([250], 1, 2))

        # 11. the pause file's documented schema, both ways (another client of the
        # same token writes and reads exactly this).
        fresh()
        with open(pause, "w") as f:
            f.write(json.dumps({"blocked_until": clock[0] + 40, "ok": "code 17", "irta_pid": 4242}))
        op = SeqOpener([("ok", {})])
        code, _, _ = run(m, ["123", "fields=id"], op)
        check("a dokumentalt semaju szunet: graph-read kivarja (40 mp), aztan hiv",
              (sleeps, len(op.calls), code), ([40], 1, 0))
        fresh()
        m.pause_write(clock[0] + 70, "code 80004")
        with open(pause) as f:
            raw = json.loads(f.read())
        check("graph-read irasa: pontosan a dokumentalt sema",
              (sorted(raw), raw["blocked_until"], raw["ok"]),
              (["blocked_until", "irta_pid", "ok"], clock[0] + 70, "code 80004"))
        # a plain reader: float(json.loads(text).get("blocked_until", 0))
        with open(pause) as f:
            check("graph-read irasa: egy egyszeru olvaso szerint 70 mp tiltas",
                  float(json.loads(f.read()).get("blocked_until", 0)) - clock[0], 70.0)
        check("zarfajl: <fajl>.lock", os.path.exists(pause + ".lock"), True)

    # 12. review k1: every documented throttling code, and the cheap fixes
    with tempfile.TemporaryDirectory() as td:
        tokf = os.path.join(td, ".meta-token")
        with open(tokf, "w") as fh:
            fh.write(USER_TOK + "\n")
        m.TOKEN_PATH = tokf
        pause = os.path.join(td, "pause.json")
        m.PAUSE_PATH = pause
        clock = [2_000_000.0]
        sleeps = []

        def fake_sleep2(sec):
            sleeps.append(sec)
            clock[0] += sec
        m._NOW = lambda: clock[0]
        m._SLEEP = fake_sleep2

        def fresh2():
            del sleeps[:]
            for f in (pause, pause + ".lock"):
                if os.path.exists(f):
                    os.remove(f)

        # 12a. EVERY code of LIMIT_CODES, driven from the tuple itself (a code
        # added later is tested the day it is added): retried + pause written
        tested = []
        for code_ in m.LIMIT_CODES:
            tested.append(code_)
            fresh2()
            t0 = clock[0]
            op = SeqOpener([("limit", code_, {}), ("ok", {})])
            code, out, err = run(m, ["123", "fields=id"], op)
            with open(pause) if os.path.exists(pause) else io.StringIO("{}") as f:
                bu = json.load(f).get("blocked_until")
            check("korlat-kod %d: ujraprobalva (2 hivas, exit 0, 60 mp)" % code_,
                  (len(op.calls), code, sleeps), (2, 0, [60]))
            check("korlat-kod %d: kozos szunet beirva (t0 + 60)" % code_, bu, t0 + 60)
        # guard: the loop above walked the whole tuple, and the tuple still
        # carries every throttling code of Meta's rate-limiting page
        documented = (4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006,
                      80008, 80009, 80014)
        check("orszem: minden LIMIT_CODES-kod tesztelve", tested, list(m.LIMIT_CODES))
        check("orszem: a LIMIT_CODES nem ures, nincs benne ismetles",
              (len(m.LIMIT_CODES) > 0, len(set(m.LIMIT_CODES)) == len(m.LIMIT_CODES)), (True, True))
        check("orszem: a dokumentalt kodok mind a LIMIT_CODES-ban",
              sorted(set(documented) - set(m.LIMIT_CODES)), [])
        fresh2()
        bad_calls = []

        def code190(req, timeout=None):
            bad_calls.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 400, "x", {}, io.BytesIO(
                json.dumps({"error": {"code": 190, "message": "Invalid OAuth token"}}).encode()))
        code, _, _ = run(m, ["123", "fields=id"], code190)
        check("nem korlat-kod (190): nincs ujraproba, nincs szunet",
              (len(bad_calls), sleeps, code, os.path.exists(pause)), (1, [], 1, False))

        # 12b. the error body is redacted BEFORE it is cut: a token straddling
        # the old 800-character cut leaves no readable prefix
        def straddle(req, timeout=None):
            body = "x" * 790 + USER_TOK + "y" * 50
            raise urllib.error.HTTPError(req.full_url, 400, "x", {}, io.BytesIO(body.encode()))
        code, out, err = run(m, ["123", "fields=id"], straddle)
        check("hibatorzs: a vagas elotti redakcio, token-elotag sincs (exit 1)",
              (code, USER_TOK[:10] in err), (1, False))

        # 12c. the answer's final URL must be the Graph host; the default
        # opener refuses redirects
        class Moved(FakeResp):
            def geturl(self):
                return "https://evil.example/x"
        code, out, err = run(m, ["123", "fields=id"], lambda req, timeout=None: Moved({"a": 1}))
        check("vegso URL mas hoston: exit 1, kimenet nelkul",
              (code, out, "Graph hostrol" in err), (1, "", True))
        nored = getattr(m, "_NoRedirect", None)   # getattr: the old helper has none
        try:
            if nored is None:
                raise AssertionError("no _NoRedirect")
            nored().redirect_request(None, None, 302, "Found", {}, "https://evil.example/x")
            check("atiranyitas: megtagadva", False, True)
        except RuntimeError as exc:
            check("atiranyitas: megtagadva", "evil.example" in str(exc), True)
        except AssertionError:
            check("atiranyitas: megtagadva", False, True)
        seen = []

        class _FakeBuilt:
            def open(self, req, timeout=None):
                return FakeResp({"ok": 1})

        def fake_build(*handlers):
            seen.extend(handlers)
            return _FakeBuilt()
        real_build = m.urllib.request.build_opener
        m.urllib.request.build_opener = fake_build
        try:
            code, _, _ = run(m, ["123", "fields=id"], None)
        finally:
            m.urllib.request.build_opener = real_build
        check("alap opener: atiranyitas-tilto kezelovel", (code, nored is not None and nored in seen), (0, True))

        # 12d. fields= may not ask for a token or alias a field
        for v in ("id,access_token", "id,ACCESS_TOKEN", "accounts{access_token}",
                  "name.as(access_token)", "id,name.AS(x)"):
            op = FakeOpener()
            code, _, _ = run(m, ["me", "fields=" + v], op)
            check("fields=%s: megtagadva, 0 hivas" % v, (code, len(op.calls)), (2, 0))
        op = FakeOpener()
        code, _, _ = run(m, ["111/videos", "fields=source", "--page", "111"], op)
        check("--page sajat me/accounts tokenkerese tovabbra is megy", (code, len(op.calls)), (0, 2))

        # 12e. an unreadable error body and a non-object me/accounts answer:
        # a clean exit 1, no traceback
        class BadBody(io.RawIOBase):
            def read(self, *a):
                raise OSError("connection reset")

        def unreadable(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 500, "x", {}, BadBody())
        try:
            code, _, err = run(m, ["123", "fields=id"], unreadable)
            check("olvashatatlan hibatorzs: exit 1", (code, "HTTP 500" in err), (1, True))
        except Exception as exc:  # noqa: BLE001
            check("olvashatatlan hibatorzs: exit 1, nem kivetel", repr(exc), None)
        for answer in (["nem", "objektum"], {"data": "x"}, {"data": [1, 2]}):
            try:
                code, _, err = run(m, ["111", "fields=id", "--page", "111"],
                                   lambda req, timeout=None, a=answer: FakeResp(a))
                check("me/accounts %r: exit 1, nem kivetel" % (answer,), code, 1)
            except Exception as exc:  # noqa: BLE001
                check("me/accounts %r: exit 1, nem kivetel" % (answer,), repr(exc), None)

        # 12f. ASCII digits only in the version prefix and the page id
        for argv in (["v١٢.0/123", "fields=id"], ["123", "fields=id", "--page", "١٢٣"]):
            op = FakeOpener()
            code, _, _ = run(m, argv, op)
            check("nem ASCII szamjegy (%r): megtagadva, 0 hivas" % argv[-1], (code, len(op.calls)), (2, 0))

        # 12g. a pause file that cannot be written is said on stderr
        fresh2()
        m.PAUSE_PATH = os.path.join(td, "nincs-ilyen-mappa", "pause.json")
        op = SeqOpener([("limit", 4, {}), ("ok", {})])
        code, _, err = run(m, ["123", "fields=id"], op)
        check("irhatatlan szunet-fajl: a hivas megy, a stderr kimondja",
              (code, "nem irhato" in err), (0, True))
        m.PAUSE_PATH = pause

        # 12h. paging.next carries the token: it comes back masked
        nxt = {"data": [], "paging": {"cursors": {"after": "QVFI"},
               "next": "https://graph.facebook.com/v21.0/123/feed?access_token=%s&after=QVFI"
                       % urllib.parse.quote(USER_TOK)}}
        code, out, err = run(m, ["123/feed", "fields=id"], lambda req, timeout=None: FakeResp(nxt))
        check("paging.next: a token maszkolva, a kurzor megmarad",
              (code, USER_TOK in out, "<token>" in out, "QVFI" in out), (0, False, True, True))

        # 13. review k2: clean exit 1, never an exception
        def no_exc(label, fn, want=1):
            try:
                code_ = fn()
                check(label, code_, want)
            except Exception as exc:  # noqa: BLE001
                check(label + " (kivetel nelkul)", repr(exc), None)
        with open(tokf, "wb") as fh:
            fh.write(b"\xff\xfe nem utf-8")
        no_exc("nem UTF-8 tokenfajl: exit 1",
               lambda: run(m, ["123", "fields=id"], FakeOpener())[0])
        with open(tokf, "w") as fh:
            fh.write(USER_TOK + "\n")
        for bad_tok in (12345, ["x"], {"t": 1}):
            no_exc("me/accounts nem szoveges oldal-token (%r): exit 1" % (bad_tok,),
                   lambda b=bad_tok: run(m, ["111", "fields=id", "--page", "111"],
                                         lambda req, timeout=None: FakeResp(
                                             {"data": [{"id": "111", "access_token": b}]}))[0])
        no_exc("kodolhatatlan argumentum (maganyos surrogate): exit 1",
               lambda: run(m, ["123", "fields=id\udcff"], FakeOpener())[0])
        no_exc("kodolhatatlan utvonal-parameter-ertek (since=): exit 1",
               lambda: run(m, ["123", "since=\ud800"], FakeOpener())[0])

    print()
    if fails:
        print("BUKOTT: %d" % len(fails))
        for f in fails:
            print("  - " + f)
        sys.exit(1)
    print("MINDEN TESZT ATMENT")


if __name__ == "__main__":
    main()
