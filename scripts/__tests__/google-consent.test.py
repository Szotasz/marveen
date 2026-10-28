#!/usr/bin/env python3
"""Tests for scripts/google-consent.py.

Hermetic: HOME, the config, the OAuth client file and every token file live in a
temp dir. There is no real OAuth flow: the token exchange goes to a local fake
token endpoint (GOOGLE_CONSENT_TOKEN_URL on 127.0.0.1), and urllib.request.urlopen
is wrapped so that any other URL fails the test. The client id, secret and tokens
are made-up sentinels; every CLI run asserts that none of them reaches stdout or
stderr.

Run: python3 scripts/__tests__/google-consent.test.py
"""
import contextlib
import http.server
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
SCRIPT = os.path.join(SCRIPTS, "google-consent.py")
EXAMPLE = os.path.join(SCRIPTS, "google-consent.example.json")

G = "https://www.googleapis.com/auth/"
GMAIL = [G + "gmail.modify", G + "gmail.settings.basic"]
CAL = [G + "calendar"]
DRIVE = [G + "calendar", G + "documents", G + "drive.file", G + "drive"]
TAGS = [G + "tagmanager.readonly", G + "tagmanager.edit.containers"]
REPORTS = [G + "webmasters.readonly", G + "analytics.readonly"]
ALL = list(dict.fromkeys(GMAIL + CAL + DRIVE + TAGS + REPORTS))
# Separate consent only: Google refuses these together with drive.file in one request.
YT = [G + "youtube.upload", G + "youtube.force-ssl"]

CLIENT_ID = "cid-test-0000.apps.googleusercontent.com"
OLD_RT = "OLD-REFRESH-sentinel-1111"
OLD_AT = "OLD-ACCESS-sentinel-2222"
NEW_RT = "NEW-REFRESH-sentinel-3333"
NEW_AT = "NEW-ACCESS-sentinel-4444"
SECRET = "CLIENT-SECRET-sentinel-5555"
YT_RT = "YT-REFRESH-sentinel-6666"
YT_AT = "YT-ACCESS-sentinel-7777"
SENTINELS = [OLD_RT, OLD_AT, NEW_RT, NEW_AT, SECRET, YT_RT, YT_AT]

REAL_URLOPEN = urllib.request.urlopen


def load_module():
    spec = importlib.util.spec_from_file_location("google_consent", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write(path, obj, pretty=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(json.dumps(obj, indent=2) if pretty else json.dumps(obj))
    os.chmod(path, 0o600)


def jload(path):
    with open(path) as f:
        return json.load(f)


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class FakeTokenEndpoint:
    """A local stand-in for oauth2.googleapis.com/token: records each POST form and
    answers with the queued (status, body) or the default response."""

    def __init__(self):
        self.requests = []
        self.reply = (200, {})
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                form = urllib.parse.parse_qs(self.rfile.read(n).decode())
                outer.requests.append({k: v[0] for k, v in form.items()})
                status, body = outer.reply
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d/token" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="google-consent-test-")
        self.home = os.path.join(self.tmp, "home")
        self.root = os.path.join(self.tmp, "install")
        self.state = os.path.join(self.root, "store")
        os.makedirs(self.state)
        os.makedirs(self.home)
        self.fake = FakeTokenEndpoint()
        self.env = mock.patch.dict(os.environ, {
            "HOME": self.home, "GOOGLE_CONSENT_TOKEN_URL": self.fake.url,
            "GOOGLE_CONSENT_CONFIG": os.path.join(self.root, "consent.json"),
            "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"})
        self.env.start()
        for k in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
            os.environ.pop(k, None)

        # Hard guard: only the local fake endpoint may be reached.
        def guarded(req, *a, **kw):
            url = req.full_url if hasattr(req, "full_url") else req
            if not url.startswith(self.fake.url):
                raise AssertionError("network call attempted: %s" % url)
            return REAL_URLOPEN(req, *a, **kw)
        self.net = mock.patch("urllib.request.urlopen", side_effect=guarded)
        self.net.start()

        self.m = load_module()
        self.client_path = os.path.join(self.home, ".config/google-consent/oauth-client.json")
        write(self.client_path, {"installed": {
            "client_id": CLIENT_ID, "client_secret": SECRET,
            "redirect_uris": ["http://localhost"]}})
        h = lambda p: os.path.join(self.home, p)
        self.paths = {
            "gmail": h(".gmail-mcp/credentials.json"),
            "calendar": h(".config/google-calendar-mcp/tokens.json"),
            "drive": h(".config/google-drive-mcp/tokens.json"),
            "tags": h(".config/google-consent/tags-token.json"),
            "reports": h(".config/google-consent/reports-token.json"),
        }
        self.yt_path = h(".config/google-consent/youtube-token.json")
        self.config = {
            "client_file": "~/.config/google-consent/oauth-client.json",
            "state_dir": self.state,
            "mcp_scan_root": self.root,
            "consumers": {
                "gmail": {"label": "Gmail MCP", "format": "gmail-mcp",
                          "path": "~/.gmail-mcp/credentials.json",
                          "scopes": ["gmail.modify", "gmail.settings.basic"], "process": "gmail-mcp"},
                "calendar": {"label": "Calendar MCP", "format": "google-auth", "account": "normal",
                             "path": "~/.config/google-calendar-mcp/tokens.json", "scopes": ["calendar"]},
                "drive": {"label": "Drive MCP", "format": "drive-mcp-v2",
                          "path": "~/.config/google-drive-mcp/tokens.json",
                          "scopes": [s[len(G):] for s in DRIVE]},
                "tags": {"label": "Tag Manager", "format": "raw",
                         "path": "~/.config/google-consent/tags-token.json", "scopes": TAGS},
                "reports": {"label": "Reports read", "format": "raw",
                            "path": "~/.config/google-consent/reports-token.json",
                            "scopes": ["webmasters.readonly", "analytics.readonly"]},
                "youtube": {"label": "YouTube upload", "format": "raw",
                            "path": "~/.config/google-consent/youtube-token.json",
                            "scopes": ["youtube.upload", "youtube.force-ssl"], "separate": True},
            },
        }
        self.save_config()
        write(self.paths["gmail"], {"tokens": {
            "access_token": OLD_AT, "refresh_token": OLD_RT, "scope": " ".join(GMAIL),
            "token_type": "Bearer", "refresh_token_expires_in": 604799,
            "expiry_date": 1790341523112}, "scopes": ["gmail.modify", "gmail.settings.basic"]})
        write(self.paths["calendar"], {"normal": {
            "access_token": OLD_AT, "refresh_token": OLD_RT, "scope": " ".join(CAL),
            "token_type": "Bearer", "refresh_token_expires_in": 36754,
            "expiry_date": 1790317826135}, "other": {"refresh_token": "untouched"}})
        write(self.paths["drive"], {"version": 2, "accounts": {"default": {
            "alias": "default", "email": "unknown", "sub": "abcdefabcdefabcdefabcdef",
            "accessToken": OLD_AT, "refreshToken": OLD_RT, "scope": " ".join(DRIVE),
            "tokenType": "Bearer", "expiryDate": 1790327825632,
            "addedAt": "2026-01-02T03:04:05.000Z", "lastRefreshedAt": "2026-01-03T03:04:05.000Z",
            "pendingIdentity": True}}, "defaultAccount": "default"})
        write(self.paths["tags"], {"access_token": OLD_AT, "expires_in": 3599,
                                   "refresh_token": OLD_RT, "scope": " ".join(TAGS),
                                   "token_type": "Bearer", "refresh_token_expires_in": 92138,
                                   "obtained_at": 1790331400}, pretty=False)
        write(os.path.join(self.root, ".mcp.json"), {"mcpServers": {
            "gmail": {"env": {"GMAIL_OAUTH_PATH": self.client_path}},
            "google-calendar": {"env": {"GOOGLE_OAUTH_CREDENTIALS": self.client_path}}}})

    def tearDown(self):
        self.net.stop()
        self.env.stop()
        self.fake.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers
    def save_config(self):
        write(os.environ.get("GOOGLE_CONSENT_CONFIG") or os.path.join(self.root, "consent.json"),
              self.config)

    def run_cli(self, *argv):
        out, errb = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(errb), \
                mock.patch.object(self.m, "running_mcp_sessions", return_value={}):
            try:
                rc = self.m.main(list(argv))
            except SystemExit as e:
                rc = e.code
        o, e = out.getvalue(), errb.getvalue()
        for s in SENTINELS:
            self.assertNotIn(s, o, "secret leaked to stdout")
            self.assertNotIn(s, e, "secret leaked to stderr")
        return rc, o, e

    def respond(self, scopes=ALL, testing=False, at=NEW_AT, rt=NEW_RT, status=200, body=None):
        r = {"access_token": at, "refresh_token": rt, "expires_in": 3599,
             "scope": " ".join(scopes), "token_type": "Bearer"}
        if testing:
            r["refresh_token_expires_in"] = 604799
        self.fake.reply = (status, body if body is not None else r)

    def link(self, *extra):
        rc, out, err = self.run_cli("link", *extra)
        self.assertEqual(rc, 0, err)
        url = out.strip()
        return url, urllib.parse.parse_qs(urllib.parse.urlparse(url).query)

    def pasted(self, state, code="4/0AfakeCODE"):
        return "http://localhost/?state=%s&code=%s&scope=%s" % (
            state, urllib.parse.quote(code), urllib.parse.quote(" ".join(ALL)))

    def pkce(self, only=None):
        return os.path.join(self.state, ".google-consent%s-pkce.json" % ("-" + only if only else ""))

    def pending(self, only=None):
        return os.path.join(self.state, ".google-consent%s-pending.json" % ("-" + only if only else ""))

    def snapshot(self):
        snap = {}
        for p in list(self.paths.values()) + [self.pkce(), self.pending()]:
            if os.path.exists(p):
                with open(p, "rb") as f:
                    snap[p] = f.read()
        return snap

    def backups(self):
        out = []
        for d in {os.path.dirname(p) for p in list(self.paths.values()) + [self.yt_path]}:
            if os.path.isdir(d):
                out += [os.path.join(d, f) for f in os.listdir(d) if ".bak-" in f]
        return out


class ConfigTests(Base):
    def test_missing_config_is_a_config_error(self):
        os.unlink(os.environ["GOOGLE_CONSENT_CONFIG"])
        rc, _, err = self.run_cli("status")
        self.assertEqual(rc, 1)
        self.assertIn("CONFIG ERROR: no config", err)
        self.assertIn("google-consent.example.json", err)

    def test_config_flag_overrides_env(self):
        other = os.path.join(self.tmp, "other.json")
        cfg = json.loads(json.dumps(self.config))
        del cfg["consumers"]["tags"]
        write(other, cfg)
        rc, out, err = self.run_cli("--config", other, "link")
        self.assertEqual(rc, 0, err)
        scopes = urllib.parse.parse_qs(urllib.parse.urlparse(out.strip()).query)["scope"][0].split()
        self.assertFalse(set(scopes) & set(TAGS))

    def test_invalid_configs_are_refused(self):
        cases = {
            "unknown format": ("gmail", "format", "pickle"),
            "no path": ("gmail", "path", ""),
            "empty scopes": ("gmail", "scopes", []),
            "scope with space": ("gmail", "scopes", ["a b"]),
            "account on raw": ("tags", "account", "x"),
            "separate not raw": ("gmail", "separate", True),
            "separate not bool": ("youtube", "separate", "yes"),
        }
        for label, (name, key, value) in cases.items():
            with self.subTest(label):
                cfg = json.loads(json.dumps(self.config))
                cfg["consumers"][name][key] = value
                write(os.environ["GOOGLE_CONSENT_CONFIG"], cfg)
                rc, out, err = self.run_cli("link")
                self.assertEqual(rc, 1, label)
                self.assertIn("CONFIG ERROR", err)
                self.assertEqual(out, "")

    def test_duplicate_path_and_bad_name_are_refused(self):
        cfg = json.loads(json.dumps(self.config))
        cfg["consumers"]["reports"]["path"] = cfg["consumers"]["tags"]["path"]
        write(os.environ["GOOGLE_CONSENT_CONFIG"], cfg)
        rc, _, err = self.run_cli("status")
        self.assertEqual(rc, 1)
        self.assertIn("share one path", err)
        cfg = json.loads(json.dumps(self.config))
        cfg["consumers"]["Bad Name"] = cfg["consumers"].pop("reports")
        write(os.environ["GOOGLE_CONSENT_CONFIG"], cfg)
        rc, _, err = self.run_cli("status")
        self.assertEqual(rc, 1)

    def test_separate_consumer_sharing_a_union_scope_is_refused(self):
        self.config["consumers"]["youtube"]["scopes"].append("drive.file")
        self.save_config()
        rc, out, err = self.run_cli("link", "--only", "youtube")
        self.assertEqual(rc, 1)
        self.assertIn("shares scopes with the union", err)
        self.assertEqual(out, "")

    def test_only_must_name_a_separate_consumer(self):
        rc, _, err = self.run_cli("link", "--only", "gmail")
        self.assertEqual(rc, 2)
        self.assertIn("youtube", err)

    def test_unusable_client_file_is_a_config_error_without_contents(self):
        with open(self.client_path, "w") as f:
            f.write('{"installed": {"client_secret": "%s"}}' % SECRET)
        rc, out, err = self.run_cli("link")
        self.assertEqual(rc, 1)
        self.assertIn("OAuth client file not usable", err)

    def test_non_loopback_token_url_override_is_refused(self):
        _, q = self.link()
        before = self.snapshot()
        for bad in ("https://evil.example/token", "http://evil.example/token",
                    "http://127.0.0.1.evil.example/token"):
            with mock.patch.dict(os.environ, {"GOOGLE_CONSENT_TOKEN_URL": bad}):
                rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
            self.assertEqual(rc, 1, bad)
            self.assertIn("loopback", err)
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.snapshot(), before)

    def test_example_config_is_valid(self):
        cfg = self.m.load_config(EXAMPLE)
        self.assertIn("youtube", cfg["separate"])
        self.assertTrue(cfg["union"])
        for c in cfg["consumers"].values():
            self.assertTrue(c["path"].startswith(os.path.expanduser("~")) or os.path.isabs(c["path"]))


class LinkTests(Base):
    def test_link_url_union_scopes_and_pkce(self):
        url, q = self.link()
        self.assertTrue(url.startswith("https://accounts.google.com/o/oauth2/v2/auth?"))
        self.assertEqual(q["client_id"], [CLIENT_ID])
        self.assertEqual(q["access_type"], ["offline"])
        self.assertEqual(q["prompt"], ["consent"])
        self.assertEqual(q["include_granted_scopes"], ["true"])
        self.assertEqual(q["redirect_uri"], ["http://localhost"])
        self.assertEqual(q["response_type"], ["code"])
        self.assertEqual(q["code_challenge_method"], ["S256"])
        self.assertEqual(set(q["scope"][0].split()), set(ALL))
        self.assertEqual(mode(self.pkce()), 0o600)
        entries = jload(self.pkce())["entries"]
        self.assertEqual(entries[-1]["state"], q["state"][0])
        self.assertNotIn(entries[-1]["verifier"], url)
        self.assertEqual(self.fake.requests, [])  # link makes no network call

    def test_link_reads_extra_scope_from_token_file(self):
        d = jload(self.paths["drive"])
        d["accounts"]["default"]["scope"] += " " + G + "userinfo.email"
        write(self.paths["drive"], d)
        _, q = self.link()
        self.assertIn(G + "userinfo.email", q["scope"][0].split())

    def test_link_keeps_consumer_whose_file_is_missing(self):
        os.unlink(self.paths["calendar"])
        os.unlink(self.paths["tags"])
        _, q = self.link()
        self.assertEqual(set(q["scope"][0].split()), set(ALL))

    def test_only_the_last_five_links_are_kept(self):
        states = [self.link()[1]["state"][0] for _ in range(7)]
        kept = [e["state"] for e in jload(self.pkce())["entries"]]
        self.assertEqual(kept, states[-5:])


class RedeemTests(Base):
    def test_exchange_sends_code_verifier_and_client_to_the_token_endpoint(self):
        _, q = self.link()
        verifier = jload(self.pkce())["entries"][-1]["verifier"]
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0], code="4/0AcodeXYZ"))
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(self.fake.requests), 1)
        form = self.fake.requests[0]
        self.assertEqual(form["code"], "4/0AcodeXYZ")
        self.assertEqual(form["code_verifier"], verifier)
        self.assertEqual(form["client_id"], CLIENT_ID)
        self.assertEqual(form["client_secret"], SECRET)
        self.assertEqual(form["grant_type"], "authorization_code")
        self.assertEqual(form["redirect_uri"], "http://localhost")

    def test_dry_run_writes_no_token_file_and_second_run_reuses_exchange(self):
        _, q = self.link()
        before = {p: b for p, b in self.snapshot().items() if p in self.paths.values()}
        self.respond()
        rc, out, err = self.run_cli("redeem", self.pasted(q["state"][0]), "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertEqual({p: b for p, b in self.snapshot().items() if p in self.paths.values()}, before)
        self.assertFalse(os.path.exists(self.paths["reports"]))
        self.assertEqual(self.backups(), [])
        self.assertIn("DRY RUN", out)
        for n in ("gmail", "calendar", "drive", "tags"):
            self.assertIn(self.paths[n], out)
        self.assertIn("NEW FILE " + self.paths["reports"], out)
        self.assertIn("-tokens.refresh_token_expires_in", out)
        self.assertEqual(mode(self.pending()), 0o600)

        # real run with the SAME url: no second exchange (the code is single use)
        rc, out, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(self.fake.requests), 1)
        self.assertFalse(os.path.exists(self.pending()))

    def test_real_run_keeps_each_format_writes_0600_and_backs_up(self):
        _, q = self.link()
        before = self.snapshot()
        self.respond()
        old_umask = os.umask(0)  # the 0600 must not depend on the caller's umask
        try:
            rc, out, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        finally:
            os.umask(old_umask)
        self.assertEqual(rc, 0, err)
        self.assertIn("no refresh_token_expires_in", out)

        g = jload(self.paths["gmail"])
        self.assertEqual(set(g), {"tokens", "scopes"})
        self.assertEqual(g["scopes"], ["gmail.modify", "gmail.settings.basic"])
        self.assertEqual(set(g["tokens"]),
                         {"access_token", "refresh_token", "scope", "token_type", "expiry_date"})
        self.assertEqual(g["tokens"]["refresh_token"], NEW_RT)
        self.assertGreater(g["tokens"]["expiry_date"], 10 ** 12)  # milliseconds

        c = jload(self.paths["calendar"])
        self.assertEqual(set(c), {"normal", "other"})
        self.assertEqual(c["other"], {"refresh_token": "untouched"})
        self.assertEqual(c["normal"]["refresh_token"], NEW_RT)
        self.assertNotIn("refresh_token_expires_in", c["normal"])

        d = jload(self.paths["drive"])
        self.assertEqual(d["version"], 2)
        self.assertEqual(d["defaultAccount"], "default")
        rec = d["accounts"]["default"]
        self.assertEqual(rec["refreshToken"], NEW_RT)
        self.assertEqual(rec["accessToken"], NEW_AT)
        self.assertEqual(rec["sub"], "abcdefabcdefabcdefabcdef")
        self.assertEqual(rec["addedAt"], "2026-01-02T03:04:05.000Z")
        self.assertTrue(rec["pendingIdentity"])

        with open(self.paths["tags"]) as f:
            tags_text = f.read()
        self.assertNotIn("\n", tags_text.strip())  # a compact file stays compact
        tags = json.loads(tags_text)
        self.assertEqual(set(tags), {"access_token", "expires_in", "refresh_token", "scope",
                                     "token_type", "obtained_at"})
        self.assertEqual(tags["refresh_token"], NEW_RT)

        rep = jload(self.paths["reports"])
        self.assertEqual(rep["refresh_token"], NEW_RT)
        self.assertTrue(set(REPORTS) <= set(rep["scope"].split()))

        for n, p in self.paths.items():
            self.assertEqual(mode(p), 0o600, n)
        baks = self.backups()
        self.assertEqual(len(baks), 4)
        for b in baks:
            self.assertEqual(mode(b), 0o600)
            src = next(p for p in self.paths.values() if b.startswith(p + ".bak-"))
            with open(b, "rb") as f:
                self.assertEqual(f.read(), before[src])
        # no temp file left behind, one-shot state cleaned up
        for p in self.paths.values():
            self.assertFalse([f for f in os.listdir(os.path.dirname(p)) if ".tmp." in f])
        self.assertEqual(jload(self.pkce())["entries"], [])
        self.assertFalse(os.path.exists(self.pending()))

        # the offline report sees one shared refresh token everywhere
        rc, out, _ = self.run_cli("status")
        self.assertEqual(rc, 0)
        self.assertNotIn("different refresh tokens", out)

    def test_new_token_dirs_are_created_0700(self):
        self.config["consumers"]["reports"]["path"] = "~/.new-dir/sub/reports-token.json"
        self.save_config()
        target = os.path.join(self.home, ".new-dir/sub/reports-token.json")
        _, q = self.link()
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        self.assertEqual(mode(os.path.dirname(target)), 0o700)
        self.assertEqual(mode(target), 0o600)

    def test_missing_scope_for_one_consumer_fails_loudly_and_writes_nothing(self):
        _, q = self.link()
        before = {p: b for p, b in self.snapshot().items() if p in self.paths.values()}
        self.respond(scopes=[s for s in ALL if s != G + "gmail.settings.basic"])
        rc, out, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 3)
        self.assertIn("SCOPE SHORTFALL: gmail", err)
        self.assertIn("NOTHING was written", err)
        self.assertIn("MISSING: " + G + "gmail.settings.basic", out)
        self.assertEqual({p: b for p, b in self.snapshot().items() if p in self.paths.values()}, before)
        self.assertFalse(os.path.exists(self.paths["reports"]))
        self.assertEqual(self.backups(), [])
        self.assertEqual(mode(self.pending()), 0o600)  # parked for --partial

    def test_partial_flag_writes_only_covered_consumers(self):
        _, q = self.link()
        before = self.snapshot()
        self.respond(scopes=[s for s in ALL if s not in REPORTS])
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]), "--partial")
        self.assertEqual(rc, 3)
        self.assertIn("SCOPE SHORTFALL: reports", err)
        self.assertFalse(os.path.exists(self.paths["reports"]))
        self.assertNotEqual(self.snapshot()[self.paths["gmail"]], before[self.paths["gmail"]])
        self.assertEqual(jload(self.paths["tags"])["refresh_token"], NEW_RT)

    def test_testing_mode_warns_and_keeps_expiry_field(self):
        _, q = self.link()
        self.respond(testing=True)
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 4)
        self.assertIn("refresh_token_expires_in", err)
        self.assertIn("Testing", err)
        self.assertEqual(jload(self.paths["calendar"])["normal"]["refresh_token_expires_in"], 604799)

    def test_unknown_state_is_rejected_without_exchange(self):
        self.link()
        before = self.snapshot()
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted("forged-state"))
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(self.snapshot(), before)

    def test_google_error_in_url_is_reported(self):
        self.link()
        rc, _, err = self.run_cli("redeem", "http://localhost/?error=access_denied&state=x")
        self.assertEqual(rc, 1)
        self.assertIn("access_denied", err)
        self.assertEqual(self.fake.requests, [])

    def test_invalid_grant_from_the_endpoint_writes_nothing(self):
        _, q = self.link()
        before = self.snapshot()
        self.respond(status=400, body={"error": "invalid_grant", "error_description": "Bad Request"})
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 1)
        self.assertIn("invalid_grant", err)
        self.assertIn("single use", err)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.backups(), [])

    def test_response_without_refresh_token_writes_nothing(self):
        _, q = self.link()
        before = {p: b for p, b in self.snapshot().items() if p in self.paths.values()}
        self.respond(body={"access_token": NEW_AT, "expires_in": 3599, "scope": " ".join(ALL)})
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 1)
        self.assertIn("no refresh_token", err)
        self.assertEqual({p: b for p, b in self.snapshot().items() if p in self.paths.values()}, before)

    def test_missing_calendar_file_is_recreated_in_its_format(self):
        os.unlink(self.paths["calendar"])
        _, q = self.link()
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        c = jload(self.paths["calendar"])
        self.assertEqual(set(c), {"normal"})
        self.assertEqual(c["normal"]["refresh_token"], NEW_RT)
        self.assertEqual(mode(self.paths["calendar"]), 0o600)

    def test_missing_gmail_file_gets_short_scopes_from_config(self):
        os.unlink(self.paths["gmail"])
        _, q = self.link()
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        self.assertEqual(jload(self.paths["gmail"])["scopes"], ["gmail.modify", "gmail.settings.basic"])

    def test_foreign_oauth_client_in_mcp_json_is_flagged(self):
        other = os.path.join(self.home, "other-client.json")
        write(other, {"installed": {"client_id": "someone-else", "client_secret": "x"}})
        write(os.path.join(self.root, ".mcp.json"), {"mcpServers": {
            "google-drive": {"env": {"GOOGLE_DRIVE_OAUTH_CREDENTIALS": other,
                                     "GOOGLE_DRIVE_MCP_TOKEN_PATH": "/elsewhere"}}}})
        _, q = self.link()
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]), "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertIn("different OAuth client", err)
        self.assertIn("GOOGLE_DRIVE_MCP_TOKEN_PATH is set", err)


class SeparateConsentTests(Base):
    """A separate consumer: never in the union link, never writes union files."""

    def yt_response(self, scopes=YT, testing=False):
        self.respond(scopes=scopes, testing=testing, at=YT_AT, rt=YT_RT)

    def test_union_link_has_no_separate_scope(self):
        _, q = self.link()
        scopes = q["scope"][0].split()
        self.assertEqual(set(scopes), set(ALL))
        self.assertFalse(set(scopes) & set(YT))
        self.assertFalse(os.path.exists(self.pkce("youtube")))

    def test_union_link_drops_separate_scope_leaked_into_union_files(self):
        # include_granted_scopes=true lets Google hand back every scope ever granted to
        # the client, so a union file can end up carrying the separate scopes.
        t = jload(self.paths["tags"])
        t["scope"] += " " + " ".join(YT)
        write(self.paths["tags"], t, pretty=False)
        _, q = self.link()
        self.assertFalse(set(q["scope"][0].split()) & set(YT))

    def test_union_redeem_never_creates_the_separate_file(self):
        _, q = self.link()
        self.respond()
        rc, _, err = self.run_cli("redeem", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.exists(self.yt_path))

    def test_separate_link_has_exactly_its_scopes(self):
        before = self.snapshot()
        url, q = self.link("--only", "youtube")
        self.assertEqual(q["scope"][0].split(), YT)
        self.assertEqual(q["include_granted_scopes"], ["false"])
        self.assertEqual(q["code_challenge_method"], ["S256"])
        self.assertEqual(mode(self.pkce("youtube")), 0o600)
        entry = jload(self.pkce("youtube"))["entries"][-1]
        self.assertEqual(entry["state"], q["state"][0])
        self.assertNotIn(entry["verifier"], url)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(os.path.exists(self.pkce()))

    def test_separate_redeem_writes_only_its_file_0600(self):
        _, q = self.link("--only", "youtube")
        verifier = jload(self.pkce("youtube"))["entries"][-1]["verifier"]
        before = self.snapshot()
        self.yt_response()
        rc, out, err = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.fake.requests[0]["code_verifier"], verifier)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.backups(), [])
        self.assertNotIn(self.paths["gmail"], out)
        self.assertEqual(mode(self.yt_path), 0o600)
        yt = jload(self.yt_path)
        self.assertEqual(yt["refresh_token"], YT_RT)
        self.assertEqual(yt["scope"].split(), YT)
        self.assertEqual(jload(self.pkce("youtube"))["entries"], [])
        self.assertFalse(os.path.exists(self.pending("youtube")))

    def test_separate_redeem_backs_up_an_existing_file(self):
        write(self.yt_path, {"access_token": OLD_AT, "refresh_token": OLD_RT, "scope": YT[0],
                             "token_type": "Bearer", "expires_in": 1, "obtained_at": 1}, pretty=False)
        with open(self.yt_path, "rb") as f:
            old_bytes = f.read()
        _, q = self.link("--only", "youtube")
        self.yt_response()
        rc, _, err = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        baks = [b for b in self.backups() if os.path.basename(b).startswith("youtube-token.json.bak-")]
        self.assertEqual(len(baks), 1)
        self.assertEqual(mode(baks[0]), 0o600)
        with open(baks[0], "rb") as f:
            self.assertEqual(f.read(), old_bytes)

    def test_separate_dry_run_then_real_run_reuses_the_exchange(self):
        _, q = self.link("--only", "youtube")
        self.yt_response()
        rc, out, err = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]), "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertIn("NEW FILE " + self.yt_path, out)
        self.assertFalse(os.path.exists(self.yt_path))
        self.assertEqual(mode(self.pending("youtube")), 0o600)
        self.assertFalse(os.path.exists(self.pending()))
        rc, _, err = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(self.fake.requests), 1)
        self.assertTrue(os.path.exists(self.yt_path))

    def test_separate_redeem_refuses_union_scopes_merged_in(self):
        _, q = self.link("--only", "youtube")
        self.yt_response(scopes=YT + [G + "drive.file"])
        rc, out, err = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))
        self.assertEqual(rc, 3)
        self.assertIn("NOT REQUESTED: " + G + "drive.file", out)
        self.assertIn("NOTHING was written", err)
        self.assertFalse(os.path.exists(self.yt_path))

    def test_separate_redeem_refuses_a_missing_scope(self):
        _, q = self.link("--only", "youtube")
        self.yt_response(scopes=[YT[0]])
        rc, out, _ = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))
        self.assertEqual(rc, 3)
        self.assertIn("MISSING: " + YT[1], out)
        self.assertFalse(os.path.exists(self.yt_path))

    def test_states_do_not_cross_between_the_flows(self):
        _, uq = self.link()
        _, yq = self.link("--only", "youtube")
        before = self.snapshot()
        self.yt_response()
        rc, _, err = self.run_cli("redeem", "--only", "youtube", self.pasted(uq["state"][0]))
        self.assertEqual(rc, 1)
        self.assertIn("UNION link", err)
        rc, _, err = self.run_cli("redeem", self.pasted(yq["state"][0]))
        self.assertEqual(rc, 1)
        self.assertIn("--only youtube", err)
        self.assertEqual(self.fake.requests, [])
        self.assertFalse(os.path.exists(self.yt_path))
        self.assertEqual(self.snapshot(), before)

    def test_separate_partial_is_refused(self):
        _, q = self.link("--only", "youtube")
        rc, _, _ = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]), "--partial")
        self.assertEqual(rc, 2)
        self.assertEqual(self.fake.requests, [])

    def test_separate_testing_mode_warns_and_exits_4(self):
        _, q = self.link("--only", "youtube")
        self.yt_response(testing=True)
        rc, _, err = self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))
        self.assertEqual(rc, 4)
        self.assertIn("Testing", err)

    def test_status_lists_separate_consumer_in_its_own_group(self):
        rc, out, _ = self.run_cli("status")
        self.assertEqual(rc, 0)
        self.assertIn("Separate consents", out)
        self.assertIn("file missing", out.split("Separate consents", 1)[1])

        _, q = self.link("--only", "youtube")
        self.yt_response()
        self.assertEqual(self.run_cli("redeem", "--only", "youtube", self.pasted(q["state"][0]))[0], 0)
        rc, out, _ = self.run_cli("status")
        union_part, sep_part = out.split("Separate consents", 1)
        self.assertNotIn("youtube", union_part)
        self.assertNotIn("different refresh tokens", out)
        row = next(l for l in sep_part.splitlines() if l.startswith("youtube "))
        self.assertEqual(row.split()[1:3], ["600", "B"])  # the union files are group A
        self.assertTrue(row.endswith("OK"), row)

        yt = jload(self.yt_path)
        yt["refresh_token"] = OLD_RT
        write(self.yt_path, yt)
        rc, out, _ = self.run_cli("status")
        self.assertIn("holds the same refresh token as", out)


class StatusTests(Base):
    def test_status_reports_groups_modes_and_expiry_without_secrets(self):
        os.chmod(self.paths["tags"], 0o644)
        t = jload(self.paths["tags"])
        t["refresh_token"] = "DIFFERENT"
        write(self.paths["tags"], t, pretty=False)
        os.chmod(self.paths["tags"], 0o644)
        rc, out, _ = self.run_cli("status")
        self.assertEqual(rc, 0)
        self.assertIn("different refresh tokens", out)
        self.assertNotIn("DIFFERENT", out)
        row = next(l for l in out.splitlines() if l.startswith("tags "))
        self.assertEqual(row.split()[1], "644")
        self.assertIn("YES (7-day?)", row)
        self.assertEqual(self.fake.requests, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
