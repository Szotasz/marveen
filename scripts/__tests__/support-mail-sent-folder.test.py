#!/usr/bin/env python3
"""ISSUE3181SENDPY (#3181): scripts/support-mail/send.py files its audit copy in the
mailbox's real Sent folder, and the letter carries Date and Message-ID.

Before: the copy always went to "INBOX.Sent" (an ordinary folder on, for example,
a Dovecot server whose Sent folder is "Sent"), and the letter had no Date and no
Message-ID header (smtplib adds neither).

main() runs for real here, with SMTP, IMAP, the vault and sender_check replaced by
recorders: nothing leaves the machine. The same run shows the delivered message,
the folder the copy went to, and the letter the approval check was handed.

Run:  python3 scripts/__tests__/support-mail-sent-folder.test.py
"""
import importlib.util
import io
import os
import sys
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SEND = os.path.join(ROOT, "scripts", "support-mail", "send.py")
FAILS = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  -- " + str(detail)) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


spec = importlib.util.spec_from_file_location("support_send", SEND)
send = importlib.util.module_from_spec(spec)
spec.loader.exec_module(send)

# ---- the LIST parser and the folder choice --------------------------------------
P = send.parse_list_line
check("quoted name, '.' delimiter", P(b'(\\HasNoChildren \\Sent) "." "INBOX.Sent"') == ({"\\hasnochildren", "\\sent"}, "INBOX.Sent"))
check("bare atom name, '/' delimiter", P(b'(\\HasNoChildren \\Sent) "/" Sent') == ({"\\hasnochildren", "\\sent"}, "Sent"))
check("NIL delimiter", P(b'(\\Noinferiors) NIL INBOX') == ({"\\noinferiors"}, "INBOX"))
check("escaped quote and backslash in a quoted name", P(b'(\\Sent) "/" "a\\"b\\\\c"') == ({"\\sent"}, 'a"b\\c'))
check("escaped delimiter", P(b'() "\\\\" "Sent"') == (set(), "Sent"))
check("a literal name arrives as a tuple", P((b'(\\Sent) "/" {13}', b"Sent Messages")) == ({"\\sent"}, "Sent Messages"))
check("garbage does not parse", P(b"* garbage") is None and P(b'(\\Sent) "/"') is None)

DOVECOT = [b'(\\HasNoChildren) "/" INBOX', b'(\\HasNoChildren \\Sent) "/" Sent', b'(\\HasNoChildren) "/" "INBOX.Sent"']
# The shape of the LIST reply measured on our own (Hostinger) support mailbox, 2026-11-27: bare atoms, "." delimiter.
COURIER = [b'(\\HasChildren) "." INBOX', b'(\\HasNoChildren \\UnMarked \\Trash) "." INBOX.Trash',
           b'(\\HasNoChildren \\UnMarked \\Sent) "." INBOX.Sent', b'(\\HasNoChildren \\UnMarked \\Junk) "." INBOX.Junk',
           b'(\\HasNoChildren \\UnMarked \\Drafts) "." INBOX.Drafts']
check("Dovecot shape: the \\Sent mailbox, not the plain INBOX.Sent", send.sent_folder_from_list(DOVECOT) == "Sent")
check("Courier shape: INBOX.Sent stays", send.sent_folder_from_list(COURIER) == "INBOX.Sent")
check("our measured reply picks INBOX.Sent through its \\Sent flag, not the fallback",
      send.choose_sent_folder("", COURIER) == ("INBOX.Sent", "\\Sent"))
check("a \\Noselect \\Sent mailbox is skipped", send.sent_folder_from_list([b'(\\Noselect \\Sent) "/" X', b'(\\Sent) "/" Y']) == "Y")
check("no \\Sent flag: None", send.sent_folder_from_list([b'() "/" INBOX']) is None)

C = send.choose_sent_folder
check("order 1: SUPPORT_SENT_FOLDER wins over \\Sent", C("Archive.Sent", DOVECOT) == ("Archive.Sent", "SUPPORT_SENT_FOLDER"))
check("order 2: the \\Sent mailbox", C("", DOVECOT) == ("Sent", "\\Sent"))
check("order 3: the INBOX.Sent fallback", C("", []) == ("INBOX.Sent", "fallback"))
check("a mailbox name with a space is quoted for IMAP", send.imap_mailbox_arg("Sent Messages") == '"Sent Messages"' and send.imap_mailbox_arg("INBOX.Sent") == "INBOX.Sent")

# ---- main() end to end, nothing leaves the machine ------------------------------
class FakeSMTP:
    sent = []
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def login(self, *a): pass
    def send_message(self, msg, to_addrs=None): FakeSMTP.sent.append(msg)


class FakeIMAP:
    list_reply = ("OK", DOVECOT)
    list_raises = False
    appended = []
    def __init__(self, *a, **k): pass
    def login(self, *a): pass
    def list(self, *a):
        if FakeIMAP.list_raises:
            raise OSError("LIST refused")
        return FakeIMAP.list_reply
    def append(self, mailbox, flags, when, data): FakeIMAP.appended.append((mailbox, data))
    def logout(self): pass


letters = []
send.smtplib.SMTP_SSL = FakeSMTP
send.imaplib.IMAP4_SSL = FakeIMAP
send.lib.password = lambda: "not-a-real-password"
send.lib.FROM_ADDRESS = "support@example.test"
send.lib.EMAIL = "support@example.test"
send.sender_check.check = lambda letter, phase="full": (letters.append((phase, dict(letter))), [])[1]


def run_main(env_folder=None):
    FakeSMTP.sent.clear(); FakeIMAP.appended.clear(); letters.clear()
    send.lib.SENT_FOLDER = env_folder or ""
    sys.argv = ["send.py", "--to", "customer@example.test", "--subject", "Hello", "--body", "Body text", "--no-owner-cc"]
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        send.main()
    return out.getvalue(), err.getvalue()


out, err = run_main()
msg = FakeSMTP.sent[0] if FakeSMTP.sent else None
check("the delivered letter has a Date header", msg is not None and bool(msg["Date"]), out + err)
mid = msg["Message-ID"] if msg is not None else None
check("the delivered letter has a Message-ID on the sender's domain", bool(mid) and mid.endswith("@example.test>"), mid)
copy = FakeIMAP.appended[0] if FakeIMAP.appended else (None, b"")
check("the audit copy went to the \\Sent mailbox", copy[0] == "Sent", copy[0])
check("the audit copy carries the same Message-ID", bool(mid) and ("Message-ID: " + mid).encode() in copy[1])
check("the output names the folder and why", "audit: copy appended to Sent (\\Sent)" in out, out)

# The approval check sees the same letter as without the fix: no header in it.
keys = sorted(letters[0][1].keys()) if letters else []
check("the approval check is handed the envelope fields only, no Date / Message-ID",
      keys == sorted(["to", "cc", "text", "render", "attachments", "raw_to", "raw_cc", "explicit_to", "explicit_cc", "default_cc"]), keys)
check("the letter text is subject + body, as before", letters and letters[0][1]["text"] == "Hello\nBody text")

out, err = run_main(env_folder="Custom.Sent")
check("SUPPORT_SENT_FOLDER is used as configured", FakeIMAP.appended and FakeIMAP.appended[0][0] == "Custom.Sent", FakeIMAP.appended)

FakeIMAP.list_raises = True
out, err = run_main()
FakeIMAP.list_raises = False
check("a failed LIST still files the copy, in INBOX.Sent", FakeIMAP.appended and FakeIMAP.appended[0][0] == "INBOX.Sent", FakeIMAP.appended)
check("and says so", "LIST failed" in err and "(fallback)" in out, out + err)
check("the letter was sent anyway", len(FakeSMTP.sent) == 1)

FakeIMAP.list_reply = ("OK", COURIER)
out, err = run_main()
check("our Courier-style mailbox keeps INBOX.Sent", FakeIMAP.appended and FakeIMAP.appended[0][0] == "INBOX.Sent", FakeIMAP.appended)

FakeIMAP.list_reply = ("OK", [b'() "/" INBOX', (b'(\\HasNoChildren \\Sent) "/" {13}', b"Sent Messages")])
out, err = run_main()
check("a \\Sent mailbox with a space in its name is appended to as a quoted string",
      FakeIMAP.appended and FakeIMAP.appended[0][0] == '"Sent Messages"', FakeIMAP.appended)

print()
print("support-mail-sent-folder: " + ("ALL PASS" if not FAILS else f"{len(FAILS)} FAILED"))
sys.exit(1 if FAILS else 0)
