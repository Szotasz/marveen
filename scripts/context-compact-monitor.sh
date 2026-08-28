#!/usr/bin/env bash
# context-compact-monitor.sh
# Sends /compact to agents whose most-recent token_usage row has reached >= COMPACT_PCT%
# of the model's context window. Covers both sub-agents (agent-<name> sessions) and the
# main channels agent (<main_agent_id>-channels session).
#
# Gates (all mandatory):
#   1. token_usage row must be < 60 min old  -- parked/long-inactive agents skipped
#      EXCEPT: agents already flagged as pending skip this gate (they qualified earlier)
#   2. 45-min per-agent cooldown             -- stored in COMPACT_STATE_FILE (atomic write)
#   3. pane must be idle                     -- busy panes are deferred and flagged as
#      pending so the next idle moment triggers compact without re-qualifying
#   4. fail-closed on corrupt state file     -- whole round skipped, file quarantined
#
# Urgent mode (>= URGENT_PCT):
#   A notification line is written to the pane so the agent can /compact at its next
#   safe point. No forced /compact -- the agent decides when is appropriate.
#
# Config env vars:
#   COMPACT_PCT          threshold % (default 75)
#   URGENT_PCT           urgent notification threshold % (default 95)
#   COMPACT_STATE_FILE   path to state JSON (default: <ROOT>/store/context-compact-state.json)
#   MARVEEN_ROOT         repo root (default: directory containing this script's parent)
#   TMUX_BIN             tmux binary (default /usr/bin/tmux)
set -euo pipefail

# Resolve repo root: two levels up from scripts/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export CCM_ROOT="${MARVEEN_ROOT:-$(dirname "$SCRIPT_DIR")}"
export CCM_COMPACT_PCT="${COMPACT_PCT:-75}"
export CCM_URGENT_PCT="${URGENT_PCT:-95}"
export CCM_STATE_FILE="${COMPACT_STATE_FILE:-$CCM_ROOT/store/context-compact-state.json}"
export CCM_TMUX_BIN="${TMUX_BIN:-tmux}"

python3 << 'PYEOF'
import json, os, re, sqlite3, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT        = Path(os.environ["CCM_ROOT"])
DB_PATH     = ROOT / "store" / "claudeclaw.db"
TOKEN_FILE  = ROOT / "store" / ".dashboard-token"
STATE_FILE  = Path(os.environ["CCM_STATE_FILE"])
ENV_FILE    = ROOT / ".env"
API         = "http://localhost:3420"
TMUX_BIN    = os.environ.get("CCM_TMUX_BIN", "tmux")
COMPACT_PCT = int(os.environ.get("CCM_COMPACT_PCT", "75"))
URGENT_PCT  = int(os.environ.get("CCM_URGENT_PCT", "95"))
FRESHNESS_S = 3600   # 60 min: parked/long-inactive agents are skipped
COOLDOWN_S  = 2700   # 45 min: per-agent cooldown between compacts
STALE_PENDING_S = 1800  # 30 min: pending flag expires after restart/long gap
LABEL       = "context-compact-monitor"

# Validate tmux binary once at startup. A missing/non-executable binary is a
# configuration error, not a transient failure -- it must be LOUD, not silently
# absorbed into the fail-closed "pane busy" path (which is reserved for
# genuine runtime ambiguity like a single capture timeout).
import shutil as _shutil
_tmux_ok = bool(_shutil.which(TMUX_BIN))
if not _tmux_ok:
    print(
        f"[{LABEL}] CONFIG ERROR: tmux binary not found or not executable: '{TMUX_BIN}'. "
        "Set the TMUX_BIN env var to the correct path (e.g. /opt/homebrew/bin/tmux). "
        "All panes will appear busy until this is fixed -- no compaction will occur.",
        flush=True,
    )
    # Do NOT exit: fail-closed behavior continues, but the cause is now visible.

# Busy-pane detection -- see is_pane_idle() docstring for rationale.
# Shape regex: word(s) + ellipsis (U+2026 or ASCII ...) + "(" + time digit.
# Matches ongoing spinners; does NOT match "Crunched for Xm Ys" (past tense).
_SPINNER_RE = re.compile(r'\w[\w\s]*[…\.]{1,3}\s*\([\dsmh]')
_STRING_MARKERS = [
    "esc to interrupt",  # primary: present throughout active tool/thinking
    "Thinking",          # legacy Claude Code label
    "Cogitating",        # legacy Claude Code label
]

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
    """True when the pane shows no active-thinking/tool-running indicators.

    Fail-closed: any exception or unrecognised state returns False (= busy).
    This biases toward missed compactions rather than interrupted work -- a
    false-busy delays compaction (pending flag compensates); a false-idle
    sends /compact mid-turn, which has a higher cost.

    Detection uses two complementary signals:
      1. String markers -- "esc to interrupt" is the most reliable; legacy
         Claude Code labels kept for backward compatibility.
      2. Spinner shape regex -- matches the ongoing-work spinners Claude Code
         displays (e.g. "Wandering… (19s · 626 tokens)", "Compacting… (9m 42s)").
         The pattern targets the SHAPE (word + ellipsis + parenthesised time),
         surviving renames better than a word allowlist would.
    Note: "Crunched for Xm Ys" is a past-tense completion marker, not a busy
    indicator, and is intentionally not matched.
    """
    try:
        r = subprocess.run(
            [TMUX_BIN, "capture-pane", "-t", session, "-p", "-S", "-20"],
            capture_output=True, text=True, timeout=3
        )
        if r.returncode != 0:
            return False  # fail-closed: can't read = treat as busy
        text = r.stdout
        if any(m in text for m in _STRING_MARKERS):
            return False
        if _SPINNER_RE.search(text):
            return False
        return True
    except Exception:
        return False  # fail-closed

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

def send_urgent_notify(session, pct):
    """Write a notification line to the pane without sending Enter."""
    msg = f"\n[context-compact-monitor] Context at {pct:.0%} -- please /compact at your next safe point\n"
    try:
        subprocess.run(
            [TMUX_BIN, "send-keys", "-t", session, "-l", msg],
            timeout=5, capture_output=True
        )
    except Exception:
        pass

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

# Gate 4: fail-closed on corrupt state
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
state_dirty = False
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
            # If a pending flag exists here, the agent compacted on its own --
            # the flag is no longer meaningful. Clear it so state stays accurate.
            a_st = state.get(agent, {})
            if a_st.get("pending_compact", False):
                a_st.pop("pending_compact", None)
                a_st.pop("pending_since", None)
                state[agent] = a_st
                state_dirty = True
                print(f"[{LABEL}] {agent}: {pct:.0%} below threshold, pending flag cleared (self-compacted)", flush=True)
            continue

        agent_state = state.get(agent, {})
        is_pending  = agent_state.get("pending_compact", False)
        pending_since = agent_state.get("pending_since", 0)

        # Stale pending cleanup: if flagged >30 min ago and token_usage is also
        # old, the agent likely restarted -- the flag is no longer meaningful.
        if is_pending and (now - pending_since) > STALE_PENDING_S and (now - ts) > STALE_PENDING_S:
            print(f"[{LABEL}] {agent}: stale pending flag cleared (>{STALE_PENDING_S//60}min old)", flush=True)
            agent_state.pop("pending_compact", None)
            agent_state.pop("pending_since", None)
            state[agent] = agent_state
            is_pending = False
            state_dirty = True

        # Gate 1: freshness -- skip long-inactive agents
        # Bypassed if the agent was already flagged as pending (qualified earlier).
        if not is_pending and (now - ts) > FRESHNESS_S:
            continue

        # Gate 2: cooldown -- 45 min between compacts per agent
        if now - agent_state.get("last_compact", 0) < COOLDOWN_S:
            continue

        # Gate 3: pane idle check
        if not is_pane_idle(session):
            # Flag as pending so the next idle moment triggers compact.
            if not is_pending:
                state.setdefault(agent, {})["pending_compact"] = True
                state.setdefault(agent, {})["pending_since"] = now
                state_dirty = True
            urgency = " [URGENT]" if pct >= URGENT_PCT / 100 else ""
            print(f"[{LABEL}] {agent}: {pct:.0%} >= threshold but pane busy{urgency} -- flagged pending", flush=True)
            # At urgent levels, also notify the agent so it can decide when to compact.
            if pct >= URGENT_PCT / 100:
                send_urgent_notify(session, pct)
            continue

        # Pane is idle -- compact now. Clear pending flag.
        if is_pending:
            state.setdefault(agent, {}).pop("pending_compact", None)
            state.setdefault(agent, {}).pop("pending_since", None)
            state_dirty = True
            print(f"[{LABEL}] {agent}: {pct:.0%} pending -> now idle -> /compact", flush=True)
        else:
            print(f"[{LABEL}] {agent}: {total:,}/{lim:,} ({pct:.0%}) -> /compact", flush=True)

        if send_compact(session):
            compacted.append((agent, total, lim, pct))
            state.setdefault(agent, {})["last_compact"] = now
            state_dirty = True
finally:
    conn.close()

if state_dirty:
    write_state(state)

if compacted:
    ts_hm = time.strftime("%H:%M", time.localtime(now))
    lines = [f"## {ts_hm} -- {LABEL}"]
    for ag, tok, lim, p in compacted:
        lines.append(f"- {ag}: {tok:,}/{lim:,} ({p:.0%}) -> /compact sent")
    post_daily_log("\n".join(lines), token, MAIN_AGENT_ID)
    print(f"[{LABEL}] done: {len(compacted)} compact(s) sent", flush=True)
elif state_dirty:
    print(f"[{LABEL}] no compact sent; pending flags updated", flush=True)
else:
    print(f"[{LABEL}] no action needed", flush=True)
PYEOF
