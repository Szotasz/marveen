#!/usr/bin/env python3
"""
Stop hook — removes the Telegram "✍️ Dolgozom rajta…" placeholder(s) that the
UserPromptSubmit hook (telegram_progress.py) posted for this session, once the
turn finishes. Every turn ends with Stop, so the placeholder can never get
stuck under normal operation; a crashed/wedged turn (no Stop) is the only orphan
case, which the separate watchdog cleans up.

Silent on stdout. Token/state dir resolution mirrors the plugin (TELEGRAM_STATE_DIR
else default).
"""
import sys, os, json, glob, urllib.request


def state_dir():
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    return os.path.expanduser("~/.claude/channels/telegram")


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
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
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        ev = {}
    sid = ev.get("session_id") or "default"
    sd = state_dir()
    # Clean up this session's dedup markers (created by telegram_progress.py).
    for m in glob.glob(os.path.join(sd, "progress", f"seen-{sid}-*.marker")):
        try:
            os.remove(m)
        except Exception:
            pass
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return  # nothing pending
    tok = token(sd)
    if tok:
        for p in pend:
            try:
                api(tok, "deleteMessage",
                    {"chat_id": p["chat_id"], "message_id": p["message_id"]})
            except Exception as e:
                log(sd, f"[stop] delete failed: {e}")
    try:
        os.remove(path)
        log(sd, f"[stop] cleared {len(pend)} placeholder(s) sid={sid}")
    except Exception:
        pass


if __name__ == "__main__":
    main()
