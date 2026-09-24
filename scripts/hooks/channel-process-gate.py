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
  3  a notification was DUE and its delivery FAILED (with --notify): the
     verdict is known, the owner is not -- the scheduler that runs this gate
     turns a streak of these into its own alert (a second, independent path)

Notification (CHANPROCGATE919, 2026-09-20) goes through scripts/notify.sh --
the install's fallback Telegram path (bot token + owner chat from the install
.env, honest delivery via scripts/lib/send-telegram.sh). The first version
spoke on "the other, still-live channel of the same session": measured on the
fleet that runs this, every session carries telegram ONLY, so there never was
another channel to speak on, and the alert had no address. notify.sh is the
path the fleet already uses when the plugin is down, which is exactly the
condition this gate detects.

Sending is on TRANSITION, not on state: a session is announced when its
MISSING set differs from the set last announced for it (`announced` in the
state file; `changed_at` records when the measurement itself changed), and a
"helyreallt" line goes out when the set becomes empty again. A failed send
does not advance `announced`, so the next run retries instead of assuming the
owner heard. Without --notify nothing is sent and `announced` is left alone.

Fixtures: --ps-file / --tmux-file replace the live `ps`/`tmux` reads verbatim;
CHANNEL_GATE_NOTIFY_CMD points the send at a stub notifier, so the notify
branch is measurable without speaking to the owner.
"""
import argparse, json, os, re, subprocess, sys, time

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


# The notifier is a COMMAND, not an HTTP call: scripts/notify.sh under the
# install root (the harness override winning, same as INSTALL_ROOT), or the
# path in CHANNEL_GATE_NOTIFY_CMD for tests. Its exit code IS the delivery
# verdict -- notify.sh returns 0 only on curl exit 0 AND Bot API "ok":true.
NOTIFY_CMD = os.environ.get("CHANNEL_GATE_NOTIFY_CMD") or os.path.join(
    INSTALL_ROOT, "scripts", "notify.sh")


def notify(text):
    """Send through the install's fallback Telegram path. True on CONFIRMED delivery."""
    try:
        r = subprocess.run([NOTIFY_CMD, text], capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.SubprocessError) as e:
        sys.stderr.write(f"kuldes BUKOTT: {type(e).__name__} {e} ({NOTIFY_CMD})\n")
        return False
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-1:] or ["-"]
        sys.stderr.write(f"kuldes BUKOTT: {NOTIFY_CMD} exit {r.returncode}: {tail[0][:200]}\n")
        return False
    return True


def html_escape(text):
    # notify.sh sends with parse_mode=HTML; a session name or plugin path with
    # < > & would otherwise break the message or be eaten as a tag.
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


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
                    help="actually send through scripts/notify.sh on a transition")
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
    send_failed = False
    for r in rows:
        key = r["session"]
        old = st.get(key, {})
        changed = old.get("missing", []) != r["missing"]
        # `announced` is what the owner has CONFIRMED-received for this
        # session (absent = nothing, i.e. green). It advances only on a
        # delivered send, and never without --notify.
        announced = old.get("announced", [])
        entry = {"missing": r["missing"], "checked_at": now,
                 "changed_at": now if changed else old.get("changed_at", now),
                 "announced": announced}
        if a.notify and r["missing"] != announced:
            stamp = time.strftime('%Y-%m-%d %H:%M')
            if r["missing"]:
                names = ", ".join(m.split("/")[-1] for m in r["missing"])
                msg = html_escape(
                    f"⚠️ Csatorna-folyamat HIANYZIK: a(z) {key} session deklaralja "
                    f"a(z) {names} plugint, de nincs elo worker-folyamata. A rajta "
                    f"erkezo uzenetek elvesznek. (channel-process-gate, {stamp})")
            else:
                msg = html_escape(
                    f"✅ Csatorna-folyamat HELYREALLT: a(z) {key} session minden "
                    f"deklaralt pluginje ujra el. (channel-process-gate, {stamp})")
            ok = notify(msg)
            if ok:
                entry["announced"] = r["missing"]
            else:
                send_failed = True
            print(f"ERTESITES {'elkuldve' if ok else 'NEM ment ki'} ({key}: "
                  f"{'hianyzik' if r['missing'] else 'helyreallt'})", file=sys.stderr)
        st[key] = entry
    save_state(st)
    if send_failed:
        return 3
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
