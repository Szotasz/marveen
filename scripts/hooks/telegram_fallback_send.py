#!/usr/bin/env python3
"""
Telegram Bot API fallback SENDER (agent-invoked CLI, not a harness hook).

When the in-session Telegram MCP `reply` tool is dropped mid-turn ("MCP servers
have disconnected: plugin:telegram:telegram"), the agent must still reach the
user. The telegram-botapi-fallback skill used to `curl` sendMessage directly --
but a raw send does NOT clear the "✍️ Dolgozom rajta…" placeholder (only the
reply TOOL's PostToolUse hook does that). So the Stop hook, seeing a still-
pending placeholder, delivered the agent's final answer a SECOND time at turn
end -> the user got the message twice.

This helper closes that gap by making a manual fallback behave EXACTLY like the
reply tool: it sends the message AND then clears the placeholder for that chat
(deleteMessage + trim the session's pending list), mirroring
telegram_progress_reply_clear.py. With the placeholder gone, the Stop hook's
enforce path finds nothing pending -> no duplicate, no "you never replied" nudge,
no restart needed.

Usage:
    telegram_fallback_send.py <chat_id> <text> [--sid SID] [--state-dir DIR]

Exit code:
    0  message delivered (placeholder cleared best-effort)
    2  delivery FAILED (Bot API not ok / unreachable) -> caller should escalate
       (per the skill: fall through to email). Nothing was cleared.

Resolution mirrors the plugin/hooks: state dir from --state-dir else
TELEGRAM_STATE_DIR else ~/.claude/channels/telegram; token from <state_dir>/.env
(TELEGRAM_BOT_TOKEN=); session id from --sid else CLAUDE_CODE_SESSION_ID else
"default". Bot API base from TELEGRAM_API_BASE (default https://api.telegram.org)
so tests can point it at a local stub.
"""
import sys
import os
import json
import urllib.request

MAX_LEN = 4000  # Telegram hard limit is 4096; match the Stop hook's trim.


def api_base():
    return os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")


def state_dir(cli_dir=None):
    return (cli_dir or os.environ.get("TELEGRAM_STATE_DIR")
            or os.path.expanduser("~/.claude/channels/telegram"))


def session_id(cli_sid=None):
    return cli_sid or os.environ.get("CLAUDE_CODE_SESSION_ID") or "default"


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
    url = f"{api_base()}/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def clear_placeholder(sd, sid, chat_id, tok):
    """Delete this session's pending placeholder(s) for `chat_id` and trim the
    pending list -- the exact bookkeeping telegram_progress_reply_clear.py does
    when the reply tool fires, so the Stop hook won't re-deliver. Best-effort:
    any failure is logged, never raised (the message is already out)."""
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return  # nothing pending for this session (e.g. not a placeholder turn)
    keep, drop = [], []
    for p in pend:
        (drop if str(p.get("chat_id")) == str(chat_id) else keep).append(p)
    if not drop:
        return
    for p in drop:
        try:
            api(tok, "deleteMessage",
                {"chat_id": p.get("chat_id"), "message_id": p.get("message_id")})
        except Exception as e:
            log(sd, f"[fallback-send] placeholder delete failed: {e}")
    try:
        if keep:
            json.dump(keep, open(path, "w"))
        else:
            os.remove(path)
    except Exception as e:
        log(sd, f"[fallback-send] pend trim failed: {e}")


def parse_args(argv):
    pos, sid, sdir = [], None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--sid" and i + 1 < len(argv):
            sid = argv[i + 1]; i += 2; continue
        if a == "--state-dir" and i + 1 < len(argv):
            sdir = argv[i + 1]; i += 2; continue
        pos.append(a); i += 1
    return pos, sid, sdir


def main():
    pos, cli_sid, cli_dir = parse_args(sys.argv[1:])
    if len(pos) < 2:
        sys.stderr.write("usage: telegram_fallback_send.py <chat_id> <text> "
                         "[--sid SID] [--state-dir DIR]\n")
        sys.exit(2)
    chat_id, text = pos[0], pos[1]
    sd = state_dir(cli_dir)
    sid = session_id(cli_sid)

    tok = token(sd)
    if not tok:
        sys.stderr.write("telegram_fallback_send: no TELEGRAM_BOT_TOKEN in "
                         f"{os.path.join(sd, '.env')}\n")
        sys.exit(2)

    try:
        resp = api(tok, "sendMessage", {"chat_id": chat_id, "text": text[:MAX_LEN]})
    except Exception as e:
        sys.stderr.write(f"telegram_fallback_send: sendMessage failed: {e}\n")
        sys.exit(2)

    if not (isinstance(resp, dict) and resp.get("ok")):
        sys.stderr.write(f"telegram_fallback_send: Bot API not ok: {resp}\n")
        sys.exit(2)

    # Delivered -> mirror the reply tool: clear the placeholder so the Stop hook
    # does not re-deliver the same answer.
    clear_placeholder(sd, sid, chat_id, tok)
    mid = (resp.get("result") or {}).get("message_id")
    log(sd, f"[fallback-send] delivered chat={chat_id} message_id={mid} "
            f"(placeholder cleared) sid={sid}")
    # Echo the API result so the agent can record the message_id.
    print(json.dumps(resp, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
