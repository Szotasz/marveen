"""Per-account Claude quota readings (USAGEPERACCOUNT1123).

Every agent's statusLine command (scripts/statusline-ratelimit.sh) used to write its
own session's rate_limits block into ONE file, store/.claude-rate-limits.json, with no
account on it. On an install where agents run on different subscriptions (a Team plan
for some agents, a personal Max plan for others) the last writer won, and the collected
number jumped between the accounts (measured 2026-11-23: 80, 29, 0, 30, 1 within two
hours -- Max before its weekly reset, Team, Max after the reset, Team, Max).

The statusLine payload carries no account id, so the writer keys each reading by an
ACCOUNT FINGERPRINT instead: the seven-day window's reset time modulo one week. It is
the same for every session of one account and differs between accounts (measured: Max
11-23 14:00 -> 11-30 14:00, exactly +7 days; Team 11-25 22:00). The readers below turn
a fingerprint into a plan id from what the install already records, in this order:

  1. agent_token_file  the writing agent (from the reading's cwd) has an own token file
                       agents/<name>/agent-config.json oauthTokenFile named
                       .claude-oauth-token-<plan id> for a plan in store/claude-plans.json
  2. active_plan       the writer is the main agent and store/claude-plans-state.json
                       activePlanByAgent names its plan
  3. probe_fingerprint a plan probe in claude-plans-state.json saw the same weekly
                       reset (modulo one week)
  4. fingerprint_only  none of the above: the label is the fingerprint key itself, and
                       the reading is never merged into a named plan

Stdlib only. Never reads a token: only file names, ids and reset times.
"""
import glob, json, os, re, time

WEEK = 604800
DIR_NAME = "claude-rate-limits"
_PLAN_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PRUNE_AFTER_SEC = 8 * 86400


def fingerprint(rate_limits):
    """The account fingerprint of a rate_limits block, or None without a seven-day reset."""
    w = (rate_limits or {}).get("seven_day") or {}
    r = w.get("resets_at")
    if isinstance(r, bool) or not isinstance(r, (int, float)) or r <= 0:
        return None
    return int(r) % WEEK


def key_for(fp):
    return "wk-%d" % fp


def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _env_value(root, key):
    """One KEY=value from the install .env, read line by line (no secret is ever read: only MAIN_AGENT_ID)."""
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


class Labeler:
    def __init__(self, root):
        self.root = root
        store = os.path.join(root, "store")
        plans = _load(os.path.join(store, "claude-plans.json"), [])
        self.plans = {p["id"]: (p.get("label") or p["id"]) for p in plans
                      if isinstance(p, dict) and isinstance(p.get("id"), str) and _PLAN_RE.match(p["id"])}
        state = _load(os.path.join(store, "claude-plans-state.json"), {})
        state = state if isinstance(state, dict) else {}
        self.active = state.get("activePlanByAgent") if isinstance(state.get("activePlanByAgent"), dict) else {}
        self.main = os.environ.get("MAIN_AGENT_ID") or _env_value(root, "MAIN_AGENT_ID") or "marveen"
        self.probe_fp = {}
        for pid, ps in (state.get("plans") or {}).items():
            if pid not in self.plans or not isinstance(ps, dict):
                continue
            r = (((ps.get("windows") or {}).get("seven_day")) or {}).get("resetsAt")
            if isinstance(r, (int, float)) and not isinstance(r, bool) and r > 0:
                self.probe_fp.setdefault(int(r) % WEEK, pid)
        self.state = state

    def agent_of(self, cwd):
        if not isinstance(cwd, str) or not cwd:
            return None
        agents = os.path.join(self.root, "agents") + os.sep
        if cwd.startswith(agents):
            return cwd[len(agents):].split(os.sep, 1)[0] or None
        if cwd == self.root or cwd.startswith(self.root + os.sep):
            return self.main
        return None

    def plan_of_agent(self, agent):
        if not agent:
            return None, None
        if agent == self.main:
            p = self.active.get(agent)
            return (p, "active_plan") if p in self.plans else (None, None)
        cfg = _load(os.path.join(self.root, "agents", agent, "agent-config.json"), {})
        tf = cfg.get("oauthTokenFile") if isinstance(cfg, dict) else None
        if isinstance(tf, str):
            base = os.path.basename(tf)
            prefix = ".claude-oauth-token-"
            if base.startswith(prefix) and base[len(prefix):] in self.plans:
                return base[len(prefix):], "agent_token_file"
        return None, None

    def label(self, fp, cwd):
        """(plan id or None, account key, label source, conflict flag)."""
        plan, src = self.plan_of_agent(self.agent_of(cwd))
        by_fp = self.probe_fp.get(fp) if fp is not None else None
        conflict = bool(plan and by_fp and plan != by_fp)
        if plan:
            return plan, plan, src, conflict
        if by_fp:
            return by_fp, by_fp, "probe_fingerprint", False
        return None, key_for(fp), "fingerprint_only", False


def _live_windows(rate_limits, now):
    out = {}
    for key in ("five_hour", "seven_day"):
        w = (rate_limits or {}).get(key)
        if not isinstance(w, dict):
            continue
        used = w.get("used_percentage")
        r = w.get("resets_at")
        if isinstance(used, bool) or not isinstance(used, (int, float)):
            continue
        if isinstance(r, bool) or not isinstance(r, (int, float)) or r <= now:
            continue
        out[key] = {"used_percent": used, "resets_at": r}
    return out


def read_accounts(root, now=None, with_probe=True):
    """{account key: entry} from store/claude-rate-limits/*.json (newest reading per account),
    plus, with_probe, each plan of claude-plans-state.json that has no statusLine reading.
    Entry: plan, label, label_source, label_conflict, fingerprint, writer_agent, source,
    written_at, age_minutes, windows (only windows whose reset is still ahead)."""
    now = time.time() if now is None else now
    lab = Labeler(root)
    out = {}
    for path in glob.glob(os.path.join(root, "store", DIR_NAME, "wk-*.json")):
        d = _load(path, None)
        if not isinstance(d, dict):
            continue
        wa = d.get("written_at")
        if isinstance(wa, bool) or not isinstance(wa, (int, float)) or wa > now + 60:
            continue
        rl = d.get("rate_limits")
        fp = fingerprint(rl)
        windows = _live_windows(rl, now)
        if fp is None or not windows:
            continue
        plan, key, src, conflict = lab.label(fp, d.get("cwd"))
        prev = out.get(key)
        if prev and prev["written_at"] >= wa:
            continue
        out[key] = {
            "plan": plan, "label": lab.plans.get(plan, key), "label_source": src, "label_conflict": conflict,
            "fingerprint": key_for(fp), "writer_agent": lab.agent_of(d.get("cwd")), "source": "statusline",
            "written_at": int(wa), "age_minutes": round((now - wa) / 60.0, 1), "windows": windows,
        }
    if with_probe:
        for pid, ps in (lab.state.get("plans") or {}).items():
            if pid in out or pid not in lab.plans or not isinstance(ps, dict):
                continue
            obs = ps.get("observedAt")
            if isinstance(obs, bool) or not isinstance(obs, (int, float)):
                continue
            rl = {k: {"used_percentage": (w or {}).get("usedPercent"), "resets_at": (w or {}).get("resetsAt")}
                  for k, w in (ps.get("windows") or {}).items()}
            windows = _live_windows(rl, now)
            if not windows:
                continue
            out[pid] = {
                "plan": pid, "label": lab.plans[pid], "label_source": "probe", "label_conflict": False,
                "fingerprint": None, "writer_agent": None, "source": "probe",
                "written_at": int(obs / 1000), "age_minutes": round((now - obs / 1000) / 60.0, 1), "windows": windows,
            }
    return out


def write_reading(store_dir, rec, now=None):
    """Writer side (statusline-ratelimit.sh): one file per account fingerprint, atomic, and the
    files of fingerprints silent for PRUNE_AFTER_SEC removed. Returns the path or None."""
    fp = fingerprint(rec.get("rate_limits"))
    if fp is None:
        return None
    now = time.time() if now is None else now
    d = os.path.join(store_dir, DIR_NAME)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, key_for(fp) + ".json")
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f)
    os.replace(tmp, path)
    for old in glob.glob(os.path.join(d, "wk-*.json")):
        try:
            if old != path and now - os.path.getmtime(old) > PRUNE_AFTER_SEC:
                os.remove(old)
        except OSError:
            pass
    return path
