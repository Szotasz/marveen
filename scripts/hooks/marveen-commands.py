#!/usr/bin/env python3
"""
UserPromptSubmit hook -- the owner's slash commands, answered without a turn.

CMD920 / ELSOKOR922 spec D-4: one bot, commands in the main chat. The owner
types a registry command (/status, /queue, /runs, /model, /usage, ...) into
the main Telegram chat; this hook sees it BEFORE the model does, asks the
dashboard to run it (POST /api/commands/dispatch, the command registry in
src/web/commands.ts), sends the reply back with the main bot's token and
blocks the turn. The round trip costs zero model tokens.

Absorbs the old claude-usage.py: `/usage` answers with the Claude quota
(scripts/usage-collect.py) AND Marveen's own token bookkeeping (the
registry's /usage) in one reply.

Main session: every registry command, read or write. A sub-agent session
(the hook is seeded fleet-wide, like claude-usage.py was) gets every READ
command too -- 0 model tokens either way -- but a WRITE (/model, /context
clear, ...) is refused with a one-line reply instead of running: those act
on or describe the MAIN session, and running them from another agent's chat
would be a surprise. The read/write split lives server-side (the registry's
`kind`, src/web/commands.ts) -- this hook only tells the server which
session it is (`mainSession` on the dispatch call) and relays whatever
comes back.

Every other message passes through untouched: exit 0, no stdout, fast.
That includes a slash word the registry does not know (/kanban, /ujchat, ...)
-- those are the agent's own instruction-level commands and go to the model
as before.

MUST stay silent on stdout for the pass-through path -- stdout from a
UserPromptSubmit hook that exits 0 is injected into the model's context. To
BLOCK the turn this exits 2 with empty stdout/stderr: a
`{"decision": "block"}` JSON does NOT block UserPromptSubmit (verified
against live Claude Code, 2026-07-29, see the claude-usage.py history).

Only fires when the prompt carries EXACTLY ONE <channel> block whose source
is Telegram, whose chat is the owner's (ALLOWED_CHAT_ID), and whose body is
a single slash command. A batched prompt (several queued messages in one
turn) goes to the model as normal, so a command sent alongside other content
is never silently swallowed. Known limit (spec D-4): while the session is
busy, the command waits for the running turn to end.

When the dashboard cannot be reached, a BUILTIN command still gets a one-line
error reply and the turn is still blocked: the model cannot run it either,
and a command must not silently turn into a paid turn. An unknown slash word
(possibly an owner custom command the dashboard would know) passes through.

Never interpolate a raw exception into a log line or a reply: a urllib error
string can carry the request URL, and the Bot API URL contains the bot token.
Exception TYPE only.
"""
import sys
import os
import re
import json
import select
import subprocess
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# The install root, from this file's own location (scripts/hooks/ -> root).
# NOT $CLAUDE_PROJECT_DIR: in a sub-agent session that is the agent's own dir,
# which holds neither the .env nor store/.dashboard-token (the old
# claude-usage.py answered "script missing" on every sub-agent for exactly
# this reason). MARVEEN_INSTALL_DIR is the test/launcher override.
REPO_ROOT = os.environ.get("MARVEEN_INSTALL_DIR") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
USAGE_SCRIPT = os.path.join(REPO_ROOT, "scripts", "usage-collect.py")
TELEGRAM_API_BASE = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org")
TELEGRAM_MAX_TEXT = 4096

CHANNEL_RX = re.compile(r'<channel\s+([^>]*)>(.*?)</channel>', re.DOTALL)
COMMAND_RX = re.compile(r'^/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]+)?(?:\s|$)')
TELEGRAM_SOURCE_RX = re.compile(r'\bsource="[^"]*telegram[^"]*"', re.IGNORECASE)

# The builtin registry names (src/web/builtin-commands.ts + the A2 writes).
# Only consulted when the dashboard is DOWN, to decide "ours, answer with an
# error" vs "not ours, let the model have it". Pinned against the registry by
# src/__tests__/marveen-commands-hook.test.ts.
BUILTIN_NAMES = frozenset({
    "help", "status", "queue", "runs", "jobs", "approvals", "model",
    "context", "usage", "board", "commands",
})

WINDOW_LABELS = [
    ("five_hour", "5 orás"),
    ("seven_day", "heti"),
    ("seven_day_opus", "Fable/Opus heti"),
    ("seven_day_sonnet", "Sonnet heti"),
]

DASHBOARD_DOWN_REPLY = "Nem futott: /{name} -- a dashboard nem érhető el ({why}). A parancs nem ment tovább a modellhez. Napló: progress/commands-hook.log"
USAGE_ERROR_REPLY = "Nem sikerult lekerdezni a keret-allapotot (a lekerdezo script hibara futott). Nezd meg a naplot: progress/commands-hook.log"
USAGE_MISSING_REPLY = "Nem sikerult lekerdezni a keret-allapotot: a lekerdezo script nincs meg ezen a telepitesen (scripts/usage-collect.py)."


def state_dir():
    # #915: env override, then the install-scoped dir once it holds the .env,
    # then the legacy shared path (unmigrated installs only).
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    inst = os.path.join(REPO_ROOT, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(inst, ".env")):
        return inst
    return os.path.expanduser("~/.claude/channels/telegram")


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "commands-hook.log"), "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def env_value(path, key):
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        return None
    return None


def owner_chat_id():
    v = env_value(os.path.join(REPO_ROOT, ".env"), "ALLOWED_CHAT_ID")
    if not v or v == "0":
        return None  # not configured here; the dashboard's owner check decides
    return v


def web_port():
    v = os.environ.get("WEB_PORT")
    if v and v.strip().isdigit():
        return v.strip()
    v = env_value(os.path.join(REPO_ROOT, ".env"), "WEB_PORT")
    return v if v and v.isdigit() else "3420"


def api_base():
    return os.environ.get("MARVEEN_API_BASE") or f"http://127.0.0.1:{web_port()}"


def tg(tok, method, payload):
    url = f"{TELEGRAM_API_BASE}/bot{tok}/{method}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def chunks(text, limit=TELEGRAM_MAX_TEXT):
    out = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind("\n", 0, limit)
        if cut <= 0:
            cut = limit
        out.append(rest[:cut])
        rest = rest[cut:]
        if rest.startswith("\n"):
            rest = rest[1:]
    if rest:
        out.append(rest)
    return out


def send(sd, tok, chat_id, text):
    """Returns True iff at least one chunk actually went out -- the caller
    uses this to decide whether to close the ledger's open question (a
    send that fully failed must NOT be marked answered; the live-drain
    should still pick it up)."""
    sent_any = False
    for part in chunks(text):
        try:
            tg(tok, "sendMessage", {"chat_id": chat_id, "text": part})
            sent_any = True
        except Exception as e:
            log(sd, f"sendMessage failed: {type(e).__name__}")
    return sent_any


def mark_answered(sd, payload, chat_id, text):
    """Close the conversation-continuity ledger's open question for this
    reply (fix-forward, ELSOKOR922 Phase 7 A-smoke, live-measured 2026-09-22):
    this hook answers over the raw Bot API, never through the
    mcp__plugin_telegram_telegram__reply tool -- so ledger-outbound.py (the
    PostToolUse hook that closes the open question on a REAL reply-tool call)
    never sees it. Without this, EVERY hook-answered command stays "open" in
    conversation_log forever, and ledger-live-drain.py (every ~2 min) surfaces
    it as lost and pays for a full model turn to answer it AGAIN -- measured
    live: /board and /context both re-answered by the main session, 3-20
    minutes later, doubling every reply and defeating the entire point of the
    hook (0 model tokens). Never raises: a ledger-write failure must not
    affect the reply that already went out."""
    try:
        agent_id = ledger_lib.agent_id_from_payload(payload)
        ledger_lib.log_outbound(agent_id, chat_id, text)
    except Exception as e:
        log(sd, f"ledger log_outbound failed: {type(e).__name__}")


def dispatch(text, chat_id, main_session, defer_writes=False):
    """POST the command to the dashboard. Returns (result dict, None) or (None, why).

    `main_session` rides along so the server can refuse a WRITE resolved for
    a sub-agent caller (fix-forward (3): the old gate lived only here and
    skipped ALL non-/usage commands for a sub-agent, reads included, so a
    sub-agent's /status went to the model at full token cost instead of the
    free hook round trip. Reads are safe to dispatch from anywhere; only
    writes need the session check, and the server is the one place that
    actually knows each command's kind."""
    try:
        with open(os.path.join(REPO_ROOT, "store", ".dashboard-token"), encoding="utf-8") as f:
            dtok = f.read().strip()
    except Exception:
        return None, "nincs dashboard-token"
    if not dtok:
        return None, "nincs dashboard-token"
    req = urllib.request.Request(
        api_base() + "/api/commands/dispatch",
        data=json.dumps({"text": text, "chatId": chat_id, "mainSession": main_session,
                         "deferWrites": defer_writes}).encode(),
        method="POST",
        headers={"Authorization": "Bearer " + dtok, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, type(e).__name__


def fmt_reset(ts):
    if not ts:
        return "ismeretlen"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(ts)))
    except Exception:
        return "ismeretlen"


def format_usage(snapshot):
    # ELSOKOR922 D-4 fix-forward: a 403/hianyzo-token eset (a konteneres
    # telepitesen mert eset: "HTTP 403 (env_file token)") korabban csendben
    # esett vissza becslesre, es ha a becsleshez sem volt adat, a valasz
    # nemtmondo "(nincs elerheto adat)" lett -- az auth_error mezo megvolt a
    # snapshotban, csak sosem olvastuk ki. A kvota-sor most VAGY a tenyleges
    # ablak-adatot mutatja, VAGY a konkret okot -- ures valasz sosem.
    c = snapshot.get("claude") or {}
    if not c.get("ok"):
        reason = c.get("error") or c.get("auth_error") or c.get("source") or "ismeretlen hiba"
        return f"Kvóta: nem mérhető ({reason})."
    w = c.get("windows") or {}
    lines = ["Claude keret-allapot:"]
    for key, label in WINDOW_LABELS:
        win = w.get(key)
        if not win or win.get("used_percent") is None:
            continue
        used = win["used_percent"]
        lines.append(
            f"- {label}: {100 - used:.0f}% van hatra ({used:.0f}% elhasznalva), "
            f"megujul: {fmt_reset(win.get('resets_at'))}"
        )
    if len(lines) == 1:
        reason = c.get("auth_error") or "nincs autoritatív adat, csak becslés lenne, de az sem elérhető"
        return f"Kvóta: nem mérhető ({reason})."
    return "\n".join(lines)


def quota_text(sd):
    if not os.path.isfile(USAGE_SCRIPT):
        log(sd, f"usage-collect.py not found at {USAGE_SCRIPT}")
        return USAGE_MISSING_REPLY
    try:
        out = subprocess.run(["python3", USAGE_SCRIPT, "--json"], capture_output=True, text=True, timeout=20).stdout
        return format_usage(json.loads(out))
    except Exception as e:
        log(sd, f"usage-collect failed: {type(e).__name__}")
        return USAGE_ERROR_REPLY


HANDLED_MARKER_MAX_AGE = 600


def mark_handled(sd, sid, src_mid):
    """Handshake with telegram_progress.py (a parallel UserPromptSubmit hook):
    it posts the placeholder, stores it, and only THEN looks for this marker.
    Written before the clear below, so either the clear finds its stored entry
    or it finds this marker -- no order of the two hooks leaves the placeholder
    behind (ELSOKOR922 Phase 7 A-smoke: "Dolgozom rajta..." hung after /model)."""
    pdir = os.path.join(sd, "progress")
    try:
        os.makedirs(pdir, exist_ok=True)
        now = time.time()
        for name in os.listdir(pdir):
            if name.startswith("cmd-") and name.endswith(".handled"):
                p = os.path.join(pdir, name)
                if now - os.path.getmtime(p) > HANDLED_MARKER_MAX_AGE:
                    os.remove(p)
        if src_mid:
            open(os.path.join(pdir, f"cmd-{sid}-{src_mid}.handled"), "w").close()
    except Exception as e:
        log(sd, f"handled marker failed: {type(e).__name__}")


def clear_stray_placeholder(sd, tok, sid, src_mid=None):
    """telegram_progress.py may have posted a "Dolgozom rajta..." placeholder
    for this same event; its Stop-hook cleanup never fires on a blocked turn,
    so clear it here (same logic as telegram_progress_clear.py)."""
    mark_handled(sd, sid, src_mid)
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
            tg(tok, "deleteMessage", {"chat_id": cid, "message_id": mid})
        except Exception as e:
            log(sd, f"stray placeholder cleanup failed: {type(e).__name__}")
    try:
        os.remove(path)
    except Exception:
        pass


def is_main_session(payload):
    try:
        return ledger_lib.agent_id_from_payload(payload) == ledger_lib.main_agent_id()
    except Exception:
        return False  # unknown identity: treated as non-main, so writes get refused


# ---- deferred writes ----------------------------------------------------------
#
# While this hook runs, Claude Code already shows the owner's own (about to be
# blocked) turn as live -- spinner + `esc to interrupt` -- so a write's quiet
# gate, checked from inside the hook, always read its OWN turn as "pane-busy"
# (measured on the test bot, ELSOKOR922 Phase 7: every /model refused, while a
# direct API call with no hook running went through). The server therefore
# answers a write on the hook's first call `deferred`, and the hook hands the
# command to a detached watcher that wakes exactly once, when THIS process
# exits (pidfd on Linux, kqueue on macOS -- an event, not a poll), waits
# SETTLE_SECONDS for the pane to redraw idle, and re-sends it. The gate then
# runs once; a genuinely busy session still gets its one-line refusal.

DEFERRED_ENV = "MARVEEN_CMD_DEFERRED"
DEFERRED_WAIT_SECONDS = 30
SETTLE_SECONDS = 0.5
DEFERRED_SPAWN_FAILED_REPLY = "Nem futott: /{name} -- a késleltetett végrehajtás nem indult el. Napló: progress/commands-hook.log"


def wait_for_exit(pid, timeout):
    """Block until `pid` exits, or `timeout` passes. True iff it exited."""
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return True
    except (AttributeError, OSError):
        fd = None
    if fd is not None:
        try:
            ready, _, _ = select.select([fd], [], [], timeout)
            return bool(ready)
        finally:
            os.close(fd)
    if hasattr(select, "kqueue"):
        kq = select.kqueue()
        try:
            ev = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                               flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                               fflags=select.KQ_NOTE_EXIT)
            return bool(kq.control([ev], 1, timeout))
        except ProcessLookupError:
            return True
        finally:
            kq.close()
    return False


def spawn_deferred(sd, payload, body, chat_id, main_session):
    job = {
        "pid": os.getpid(),
        "text": body,
        "chat_id": chat_id,
        "main_session": main_session,
        "payload": {k: payload.get(k) for k in ("transcript_path", "cwd", "session_id")},
    }
    env = dict(os.environ)
    env[DEFERRED_ENV] = json.dumps(job)
    try:
        # stdio MUST NOT be inherited: Claude Code waits for the hook's pipes
        # to close, so an inherited stdout would hold the turn open for the
        # watcher's whole life -- the very busy state this is waiting out.
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--deferred"],
            env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
        )
        return True
    except Exception as e:
        log(sd, f"deferred spawn failed: {type(e).__name__}")
        return False


def run_deferred():
    try:
        job = json.loads(os.environ.get(DEFERRED_ENV) or "")
    except Exception:
        sys.exit(0)
    sd = state_dir()
    tok = env_value(os.path.join(sd, ".env"), "TELEGRAM_BOT_TOKEN")
    if not tok:
        sys.exit(0)
    text, chat_id = job.get("text") or "", job.get("chat_id") or ""
    name = (COMMAND_RX.match(text).group(1).lower() if COMMAND_RX.match(text) else "?")
    exited = wait_for_exit(int(job.get("pid") or 0), DEFERRED_WAIT_SECONDS)
    if not exited:
        log(sd, f"/{name} deferred: hook did not exit within {DEFERRED_WAIT_SECONDS}s, running anyway")
    time.sleep(SETTLE_SECONDS)
    result, why = dispatch(text, chat_id, bool(job.get("main_session")))
    if result is None:
        reply = DASHBOARD_DOWN_REPLY.format(name=name, why=why)
        replies = [reply]
    else:
        replies = [r for r in (result.get("replies") or []) if isinstance(r, str) and r]
    sent_any = False
    for r in replies:
        if send(sd, tok, chat_id, r):
            sent_any = True
    if sent_any:
        mark_answered(sd, job.get("payload") or {}, chat_id, replies[-1])
    log(sd, f"/{name} deferred write answered ({(result or {}).get('outcome', why)}) chat={chat_id}")
    sys.exit(0)


def attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def run_stop():
    """Stop hook: the main session finished a turn. If a /model hold expired
    while the session was busy (the one-shot expiry timer found it busy), tell
    the dashboard, which arms ONE revert retry after the switch quiet window.
    The expiry is checked from the hold file first, so an ordinary turn end
    costs no HTTP call. Silent, never blocks (exit 0, empty stdout)."""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    if not is_main_session(payload):
        sys.exit(0)
    try:
        with open(os.path.join(REPO_ROOT, "store", "main-model-hold.json"), encoding="utf-8") as f:
            until = json.load(f).get("until")
        if not isinstance(until, (int, float)) or time.time() * 1000 < until:
            sys.exit(0)
    except Exception:
        sys.exit(0)
    try:
        with open(os.path.join(REPO_ROOT, "store", ".dashboard-token"), encoding="utf-8") as f:
            dtok = f.read().strip()
        req = urllib.request.Request(
            api_base() + "/api/commands/turn-ended", data=b"{}", method="POST",
            headers={"Authorization": "Bearer " + dtok, "Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        log(state_dir(), f"turn-ended notify failed: {type(e).__name__}")
    sys.exit(0)


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
    attrs, body = matches[0].group(1), matches[0].group(2).strip()
    cm = COMMAND_RX.match(body)
    if not cm or "\n" in body:
        sys.exit(0)
    if not TELEGRAM_SOURCE_RX.search(attrs):
        sys.exit(0)
    chat_id = attr(attrs, "chat_id")
    if not chat_id:
        sys.exit(0)
    owner = owner_chat_id()
    if owner is not None and chat_id != owner:
        sys.exit(0)
    name = cm.group(1).lower()
    main_session = is_main_session(payload)

    sd = state_dir()
    tok = env_value(os.path.join(sd, ".env"), "TELEGRAM_BOT_TOKEN")
    if not tok:
        log(sd, "no bot token found, letting the prompt through")
        sys.exit(0)

    result, why = dispatch(body, chat_id, main_session, defer_writes=True)
    if result is not None and result.get("outcome") == "deferred":
        if not spawn_deferred(sd, payload, body, chat_id, main_session):
            reply = DEFERRED_SPAWN_FAILED_REPLY.format(name=name)
            if send(sd, tok, chat_id, reply):
                mark_answered(sd, payload, chat_id, reply)
        clear_stray_placeholder(sd, tok, sid, attr(attrs, "message_id"))
        log(sd, f"/{name} deferred until the hook exits chat={chat_id} sid={sid}")
        sys.exit(2)
    if result is None:
        if name not in BUILTIN_NAMES:
            log(sd, f"/{name}: dashboard unreachable ({why}), not a builtin, passed to the model")
            sys.exit(0)
        reply = DASHBOARD_DOWN_REPLY.format(name=name, why=why)
        if name == "usage":
            reply = quota_text(sd) + "\n\n" + reply
        if send(sd, tok, chat_id, reply):
            mark_answered(sd, payload, chat_id, reply)
        clear_stray_placeholder(sd, tok, sid, attr(attrs, "message_id"))
        log(sd, f"/{name}: dashboard unreachable ({why}), error reply sent, turn blocked")
        sys.exit(2)

    if not result.get("handled"):
        sys.exit(0)

    replies = [r for r in (result.get("replies") or []) if isinstance(r, str) and r]
    if name == "usage":
        replies = [quota_text(sd) + ("\n\n" + replies[0] if replies else "")] + replies[1:]
    sent_any = False
    for r in replies:
        if send(sd, tok, chat_id, r):
            sent_any = True
    if sent_any:
        mark_answered(sd, payload, chat_id, replies[-1])
    clear_stray_placeholder(sd, tok, sid, attr(attrs, "message_id"))
    log(sd, f"/{name} answered ({result.get('outcome')}) chat={chat_id} sid={sid}")
    sys.exit(2)  # block: the model never sees this turn


if __name__ == "__main__":
    if sys.argv[1:2] == ["--deferred"]:
        run_deferred()
    if sys.argv[1:2] == ["--stop"]:
        run_stop()
    main()
