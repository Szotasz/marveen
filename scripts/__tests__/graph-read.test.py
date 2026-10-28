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
    check("szunet-fajl a modulban: a telepites gyokere alatt",
          m.PAUSE_PATH.startswith(ROOT + os.sep) or os.path.isabs(m.PAUSE_PATH), True)
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

    print()
    if fails:
        print("BUKOTT: %d" % len(fails))
        for f in fails:
            print("  - " + f)
        sys.exit(1)
    print("MINDEN TESZT ATMENT")


if __name__ == "__main__":
    main()
