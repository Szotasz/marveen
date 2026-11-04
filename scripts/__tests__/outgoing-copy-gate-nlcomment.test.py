#!/usr/bin/env python3
"""MAINGATENLCOMMENT1104 (Samu 69660/2): the main agent's approval gate reads a shell comment as bash does.

Measured on develop before the fix (is_send_invocation): a comment on one line swallowed the send on the next
("echo hi # note" newline "sendmail a@b.hu" -> False), an apostrophe in the comment did the same, and a # inside a
word started a comment ("echo a#b; sendmail a@b.hu" -> False). The shared rows live in send-invocation-cases.json;
this file holds the forms where only the python twin is exact (the JS twin keeps every word: MJSTOKCOMMENT1010)."""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ocg", os.path.join(HERE, "..", "hooks", "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)
failed = []


def check(name, cond, extra=""):
    print(("  [PASS] " if cond else "  [FAIL] ") + name + ("" if cond else f" -- {extra}"))
    if not cond:
        failed.append(name)


for cmd, want, what in [
    ("echo hi # note; sendmail a@b.hu", False, "a comment runs to the end of its line, a ; inside it too"),
    ("echo hi # note\nsendmail a@b.hu", True, "the next line is a command again"),
    ("echo hi # a 'quote\nsendmail a@b.hu", True, "a quote inside a comment is comment text"),
    ("echo a#b; sendmail a@b.hu", True, "a # inside a word"),
    ("echo $# x; sendmail a@b.hu", True, "$# is no comment"),
    ("echo ${#x}; sendmail a@b.hu", True, "${#x} is no comment"),
    ("echo 'it''s' # c\nsendmail a@b.hu", True, "quotes before a comment"),
    ("# only a comment", False, "a command that is only a comment"),
]:
    got = ocg.is_send_invocation(cmd)
    check(f"{what}: {cmd!r} -> {want}", got is want, f"got {got}")
for cmd, want in [
    ("echo a#b; x", [["echo", "a#b"], ["x"]]),
    ("echo hi # c\nx", [["echo", "hi"], ["x"]]),
    ("echo \"#q\" z", [["echo", "#q", "z"]]),
]:
    got = ocg._segments_tokens(cmd)
    check(f"tokens of {cmd!r}", got == want, f"got {got}")

# email-approval-gate.py names_own_sender (DENY-only): the same shlex default hid the project's own sender after a #
sys.path.insert(0, os.path.join(HERE, "..", "hooks"))
spec2 = importlib.util.spec_from_file_location("eag_nl", os.path.join(HERE, "..", "hooks", "email-approval-gate.py"))
eag = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(eag)
ROOT = os.path.realpath(os.path.join(HERE, "..", ".."))
for cmd, want, what in [
    ("python3 scripts/support-mail/send.py --to a@b.hu", True, "control: the own sender, plain"),
    ("echo a#b; python3 scripts/support-mail/send.py --to a@b.hu", True, "a # inside a word before the own sender"),
    ("echo hi # c\npython3 scripts/support-mail/send.py --to a@b.hu", True, "a comment line before the own sender"),
    ("python3 scripts/other.py", False, "control: another script"),
]:
    got = eag.names_own_sender(cmd, ROOT)
    check(f"names_own_sender {what}: {cmd!r} -> {want}", got is want, f"got {got}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate-nlcomment tests passed.")
