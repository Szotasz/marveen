#!/usr/bin/env python3
"""Quiet-hours contract for scripts/hooks/telegram-reply-guard.py (cards 30d968cd / 352c3b42).

Run: python3 scripts/__tests__/telegram-reply-guard-quiet-hours.test.py
Exit 0 = pass. Discovered and executed by src/__tests__/script-tests-runner.test.ts,
which invokes every scripts/__tests__/*.test.py WITHOUT arguments -- so this file
must be self-contained and take no required argument.

WHAT IT PINS
  A message that arrives inside the chat's quiet window must not be blocked and
  must not increment the stop counter (03:57 -> checks at 01:58 / 01:59 / 02:30),
  and it must still be enforced once the window closes (07:01), because the
  staleness clock runs from the window END rather than from arrival. Without that
  second half the reminder goes stale overnight and is silently dropped.

NEGATIVE CONTROL, IN THIS FILE
  A green probe proves nothing on its own: it has to fail on the unpatched shape.
  This file builds that shape at run time by cutting the quiet-hours block out of
  the guard source, and asserts the probe FAILS on it. The cut is verified (both
  markers found, the result is shorter, and `in_quiet` is gone), so a marker drift
  turns the control loud instead of vacuous.

DATA
  No real identifier appears here. The chat id, the message text and the payload
  cwd are fixtures. That loses no coverage: the probe always wrote its own
  quiet-hours.json into a temp dir, so a real id was only ever the key of a
  throwaway file -- it never tested the site's configuration, and neither does this.

  The payload cwd matters more than it looks: the guard resolves its state dir
  from CLAUDE_PROJECT_DIR or the cwd, so a cwd that does not exist yields no
  quiet-hours.json and makes in_quiet False for EVERY chat. A probe that inherited
  such a default would measure the fail-open state it is meant to exclude, and
  would pass while doing it. Hence the explicit fixture below.
"""
import contextlib
import datetime
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_GUARD = os.path.join(REPO, "scripts", "hooks", "telegram-reply-guard.py")

CHAT_ID = os.environ.get("TEST_CHAT_ID", "999")
QUESTION_TEXT = "teszt-kerdes helyorzo szoveg"
MESSAGE_ID = "1"
TZ = ZoneInfo("Europe/Budapest")

# The guard reads its state dir from CLAUDE_PROJECT_DIR or the cwd; both are
# overridden per probe, but the payload cwd must still be a directory that exists.
TEST_CWD = os.environ.get("TEST_CWD", tempfile.gettempdir())

# One fake clock for the whole file; each probe sets NOW before every hook round.
import time as _time  # noqa: E402

_fake_time = types.ModuleType("time")
for _n in dir(_time):
    if not _n.startswith("__"):
        setattr(_fake_time, _n, getattr(_time, _n))
_fake_time.time = lambda: _fake_time.NOW
sys.modules["time"] = _fake_time


def _ep(h, m):
    return int(datetime.datetime(2026, 9, 12, h, m, tzinfo=TZ).timestamp())


ARRIVED = _ep(1, 57)


def probe(guard_path):
    """Run the four rounds against one guard. Returns (ok, rows)."""
    state_dir = tempfile.mkdtemp()
    os.environ["TELEGRAM_STATE_DIR"] = state_dir
    # the guard records the usable config in the install marker (card 20e178fc): a temp root, not the checkout's store
    os.environ["MARVEEN_ROOT"] = tempfile.mkdtemp()
    json.dump({CHAT_ID: {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}},
              open(os.path.join(state_dir, "quiet-hours.json"), "w"))

    fake_ledger = types.ModuleType("ledger_lib")
    fake_ledger.agent_id_from_payload = lambda p: "main-agent"
    fake_ledger.db_path = lambda: os.path.join(state_dir, "db.sqlite")
    fake_ledger.open_question_with_age = lambda a: (
        CHAT_ID, MESSAGE_ID, QUESTION_TEXT, "2026-09-11T23:57:34Z", ARRIVED)
    sys.modules["ledger_lib"] = fake_ledger

    # in_quiet takes now=None -> datetime.now(tz); make it follow the fake clock.
    # The module is the repo's, next to the guard: since e6680b3c the guard imports it from its own
    # directory, and a copy under ~/.claude/hooks is not what ships. Measured 2026-10-01: the copy
    # there had no config_state(), and a probe that preferred it crashed the merged guard.
    hooks_dir = os.path.join(REPO, "scripts", "hooks")
    sys.path.insert(0, hooks_dir)
    import telegram_quiet_hours as q
    assert os.path.dirname(os.path.abspath(q.__file__)) == hooks_dir, (
        "the probe must measure the repo's quiet-hours module, got %s" % q.__file__)
    real_in_quiet = getattr(q, "_real_in_quiet", q.in_quiet)
    q._real_in_quiet = real_in_quiet
    q.in_quiet = lambda sd, cid, now=None: real_in_quiet(
        sd, cid, now or datetime.datetime.fromtimestamp(_fake_time.NOW, TZ))

    def one_round(now_epoch):
        _fake_time.NOW = now_epoch
        loader = importlib.machinery.SourceFileLoader("guard", guard_path)
        spec = importlib.util.spec_from_loader("guard", loader)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sys.stdin = io.StringIO(json.dumps({"session_id": "t", "cwd": TEST_CWD}))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                mod.main()
            except SystemExit:
                pass
        return "block" in out.getvalue()

    state_file = os.path.join(state_dir, ".tg-reply-guard-main-agent")

    def counter():
        try:
            return int(open(state_file).read().split("\t")[1])
        except Exception:
            return 0

    rows = []
    for h, m in ((1, 58), (1, 59), (2, 30)):
        rows.append(("%02d:%02d" % (h, m), one_round(_ep(h, m)), counter()))
    rows.append(("07:01", one_round(_ep(7, 1)), counter()))
    ok = (not rows[0][1] and not rows[1][1] and not rows[2][1] and rows[2][2] == 0
          and rows[3][1] and rows[3][2] == 1)
    return ok, rows


def unpatched_copy(guard_path):
    """Write a copy of the guard with the quiet-hours block cut out.

    Raises if the cut cannot be verified -- a silent no-op here would turn the
    negative control into a second copy of the positive one.
    """
    src = open(guard_path, encoding="utf-8").read()
    start_mark = "# Quiet hours (card 30d968cd"
    end_mark = "# Too old -> don't nag forever"
    if src.count(start_mark) != 1 or src.count(end_mark) != 1:
        raise AssertionError(
            "the quiet-hours block markers moved (start=%d end=%d); the negative "
            "control cannot be built, so this test refuses to pass"
            % (src.count(start_mark), src.count(end_mark)))
    i, j = src.index(start_mark), src.index(end_mark)
    cut = src[:i] + "anchor = created_at\n\n    " + src[j:]
    if len(cut) >= len(src) or "in_quiet" in cut:
        raise AssertionError("the cut removed nothing (len %d -> %d, in_quiet present: %s)"
                             % (len(src), len(cut), "in_quiet" in cut))
    path = os.path.join(tempfile.mkdtemp(), "guard-unpatched.py")
    open(path, "w", encoding="utf-8").write(cut)
    return path


def main():
    guard = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GUARD
    expect = sys.argv[2] if len(sys.argv) > 2 else None

    ok, rows = probe(guard)
    for name, blocked, cnt in rows:
        print("  %s: blocked=%s counter=%s" % (name, blocked, cnt))
    verdict = "PASS" if ok else "FAIL"
    print("%s (%s)" % (verdict, guard))

    if expect is not None:                      # explicit mode, for development
        print("expected=%s" % expect)
        return 0 if verdict.lower() == expect else 1

    if not ok:
        print("FAIL: the patched guard does not honour the quiet window")
        return 1

    # Negative control: the same probe must FAIL on the guard without the block.
    unpatched = unpatched_copy(guard)
    ok2, rows2 = probe(unpatched)
    for name, blocked, cnt in rows2:
        print("  [negative control] %s: blocked=%s counter=%s" % (name, blocked, cnt))
    if ok2:
        print("FAIL: the probe also passes WITHOUT the quiet-hours block, so it "
              "does not measure this change")
        return 1
    print("PASS: probe green on the patched guard, red without the block")
    return 0


if __name__ == "__main__":
    sys.exit(main())
