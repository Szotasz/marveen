"""MS365MAIL1024: the outgoing copy gate audits the Microsoft Graph MCP's letters.

The Graph MCP's hyphenated tools (send-mail, update-mail-message, ...) used to classify as
"not mail", so the copy gate exited 0 on them without reading anything. Now a Graph send is
audited on its subject and body content; a flag/read update that carries no text of ours
(update-mail-message {isRead: true}) still passes, while an update that writes text is audited.

The audit is proven through the rules file's fail-closed branch: with an unparseable rules
file an audited email exits 2, an unaudited call exits 0.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
TEXT = "Kedves Ügyfelünk! Köszönjük a megkeresést, a választ hamarosan küldjük."

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def run_hook(payload, rules_file):
    env = dict(os.environ, OUTGOING_COPY_GATE_RULES=rules_file)
    p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True,
                       text=True, env=env, timeout=20)
    return p.returncode, p.stdout, p.stderr


def send_mail(content=TEXT):
    return {"tool_name": "mcp__ms365__send-mail", "tool_input": {"body": {"Message": {
        "subject": "Válasz a megkeresésére", "body": {"contentType": "Text", "content": content},
        "toRecipients": [{"emailAddress": {"address": "a@example.com"}}]}, "SaveToSentItems": True}}}


with tempfile.TemporaryDirectory(prefix="copygate-ms365-") as tmp:
    corrupt = os.path.join(tmp, "corrupt.json")
    with open(corrupt, "w", encoding="utf-8") as fh:
        fh.write("{ not valid json ]")
    no_rule = os.path.join(tmp, "no-rule.json")
    with open(no_rule, "w", encoding="utf-8") as fh:
        json.dump({"no_name_rule": True, "no_name_rule_reason": "teszt: nincs nev-szabaly"}, fh)

    code, out, err = run_hook(send_mail(), corrupt)
    check("send-mail with an unparseable rules file: audited as email, fail-closed (exit 2)",
          code == 2, f"exit={code} err={err[:200]!r}")
    code, out, err = run_hook(send_mail(), no_rule)
    check("send-mail with clean Hungarian text and no name rule: passes (exit 0)",
          code == 0, f"exit={code} err={err[:200]!r}")

    code, out, err = run_hook({"tool_name": "mcp__ms365__update-mail-message",
                               "tool_input": {"messageId": "m1", "body": {"isRead": True}}}, corrupt)
    check("update-mail-message isRead: no text of ours, not audited (exit 0) even with a broken rules file",
          code == 0, f"exit={code} err={err[:200]!r}")
    code, out, err = run_hook({"tool_name": "mcp__ms365__update-mail-message",
                               "tool_input": {"messageId": "m1", "body": {"subject": "Uj targy",
                                              "body": {"contentType": "Text", "content": TEXT}}}}, corrupt)
    check("update-mail-message that writes text: audited (exit 2 with the broken rules file)",
          code == 2, f"exit={code} err={err[:200]!r}")

    code, out, err = run_hook({"tool_name": "mcp__ms365__update-mail-message",
                               "tool_input": {"messageId": "m1", "subject": "Uj targy",
                                              "body": {"contentType": "Text", "content": "Szoveg"}}}, corrupt)
    check("update-mail-message with the fields at the top (body is the itemBody): audited (exit 2)",
          code == 2, f"exit={code} err={err[:200]!r}")
    code, out, err = run_hook({"tool_name": "mcp__ms365__update-mail-message",
                               "tool_input": {"messageId": "m1", "body": {"subject": "A", "Subject": "B"}}}, corrupt)
    check("update-mail-message with a subject twice in different case: unreadable, not 'no text' (exit 2)",
          code == 2, f"exit={code} err={err[:200]!r}")
    # Round 2: the Graph read is by NAME, so a body-less update whose only text is a
    # capitalized top-level Subject is audited too -- it is Graph material, not "no text".
    code, out, err = run_hook({"tool_name": "mcp__ms365__update-mail-message",
                               "tool_input": {"messageId": "m1", "Subject": "Uj targy"}}, corrupt)
    check("update-mail-message body-less with a capitalized top-level Subject: audited (exit 2)",
          code == 2, f"exit={code} err={err[:200]!r}")
    code, out, err = run_hook({"tool_name": "mcp__ms365__send-mail", "tool_input": {"body": {
        "Message": {"subject": "Valasz a megkeresesere", "body": {"contentType": "Text", "content": TEXT},
                    "toRecipients": [{"emailAddress": {"address": "a@example.com"}}]},
        "message": {"subject": "Masik targy", "body": {"contentType": "Text", "content": "Masik torzs."}}}}},
        no_rule)
    check("send-mail with both Message and message in body: unreadable even with a clean rules file (exit 2)",
          code == 2, f"exit={code} err={err[:200]!r}")

    code, out, err = run_hook({"tool_name": "mcp__ms365__list-mail-messages", "tool_input": {}}, corrupt)
    check("list-mail-messages: not mail, untouched (exit 0)", code == 0, f"exit={code} err={err[:200]!r}")


print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate ms365 tests passed.")
