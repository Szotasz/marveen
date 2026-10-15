#!/usr/bin/env python3
"""The helper scripts/approval-envelope.py builds the POST /api/approvals body for an
email_send approval from the same PreToolUse input the email approval gate sees.

Proven:
  - PARITY: the helper's content_hash equals the sha256 anchor the gate itself prints when it denies
    the same call (run as a subprocess, level 2, empty approvals), on the MCP path (accents, emoji,
    CRLF, tab, control characters, quote and backslash, cc, bcc) and on the Bash path (heredoc body,
    --bcc, --html and --attach scratch files);
  - the action_payload is a JSON string with envelope_v 1 and the fields the hash covers, and the
    gate's content_anchor recomputed from it gives the same hash;
  - a bcc-less letter has an empty bcc list, and the same hash as the gate's bcc-less anchor;
  - REFUSED with exit 2 and EMPTY stdout: a shell-substituted body, an unreadable --attach, a call
    that is not a send (ls, a manage_email search), a draft, no recipient, an empty body, non-JSON
    stdin, a lone UTF-16 surrogate, a --subject that is not exactly the FIRST line of the hashed
    text (a Bash --subject after --body; a body line; a partial line), ANY --subject on the MCP
    path, even one equal to the text's first line (the extractor puts the MCP subject last, so the first
    line is the body's), a bad agent id;
  - a --subject that IS the first line (Bash: --subject before --body) is accepted, with parity;
  - a dependency that does not load (email_extract.py, email-approval-gate.py) is exit 2 with empty
    stdout, measured on a disposable copy of scripts/;
  - the helper only reads: its source imports no network, DB or process module, and the two hook
    files it loads are byte-identical to HEAD (git diff is empty).

Run: python3 -I <thisfile>   Exit 0 = all pass.
"""
import ast
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(SCRIPTS)
HELPER = os.path.join(SCRIPTS, "approval-envelope.py")
GATE = os.path.join(SCRIPTS, "hooks", "email-approval-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(td):
    store = os.path.join(td, "store")
    os.makedirs(store, exist_ok=True)
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [
            {"key": "email_send", "label": "Email", "level": 2, "locked": False}]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
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


def gate_anchor(store, payload):
    """The anchor the gate itself hands a requester when it denies this call."""
    env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=store,
               OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
    proc = subprocess.run([sys.executable, "-I", GATE], input=json.dumps(payload).encode(),
                          capture_output=True, env=env)
    m = re.search(r"Tartalom-horgony[^\n]*?:\s*([0-9a-f]{64})", proc.stderr.decode("utf-8", "replace"))
    return m.group(1) if m else None


def run_helper(stdin, *args, helper=HELPER, raw=False):
    data = stdin if raw else json.dumps(stdin).encode("utf-8")
    proc = subprocess.run([sys.executable, "-I", helper, *args], input=data, capture_output=True)
    return proc.returncode, proc.stdout.decode("utf-8"), proc.stderr.decode("utf-8", "replace")


def load_gate():
    spec = importlib.util.spec_from_file_location("gate_for_test", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def mcp(to=("a@b.example.com",), cc=(), bcc=(), subject="Teszt tárgy", body="Kedves Ügyfelünk! Törzs."):
    ti = {"to": list(to), "subject": subject, "body": body}
    if cc:
        ti["cc"] = list(cc)
    if bcc:
        ti["bcc"] = list(bcc)
    return {"tool_name": "mcp__server-gmail-autoauth-mcp__send_email", "tool_input": ti}


def bash(cmd):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}}


gate_mod = load_gate()

with tempfile.TemporaryDirectory() as td:
    store = make_store(os.path.join(td, "s"))

    # --- parity with the gate's anchor ---------------------------------------
    vectors = [
        ("MCP plain", mcp(), None),
        ("MCP accents + emoji", mcp(subject="Árvíztűrő tükörfúrógép", body="Szia 😀 ő ű Ő Ű\nTörzs 🇭🇺"), None),
        ("MCP CRLF + tab", mcp(body="Sor1\r\nSor2\tTab\r\n"), None),
        ("MCP control characters", mcp(body="a\u0001b\u001fc"), None),
        ("MCP quote + backslash", mcp(body='idézet "x" és \\ perjel \\n'), None),
        ("MCP cc", mcp(cc=["c@d.example.com"]), None),
        ("MCP bcc", mcp(bcc=["rejtett@idegen.example"]), None),
        ("MCP to + cc + bcc", mcp(to=["a@b.example.com", "e@f.example.com"], cc=["c@d.example.com"], bcc=["g@h.example.com"]), None),
        ("Bash with --subject (its first line)",
         bash('python3 scripts/send.py --to "a@b.example.com" --subject "Bash tárgy" --body "Bash törzs."'), "Bash tárgy"),
    ]
    for label, payload, subj in vectors:
        want = gate_anchor(store, payload)
        args = ["--agent", "marveen"] + (["--subject", subj] if subj else [])
        code, out, err = run_helper(payload, *args)
        got = json.loads(out)["content_hash"] if code == 0 and out else None
        check(f"parity: {label}", want is not None and got == want, f"gate={want} helper={got} err={err[:120]!r}")

    plain_cmd = 'python3 scripts/send.py --to "a@b.example.com" --subject "Bash tárgy" --body "Bash törzs."'
    hdir = os.path.join(td, "files")
    os.makedirs(hdir)
    html_path = os.path.join(hdir, "level.html")
    att1 = os.path.join(hdir, "b-melleklet.pdf")
    att2 = os.path.join(hdir, "a-melleklet.pdf")
    for p, d in ((html_path, "<p>Kedves Ügyfelünk!</p>\n".encode()), (att1, b"%PDF-1.4 elso"), (att2, b"%PDF-1.4 masik")):
        with open(p, "wb") as fh:
            fh.write(d)
    heredoc = ("python3 scripts/send.py --to a@b.example.com --subject 'Heredoc tárgy' <<'EOF'\n"
               "Első sor ő\nMásodik \"sor\"\nEOF")
    bash_vectors = [
        ("Bash inline", bash(plain_cmd)),
        ("Bash heredoc body", bash(heredoc)),
        ("Bash --bcc", bash(plain_cmd + ' --bcc "rejtett@idegen.example"')),
        ("Bash --html + --attach", bash(plain_cmd + f' --html "{html_path}" --attach "{att1}"')),
        ("Bash two --attach (flag order)", bash(plain_cmd + f' --attach "{att1}" --attach "{att2}"')),
        ("Bash --attach scratch only", bash(plain_cmd + f' --attach "{att2}"')),
    ]
    helper_out = {}
    for label, payload in bash_vectors:
        want = gate_anchor(store, payload)
        code, out, err = run_helper(payload, "--agent", "marveen")
        got = json.loads(out)["content_hash"] if code == 0 and out else None
        helper_out[label] = out
        check(f"parity: {label}", want is not None and got == want, f"gate={want} helper={got} err={err[:120]!r}")
    _, o1, _ = run_helper(bash(plain_cmd + f' --attach "{att1}" --attach "{att2}"'), "--agent", "marveen")
    _, o2, _ = run_helper(bash(plain_cmd + f' --attach "{att2}" --attach "{att1}"'), "--agent", "marveen")
    check("attachment flag order does not change hash or payload", o1 == o2 and o1 != "")

    # --- output shape ----------------------------------------------------------
    # The Bash path puts a --subject given before --body FIRST in the text: the only place a subject
    # can be labelled.
    payload = bash("python3 scripts/send.py --to a@b.example.com --cc c@d.example.com --bcc g@h.example.com "
                   "--subject 'Árvíz 😀' --body 'Törzs \"x\" \\ ő'")
    code, out, err = run_helper(payload, "--agent", "marveen", "--subject", "Árvíz 😀")
    body = json.loads(out)
    check("one JSON line on stdout", code == 0 and out.endswith("\n") and out.count("\n") == 1)
    check("top-level keys are exactly the POST body",
          set(body) == {"agent_id", "category", "content_hash", "action_description", "action_payload"})
    check("agent_id and category", body["agent_id"] == "marveen" and body["category"] == "email_send")
    check("content_hash is 64 lowercase hex", re.fullmatch(r"[0-9a-f]{64}", body["content_hash"]) is not None)
    check("action_payload is a JSON string", isinstance(body["action_payload"], str))
    env = json.loads(body["action_payload"])
    check("envelope_v 1 with to/cc/bcc/text/subject",
          env["envelope_v"] == 1 and env["to"] == ["a@b.example.com"] and env["cc"] == ["c@d.example.com"]
          and env["bcc"] == ["g@h.example.com"] and env["subject"] == "Árvíz 😀" and "Törzs \"x\" \\ ő" in env["text"])
    allowed_keys = {"envelope_v", "to", "cc", "bcc", "text", "subject", "html_sha256", "attachments"}
    check("payload key set is a subset of the pinned envelope keys (no extra field)",
          set(env) <= allowed_keys, str(set(env) - allowed_keys))
    check("payload without --subject has no subject key",
          "subject" not in json.loads(json.loads(run_helper(payload, "--agent", "marveen")[1])["action_payload"]))
    check("the subject is the FIRST line of the text (the hash covers subject+body)",
          env["text"].split("\n", 1)[0] == "Árvíz 😀")
    check("gate content_anchor over the payload == content_hash",
          gate_mod.content_anchor(env) == body["content_hash"])
    check("action_description is readable: recipient, cc, bcc, text head",
          all(s in body["action_description"] for s in ("a@b.example.com", "c@d.example.com", "g@h.example.com", "Árvíz")))

    code, out, _ = run_helper(mcp(), "--agent", "marveen")
    env = json.loads(json.loads(out)["action_payload"])
    check("bcc-less letter: bcc is an empty list, no subject/html/attachments keys",
          env["bcc"] == [] and not ({"subject", "html_sha256", "attachments"} & set(env)))

    code, out, _ = run_helper(bash(plain_cmd + f' --html "{html_path}" --attach "{att1}"'), "--agent", "marveen")
    body = json.loads(out)
    env = json.loads(body["action_payload"])
    check("Bash html/attachment letter: html_sha256 and attachments in the payload",
          re.fullmatch(r"[0-9a-f]{64}", env.get("html_sha256", "")) is not None
          and env["attachments"][0]["name"] == "b-melleklet.pdf" and env["attachments"][0]["size"] == 13
          and gate_mod.content_anchor(env) == body["content_hash"])

    # --- refusals: exit 2, stdout EMPTY -----------------------------------------
    def refused(label, stdin, *args, raw=False, helper=HELPER, needle=None):
        code, out, err = run_helper(stdin, *args, helper=helper, raw=raw)
        ok = code == 2 and out == "" and err.strip() != "" and (needle is None or needle in err)
        check(f"refused: {label}", ok, f"exit={code} out={out[:80]!r} err={err[:160]!r}")

    A = ("--agent", "marveen")
    refused("shell-substituted body", bash('python3 scripts/send.py --to a@b.example.com --subject "T" --body "$(cat /x)"'), *A,
            needle="nem horgonyozhato")
    refused("variable body", bash('python3 scripts/send.py --to a@b.example.com --subject "T" --body "$BODY"'), *A)
    refused("shell-substituted recipient", bash('python3 scripts/send.py --to "$(whoami)" --subject "T" --body "x"'), *A)
    refused("unreadable --attach file", bash(plain_cmd + f' --attach "{os.path.join(hdir, "nincs.pdf")}"'), *A,
            needle="nem horgonyozhato")
    refused("--attach command substitution", bash(plain_cmd + ' --attach "$(ls *.pdf)"'), *A)
    refused("non-send Bash (ls)", bash("ls -la"), *A, needle="nem levelkuldes")
    refused("non-email tool", {"tool_name": "Read", "tool_input": {"file_path": "/x"}}, *A)
    refused("manage_email search", {"tool_name": "mcp__x__manage_email",
                                    "tool_input": {"operation": "search", "query": "x"}}, *A, needle="nem levelkuldes")
    refused("manage_email explicit draft", {"tool_name": "mcp__x__manage_email",
            "tool_input": {"operation": "reply", "draft": True, "to": ["a@b.example.com"], "body": "x"}}, *A)
    refused("no recipient", {"tool_name": "mcp__x__send_email", "tool_input": {"subject": "T", "body": "x"}}, *A)
    refused("empty body and subject", {"tool_name": "mcp__x__send_email",
                                       "tool_input": {"to": ["a@b.example.com"], "subject": "", "body": "  "}}, *A)
    refused("non-JSON stdin", b"not json", *A, raw=True, needle="JSON")
    refused("empty stdin", b"", *A, raw=True)
    refused("JSON that is not an object", [1, 2], *A)
    refused("non-UTF-8 stdin", b"\xff\xfe{}", *A, raw=True)
    refused("lone surrogate in the body", b'{"tool_name":"mcp__x__send_email","tool_input":{"to":["a@b.example.com"],'
            b'"subject":"T","body":"x \\ud800 y"}}', *A, raw=True, needle="surrogate")
    refused("subject that is not a line of the hashed text", mcp(), "--agent", "marveen", "--subject", "Más tárgy")
    refused("subject that is part of a line only", mcp(), "--agent", "marveen", "--subject", "Teszt")
    # Only the FIRST line may be labelled as the subject.
    refused("MCP subject (the extractor puts it LAST, not first)", mcp(), "--agent", "marveen",
            "--subject", "Teszt tárgy", needle="MCP-uton")
    # On the MCP path the first line is the BODY's first line. A --subject equal to it
    # would pass the first-line check and label a body line as the subject, so MCP refuses any.
    refused("MCP --subject equal to the body's first line",
            mcp(subject="Valódi tárgy", body="Kedves Ügyfelünk!\nTörzs."), "--agent", "marveen",
            "--subject", "Kedves Ügyfelünk!", needle="MCP-uton")
    refused("MCP --subject on a subject-less letter (first line = body)",
            mcp(subject="", body="Első sor\nMásodik sor"), "--agent", "marveen", "--subject", "Első sor",
            needle="MCP-uton")
    code, out, _ = run_helper(mcp(subject="Valódi tárgy", body="Kedves Ügyfelünk!\nTörzs."), "--agent", "marveen")
    check("MCP without --subject is still accepted (no subject key)",
          code == 0 and "subject" not in json.loads(json.loads(out)["action_payload"]))
    refused("Bash --subject after --body (a later line)",
            bash('python3 scripts/send.py --to a@b.example.com --body "Törzs." --subject "Később"'), "--agent", "marveen",
            "--subject", "Később", needle="elso sora")
    refused("a body line that is not the first one",
            bash('python3 scripts/send.py --to a@b.example.com --body "Első sor\nMásodik sor"'), "--agent", "marveen",
            "--subject", "Második sor", needle="elso sora")
    refused("the first line plus a trailing space", bash(plain_cmd), "--agent", "marveen", "--subject", "Bash tárgy ")
    refused("multi-line --subject", mcp(), "--agent", "marveen", "--subject", "a\nb")
    refused("empty --subject", mcp(), "--agent", "marveen", "--subject", " ")
    refused("--agent missing", mcp())
    refused("--agent with a space", mcp(), "--agent", "bad agent")
    refused("--agent with a slash", mcp(), "--agent", "../x")
    refused("--agent empty", mcp(), "--agent", "")
    refused("unknown option", mcp(), "--agent", "marveen", "--nope")

    # --- a dependency that does not load: exit 2, stdout empty ------------------
    for label, fname in (("email_extract.py", "email_extract.py"), ("email-approval-gate.py", "email-approval-gate.py")):
        sd = os.path.join(td, "copy-" + fname)
        shutil.copytree(os.path.join(SCRIPTS, "hooks"), os.path.join(sd, "hooks"))
        shutil.copy(HELPER, os.path.join(sd, "approval-envelope.py"))
        with open(os.path.join(sd, "hooks", fname), "w", encoding="utf-8") as fh:
            fh.write("def broken(:\n")
        refused(f"broken {label}", mcp(), *A, helper=os.path.join(sd, "approval-envelope.py"), needle=fname)
    sd = os.path.join(td, "copy-gone")
    shutil.copytree(os.path.join(SCRIPTS, "hooks"), os.path.join(sd, "hooks"))
    shutil.copy(HELPER, os.path.join(sd, "approval-envelope.py"))
    os.remove(os.path.join(sd, "hooks", "email_extract.py"))
    refused("missing email_extract.py", mcp(), *A, helper=os.path.join(sd, "approval-envelope.py"))
    sd = os.path.join(td, "copy-copygate")
    shutil.copytree(os.path.join(SCRIPTS, "hooks"), os.path.join(sd, "hooks"))
    shutil.copy(HELPER, os.path.join(sd, "approval-envelope.py"))
    with open(os.path.join(sd, "hooks", "outgoing-copy-gate.py"), "w", encoding="utf-8") as fh:
        fh.write("def broken(:\n")
    refused("broken outgoing-copy-gate.py (Bash classifier)", bash(plain_cmd), *A,
            helper=os.path.join(sd, "approval-envelope.py"), needle="outgoing-copy-gate.py")

    # --- read-only: no network, DB or process module; the hook files are untouched ---
    with open(HELPER, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    banned = {"socket", "urllib", "http", "requests", "ssl", "sqlite3", "subprocess", "ftplib", "smtplib"}
    check("helper source imports no network, DB or process module", not (imported & banned), str(imported & banned))
    check("helper source does not read the dashboard token or any store file",
          ".dashboard-token" not in open(HELPER, encoding="utf-8").read()
          and "store" not in {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)})

    if shutil.which("git"):
        proc = subprocess.run(["git", "-C", ROOT, "diff", "--quiet", "HEAD", "--",
                               "scripts/hooks/email-approval-gate.py", "scripts/hooks/email_extract.py"])
        check("the gate and the extractor are byte-identical to HEAD (git diff empty)", proc.returncode == 0,
              f"git diff exit={proc.returncode}")
    else:
        print("  [SKIP] git not found: gate/extractor diff not checked")

print()
if failed:
    print(f"{len(failed)} FAILED: " + "; ".join(failed))
    sys.exit(1)
print("all passed")
