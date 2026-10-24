"""MS365MAIL1024: the Microsoft Graph MCP's hyphenated mail tools reach the main agent's
email approval gate.

The Graph MCP server names its tools with hyphens (send-mail, reply-mail-message, ...)
and carries the letter in Graph's own shape under `body` (body.Message.toRecipients[]
.emailAddress.address, subject, body.content). Before this, the classifier returned None
for every such name, so a send-mail went out with no approval at any level.

Branches proven:
  - level 1 denies every Graph send (send-mail, a reply, a shared-mailbox send, a draft send);
    level 3 allows; a flag update (update-mail-message isRead) is not a send.
  - level 2: the send-mail payload is denied without approval and carries the anchor; with
    that anchor approved it passes. The anchor covers the id the call answers: an approval
    for forwarding message m1 does not answer the same forward of message m2.
  - fail-closed: a field the anchor does not cover (attachments), a stray top-level
    recipient field, a key twice in different case, a MIME (string) body, an extra key in a
    recipient item and a non-text address are each denied as not anchorable.
  - the owner-CC check reads the Graph recipients.
  - email_extract reads the Graph text and puts the messageId into the anchor's `to`.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "email-approval-gate.py")
WINDOW = 1800
NOW_S = "CAST(strftime('%s','now') AS INTEGER)"
OWNER = "owner@example.com"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(root, level):
    store = os.path.join(root, "store")
    os.makedirs(store, exist_ok=True)
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [
            {"key": "email_send", "label": "Email", "level": level, "locked": False}]}, fh)
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


def owner_store(root, level, owner=OWNER):
    """A store whose install root (its parent) has a .env with MAIL_OWNER_CC."""
    store = make_store(root, level)
    with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
        fh.write(f"MAIL_OWNER_CC={owner}\n")
    return store


def run_gate(store, payload):
    env = dict(os.environ,
               EMAIL_APPROVAL_GATE_STORE=store,
               EMAIL_APPROVAL_WINDOW_S=str(WINDOW),
               OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
    proc = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(),
                          capture_output=True, env=env)
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


def approve(store, anchor):
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute(
        "INSERT INTO approvals (id, agent_id, category, action_description, status,"
        " requested_at, resolved_at, resolved_by, content_hash, consumed_at)"
        " VALUES (hex(randomblob(6)), 'main', 'email_send', 'Email teszt', 'approved',"
        f" {NOW_S}-60, {NOW_S}, 'owner', ?, NULL)", (anchor,))
    con.commit()
    con.close()


def anchor_from_stderr(err):
    m = re.search(r"\b([0-9a-f]{64})\b", err)
    return m.group(1) if m else None


def recipients(*addrs):
    return [{"emailAddress": {"address": a}} for a in addrs]


def message(to=("a@example.com",), cc=(), subject="Teszt targy", content="Kedves Ugyfelunk! Torzs."):
    m = {"subject": subject, "body": {"contentType": "Text", "content": content}, "toRecipients": recipients(*to)}
    if cc:
        m["ccRecipients"] = recipients(*cc)
    return m


def ms365_send(msg=None, **top):
    """The send-mail call as the Graph MCP takes it (the payload the gate let through)."""
    return {"tool_name": "mcp__ms365__send-mail",
            "tool_input": {"body": {"Message": msg if msg is not None else message(), "SaveToSentItems": True}, **top}}


def call(tool, tool_input):
    return {"tool_name": f"mcp__ms365__{tool}", "tool_input": tool_input}


with tempfile.TemporaryDirectory() as td:
    # --- level 1: every Graph send is denied ----------------------------------
    store = make_store(os.path.join(td, "l1"), 1)
    for payload in (ms365_send(),
                    call("reply-mail-message", {"messageId": "m1", "body": {"Comment": "Koszonom."}}),
                    call("send-shared-mailbox-mail", {"userId": "shared-1", "body": {"Message": message()}}),
                    call("send-draft-message", {"messageId": "d1"})):
        code, _, err = run_gate(store, payload)
        check(f"level 1: {payload['tool_name']} DENIED", code == 2 and "szint 1" in err, f"exit={code} err={err[:160]!r}")
    code, _, err = run_gate(store, call("update-mail-message", {"messageId": "m1", "body": {"isRead": True}}))
    check("level 1: update-mail-message isRead is not a send -> passes", code == 0, f"exit={code} err={err[:160]!r}")

    # --- level 3: allowed -------------------------------------------------------
    code, _, err = run_gate(make_store(os.path.join(td, "l3"), 3), ms365_send())
    check("level 3: send-mail allowed", code == 0, f"exit={code} err={err[:160]!r}")

    # --- level 2: the approval loop on the Graph shape --------------------------
    store = make_store(os.path.join(td, "l2"), 2)
    payload = ms365_send()
    code, _, err = run_gate(store, payload)
    anchor = anchor_from_stderr(err)
    check("level 2: send-mail without approval DENIED, the deny carries the anchor",
          code == 2 and "NINCS jovahagyas" in err and anchor is not None, f"exit={code} err={err[:200]!r}")
    check("the deny names the Graph recipient", "a@example.com" in err, f"err={err[:200]!r}")
    approve(store, anchor)
    code, out, err = run_gate(store, payload)
    check("level 2: send-mail with its approved anchor ALLOWED", code == 0 and "felhasznalva" in out,
          f"exit={code} out={out[:120]!r} err={err[:160]!r}")

    # The anchor covers bcc: the approved letter with an added bccRecipients is another letter.
    code, _, err = run_gate(store, ms365_send({**message(), "bccRecipients": recipients("hidden@example.org")}))
    check("the approved send-mail with an added bccRecipients is NOT answered by that approval",
          code == 2 and "NINCS jovahagyas" in err and anchor_from_stderr(err) not in (None, anchor),
          f"exit={code} err={err[:200]!r}")

    # The anchor covers the message a forward answers.
    fwd = lambda mid: call("forward-mail-message", {"messageId": mid, "body": {
        "ToRecipients": recipients("x@example.org"), "Comment": "Lasd lent."}})
    code, _, err = run_gate(store, fwd("m1"))
    a1 = anchor_from_stderr(err)
    approve(store, a1)
    code, _, err = run_gate(store, fwd("m2"))
    check("an approval for forwarding m1 does not answer forwarding m2",
          code == 2 and "NINCS jovahagyas" in err and anchor_from_stderr(err) not in (None, a1),
          f"exit={code} err={err[:200]!r}")
    code, out, _ = run_gate(store, fwd("m1"))
    check("the forward of m1 itself passes with its approval", code == 0 and "felhasznalva" in out, f"exit={code}")

    # --- fail-closed shapes at level 2 -------------------------------------------
    # Each must be the NOT-ANCHORABLE deny with its own reason, not just any deny: a plain
    # "no approval" deny would also exit 2 and would hide a reader that let the field through.
    bad = {
        "an attachment in the Message": (ms365_send({**message(), "attachments": []}), "attachments"),
        "an unknown field in body": ({"tool_name": "mcp__ms365__send-mail", "tool_input": {"body": {
            "Message": message(), "Attachments": []}}}, "ismeretlen mezo a body-ban"),
        "a stray top-level bccRecipients": (ms365_send(bccRecipients=recipients("hidden@example.org")), "bccrecipients"),
        "toRecipients twice in different case": (ms365_send({**message(), "ToRecipients": recipients("b@example.com")}),
                                                  "ketszer szerepel"),
        "a MIME (string) body": ({"tool_name": "mcp__ms365__send-mail", "tool_input": {"body": "TUlNRS1WZXJzaW9uOiAxLjA="}},
                                 None),
        "an extra key in a recipient item": (ms365_send({**message(), "toRecipients": [
            {"emailAddress": {"address": "a@example.com"}, "type": "to"}]}), "ismeretlen mezo ['type']"),
        "an address that is not text": (ms365_send({**message(), "toRecipients": [{"emailAddress": {"address": 5}}]}),
                                         "hianyzik vagy nem szoveg"),
    }
    for what, (payload, why) in bad.items():
        code, _, err = run_gate(store, payload)
        if why is None:
            # A string body is not Graph-shaped: the flat reader finds no recipient and denies.
            check(f"level 2, fail-closed: {what} DENIED (no recipient)", code == 2 and "cimzett" in err,
                  f"exit={code} err={err[:200]!r}")
        else:
            check(f"level 2, fail-closed: {what} DENIED as not anchorable, naming why",
                  code == 2 and "nem horgonyozhato" in err and why in err.lower(), f"exit={code} err={err[:220]!r}")

    # --- owner CC reads the Graph recipients --------------------------------------
    store = owner_store(os.path.join(td, "owner3"), 3)
    code, _, err = run_gate(store, ms365_send(message(cc=(OWNER,))))
    check("owner CC: the owner in ccRecipients -> the owner check passes (level 3 allows)", code == 0,
          f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, ms365_send())
    check("owner CC: without the owner -> DENIED with the owner-copy message",
          code == 2 and "A gazda masolata hianyzik" in err and OWNER in err, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, ms365_send(ccRecipients=recipients(OWNER)))
    check("owner CC: the owner only in a stray top-level ccRecipients does NOT count (it may not be delivered)",
          code == 2 and "A gazda masolata hianyzik" in err, f"exit={code} err={err[:200]!r}")

    # --- the recipient ledger reads the Graph recipients, strays included ------------
    def ledger_store(root, level, known):
        st = make_store(root, level)
        with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
            fh.write("MAIN_AGENT_RECIPIENT_LEDGER=1\n")
        with open(os.path.join(st, "verified-recipients.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "recipients": {a: {"source": "owner"} for a in known}}, fh)
        return st
    st = ledger_store(os.path.join(td, "ledger"), 3, ["known@example.com"])
    draft = lambda **extra: call("create-draft-email", {"body": {
        "subject": "Teszt targy", "body": {"contentType": "Text", "content": "Kedves Ugyfelunk!"},
        "toRecipients": recipients(extra.pop("to", "known@example.com"))}, **extra})
    code, _, err = run_gate(st, draft())
    check("ledger on: a Graph draft to a known address passes", code == 0, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(st, draft(to="invented@example.org"))
    check("ledger on: a Graph draft to an unknown address is denied",
          code == 2 and "Nem igazolt cimzett: invented@example.org" in err, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(st, draft(ccRecipients=recipients("invented@example.org")))
    check("ledger on: an unknown address in a stray top-level ccRecipients is denied too",
          code == 2 and "invented@example.org" in err, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(st, ms365_send(message(to=("invented@example.org",))))
    check("ledger on: a Graph send to an unknown address is denied at level 3",
          code == 2 and "invented@example.org" in err, f"exit={code} err={err[:200]!r}")

    # --- the extractor itself ---------------------------------------------------------
    spec = importlib.util.spec_from_file_location("email_extract_ms365_test", os.path.join(HOOKS, "email_extract.py"))
    ee = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ee)
    ti = ms365_send()["tool_input"]
    check("collect_mcp_body reads the Graph subject and content",
          ee.collect_mcp_body(ti) == "Teszt targy\nKedves Ugyfelunk! Torzs.", repr(ee.collect_mcp_body(ti)))
    to, cc, bcc, text, reason = ee.ms365_send_fields({"messageId": "m9", "body": {"Comment": "Rendben."}})
    check("ms365_send_fields: a reply's anchor holds its messageId", reason is None and to == ["messageId:m9"]
          and text == "Rendben.", f"to={to} text={text!r} reason={reason!r}")
    check("classify_mail_tool: send-mail is a send, list-mail-messages is not",
          ee.classify_mail_tool("mcp__ms365__send-mail") == "connector_send"
          and ee.classify_mail_tool("mcp__ms365__list-mail-messages") is None)


print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate ms365 tests passed.")
