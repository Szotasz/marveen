#!/usr/bin/env python3
"""
channel-process-gate.py -- exit-code gate for "a declared channel plugin died
silently inside a running session".

Why this exists (card ccdc10ec, step 3): on 2026-09-05 and 09-06 the telegram
plugin process vanished from the main-agent session while `--channels` still
listed it. The session looks healthy, `--channels` still advertises telegram,
but the bun worker is gone -- so every Telegram reply is dropped and, by
definition, we cannot report that over Telegram.

What it measures (process facts only, no network):
  1. every running `claude ... --channels plugin:<name>@<marketplace> ...`
     -> the set of channels that session DECLARES
  2. its child `bun run --cwd .../<marketplace>/<name>/<version> ... start`
     processes -> the set of channels that are actually ALIVE
  3. MISSING = declared - alive, per session

Exit codes:
  0  every declared channel has a live worker (or --only matched nothing)
  1  at least one declared channel has NO live worker   <- the alarm
  2  measurement failed (ps/tmux unreadable, or no `claude --channels` process
     found at all -- that is "cannot tell", never "all good")

Notification goes to THE OTHER, still-live channel of the same session: if
telegram died, we speak on discord, and vice versa. Sending requires --notify;
without it the gate only measures and prints (so both branches are testable).

Fixtures: --ps-file / --tmux-file replace the live `ps`/`tmux` reads verbatim;
DISCORD_API_BASE / TELEGRAM_API_BASE point the send at a local stub, so the
notify branch is measurable without speaking to the owner.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.error

# The install root, NOT the home directory. The earlier `~/marveen/...` default
# assumed the checkout lives at a fixed path under $HOME; on an install rooted
# elsewhere it silently CREATED an orphan `~/marveen/store` (os.makedirs is
# permissive) and parked the state where nobody looks. Derive it from this file
# instead, with the harness override winning when present.
INSTALL_ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
STATE = os.path.join(INSTALL_ROOT, "store", ".channel-process-gate-state.json")
CH_DIR = os.path.join(os.path.expanduser("~"), ".claude", "channels")

DECL_RE = re.compile(r"plugin:([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)")
CWD_RE = re.compile(r"--cwd\s+(\S+)")


def read_ps(ps_file):
    if ps_file:
        with open(ps_file, encoding="utf-8") as fh:
            return fh.read()
    return subprocess.run(["ps", "-eo", "pid,ppid,args"],
                          capture_output=True, text=True, timeout=20).stdout


def read_tmux(tmux_file):
    if tmux_file:
        with open(tmux_file, encoding="utf-8") as fh:
            return fh.read()
    r = subprocess.run(["tmux", "list-panes", "-a", "-F",
                        "#{session_name} #{pane_pid}"],
                       capture_output=True, text=True, timeout=20)
    return r.stdout if r.returncode == 0 else ""


def parse_ps(text):
    procs = {}
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue  # header and malformed rows
        procs[int(parts[0])] = {"ppid": int(parts[1]), "args": parts[2]}
    return procs


def parse_tmux(text):
    by_pid = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            by_pid[int(parts[1])] = parts[0]
    return by_pid


def session_name(pid, procs, tmux_map):
    """Walk up the ppid chain until a pid that tmux knows as a pane."""
    seen, cur = set(), pid
    while cur and cur not in seen:
        if cur in tmux_map:
            return tmux_map[cur]
        seen.add(cur)
        cur = procs.get(cur, {}).get("ppid", 0)
    return f"pid:{pid}"


def measure(procs, tmux_map):
    """-> list of {session, pid, declared:[], alive:[], missing:[]}"""
    out = []
    for pid, p in sorted(procs.items()):
        args = p["args"]
        if "--channels" not in args:
            continue
        if not re.search(r"(^|/)claude(\s|$)", args.split()[0] + " "):
            continue
        declared = {f"{m.group(2)}/{m.group(1)}" for m in DECL_RE.finditer(args)}
        if not declared:
            continue
        alive = set()
        for cpid, c in procs.items():
            if c["ppid"] != pid:
                continue
            m = CWD_RE.search(c["args"])
            if not m or "plugins/cache" not in m.group(1):
                continue
            seg = m.group(1).rstrip("/").split("/")
            if len(seg) >= 3:
                alive.add(f"{seg[-3]}/{seg[-2]}")  # <marketplace>/<plugin>
        out.append({
            "session": session_name(pid, procs, tmux_map),
            "pid": pid,
            "declared": sorted(declared),
            "alive": sorted(alive),
            "missing": sorted(declared - alive),
        })
    return out


def env_value(path, key):
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


def owner_dm_id():
    """Telegram keeps no owner chat id in .env; in a DM the paired sender id IS
    the chat id, and access.json holds exactly the senders the owner paired."""
    try:
        with open(f"{CH_DIR}/telegram/access.json", encoding="utf-8") as fh:
            allow = json.load(fh).get("allowFrom") or []
    except (OSError, ValueError):
        return None
    return str(allow[0]) if allow else None


ALERT_TARGETS = os.path.join(INSTALL_ROOT, "store", "alert-targets.json")


def alert_target(channel):
    """Where the alarm goes, most explicit source first.

    MEASURED 2026-09-12: the discord .env DISCORD_CHANNEL_ID is a guild text
    channel ("agent"), NOT the owner's DM -- an alarm sent there gives no
    push. So the .env is the LAST resort and says so out loud: a gate whose
    verdict is right but whose address is wrong is still a silent gate.
    """
    env_key = {"discord": "CHANNEL_GATE_DISCORD_ID",
               "telegram": "CHANNEL_GATE_TELEGRAM_ID"}[channel]
    val = os.environ.get(env_key)
    if val:
        return val, env_key
    try:
        with open(os.environ.get("CHANNEL_GATE_TARGETS", ALERT_TARGETS),
                  encoding="utf-8") as fh:
            val = json.load(fh).get(f"{channel}_owner_dm")
        if val:
            return str(val), "alert-targets.json"
    except (OSError, ValueError):
        pass
    if channel == "telegram":
        val = env_value(f"{CH_DIR}/telegram/.env", "TELEGRAM_OWNER_CHAT_ID") \
              or owner_dm_id()
        return (val, "telegram access.json") if val else (None, None)
    val = env_value(f"{CH_DIR}/discord/.env", "DISCORD_CHANNEL_ID")
    if val:
        sys.stderr.write("FIGYELEM: a riasztas cime a discord .env-bol jon, "
                         "ami NEM biztos, hogy a gazda DM-je\n")
    return (val, "discord .env") if val else (None, None)


# MERVE 2026-09-12 07:30: a discord API User-Agent nelkul 403 / "error code: 1010"
# (Cloudflare browser-integrity), ezert a kapu ELSO eles riasztasa NEM ment ki --
# a verdikt jo volt, a cim jo volt, a kezbesites bukott. UA-val ugyanaz a hivas 200.
USER_AGENT = "DiscordBot (https://github.com/anthropics/claude-code, 1.0)"


def notify(channel, text):
    """Send on the still-live channel. Returns True on confirmed delivery."""
    if channel == "discord":
        tok = env_value(f"{CH_DIR}/discord/.env", "DISCORD_BOT_TOKEN")
        chat, src = alert_target("discord")
        if not tok or not chat:
            return False
        sys.stderr.write(f"cimzett: discord {chat} ({src})\n")
        base = os.environ.get("DISCORD_API_BASE",
                              "https://discord.com/api/v10").rstrip("/")
        url = f"{base}/channels/{chat}/messages"
        req = urllib.request.Request(
            url, data=json.dumps({"content": text[:1900]}).encode(),
            headers={"Authorization": f"Bot {tok}",
                     "Content-Type": "application/json",
                     "User-Agent": USER_AGENT})
    elif channel == "telegram":
        tok = env_value(f"{CH_DIR}/telegram/.env", "TELEGRAM_BOT_TOKEN")
        chat, src = alert_target("telegram")
        if not tok or not chat:
            return False
        sys.stderr.write(f"cimzett: telegram {chat} ({src})\n")
        base = os.environ.get("TELEGRAM_API_BASE",
                              "https://api.telegram.org").rstrip("/")
        url = f"{base}/bot{tok}/sendMessage"
        req = urllib.request.Request(
            url, data=json.dumps({"chat_id": chat, "text": text[:3900]}).encode(),
            headers={"Content-Type": "application/json",
                     "User-Agent": USER_AGENT})
    else:
        return False
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read()[:200].decode("utf-8", "replace").strip()
        except Exception:
            pass
        sys.stderr.write(f"kuldes BUKOTT: HTTP {e.code} {body}\n")
        return False
    except (urllib.error.URLError, OSError) as e:
        sys.stderr.write(f"kuldes BUKOTT: {type(e).__name__} {e}\n")
        return False


def other_live(row):
    """Pick a channel that is still alive in the same session to speak on."""
    for full in row["alive"]:
        name = full.split("/")[-1]
        if name in ("discord", "telegram"):
            return name
    return None


def load_state():
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(st):
    # Do not conjure a store/ in a tree we do not own: a missing store/ means the
    # root resolved wrong, and creating it is exactly how the orphan directory
    # appeared. Fail loudly instead.
    state_dir = os.path.dirname(STATE)
    if not os.path.isdir(state_dir):
        print(f"MERESI HIBA: a store konyvtar nem letezik: {state_dir} "
              f"(INSTALL_ROOT={INSTALL_ROOT}). Allitsd a CLAUDE_PROJECT_DIR-t a telepites gyokerere.",
              file=sys.stderr)
        # SystemExit, not `return`: save_state()'s return value is not checked by
        # its caller, so a plain return would drop the state write SILENTLY and
        # the gate would still exit 0/1 as if it had persisted.
        raise SystemExit(2)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ps-file")
    ap.add_argument("--tmux-file")
    ap.add_argument("--only", help="restrict to one tmux session name")
    ap.add_argument("--notify", action="store_true",
                    help="actually send on the other live channel")
    ap.add_argument("--state", help="override state file path")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    global STATE
    if a.state:
        STATE = a.state

    try:
        ps_text = read_ps(a.ps_file)
        tmux_text = read_tmux(a.tmux_file)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"MERESI HIBA: {exc}", file=sys.stderr)
        return 2
    procs = parse_ps(ps_text)
    if not procs:
        print("MERESI HIBA: ures ps-kimenet", file=sys.stderr)
        return 2

    rows = measure(procs, parse_tmux(tmux_text))
    if a.only:
        rows = [r for r in rows if r["session"] == a.only]
        if not rows:
            print(f"MERESI HIBA: nincs '{a.only}' session --channels-szel",
                  file=sys.stderr)
            return 2
    if not rows:
        print("MERESI HIBA: egyetlen 'claude --channels' folyamat sem talalhato",
              file=sys.stderr)
        return 2

    broken = [r for r in rows if r["missing"]]
    if a.json:
        print(json.dumps(rows, indent=1, sort_keys=True))
    else:
        for r in rows:
            mark = "PIROS" if r["missing"] else "zold"
            print(f"[{mark}] {r['session']} (pid {r['pid']}): "
                  f"deklaralt={','.join(r['declared']) or '-'} "
                  f"elo={','.join(r['alive']) or '-'} "
                  f"HIANYZO={','.join(r['missing']) or '-'}")

    st = load_state()
    now = int(time.time())
    for r in rows:
        key = r["session"]
        prev = st.get(key, {}).get("missing", [])
        changed = prev != r["missing"]
        st[key] = {"missing": r["missing"], "checked_at": now,
                   "changed_at": now if changed else
                   st.get(key, {}).get("changed_at", now)}
        if r["missing"] and changed and a.notify:
            ch = other_live(r)
            names = ", ".join(m.split("/")[-1] for m in r["missing"])
            msg = (f"⚠️ Csatorna-folyamat HIANYZIK: a(z) `{key}` session "
                   f"deklaralja a(z) **{names}** plugint, de nincs elo "
                   f"worker-folyamata. A rajta erkezo uzenetek elvesznek. "
                   f"(channel-process-gate, {time.strftime('%Y-%m-%d %H:%M')})")
            ok = notify(ch, msg) if ch else False
            print(f"ERTESITES {'elkuldve' if ok else 'NEM ment ki'} "
                  f"({ch or 'nincs elo masik csatorna'})", file=sys.stderr)
    save_state(st)
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
