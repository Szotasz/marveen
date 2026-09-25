#!/usr/bin/env python3
"""owner-url-allow.py: a link the OWNER sends in a DM is added to the
quarantine allowlist; groups, other senders, IP literals, several paired
contacts and the disabled (default) state add nothing."""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hooks", "owner-url-allow.py")
fails = 0


def run(allow_from, prompt, env_extra):
    with tempfile.TemporaryDirectory() as d:
        cwd = os.path.join(d, "work")
        acc_dir = os.path.join(cwd, ".claude", "channels", "telegram")
        os.makedirs(acc_dir)
        with open(os.path.join(acc_dir, "access.json"), "w") as f:
            json.dump({"allowFrom": allow_from}, f)
        al = os.path.join(d, "egress-allowlist.json")
        with open(al, "w") as f:
            json.dump({"domains": [], "quarantine_domains": ["example.org"]}, f)
        env = dict(os.environ, HOME=d, OWNER_URL_ALLOWLIST_PATH=al, MAIN_AGENT_ID="marveen")
        for k in ("MARVEEN_OWNER_URL_ALLOW", "MARVEEN_OWNER_URL_SENDERS", "MARVEEN_OWNER_URL_ANY_PAIRED"):
            env.pop(k, None)
        env.update(env_extra)
        r = subprocess.run([sys.executable, HOOK], input=json.dumps({"cwd": cwd, "prompt": prompt}),
                           capture_output=True, text=True, env=env, timeout=20)
        with open(al) as f:
            return r.returncode, json.load(f)["quarantine_domains"]


def dm(user, text, chat=None):
    return (f'<channel source="plugin:telegram:telegram" chat_id="{chat or user}" '
            f'message_id="1" user="x" user_id="{user}" ts="t">{text}</channel>')


def check(name, got, want):
    global fails
    ok = got == want
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- got {got!r}, want {want!r}"))
    fails += 0 if ok else 1


ON = {"MARVEEN_OWNER_URL_ALLOW": "1"}
check("disabled by default", run(["111"], dm("111", "see https://news.example.com/a"), {})[1], ["example.org"])
check("owner DM adds the host", run(["111"], dm("111", "see https://news.example.com/a?x=1"), ON)[1],
      ["example.org", "news.example.com"])
check("group message ignored", run(["111"], dm("111", "https://news.example.com", chat="-1001"), ON)[1], ["example.org"])
check("other sender ignored", run(["111"], dm("222", "https://news.example.com"), ON)[1], ["example.org"])
check("IP literal / localhost ignored", run(["111"], dm("111", "http://10.0.0.1/x http://localhost:8080/"), ON)[1], ["example.org"])
check("several paired contacts: nobody qualifies", run(["111", "222"], dm("111", "https://news.example.com"), ON)[1], ["example.org"])
check("explicit owner list wins", run(["111", "222"], dm("222", "https://news.example.com"),
                                        dict(ON, MARVEEN_OWNER_URL_SENDERS="222"))[1], ["example.org", "news.example.com"])
check("any-paired opt-in", run(["111", "222"], dm("222", "https://news.example.com"),
                               dict(ON, MARVEEN_OWNER_URL_ANY_PAIRED="1"))[1], ["example.org", "news.example.com"])
check("never blocks the prompt", run([], "no channel here", ON)[0], 0)

print("All tests passed." if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
