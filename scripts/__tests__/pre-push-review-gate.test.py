#!/usr/bin/env python3
"""Test the pre-push reviewer-green gate (scripts/git-hooks/pre-push-review-gate.py), card ee1a22f1.

Real git, real installer, real dispatcher: every case runs an actual `git push` from a throwaway
repo to a bare remote, with the hook installed by scripts/install-review-gate-hook.sh. The
dashboard is a local stub (a thread serving /api/messages), so nothing here touches the live
mailbox, the live .git/hooks or the network. Run:
  python3 scripts/__tests__/pre-push-review-gate.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).

What this file guards above all, in the order the gate can go wrong:
  - the FAIL direction: a stub that cannot be reached, a missing token, a malformed answer must
    BLOCK, never pass;
  - the lookalikes that must NOT count as a trace: the reviewer's line with text after the hash, a sentence
    mentioning the token, a row from another sender, a failed row, a 7-digit prefix, a green for
    the OLD head after an amend;
  - what needs NO trace and must pass without even asking the dashboard (deletion, a commit that
    is already on the remote), proved by the stub's request counter.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
CLEAN_ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
CLEAN_ENV.update({"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                  "GIT_COMMITTER_EMAIL": "t@t"})
for _k in ("REVIEW_GATE_SKIP", "REVIEW_GATE_SKIP_REASON", "MARVEEN_API_BASE", "MARVEEN_WEB_PORT",
           "WEB_PORT", "MARVEEN_TOKEN_FILE", "REVIEW_GATE_INSTALL_ROOT", "REVIEW_GATE_REVIEWER", "REVIEW_GATE_TRACE_WORD"):
    CLEAN_ENV.pop(_k, None)
# The gate applies to agent sessions only (the owner's decision, 2026-10-11). The suite itself may run inside one,
# so the agent markers are removed here and the agent case is put back explicitly in setUp.
AGENT_MARKERS = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_EXECPATH")
for _k in AGENT_MARKERS:
    CLEAN_ENV.pop(_k, None)


class Stub:
    """Serves GET /api/messages. `rows` is the whole mailbox; the handler honours agent/limit/before."""

    def __init__(self):
        self.rows = []
        self.requests = []
        self.token_seen = []
        self.raw = None  # when set, answer with this body instead (malformed-answer case)
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                u = urlparse(self.path)
                q = parse_qs(u.query)
                stub.requests.append(self.path)
                stub.token_seen.append(self.headers.get("Authorization"))
                if stub.raw is not None:
                    body = stub.raw.encode()
                else:
                    who = q.get("agent", ["reviewer1"])[0]
                    rows = [r for r in stub.rows if r["from_agent"] == who or r["to_agent"] == who]
                    rows.sort(key=lambda r: -r["id"])
                    if "before" in q:
                        rows = [r for r in rows if r["id"] < int(q["before"][0])]
                    body = json.dumps(rows[: int(q.get("limit", ["50"])[0])]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.next_id = 1

    def add(self, content, frm="reviewer1", to="igor", status="done"):
        self.rows.append({"id": self.next_id, "from_agent": frm, "to_agent": to, "content": content, "status": status})
        self.next_id += 1

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def sh(*cmd, cwd=None, env=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, env=env or CLEAN_ENV, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError("%s failed (%d): %s%s" % (" ".join(cmd), p.returncode, p.stdout, p.stderr))
    return p


class ReviewGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = Stub()
        cls.tmp = tempfile.mkdtemp(prefix="reviewgate-")
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        ReviewGate.n += 1
        self.stub.rows.clear()
        self.stub.requests.clear()
        self.stub.next_id = 1
        base = os.path.join(self.tmp, "case%d" % ReviewGate.n)
        self.repo = os.path.join(base, "repo")
        self.bare = os.path.join(base, "fork.git")
        self.upbare = os.path.join(base, "up.git")
        os.makedirs(os.path.join(self.repo, "scripts", "git-hooks"))
        os.makedirs(os.path.join(self.repo, "store"))
        sh("git", "init", "-q", "--bare", "-b", "develop", self.bare)
        sh("git", "init", "-q", "--bare", "-b", "develop", self.upbare)
        sh("git", "init", "-q", "-b", "develop", self.repo)
        for f in ("install-review-gate-hook.sh", "install-git-guard-hook.sh"):
            shutil.copy(os.path.join(SCRIPTS, f), os.path.join(self.repo, "scripts", f))
        shutil.copy(os.path.join(SCRIPTS, "git-hooks", "pre-push-review-gate.py"),
                    os.path.join(self.repo, "scripts", "git-hooks", "pre-push-review-gate.py"))
        with open(os.path.join(self.repo, "store", ".dashboard-token"), "w") as fh:
            fh.write("test-token\n")
        sh("git", "remote", "add", "origin", self.upbare, cwd=self.repo)
        sh("git", "remote", "add", "fork", self.bare, cwd=self.repo)
        self.commit("base")
        # Setup pushes happen BEFORE the hook is installed (a setup push through the hook is itself gated).
        sh("git", "push", "-q", "origin", "develop", cwd=self.repo)
        sh("git", "push", "-q", "fork", "develop", cwd=self.repo)
        sh("git", "fetch", "-q", "origin", cwd=self.repo)
        sh("git", "fetch", "-q", "fork", cwd=self.repo)
        sh("bash", os.path.join(self.repo, "scripts", "install-review-gate-hook.sh"), cwd=self.repo)
        # self.env is an AGENT push (CLAUDECODE set); self.hand_env is a hand push (no marker).
        self.hand_env = dict(CLEAN_ENV, MARVEEN_API_BASE="http://127.0.0.1:%d" % self.stub.port,
                             REVIEW_GATE_REVIEWER="reviewer1", REVIEW_GATE_TRACE_WORD="CUSTOM-GREEN")
        self.env = dict(self.hand_env, CLAUDECODE="1")
        sh("git", "checkout", "-q", "-b", "feature", cwd=self.repo)

    def commit(self, msg):
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write(msg + "\n")
        sh("git", "add", "f.txt", cwd=self.repo)
        sh("git", "commit", "-q", "-m", msg, cwd=self.repo)
        return self.head()

    def head(self):
        return sh("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()

    def push(self, *args, env=None):
        return subprocess.run(["git", "push", "-q", *args], cwd=self.repo, env=env or self.env,
                              capture_output=True, text=True)

    def hook_path(self):
        return os.path.join(self.repo, ".git", "hooks", "pre-push.d", "30-review-gate")

    # ---- the trace -------------------------------------------------------------------------

    def test_no_trace_blocks_and_names_what_is_needed(self):
        h = self.commit("a")
        p = self.push("fork", "feature")
        self.assertNotEqual(p.returncode, 0, p.stderr)
        self.assertIn("has no green trace from reviewer1", p.stderr)
        self.assertIn("CUSTOM-GREEN " + h[:8], p.stderr)

    def test_trace_for_the_head_passes(self):
        h = self.commit("a")
        self.stub.add("Reviewed, fine.\nCUSTOM-GREEN %s\nCard: x" % h[:8])
        p = self.push("fork", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(h, sh("git", "ls-remote", self.bare, "refs/heads/feature").stdout)

    def test_full_40_digit_hash_and_uppercase_pass(self):
        h = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % h.upper())
        self.assertEqual(self.push("fork", "feature").returncode, 0)

    def test_green_for_the_old_head_does_not_cover_an_amended_head(self):
        old = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % old[:8])
        self.assertEqual(self.push("fork", "feature").returncode, 0)
        sh("git", "commit", "-q", "--amend", "-m", "a (amended)", cwd=self.repo)
        p = self.push("--force", "fork", "feature")
        self.assertNotEqual(p.returncode, 0, "a force-push of a NEW head must need a NEW green")
        self.assertIn("has no green trace from reviewer1", p.stderr)

    def test_a_further_commit_on_the_pr_branch_needs_its_own_green(self):
        first = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % first[:8])
        self.assertEqual(self.push("fork", "feature").returncode, 0)
        self.commit("b")
        p = self.push("fork", "feature")
        self.assertNotEqual(p.returncode, 0)

    def test_lookalikes_do_not_count(self):
        h = self.commit("a")
        for text in (
            "CUSTOM-GREEN %s NOT" % h[:8],                      # text after the hash
            "CUSTOM-GREEN %s." % h[:8],                         # trailing punctuation
            "If it were green: CUSTOM-GREEN %s" % h[:8],           # not a line of its own
            "`CUSTOM-GREEN %s`" % h[:8],                        # wrapped
            "CUSTOM-GREEN %s" % h[:7],                          # prefix too short
            "CUSTOM-RED %s" % h[:8],                           # a refusal
            "CUSTOM-GREEN deadbeef",                            # another commit
        ):
            self.stub.rows.clear()
            self.stub.add(text)
            p = self.push("--dry-run", "fork", "feature")
            self.assertNotEqual(p.returncode, 0, "must NOT count as a trace: %r\n%s" % (text, p.stderr))

    def test_a_row_from_another_sender_or_a_failed_row_does_not_count(self):
        h = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % h[:8], frm="other-agent", to="reviewer1")
        self.stub.add("CUSTOM-GREEN %s" % h[:8], frm="reviewer1", status="failed")
        self.assertNotEqual(self.push("--dry-run", "fork", "feature").returncode, 0)

    def test_the_token_is_sent_and_never_printed(self):
        h = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % h[:8])
        p = self.push("fork", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Bearer test-token", self.stub.token_seen)
        self.assertNotIn("test-token", p.stderr + p.stdout)

    def test_a_green_older_than_one_page_is_found(self):
        h = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % h[:8])
        for i in range(250):
            self.stub.add("chatter %d" % i)
        p = self.push("fork", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertGreaterEqual(len(self.stub.requests), 2, "should have paged back")

    # ---- fail direction --------------------------------------------------------------------

    def test_dashboard_unreachable_blocks(self):
        self.commit("a")
        env = dict(self.env, MARVEEN_API_BASE="http://127.0.0.1:1")
        p = self.push("fork", "feature", env=env)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("cannot read reviewer1's messages", p.stderr)

    def test_missing_token_blocks(self):
        self.commit("a")
        os.remove(os.path.join(self.repo, "store", ".dashboard-token"))
        p = self.push("fork", "feature")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("cannot read reviewer1's messages", p.stderr)

    def test_a_malformed_answer_blocks(self):
        self.commit("a")
        self.stub.raw = '{"error":"nope"}'
        try:
            p = self.push("fork", "feature")
        finally:
            self.stub.raw = None
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("cannot read reviewer1's messages", p.stderr)

    def test_python_missing_from_the_hook_means_the_push_is_blocked_not_skipped(self):
        # the dispatcher turns a hook that cannot start into a failed push: shebang to nowhere
        self.commit("a")
        path = self.hook_path()
        with open(path) as fh:
            body = fh.read().replace("#!/usr/bin/env python3", "#!/nonexistent/python3", 1)
        with open(path, "w") as fh:
            fh.write(body)
        self.assertNotEqual(self.push("fork", "feature").returncode, 0)

    # ---- what needs no trace ---------------------------------------------------------------

    def test_branch_deletion_needs_no_trace_and_no_request(self):
        self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % self.head()[:8])
        self.assertEqual(self.push("fork", "feature").returncode, 0)
        self.stub.rows.clear()
        self.stub.requests.clear()
        p = self.push("fork", "--delete", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.stub.requests, [])

    def test_a_commit_the_remote_already_has_needs_no_trace_and_no_request(self):
        # pushing an existing commit to a second branch name sends no new code
        self.assertEqual(sh("git", "rev-parse", "develop", cwd=self.repo).stdout.strip(), self.head())
        p = self.push("fork", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.stub.requests, [])

    def test_an_upstream_commit_pushed_to_the_fork_needs_no_trace(self):
        # the fork lags: origin has a commit the fork does not; syncing it is not our code going out
        sh("git", "checkout", "-q", "develop", cwd=self.repo)
        h = self.commit("upstream work")
        sh("git", "push", "-q", "--no-verify", "origin", "develop", cwd=self.repo)
        sh("git", "fetch", "-q", "origin", cwd=self.repo)
        p = self.push("fork", "develop")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.stub.requests, [])
        self.assertIn(h, sh("git", "ls-remote", self.bare, "refs/heads/develop").stdout)

    def test_pushing_new_code_to_the_upstream_itself_still_needs_a_trace(self):
        self.commit("ours")
        p = self.push("origin", "feature")
        self.assertNotEqual(p.returncode, 0)

    # ---- who it applies to -----------------------------------------------------------------

    def test_a_hand_push_without_agent_markers_passes_with_no_trace_and_no_request(self):
        self.commit("a")
        for remote in ("fork", "origin"):
            p = self.push(remote, "feature", env=self.hand_env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("not a Claude Code agent session", p.stderr)
        self.assertEqual(self.stub.requests, [], "a non-agent push must not even ask the dashboard")

    def test_every_agent_marker_alone_makes_the_push_gated(self):
        for marker in AGENT_MARKERS:
            with self.subTest(marker=marker):
                self.commit("m-" + marker)
                p = self.push("fork", "feature", env=dict(self.hand_env, **{marker: "1"}))
                self.assertNotEqual(p.returncode, 0, p.stderr)
                self.assertIn("has no green trace from reviewer1", p.stderr)

    def test_an_empty_marker_does_not_make_the_push_an_agent_push(self):
        self.commit("a")
        p = self.push("fork", "feature", env=dict(self.hand_env, CLAUDECODE=""))
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_config_dir_alone_is_not_a_marker(self):
        # CLAUDE_CONFIG_DIR can be exported in a plain terminal to run `claude`; it must not gate a hand push.
        self.commit("a")
        p = self.push("fork", "feature", env=dict(self.hand_env, CLAUDE_CONFIG_DIR="/tmp/x"))
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_documented_limit_an_agent_that_unsets_the_markers_walks_through(self):
        # NOT a feature: pins the stated limit (a "who typed it" guess, not an identity). If this ever
        # fails, update the docs too.
        self.commit("a")
        env = {k: v for k, v in self.env.items() if k not in AGENT_MARKERS}
        self.assertEqual(self.push("fork", "feature", env=env).returncode, 0)

    def test_a_green_agent_push_still_passes(self):
        h = self.commit("a")
        self.stub.add("CUSTOM-GREEN %s" % h[:12])
        p = self.push("fork", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)

    # ---- opt-in and configurable (upstream review of #1888, finding 1) -----------------------

    def env_without(self, *names):
        return {k: v for k, v in self.env.items() if k not in names}

    def test_an_unset_reviewer_means_the_gate_is_inactive(self):
        self.commit("a")
        env = self.env_without("REVIEW_GATE_REVIEWER", "REVIEW_GATE_TRACE_WORD")
        for remote in ("fork", "origin"):
            p = self.push(remote, "feature", env=env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("INACTIVE", p.stderr)
        self.assertEqual(self.stub.requests, [], "an inactive gate must not even ask the dashboard")

    def test_reviewer_and_word_can_come_from_the_install_dotenv(self):
        h = self.commit("a")
        with open(os.path.join(self.repo, ".env"), "w") as fh:
            fh.write("REVIEW_GATE_REVIEWER=reviewer1\nREVIEW_GATE_TRACE_WORD='CUSTOM-GREEN'\n")
        env = self.env_without("REVIEW_GATE_REVIEWER", "REVIEW_GATE_TRACE_WORD")
        p = self.push("fork", "feature", env=env)
        self.assertNotEqual(p.returncode, 0, p.stderr)
        self.assertIn("has no green trace from reviewer1", p.stderr)
        self.stub.add("CUSTOM-GREEN " + h[:12])
        p = self.push("fork", "feature", env=env)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_another_reviewer_and_the_default_word_and_no_name_in_the_texts(self):
        h = self.commit("a")
        env = dict(self.env_without("REVIEW_GATE_TRACE_WORD"), REVIEW_GATE_REVIEWER="reviewer2")
        self.stub.add("CUSTOM-GREEN " + h[:12], frm="reviewer2")  # right sender, wrong word
        p = self.push("fork", "feature", env=env)
        self.assertNotEqual(p.returncode, 0, p.stderr)
        self.assertIn("REVIEW-GREEN " + h[:8], p.stderr)
        for name in ("Sam", "Laci", "CUSTOM-GREEN"):
            self.assertNotIn(name, p.stderr)
        self.stub.add("REVIEW-GREEN " + h[:12], frm="reviewer1")  # right word, wrong sender
        self.assertNotEqual(self.push("fork", "feature", env=env).returncode, 0)
        self.stub.add("REVIEW-GREEN " + h[:12], frm="reviewer2")
        p = self.push("fork", "feature", env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(any("agent=reviewer2" in r for r in self.stub.requests), self.stub.requests)

    def test_a_misconfigured_reviewer_or_word_blocks(self):
        self.commit("a")
        for key, val in (("REVIEW_GATE_REVIEWER", "reviewer1&x=1"), ("REVIEW_GATE_TRACE_WORD", "a b")):
            with self.subTest(key=key):
                p = self.push("fork", "feature", env=dict(self.env, **{key: val}))
                self.assertNotEqual(p.returncode, 0, p.stderr)
                self.assertIn("misconfigured", p.stderr)
        self.assertEqual(self.stub.requests, [])

    def test_dotenv_lines_are_read_like_the_product_reader_plus_export(self):
        h = self.commit("a")
        env = self.env_without("REVIEW_GATE_REVIEWER", "REVIEW_GATE_TRACE_WORD")
        dotenv = os.path.join(self.repo, ".env")
        cases = {
            "export prefix": "export REVIEW_GATE_REVIEWER=reviewer1\nexport REVIEW_GATE_TRACE_WORD=CUSTOM-GREEN\n",
            "export + quotes + spaces": "  export  REVIEW_GATE_REVIEWER = \"reviewer1\"  \n# c\nREVIEW_GATE_TRACE_WORD='CUSTOM-GREEN'\n",
            "BOM on the first line": "\ufeffREVIEW_GATE_REVIEWER=reviewer1\nREVIEW_GATE_TRACE_WORD=CUSTOM-GREEN\n",
            "BOM + export": "\ufeffexport REVIEW_GATE_REVIEWER=reviewer1\nREVIEW_GATE_TRACE_WORD=CUSTOM-GREEN\n",
            "last occurrence wins": "REVIEW_GATE_REVIEWER=other\nREVIEW_GATE_REVIEWER=reviewer1\nREVIEW_GATE_TRACE_WORD=CUSTOM-GREEN\n",
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                with open(dotenv, "w", encoding="utf-8", newline="") as fh:
                    fh.write(body)
                p = self.push("fork", "feature", env=env)
                self.assertNotEqual(p.returncode, 0, "the gate must be ACTIVE for %r: %s" % (label, p.stderr))
                self.assertIn("has no green trace from reviewer1", p.stderr)
        # a commented-out line is NOT a setting
        with open(dotenv, "w") as fh:
            fh.write("# REVIEW_GATE_REVIEWER=reviewer1\n")
        p = self.push("fork", "feature", env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("INACTIVE", p.stderr)

    # ---- the installer (upstream review of #1888, finding 2) -------------------------------

    def installer(self):
        return os.path.join(self.repo, "scripts", "install-review-gate-hook.sh")

    def test_the_installer_refuses_loudly_when_core_hooks_path_points_elsewhere(self):
        os.makedirs(os.path.join(self.repo, ".githooks"))
        sh("git", "config", "core.hooksPath", ".githooks", cwd=self.repo)
        p = sh("bash", self.installer(), cwd=self.repo, check=False)
        self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("would enforce NOTHING", p.stderr)
        self.assertNotIn("installed", p.stdout)

    def test_the_installer_removes_the_first_generation_hook_and_only_that(self):
        d = os.path.join(self.repo, ".git", "hooks", "pre-push.d")
        legacy = os.path.join(d, "30-sam-green-gate")
        with open(legacy, "w") as fh:
            fh.write('#!/usr/bin/env python3\n"""pre-push gate: outgoing code needs a Sam-green trace"""\n')
        os.chmod(legacy, 0o755)
        p = sh("bash", self.installer(), cwd=self.repo)
        self.assertFalse(os.path.exists(legacy), p.stdout)
        self.assertTrue(os.path.exists(self.hook_path()))
        # an unrelated file under that name is left alone
        with open(legacy, "w") as fh:
            fh.write("#!/bin/sh\necho mine\n")
        sh("bash", self.installer(), cwd=self.repo)
        self.assertTrue(os.path.exists(legacy))

    def test_the_installer_accepts_core_hooks_path_equal_to_the_hook_dir(self):
        sh("git", "config", "core.hooksPath", os.path.join(self.repo, ".git", "hooks"), cwd=self.repo)
        p = sh("bash", self.installer(), cwd=self.repo, check=False)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("INACTIVE until REVIEW_GATE_REVIEWER", p.stdout)

    # ---- fail-closed branches that were reachable but unpinned (finding 3) ------------------

    def test_a_ref_that_does_not_resolve_to_a_commit_blocks(self):
        self.commit("a")
        blob = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=self.repo, env=CLEAN_ENV, input="x\n",
                              capture_output=True, text=True, check=True).stdout.strip()
        p = self.push("fork", blob + ":refs/tags/x")
        self.assertNotEqual(p.returncode, 0, p.stderr)
        self.assertIn("does not resolve to a commit", p.stderr)

    def test_a_failing_rev_list_blocks(self):
        # A stub `git` on PATH does not reach the hook (git puts its own exec path first for hooks), so the
        # failure is made real: the base commit's object is moved away and the hook's rev-list cannot walk to it.
        # The hook is run DIRECTLY and its own exit status is asserted: through `git push` the push would fail
        # anyway on the missing object, so a push result cannot tell a blocking hook from a passing one.
        head = self.commit("a")
        base = sh("git", "rev-parse", "develop", cwd=self.repo).stdout.strip()
        obj = os.path.join(self.repo, ".git", "objects", base[:2], base[2:])
        self.assertTrue(os.path.exists(obj), "the base commit must be a loose object for this case")
        os.rename(obj, obj + ".moved-away")
        p = subprocess.run([self.hook_path(), "fork", self.bare], cwd=self.repo, env=self.env, capture_output=True,
                           text=True, input="refs/heads/feature %s refs/heads/feature %s\n" % (head, "0" * 40))
        self.assertEqual(p.returncode, 1, p.stderr)
        self.assertIn("git rev-list failed", p.stderr)

    def test_odd_answer_shapes_block_with_the_gates_message_not_a_traceback(self):
        self.commit("a")
        for raw in ('["x", 1]', '[{"id":1,"from_agent":"reviewer1","status":"done","content":5}]'):
            with self.subTest(raw=raw):
                self.stub.raw = raw
                try:
                    p = self.push("fork", "feature")
                finally:
                    self.stub.raw = None
                self.assertNotEqual(p.returncode, 0, p.stderr)
                self.assertIn("cannot read reviewer1's messages", p.stderr)
                self.assertNotIn("Traceback", p.stderr)

    # ---- the bypass ------------------------------------------------------------------------

    def test_skip_without_a_reason_is_refused(self):
        self.commit("a")
        p = self.push("fork", "feature", env=dict(self.env, REVIEW_GATE_SKIP="1"))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("needs REVIEW_GATE_SKIP_REASON", p.stderr)

    def test_skip_with_a_reason_passes_and_is_recorded(self):
        h = self.commit("a")
        env = dict(self.env, REVIEW_GATE_SKIP="1", REVIEW_GATE_SKIP_REASON="owner msg 9999: emergency hotfix")
        p = self.push("fork", "feature", env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(os.path.join(self.repo, "store", "push-review-gate-skips.log")) as fh:
            log = fh.read()
        self.assertIn("owner msg 9999: emergency hotfix", log)
        self.assertIn(h, log)
        self.assertEqual(self.stub.requests, [], "a skip must not even ask the dashboard")

    def test_a_skip_that_cannot_be_recorded_is_refused(self):
        self.commit("a")
        os.symlink("/nonexistent-dir/x.log", os.path.join(self.repo, "store", "push-review-gate-skips.log"))
        env = dict(self.env, REVIEW_GATE_SKIP="1", REVIEW_GATE_SKIP_REASON="owner msg 9999: emergency hotfix")
        p = self.push("fork", "feature", env=env)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("unrecorded skip is refused", p.stderr)

    def test_documented_limit_no_verify_skips_the_gate(self):
        # NOT a feature: this pins the stated limit (the gate guards against forgetting) so nobody
        # later reads the gate as stronger than it is. If this ever fails, update the docs too.
        self.commit("a")
        p = self.push("--no-verify", "fork", "feature")
        self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
