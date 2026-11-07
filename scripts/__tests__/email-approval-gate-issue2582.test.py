"""ISSUE2582: two harmless Bash shapes were judged a mail send by the main agent's approval gate, and every real send
shape stays a send.

  A2  `D=/x; python3 $D/a.py`          the script path through a variable the same command sets to a literal
  B1  `cat > F <<'EOF' ... EOF; python3 F`   a script written by a heredoc and run in the same command

Both are now read (the variable is filled in, the heredoc body is judged) where the gate can PROVE what runs; every
other shape keeps the fail-closed verdict. This file drives the real hook as a subprocess at level 2 without an
approval, so exit 2 = the call is stopped, exit 0 = it passes. The row-by-row contract of the two gates (main and
sub-agent) is script-run-cases.json; this file is the end-to-end proof on the main agent's hook, with the issue's own
reproduction first.

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
    """A throwaway install: <td>/scripts -> this repo's scripts, <td>/store with email_send at level 2 and an empty
    approvals table (the gate reads only its own install's store; see email-approval-gate-script-file.test.py)."""
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


SEND = "import smtplib\nsmtplib.SMTP('localhost').sendmail('a@x.invalid', ['b@y.invalid'], 'hi')\n"
td = tempfile.mkdtemp(prefix="issue2582-")
try:
    gate = make_install(td)
    D = os.path.join(td, "work")
    os.makedirs(D)
    with open(os.path.join(D, "hello.py"), "w") as fh:
        fh.write('print("hello")\n')
    with open(os.path.join(D, "send.py"), "w") as fh:
        fh.write(SEND)

    def rc(command):
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": D}
        p = subprocess.run([sys.executable, gate], input=json.dumps(payload), capture_output=True, text=True)
        return p.returncode, p.stderr

    H = "cat > {f} <<'EOF'\n{body}EOF\n"
    harmless = H.format(f=f"{D}/new.py", body='print("hi")\n')
    sender = H.format(f=f"{D}/new.py", body=SEND)

    print("== the issue's reproduction (all four pass)")
    for name, cmd in (
        ("A1 a literal script path", f"python3 {D}/hello.py"),
        ("A2 the path through a variable the command sets", f"D={D}; python3 $D/hello.py"),
        ("B1 a heredoc-written script, then run", harmless + f"python3 {D}/new.py"),
        ("B2 python3 - with a heredoc (control)", "python3 - <<'EOF'\nprint(\"hi\")\nEOF"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 0", code == 0, f"exit={code} err={err[:200]!r}")

    print("== every real send shape is stopped (level 2, no approval)")
    for name, cmd in (
        ("a literal sender script", f"python3 {D}/send.py"),
        ("a sender through a bound variable", f"D={D}; python3 $D/send.py"),
        ("a sender through ${D}", f"export D={D} && python3 \"${{D}}/send.py\""),
        ("a heredoc-written sender, then run", sender + f"python3 {D}/new.py"),
        ("a sender fed to python3 - by a heredoc", "python3 - <<'EOF'\n" + SEND + "EOF"),
        ("sendmail on the command line", "sendmail b@y.invalid < /dev/null"),
        ("a sender written harmlessly, then a cp of a sender onto it", harmless + f"cp {D}/send.py {D}/new.py\npython3 {D}/new.py"),
        ("the heredoc writes a harmless file, the sender runs", H.format(f=f"{D}/x/send.py", body="print(1)\n") + f"python3 {D}/send.py"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    print("== what runs is not certain: still asks (exit 2), even for the harmless script")
    for name, cmd in (
        ("a prefix assignment (D=x cmd $D expands the outer D)", f"D={D} python3 $D/hello.py"),
        ("an assignment in a pipeline", f"D={D} | python3 $D/hello.py"),
        ("an assignment in the background", f"D={D} & python3 $D/hello.py"),
        ("an assignment in a subshell", f"(D={D}); python3 $D/hello.py"),
        ("an assignment after ||", f"false || D={D}; python3 $D/hello.py"),
        ("an && assignment, then ;", f"test -d x && D={D}; python3 $D/hello.py"),
        ("a second assignment", f"D={D}; D=$HOME; python3 $D/hello.py"),
        ("a single-quoted use", f"D={D}; python3 '$D/hello.py'"),
        ("unset", f"D={D}; unset D; python3 $D/hello.py"),
        ("read", f"D={D}; read D; python3 $D/hello.py"),
        ("eval", f"D={D}; eval D=/tmp; python3 $D/hello.py"),
        ("an IFS assignment", f"IFS=/; D={D}; python3 $D/hello.py"),
        ("a variable set only outside", "python3 $D/hello.py"),
        (">> appends to the script", f"cat >> {D}/new.py <<'EOF'\nprint(1)\nEOF\npython3 {D}/new.py"),
        ("an unquoted heredoc with a $ in it", f"cat > {D}/new.py <<EOF\nprint('$HOME')\nEOF\npython3 {D}/new.py"),
        ("the run before the write", f"python3 {D}/new.py\n" + harmless),
        ("the write inside an if block", f"if test -d x; then :; " + harmless + "fi\n" + f"python3 {D}/new.py"),
        ("the write on a condition from the line before", "test -d x &&\n" + harmless + f"python3 {D}/new.py"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    print("== Dani's review of #2586: the run would reach a sender in zsh or bash; every shape is stopped")
    os.makedirs(os.path.join(D, "evil"))
    with open(os.path.join(D, "evil", "hello.py"), "w") as fh:
        fh.write(SEND)
    os.makedirs(os.path.join(D, "ro"))
    ro = os.path.join(D, "ro", "send.py")
    with open(ro, "w") as fh:
        fh.write(SEND)
    os.chmod(ro, 0o444)
    harmless_over = lambda p: H.format(f=p, body='print("hi")\n')  # noqa: E731
    for name, cmd in (
        ("set -C, then a heredoc 'overwrite' of an existing sender", "set -C; " + harmless_over(f"{D}/send.py") + f"python3 {D}/send.py"),
        ("setopt noclobber (zsh), the same", "setopt noclobber; " + harmless_over(f"{D}/send.py") + f"python3 {D}/send.py"),
        ("a heredoc 'overwrite' of a read-only sender", harmless_over(ro) + f"python3 {ro}"),
        ("an unzip before the write may leave the script there", f"unzip -o {D}/a.zip -d {D}; " + harmless_over(f"{D}/new.py") + f"python3 {D}/new.py"),
        ("exec {D}> sets D (zsh)", f"D={D}; exec {{D}}>/dev/null; python3 $D/hello.py"),
        ("builtin printf -v D", f"D={D}; builtin printf -v D %s {D}/evil; python3 $D/hello.py"),
        ("print -v D (zsh)", f"D={D}; print -v D {D}/evil; python3 $D/hello.py"),
        (": ${D::=x} (zsh)", f"D={D}; : ${{D::={D}/evil}}; python3 $D/hello.py"),
        ("command . FILE that sets D", f"D={D}; command . {D}/setD.sh; python3 $D/hello.py"),
        ("a trap DEBUG string that sets D", f"D={D}; trap 'D={D}/evil' DEBUG; python3 $D/hello.py"),
        ("$D:h is a zsh modifier", f"D={D}/evil/x; python3 $D:h/hello.py"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")
    os.chmod(ro, 0o644)
finally:
    shutil.rmtree(td, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All ISSUE2582 tests passed.")
