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
    # Bence 69475: a real sender in another directory, and a harmless send.py decoy in the cwd
    os.makedirs(os.path.join(D, "evil"), exist_ok=True)
    with open(os.path.join(D, "evil", "send.py"), "w") as fh:
        fh.write('import smtplib\nsmtplib.SMTP("x").sendmail("a", ["b"], "c")\n')
    os.makedirs(os.path.join(D, "decoy"), exist_ok=True)
    with open(os.path.join(D, "decoy", "send.py"), "w") as fh:
        fh.write("print('x')\n")
    for name, line in (("sender", "#!/usr/bin/env -P /usr/bin python3"), ("sender-u", "#!/usr/bin/env -u FOO python3"),
                       ("sender-c", "#!/usr/bin/env -C /tmp python3"), ("harmless", "#!/usr/bin/env -P /usr/bin python3"),
                       # Bence 69552: options at the start of the -S value, on a #! line
                       ("sender-sa", "#!/usr/bin/env -S -a x python3"), ("sender-sc", "#!/usr/bin/env -S --c /tmp python3"),
                       ("sender-su", "#!/usr/bin/env -S -u X python3"), ("sender-si", "#!/usr/bin/env -S -i python3")):
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
        ("./sender-sa", True, "a #! line env -S -a x python3"),
        ("./sender-sc", True, "a #! line env -S --c DIR python3 (prefix of --chdir)"),
        ("./sender-su", True, "a #! line env -S -u X python3"),
        ("./sender-si", True, "a #! line env -S -i python3"),
        ("env -P /usr/local/bin python3 plain.py", False, "control: env -P before a script that does not send"),
        ('env -S "python3 plain.py"', False, "control: env -S with a script that does not send"),
        ("./harmless", False, "control: the same #! line on a script that does not send"),
        ("env -P /usr/local/bin ls", False, "control: env -P before a non-sender"),
        # Bence 69481: launchers whose value options hid the command behind them
        ("stdbuf -o0 python3 send.py", True, "stdbuf -o0"),
        ("stdbuf -o 0 python3 send.py", True, "stdbuf -o 0"),
        ("stdbuf --output=0 python3 send.py", True, "stdbuf --output=0"),
        ("ionice -c 3 python3 send.py", True, "ionice -c 3"),
        ("ionice -c3 -n 7 python3 send.py", True, "ionice -c3 -n 7"),
        ("chrt -r 1 python3 send.py", True, "chrt -r 1 (a priority before the command)"),
        ("chrt 1 python3 send.py", True, "chrt 1"),
        ("caffeinate -i python3 send.py", True, "caffeinate -i"),
        ("caffeinate -t 60 python3 send.py", True, "caffeinate -t 60"),
        ("stdbuf -o0 python3 plain.py", False, "control: stdbuf before a script that does not send"),
    ]:
        got = ocg.script_run_sends(cmd, D)
        check(f"ENVOPTHEAD1104 {what}: {cmd!r} -> {want}", got is want, f"got {got}")
    # Bence 69475: env -C DIR runs the command in DIR; the relative script is the one there, not the cwd's decoy
    C = os.path.join(D, "decoy")
    for cmd, want, what in [
        (f"env -C {D}/evil python3 send.py", True, "env -C DIR"),
        (f"env --chdir={D}/evil python3 send.py", True, "env --chdir=DIR"),
        (f"env --chdir {D}/evil python3 send.py", True, "env --chdir DIR"),
        (f"env -C{D}/evil python3 send.py", True, "env -CDIR"),
        (f"env -i -C {D}/evil python3 send.py", True, "env -i -C DIR"),
        ("env -C ../evil python3 send.py", True, "env -C with a relative DIR"),
        ("env -C $X python3 send.py", True, "env -C with an undecidable DIR"),
        # Bence 69517: -a takes a value; a unique prefix of --chdir works like the full name
        (f"env -a x -C {D}/evil python3 send.py", True, "env -a ARG -C DIR"),
        (f"env --c={D}/evil python3 send.py", True, "env --c=DIR (prefix of --chdir)"),
        (f"env --chd {D}/evil python3 send.py", True, "env --chd DIR (prefix of --chdir)"),
        (f"env --un FOO --chd {D}/evil python3 send.py", True, "env --un NAME --chd DIR"),
        (f"env -C {D}/decoy python3 send.py", False, "control: env -C into a dir whose script does not send"),
        # Bence 69552: GNU env parses the options at the start of the -S value too
        (f'env -S "-C {D}/evil python3 send.py"', True, "env -S with -C DIR at the start of the value"),
        (f'env -S "--chdir={D}/evil python3 send.py"', True, "env -S with --chdir=DIR at the start of the value"),
        (f'env -S "-u X python3 {D}/evil/send.py"', True, "env -S with -u NAME at the start, absolute script"),
        (f'env -S "-a x python3 {D}/evil/send.py"', True, "env -S with -a ARG at the start, absolute script"),
        (f'env -S "--c {D}/evil" python3 send.py', True, "env -S value of options only, the command after it"),
        (f'env -S "-S \'-C {D}/evil python3 send.py\'"', True, "env -S nested in an -S value"),
        (f'env -S "-C {D}/decoy python3 send.py"', False, "control: env -S -C into a dir whose script does not send"),
    ]:
        got = ocg.script_run_sends(cmd, C)
        check(f"ENVOPTHEAD1104 {what}: {cmd!r} -> {want}", got is want, f"got {got}")
finally:
    shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate-envopt tests passed.")
