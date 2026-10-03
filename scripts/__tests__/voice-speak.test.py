#!/usr/bin/env python3
"""speak() behaviour with piper, ffmpeg and sendVoice stubbed out.

Pins three things a source match could not:
- the text piped into piper has been through the pronunciation map;
- the ffmpeg filter chain carries the tail silence pad (and keeps the pitch
  filter in front of it when VOICE_PITCH is set);
- a successful send writes an outbound row to the conversation ledger under the
  right agent id, and a failed send writes none.

Runs the module twice: from the source tree, and as a copy OUTSIDE the install
tree (how the installed toolkit runs live), where the install, the ledger and
the lexicon must be found from the channel state_dir.

No audio, no network, no token. Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(INSTALL, "scripts", "voice", "_vtools.py")

tmp = tempfile.mkdtemp(prefix="voice-speak-test-")
os.environ["LEDGER_DB_PATH"] = os.path.join(tmp, "ledger.db")
os.environ["MAIN_AGENT_ID"] = "mainagent"
os.environ.pop("MARVEEN_INSTALL_DIR", None)
os.environ.pop("VOICE_PITCH", None)
os.environ.pop("VOICE_TAIL_PAD_S", None)

fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else " -- " + detail))
    if not ok:
        fails += 1


def load(path, modname):
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Stub:
    def __init__(self, mod, send_ok=True, message_id=4242):
        self.calls = []
        self.mod = mod
        mod._token = lambda state_dir: "TOKEN"
        mod._post_voice = lambda token, chat_id, ogg: (
            {"ok": True, "result": {"message_id": message_id}} if send_ok else {"ok": False}
        )
        stub = self

        class _Sub:
            @staticmethod
            def run(args, input=None, check=False, **kw):
                stub.calls.append((list(args), input))

        self._orig = mod.subprocess
        mod.subprocess = _Sub

    def piper_input(self):
        for args, inp in self.calls:
            if "piper" in args:
                return (inp or b"").decode()
        return None

    def ffmpeg_filter(self):
        for args, _ in self.calls:
            if args and args[0] == "ffmpeg":
                return args[args.index("-af") + 1] if "-af" in args else ""
        return None


def ledger_rows():
    if not os.path.exists(os.environ["LEDGER_DB_PATH"]):
        return []
    con = sqlite3.connect(os.environ["LEDGER_DB_PATH"])
    try:
        return con.execute(
            "SELECT agent_id, chat_id, direction, message_id, text FROM conversation_log ORDER BY rowid"
        ).fetchall()
    finally:
        con.close()


def reset_ledger():
    try:
        os.unlink(os.environ["LEDGER_DB_PATH"])
    except OSError:
        pass


SUB_STATE = os.path.join(INSTALL, "agents", "dex", ".claude", "channels", "telegram")
MAIN_STATE = os.path.join(INSTALL, ".claude", "channels", "telegram")

# Installed-layout copy: _vtools.py alone in a directory outside the install
# tree, with no lexicon next to it.
installed_dir = os.path.join(tmp, "marveen-voice")
os.makedirs(installed_dir)
shutil.copy(SRC, os.path.join(installed_dir, "_vtools.py"))

for label, path in (("source tree", SRC), ("installed copy", os.path.join(installed_dir, "_vtools.py"))):
    v = load(path, "_vtools_" + label.replace(" ", "_"))

    # 1) sub-agent, successful send
    reset_ledger()
    s = Stub(v)
    v.speak("/voices/x.onnx", SUB_STATE, 12345, "A Mondayben van a meeting.")
    check(f"[{label}] piper gets the pronunciation-mapped text",
          s.piper_input() == "A mandéjben van a míting.", repr(s.piper_input()))
    f = s.ffmpeg_filter() or ""
    check(f"[{label}] ffmpeg pads the tail with silence", "apad=pad_dur=0.5" in f, repr(f))
    rows = ledger_rows()
    check(f"[{label}] one outbound ledger row for the sub-agent",
          len(rows) == 1 and rows[0][0] == "dex" and rows[0][1] == "12345"
          and rows[0][2] == "out" and rows[0][3] == "4242"
          and rows[0][4].endswith("A Mondayben van a meeting."), repr(rows))

    # 2) main agent state_dir -> main agent id
    reset_ledger()
    Stub(v)
    v.speak("/voices/x.onnx", MAIN_STATE, 777, "Szia")
    rows = ledger_rows()
    check(f"[{label}] main-agent state_dir logs under MAIN_AGENT_ID",
          len(rows) == 1 and rows[0][0] == "mainagent", repr(rows))

    # 3) failed send -> no row
    reset_ledger()
    Stub(v, send_ok=False)
    v.speak("/voices/x.onnx", SUB_STATE, 12345, "Szia")
    check(f"[{label}] failed send writes no ledger row", ledger_rows() == [], repr(ledger_rows()))

    # 4) pitch filter stays in front of the pad
    os.environ["VOICE_PITCH"] = "0.9"
    s = Stub(v)
    v.speak("/voices/x.onnx", SUB_STATE, 12345, "Szia")
    f = s.ffmpeg_filter() or ""
    check(f"[{label}] pitch filter then pad",
          f == "asetrate=22050*0.9,aresample=22050,apad=pad_dur=0.5", repr(f))
    os.environ.pop("VOICE_PITCH", None)

    # 5) a ledger that cannot be written never fails an already-sent voice
    os.environ["LEDGER_DB_PATH"] = os.path.join(tmp, "no-such-dir", "ledger.db")
    Stub(v)
    try:
        v.speak("/voices/x.onnx", SUB_STATE, 12345, "Szia")
        ok = True
    except Exception as e:  # noqa: BLE001
        ok, err = False, repr(e)
    check(f"[{label}] ledger failure does not raise", ok, "" if ok else err)
    os.environ["LEDGER_DB_PATH"] = os.path.join(tmp, "ledger.db")

shutil.rmtree(tmp, ignore_errors=True)
print("All tests passed." if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
