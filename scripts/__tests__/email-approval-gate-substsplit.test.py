"""COPYSUBST1116: a recipient flag after an unquoted substitution, and a recipient value that is no literal.

  1  `python3 tool.py --text $(cat p) --to a@x`   the tokenizer cut the command at the $(...), the --to landed in a
     segment of its own, and the run was not addressed: no approval was asked. Also backtick, <(...), a glued $(...),
     a heredoc body or a comment with an apostrophe before the run (Revizor 4111 L1), `bash -c "..\\$(..).."` (L2).
  2  `python3 tool.py --to $(cat addr.txt)`       the address itself comes from a substitution, a variable or an
     ANSI-C string: the gate cannot read it, so it is treated as an address (fail-closed, Marveen 4114); also an
     argparse prefix (--bc) and eval.

This file drives the real hook (email-approval-gate.py, the main agent's approval gate) as a subprocess at level 2
without an approval, so exit 2 = the call is stopped, exit 0 = it passes. The row-by-row contract of both gates is
script-run-cases.json (COPYSUBST1116 rows). Nothing is executed: the hook only reads the command text.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_install(td):
    """A throwaway install with email_send at level 2 and an empty approvals table (as email-approval-gate-issue2582)."""
    os.symlink(SCRIPTS, os.path.join(td, "scripts"))
    store = os.path.join(td, "store")
    os.makedirs(store)
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [{"key": "email_send", "label": "Email", "level": 2, "locked": False}]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute("""CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT, content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    return os.path.join(td, "scripts", "hooks", "email-approval-gate.py")


td = tempfile.mkdtemp(prefix="substsplit-")
try:
    gate = make_install(td)
    D = os.path.join(td, "work")
    os.makedirs(D)
    with open(os.path.join(D, "tool.py"), "w") as fh:
        fh.write('print("tool")\n')

    def rc(command):
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": D}
        p = subprocess.run([sys.executable, gate], input=json.dumps(payload), capture_output=True, text=True)
        return p.returncode, p.stderr

    T = f"python3 {D}/tool.py"
    print("== control: the same run without the substitution is stopped, and an unaddressed one passes")
    code, err = rc(f"{T} --text x --to a@example.com")
    check("a literal address -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")
    for name, cmd in (
        ("a $(...) with no recipient", f"{T} --text $(cat p)"),
        ("a one-letter prefix with a variable (--c \"$CFG\")", f"{T} --c \"$CFG\""),
        ("eval \"$(ssh-agent -s)\"", "eval \"$(ssh-agent -s)\""),
        ("bash -c with an escaped $(...) and no address", "bash -c \"echo \\$(date)\""),
        ("git commit -m \"$(cat msg)\"", "git commit -m \"$(cat msg.txt)\""),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 0", code == 0, f"exit={code} err={err[:200]!r}")

    print("== 1: the address after a substitution is still the run's address (level 2, no approval: exit 2)")
    for name, cmd in (
        ("--to after $(...)", f"{T} --text $(cat p) --to a@example.com"),
        ("--to after a backtick", f"{T} --text `cat p` --to a@example.com"),
        ("--cc after <(...)", f"{T} --file <(cat p) --cc a@example.com"),
        ("--bcc after a glued $(...)", f"{T} --text=x$(cat p) --bcc a@example.com"),
        ("L1 a heredoc body with an apostrophe before", f"cat > {D}/n.txt <<'EOF'\ndon't\nEOF\n{T} --text $(cat p) --to a@example.com"),
        ("L1 a comment with an apostrophe before", f"# don't\n{T} --text $(cat p) --to a@example.com"),
        ("L1 a comment with an odd backtick before", f"# a ` b\n{T} --text $(cat p) --to a@example.com"),
        ("L2 bash -c with an escaped $(...)", f"bash -c \"{T} --text \\$(cat p) --to a@example.com\""),
        ("sh -c in single quotes", f"sh -c '{T} --text $(cat p) --to a@example.com'"),
        ("an env prefix", f"env X=1 {T} --text $(cat p) --to a@example.com"),
        ("a nested $(...)", f"true && {T} --text $(echo $(cat p)) --to a@example.com"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    print("== 2: a recipient value that is no literal counts as an address (fail-closed, Marveen 4114)")
    for name, cmd in (
        ("--to $(cat addr.txt)", f"{T} --to $(cat addr.txt)"),
        ("--to `cat addr.txt`", f"{T} --to `cat addr.txt`"),
        ("--to=$(cat addr.txt)", f"{T} --to=$(cat addr.txt)"),
        ("--to \"$(cat addr.txt)\"", f"{T} --to \"$(cat addr.txt)\""),
        ("--to \"$ADDR\"", f"{T} --to \"$ADDR\""),
        ("--bcc=${ADDR}", f"{T} --bcc=${{ADDR}}"),
        ("an ANSI-C $'..' address", f"{T} --to $'a\\x40example.com'"),
        ("an argparse prefix --bc", f"{T} --bc a@example.com"),
        ("eval of an addressed run", f"eval '{T} --to a@example.com'"),
        ("--cc $(cat addr.txt)", f"{T} --cc $(cat addr.txt)"),
        # Revizor 4123 L1-L3: the flag name, the eval line or the -c body written as an ANSI-C string; builtin / -- eval
        ("an ANSI-C $'--to' flag name", f"{T} $'--to' a@example.com"),
        ("builtin eval", f"builtin eval '{T} --to a@example.com'"),
        ("eval --", f"eval -- '{T} --to a@example.com'"),
        ("eval $'...'", f"eval $'{T} --to a@example.com'"),
        ("bash -c $'...'", f"bash -c $'{T} --to a@example.com'"),
        # Revizor 4138 L7, L8
        ("a locale $\"--to\" flag name", f"{T} $\"--to\" a@example.com"),
        ("builtin command eval", f"builtin command eval '{T} --to a@example.com'"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    print("== KNOWN LIMIT (Marveen 4128, Revizor 4123 L4): eval \"$(cmd)\" is not stopped")
    # The line eval runs comes from a command the gate cannot evaluate. Stopping every such eval would stop
    # eval "$(pyenv init -)" and eval "$(ssh-agent -s)" too, so it passes by decision; this pins the decision, and a
    # change of it must change this test. A cost of the fail-closed rule above is stated here as well (Revizor 4123 L5):
    # a variable on --to / --cc / --bcc asks for approval even when it is no address.
    for name, cmd in (
        ("eval \"$(echo ... --to a@x)\" passes", f"eval \"$(echo {T} --to a@example.com)\""),
        ("eval \"$(pyenv init -)\" passes", "eval \"$(pyenv init -)\""),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 0", code == 0, f"exit={code} err={err[:200]!r}")
    code, err = rc(f"{T} --cc \"$CC_COMPILER\"")
    check("the stated cost: --cc \"$CC_COMPILER\" -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")
finally:
    shutil.rmtree(td, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All COPYSUBST1116 tests passed.")
