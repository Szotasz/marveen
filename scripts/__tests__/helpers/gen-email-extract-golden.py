#!/usr/bin/env python3
"""Golden-fixture generator for the email extraction parity test (EMAILKAPU901 PR1).

Run ONCE against the PRE-refactor scripts/hooks/outgoing-copy-gate.py (commit
8ccacdf8, before collect_bash_body/collect_mcp_body moved to email_extract.py)
to capture the exact (text, unreadable_reason) outputs. The parity test then
proves the extracted module reproduces these bytes exactly. Re-running this
generator against the refactored code would capture the NEW behavior and make
the test tautological -- regenerate only when the extraction contract itself
changes deliberately, and say so in the commit message.

Usage: python3 gen-email-extract-golden.py <source-module.py> <out.json>
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(os.path.dirname(HERE), "fixtures")
BODY_FILE = os.path.join(FIXTURES, "email-extract-body.txt")
BODY_FILE_LATIN1 = os.path.join(FIXTURES, "email-extract-body-latin1.txt")


def load_module(path):
    spec = importlib.util.spec_from_file_location("golden_src", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bash_cases():
    # {BODY_FILE} is substituted at run time in the parity test too, so the
    # golden stores the case template, not a machine-specific path.
    return [
        ("inline-body-subject",
         'send.py --to a@b.hu --subject "Teszt tárgy ékezettel" --body "Kedves Ügyfelünk! Ez a törzs."'),
        ("inline-single-quotes",
         "send.py --subject 'Egy tárgy' --body 'Törzs aposztróffal'"),
        ("inline-unquoted-token",
         "send.py --body Egyszavas --subject Targy"),
        ("redirect-abs-file",
         'sendmail a@b.hu --subject "Fájlból jövő törzs" < {BODY_FILE}'),
        # invalid UTF-8 in the body file: pins the errors="replace" decode
        # policy (a "replace"->"ignore" mutation is invisible on clean UTF-8)
        ("redirect-invalid-utf8",
         'sendmail a@b.hu < {BODY_FILE_LATIN1}'),
        ("subst-dollar-paren",
         'send.py --body "$(cat /tmp/level.txt)" --subject "Utána jövő tárgy"'),
        ("subst-backtick",
         'send.py --body "`cat /tmp/x.txt`"'),
        ("subst-var",
         'send.py --body "$BODY_VAR" --subject "Tárgy"'),
        ("subst-var-braced",
         'send.py --body "${BODY_VAR}"'),
        ("heredoc-inline",
         "sendmail a@b.hu <<'EOF'\nHeredoc törzs első sor.\nMásodik sor.\nEOF"),
        ("redirect-unresolvable-var-path",
         'sendmail a@b.hu < $NOPE_VAR_EMAILKAPU901/body.txt'),
        ("redirect-missing-file",
         'sendmail a@b.hu < /nonexistent-emailkapu901/body.txt'),
        ("pipe-into-send",
         'cat /tmp/x.txt | python3 send.py --to a@b.hu'),
        ("no-body-flags-no-pipe",
         'send.py --to a@b.hu'),
    ]


def mcp_cases():
    return [
        ("mcp-body-subject",
         {"to": ["a@b.hu"], "subject": "MCP tárgy", "body": "MCP törzs ékezettel: űrhajó."}),
        ("mcp-html-message-content",
         {"html": "<p>HTML törzs</p>", "message": "Üzenet mező", "content": "Content mező"}),
        ("mcp-htmlbody-text",
         {"htmlBody": "<b>b</b>", "text": "Sima szöveg"}),
        ("mcp-empty-fields",
         {"to": ["a@b.hu"], "body": "", "subject": None}),
        ("mcp-non-string-body",
         {"body": 42, "subject": ["lista", "elem"]}),
    ]


def main():
    src, out = sys.argv[1], sys.argv[2]
    mod = load_module(src)
    golden = {"source": os.path.basename(src), "bash": {}, "mcp": {}}
    for name, tpl in bash_cases():
        cmd = tpl.replace("{BODY_FILE_LATIN1}", BODY_FILE_LATIN1).replace("{BODY_FILE}", BODY_FILE)
        text, reason = mod.collect_bash_body(cmd)
        golden["bash"][name] = {"cmd_template": tpl, "text": text, "reason": reason}
    for name, tool_input in mcp_cases():
        text = mod.collect_mcp_body(tool_input)
        golden["mcp"][name] = {"tool_input": tool_input, "text": text}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(golden, fh, ensure_ascii=False, indent=2)
    print(f"golden written: {out} ({len(golden['bash'])} bash + {len(golden['mcp'])} mcp cases)")


if __name__ == "__main__":
    main()
