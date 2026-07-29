#!/usr/bin/env python3
"""
Live Telegram progress mirror.

Two independent channels of feedback, both configurable per agent:

1. INDICATOR (ephemeral) -- mirrors the Claude Code status line
   (`✽ Incubating… (55s · ↓ 2.6k tokens)`, `✻ Churned for 11s · 1 shell still
   running`) into ONE Telegram message that is edited in place and DELETED when
   the turn ends. The status line already carries the token counter and the
   "shell / sub-agent still running" state, so mirroring it is both faithful to
   the terminal and cheaper than recomputing any of it.

2. VERBOSE LOG (persistent) -- the agent's visible reasoning steps, taken from
   the session transcript, posted as normal messages that STAY in the chat.
   Filtered: channel plumbing (the reply tool itself) is not interesting.

Why a daemon and not a hook: a hook fires at discrete points and cannot keep a
message updated *while* the model is thinking. This polls, so the indicator
stays alive through a six-minute turn.

Config: store/progress-config.json
    {
      "agents": {
        "turing": {"mode": "verbose", "chatId": "8850069875"}
      },
      "defaultMode": "indicator",
      "pollSeconds": 2,
      "editThrottleSeconds": 3
    }

mode: "silent" (nothing) | "indicator" (ephemeral only) | "verbose" (both)
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "store", "progress-config.json")
STATE_PATH = os.path.join(ROOT, "store", "progress-live-state.json")
LOG_PATH = os.path.join(ROOT, "store", "progress-live.log")

MAIN_AGENT = os.environ.get("MAIN_AGENT_ID", "turing")

# The status line always starts with one of Claude Code's spinner glyphs.
SPINNER = "✻✽✢✳✶✴✵✷⏺●○◐◓◑◒*"
STATUS_RE = re.compile(rf"^[{SPINNER}]\s+(.+)$")


def log(msg):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except Exception:
        pass


def read_json(path, fallback):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


OVERRIDES_PATH = os.path.join(ROOT, "store", "config-overrides.json")
ENV_PATH = os.path.join(ROOT, ".env")
VALID_MODES = ("silent", "indicator", "verbose")


def dashboard_default_mode():
    """Fleet default, as set on the dashboard settings page.

    Same resolution order the TypeScript settings store uses: the override
    file the dashboard writes, then .env, then the registry default. Reading
    it here is what makes the dashboard switch take effect without a restart.
    """
    ov = read_json(OVERRIDES_PATH, {})
    val = ov.get("TELEGRAM_PROGRESS_MODE")
    if val in VALID_MODES:
        return val
    try:
        for line in open(ENV_PATH, encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_PROGRESS_MODE="):
                v = line.split("=", 1)[1].strip().strip('"\'')
                if v in VALID_MODES:
                    return v
    except Exception:
        pass
    return None


def config(state=None):
    """Merged config: the dashboard setting is the fleet-wide switch.

    Per-agent entries in progress-config.json are exceptions, but a user who
    flips the mode on the dashboard expects the whole fleet to follow -- so a
    CHANGED dashboard value clears the per-agent overrides once. After that,
    the CLI can carve out exceptions again.
    """
    cfg = read_json(CONFIG_PATH, {})
    dash = dashboard_default_mode()
    if not dash:
        return cfg
    cfg["defaultMode"] = dash
    if state is not None and state.get("dashboardMode") != dash:
        for a in (cfg.get("agents") or {}).values():
            a.pop("mode", None)
        state["dashboardMode"] = dash
        write_json(CONFIG_PATH, cfg)
        log(f"dashboard mode -> {dash}, per-agent overrides cleared")
    return cfg


def channel_dir(agent):
    if agent == MAIN_AGENT:
        return os.path.expanduser("~/.claude/channels/telegram")
    return os.path.join(ROOT, "agents", agent, ".claude", "channels", "telegram")


def bot_token(agent):
    path = os.path.join(channel_dir(agent), ".env")
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def chat_id(agent, cfg_agent):
    if cfg_agent.get("chatId"):
        return str(cfg_agent["chatId"])
    access = read_json(os.path.join(channel_dir(agent), "access.json"), {})
    allow = access.get("allowFrom") or []
    return str(allow[0]) if allow else None


def api(tok, method, payload):
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log(f"api {method} failed: {e}")
        return {"ok": False}


def session_alive(agent):
    try:
        return subprocess.run(["tmux", "has-session", "-t", tmux_session(agent)],
                              capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def tmux_session(agent):
    # The main agent's channel session is named differently from sub-agents.
    return f"{MAIN_AGENT}-channels" if agent == MAIN_AGENT else f"agent-{agent}"


def status_line(agent):
    """The live 'thinking' line from the agent's terminal, or None when idle."""
    session = tmux_session(agent)
    try:
        out = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", session],
            capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    # The bottom bar carries "esc to interrupt" for the whole duration of a
    # turn, so it is the reliable "is working" gate. The spinner line above it
    # (with the verb and the token counter) is only redrawn periodically -- use
    # it when present, but never let a missed frame look like an idle agent.
    working = "esc to interrupt" in out
    if not working:
        return None
    for line in reversed(out.splitlines()):
        m = STATUS_RE.match(line.strip())
        if not m:
            continue
        text = m.group(1).strip()
        if re.search(r"\(\d|for \d+s|still running", text):
            return text
    # Working, but the detail line was not on screen this frame.
    busy = re.search(r"(\d+ shells?|\d+ tasks?|monitor)", out)
    return f"dolgozom… ({busy.group(1)})" if busy else "dolgozom…"


# --- verbose log ------------------------------------------------------------

def transcript_path(agent):
    if agent == MAIN_AGENT:
        proj = "-home-ubuntu-marveen"
    else:
        proj = f"-home-ubuntu-marveen-agents-{agent}"
    d = os.path.expanduser(f"~/.claude/projects/{proj}")
    try:
        files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")]
        return max(files, key=os.path.getmtime) if files else None
    except Exception:
        return None


SKIP_TOOLS = ("telegram", "reply")


def _norm(t):
    return " ".join(str(t or "").split())[:400]


def new_thoughts(agent, st):
    """Assistant text blocks written since the last poll, plus whether a real
    reply went out in that span.

    Anything the agent also sent as a real Telegram reply is dropped: the owner
    would otherwise receive the same paragraph twice, once as "thinking" and
    once as the answer. The reply flag is what lets the caller know the
    indicator (if still alive) is now stranded above a message that already
    left, and should be moved to the bottom.
    """
    path = transcript_path(agent)
    if not path:
        return [], False
    key = f"{agent}:offset"
    prev_file = st.get(f"{agent}:file")
    offset = st.get(key, 0) if prev_file == path else 0
    st[f"{agent}:file"] = path
    out = []
    sent = []
    replied = False
    try:
        size = os.path.getsize(path)
        if size < offset:          # file rotated
            offset = 0
        with open(path, encoding="utf-8") as f:
            f.seek(offset)
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") != "assistant":
                    continue
                content = (d.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for c in content:
                    if c.get("type") == "tool_use" and "telegram" in str(c.get("name", "")):
                        sent.append(_norm((c.get("input") or {}).get("text")))
                        if str(c.get("name", "")).endswith("__reply"):
                            replied = True
                    elif c.get("type") == "text" and c.get("text"):
                        t = c["text"].strip()
                        if t:
                            out.append(t)
            st[key] = f.tell()
        out = [t for t in out if not any(
            s_ and (_norm(t) == s_ or _norm(t).startswith(s_[:120])) for s_ in sent)]
    except Exception as e:
        log(f"transcript read failed: {e}")
    return out, replied


# --- main loop --------------------------------------------------------------

def main():
    cfg = config()
    poll = float(cfg.get("pollSeconds", 2))
    throttle = float(cfg.get("editThrottleSeconds", 3))
    st = read_json(STATE_PATH, {})
    cfg = config(st)
    log("telegram-live-progress started")

    while True:
        try:
            cfg = config(st)
            agents = cfg.get("agents", {})
            default_mode = cfg.get("defaultMode", "silent")

            for agent, acfg in agents.items():
                mode = acfg.get("mode", default_mode)
                if mode == "silent":
                    # Switching to silent mid-turn must not leave a frozen
                    # "thinking" message behind in the chat.
                    mid = st.get(f"{agent}:mid")
                    if mid:
                        tok = bot_token(agent)
                        cid = chat_id(agent, acfg)
                        if tok and cid:
                            api(tok, "deleteMessage", {"chat_id": cid, "message_id": mid})
                        st.pop(f"{agent}:mid", None)
                        st.pop(f"{agent}:text", None)
                    new_thoughts(agent, st)   # keep the offset current
                    continue
                tok = bot_token(agent)
                cid = chat_id(agent, acfg)
                if not tok or not cid:
                    continue

                # --- ephemeral indicator ---
                line = status_line(agent)
                mid = st.get(f"{agent}:mid")
                shown = st.get(f"{agent}:text")
                last_edit = st.get(f"{agent}:edited", 0)
                gone = st.get(f"{agent}:gone", 0)

                if line:
                    st[f"{agent}:gone"] = 0
                    text = f"✻ {line}"
                    if not mid:
                        r = api(tok, "sendMessage",
                                {"chat_id": cid, "text": text, "disable_notification": True})
                        if r.get("ok"):
                            st[f"{agent}:mid"] = r["result"]["message_id"]
                            st[f"{agent}:text"] = text
                            st[f"{agent}:edited"] = time.time()
                    elif text != shown and time.time() - last_edit >= throttle:
                        api(tok, "editMessageText",
                            {"chat_id": cid, "message_id": mid, "text": text})
                        st[f"{agent}:text"] = text
                        st[f"{agent}:edited"] = time.time()
                elif mid:
                    # The agent vanished mid-turn (crash, restart, wedged
                    # session): the answer is never coming. Silence here is the
                    # worst outcome -- the owner would wait for something that
                    # no longer exists -- so the indicator is turned INTO the
                    # error instead of being deleted.
                    if not session_alive(agent):
                        api(tok, "editMessageText", {
                            "chat_id": cid, "message_id": mid,
                            "text": "⚠️ A munkamenet leállt munka közben, ez a válasz "
                                    "nem fog megérkezni. Küldd el újra a kérést.",
                        })
                        st.pop(f"{agent}:mid", None)
                        st.pop(f"{agent}:text", None)
                        st[f"{agent}:gone"] = 0
                        log(f"{agent}: session died mid-turn, indicator turned into error")
                        continue
                    # Debounce: the status line blinks between tool calls, and
                    # deleting on the first empty poll would flicker the message
                    # in and out of the chat.
                    gone += 1
                    st[f"{agent}:gone"] = gone
                    if gone >= 2:
                        api(tok, "deleteMessage", {"chat_id": cid, "message_id": mid})
                        st.pop(f"{agent}:mid", None)
                        st.pop(f"{agent}:text", None)
                        st[f"{agent}:gone"] = 0

                # --- persistent verbose log ---
                thoughts, replied = new_thoughts(agent, st)
                posted = replied
                if mode == "verbose":
                    for t in thoughts:
                        body = t if len(t) <= 600 else t[:600] + "…"
                        api(tok, "sendMessage",
                            {"chat_id": cid, "text": f"▸ {body}",
                             "disable_notification": True})
                        posted = True

                # A real reply or a verbose thought just landed below the
                # indicator: delete it here so the next poll recreates it
                # fresh at the bottom, instead of leaving it stranded above
                # the message that just went out.
                if posted:
                    stale_mid = st.get(f"{agent}:mid")
                    if stale_mid:
                        api(tok, "deleteMessage", {"chat_id": cid, "message_id": stale_mid})
                        st.pop(f"{agent}:mid", None)
                        st.pop(f"{agent}:text", None)
                        st[f"{agent}:gone"] = 0

            write_json(STATE_PATH, st)
        except Exception as e:
            log(f"loop error: {e}")
        time.sleep(poll)


if __name__ == "__main__":
    sys.exit(main())
