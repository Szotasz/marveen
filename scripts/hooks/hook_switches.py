"""Shared runtime switches for Marveen's own Python hooks (HOOKDRIFT926).

Not a hook itself: a small library a hook script calls as its first step.

Two switches, both read from the hook process environment (which Claude Code
inherits from the session that launched it, or from the "env" block of
settings.json):

  MARVEEN_DISABLED_HOOKS=tool-log-capture
      Comma/space separated hook NAMES (the script file stem, the "hook" field
      of .claude/hooks.metadata.json). A listed hook exits 0 before reading
      its input. Locked names (DEFAULT_NON_DISABLEABLE below, plus the
      sidecar's "non_disableable" list) are IGNORED here, whatever the env
      says: an env var is exactly what a prompt injection or a careless
      "export" can set, so it must never be able to switch off a gate that
      stands between the agent and the outside world. If the sidecar exists
      but its lock list cannot be read, EVERY hook counts as locked (fail
      safe): none is disableable, and oversize input fails closed.

  MARVEEN_HOOK_INPUT_MAX_BYTES=<int>
      Upper bound on the stdin payload a hook will read (default 8 MiB).
      Over the cap the direction depends on what the hook is:
        - a locked hook (gate / audit ledger) fails CLOSED: exit 2
          with a stderr reason, which blocks a PreToolUse call and surfaces
          the reason to the model on the other events;
        - any other hook (pure logging) fails OPEN: the caller gets None and
          should exit 0 without doing anything.

Every hook that imports this must keep working if the import fails (catch the
ImportError and fall back to its previous behaviour): the switches are an
operational convenience, never a new way for a hook to break a session.
"""
import json
import os
import sys

DISABLE_ENV = "MARVEEN_DISABLED_HOOKS"
MAX_BYTES_ENV = "MARVEEN_HOOK_INPUT_MAX_BYTES"
DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024

# Hooks that no env var may disable, and whose oversize input fails closed.
# Rule: every hook that can BLOCK a tool call or gate outward-facing content /
# approvals / fleet state. This is the built-in floor shipped with the repo;
# an installation adds its OWN gates and audit ledgers through the sidecar
# (.claude/hooks.metadata.json, top-level "non_disableable": [names]), never
# by editing this list. The sidecar can only ADD names: nothing in data can
# unlock a name listed here. scripts/hook-metadata.py cross-checks the
# effective list against the "gate" flag of every sidecar entry and flags any
# wired *-gate / *-guard that is not locked.
DEFAULT_NON_DISABLEABLE = frozenset({
    # outgoing content and approvals
    "outgoing-copy-gate",       # outgoing text rules (mail, channel reply)
    "email-approval-gate",      # level-aware email approval (main agent)
    "email-send-gate",          # sub-agent email gate + verified-recipient ledger
    "second-reviewer-gate",
    # egress, provenance, credentials, destructive commands
    "egress-gate",
    "provenance-gate",
    "digest-provenance-gate",
    "credential-gate",
    "destructive-gate",
    "secret-gate",
    "sender-role-gate",
    # state integrity
    "memory-frontmatter-gate",
    "memory-frontmatter-bash-gate",  # the Bash twin of the gate above
    "kanban-write-gate",
    "fleet-memory-gate",
    "self-pace-gate",
    "staleness-guard",
    # reply enforcement and channel ownership
    "telegram-reply-guard",
    "channel-reply-guard",
    "channel-process-gate",
    "child-claude-channel-guard",
    # fleet control (KILLSWITCH1022): the red button must not be env-disabled
    "fleet-freeze-gate",
})
# Backwards-compatible name for the built-in floor.
NON_DISABLEABLE = DEFAULT_NON_DISABLEABLE

SIDECAR_LOCK_KEY = "non_disableable"
# The sidecar next to the settings this checkout ships. Deliberately NOT
# overridable from the environment: an env var that could point the lookup
# at an empty file would be an env switch for the install's own gates.
DEFAULT_METADATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".claude", "hooks.metadata.json")

_EXTENSIONS = (".py", ".mjs", ".cjs", ".js", ".sh", ".ts")


def normalize(name):
    """Hook name as used in the env list: basename, no extension, lower-case."""
    name = os.path.basename(str(name or "").strip()).lower()
    for ext in _EXTENSIONS:
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def sidecar_locks(metadata_path=None):
    """(extra locked names from the sidecar, ok).

    ok=False means the sidecar exists but its lock list could not be read
    (unreadable file, bad JSON, wrong type). Callers treat that as "the
    install's own lock list is unknown" and refuse every env disable, see
    is_disabled(). A missing sidecar is ok=True with no extra names.
    """
    path = metadata_path or DEFAULT_METADATA_PATH
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return frozenset(), True
    except (OSError, ValueError):
        return frozenset(), False
    return parse_locks(data)


def parse_locks(data):
    """(extra locked names, ok) from an already-parsed sidecar object."""
    if not isinstance(data, dict):
        return frozenset(), False
    raw = data.get(SIDECAR_LOCK_KEY, [])
    if not isinstance(raw, list) or not all(isinstance(x, str) and x.strip() for x in raw):
        return frozenset(), False
    return frozenset(normalize(x) for x in raw), True


_CACHE = {}


def _locks(metadata_path=None):
    key = metadata_path or DEFAULT_METADATA_PATH
    if key not in _CACHE:
        _CACHE[key] = sidecar_locks(key)
    return _CACHE[key]


def locked_names(metadata_path=None):
    """Effective lock list: the built-in floor plus the sidecar's additions."""
    extra, _ = _locks(metadata_path)
    return DEFAULT_NON_DISABLEABLE | extra


def is_locked(name, metadata_path=None):
    """True when the hook is a gate that no env switch may touch.

    With a broken sidecar every hook counts as locked: we cannot tell which
    of the install's own hooks are gates, so all of them get the gate
    treatment (no env disable, oversize input fails closed) until it is fixed.
    """
    _, ok = _locks(metadata_path)
    return not ok or normalize(name) in locked_names(metadata_path)


def disabled_hooks(env=None):
    env = os.environ if env is None else env
    raw = env.get(DISABLE_ENV, "") or ""
    parts = raw.replace(";", ",").replace(" ", ",").split(",")
    return {normalize(p) for p in parts if p.strip()}


def is_disabled(name, env=None, metadata_path=None):
    n = normalize(name)
    if not n or is_locked(n, metadata_path):
        return False
    return n in disabled_hooks(env)


def max_input_bytes(env=None):
    env = os.environ if env is None else env
    raw = (env.get(MAX_BYTES_ENV) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_INPUT_BYTES
    return value if value > 0 else DEFAULT_MAX_INPUT_BYTES


def read_hook_stdin(name, stream=None, env=None, metadata_path=None):
    """Read the hook payload with the size cap applied.

    Returns the decoded text, or None when a fail-open hook got an oversize
    payload. A locked (gate) hook with an oversize payload does not return:
    it exits 2 with the reason on stderr.
    """
    if stream is None:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
    limit = max_input_bytes(env)
    data = stream.read(limit + 1)
    if isinstance(data, str):
        data = data.encode("utf-8", "surrogateescape")
    if len(data) > limit:
        if is_locked(name, metadata_path):
            sys.stderr.write(
                "%s: hook input exceeds %s=%d bytes; gate fails closed\n"
                % (normalize(name), MAX_BYTES_ENV, limit))
            sys.exit(2)
        return None
    return data.decode("utf-8", "replace")
