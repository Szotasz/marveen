#!/usr/bin/env python3
"""Silent infrastructure self-check (token-free launchd cron).

WHY: on 2026-09-16 two independent degradations ran for hours unnoticed:
  1. A half-finished merge left ~/.claude/settings.json invalid -> all hooks
     (safety gates + inter-agent inbox drain) silently died.
  2. The macOS launchd twin of the keepalive probe was never installed -> the
     main channels session respawned 8 times, losing the running conversation.
Both were found by accident. Nothing alerts on either, because the failure mode
is absence of work, not an error.

This check runs outside the agent (no model tokens) and notifies ONLY on drift,
straight through the Telegram Bot API -- deliberately NOT through the agent's
own message queue, because the queue is exactly what dies when the hooks die.

Scheduling: run it every few minutes outside the agent and the dashboard --
on macOS a launchd job (StartInterval 300), on Linux a cron entry. It only
needs python3 and the install's .env (TELEGRAM_BOT_TOKEN +
TELEGRAM_OWNER_CHAT_ID); without those it still runs and records state, it
just cannot send.

Anti-spam: the same finding is reported at most once per RENOTIFY_SECONDS.
Fail-safe: any unexpected exception is swallowed after being recorded in the
state file; a broken checker must never take down the machine's cron.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

INSTALL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.join(INSTALL_DIR, "store", ".infra-selfcheck-state.json")
GLOBAL_SETTINGS = os.path.expanduser("~/.claude/settings.json")
PROJECT_SETTINGS = os.path.join(INSTALL_DIR, ".claude", "settings.json")
KEEPALIVE_FILE = os.path.join(INSTALL_DIR, "store", ".channel-keepalive")

RENOTIFY_SECONDS = 6 * 3600
KEEPALIVE_MAX_AGE = 20 * 60  # the probe touches it every 3 min; 20 is generous

# update.sh's auto-stash is pushed and popped within one run (minutes). An
# entry still in `git stash list` past this age means the pop never happened
# (conflict, or the run died first) and uncommitted local work is sitting
# invisible in the stash -- measured 2026-10-10: five such entries back to
# 2026-06-01, one of them a whole lost, finished feature.
AUTO_STASH_MAX_AGE = 30 * 60
_AUTO_STASH_RE = re.compile(r"marveen-update-auto-stash (\d{8}-\d{6})")


def _env(key):
    """One value from <install>/.env; None when absent. The settings this
    script needs are per-install facts, so they live next to the install's
    other secrets and knobs, never in this file."""
    try:
        with open(os.path.join(INSTALL_DIR, ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return None


# Minimum hook counts: "fewer than expected" checks, so adding hooks never
# trips them. The defaults are deliberately low; an install that knows its
# own healthy baseline can pin it via SELFCHECK_MIN_GLOBAL_HOOKS /
# SELFCHECK_MIN_PROJECT_HOOKS in .env (a parse failure alerts regardless).
MIN_GLOBAL_HOOKS = int(_env("SELFCHECK_MIN_GLOBAL_HOOKS") or 1)
MIN_PROJECT_HOOKS = int(_env("SELFCHECK_MIN_PROJECT_HOOKS") or 1)

# Core services every install runs. Install-specific extras (own dashboards,
# tunnels) belong in .env as SELFCHECK_EXTRA_LAUNCHD=label1,label2 -- not here.
REQUIRED_LAUNCHD = [
    "com.marveen.channels",
    "com.marveen.dashboard",
    "com.marveen.channel-keepalive-probe",
] + [x.strip() for x in (_env("SELFCHECK_EXTRA_LAUNCHD") or "").split(",") if x.strip()]


def count_hooks(path):
    """Return (hook_count, error). A parse failure is the headline symptom."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None, "hiányzik"
    except json.JSONDecodeError as err:
        return None, f"érvénytelen JSON ({err.lineno}. sor)"
    hooks = data.get("hooks", {})
    n = sum(len(entry.get("hooks", [])) for event in hooks.values() for entry in event)
    return n, None


def loaded_launchd_labels():
    try:
        out = subprocess.run(
            ["launchctl", "list"], capture_output=True, text=True, timeout=20
        ).stdout
    except Exception:
        return None
    return {line.split("\t")[-1].strip() for line in out.splitlines() if line.strip()}


def stranded_auto_stashes():
    """Names of update auto-stash entries older than AUTO_STASH_MAX_AGE."""
    try:
        out = subprocess.run(
            ["git", "-C", INSTALL_DIR, "stash", "list"],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except Exception:
        return None  # unreadable list is "no measurement", not "no stashes"
    names = []
    now = time.time()
    for line in out.splitlines():
        m = _AUTO_STASH_RE.search(line)
        if not m:
            continue
        try:
            created = time.mktime(time.strptime(m.group(1), "%Y%m%d-%H%M%S"))
        except ValueError:
            created = 0  # unparseable timestamp -> treat as old, better loud than lost
        if now - created > AUTO_STASH_MAX_AGE:
            names.append("marveen-update-auto-stash " + m.group(1))
    return names


def collect_findings():
    findings = []

    for label, path, minimum in (
        ("globális", GLOBAL_SETTINGS, MIN_GLOBAL_HOOKS),
        ("projekt", PROJECT_SETTINGS, MIN_PROJECT_HOOKS),
    ):
        n, err = count_hooks(path)
        if err:
            findings.append(f"A {label} settings.json {err}. Emiatt a hookok nem futnak.")
        elif n < minimum:
            findings.append(
                f"A {label} settings.json csak {n} hookot tartalmaz ({minimum} volt a várt minimum)."
            )

    labels = loaded_launchd_labels()
    if labels is not None:
        missing = [u for u in REQUIRED_LAUNCHD if u not in labels]
        if missing:
            findings.append("Nem fut launchd szolgáltatás: " + ", ".join(missing) + ".")

    try:
        age = time.time() - os.path.getmtime(KEEPALIVE_FILE)
        if age > KEEPALIVE_MAX_AGE:
            findings.append(
                f"A channel-keepalive {int(age // 60)} perce nem frissült, a session felesleges újraindulás előtt áll."
            )
    except FileNotFoundError:
        findings.append("A channel-keepalive jelzőfájl hiányzik.")

    return findings


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=1)
    except Exception:
        pass


def telegram_token():
    env_path = os.path.join(INSTALL_DIR, ".env")
    try:
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def chat_id():
    env_path = os.path.join(INSTALL_DIR, ".env")
    try:
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("TELEGRAM_OWNER_CHAT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def notify(findings):
    token = telegram_token()
    cid = chat_id()
    if not token or not cid:
        return False
    body = "\n".join("- " + f for f in findings)
    text = (
        "⚠️ Rendszer-önellenőrzés: valami csendben elromlott.\n\n"
        + body
        + "\n\nEz a jelzés a háttérből jön, nem az ügynöktől, ezért akkor is megérkezik, ha az ügynök fékjei kiestek."
    )
    payload = json.dumps({"chat_id": cid, "text": text}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=20)
        return True
    except Exception:
        return False


def main():
    try:
        findings = collect_findings()
    except Exception as err:  # a broken checker must stay silent, not loud
        save_state({"checker_error": repr(err), "at": int(time.time())})
        return 0

    state = load_state()
    now = int(time.time())
    seen = state.get("seen", {})

    # Stranded auto-stash check: alert ONCE per stash entry, ever (the entry
    # may legitimately sit in the list for days while someone reviews it, so
    # the 6h renotify loop below would turn a known item into spam). The
    # timestamp in the name makes entries unique; alerted names are pruned
    # once the stash is gone, which can never resurrect an alert.
    stash_finding = None
    new_stashes = []
    alerted = state.get("stash_alerted", [])
    try:
        stranded = stranded_auto_stashes()
        if stranded is None:
            stranded = alerted  # keep state untouched on a failed read
        alerted = [n for n in alerted if n in stranded]
        new_stashes = [n for n in stranded if n not in alerted]
        if new_stashes:
            stash_finding = (
                "Beragadt update auto-stash a git stash listában: "
                + ", ".join(new_stashes)
                + ". Egy frissítés nem tette vissza a lokális változásokat; bennük nem commitolt munka ülhet. Átnézés: git stash list / git stash show -p."
            )
            findings.append(stash_finding)
    except Exception:
        pass  # the stash check must never take down the other checks

    fresh = [f for f in findings if now - seen.get(f, 0) > RENOTIFY_SECONDS]
    if fresh and notify(fresh):
        for f in fresh:
            seen[f] = now

    # A stash entry counts as alerted only once its notify went out; a failed
    # send leaves it pending so the next run retries instead of losing it.
    if stash_finding and stash_finding in seen:
        alerted = alerted + new_stashes

    # Drop remembered findings that no longer apply, so a recurrence alerts again.
    # The stash finding is deliberately NOT kept in `seen` across runs: once-ever
    # delivery is handled by stash_alerted, keyed on the unique entry names.
    seen = {k: v for k, v in seen.items() if k in findings and k != stash_finding}
    save_state({"seen": seen, "last_run": now, "findings": findings, "stash_alerted": alerted})

    if findings:
        print("DRIFT:\n" + "\n".join(findings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
