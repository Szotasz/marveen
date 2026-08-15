#!/usr/bin/env bash
# context-compact-monitor.sh
# Sends /compact to agents whose most-recent token_usage row has reached >= COMPACT_PCT%
# of the model's context window. Covers both sub-agents (agent-<name> sessions) and the
# main channels agent (<main_agent_id>-channels session).
#
# Anti-burn gates (all three are mandatory):
#   1. token_usage row must be < 20 min old  -- parked/inactive agents are skipped
#   2. 45-min per-agent cooldown             -- stored in COMPACT_STATE_FILE (atomic write)
#   3. fail-closed on corrupt state file     -- whole round skipped, file quarantined
#
# Config env vars:
#   COMPACT_PCT          threshold % (default 75)
#   COMPACT_STATE_FILE   path to state JSON (default: <ROOT>/store/context-compact-state.json)
#   MARVEEN_ROOT         repo root (default: directory containing this script's parent)
#   TMUX_BIN             tmux binary (default /usr/bin/tmux)
set -euo pipefail

# Resolve repo root: two levels up from scripts/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export CCM_ROOT="${MARVEEN_ROOT:-$(dirname "$SCRIPT_DIR")}"
export CCM_COMPACT_PCT="${COMPACT_PCT:-75}"
export CCM_STATE_FILE="${COMPACT_STATE_FILE:-$CCM_ROOT/store/context-compact-state.json}"
export CCM_TMUX_BIN="${TMUX_BIN:-/usr/bin/tmux}"

python3 << 'PYEOF'
import json, os, re, sqlite3, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT        = Path(os.environ["CCM_ROOT"])
DB_PATH     = ROOT / "store" / "claudeclaw.db"
TOKEN_FILE  = ROOT / "store" / ".dashboard-token"
STATE_FILE  = Path(os.environ["CCM_STATE_FILE"])
ENV_FILE    = ROOT / ".env"
API         = "http://localhost:3420"
TMUX_BIN    = os.environ.get("CCM_TMUX_BIN", "/usr/bin/tmux")
COMPACT_PCT = int(os.environ.get("CCM_COMPACT_PCT", "75"))
FRESHNESS_S = 1200   # 20 minutes: agents with no recent activity are skipped
COOLDOWN_S  = 2700   # 45 minutes: per-agent cooldown between compacts
LABEL       = "context-compact-monitor"

def read_main_agent_id():
    """Read MAIN_AGENT_ID from .env; fall back to 'marveen' (upstream default)."""
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("MAIN_AGENT_ID="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return "marveen"

MAIN_AGENT_ID = read_main_agent_id()
MAIN_SESSION  = f"{MAIN_AGENT_ID}-channels"

# contextLimitForModel: mirrors src/context-guard.ts ONE_MILLION_FAMILIES
ONE_MILLION_RX = [
    re.compile(r"fable-\d"),
    re.compile(r"mythos-\d"),
    re.compile(r"opus-4-[6-9]"),
    re.compile(r"opus-[5-9]\b"),
]

def context_limit(model):
    if not isinstance(model, str):
        return 200_000
    m = model.lower()
    if "[1m]" in m:
        return 1_000_000
    if any(rx.search(m) for rx in ONE_MILLION_RX):
        return 1_000_000
    return 200_000

# ── State file ────────────────────────────────────────────────────────────────

def read_state():
    """Returns {} if missing/empty. Raises ValueError on corrupt JSON."""
    if not STATE_FILE.exists():
        return {}
    raw = STATE_FILE.read_text().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"corrupt JSON: {e}") from e

def write_state(state):
    """Atomic write: tmp file then rename."""
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.rename(STATE_FILE)

def quarantine_state():
    if STATE_FILE.exists():
        dest = STATE_FILE.with_name(
            f"context-compact-state.quarantine-{int(time.time())}.json"
        )
        STATE_FILE.rename(dest)
        print(f"[{LABEL}] state quarantined -> {dest.name}", flush=True)

# ── Tmux helpers ──────────────────────────────────────────────────────────────

def tmux_session_exists(session):
    try:
        r = subprocess.run(
            [TMUX_BIN, "has-session", "-t", session],
            capture_output=True, timeout=3
        )
        return r.returncode == 0
    except Exception:
        return False

def is_pane_idle(session):
    """True when the pane shows no active-thinking/tool-running indicators."""
    try:
        r = subprocess.run(
            [TMUX_BIN, "capture-pane", "-t", session, "-p", "-S", "-20"],
            capture_output=True, text=True, timeout=3
        )
        if r.returncode != 0:
            return False
        busy_markers = ["Thinking…", "Thinking...", "esc to interrupt", "Cogitating"]
        return not any(m in r.stdout for m in busy_markers)
    except Exception:
        return False

def send_compact(session):
    """Send /compact to the given tmux session. Returns True on success."""
    try:
        subprocess.run(
            [TMUX_BIN, "send-keys", "-t", session, "-l", "/compact"],
            check=True, timeout=5, capture_output=True
        )
        subprocess.run(
            [TMUX_BIN, "send-keys", "-t", session, "Enter"],
            check=True, timeout=5, capture_output=True
        )
        return True
    except Exception as e:
        print(f"[{LABEL}] tmux send-keys failed for {session}: {e}", flush=True)
        return False

# ── API helpers ───────────────────────────────────────────────────────────────

def api_get(path, token):
    req = urllib.request.Request(
        f"{API}{path}", headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())

def post_daily_log(content, token, agent_id):
    payload = json.dumps({"agent_id": agent_id, "content": content}).encode()
    req = urllib.request.Request(
        f"{API}/api/daily-log", data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass

# ── Main ──────────────────────────────────────────────────────────────────────

# Gate 3: fail-closed on corrupt state
try:
    state = read_state()
except ValueError as e:
    print(f"[{LABEL}] {e} -- quarantining state, skipping round", flush=True)
    quarantine_state()
    sys.exit(0)

token = TOKEN_FILE.read_text().strip()
now   = int(time.time())

# Build candidate list: sub-agents from API + main channels agent
try:
    agents_data = api_get("/api/agents", token)
except Exception as e:
    print(f"[{LABEL}] failed to fetch /api/agents: {e}", flush=True)
    sys.exit(1)

# (agent_name, tmux_session)
candidates = [
    (a["name"], f"agent-{a['name']}")
    for a in agents_data if a.get("running")
]
if tmux_session_exists(MAIN_SESSION):
    candidates.append((MAIN_AGENT_ID, MAIN_SESSION))

if not candidates:
    print(f"[{LABEL}] no running agents found", flush=True)
    sys.exit(0)

# Evaluate each candidate
conn = sqlite3.connect(str(DB_PATH))
compacted = []
try:
    for agent, session in candidates:
        row = conn.execute(
            "SELECT model, input_tokens, cache_read_tokens, cache_creation_tokens, timestamp "
            "FROM token_usage WHERE agent = ? ORDER BY timestamp DESC LIMIT 1",
            (agent,)
        ).fetchone()
        if not row:
            continue

        model, inp, cr, cc, ts = row
        total = (inp or 0) + (cr or 0) + (cc or 0)
        if total == 0:
            continue

        lim = context_limit(model)
        pct = total / lim

        # Threshold check (cheapest gate first)
        if pct < COMPACT_PCT / 100:
            continue

        # Gate 1: freshness -- skip agents inactive for > 20 min
        if now - ts > FRESHNESS_S:
            continue

        # Gate 2: cooldown -- 45 min between compacts per agent
        if now - state.get(agent, {}).get("last_compact", 0) < COOLDOWN_S:
            continue

        # Don't interrupt a pane that is actively running a tool/thinking
        if not is_pane_idle(session):
            print(f"[{LABEL}] {agent}: {pct:.0%} >= threshold but pane busy -- deferred", flush=True)
            continue

        print(f"[{LABEL}] {agent}: {total:,}/{lim:,} ({pct:.0%}) -> /compact", flush=True)
        if send_compact(session):
            compacted.append((agent, total, lim, pct))
            state.setdefault(agent, {})["last_compact"] = now
finally:
    conn.close()

if compacted:
    write_state(state)
    ts_hm = time.strftime("%H:%M", time.localtime(now))
    lines = [f"## {ts_hm} -- {LABEL}"]
    for ag, tok, lim, p in compacted:
        lines.append(f"- {ag}: {tok:,}/{lim:,} ({p:.0%}) -> /compact sent")
    post_daily_log("\n".join(lines), token, MAIN_AGENT_ID)
    print(f"[{LABEL}] done: {len(compacted)} compact(s) sent", flush=True)
else:
    print(f"[{LABEL}] no action needed", flush=True)
PYEOF
