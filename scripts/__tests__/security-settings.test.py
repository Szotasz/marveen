#!/usr/bin/env python3
"""The dashboard's Security switches, on the Python side.

  (1) scripts/hooks/security_settings.py resolves a key the way the settings
      store does: store/config-overrides.json (an empty value included), then
      the install .env, then the caller's default; a malformed overrides file
      or a value outside `allowed` reads as the default.
  (2) SECURITY_COPY_GATE_MODE=warn lets a text with copy findings out with a
      systemMessage; block (the default) denies it; an unreadable send stays
      denied in warn mode too.
  (3) MAIL_OWNER_CC saved on the dashboard (overrides file) switches the
      owner-copy check on and wins over the .env; never the process env.
  (4) SECURITY_CREDENTIAL_GATE warn/block sets the credential gate's mode.

Drives the hooks as subprocesses against throwaway install roots, so the real
store is never touched. Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(ROOT, "scripts", "hooks")
COPY_GATE = os.path.join(HOOKS, "outgoing-copy-gate.py")
APPROVAL_GATE = os.path.join(HOOKS, "email-approval-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_root(td, name, overrides=None, env_text=None):
    root = os.path.join(td, name)
    os.makedirs(os.path.join(root, "store"))
    if overrides is not None:
        with open(os.path.join(root, "store", "config-overrides.json"), "w", encoding="utf-8") as fh:
            fh.write(overrides if isinstance(overrides, str) else json.dumps(overrides))
    if env_text is not None:
        with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
            fh.write(env_text)
    return root


ss = load(os.path.join(HOOKS, "security_settings.py"), "security_settings")

print("(1) reader precedence")
with tempfile.TemporaryDirectory() as td:
    r = make_root(td, "none")
    check("nothing set -> the default", ss.security_setting("K", "block", root=r) == "block")
    r = make_root(td, "env", env_text='K="warn"\n')
    check("a quoted .env line counts", ss.security_setting("K", "block", root=r) == "warn")
    r = make_root(td, "both", overrides={"K": "block"}, env_text="K=warn\n")
    check("the override wins over .env", ss.security_setting("K", "x", root=r) == "block")
    r = make_root(td, "empty", overrides={"K": ""}, env_text="K=warn\n")
    check("an empty override still wins (as in the settings store)", ss.security_setting("K", "x", root=r) == "")
    r = make_root(td, "bad", overrides="{ not json", env_text="K=warn\n")
    check("a malformed overrides file is no override", ss.security_setting("K", "x", root=r) == "warn")
    r = make_root(td, "odd", overrides={"K": "open"})
    check("a value outside `allowed` -> the default",
          ss.security_setting("K", "block", ("block", "warn"), root=r) == "block")

print("(2) copy gate warn mode")


def copy_gate(payload, root):
    env = dict(os.environ, SECURITY_SETTINGS_ROOT=root,
               OUTGOING_COPY_GATE_RULES=os.path.join(root, "store", "rules.json"))
    with open(env["OUTGOING_COPY_GATE_RULES"], "w", encoding="utf-8") as fh:
        json.dump({"bad_name_patterns": [], "no_name_rule": True}, fh)
    p = subprocess.run([sys.executable, COPY_GATE], input=json.dumps(payload),
                       capture_output=True, text=True, env=env, timeout=20)
    return p.returncode, p.stdout, p.stderr


UNACCENTED = "Szia! Koszonom szepen, holnap kuldom at a szamlat es a reszleteket."
tg = {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": UNACCENTED}}
mail = {"tool_name": "send_email", "tool_input": {"body": UNACCENTED}}
with tempfile.TemporaryDirectory() as td:
    r = make_root(td, "block")
    code, _, err = copy_gate(tg, r)
    check("default (block): unaccented Telegram text -> DENIED", code == 2 and "TILTVA" in err, f"exit={code}")
    code, _, err = copy_gate(mail, r)
    check("default (block): unaccented letter -> DENIED, original wording kept",
          code == 2 and "a levél nem mehet ki így" in err, f"exit={code} err={err[:120]!r}")
    r = make_root(td, "warn", overrides={"SECURITY_COPY_GATE_MODE": "warn"})
    code, out, _ = copy_gate(tg, r)
    msg = json.loads(out or "{}").get("systemMessage", "")
    check("warn: the Telegram text goes out with a notice", code == 0 and "figyelo mod" in msg, f"exit={code} out={out[:120]!r}")
    code, out, _ = copy_gate(mail, r)
    msg = json.loads(out or "{}").get("systemMessage", "")
    check("warn: the letter goes out with a notice", code == 0 and "figyelo mod" in msg, f"exit={code} out={out[:120]!r}")
    code, _, _ = copy_gate({"tool_name": "send_email", "tool_input": "not-a-dict"}, r)
    check("warn: an unreadable send is still DENIED", code == 2, f"exit={code}")

print("(3) MAIL_OWNER_CC from the dashboard")
OWNER = "owner@example.org"
with tempfile.TemporaryDirectory() as td:
    def owner_cc(root, extra=None):
        env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=os.path.join(root, "store"))
        env.update(extra or {})
        code = ("import importlib.util,sys;"
                f"s=importlib.util.spec_from_file_location('g',{APPROVAL_GATE!r});"
                "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                "print(m.owner_cc_address())")
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=20)
        return p.stdout.strip()
    r = make_root(td, "dash", overrides={"MAIL_OWNER_CC": "Owner@Example.org"})
    check("saved on the dashboard -> on, lowercased", owner_cc(r) == OWNER, owner_cc(r))
    r = make_root(td, "envonly", env_text=f"MAIL_OWNER_CC={OWNER}\n")
    check("only in .env -> on, as before", owner_cc(r) == OWNER)
    r = make_root(td, "cleared", overrides={"MAIL_OWNER_CC": ""}, env_text=f"MAIL_OWNER_CC={OWNER}\n")
    check("cleared on the dashboard -> off (the owner's decision wins)", owner_cc(r) == "")
    r = make_root(td, "procenv")
    check("the process env alone does not switch it on", owner_cc(r, {"MAIL_OWNER_CC": OWNER}) == "")

print("(4) credential gate mode")
with tempfile.TemporaryDirectory() as td:
    def mode(root, extra=None):
        env = dict(os.environ, CREDENTIAL_GATE_STORE=os.path.join(root, "store"))
        env.pop("CREDENTIAL_GATE_MODE", None)
        env.update(extra or {})
        code = (f"import sys;sys.path.insert(0,{HOOKS!r});import credential_lib as cl;"
                "print(cl.load_config()['mode'])")
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=20)
        return p.stdout.strip() or p.stderr.strip()
    check("nothing set -> block (the gate's own default)", mode(make_root(td, "none")) == "block")
    check("SECURITY_CREDENTIAL_GATE=warn -> warn",
          mode(make_root(td, "warn", overrides={"SECURITY_CREDENTIAL_GATE": "warn"})) == "warn")
    check("SECURITY_CREDENTIAL_GATE=off -> the file / default decides",
          mode(make_root(td, "off", overrides={"SECURITY_CREDENTIAL_GATE": "off"})) == "block")
    check("CREDENTIAL_GATE_MODE still overrides per process",
          mode(make_root(td, "envwins", overrides={"SECURITY_CREDENTIAL_GATE": "warn"}),
               {"CREDENTIAL_GATE_MODE": "block"}) == "block")

if failed:
    print(f"\n{len(failed)} FAILED", file=sys.stderr)
    sys.exit(1)
print("\nall passed")
