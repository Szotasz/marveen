#!/usr/bin/env python3
"""egyszeri.py -- create a one-shot (dated-cron) schedule and everything a raw POST leaves out, in one step.

A dated cron ("15 7 9 10 *": the day and the month are fixed) is how a one-shot wake-up is written. A raw
POST /api/schedules creates the task and nothing else: the POST drops telegramChatId (without it, an agent with several
contacts gets a delivery warning on every run), forceSend has to be set on purpose (without it a wake-up waits behind a
busy pane), a sub-agent cannot disable its own one-shot later (scripts/self-pace-gate.mjs blocks /api/schedules for
it), and nothing is read back. A rule that says "do all of this" is known and still skipped; this script makes it
mechanical, and scripts/hooks/schedule-dated-post-gate.py denies the main agent's raw dated POST.

Usage (from anywhere; the install is the directory above scripts/):
  python3 scripts/egyszeri.py --name NAME --cron 'M H D Mo *' --agent AGENT --desc 'ONE-SHOT ...' \
      --prompt-file FILE [--type heartbeat] [--skip-if-busy] [--no-force-send] [--telegram-chat-id ID] \
      [--cleanup-by OWN_LATER_ONESHOT] [--dry-run]

Rules enforced (a refusal writes nothing):
  - the cron is dated (M H D Mo *, all numbers) and in the future (UTC, this year);
  - the prompt and the description carry no Cyrillic homoglyphs and no en/em dashes;
  - the main agent's own one-shot: its prompt contains '/toggle' (its last step disables itself);
  - any other agent: its prompt does not call /api/schedules (the self-pace gate would stop that step), and
    --cleanup-by names an existing, enabled, later one-shot of the main agent: a CLEANUP line is appended to that
    task's prompt, so the main agent disables this one after it fired.
Also: forceSend is the default (--no-force-send opts out, never for a time-bound wake-up); telegramChatId is set with
a PUT after the POST ('none' by default: the prompt names its own recipient); if the install keeps a schedule registry
(store/schedule-registry.json, an optional audit file), the entry is merged into its "known" map after a backup.
Settings: the dashboard base MARVEEN_API_BASE, else http://localhost:<port> with MARVEEN_WEB_PORT, WEB_PORT or the
install .env (default 3420); the token MARVEEN_TOKEN_FILE, else store/.dashboard-token; the main agent MAIN_AGENT_ID
or the install .env (default "marveen").
Exit codes: 0 ok, 1 refused (nothing written), 2 written half-way (the schedule exists, a later step failed).
"""
import argparse
import datetime
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "scheduled-tasks")
REGISTRY = os.path.join(ROOT, "store", "schedule-registry.json")


def install_setting(name, default):
    v = os.environ.get(name)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return default


MAIN = install_setting("MAIN_AGENT_ID", "marveen")
API = os.environ.get("MARVEEN_API_BASE") or "http://localhost:%s" % (
    os.environ.get("MARVEEN_WEB_PORT") or install_setting("WEB_PORT", "3420"))
TOKEN_FILE = os.environ.get("MARVEEN_TOKEN_FILE") or os.path.join(ROOT, "store", ".dashboard-token")
TOKEN = ""


def refuse(msg):
    print("REFUSED:", msg)
    sys.exit(1)


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
    req = urllib.request.Request(API.rstrip("/") + path, data=data, method=method, headers={
        "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "null")


def schedules():
    s = call("GET", "/api/schedules")  # the list carries each task's prompt
    return {x["name"]: x for x in (s if isinstance(s, list) else s.get("schedules", s))}


def cron_dt(cron):
    p = cron.split()
    if len(p) != 5 or p[4] != "*" or not all(x.isdigit() for x in p[:4]):
        return None
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        return datetime.datetime(now.year, int(p[3]), int(p[2]), int(p[1]), int(p[0]), tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def task_config(name):
    with open(os.path.join(TASKS_DIR, name, "task-config.json"), encoding="utf-8") as f:
        return json.load(f)


def registry_merge(name, entry):
    """Merge one entry into the optional registry's "known" map: backup first, atomic replace, read back."""
    shutil.copy2(REGISTRY, REGISTRY + ".bak." + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    with open(REGISTRY, encoding="utf-8") as f:
        reg = json.load(f)
    reg.setdefault("known", {}).setdefault(name, {}).update(entry)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(REGISTRY))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, os.stat(REGISTRY).st_mode & 0o777)
    os.replace(tmp, REGISTRY)


def main():
    global TOKEN
    a = argparse.ArgumentParser(description="Create a one-shot (dated-cron) schedule in one step.")
    a.add_argument("--name", required=True)
    a.add_argument("--cron", required=True)
    a.add_argument("--agent", required=True)
    a.add_argument("--desc", required=True)
    a.add_argument("--prompt-file", required=True)
    a.add_argument("--type", default="heartbeat")
    a.add_argument("--skip-if-busy", action="store_true")
    a.add_argument("--force-send", action="store_true", help="kept for compatibility; forceSend is the default")
    a.add_argument("--no-force-send", action="store_true", help="opt out of forceSend (never for a time-bound wake-up)")
    a.add_argument("--cleanup-by", help="an enabled, later one-shot of the main agent that disables this one")
    a.add_argument("--telegram-chat-id", default="none")
    a.add_argument("--dry-run", action="store_true")
    o = a.parse_args()
    force = not o.no_force_send

    with open(o.prompt_file, encoding="utf-8") as f:
        prompt = f.read()
    bad = [hex(ord(c)) for c in prompt + o.desc if 0x0370 <= ord(c) <= 0x04FF or ord(c) in (0x2013, 0x2014)]
    if bad:
        refuse(f"homoglyph or dash in the prompt or the description: {bad[:5]}")
    dt = cron_dt(o.cron)
    if dt is None:
        refuse(f"the cron is not dated (M H D Mo *): {o.cron!r}")
    if dt <= datetime.datetime.now(datetime.timezone.utc):
        refuse(f"the cron time has already passed: {dt:%Y-%m-%d %H:%MZ}")
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            TOKEN = f.read().strip()
    except OSError as e:
        refuse(f"no dashboard token ({TOKEN_FILE}): {e}")
    S = schedules()
    if o.name in S:
        refuse(f"schedule {o.name} already exists")
    keep_registry = os.path.isfile(REGISTRY)
    if keep_registry:
        with open(REGISTRY, encoding="utf-8") as f:
            if o.name in json.load(f).get("known", {}):
                refuse(f"the registry already has {o.name}")
    if o.agent == MAIN:
        if "/toggle" not in prompt:
            refuse("the main agent's own one-shot has no /toggle step (its last step must disable itself)")
    else:
        if "/api/schedules" in prompt:
            refuse("a sub-agent prompt calls /api/schedules; the self-pace gate blocks that step")
        c = S.get(o.cleanup_by or "")
        if not c:
            refuse(f"a sub-agent one-shot needs --cleanup-by <an existing later one-shot of {MAIN}>")
        cdt = cron_dt(c.get("schedule", ""))
        if c.get("agent") != MAIN or not c.get("enabled") or cdt is None or cdt <= dt:
            refuse(f"--cleanup-by {o.cleanup_by} must be an enabled {MAIN} one-shot running after {dt:%m-%d %H:%MZ}")
    print(f"OK to create: {o.name} {o.cron} ({dt:%Y-%m-%d %H:%MZ}) agent={o.agent} skipIfBusy={o.skip_if_busy} "
          f"forceSend={force} registry={'yes' if keep_registry else 'none kept'}")
    if o.dry_run:
        return

    payload = {"name": o.name, "description": o.desc, "prompt": prompt, "schedule": o.cron, "agent": o.agent,
               "type": o.type, "skipIfBusy": bool(o.skip_if_busy), "forceSend": bool(force)}
    resp = call("POST", "/api/schedules", payload)
    if not (isinstance(resp, dict) and resp.get("ok") is True):
        refuse(f"POST not ok: {resp}")
    try:
        if keep_registry:
            note = o.desc + (f" | disabled by {o.cleanup_by}" if o.agent != MAIN else "")
            registry_merge(o.name, {"agent": o.agent, "creator": MAIN, "one_shot": True, "expired": False,
                                    "created_at": int(time.time()), "cron": o.cron, "note": note})
        if o.agent != MAIN:
            cp = schedules()[o.cleanup_by]["prompt"]
            line = (f"\nCLEANUP: if {o.name} fired (its /runs show it) AND its task-config enabled is not false (the toggle "
                    f"flips: it would switch a disabled task back on), toggle it and measure enabled:false on disk"
                    + (", then mark it expired in the registry (merge)" if keep_registry else "")
                    + ". If it did not fire, do NOT disable it: report it.")
            r = call("PUT", f"/api/schedules/{o.cleanup_by}", {"prompt": cp + line})
            if not (isinstance(r, dict) and r.get("ok") is True):
                raise RuntimeError(f"cleanup PUT not ok: {r}")
        r = call("PUT", f"/api/schedules/{o.name}", {"telegramChatId": o.telegram_chat_id})
        if not (isinstance(r, dict) and r.get("ok") is True):
            raise RuntimeError(f"telegramChatId PUT not ok: {r}")
    except Exception as e:  # noqa: BLE001 -- any later step: the schedule exists, say so
        print("HALF-WRITTEN: the schedule was created, a later step failed:", e)
        sys.exit(2)

    S = schedules()
    cfg = task_config(o.name)
    regok = True
    if keep_registry:
        with open(REGISTRY, encoding="utf-8") as f:
            regok = o.name in json.load(f).get("known", {})
    cleanok = o.agent == MAIN or o.name in S[o.cleanup_by]["prompt"]
    print(f"READBACK api_enabled={S[o.name]['enabled']} disk_enabled={cfg.get('enabled')} "
          f"disk_forceSend={cfg.get('forceSend')} disk_telegramChatId={cfg.get('telegramChatId')} "
          f"registry={regok if keep_registry else 'none kept'} cleanup={cleanok}")
    if force and cfg.get("forceSend") is not True:
        print("ERROR: forceSend is not set on disk")
        sys.exit(2)
    if cfg.get("telegramChatId") != o.telegram_chat_id:
        print("ERROR: telegramChatId is not set on disk")
        sys.exit(2)
    if not (S[o.name]["enabled"] and cfg.get("enabled") and regok and cleanok):
        sys.exit(2)


if __name__ == "__main__":
    main()
