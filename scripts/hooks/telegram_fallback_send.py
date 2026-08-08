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
                              [--once-per-day LABEL] [--marker-dir DIR]

`--once-per-day` is the code-level defence against a message going out twice.
The morning briefing went out twice on three separate days (2026-08-02, 08-07,
08-08) because two sessions ran the same scheduled task around a channels
restart. The prompt-side guard (marker file + mkdir lock) cannot close that: it
only protects sessions that actually run it, and the third incident was a stale
session that sent without ever looking.

So the claim moves into the sender: the marker is created with O_CREAT|O_EXCL
BEFORE the API call, and the second caller loses the race and sends nothing.
Fail-closed -- if the marker cannot be created for any reason other than "it
already exists", the send is refused rather than risking a duplicate.

Exit code:
    0  message delivered (placeholder cleared best-effort)
    2  delivery FAILED (Bot API not ok / unreachable) -> caller should escalate
       (per the skill: fall through to email). Nothing was cleared.
    3  refused: today's message for this label has already been sent (or is
       being sent right now by another process). Nothing was sent.

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


def marker_dir(cli_dir=None):
    """Where the once-per-day markers live. Defaults to the project's store/."""
    if cli_dir:
        return cli_dir
    env = os.environ.get("MORNING_MARKER_DIR")
    if env:
        return env
    return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "store")


def marker_path(label, mdir, day=None):
    day = day or __import__("datetime").date.today().isoformat()
    return os.path.join(mdir, f"{label}-{day}")


def claim_once_per_day(path):
    """
    Claim today's single send for this label.

    Returns True exactly once per marker path, whatever else is happening: the
    file is created with O_CREAT|O_EXCL, which is atomic even between two
    processes that check at the same instant. That is the whole point -- the
    check-then-send the prompt used to do was NOT atomic, and two sessions
    walked through it forty seconds apart.

    A failure that is not "already there" also returns False. Fail-closed: if
    we cannot prove we are the only sender, we do not send. A duplicate message
    is worse than a missing one here -- the user reads the same briefing twice
    and cannot tell which is current.
    """
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    except OSError:
        return False
    with os.fdopen(fd, "w") as fh:
        fh.write(f"claimed pid={os.getpid()} at={__import__('datetime').datetime.now().isoformat(timespec='seconds')}\n")
    return True


def release_claim(path):
    """
    Give the day's chance back after a FAILED send.

    Only called when the API call did not deliver: a claim that outlives a
    failure would silently cost the day's briefing, which is the opposite
    failure from the one this guard exists to prevent.
    """
    try:
        os.unlink(path)
    except OSError:
        pass


def parse_args(argv):
    pos, sid, sdir, label, mdir = [], None, None, None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--sid" and i + 1 < len(argv):
            sid = argv[i + 1]; i += 2; continue
        if a == "--state-dir" and i + 1 < len(argv):
            sdir = argv[i + 1]; i += 2; continue
        if a == "--once-per-day" and i + 1 < len(argv):
            label = argv[i + 1]; i += 2; continue
        if a == "--marker-dir" and i + 1 < len(argv):
            mdir = argv[i + 1]; i += 2; continue
        pos.append(a); i += 1
    return pos, sid, sdir, label, mdir


def main():
    pos, cli_sid, cli_dir, label, cli_mdir = parse_args(sys.argv[1:])
    if len(pos) < 2:
        sys.stderr.write("usage: telegram_fallback_send.py <chat_id> <text> "
                         "[--sid SID] [--state-dir DIR] [--once-per-day LABEL] "
                         "[--marker-dir DIR]\n")
        sys.exit(2)
    chat_id, text = pos[0], pos[1]
    sd = state_dir(cli_dir)
    sid = session_id(cli_sid)

    claimed = None
    if label:
        claimed = marker_path(label, marker_dir(cli_mdir))
        if not claim_once_per_day(claimed):
            # Not an error: another process holds today's send, or it already
            # went out. Say so plainly -- a caller that sees only a non-zero
            # exit tends to retry.
            sys.stderr.write(f"telegram_fallback_send: refused, '{label}' already claimed for today "
                             f"({claimed}) -- nothing sent\n")
            sys.exit(3)

    tok = token(sd)
    if not tok:
        if claimed:
            release_claim(claimed)
        sys.stderr.write("telegram_fallback_send: no TELEGRAM_BOT_TOKEN in "
                         f"{os.path.join(sd, '.env')}\n")
        sys.exit(2)

    try:
        resp = api(tok, "sendMessage", {"chat_id": chat_id, "text": text[:MAX_LEN]})
    except Exception as e:
        if claimed:
            release_claim(claimed)
        sys.stderr.write(f"telegram_fallback_send: sendMessage failed: {e}\n")
        sys.exit(2)

    if not (isinstance(resp, dict) and resp.get("ok")):
        if claimed:
            release_claim(claimed)
        sys.stderr.write(f"telegram_fallback_send: Bot API not ok: {resp}\n")
        sys.exit(2)

    # Delivered -> mirror the reply tool: clear the placeholder so the Stop hook
    # does not re-deliver the same answer.
    clear_placeholder(sd, sid, chat_id, tok)
    mid = (resp.get("result") or {}).get("message_id")
    if claimed:
        # The marker now says what was sent and when. A caller that finds it
        # tomorrow morning gets an answer, not just a lock file: the whole
        # incident started with people unable to tell which message was current.
        try:
            with open(claimed, "a") as fh:
                fh.write(f"sent chat={chat_id} message_id={mid} sid={sid}\n")
        except OSError:
            pass
    log(sd, f"[fallback-send] delivered chat={chat_id} message_id={mid} "
            f"(placeholder cleared) sid={sid}")
    # Echo the API result so the agent can record the message_id.
    print(json.dumps(resp, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
