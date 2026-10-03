"""One visible line for a hook failure that must not break the tool call.

SILENTOLLAMA926 (card 035e46d0): hooks swallow their own failures on purpose
(a hook that raises blocks the agent's tool call), but `except Exception:
pass` also swallows the evidence, and that is how an external dependency can
be missing for days with nothing anywhere saying so. report() appends one
timestamped line to <install>/store/hook-errors.log (HOOK_ERRLOG_PATH
overrides the path, for tests) and never raises itself.

Not a hook: a shared helper imported by hooks, like ledger_lib.
"""
import os
import time


def _default_path():
    install = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    return os.path.join(install, "store", "hook-errors.log")


def report(hook, message, exc=None):
    """Append `[hook] message ExcType: exc` with a local timestamp. Best effort."""
    try:
        path = os.environ.get("HOOK_ERRLOG_PATH") or _default_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        detail = ""
        if exc is not None:
            detail = " %s: %s" % (type(exc).__name__, str(exc)[:300])
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("%s [%s] %s%s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), hook, message, detail))
    except Exception:
        pass
