#!/usr/bin/env python3
"""
telegram_progress_watchdog.py — the "őrszem" (sentry) for the Telegram progress
indicator. Runs independently of the agent sessions (via launchd), so it can
speak even when an agent is wedged or down.

Problem it solves: the UserPromptSubmit hook posts a "✍️ Dolgozom rajta…"
placeholder; the Stop hook deletes it when the turn ends. If a turn never ends
(agent crashed, session killed, wedged), the placeholder would sit there
forever and the user is left wondering "is it working or broken?". This watchdog
detects those orphans and rewrites the placeholder into a CLEAR error message,
so the user always gets an unambiguous signal.

Detection (per pending placeholder, identified by its session state file):
  - agent process DOWN (its tmux `agent-<name>` session is gone) and the
    placeholder is older than DOWN_GRACE_SEC  -> error (covers crash / not
    reachable, with a short grace so a fleet restart isn't flagged), or
  - agent UP but the placeholder is older than WEDGED_SEC -> error (covers a
    genuinely stuck turn; generous so long legit tasks aren't killed).

On error it edits the existing placeholder message (editMessageText) into the
error text and removes the state file so it fires once.

Standalone: scans every agent's per-agent telegram state dir. No marveen src
dependency; only Python stdlib + the `tmux` binary.
"""
import os, glob, json, time, subprocess, urllib.request

# State dirs to scan: per-agent dirs under the fleet, plus the default dir.
# No hardcoded user paths — derive from $HOME (override with MARVEEN_ROOT).
FLEET_ROOT = os.environ.get("MARVEEN_ROOT") or os.path.expanduser("~/marveen")
SCAN_GLOBS = [
    os.path.join(FLEET_ROOT, "agents", "*", ".claude", "channels", "telegram", "progress"),
    os.path.expanduser("~/.claude/channels/telegram/progress"),
]
DOWN_GRACE_SEC = 120        # agent down + placeholder older than this -> error
WEDGED_SEC = 15 * 60        # agent up but placeholder this old -> error
ERROR_TEXT = ("⚠️ Valami elakadt, és erre nem érkezett válasz. "
              "Lehet, hogy újra kell indítani az ügynököt, vagy próbáld újra kicsit később.")


def token(state_dir):
    try:
        for line in open(os.path.join(state_dir, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def agent_name_from(progress_dir):
    # .../agents/<name>/.claude/channels/telegram/progress  -> <name>
    parts = progress_dir.split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def tmux_session_alive(session):
    try:
        return subprocess.run(["tmux", "has-session", "-t", session],
                              capture_output=True, timeout=5).returncode == 0
    except Exception:
        return True  # if tmux probe fails, assume alive (don't false-alarm)


def log(progress_dir, msg):
    try:
        with open(os.path.join(progress_dir, "debug.log"), "a", encoding="utf-8") as f:
            f.write(f"[watchdog {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def handle_dir(progress_dir):
    state_dir = os.path.dirname(progress_dir)           # .../telegram
    name = agent_name_from(progress_dir)
    agent_up = tmux_session_alive(f"agent-{name}") if name else True
    now = time.time()
    # Sweep orphan dedup markers (normally removed by the Stop hook).
    for m in glob.glob(os.path.join(progress_dir, "seen-*.marker")):
        try:
            if now - os.path.getmtime(m) > 3600:
                os.remove(m)
        except Exception:
            pass
    tok = None
    for path in glob.glob(os.path.join(progress_dir, "*.json")):
        try:
            age = now - os.path.getmtime(path)
        except Exception:
            continue
        # Decide if this is an orphan needing an error.
        orphan = (not agent_up and age > DOWN_GRACE_SEC) or (age > WEDGED_SEC)
        if not orphan:
            continue
        try:
            pend = json.load(open(path))
        except Exception:
            pend = []
        if tok is None:
            tok = token(state_dir)
        for p in pend:
            if not tok:
                break
            try:
                api(tok, "editMessageText", {
                    "chat_id": p["chat_id"], "message_id": p["message_id"],
                    "text": ERROR_TEXT,
                })
            except Exception as e:
                log(progress_dir, f"edit failed (mid={p.get('message_id')}): {e}")
        try:
            os.remove(path)
            log(progress_dir, f"orphan handled: {os.path.basename(path)} "
                              f"agent_up={agent_up} age={int(age)}s")
        except Exception:
            pass


def main():
    dirs = []
    for g in SCAN_GLOBS:
        dirs.extend(glob.glob(g))
    for d in dirs:
        if os.path.isdir(d):
            handle_dir(d)


if __name__ == "__main__":
    main()
