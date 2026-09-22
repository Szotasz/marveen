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
    for part in chunks(text):
        try:
            tg(tok, "sendMessage", {"chat_id": chat_id, "text": part})
        except Exception as e:
            log(sd, f"sendMessage failed: {type(e).__name__}")


def dispatch(text, chat_id, main_session):
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
        data=json.dumps({"text": text, "chatId": chat_id, "mainSession": main_session}).encode(),
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


def clear_stray_placeholder(sd, tok, sid):
    """telegram_progress.py may have posted a "Dolgozom rajta..." placeholder
    for this same event; its Stop-hook cleanup never fires on a blocked turn,
    so clear it here (same logic as telegram_progress_clear.py)."""
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


def attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


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

    result, why = dispatch(body, chat_id, main_session)
    if result is None:
        if name not in BUILTIN_NAMES:
            log(sd, f"/{name}: dashboard unreachable ({why}), not a builtin, passed to the model")
            sys.exit(0)
        reply = DASHBOARD_DOWN_REPLY.format(name=name, why=why)
        if name == "usage":
            reply = quota_text(sd) + "\n\n" + reply
        send(sd, tok, chat_id, reply)
        clear_stray_placeholder(sd, tok, sid)
        log(sd, f"/{name}: dashboard unreachable ({why}), error reply sent, turn blocked")
        sys.exit(2)

    if not result.get("handled"):
        sys.exit(0)

    replies = [r for r in (result.get("replies") or []) if isinstance(r, str) and r]
    if name == "usage":
        replies = [quota_text(sd) + ("\n\n" + replies[0] if replies else "")] + replies[1:]
    for r in replies:
        send(sd, tok, chat_id, r)
    clear_stray_placeholder(sd, tok, sid)
    log(sd, f"/{name} answered ({result.get('outcome')}) chat={chat_id} sid={sid}")
    sys.exit(2)  # block: the model never sees this turn


if __name__ == "__main__":
    main()
