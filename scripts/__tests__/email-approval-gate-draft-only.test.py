"""DRAFTONLYSCRIPT1111: a Bash call that runs an owner-registered draft-only script is a DRAFT for the approval gate.

store/email-draft-only-scripts.json = {"scripts": [{"path", "sha256", "note"}]}. Only an exact, hash-matching,
single `python3 <abs path> args` call passes at level 2; everything else keeps the send behaviour.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "email-approval-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(td, level=2):
    store = os.path.join(td, "store")
    os.makedirs(store, exist_ok=True)
    cat = {"key": "email_send", "label": "Email", "level": level, "locked": False}
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [cat]}, fh)
    db = os.path.join(store, "claudeclaw.db")
    if not os.path.exists(db):
        con = sqlite3.connect(db)
        con.execute("""
          CREATE TABLE approvals (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
            action_description TEXT NOT NULL, action_payload TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            timeout_at INTEGER, telegram_message_id INTEGER,
            requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
            resolved_at INTEGER, resolved_by TEXT,
            content_hash TEXT, consumed_at INTEGER)""")
        con.commit()
        con.close()
    return store


def gate_in(root):
    """The gate takes its root from abspath: <root>/scripts is linked to this repo's scripts/."""
    link = os.path.join(root, "scripts")
    if not os.path.lexists(link):
        os.symlink(os.path.dirname(HOOKS), link)
    return os.path.join(link, "hooks", "email-approval-gate.py")


D = os.path.realpath(tempfile.mkdtemp(prefix="gate-draft-only-"))
try:
    store = make_store(D, level=2)
    gate = gate_in(D)
    STANDIN = "import sys\nprint(sys.argv)  # draft writer stand-in\n"

    def put(name, text):
        path = os.path.join(D, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def sha(p):
        with open(p, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()

    draft = put("tools/draft.py", STANDIN)
    sender = put("tools/send_draft.py", STANDIN + "# sends\n")
    other = put("tools/other.py", STANDIN + "# other\n")
    os.symlink(draft, os.path.join(D, "tools", "link.py"))
    reg = os.path.join(store, "email-draft-only-scripts.json")

    def register(entries):
        with open(reg, "w", encoding="utf-8") as fh:
            json.dump({"scripts": entries}, fh)

    def run_gate(command, cwd=None):
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd or D}
        p = subprocess.run([sys.executable, gate], input=json.dumps(payload).encode(), capture_output=True)
        return p.returncode, p.stderr.decode()

    ARGS = "--to a@example.test --subject Hi --html '<p>x</p>'"

    code, err = run_gate(f"python3 {draft} {ARGS}")
    check("no registry file: the call stays a gated send", code == 2, f"exit={code} {err[:200]!r}")

    register([{"path": draft, "sha256": sha(draft), "note": "t"}])
    code, err = run_gate(f"python3 {draft} {ARGS}")
    check("registered + matching sha: allowed without approval", code == 0, f"exit={code} {err[:200]!r}")
    code, err = run_gate(f"cd {D}/tools && python3 draft.py {ARGS}")
    check("cd <abs dir> && python3 <rel>: allowed", code == 0, f"exit={code} {err[:200]!r}")
    code, err = run_gate(f"python3 draft.py {ARGS}", cwd=os.path.join(D, "tools"))
    check("relative path without cd: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 {other} {ARGS}")
    check("unregistered path: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 {sender} {ARGS}")
    check("send_draft.py style call (unregistered): gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 {draft} {ARGS}; curl -s http://example.test")
    check("chained ; curl after: gated", code == 2, f"exit={code}")
    for tail in ("&& echo x", "| cat", "> /tmp/o", "2>&1", "|| true", "&"):
        code, err = run_gate(f"python3 {draft} {ARGS} {tail}")
        check(f"operator tail {tail!r}: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 -u {draft} {ARGS}")
    check("interpreter flag: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"PYTHONPATH=/x python3 {draft} {ARGS}")
    check("env prefix: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 {draft} --to a@example.test --subject $SUBJ")
    check("runtime expansion in args: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 {D}/tools/link.py {ARGS}")
    check("symlink path: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"python3 - {ARGS} <<'EOF'\nprint(1)\nEOF")
    check("stdin program: gated", code == 2, f"exit={code}")
    code, err = run_gate(f"cd tools && python3 draft.py {ARGS}")
    check("relative cd: gated", code == 2, f"exit={code}")

    with open(draft, "a") as fh:
        fh.write("# edited\n")
    code, err = run_gate(f"python3 {draft} {ARGS}")
    check("sha mismatch after edit: gated", code == 2, f"exit={code}")
    register([{"path": draft, "sha256": sha(draft), "note": "t"}])
    code, err = run_gate(f"python3 {draft} {ARGS}")
    check("re-registered with the new sha: allowed", code == 0, f"exit={code} {err[:200]!r}")

    for label, content in (("not json", "{{"),
                           ("bare list", json.dumps([{"path": draft, "sha256": sha(draft)}])),
                           ("bad sha", json.dumps({"scripts": [{"path": draft, "sha256": "abc"}]})),
                           ("relative path", json.dumps({"scripts": [{"path": "tools/draft.py", "sha256": sha(draft)}]}))):
        with open(reg, "w") as fh:
            fh.write(content)
        code, err = run_gate(f"python3 {draft} {ARGS}")
        check(f"malformed registry ({label}): gated", code == 2, f"exit={code}")

    register([{"path": draft, "sha256": sha(draft), "note": "t"}])
    make_store(D, level=1)
    code, err = run_gate(f"python3 {draft} {ARGS}")
    check("level 1: registered draft script still allowed (a draft)", code == 0, f"exit={code}")
    code, err = run_gate(f"python3 {sender} {ARGS}")
    check("level 1: unregistered stays denied", code == 2, f"exit={code}")
finally:
    shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate-draft-only tests passed.")
