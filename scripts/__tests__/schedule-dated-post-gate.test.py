#!/usr/bin/env python3
"""Card 44ac3366: a raw POST /api/schedules with a dated cron is denied on the main agent; egyszeri.py, toggle, run,
PUT and a recurring cron pass; the gate's own failure never stops a Bash call.

Every case drives the real hook (scripts/hooks/schedule-dated-post-gate.py) the way Claude Code does: one JSON payload
on stdin, the decision in the exit code (2 = denied, with the card's text on stderr; 0 = allowed). The command shapes
are the ones the main agent's transcripts use (curl inline, curl with a heredoc body, Python helpers call/req/api,
urllib.request.Request, requests.post, a cron passed as its own string or built in an f-string).

Run: python3 <thisfile>   Exit 0 = all pass. In CI it runs through src/__tests__/script-tests-runner.test.ts, which
discovers every suite in this directory.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True  # the in-process import below must not leave a __pycache__ in the tree
HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "schedule-dated-post-gate.py")
MESSAGE = "egyszeri ébresztő csak az egyszeri.py-jal (utemezett-feladat-eletciklus 0.)"
URL = "http://localhost:3420/api/schedules"
AUTH = '-H "Authorization: Bearer $(cat store/.dashboard-token)" -H "Content-Type: application/json"'

failed = []
TMP = tempfile.mkdtemp(prefix="schedule-gate-test-")
ONESHOT = os.path.join(TMP, "egyszeri.py")
with open(ONESHOT, "w", encoding="utf-8") as fh:
    fh.write("# stand-in: the gate only checks that the script exists\n")
ERRLOG = os.path.join(TMP, "hook-errors.log")


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def run(stdin_text, oneshot=ONESHOT):
    env = dict(os.environ, SCHEDULE_GATE_ONESHOT_SCRIPT=oneshot, HOOK_ERRLOG_PATH=ERRLOG, PYTHONDONTWRITEBYTECODE="1")
    return subprocess.run([sys.executable, GATE], input=stdin_text, capture_output=True, text=True, env=env, timeout=30)


def bash(command, oneshot=ONESHOT):
    return run(json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}), oneshot)


def log_lines():
    if not os.path.exists(ERRLOG):
        return []
    with open(ERRLOG, encoding="utf-8") as fh:
        return fh.read().splitlines()


def denied(name, command):
    r = bash(command)
    check(f"DENY {name}", r.returncode == 2 and r.stderr.strip() == MESSAGE, f"rc={r.returncode} stderr={r.stderr[:200]!r}")


def allowed(name, command):
    r = bash(command)
    check(f"ALLOW {name}", r.returncode == 0 and r.stderr == "", f"rc={r.returncode} stderr={r.stderr[:200]!r}")


PY_HELPER = '''python3 - <<'PY'
import json, urllib.request
H = {'Authorization': 'Bearer ' + open('store/.dashboard-token').read().strip(), 'Content-Type': 'application/json'}
def call(method, path, body=None):
    req = urllib.request.Request('http://localhost:3420' + path, method=method, headers=H,
                                 data=(json.dumps(body).encode() if body is not None else None))
    with urllib.request.urlopen(req) as r:
        return r.status, r.read().decode()[:200]
%s
PY'''

print("negative: a raw create with a dated cron is denied")
denied("curl -X POST, inline -d", f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"ebreszto-0715z","prompt":"p","schedule":"15 7 9 10 *","agent":"marveen"}}'""")
denied("curl without -X, --data-binary @- with a heredoc body", f"""curl -s {URL} {AUTH} --data-binary @- <<'JSON'
{{"name":"ebreszto","prompt":"p","schedule":"5 14 21 9 *","agent":"infra"}}
JSON""")
denied("curl, escaped JSON in a double-quoted argument", f"""curl -s -X POST "{URL}" {AUTH} -d "{{\\"name\\":\\"x\\",\\"schedule\\":\\"0 6 10 10 *\\",\\"prompt\\":\\"p\\"}}\"""")
denied("curl, body written to a file in the same command", f"""cat > /tmp/s.json <<'JSON'
{{"name":"x","schedule":"30 4 12 10 *","prompt":"p"}}
JSON
curl -s -w ' HTTP %{{http_code}}' -X POST {URL} {AUTH} --data-binary @/tmp/s.json""")
denied("python call('POST', '/api/schedules', ...)", PY_HELPER % "print(call('POST', '/api/schedules', {'name': 'x', 'prompt': 'p', 'schedule': '45 5 21 9 *', 'agent': 'marveen'}))")
denied("python req('POST', path, body) with the body built earlier", PY_HELPER.replace("def call(", "def req(") % (
    "body = {\"name\": \"x\", \"prompt\": \"p\", \"schedule\": \"57 4 21 9 *\"}\nprint(req('POST', '/api/schedules', body))"))
denied("python api('/api/schedules', 'POST', body): the method as the second argument", PY_HELPER.replace("def call(method, path,", "def api(path, method,") % (
    "print(api('/api/schedules', 'POST', {'name': 'x', 'prompt': 'p', 'schedule': '10 6 21 9 *'}))"))
denied("python api(path, body): a helper given a body", '''python3 - <<'PY'
import json, urllib.request
def api(path, data):
    req = urllib.request.Request('http://localhost:3420' + path, method='POST', data=json.dumps(data).encode())
    return json.load(urllib.request.urlopen(req))
r = api('/api/schedules', {'name': 'x', 'prompt': 'p', 'schedule': '0 13 21 9 *'})
PY''')
denied("python urllib.request.Request(collection URL, data=...)", '''python3 - <<'PY'
import json, urllib.request
body = {"name": "x", "prompt": "p", "schedule": "20 19 22 9 *"}
r = urllib.request.urlopen(urllib.request.Request('http://localhost:3420/api/schedules', data=json.dumps(body).encode(), headers={}))
PY''')
denied("python requests.post", '''python3 -c "import requests; requests.post('http://localhost:3420/api/schedules', json={'name': 'x', 'prompt': 'p', 'schedule': '0 9 13 10 *'})"''')
denied("a cron passed as its own string (shell function argument)", f"""mk() {{ python3 -c 'import json,sys; print(json.dumps({{"name": sys.argv[1], "prompt": "p", "schedule": sys.argv[2]}}))' "$1" "$2" | curl -s -X POST {URL} {AUTH} --data-binary @-; }}
mk ebreszto-a "55 5 19 9 *"
mk ebreszto-b "50 7 19 9 *\"""")
denied("a cron built in an f-string (day and month literal)", PY_HELPER % (
    "import datetime\nt = datetime.datetime.utcnow()\nprint(call('POST', '/api/schedules', {'name': 'x', 'prompt': 'p', 'schedule': f\"{t.minute} {t.hour} 23 9 *\"}))"))
denied("the card's definition: day and month numbers, minute every 5", f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"x","prompt":"p","schedule":"*/5 * 9 10 *"}}'""")
denied("egyszeri.py and a raw create in the same command", f"""python3 .claude/skills/utemezett-feladat-eletciklus/scripts/egyszeri.py --name a --cron '15 7 9 10 *' --agent marveen --desc 'EGYSZERI' --prompt-file /tmp/p.txt
curl -s -X POST {URL} {AUTH} -d '{{"name":"b","prompt":"p","schedule":"20 7 9 10 *"}}'""")

print("positive: everything else passes")
allowed("egyszeri.py", "python3 .claude/skills/utemezett-feladat-eletciklus/scripts/egyszeri.py --name ebreszto --cron '15 7 9 10 *' --agent marveen --desc 'EGYSZERI 2026-10-09 07:15Z' --prompt-file /tmp/p.txt")
allowed("toggle", f"curl -s -X POST {URL}/ebreszto-0715z/toggle {AUTH}")
allowed("run", f"curl -s -X POST {URL}/ebreszto-0715z/run {AUTH}")
allowed("PUT with a dated cron", f"""curl -s -X PUT {URL}/ebreszto-0715z {AUTH} -d '{{"schedule":"15 7 9 10 *"}}'""")
allowed("curl -X PUT on the collection path itself (a PUT never creates)", f"""curl -s -X PUT {URL} {AUTH} -d '{{"name":"x","schedule":"15 7 9 10 *"}}'""")
allowed("python PUT next to a GET of the collection", PY_HELPER % (
    "print(call('GET', '/api/schedules'))\nprint(call('PUT', '/api/schedules/x', {'schedule': '15 7 9 10 *'}))"))
allowed("a recurring cron (daily)", f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"napi","prompt":"p","schedule":"0 8 * * *"}}'""")
allowed("a recurring cron (monthly: the day is a number, the month is not)", f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"havi","prompt":"p","schedule":"0 8 1 * *"}}'""")
allowed("GET of the collection filtered by a dated cron", f"""curl -s {AUTH} {URL} | python3 -c "import json,sys; d=json.load(sys.stdin); print([t['name'] for t in d if t['schedule'] == '15 7 9 10 *'])\"""")
allowed("python urllib GET with a dated cron in the printout", '''python3 - <<'PY'
import json, urllib.request
rows = json.load(urllib.request.urlopen(urllib.request.Request('http://localhost:3420/api/schedules', headers={})))
print([r for r in rows if r.get('schedule') == '15 7 9 10 *'])
PY''')
allowed("a POST to another endpoint that quotes a dated schedule", f"""curl -s {AUTH} {URL} >/dev/null; curl -s -X POST http://localhost:3420/api/messages {AUTH} -d '{{"from":"marveen","to":"infra","content":"a regi alak: {{\\"schedule\\": \\"15 7 9 10 *\\"}}"}}'""")
allowed("a print of the path is not a call", '''python3 -c "print('POST', '/api/schedules', 'x'); print({'schedule': '15 7 9 10 *'})"''')
allowed("prose with numbers is not a cron (five words, the third and fourth numbers)", f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"x","prompt":"megrendelő kéri 9 10 órára","schedule":"0 8 * * *"}}'""")
allowed("egyszeri.py next to the toggle of an old one-shot", f"""python3 .claude/skills/utemezett-feladat-eletciklus/scripts/egyszeri.py --name uj --cron '15 7 9 10 *' --agent marveen --desc 'EGYSZERI' --prompt-file /tmp/p.txt && curl -s -X POST {URL}/regi-0715z/toggle {AUTH}""")
allowed("curl -G with data is a GET", f"""curl -s -G {URL} {AUTH} --data-urlencode 'agent=marveen' | grep -c '15 7 9 10 \\*'; echo '15 7 9 10 *'""")
allowed("a get-named helper given the path and headers", """python3 - <<'PY'
import json, urllib.request
def api_get(path, headers):
    return json.load(urllib.request.urlopen(urllib.request.Request('http://localhost:3420' + path, headers=headers)))
print([t['name'] for t in api_get('/api/schedules', {}) if t['schedule'] == '15 7 9 10 *'])
PY""")
allowed("a helper given only the path (a GET)", PY_HELPER.replace("def call(method, path,", "def api(path, method='GET',") % (
    "rows = api('/api/schedules')\nprint([r for r in rows if r.get('schedule') == '15 7 9 10 *'])"))
allowed("an unrelated command", "ls -la /tmp && git status --short")
r = run(json.dumps({"tool_name": "Read", "tool_input": {"file_path": "/tmp/x"}}))
check("ALLOW a non-Bash tool payload", r.returncode == 0 and r.stderr == "", f"rc={r.returncode}")

print("the script is missing: the gate allows and logs")
before = len(log_lines())
r = bash(f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"x","prompt":"p","schedule":"15 7 9 10 *"}}'""", oneshot=os.path.join(TMP, "nincs", "egyszeri.py"))
new = log_lines()[before:]
check("ALLOW when egyszeri.py is missing", r.returncode == 0 and r.stderr == "", f"rc={r.returncode} stderr={r.stderr[:120]!r}")
check("and one log line names the cron and the missing script", len(new) == 1 and "15 7 9 10 *" in new[0] and "missing" in new[0], repr(new))

print("the default path: scripts/egyszeri.py next to the hooks directory")
default_script = os.path.join(os.path.dirname(os.path.dirname(GATE)), "egyszeri.py")
check("the default script ships in the tree (scripts/egyszeri.py)", os.path.isfile(default_script), default_script)
env = dict(os.environ, HOOK_ERRLOG_PATH=ERRLOG, PYTHONDONTWRITEBYTECODE="1")
env.pop("SCHEDULE_GATE_ONESHOT_SCRIPT", None)
r = subprocess.run([sys.executable, GATE], capture_output=True, text=True, env=env, timeout=30, input=json.dumps(
    {"tool_name": "Bash", "tool_input": {"command": f"""curl -s -X POST {URL} {AUTH} -d '{{"name":"x","prompt":"p","schedule":"15 7 9 10 *"}}'"""}}))
check("DENY a raw dated POST without the override (the default path is found)",
      r.returncode == 2 and r.stderr.strip() == MESSAGE, f"rc={r.returncode} stderr={r.stderr[:200]!r}")

print("fail-open: the gate's own failure never stops the call")
before = len(log_lines())
r = run("{not json")
new = log_lines()[before:]
check("ALLOW on a broken stdin", r.returncode == 0 and r.stderr == "", f"rc={r.returncode}")
check("and one log line says the call was allowed", len(new) == 1 and "fail-open" in new[0], repr(new))

spec = importlib.util.spec_from_file_location("gate", GATE)
gate = importlib.util.module_from_spec(spec)
os.environ["HOOK_ERRLOG_PATH"] = ERRLOG
spec.loader.exec_module(gate)


def boom(command):
    raise RuntimeError("synthetic failure inside the decision")


gate.decide = boom
before = len(log_lines())
saved_stdin = sys.stdin
sys.stdin = io.StringIO(json.dumps({"tool_name": "Bash", "tool_input": {"command": f"curl -s -X POST {URL} -d '{{\"schedule\":\"15 7 9 10 *\"}}'"}}))
try:
    gate.main()
    code = None
except SystemExit as e:
    code = e.code
finally:
    sys.stdin = saved_stdin
new = log_lines()[before:]
check("ALLOW when the decision itself raises (exit 0, not 1)", code == 0, f"exit={code!r}")
check("and one log line carries the exception", len(new) == 1 and "RuntimeError" in new[0] and "fail-open" in new[0], repr(new))

print("time: a long command is read in linear time")
filler = ("echo 'a \"b\" c' ; " * 20000) + f"""curl -s -X POST {URL} -d '{{"schedule":"15 7 9 10 *"}}'"""
t0 = time.perf_counter()
r = bash(filler)
dt = time.perf_counter() - t0
check(f"a {len(filler) // 1000} kB command is decided (denied) within 3 s", r.returncode == 2 and dt < 3.0, f"rc={r.returncode} {dt:.2f}s")

print()
if failed:
    print(f"FAILED {len(failed)}: {failed}")
    sys.exit(1)
print("all passed")
