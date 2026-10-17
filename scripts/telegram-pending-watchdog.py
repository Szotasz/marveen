#!/usr/bin/env python3
"""Telegram pending-update watchdog: restarts an agent whose poller is alive but no longer polling.

WHY (TGPENDING1016): after a network outage on 2026-10-16 the telegram plugin's poller (`bun server.ts`)
of several agents stayed ALIVE as a process but stopped calling getUpdates. Inbound messages sat on the
Bot API (getWebhookInfo pending_update_count=1 on one bot at 08:05), the session never saw them, and
sending kept working. channel-keepalive-probe only proves the process exists, so it read these agents as
healthy. The one signal that sees this failure is Telegram's own queue: a bot whose poller is polling has
pending_update_count 0 within a second of an update arriving (the long poll returns it at once).

What it does, every run (launchd StartInterval, see install-telegram-pending-watchdog.sh):
  1. finds every bot of this install: the main agent's channel .env and agents/*/.claude/channels/telegram/.env;
  2. asks getWebhookInfo for each (a bot with a webhook URL set is skipped: it has no poller to freeze);
  3. a bot is STUCK when pending_update_count > 0 in two CONSECUTIVE runs that are at least MIN_STUCK_S
     apart (the second run must follow the first within MAX_GAP_S, else the streak restarts);
  4. a stuck agent is restarted through the dashboard (POST /api/agents/<name>/restart -- for the main
     agent the same endpoint takes the channels-session path), at most once per COOLDOWN_S per agent;
  5. every run writes one log line; a restart also writes a daily-log entry for that agent.

The restart endpoint keeps its own rules: an agent stopped on purpose is refused (409), a stopped agent
that should be up is started. A failed or refused attempt still counts for the cooldown, so a bot whose
agent is down on purpose costs one log line per COOLDOWN_S, not one per run.

Token handling: a bot token is read from its .env inside this process and only ever appears in the
request URL. Nothing it prints contains it: bots are named by agent and by a sha256 prefix, and every
error text goes through redact() before it is written.

Exit 0 always: a watchdog that fails launchd tells nobody anything; the log line carries the outcome.

Test seams (env): TPW_INSTALL_DIR, TPW_MAIN_TG_ENV, TPW_TELEGRAM_BASE, TPW_DASHBOARD_BASE, TPW_STATE_FILE,
TPW_NOW (epoch seconds), TPW_DRY_RUN=1 (measure and decide, restart nothing, write no daily log).
"""
import glob
import hashlib
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

MIN_STUCK_S = int(os.environ.get("TPW_MIN_STUCK_S", "170"))   # two runs at the 180 s cadence, minus jitter
MAX_GAP_S = int(os.environ.get("TPW_MAX_GAP_S", "420"))       # a run this late does not continue a streak
COOLDOWN_S = int(os.environ.get("TPW_COOLDOWN_S", "900"))     # max one restart attempt / agent / 15 min
RUN_TIMEOUT_S = 120                                           # launchd never overlaps runs: a hang must end

INSTALL_DIR = os.environ.get("TPW_INSTALL_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TELEGRAM_BASE = os.environ.get("TPW_TELEGRAM_BASE", "https://api.telegram.org").rstrip("/")
DRY_RUN = os.environ.get("TPW_DRY_RUN") == "1"

_secrets = []


def redact(text):
    s = str(text)
    for t in _secrets:
        s = s.replace(t, "<token>")
    return s


def now():
    return float(os.environ.get("TPW_NOW") or time.time())


def stamp():
    return datetime.fromtimestamp(now()).strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    print(f"{stamp()} [telegram-pending-watchdog] {redact(msg)}", flush=True)


def read_env(path, key):
    """One key from a .env file, without sourcing it. Last line wins, quotes stripped."""
    val = None
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return None
    return val or None


def install_env(key):
    return read_env(os.path.join(INSTALL_DIR, ".env"), key)


def main_agent_id():
    v = install_env("MAIN_AGENT_ID") or "marveen"
    return "".join(c for c in v if c.isalnum() or c in "_-") or "marveen"


def dashboard_base():
    if os.environ.get("TPW_DASHBOARD_BASE"):
        return os.environ["TPW_DASHBOARD_BASE"].rstrip("/")
    port = os.environ.get("MARVEEN_WEB_PORT") or os.environ.get("WEB_PORT") or install_env("WEB_PORT") or "3420"
    return f"http://localhost:{port.strip()}"


def discover_bots():
    """[(agent, env_path)] -- one entry per distinct .env file (the main path may be a symlink of $HOME's)."""
    main_env = os.environ.get("TPW_MAIN_TG_ENV")
    if not main_env:
        local = os.path.join(INSTALL_DIR, ".claude", "channels", "telegram", ".env")
        main_env = local if os.path.exists(local) else os.path.expanduser("~/.claude/channels/telegram/.env")
    found = []
    if os.path.exists(main_env):
        found.append((main_agent_id(), main_env))
    for p in sorted(glob.glob(os.path.join(INSTALL_DIR, "agents", "*", ".claude", "channels", "telegram", ".env"))):
        found.append((p.split(os.sep)[-5], p))
    seen, out = set(), []
    for agent, p in found:
        rp = os.path.realpath(p)
        if rp in seen:
            continue
        seen.add(rp)
        out.append((agent, p))
    return out


def http_json(url, method="GET", body=None, headers=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        with e:
            try:
                payload = json.loads(e.read().decode() or "{}")
            except Exception:
                payload = {}
        return e.code, payload


def pending_count(token):
    """(count, None) or (None, reason). A webhook bot returns (None, 'webhook')."""
    try:
        code, d = http_json(f"{TELEGRAM_BASE}/bot{token}/getWebhookInfo")
    except Exception as e:  # network down, DNS, timeout: no evidence either way
        return None, f"getWebhookInfo failed: {type(e).__name__}: {redact(e)}"
    if code != 200 or not d.get("ok"):
        return None, f"getWebhookInfo HTTP {code}: {redact(d.get('description', ''))}"
    res = d.get("result") or {}
    if res.get("url"):
        return None, "webhook"
    return int(res.get("pending_update_count") or 0), None


def load_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def dashboard_headers():
    try:
        tok = open(os.path.join(INSTALL_DIR, "store", ".dashboard-token"), encoding="utf-8").read().strip()
    except OSError:
        tok = ""
    if tok:
        _secrets.append(tok)
    h = {"X-Agent-Id": "telegram-pending-watchdog"}
    if tok:
        h["Authorization"] = "Bearer " + tok
    return h


def restart(agent):
    try:
        code, d = http_json(f"{dashboard_base()}/api/agents/{agent}/restart", method="POST", body={},
                            headers=dashboard_headers(), timeout=90)
    except Exception as e:
        return False, f"{type(e).__name__}: {redact(e)}"
    if code == 200 and d.get("ok"):
        return True, "ok"
    return False, f"HTTP {code} {d.get('code') or ''} {redact(d.get('error') or '')}".strip()


def daily_log(agent, text):
    content = f"## {datetime.fromtimestamp(now()).strftime('%H:%M')} -- Telegram-poller elakadás\n{text}"
    try:
        http_json(f"{dashboard_base()}/api/daily-log", method="POST", body={"agent_id": agent, "content": content},
                  headers=dashboard_headers())
    except Exception as e:
        log(f"daily-log write failed for {agent}: {type(e).__name__}")


def step(state, agent, count, t):
    """Advance one agent's streak with this run's measurement. Returns True when the agent is STUCK."""
    s = state.setdefault(agent, {})
    if count is None:          # no measurement: keep the streak as it is, MAX_GAP_S ages it out
        return False
    if count == 0:
        s.pop("since", None); s.pop("seen", None); s.pop("streak", None)
        return False
    if s.get("streak") and t - s.get("seen", 0) <= MAX_GAP_S:
        s["streak"] += 1
    else:
        s["streak"], s["since"] = 1, t
    s["seen"] = t
    return s["streak"] >= 2 and t - s["since"] >= MIN_STUCK_S


def main():
    signal.signal(signal.SIGALRM, lambda *_: (log(f"WARN run exceeded {RUN_TIMEOUT_S}s, aborting"), os._exit(0)))
    signal.alarm(RUN_TIMEOUT_S)
    state_path = os.environ.get("TPW_STATE_FILE") or os.path.join(INSTALL_DIR, "store", ".telegram-pending-watchdog.json")
    state = load_state(state_path)
    t = now()
    bots = discover_bots()
    if not bots:
        log("no telegram bot .env found; nothing to watch")
        return
    fp_owner, parts = {}, []
    for agent, env_path in bots:
        token = read_env(env_path, "TELEGRAM_BOT_TOKEN")
        if not token:
            parts.append(f"{agent}=no-token")
            continue
        _secrets.append(token)
        fp = hashlib.sha256(token.encode()).hexdigest()[:12]
        if fp in fp_owner:     # two agents on one token: a restart could hit the wrong one
            parts.append(f"{agent}=shares-token-with-{fp_owner[fp]}(skip)")
            continue
        fp_owner[fp] = agent
        count, why = pending_count(token)
        if why == "webhook":
            parts.append(f"{agent}=webhook(skip)")
            continue
        if why:
            parts.append(f"{agent}=?")
            log(f"{agent} ({fp}): {why}")
        stuck = step(state, agent, count, t)
        if count is not None:
            parts.append(f"{agent}={count}" + (f"(x{state[agent]['streak']})" if count else ""))
        if not stuck:
            continue
        s = state[agent]
        since = int(t - s["since"])
        last = s.get("last_restart", 0)
        if t - last < COOLDOWN_S:
            log(f"{agent}: STUCK (pending {count} for {since}s) but last restart attempt was {int(t - last)}s ago "
                f"(< {COOLDOWN_S}s): waiting")
            continue
        if DRY_RUN:
            log(f"{agent}: STUCK (pending {count} for {since}s) -- DRY_RUN, would restart")
            continue
        s["last_restart"] = t
        runs = s["streak"]
        ok, detail = restart(agent)
        log(f"{agent}: STUCK (pending {count} for {since}s across {runs} runs) -> restart {'OK' if ok else 'FAILED'}: {detail}")
        for k in ("since", "seen", "streak"):
            s.pop(k, None)
        daily_log(agent, f"A bejövő Telegram-üzenet {since} mp óta a Bot API-n várt (pending_update_count={count}, "
                         f"{runs} egymást követő mérés), a poller nem vette fel. Újraindítás: "
                         f"{'sikerült' if ok else 'NEM sikerült (' + detail + ')'}. (telegram-pending-watchdog)")
    log("pending: " + " ".join(parts))
    save_state(state_path, state)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERROR {type(e).__name__}: {e}")
    sys.exit(0)
