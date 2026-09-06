#!/usr/bin/env python3
"""
UserPromptSubmit hook -- fleet-wide, zero-token "/usage" command.

Intercepts an inbound Telegram message whose entire body is "/usage"
(case-insensitive), replies with the account's current Claude quota status --
5-hour, weekly, and Fable/Opus-weekly windows, with reset times -- straight
from scripts/usage-collect.py, and blocks the prompt from ever reaching the
model. The round trip costs zero model tokens: the owner is checking how much
quota is left, so the check itself must not spend any.

Every other message passes through untouched: exit 0, no stdout, fast.

MUST stay silent on stdout for the pass-through path -- stdout from a
UserPromptSubmit hook that exits 0 is injected into the model's context (see
telegram_progress.py, same convention). To actually BLOCK the turn on a
match this exits 2 with empty stdout/stderr: a `{"decision": "block", ...}`
JSON does NOT block UserPromptSubmit, it only gets injected as context same
as any other exit-0 stdout -- only exit code 2 stops the prompt from ever
reaching the model. Verified against live Claude Code hook behaviour,
2026-07-29.

Only fires when the prompt carries EXACTLY ONE <channel> block whose own body
is "/usage" -- a batched/grouped message (several queued texts in one prompt)
is left alone and goes to the model as normal, so a "/usage" sent alongside
other content is never silently swallowed.

The <channel ... chat_id="..."> envelope is NOT Telegram-specific (other
channel plugins use the same shape, per prompt-safety.ts), so this also checks
the `source` attribute contains "telegram" before doing anything. Without that
check a non-Telegram channel carrying a chat_id would still match, the reply
would go to the Telegram Bot API with a foreign chat id (fails), and the
prompt would still be swallowed by the exit-2 block -- the owner gets nothing
and the model never even sees the request. (Found in review, 2026-07-29.)

Design decision: if scripts/usage-collect.py itself fails, this still replies
(with a short generic error, see below) and still exits 2 -- a failed quota
check still counts as "handled", the model is not woken up just to relay a
subprocess error it cannot do anything about.
"""
import sys
import os
import re
import json
import subprocess
import time

# Derived from this file's own location (scripts/hooks/ -> repo root), never a
# shipped absolute path: on any install but the author's, a hardcoded root
# would make the hook miss the repo, and it would fail the WORST way -- the
# chat gets the generic error while the hook still exits 2, so the owner is
# told "it did not work" and nothing says a path is simply missing.
# CLAUDE_PROJECT_DIR (set by Claude Code for hooks) wins when present, so an
# install that runs the hook from outside the checkout can still point at it.
REPO_ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
USAGE_SCRIPT = os.path.join(REPO_ROOT, "scripts", "usage-collect.py")

CHANNEL_RX = re.compile(r'<channel\s+([^>]*)>(.*?)</channel>', re.DOTALL)
USAGE_RX = re.compile(r'^/usage\s*$', re.IGNORECASE)
TELEGRAM_SOURCE_RX = re.compile(r'\bsource="[^"]*telegram[^"]*"', re.IGNORECASE)

WINDOW_LABELS = [
    ("five_hour", "5 orás"),
    ("seven_day", "heti"),
    ("seven_day_opus", "Fable/Opus heti"),
    ("seven_day_sonnet", "Sonnet heti"),
]

GENERIC_ERROR_REPLY = "Nem sikerult lekerdezni a keret-allapotot (a lekerdezo script hibara futott). Nezd meg a naplot: progress/usage-hook.log"
MISSING_SCRIPT_REPLY = "Nem sikerult lekerdezni a keret-allapotot: a lekerdezo script nincs meg ezen a telepitesen (scripts/usage-collect.py). Nezd meg a naplot: progress/usage-hook.log"


def state_dir():
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    return os.path.expanduser("~/.claude/channels/telegram")


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "usage-hook.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    import urllib.request
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def fmt_reset(ts):
    if not ts:
        return "ismeretlen"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(ts)))
    except Exception:
        return "ismeretlen"


def format_usage(snapshot):
    c = snapshot.get("claude") or {}
    if not c.get("ok"):
        return f"Nem sikerult lekerni a Claude keret-allapotot (forras: {c.get('source', 'ismeretlen')})."
    w = c.get("windows") or {}
    lines = ["Claude keret-allapot:"]
    for key, label in WINDOW_LABELS:
        win = w.get(key)
        if not win or win.get("used_percent") is None:
            continue
        used = win["used_percent"]
        remaining = 100 - used
        lines.append(
            f"- {label}: {remaining:.0f}% van hatra ({used:.0f}% elhasznalva), "
            f"megujul: {fmt_reset(win.get('resets_at'))}"
        )
    if len(lines) == 1:
        lines.append("(nincs elerheto adat)")
    return "\n".join(lines)


def clear_stray_placeholder(sd, tok, sid):
    """Defensive cleanup for telegram_progress.py's "Dolgozom rajta..." placeholder.

    That UserPromptSubmit hook (not currently registered anywhere on this
    install, but ships with the product and could be later) posts a
    placeholder for the SAME event this hook blocks. If it ran first in the
    hook chain, its Stop-hook cleanup never fires (the turn never reaches
    Stop), so the placeholder would sit in the chat forever. This mirrors
    telegram_progress_clear.py's own cleanup: read progress/<sid>.json,
    delete anything listed, then remove the file.
    """
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pending = json.load(open(path, encoding="utf-8"))
    except Exception:
        return
    for p in pending or []:
        cid, mid = p.get("chat_id"), p.get("message_id")
        if not cid or not mid:
            continue
        try:
            api(tok, "deleteMessage", {"chat_id": cid, "message_id": mid})
        except Exception as e:
            log(sd, f"stray placeholder cleanup failed: {type(e).__name__}")
    try:
        os.remove(path)
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    prompt = payload.get("prompt") or ""
    sid = payload.get("session_id") or "unknown"

    matches = list(CHANNEL_RX.finditer(prompt))
    if len(matches) != 1:
        sys.exit(0)
    m = matches[0]
    attrs, body = m.group(1), m.group(2)
    if not USAGE_RX.match(body.strip()):
        sys.exit(0)
    if not TELEGRAM_SOURCE_RX.search(attrs):
        sys.exit(0)

    chat_id = attr(attrs, "chat_id")
    if not chat_id:
        sys.exit(0)

    sd = state_dir()
    tok = token(sd)
    if not tok:
        log(sd, "no bot token found, letting the prompt through")
        sys.exit(0)

    if not os.path.isfile(USAGE_SCRIPT):
        # Named separately from the generic failure: a missing path is the one
        # cause the owner can actually act on, and the old wording hid it.
        log(sd, f"usage-collect.py not found at {USAGE_SCRIPT}")
        try:
            api(tok, "sendMessage", {"chat_id": chat_id, "text": MISSING_SCRIPT_REPLY})
        except Exception as e:
            log(sd, f"sendMessage failed: {type(e).__name__}")
        clear_stray_placeholder(sd, tok, sid)
        sys.exit(2)

    try:
        out = subprocess.run(
            ["python3", USAGE_SCRIPT, "--json"],
            capture_output=True, text=True, timeout=20,
        ).stdout
        snapshot = json.loads(out)
        reply = format_usage(snapshot)
    except Exception as e:
        # Never interpolate the raw exception into a log line or a chat reply:
        # a urllib HTTPError/URLError string can carry the request URL, and
        # the request URL to the Telegram Bot API contains the bot token.
        # Exception TYPE only, generic fixed text to the chat.
        reply = GENERIC_ERROR_REPLY
        log(sd, f"usage-collect failed: {type(e).__name__}")

    try:
        api(tok, "sendMessage", {"chat_id": chat_id, "text": reply})
    except Exception as e:
        log(sd, f"sendMessage failed: {type(e).__name__}")

    clear_stray_placeholder(sd, tok, sid)

    log(sd, f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] /usage answered chat={chat_id} sid={sid}")
    sys.exit(2)  # block: the model never sees this turn


if __name__ == "__main__":
    main()
