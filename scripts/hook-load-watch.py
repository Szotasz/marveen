#!/usr/bin/env python3
"""Out-of-process watcher: do the PreToolUse security hooks still LOAD? (card 723bbb70, point (3))

THE HOLE IT COVERS. Claude Code reads a PreToolUse hook's exit code 2 as "block"; ANY other non-zero
exit is a non-blocking error and the tool call goes through. Measured 2026-10-08 (af12a1d3, on a throwaway
copy): when a gate FILE, or a module it imports at load time, is broken (a syntax error), every security
hook exits 1 -- the gate stands open. The command wrapper of 723bbb70 (1)-(2)
turns that exit into 2, so the gate closes instead -- and then a broken bash-egress-parser blocks every
Bash call of every sub-agent, which can then not even send a message to say so. Either way the failure
is silent where it happens. It has to be measured from outside, on the main agent's side, by a timer.

WHAT IT MEASURES. The hook list is derived at run time from the settings, never from a list file
shared with the wrapper: the PreToolUse union of <root>/.claude/settings.json and
<root>/agents/*/.claude/settings.json. A script that any of them calls in the "...; exit 0" helper
form is deliberately non-blocking and is left out (on this install: channel-image-resize and the two
memory-frontmatter gates). Each distinct command is run the way Claude Code runs it (/bin/sh -c,
CLAUDE_PROJECT_DIR set, cwd at the root, the hook's own timeout) with a HARMLESS call on stdin: a Bash
`true` when one of its matchers takes Bash -- so a gate that loads a dependency only on its Bash
branch is reached too -- otherwise a tool name no hook acts on. A loadable gate lets that call through
(exit 0, no deny). Anything else is a finding:
  OPEN    exit code other than 0 and 2 (a load error, a missing module, a signal): the call passes,
          the gate does not guard;
  CLOSED  exit 2, or a deny/block decision on stdout, for a harmless call: the gate blocks everything
          it is wired to (a load error behind the wrapper, a missing interpreter, a missing file);
  TIMEOUT the hook did not finish within its own timeout.
READ-ONLY. PYTHONDONTWRITEBYTECODE is set, and on this install the probe calls of all twelve commands
wrote nothing (strace, 2026-10-08). A hook's OWN designed logging still runs when its state calls for
it -- outgoing-copy-gate logs a missing or broken name-rules file on every call -- as on any real call.
LOCAL DEPENDENCIES (card 06c9aa79). A gate can load a module only on its own narrow path -- a signal gate loads
destructive-gate.py only for a command that sends a signal -- and the harmless call never reaches it: with that
module broken, the wrapped gate blocks every such command and nobody is told. So the gates' local dependencies
(files under <root>/scripts) are derived from their source at run time, transitively: python imports (resolved
in the importing file's directory, then scripts/lib, then a unique file of that name under scripts/) and quoted
.py/.mjs/.cjs/.js file names that exist (node's relative imports, destructive-gate.py, outgoing-copy-gate.py).
Each one is loaded on its own WITHOUT running a main -- python -B under a module name other than __main__,
node's import() from -e (a gate starts its main only as the entry script) -- with stdin closed, a timeout and
the process-group kill. A module that does not load is an IMPORT finding, named with the gates that reach it,
in the same alert.
WHAT IT DOES NOT SEE. A dependency whose path is computed rather than written as a literal (or a node
specifier without its extension). A module that runs a main of its own when imported is not missed but
reported (it reads an empty stdin): such a module should guard its main.

THE ALERT goes to the main agent through the dashboard API (/api/messages), sent as `hook-load-watch`
when SYSTEM_SENDER_IDS lists it, otherwise as MAIN_AGENT_ID -- the sender rule of the scripts/channels.sh
guards: an id the API does not know is refused with 403 "unknown agent". Delivery is honest: only an
HTTP 2xx answer carrying a message id counts as sent; a failed POST is logged and the alert state is
not advanced, so the next tick tries again. One alert per changed set of findings, repeated every
HOOK_LOAD_WATCH_COOLDOWN seconds while it lasts, and one notice when every hook loads again.
Every tick stamps <state>/.hook-load-watch, so a watcher that stopped running is told apart from a
healthy install by the stamp's age.

Usage:
  scripts/hook-load-watch.py          # one tick (timer): measure, alert on a change, stamp
  scripts/hook-load-watch.py --check  # measure and print; no alert, no stamp, no state written
Exit codes: 0 measured (tick: findings, if any, were alerted or are within the repeat window);
1 --check: at least one finding / tick: findings whose alert could NOT be delivered;
3 nothing to measure (no settings readable, or no hook derived).
Env:
  HOOK_LOAD_WATCH_ROOT          install root (default: this script's parent's parent)
  HOOK_LOAD_WATCH_STATE_DIR     stamp and alert state (default <root>/store)
  HOOK_LOAD_WATCH_TO            alert recipient (default .env MAIN_AGENT_ID, then marveen)
  HOOK_LOAD_WATCH_FROM          alert sender (default: the rule above)
  HOOK_LOAD_WATCH_API           dashboard base URL (default http://localhost:<.env WEB_PORT or 3420>)
  HOOK_LOAD_WATCH_ALERT_DRYRUN  1: print "ALERT_DRYRUN: <message>" instead of the POST (tests)
  HOOK_LOAD_WATCH_COOLDOWN      seconds between repeats of an unchanged alert (default 3600)
  HOOK_LOAD_WATCH_IMPORT_TIMEOUT  seconds for one dependency's load (default 20)
"""
import glob
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.environ.get("HOOK_LOAD_WATCH_ROOT")
                       or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_DIR = os.environ.get("HOOK_LOAD_WATCH_STATE_DIR") or os.path.join(ROOT, "store")
STAMP = os.path.join(STATE_DIR, ".hook-load-watch")
STATE = os.path.join(STATE_DIR, ".hook-load-watch.json")
SENDER_ID = "hook-load-watch"
DEFAULT_TIMEOUT = 60          # seconds, Claude Code's default for a hook without its own timeout
PROBE_TOOL = "HookLoadProbe"  # a tool name no hook acts on
SCRIPT_EXT = r"(?:py|mjs|cjs|js|sh)"


def cooldown():
    raw = os.environ.get("HOOK_LOAD_WATCH_COOLDOWN", "")
    # a malformed or zero override must not turn the repeat into an every-tick alert storm
    return int(raw) if raw.isdigit() and int(raw) > 0 else 3600


def log(msg):
    print("%s [hook-load-watch] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg), flush=True)


def read_env_keys(keys):
    """The named keys of <root>/.env, read WITHOUT sourcing the file (it carries tokens)."""
    out = {}
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
            for line in fh:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep and k in keys and k not in out:
                    out[k] = v.strip()
    except OSError:
        pass
    return out


# --- derivation -----------------------------------------------------------------------------------

def settings_files():
    files = [os.path.join(ROOT, ".claude", "settings.json")]
    files += sorted(glob.glob(os.path.join(ROOT, "agents", "*", ".claude", "settings.json")))
    return files


def script_paths(command):
    """The script files a hook command runs, as absolute paths: $CLAUDE_PROJECT_DIR resolved to the root,
    then every absolute path with a script extension (the interpreter paths have none)."""
    text = command.replace("${CLAUDE_PROJECT_DIR}", ROOT).replace("$CLAUDE_PROJECT_DIR", ROOT)
    return sorted({os.path.normpath(m) for m in re.findall(r"(/[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*\." + SCRIPT_EXT + r")(?![A-Za-z0-9_])", text)})


def is_helper_form(command):
    """The deliberately non-blocking helper form: the command ends in `exit 0` (possibly inside bash -c '...')."""
    return re.search(r";\s*exit\s+0\s*'?\s*$", command.strip()) is not None


def derive():
    """Returns (commands, helpers, unreadable): commands maps a command string to its scripts, matchers,
    timeout and the settings owners that call it."""
    entries, unreadable = [], []
    main_path = os.path.join(ROOT, ".claude", "settings.json")
    for path in settings_files():
        owner = "MAIN" if path == main_path else path.split(os.sep)[-3]
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            if owner == "MAIN":
                unreadable.append((path, owner, "the file is missing"))
            continue
        except (OSError, ValueError) as exc:
            unreadable.append((path, owner, "%s: %s" % (type(exc).__name__, first_line(str(exc)))))
            continue
        for entry in (data.get("hooks") or {}).get("PreToolUse") or []:
            for hook in entry.get("hooks") or []:
                cmd = hook.get("command")
                if hook.get("type", "command") != "command" or not isinstance(cmd, str):
                    continue
                entries.append((owner, entry.get("matcher") or "", cmd, hook.get("timeout")))
    helpers = set()
    for _, _, cmd, _ in entries:
        if is_helper_form(cmd):
            helpers.update(script_paths(cmd))
    commands, skipped = {}, set()
    for owner, matcher, cmd, timeout in entries:
        scripts = script_paths(cmd)
        if not scripts:
            skipped.add(cmd)
            continue
        if set(scripts) & helpers:
            continue
        rec = commands.setdefault(cmd, {"scripts": scripts, "matchers": set(), "owners": set(), "timeout": None})
        rec["matchers"].add(matcher)
        rec["owners"].add(owner)
        if isinstance(timeout, (int, float)) and timeout > 0:
            rec["timeout"] = max(rec["timeout"] or 0, timeout)
    return commands, helpers, unreadable, skipped


# --- local dependencies (06c9aa79) ------------------------------------------------------------------

PY_IMPORT = re.compile(r"^[ \t]*(?:from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b"
                       r"|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*(?:[ \t]+as[ \t]+\w+)?)*))", re.M)
FILE_LIT = re.compile(r"""["']([A-Za-z0-9_./@+-]*[A-Za-z0-9_@+-]\.(?:py|mjs|cjs|js))["']""")
STDLIB = frozenset(getattr(sys, "stdlib_module_names", ()))
PY_IMPORT_PROBE = ("import importlib.util, os, sys\n"
                   "p = sys.argv[1]\n"
                   "sys.path.insert(0, os.path.dirname(p))\n"
                   "s = importlib.util.spec_from_file_location('_hook_load_watch_dependency', p)\n"
                   "m = importlib.util.module_from_spec(s)\n"
                   "s.loader.exec_module(m)\n")


def import_timeout():
    raw = os.environ.get("HOOK_LOAD_WATCH_IMPORT_TIMEOUT", "")
    return int(raw) if raw.isdigit() and int(raw) > 0 else 20


def python_index():
    """Every .py under <root>/scripts by module name (node_modules, __pycache__ and test dirs left out)."""
    index = {}
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "scripts")):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", "__pycache__", "__tests__")]
        for name in filenames:
            if name.endswith(".py") and name[:-3].isidentifier():
                index.setdefault(name[:-3], []).append(os.path.join(dirpath, name))
    return index


def local_deps(path, index):
    """The local files one script loads: its python imports and the quoted file names that exist."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return set()
    here, scripts, found = os.path.dirname(path), os.path.join(ROOT, "scripts"), set()

    def add(cand):
        cand = os.path.normpath(cand)
        if cand != path and os.path.isfile(cand) and os.path.commonpath([scripts, cand]) == scripts:
            found.add(cand)
            return True
        return False

    if path.endswith(".py"):
        for m in PY_IMPORT.finditer(text):
            names = [m.group(1)] if m.group(1) else [part.split()[0] for part in m.group(2).split(",") if part.strip()]
            for name in (n.split(".")[0] for n in names):
                if name in STDLIB:
                    continue
                for cand in (os.path.join(here, name + ".py"), os.path.join(here, name, "__init__.py"),
                             os.path.join(scripts, "lib", name + ".py")):
                    if add(cand):
                        break
                else:
                    if len(index.get(name, [])) == 1:
                        add(index[name][0])
    for m in FILE_LIT.finditer(text):
        for cand in (os.path.join(here, m.group(1)), os.path.join(ROOT, m.group(1))):
            if add(cand):
                break
    return found


def dependency_map(commands):
    """Each local dependency of the derived gate scripts -> the gates (relative) that reach it, transitively,
    and the owners of their commands."""
    index, deps = python_index(), {}
    for rec in commands.values():
        for gate in rec["scripts"]:
            if not gate.endswith((".py", ".mjs", ".cjs", ".js")):
                continue
            seen, todo = {gate}, [gate]
            while todo:
                for dep in sorted(local_deps(todo.pop(), index)):
                    if dep not in seen:
                        seen.add(dep)
                        todo.append(dep)
                        d = deps.setdefault(dep, {"gates": set(), "owners": set()})
                        d["gates"].add(os.path.relpath(gate, ROOT))
                        d["owners"].update(rec["owners"])
    return deps


def import_probe(path):
    """Load ONE dependency on its own, without running a main: OK, IMPORT (it does not load) or TIMEOUT."""
    if path.endswith(".py"):
        argv = ["python3", "-B", "-c", PY_IMPORT_PROBE, path]
    else:
        argv = ["node", "--input-type=module", "-e", "await import(%s)" % json.dumps(pathlib.Path(path).as_uri())]
    timeout = import_timeout()
    try:
        proc = subprocess.Popen(argv, cwd=ROOT, env=dict(os.environ, CLAUDE_PROJECT_DIR=ROOT), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        return {"class": "IMPORT", "rc": None, "detail": "%s: %s" % (type(exc).__name__, argv[0])}
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return {"class": "TIMEOUT", "rc": None, "detail": "not loaded within %ss" % timeout}
    rc = proc.returncode
    detail = "" if rc == 0 else (error_detail(err.decode("utf-8", "replace")) or first_line(out.decode("utf-8", "replace")))
    return {"class": "OK" if rc == 0 else "IMPORT", "rc": rc, "detail": detail}


def takes_bash(matchers):
    for m in matchers:
        if m in ("", "*") or m == "Bash":
            return True
        try:
            if re.fullmatch(m, "Bash"):
                return True
        except re.error:
            continue
    return False


# --- probe ----------------------------------------------------------------------------------------

def probe_payload(bash):
    payload = {"session_id": "hook-load-watch", "transcript_path": "", "cwd": ROOT,
               "hook_event_name": "PreToolUse", "tool_name": PROBE_TOOL, "tool_input": {}}
    if bash:
        payload["tool_name"] = "Bash"
        payload["tool_input"] = {"command": "true", "description": "hook load probe"}
    return payload


def denies(stdout):
    try:
        out = json.loads(stdout)
    except ValueError:
        return False
    if not isinstance(out, dict):
        return False
    hso = out.get("hookSpecificOutput") if isinstance(out.get("hookSpecificOutput"), dict) else {}
    return out.get("decision") == "block" or hso.get("permissionDecision") == "deny" or out.get("continue") is False


def first_line(text):
    for line in (text or "").splitlines():
        line = re.sub(r"[\x00-\x1f\x7f]", " ", line).strip()
        if line:
            return line[:200]
    return ""


def error_detail(text):
    """The place and the cause. Node prints the file:line first; a Python traceback starts with "Traceback ...",
    its last 'File "...", line N' line is the place (for a broken import: the broken module, not the gate) and
    its last "...Error: ..." line is the cause."""
    # an absolute path or file:// URL shrinks to its file name: the cause, not the directory, has to fit the line
    text = re.sub(r"(?:file://)?/[^\s:'\"]*/([^/\s:'\"]+)", r"\1", text or "")
    head = first_line(text)
    if head.startswith("Traceback"):
        places = [l for l in text.splitlines() if re.match(r'\s*File "[^"<]+", line \d+', l)]
        if places:
            head = first_line(places[-1])
    errs = [l.strip() for l in text.splitlines() if re.match(r"\s*[A-Za-z_.]*(Error|Exception)\b", l)]
    tail = re.sub(r"[\x00-\x1f\x7f]", " ", errs[-1])[:160] if errs else ""
    return head if not tail or tail == head else "%s | %s" % (head[:100], tail)


def probe(command, rec):
    bash = takes_bash(rec["matchers"])
    env = dict(os.environ, CLAUDE_PROJECT_DIR=ROOT, PYTHONDONTWRITEBYTECODE="1")
    timeout = rec["timeout"] or DEFAULT_TIMEOUT
    started = time.monotonic()
    proc = subprocess.Popen(["/bin/sh", "-c", command], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = proc.communicate(json.dumps(probe_payload(bash)).encode(), timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        out, err = proc.communicate()
        return {"class": "TIMEOUT", "rc": None, "detail": "no answer within %ss" % timeout, "tool": "Bash" if bash else PROBE_TOOL}
    rc = proc.returncode
    out_s, err_s = out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    if rc == 0 and not denies(out_s):
        klass = "OK"
    elif rc == 0 or rc == 2:
        klass = "CLOSED"
    else:
        klass = "OPEN"
    return {"class": klass, "rc": rc, "detail": error_detail(err_s) or first_line(out_s),
            "tool": "Bash" if bash else PROBE_TOOL, "ms": int((time.monotonic() - started) * 1000)}


def measure():
    commands, helpers, unreadable, skipped = derive()
    results = []
    for path, owner, why in unreadable:
        # a settings file Claude Code cannot read loads none of its hooks: that is a finding too
        results.append({"class": "SETTINGS", "rc": None, "detail": why, "tool": "-", "command": "",
                        "scripts": [os.path.relpath(path, ROOT)], "owners": [owner]})
    for cmd, rec in commands.items():
        res = probe(cmd, rec)
        res.update(command=cmd, scripts=[os.path.relpath(s, ROOT) for s in rec["scripts"]],
                   owners=sorted(rec["owners"]))
        results.append(res)
    for cmd in sorted(skipped):
        log("left out, no script file in the command: %s" % first_line(cmd)[:120])
    # 06c9aa79: the gates' local dependencies, each loaded on its own; their results come after the commands'
    for dep, d in sorted(dependency_map(commands).items()):
        res = import_probe(dep)
        res.update(kind="import", command="", scripts=[os.path.relpath(dep, ROOT)], owners=sorted(d["owners"]),
                   tool="import (<- %s)" % ", ".join(sorted(d["gates"])))
        results.append(res)
    return results, sorted(os.path.relpath(h, ROOT) for h in helpers)


# --- report and alert -----------------------------------------------------------------------------

def owners_text(owners):
    agents = [o for o in owners if o != "MAIN"]
    parts = (["a fő ügynök"] if "MAIN" in owners else []) + (["%d ügynök" % len(agents)] if agents else [])
    return " és ".join(parts)


MEANING = {"SETTINGS": "OLVASHATATLAN BEÁLLÍTÁS (a hookjai nem mérhetők, és a Claude Code sem tölti be őket)",
           "OPEN": "NYITVA (nem tiltó hibakód: a hívás átmegy, a kapu nem véd)",
           "CLOSED": "ZÁRVA (egy ártalmatlan hívást is tilt: minden ilyen eszközhívás áll)",
           "TIMEOUT": "IDŐTÚLLÉPÉS (a saját határidején belül nem válaszolt)",
           "IMPORT": "NEM TÖLTHETŐ BE (egy kapu helyi függősége: ahol a kapu betölti, ott hibázik, a burkolóval tilt)"}


def findings_of(results):
    return [r for r in results if r["class"] != "OK"]


def fingerprint(findings):
    return sorted("%s|%s|%s" % (",".join(f["scripts"]), f["class"], f["rc"]) for f in findings)


def alert_text(findings, results):
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    imp_total = sum(1 for r in results if r.get("kind") == "import")
    imp_found = sum(1 for f in findings if f.get("kind") == "import")
    cmd_total, cmd_found = len(results) - imp_total, len(findings) - imp_found
    parts = ["%d/%d PreToolUse biztonsági hook-parancs nem tölt be rendesen" % (cmd_found, cmd_total)] if cmd_found or not imp_found else []
    if imp_found:
        parts.append("%d/%d helyi kapu-függőség nem tölthető be" % (imp_found, imp_total))
    lines = ["[HOOK-FIGYELŐ] %s (mérve %s, %s):" % (", ".join(parts), when, ROOT)]
    for f in findings[:12]:
        lines.append("- %s (%s): %s, rc %s, próba: %s%s" % (
            ", ".join(f["scripts"]), owners_text(f["owners"]), MEANING[f["class"]], f["rc"], f["tool"],
            (": " + f["detail"][:160]) if f["detail"] else ""))
    if len(findings) > 12:
        lines.append("- ... és még %d (a teljes lista: python3 scripts/hook-load-watch.py --check)" % (len(findings) - 12))
    lines.append("Teendő: a hook-fájl és a betöltött moduljai (git diff, a legutóbbi módosítás); újramérés: "
                 "python3 scripts/hook-load-watch.py --check")
    lines.append("Ugyanerről legközelebb a változáskor vagy %d perc múlva szólok." % (cooldown() // 60))
    return "\n".join(lines)


def az(n):
    """The Hungarian article before a number, by how it is read out: az 1 (egy), az 5 (öt), az 50-59 (ötven),
    az 500-599 (ötszáz), az 1000-1999 (ezer); a for the rest."""
    s = str(n)
    return "az" if s == "1" or s[0] == "5" or (len(s) == 4 and s[0] == "1") else "a"


def recovered_text(previous, results):
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    imp_total = sum(1 for r in results if r.get("kind") == "import")
    total = len(results) - imp_total
    deps = (", és mind %s %d helyi kapu-függőség is" % (az(imp_total), imp_total)) if imp_total else ""
    return ("[HOOK-FIGYELŐ] HELYREÁLLT: mind %s %d PreToolUse biztonsági hook-parancs betölt%s (mérve %s). "
            "A %s óta jelzett hiba lezárható." % (az(total), total, deps, when, previous.get("first_seen", "?")))


def send(content):
    """Honest delivery: True only for an HTTP 2xx answer that carries a message id."""
    if os.environ.get("HOOK_LOAD_WATCH_ALERT_DRYRUN") == "1":
        print("ALERT_DRYRUN: " + content, flush=True)
        return True
    env = read_env_keys(("MAIN_AGENT_ID", "SYSTEM_SENDER_IDS", "WEB_PORT"))
    main_id = env.get("MAIN_AGENT_ID") or "marveen"
    listed = {re.sub(r"[^A-Za-z0-9_-]", "", e) for e in env.get("SYSTEM_SENDER_IDS", "").split(",")}
    sender = os.environ.get("HOOK_LOAD_WATCH_FROM") or (SENDER_ID if SENDER_ID in listed else main_id)
    to = os.environ.get("HOOK_LOAD_WATCH_TO") or main_id
    port = env.get("WEB_PORT", "") if env.get("WEB_PORT", "").isdigit() else "3420"
    base = (os.environ.get("HOOK_LOAD_WATCH_API") or "http://localhost:%s" % port).rstrip("/")
    try:
        with open(os.path.join(ROOT, "store", ".dashboard-token"), encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        log("ALERT NOT SENT: no dashboard token (%s)" % type(exc).__name__)
        return False
    req = urllib.request.Request(base + "/api/messages", method="POST",
                                 data=json.dumps({"from": sender, "to": to, "content": content}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            code, body = resp.status, resp.read(2000)
    except urllib.error.HTTPError as exc:
        log("ALERT NOT SENT: HTTP %s (from=%s to=%s)" % (exc.code, sender, to))
        return False
    except (urllib.error.URLError, OSError) as exc:
        log("ALERT NOT SENT: %s (from=%s to=%s)" % (type(exc).__name__, sender, to))
        return False
    try:
        msg_id = json.loads(body).get("id")
    except (ValueError, AttributeError):
        msg_id = None
    if 200 <= code < 300 and msg_id is not None:
        log("alert sent: id=%s from=%s to=%s" % (msg_id, sender, to))
        return True
    log("ALERT NOT SENT: HTTP %s without a message id (from=%s to=%s)" % (code, sender, to))
    return False


def load_state():
    try:
        with open(STATE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_file(path, text):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError as exc:
        log("cannot write %s (%s)" % (path, type(exc).__name__))


def tick(results):
    findings = findings_of(results)
    now = int(time.time())
    state = load_state()
    rc = 0
    if findings:
        fp = fingerprint(findings)
        due = state.get("fingerprint") != fp or now - int(state.get("last_alert") or 0) >= cooldown()
        if due:
            if send(alert_text(findings, results)):
                state = {"fingerprint": fp, "last_alert": now,
                         "first_seen": state.get("first_seen") if state.get("fingerprint") else
                         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}
                write_file(STATE, json.dumps(state))
            else:
                rc = 1
    elif state.get("fingerprint"):
        if send(recovered_text(state, results)):
            write_file(STATE, json.dumps({}))
        else:
            rc = 1
    write_file(STAMP, "%s %d/%d ok\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                                         len(results) - len(findings), len(results)))
    return rc


def main(argv):
    check = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        print("usage: hook-load-watch.py [--check]", file=sys.stderr)
        return 3
    results, helpers = measure()
    if not results:
        log("NOTHING TO MEASURE: no PreToolUse hook command derived from the settings under %s" % ROOT)
        return 3
    for r in results:
        log("%-7s rc=%-4s %s (%s) probe=%s%s" % (r["class"], r["rc"], ", ".join(r["scripts"]), owners_text(r["owners"]),
                                                   r["tool"], (" | " + r["detail"]) if r["class"] != "OK" and r["detail"] else ""))
    probed = [r for r in results if r["class"] != "SETTINGS" and r.get("kind") != "import"]
    log("derived %d commands, %d scripts; helpers left out: %s; findings: %d"
        % (len(probed), len({s for r in probed for s in r["scripts"]}), ", ".join(helpers) or "-",
           len(findings_of(results))))
    imports = [r for r in results if r.get("kind") == "import"]
    log("local dependencies: %d loaded on their own, without a main; failing: %d" % (len(imports), len(findings_of(imports))))
    if check:
        return 1 if findings_of(results) else 0
    return tick(results)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
