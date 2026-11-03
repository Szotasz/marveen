#!/usr/bin/env python3
"""speak() behaviour with piper, ffmpeg and sendVoice stubbed out.

Pins three things a source match could not:
- the text piped into piper has been through the pronunciation map;
- the ffmpeg filter chain carries the tail silence pad (and keeps the pitch
  filter in front of it when VOICE_PITCH is set);
- the optional VOICE_LENGTH_SCALE / VOICE_SENTENCE_SILENCE / VOICE_NOISE_SCALE /
  VOICE_NOISE_W_SCALE knobs add Piper flags only when set and valid (unset = the
  exact argv as before; invalid = skipped with a stderr warning, never raises);
- a successful send writes an outbound row to the conversation ledger under the
  right agent id, and a failed send writes none.

Runs the module twice: from the source tree, and as a copy OUTSIDE the install
tree (how the installed toolkit runs live), where the install, the ledger and
the lexicon must be found from the channel state_dir.

No audio, no network, no token. Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import io
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
PROSODY_VARS = ("VOICE_LENGTH_SCALE", "VOICE_SENTENCE_SILENCE", "VOICE_NOISE_SCALE", "VOICE_NOISE_W_SCALE")
PROSODY_FLAGS = ("--length-scale", "--sentence-silence", "--noise-scale", "--noise-w-scale")
for _n in PROSODY_VARS:
    os.environ.pop(_n, None)

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

    def piper_args(self):
        for args, _ in self.calls:
            if "piper" in args:
                return list(args)
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

    def run_prosody(env):
        old_err, sys.stderr = sys.stderr, io.StringIO()
        err, raised, s = "", None, None
        try:
            for k, val in env.items():
                os.environ[k] = val
            s = Stub(v)
            v.speak("/voices/x.onnx", SUB_STATE, 12345, "Szia")
        except Exception as e:  # noqa: BLE001
            raised = repr(e)
        finally:
            err, sys.stderr = sys.stderr.getvalue(), old_err
            for k in env:
                os.environ.pop(k, None)
        return (s.piper_args() if s else None), err, raised

    # 6) all unset -> argv exactly as before
    a, _, _ = run_prosody({})
    check(f"[{label}] unset knobs leave the piper argv unchanged",
          a is not None and len(a) == 7 and a[6].endswith(".wav")
          and a[:6] == [v.VENV_PY, "-m", "piper", "-m", "/voices/x.onnx", "-f"]
          and not any(f in a for f in PROSODY_FLAGS), repr(a))

    # 6b) blank values behave like unset, silently
    a, err, _ = run_prosody({"VOICE_LENGTH_SCALE": "", "VOICE_SENTENCE_SILENCE": "  ",
                             "VOICE_NOISE_SCALE": "\t", "VOICE_NOISE_W_SCALE": ""})
    check(f"[{label}] blank knobs add no flags and no warning",
          a is not None and len(a) == 7 and not any(f in a for f in PROSODY_FLAGS) and err == "",
          repr((a, err)))

    # 7) all four valid, inserted in reverse so the fixed order is what is tested
    a, _, _ = run_prosody({"VOICE_NOISE_W_SCALE": "0.8", "VOICE_NOISE_SCALE": "0.667",
                           "VOICE_SENTENCE_SILENCE": "0.5", "VOICE_LENGTH_SCALE": "1.22"})
    check(f"[{label}] all four knobs become flags in order",
          a is not None and a[-8:] == ["--length-scale", "1.22", "--sentence-silence", "0.5",
                     "--noise-scale", "0.667", "--noise-w-scale", "0.8"], repr(a))

    # 8) strip, keep spelling
    a, _, _ = run_prosody({"VOICE_LENGTH_SCALE": "  1.10 "})
    check(f"[{label}] value is stripped, spelling kept", a is not None and a[-2:] == ["--length-scale", "1.10"], repr(a))
    # a length scale below 1 (faster speech) is just as valid as one above it
    a, _, _ = run_prosody({"VOICE_LENGTH_SCALE": "0.85"})
    check(f"[{label}] a length scale below 1 is valid", a is not None and a[-2:] == ["--length-scale", "0.85"], repr(a))

    # 9) invalid values skipped, never raise
    for bad in ("abc", "0", "-1", "-0e0", "-0.", "nan", "inf", ""):
        a, err, raised = run_prosody({"VOICE_LENGTH_SCALE": bad})
        check(f"[{label}] invalid VOICE_LENGTH_SCALE={bad!r} is skipped without raising",
              raised is None and a is not None and "--length-scale" not in a, repr((a, raised)))
        if bad:
            check(f"[{label}] invalid VOICE_LENGTH_SCALE={bad!r} warns on stderr",
                  len(err.splitlines()) == 1 and err.endswith("\n")
                  and "ignoring VOICE_LENGTH_SCALE=" in err, repr(err))
        else:
            check(f"[{label}] empty VOICE_LENGTH_SCALE is silent", err == "", repr(err))

    # 10) zero valid for non-negative knobs
    a, _, _ = run_prosody({"VOICE_SENTENCE_SILENCE": "0"})
    check(f"[{label}] zero sentence silence is valid", a is not None and a[-2:] == ["--sentence-silence", "0"], repr(a))

    # 11) one invalid knob keeps the valid ones
    a, _, _ = run_prosody({"VOICE_LENGTH_SCALE": "abc", "VOICE_NOISE_SCALE": "0.5"})
    check(f"[{label}] invalid knob does not drop valid ones",
          a is not None and "--length-scale" not in a and a[-2:] == ["--noise-scale", "0.5"], repr(a))

    # 12) the non-negative knobs refuse negatives and nan too
    for name, flag in zip(PROSODY_VARS[1:], PROSODY_FLAGS[1:]):
        for bad in ("-1", "-0e0", "-0.", "-0_0", "nan"):
            a, err, raised = run_prosody({name: bad})
            check(f"[{label}] invalid {name}={bad!r} is skipped with one warning line",
                  raised is None and a is not None and flag not in a
                  and len(err.splitlines()) == 1 and err.endswith("\n")
                  and f"ignoring {name}=" in err, repr((a, err, raised)))

# helper reads the mapping it is given, not os.environ
helper = getattr(load(SRC, "_vtools_helper"), "_piper_prosody_args", None)
check("helper: _piper_prosody_args exists", callable(helper))
if callable(helper):
    check("helper: empty mapping gives no args", helper({}) == [])
    check("helper: reads the given mapping",
          helper({"VOICE_NOISE_W_SCALE": "0.3"}) == ["--noise-w-scale", "0.3"])
    _old_err, sys.stderr = sys.stderr, io.StringIO()
    try:
        neg_zero = helper({"VOICE_NOISE_SCALE": "-0e0"})
    except Exception as e:  # noqa: BLE001
        neg_zero = "raised " + repr(e)
    finally:
        sys.stderr = _old_err
    check("helper: negative-zero spelling is refused", neg_zero == [], repr(neg_zero))

    # a stderr that cannot be written (closed, or None in a detached run) must
    # not turn an invalid knob into a failed reply
    class _BrokenErr:
        def write(self, _s):
            raise ValueError("I/O operation on closed file")
    for bad_err in (_BrokenErr(), None):
        _old_err, sys.stderr = sys.stderr, bad_err
        try:
            broken = helper({"VOICE_NOISE_SCALE": "abc", "VOICE_SENTENCE_SILENCE": "0.4"})
        except Exception as e:  # noqa: BLE001
            broken = "raised " + repr(e)
        finally:
            sys.stderr = _old_err
        check(f"helper: stderr={type(bad_err).__name__} does not raise, valid knobs still apply",
              broken == ["--sentence-silence", "0.4"], repr(broken))

shutil.rmtree(tmp, ignore_errors=True)
print("All tests passed." if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
