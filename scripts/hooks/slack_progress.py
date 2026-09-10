#!/usr/bin/env python3
"""
UserPromptSubmit hook — Slack "processing" indicator.

Slack's modern Web API (chat.postMessage) has no bot "typing…" bubble — that
only ever existed on the legacy RTM API (a `type: typing` websocket frame),
which new Slack apps have not been allowed to use for years. So the only
honest option is the same pattern already used for Telegram
(docs/telegram-progress-indicator.md): post a visible placeholder message the
instant the turn starts, then either clear it (reply sent) or rewrite it into
an error (turn never finished).

When an inbound Slack channel message is delivered to the agent, this posts a
"✍️ Dolgozom rajta…" placeholder via chat.postMessage (in the same thread as
the inbound message, if any) and records its `ts` so the PostToolUse/Stop
hooks can clear it when the turn ends.

MUST stay silent on stdout — stdout from UserPromptSubmit is injected into the
model prompt. All diagnostics go to a debug log file under the state dir.

Token/state dir resolution mirrors the Slack plugin: honor SLACK_STATE_DIR
(set per-agent), else the install-scoped dir (#915), else the legacy shared
~/.claude/channels/slack. This keeps the hook correct even if installed
globally across agents with different bots.
"""
import sys, os, json, re, urllib.request

# Same wording as the Telegram placeholder, per install language.
TEXTS = {
    "hu": {"placeholder": "✍️ Dolgozom rajta…"},
    "en": {"placeholder": "✍️ Working on it…"},
}


def lang(sd):
    """Install language: MARVEEN_LANG env, else the install's `.lang` file
    (written by install.sh at the install root; found by walking up from the
    state dir, which is <root>/.claude/channels/slack or
    <root>/agents/<name>/.claude/channels/slack), else hu (the repo default)."""
    v = (os.environ.get("MARVEEN_LANG") or "").strip().lower()
    if v in TEXTS:
        return v
    d = os.path.abspath(sd)
    for _ in range(6):
        try:
            v = open(os.path.join(d, ".lang"), encoding="utf-8").read().strip().lower()
            if v in TEXTS:
                return v
        except Exception:
            pass
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return "hu"


def state_dir():
    # #915: env override, then the install-scoped dir once it holds the .env,
    # then the legacy shared path (unmigrated installs only).
    d = os.environ.get("SLACK_STATE_DIR")
    if d:
        return d
    _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _inst = os.path.join(_root, ".claude", "channels", "slack")
    if os.path.isfile(os.path.join(_inst, ".env")):
        return _inst
    return os.path.expanduser("~/.claude/channels/slack")


def api_base():
    return os.environ.get("SLACK_API_BASE", "https://slack.com/api").rstrip("/")


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
            if line.startswith("SLACK_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"{api_base()}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {tok}",
    })
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def claim(progress_dir, sid, src_ts):
    """Atomic per-inbound-message guard, mirrors telegram_progress.py. Returns
    True if THIS invocation claimed the message (proceed), False if another
    already did (skip). O_EXCL makes the claim race-safe."""
    if not src_ts:
        return True
    try:
        os.makedirs(progress_dir, exist_ok=True)
        marker = os.path.join(progress_dir, f"seen-{sid}-{src_ts}.marker")
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except Exception:
        return True  # never let the guard block the indicator


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        return
    prompt = ev.get("prompt") or ""
    sid = ev.get("session_id") or "default"
    transcript_path = ev.get("transcript_path") or ""
    sd = state_dir()

    # The live tag is <channel source="plugin:slack-channel:slack" ...>; the
    # loose "slack" match also covers a coordinator-style source="slack".
    blocks = re.findall(r'<channel\b[^>]*\bsource="[^"]*slack[^"]*"[^>]*>', prompt)
    if not blocks:
        return  # not a Slack turn — stay silent
    log(sd, f"[submit] sid={sid} blocks={len(blocks)} state_dir={sd}")

    tok = token(sd)
    if not tok:
        log(sd, "[submit] no token found")
        return
    placeholder = TEXTS[lang(sd)]["placeholder"]

    pending = []
    for b in blocks:
        cid = re.search(r'\bchat_id="([^"]+)"', b)
        thread = re.search(r'\bthread_ts="([^"]+)"', b)
        src_ts = re.search(r'\bts="([^"]+)"', b)
        if not cid:
            continue
        chat_id = cid.group(1)
        thread_ts = thread.group(1) if thread else None
        src = src_ts.group(1) if src_ts else None
        # Dedup: skip if a sibling invocation already handled this inbound msg.
        if not claim(os.path.join(sd, "progress"), sid, src):
            log(sd, f"[submit] dedup skip src={src}")
            continue
        payload = {"channel": chat_id, "text": placeholder}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        try:
            resp = api(tok, "chat.postMessage", payload)
            if not resp.get("ok"):
                log(sd, f"[submit] placeholder rejected: {resp.get('error')}")
                continue
            pts = resp.get("ts")
            if pts:
                entry = {"chat_id": chat_id, "ts": pts}
                if thread_ts:
                    entry["thread_ts"] = thread_ts
                if transcript_path:
                    entry["transcript_path"] = transcript_path
                pending.append(entry)
        except Exception as e:
            log(sd, f"[submit] placeholder failed: {e}")

    if pending:
        path = os.path.join(sd, "progress", f"{sid}.json")
        old = []
        try:
            old = json.load(open(path))
        except Exception:
            old = []
        try:
            json.dump(old + pending, open(path, "w"))
            log(sd, f"[submit] stored {len(pending)} placeholder(s)")
        except Exception as e:
            log(sd, f"[submit] store failed: {e}")


if __name__ == "__main__":
    main()
