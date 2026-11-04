"""ENVOPTHEAD1104: env's value-taking options must not hide the program it runs.

`env -P DIR` (macOS/BSD: another search path) took DIR as the program, and `env -S STRING` skipped STRING, whose
words ARE the command. So a real SMTP sender run as `env -P /x python3 send.py --to a@x` or
`env -S "python3 send.py --to a@x"` was no send for the approval gate, and an extensionless script whose #! line
is `#!/usr/bin/env -P /usr/bin python3` was not judged at all (measured on develop 5d8ed56c: all False).
The command-string level is pinned in send-invocation-cases.json (both twins); this file pins the script-run level.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ocg", os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


D = tempfile.mkdtemp(prefix="envopt-")
try:
    with open(os.path.join(D, "send.py"), "w") as fh:
        fh.write('import smtplib\nsmtplib.SMTP("x").sendmail("a", ["b"], "c")\n')
    with open(os.path.join(D, "plain.py"), "w") as fh:
        fh.write("print('x')\n")
    for name, line in (("sender", "#!/usr/bin/env -P /usr/bin python3"), ("sender-u", "#!/usr/bin/env -u FOO python3"),
                       ("sender-c", "#!/usr/bin/env -C /tmp python3"), ("harmless", "#!/usr/bin/env -P /usr/bin python3")):
        body = "print('x')\n" if name == "harmless" else 'import smtplib\nsmtplib.SMTP("x")\n'
        p = os.path.join(D, name)
        with open(p, "w") as fh:
            fh.write(line + "\n" + body)
        os.chmod(p, 0o755)

    for cmd, want, what in [
        ("env -P /tmp/planted python3 send.py --to a@x", True, "env -P DIR before the interpreter"),
        ("env -P /tmp/planted python3 send.py", True, "the same without an address: the script judge sees smtplib"),
        ('env -S "python3 send.py --to a@x"', True, "env -S: the value is the command"),
        ("env -S'python3 send.py'", True, "env -S joined value"),
        ('env --split-string="python3 send.py"', True, "env --split-string="),
        ('env -iS "python3 send.py"', True, "env -iS cluster"),
        ("./sender", True, "a #! line env -P DIR python3: the interpreter is python3"),
        ("./sender-u", True, "a #! line env -u NAME python3"),
        ("./sender-c", True, "a #! line env -C DIR python3"),
        ("env -P /usr/local/bin python3 plain.py", False, "control: env -P before a script that does not send"),
        ('env -S "python3 plain.py"', False, "control: env -S with a script that does not send"),
        ("./harmless", False, "control: the same #! line on a script that does not send"),
        ("env -P /usr/local/bin ls", False, "control: env -P before a non-sender"),
    ]:
        got = ocg.script_run_sends(cmd, D)
        check(f"ENVOPTHEAD1104 {what}: {cmd!r} -> {want}", got is want, f"got {got}")
finally:
    shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate-envopt tests passed.")
