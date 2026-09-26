#!/usr/bin/env python3
"""Branch tests for garmin_run_gate, with every outward path redirected.

The point of this file is the isolation list, not the assertions. A gate test
that only redirects the obvious artefact still reaches the ones it forgot: an
earlier test in this repo isolated INTEL_DB but not the gate's audit log and
appended 44 synthetic verdicts to the production trail. So every module
constant that names a file or a URL is rebound here -- state, pending,
heartbeat, token, messages endpoint, the analysis script itself -- and the
notify path is replaced outright so no request can leave the process.

Run: python3 scripts/test_garmin_run_gate.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "garmin_run_gate", Path(__file__).resolve().parent / "garmin_run_gate.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

VALODI_NOTIFY = gate.notify_seven  # captured before any scenario rebinds it

FAILURES: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}: {got!r}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILURES.append(name)


def fake_analysis_script(tmp: Path, exit_code: int, advance_to: str | None) -> Path:
    """A stand-in for running_analysis.py with a chosen exit code.

    When advance_to is set it also rewrites the state file, mimicking the real
    script's habit of advancing last_analyzed_run.json before anyone has been
    told about the run.
    """
    body = ["import json, sys"]
    if advance_to is not None:
        body.append(
            f"open({str(tmp / 'state.json')!r}, 'w')"
            f".write(json.dumps({{'last_activity_id': {advance_to!r}}}))"
        )
    body.append(f"sys.exit({exit_code})")
    path = tmp / "fake_analysis.py"
    path.write_text("\n".join(body) + "\n")
    return path


def wire(tmp: Path, script: Path) -> None:
    """Redirect every outward path in the module to the sandbox."""
    gate.GARMIN_DIR = tmp
    gate.ANALYSIS_SCRIPT = script
    gate.STATE_FILE = tmp / "state.json"
    gate.PENDING_FILE = tmp / "pending.txt"
    gate.HEARTBEAT_FILE = tmp / "heartbeat.txt"
    gate.TOKEN_FILE = tmp / "token"
    gate.MESSAGES_URL = "http://127.0.0.1:1/never"
    gate.TOKEN_FILE.write_text("test-token")


def scenario_nothing_new() -> None:
    print("nothing new (rc 0) -> silent success, no notify")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        wire(tmp, fake_analysis_script(tmp, 0, None))
        gate.STATE_FILE.write_text(json.dumps({"last_activity_id": "111"}))
        called = []
        gate.notify_seven = lambda a: called.append(a)

        check("exit code", gate.main(), 0)
        check("notified", called, [])
        check("state untouched", json.loads(gate.STATE_FILE.read_text())["last_activity_id"], "111")
        check("heartbeat written", gate.HEARTBEAT_FILE.read_text().strip(), "nothing-new")


def scenario_new_run() -> None:
    print("new run (rc 2) -> notify, state stays advanced")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        wire(tmp, fake_analysis_script(tmp, 2, "222"))
        gate.STATE_FILE.write_text(json.dumps({"last_activity_id": "111"}))
        called = []
        gate.notify_seven = lambda a: called.append(a)

        check("exit code", gate.main(), 0)
        check("notified with new id", called, ["222"])
        check("state advanced", json.loads(gate.STATE_FILE.read_text())["last_activity_id"], "222")


def scenario_notify_fails() -> None:
    print("new run but notify fails -> state rolled back, non-zero exit")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        wire(tmp, fake_analysis_script(tmp, 2, "222"))
        gate.STATE_FILE.write_text(json.dumps({"last_activity_id": "111"}))

        def boom(_):
            raise OSError("dashboard down")

        gate.notify_seven = boom

        check("exit code", gate.main(), 1)
        check(
            "state rolled back",
            json.loads(gate.STATE_FILE.read_text())["last_activity_id"],
            "111",
        )


def scenario_crash() -> None:
    print("analysis crashes (rc 1) -> non-zero exit, not silence")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        wire(tmp, fake_analysis_script(tmp, 1, None))
        gate.STATE_FILE.write_text(json.dumps({"last_activity_id": "111"}))
        called = []
        gate.notify_seven = lambda a: called.append(a)

        check("exit code", gate.main(), 1)
        check("notified", called, [])
        check("no heartbeat on failure", gate.HEARTBEAT_FILE.exists(), False)


def scenario_no_state_file() -> None:
    print("first ever run, no state file -> rollback deletes it again")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        wire(tmp, fake_analysis_script(tmp, 2, "222"))

        def boom(_):
            raise OSError("dashboard down")

        gate.notify_seven = boom

        check("exit code", gate.main(), 1)
        check("state file gone again", gate.STATE_FILE.exists(), False)


def scenario_sender_is_the_agent_id() -> None:
    """The SENDER is the agent id, and the fallback is the PRODUCT's.

    Two things nothing pinned before, and both lost the message in their own
    way. Measured on the live dashboard 2026-09-25:
      from=garmin-gate -> HTTP 403,  from=<the install's main agent> -> 200
    A readable label reads well and is rejected. And the fallback has to be
    "marveen", because src/config.ts resolves MAIN_AGENT_ID as
    `env['MAIN_AGENT_ID'] ?? 'marveen'`: on an install without the key that IS
    the registered agent, so anything else we invented would be a 403 too.

    Every other scenario replaces notify_seven outright, so this is the only
    one that runs the real function -- which is exactly why the sender went
    unmeasured until review.
    """
    print("the notification is sent AS the agent, with the product's fallback")
    kuldott = {}

    class Valasz:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def hamis(req, timeout=None):
        kuldott.update(json.loads(req.data.decode()))
        return Valasz()

    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        wire(tmp, fake_analysis_script(tmp, 0, None))
        gate.notify_seven = VALODI_NOTIFY
        eredeti_env, eredeti_urlopen = gate.MARVEEN_DIR, gate.urllib.request.urlopen
        gate.MARVEEN_DIR = tmp                      # nincs .env -> a termek alapertelmezese
        gate.urllib.request.urlopen = hamis
        try:
            gate.notify_seven("333")
        finally:
            gate.MARVEEN_DIR, gate.urllib.request.urlopen = eredeti_env, eredeti_urlopen
    check("from is the agent id", kuldott.get("from"), "marveen")
    check("to is the agent id", kuldott.get("to"), "marveen")
    check("not a descriptive label", kuldott.get("from") in {"garmin-gate", "geordi"}, False)


if __name__ == "__main__":
    for scenario in (
        scenario_nothing_new,
        scenario_new_run,
        scenario_notify_fails,
        scenario_crash,
        scenario_no_state_file,
        scenario_sender_is_the_agent_id,
    ):
        scenario()
        print()

    if FAILURES:
        print(f"FAILED: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all scenarios passed")
