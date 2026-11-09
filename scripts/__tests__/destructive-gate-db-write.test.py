#!/usr/bin/env python3
"""Regresszios kapu: az eles adatbazis csonkitasa ertelmezo NELKUL (5BBA912C / 8356747b).

A res, amit ez a teszt zarva tart: a destructive-gate.py a torlest (rm, mv, shred, dd)
tiltotta, az ADATBAZIS FELULIRASAT nem. Merve 2026-11-01-en az eles kapun 23 alakbol
23 atment (`: > store/claudeclaw.db`, `tee`, `truncate -s 0`, `cp /dev/null`, `sed -i`,
`gzip`, ...), es ugyanigy a Write/Edit fajl-eszkoz is.

A masik irany ugyanilyen fontos, es kulon pin-elve van: az OLVASAS (cp ROLA, grep,
gzip -c, Read) es a vedett utvonalon KIVULI iras (scratch-masolat, mktemp-fixture)
tovabbra is szabad. A kapu hamis pozitivjai atfogalmazast tanitanak -- lasd a
modul-fejlecet. A visszajatszas 18 838 valos hivason: 0 elveszett blokk, 1 uj hamis
pozitiv -- egy teszt-shellforras python-sztringkent egy ertelmezo-heredocban, ahol a
`$INSTALL/store/claudeclaw.db` cel nincs hozzarendelve. A kapu a heredoc-torzset
helyesen kodnak latja (modul-fejlec 3. pont), tehat ez szovegbol nem valaszthato le.

Futtatas: python3 <ezafajl>   Exit 0 = minden teszt zold.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GATE = os.path.join(ROOT, "scripts", "hooks", "destructive-gate.py")

spec = importlib.util.spec_from_file_location("dgate_db", GATE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Blocked(Exception):
    pass


def _raise(msg):
    raise Blocked(msg)


gate.block = _raise
failed = []


def check(name, ok):
    print("  [%s] %s" % ("PASS" if ok else "FAIL", name))
    if not ok:
        failed.append(name)


def bash_blocks(cmd, cwd):
    try:
        gate.check_bash(cmd, cwd=cwd)
        return False
    except Blocked:
        return True


def tool_blocks(tool, path, cwd):
    try:
        gate.run_checks(tool, {"file_path": path}, {"cwd": cwd})
        return False
    except Blocked:
        return True


DB = "store/claudeclaw.db"

# Minden sor egy MERT, 2026-11-01-en az eles kapun ATMENT alak (FC615B58).
MUST_BLOCK = [
    ": > " + DB,
    ":>" + DB,
    "echo x > " + DB,
    "true >| " + DB,
    "cat /dev/null > " + DB,
    "echo x 1> " + DB,
    "echo x 2> " + DB,
    "echo x &> " + DB,
    "echo x >& " + DB,
    "echo x >&" + DB,
    "echo x >> " + DB,
    "exec 3> " + DB,
    "exec 3<> " + DB,
    "echo x | tee " + DB,
    "echo x | tee -a /dev/null " + DB,
    "truncate -s 0 " + DB,
    "truncate --size=0 " + DB + "-wal",
    "cp /dev/null " + DB,
    "cp /tmp/other.db store/",
    "cp -t store /tmp/claudeclaw.db",
    "install /dev/null " + DB,
    "ln -sf /dev/null " + DB,
    "rsync -a /tmp/x " + DB,
    "sed -i s/a/b/ " + DB,
    "sed --in-place=.bak s/a/b/ " + DB,
    "fallocate -p -o 0 -l 4096 " + DB,
    "gzip " + DB,
    "xz " + DB + "-shm",
    "zstd --rm " + DB,
    "curl -s -o " + DB + " http://127.0.0.1:1/x",
    "wget -O " + DB + " http://127.0.0.1:1/x",
    "cd store && : > claudeclaw.db",
    "if true; then : > " + DB + "; fi",
    "bash -c ': > " + DB + "'",
    "timeout 5 tee " + DB,
    ": > store/*.db",
    ": > store/backups/old.db",
    ': > "${ROOT}/store/claudeclaw.db"',
    'R="$(cd /x && pwd)"; : > "$R/store/claudeclaw.db"',
    "python3 -c \"open('" + DB + "','w')\"",
    "python3 -c \"open('" + DB + "', mode='r+b')\"",
    "python3 -c \"import pathlib; pathlib.Path('" + DB + "').write_bytes(b'')\"",
    "node -e \"require('fs').writeFileSync('" + DB + "','')\"",
]

# Olvasas, illetve vedett utvonalon kivuli iras: ATMEGY.
MUST_ALLOW = [
    "ls -la " + DB,
    "cp " + DB + " /tmp/x.db",
    "cp -a store/claudeclaw.db store/claudeclaw.db-wal /tmp/snap/",
    "echo x > /tmp/claudeclaw.db",
    "grep -c x " + DB + " > /tmp/out.txt",
    "cat " + DB + " | tee /tmp/copy.db >/dev/null",
    "cat < " + DB,
    'echo "do not run : > ' + DB + ' please"',
    "gzip -c " + DB + " > /tmp/db.gz",
    "gzip -k " + DB,
    "zstd " + DB,
    "sed -n 1p " + DB,
    "echo x 2>&1 >/dev/null",
    "echo x >&2",
    "diff <(sort a) >(cat) /dev/null",
    "python3 -c \"import sqlite3; sqlite3.connect('" + DB + "')\"",
    "python3 -c \"open('" + DB + "','rb').read(16)\"",
    "echo x > $OUT",
    "cp x.db $TMP/a.db",
    'D=$(mktemp -d); mkdir -p "$D/store"; : > "$D/store/claudeclaw.db"',
    'D="$(mktemp -d /tmp/x.XXXX)"; echo db > "$D/store/claudeclaw.db"',
    'B="$HOME/probe"; F="$B/install"; printf db > "$F/store/claudeclaw.db"; HOME="$F/home"',
    "printf 'x' > " + DB.replace("store/", "scratch/"),
]

with tempfile.TemporaryDirectory() as td:
    td = os.path.realpath(td)
    os.makedirs(os.path.join(td, "store", "backups"))
    os.makedirs(os.path.join(td, "scratch"))
    for f in ("claudeclaw.db", "claudeclaw.db-wal", "claudeclaw.db-shm", "backups/old.db"):
        open(os.path.join(td, "store", f), "w").close()
    orig_root = gate.PROJECT_ROOT
    gate.PROJECT_ROOT = td
    try:
        print("BLOKK -- az eles adatbazis irasa:")
        for c in MUST_BLOCK:
            check("blokk: " + c, bash_blocks(c, td))
        print("ATMEGY -- olvasas es vedett utvonalon kivuli iras:")
        for c in MUST_ALLOW:
            check("atmegy: " + c, not bash_blocks(c, td))

        print("Abszolut ut, cwd nelkul is:")
        check("blokk: abszolut ut, cwd=None",
              bash_blocks(": > " + os.path.join(td, DB), None))
        check("blokk: relativ db-ut, cwd=None (nem eldontheto)",
              bash_blocks(": > " + DB, None))
        check("atmegy: relativ NEM db cel, cwd=None",
              not bash_blocks("echo x > out.txt", None))
        check("blokk: hozzarendelt literal valtozon at",
              bash_blocks("R=%s; : > $R/store/claudeclaw.db" % td, None))

        print("Symlinken at: az iras a link CELJAT csonkitja:")
        lnk = os.path.join(td, "scratch", "innocent.txt")
        os.symlink(os.path.join(td, DB), lnk)
        check("blokk: : > symlink -> eles db", bash_blocks(": > " + lnk, td))
        check("blokk: Write symlinkre -> eles db", tool_blocks("Write", lnk, td))

        print("Fajl-eszkozok:")
        for tool in ("Write", "Edit", "NotebookEdit"):
            check("blokk: %s %s" % (tool, DB), tool_blocks(tool, os.path.join(td, DB), td))
        check("atmegy: Read " + DB, not tool_blocks("Read", os.path.join(td, DB), td))
        check("atmegy: Write a scratch-be", not tool_blocks("Write", os.path.join(td, "scratch", "x.db"), td))
    finally:
        gate.PROJECT_ROOT = orig_root

# Vegpontig: a VALODI hook-folyamat, a sajat helyerol szarmaztatott gyokerrel. Az
# egysegtesztek a PROJECT_ROOT-ot kezzel iranyitjak; ez azt meri, hogy a kapcsolas a
# fajl helye es a store/ kozott a valodi futasban is ugyanigy all.
with tempfile.TemporaryDirectory() as td:
    td = os.path.realpath(td)
    os.makedirs(os.path.join(td, "scripts", "hooks"))
    os.makedirs(os.path.join(td, "store"))
    open(os.path.join(td, DB), "w").close()
    hook = os.path.join(td, "scripts", "hooks", "destructive-gate.py")
    shutil.copy(GATE, hook)

    def hook_run(tool, inp):
        ev = {"tool_name": tool, "tool_input": inp, "cwd": td}
        return subprocess.run([sys.executable, hook], input=json.dumps(ev),
                              capture_output=True, text=True)

    print("Vegpontig, a valodi hook-folyamattal:")
    r = hook_run("Bash", {"command": ": > " + DB})
    check("hook: ': > db' -> exit 2", r.returncode == 2)
    check("hook: az indoklas megnevezi az adatbazist", "adatbazis" in r.stderr)
    r = hook_run("Bash", {"command": "cp " + DB + " /tmp/x.db"})
    check("hook: olvaso cp -> exit 0", r.returncode == 0)
    r = hook_run("Write", {"file_path": os.path.join(td, DB), "content": ""})
    check("hook: Write db -> exit 2", r.returncode == 2)
    check("hook: a fajl tenyleg erintetlen (a kapu nem ir)",
          os.path.getsize(os.path.join(td, DB)) == 0 and os.path.exists(os.path.join(td, DB)))

print()
if failed:
    print("%d FAILED: %s" % (len(failed), failed), file=sys.stderr)
    sys.exit(1)
print("Minden destructive-gate adatbazis-iras teszt zold.")
