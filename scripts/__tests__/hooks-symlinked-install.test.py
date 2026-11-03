#!/usr/bin/env python3
"""Agent resolution in the hooks on an install reached through a symlink
(#1878 items 11 and 12).

Shape: the real install is R, and L -> R is a symlink. The hook command names
the hook through L, while Claude Code may report cwd / transcript_path under R
(or the other way round). ledger_lib.py compared against L only, so a
sub-agent's cwd under R fell back to the main agent; voice-reply-directive.py
compared the main agent's cwd against L only and returned None (directive
skipped).

Also pinned: the PAYLOAD transcript path is NOT resolved. On a fleet host
agents/<id>/.claude-config/projects is a symlink into ~/.claude/projects, and
resolving it would hand a session started outside its agent dir to the main
agent.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")

os.environ.pop("MAIN_AGENT_ID", None)
os.environ.pop("MARVEEN_AGENT_ID", None)

base = os.path.realpath(tempfile.mkdtemp(prefix="hooks-symlink-"))
failed = []


def check(name, got, want):
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")


try:
    R = os.path.join(base, "real-install")
    L = os.path.join(base, "link-install")
    os.makedirs(os.path.join(R, "scripts", "hooks"))
    for f in ("ledger_lib.py", "voice-reply-directive.py"):
        shutil.copy(os.path.join(HOOKS, f), os.path.join(R, "scripts", "hooks", f))
    with open(os.path.join(R, ".env"), "w") as f:
        f.write("MAIN_AGENT_ID=mainagent\n")
    os.makedirs(os.path.join(R, "agents", "samu"))
    # agents/geri/.claude-config/projects -> a ~/.claude/projects stand-in
    home_projects = os.path.join(base, "home-claude", "projects")
    os.makedirs(home_projects)
    os.makedirs(os.path.join(R, "agents", "geri", ".claude-config"))
    os.symlink(home_projects, os.path.join(R, "agents", "geri", ".claude-config", "projects"))
    os.symlink(R, L)

    def load(name, fname):
        spec = importlib.util.spec_from_file_location(name, os.path.join(L, "scripts", "hooks", fname))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    ledger = load("ledger_lib_symlinked", "ledger_lib.py")
    vrd = load("voice_reply_directive_symlinked", "voice-reply-directive.py")

    print("ledger_lib.agent_id_from_cwd")
    check("sub-agent cwd under the REAL path", ledger.agent_id_from_cwd(os.path.join(R, "agents", "samu")), "samu")
    check("sub-agent cwd under the LINK path", ledger.agent_id_from_cwd(os.path.join(L, "agents", "samu")), "samu")
    check("real install root is the main agent", ledger.agent_id_from_cwd(R), "mainagent")
    check("real install subdir is the main agent", ledger.agent_id_from_cwd(os.path.join(R, "store")), "mainagent")

    print("ledger_lib.agent_id_from_payload (transcript_path)")
    check("config dir under the REAL path",
          ledger.agent_id_from_payload({"transcript_path": os.path.join(R, "agents", "samu", ".claude-config", "projects", "x", "s.jsonl")}),
          "samu")
    flat_real = R.replace(os.sep, "-")
    check("~/.claude segment of the REAL path",
          ledger.agent_id_from_payload({"transcript_path": os.path.join(home_projects, flat_real + "-agents-samu", "s.jsonl")}),
          "samu")
    check("~/.claude segment of the LINK path",
          ledger.agent_id_from_payload({"transcript_path": os.path.join(home_projects, L.replace(os.sep, "-") + "-agents-samu", "s.jsonl")}),
          "samu")
    # The config owner stays authoritative although .claude-config/projects is a
    # symlink and the session started elsewhere (segment of an unrelated dir).
    check("config owner wins through a symlinked projects dir",
          ledger.agent_id_from_payload({"transcript_path": os.path.join(R, "agents", "geri", ".claude-config", "projects", "-elsewhere-wt", "s.jsonl")}),
          "geri")

    print("voice-reply-directive._agent_id")
    check("main agent, cwd = REAL root", vrd._agent_id(R), "mainagent")
    check("main agent, cwd = LINK root", vrd._agent_id(L), "mainagent")
    check("sub-agent unchanged", vrd._agent_id(os.path.join(R, "agents", "samu")), "samu")
    check("unrelated dir is still None", vrd._agent_id(base), None)
finally:
    shutil.rmtree(base, ignore_errors=True)

if failed:
    print(f"\nFAILED ({len(failed)}): {failed}")
    sys.exit(1)
print("\nall pass")
