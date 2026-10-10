#!/usr/bin/env python3
"""CREDGATE1003: the credential gate stops a letter that carries a password,
PIN or login key, unless it is acknowledged as the recipient's own, unique
credential -- and never for a shared one.

Acceptance (the five points the gate was specified with):
  (1) a letter with "admin jelszo: <made-up value>" is DENIED;
  (2) the same letter with a one-shot acknowledgement goes out, and the
      acknowledgement is logged (who, why);
  (3) a value on the shared list is denied even when acknowledged;
  (4) a letter without a credential goes out untouched;
  (5) the gate never writes the value: not in the log, not in the state, not
      on stdout or stderr -- only its length and an 8-hex fingerprint prefix.
Plus the detector's false-positive set and boundaries, the cross-recipient
check with its owner-approved alias, warn mode, the drafts, and every
fail-closed branch. Every value in this file is made up.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GATE = os.path.join(ROOT, "scripts", "hooks", "credential-gate.py")
CLI = os.path.join(ROOT, "scripts", "credential-gate-cli.py")
sys.path.insert(0, os.path.join(ROOT, "scripts", "hooks"))
import credential_lib as cl  # noqa: E402

# Made-up values; the leak check below looks for every one of them.
VAL = "Xk29proba"
VAL2 = "Kiskert2099z"
SHARED = "KozosPr0ba"
ALL_VALUES = (VAL, VAL2, SHARED, "TitkosProba7", "4821", "Kert!proba", "probaUrlJelszo9")
NOW_S = "CAST(strftime('%s','now') AS INTEGER)"

failed = []
outputs = []   # every stdout/stderr the gate and the CLI produced, for (5)


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store():
    td = tempfile.mkdtemp(prefix="credgate-")
    store = os.path.join(td, "store")
    os.makedirs(store)
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
    return td, store


def env_for(store, **extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CREDENTIAL_GATE_")}
    env["CREDENTIAL_GATE_STORE"] = store
    env.update(extra)
    return env


def gate(store, tool, tool_input, raw=None, **extra):
    payload = raw if raw is not None else json.dumps({"tool_name": tool, "tool_input": tool_input})
    r = subprocess.run([sys.executable, GATE], input=payload, capture_output=True, text=True,
                       env=env_for(store, **extra), timeout=60)
    outputs.append(r.stdout + r.stderr)
    return r


def cli(store, *args, stdin=""):
    r = subprocess.run([sys.executable, CLI, *args], input=stdin, capture_output=True, text=True,
                       env=env_for(store), timeout=60)
    outputs.append(r.stdout + r.stderr)
    return r


def bash_send(td, to, body, name="body.txt"):
    path = os.path.join(td, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return {"command": f"send.py --to {to} --subject Proba < {path}"}


def anchor_for(tool_input):
    """The anchor the gate computes for a Bash send, from the same two
    implementations (extractor + the approval gate's anchor)."""
    import importlib.util
    from email_extract import collect_email_envelope
    spec = importlib.util.spec_from_file_location(
        "eag", os.path.join(ROOT, "scripts", "hooks", "email-approval-gate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.content_anchor(collect_email_envelope("Bash", tool_input))


def anchor_of(r):
    for tok in r.stderr.split():
        if len(tok) == 64 and all(c in "0123456789abcdef" for c in tok):
            return tok
    return None


def log_lines(store):
    path = os.path.join(store, "credential-gate.log")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(x) for x in fh if x.strip()]


def approve(store, category, content_hash, status="approved", rid="appr-1"):
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute(f"INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)"
                f" VALUES (?, 'teszt', ?, 'x', ?, {NOW_S}, ?)", (rid, category, status, content_hash))
    con.commit()
    con.close()


LETTER = "Kedves Ugyfel!\n\nA belepeshez: felhasznalo admin, admin jelszó: " + VAL + "\n\nUdvozlettel\n"
CLEAN = "Kedves Ugyfel!\n\nA rendszer rendben mukodik, a jelszavat a portalon tudja modositani.\n"


def test_acceptance():
    print("acceptance (1)-(5)")
    td, store = make_store()
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", LETTER))
    check("(1) a letter with a credential is denied", r.returncode == 2, r.stderr)
    check("(1) the deny names keyword, length and fingerprint, not the value",
          "admin" in r.stderr and f"{len(VAL)} karakter" in r.stderr and VAL not in r.stderr)
    anchor = anchor_of(r)
    check("(1) the deny hands over the letter's anchor", anchor is not None)
    a = cli(store, "ack", "--anchor", anchor, "--by", "teszt-ugynok",
            "--reason", "az ugyfel sajat eszkozenek egyedi jelszava, az atadasi lapjarol")
    check("(2) the acknowledgement is recorded", a.returncode == 0, a.stderr)
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", LETTER))
    check("(2) the acknowledged letter goes out", r.returncode == 0, r.stderr)
    allow = [x for x in log_lines(store) if x.get("decision") == "allow"]
    check("(2) the acknowledgement is logged with who and why",
          len(allow) == 1 and allow[0]["ack"]["by"] == "teszt-ugynok" and "egyedi" in allow[0]["ack"]["reason"])
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", LETTER))
    check("(2) the acknowledgement is one-shot: the same letter again is denied", r.returncode == 2)
    a = cli(store, "ack", "--anchor", anchor, "--by", "teszt-ugynok", "--reason", "ugyanannak a levelnek ujra (proba)")
    other = LETTER.replace("Udvozlettel", "Koszonettel")
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", other, name="other.txt"))
    check("(2) the acknowledgement is bound to its letter: another body is denied", r.returncode == 2
          and log_lines(store)[-1].get("reason") == "jeloles-nelkul", r.stderr)

    td, store = make_store()
    s = cli(store, "shared-add", "--note", "kozos eszkoz-jelszo (proba)", stdin=SHARED + "\n")
    check("(3) a value goes onto the shared list from stdin", s.returncode == 0, s.stderr)
    shared_letter = "Kedves Ugyfel!\nJelszó: " + SHARED + "\n"
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", shared_letter))
    anchor = anchor_of(r)
    check("(3) a shared value is denied", r.returncode == 2 and "KOZOS" in r.stderr, r.stderr)
    cli(store, "ack", "--anchor", anchor or "0" * 64, "--by", "teszt", "--reason", "probalom a kozoset is atvinni")
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", shared_letter))
    check("(3) ... and stays denied when acknowledged", r.returncode == 2 and "KOZOS" in r.stderr, r.stderr)

    td, store = make_store()
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", CLEAN))
    check("(4) a letter without a credential goes out", r.returncode == 0, r.stderr)
    check("(4) ... untouched: nothing logged, nothing printed", log_lines(store) == [] and r.stdout == "" and r.stderr == "")


def detect(text):
    return cl.detect(text, CFG, cl.make_fingerprint(b"k" * 32))


def test_detector():
    print("detector: hits")
    hits = {
        "admin jelszó: " + VAL: 1,
        "Bejelentkezés, felhasználónév Admin, jelszó TitkosProba": 1,   # no colon, internal capital
        "A jelszava a következő: titkosproba": 1,                        # bare word after a colon
        "Belépési adatok: admin / " + VAL2: 1,                           # user / password pair
        "Wi-Fi kulcs: \"Kert!proba\"": 1,
        "PIN-kód: 4821": 1,
        "JELSZO: " + VAL: 1,                                             # unaccented, upper-case key
        "jelszo " + VAL: 1,
        "> jelszó: " + VAL: 1,                                           # a quoted earlier mail goes out too
        "jelszó: " + VAL + ", PIN: 4821": 2,
        "https://user:probaUrlJelszo9@example.invalid/x": 1,
        "https://example.invalid/login?password=" + VAL + "&next=1": 1,
        "<p>jelszó: <b>" + VAL + "</b></p>": 1,                          # HTML body
        "Jelszó a routerhez: " + VAL: 1,                                 # a label continues the key
        "Jelszó:\n" + VAL: 1,                                            # a bare label, the value below it
        "Felhasználó: admin\nJelszó:\n  " + VAL2: 1,
    }
    for text, n in hits.items():
        got = detect(text)
        check(f"hit x{n}: {text[:48]!r}", len(got) == n, repr([(h['keyword'], h['length']) for h in got]))
    print("detector: no hits (the false-positive set)")
    misses = (
        "Jelszó: [KITAKARVA]", "jelszó: ***", "Jelszó: xxx", "jelszó: <ide jön>", "Jelszó: ${PASSWORD}",
        "A jelszó legalább 8 karakter hosszú legyen.",
        "Jelszavát a portálon tudja módosítani.",
        "Jelszó: lásd a csatolt útmutatót",
        "A jelszót elküldtük e-mailben.",
        "JELSZÓ: NINCS",                                                 # an all-caps word
        "Password: please change it after login",
        "Az admin jelszó és a belépési adatok: lásd lent",
        "Admin felület: https://example.invalid/admin",
        "https://example.invalid/login?next=/home",
        "PIN: 123",                                                      # shorter than min_length
        "Köszönjük, a rendszer rendben működik.",
        "A jelszóváltoztatás sikeres volt.",                             # a compound word
        "A spinning wheel and a pinpoint.",                              # 'pin' inside words
        "Kérdés esetén: admin@example-proba.invalid vagy admin@proba.invalid",  # an address, not a label
        "Jelszó:\n\n" + VAL,                                            # the next line only, not further
        "A jelszó\n" + VAL,                                              # no label: no continuation
    )
    for text in misses:
        got = detect(text)
        check(f"no hit: {text[:48]!r}", got == [], repr([(h['keyword'], h['length']) for h in got]))
    print("detector: what it returns")
    got = detect("első sor\nadmin jelszó: " + VAL)
    check("a hit carries keyword, line, length and fingerprint only",
          got and set(got[0]) == {"keyword", "line", "length", "fp"} and got[0]["line"] == 2
          and got[0]["length"] == len(VAL))
    k = cl.make_fingerprint(b"k" * 32)
    check("the fingerprint is keyed: another key, another fingerprint",
          k(VAL) != cl.make_fingerprint(b"j" * 32)(VAL))
    check("normalization: quotes and a trailing full stop do not change the fingerprint",
          k('"' + VAL + '".') == k(VAL))


def test_cross_recipient_and_alias():
    print("cross-recipient check and the owner-approved alias")
    td, store = make_store()
    r = gate(store, "Bash", bash_send(td, "elso@example.invalid", LETTER))
    cli(store, "ack", "--anchor", anchor_of(r), "--by", "teszt", "--reason", "az elso ugyfel sajat adata (proba)")
    check("first recipient: acknowledged letter goes out",
          gate(store, "Bash", bash_send(td, "elso@example.invalid", LETTER)).returncode == 0)
    r = gate(store, "Bash", bash_send(td, "masodik@example.invalid", LETTER))
    check("the same value to a second, unrelated recipient is denied as shared",
          r.returncode == 2 and "MASIK cimzettnek" in r.stderr, r.stderr)
    check("... and the deny names the alias way out and the approval category",
          "alias" in r.stderr and "credential_alias" in r.stderr)
    second = bash_send(td, "masodik@example.invalid", LETTER)
    check("the anchor in a deny equals the approval gate's anchor of the same letter",
          anchor_of(gate(store, "Bash", bash_send(td, "elso@example.invalid", LETTER))) ==
          anchor_for(bash_send(td, "elso@example.invalid", LETTER)))
    cli(store, "ack", "--anchor", anchor_for(second), "--by", "teszt", "--reason", "probalom jelolessel atvinni")
    r = gate(store, "Bash", bash_send(td, "masodik@example.invalid", LETTER))
    check("an acknowledgement does not lift the cross-recipient check", r.returncode == 2 and "MASIK" in r.stderr)
    fp8 = log_lines(store)[-1]["hits"][0]["fp8"]
    a = cli(store, "alias", "--fp", fp8, "--to", "elso@example.invalid", "--to", "Masodik <masodik@example.invalid>")
    check("an alias candidate is recorded by fingerprint, without the value", a.returncode == 0, a.stderr)
    r = gate(store, "Bash", bash_send(td, "masodik@example.invalid", LETTER))
    check("an alias without an approval changes nothing", r.returncode == 2 and "nincs jovahagyott alias" in r.stderr,
          r.stderr)
    with cl_state(store) as st:
        alias = next(iter(st.data["aliases"].values()))
    approve(store, "credential_alias", alias["anchor"])
    r = gate(store, "Bash", bash_send(td, "masodik@example.invalid", LETTER))
    check("with an approved alias the history check passes; the ack given while it counted as shared is void",
          r.returncode == 2 and "SAJAT" in r.stderr and "MASIK" not in r.stderr, r.stderr)
    cli(store, "ack", "--anchor", anchor_of(r), "--by", "teszt", "--reason", "ugyanaz az ugyfel, masik cime (alias)")
    check("alias + acknowledgement: the letter goes out",
          gate(store, "Bash", bash_send(td, "masodik@example.invalid", LETTER)).returncode == 0)
    approve(store, "credential_alias", alias["anchor"], status="rejected", rid="appr-2")
    r = gate(store, "Bash", bash_send(td, "masodik@example.invalid", LETTER))
    check("a later rejection revokes the alias (the last decision wins)",
          r.returncode == 2 and "rejected" in r.stderr, r.stderr)
    r = gate(store, "Bash", bash_send(td, "harmadik@example.invalid", LETTER))
    check("the alias covers exactly its recipient set", r.returncode == 2 and "MASIK" in r.stderr)

    td, store = make_store()
    with open(os.path.join(store, "credential-gate.json"), "w") as fh:
        json.dump({"auto_shared": False}, fh)
    for to in ("elso@example.invalid", "masodik@example.invalid"):
        r = gate(store, "Bash", bash_send(td, to, LETTER))
        cli(store, "ack", "--anchor", anchor_of(r), "--by", "teszt", "--reason", "sajat adat, kikapcsolt kozos-figyeles")
        r = gate(store, "Bash", bash_send(td, to, LETTER))
    check("auto_shared false: the second recipient only needs its own acknowledgement", r.returncode == 0, r.stderr)


class cl_state:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        os.environ["CREDENTIAL_GATE_STORE"] = self.store
        self.st = cl.State(write=False).__enter__()
        return self.st

    def __exit__(self, *a):
        self.st.__exit__(None, None, None)
        os.environ.pop("CREDENTIAL_GATE_STORE", None)


def test_scope_and_drafts():
    print("scope: drafts and MCP tools")
    td, store = make_store()
    r = gate(store, "mcp__mail__create_draft", {"to": "ugyfel@example.invalid", "subject": "x", "body": LETTER})
    check("a draft with a credential is denied (a draft is a letter someone will send)", r.returncode == 2, r.stderr)
    r = gate(store, "mcp__mail__send_email", {"to": "ugyfel@example.invalid", "subject": "x", "body": LETTER})
    check("an MCP send with a credential is denied", r.returncode == 2)
    r = gate(store, "mcp__mail__manage_email", {"operation": "search", "query": "jelszó"})
    check("a manage_email search (no letter body) passes", r.returncode == 0, r.stderr)
    r = gate(store, "mcp__claude_ai_Gmail__reply", {"messageId": "m-1", "body": LETTER})
    check("a connector reply is anchored to its messageId and denied", r.returncode == 2, r.stderr)
    check("a Bash call that is not a send passes", gate(store, "Bash", {"command": "ls -la"}).returncode == 0)
    check("a tool that cannot carry a letter passes", gate(store, "Read", {"file_path": "/x"}).returncode == 0)
    r = gate(store, "mcp__mail__create_draft", {"subject": "x", "body": LETTER})
    check("a credential with no readable recipient is denied, for that reason",
          r.returncode == 2 and log_lines(store)[-1].get("reason") == "cimzett-nelkul", r.stderr)


def test_warn_mode():
    print("warn mode")
    td, store = make_store()
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", LETTER), CREDENTIAL_GATE_MODE="warn")
    check("warn: the letter goes out", r.returncode == 0, r.stderr)
    check("warn: a visible warning, without the value", "figyelo mod" in r.stdout and VAL not in r.stdout)
    last = log_lines(store)[-1]
    check("warn: logged as warn with what block mode would have done",
          last["decision"] == "warn" and last["would_deny"] == "jeloles-nelkul")


def test_fail_closed():
    print("fail-closed branches")
    td, store = make_store()
    letter = bash_send(td, "ugyfel@example.invalid", LETTER)
    r = gate(store, "Bash", {}, raw="{not json")
    check("unparseable stdin is denied", r.returncode == 2)
    r = gate(store, "Bash", {"command": 'send.py --to ugyfel@example.invalid --body "$(cat level.txt)"'})
    check("an unreadable letter (shell substitution) is denied", r.returncode == 2 and "nem olvashato" in r.stderr,
          r.stderr)
    for bad, label in (("{not json", "broken JSON"), (json.dumps({"mode": "loud"}), "a bad mode"),
                       (json.dumps({"windw": 10}), "an unknown key"), (json.dumps({"keywords": ["("]}), "a bad regex")):
        with open(os.path.join(store, "credential-gate.json"), "w") as fh:
            fh.write(bad)
        r = gate(store, "Bash", letter)
        check(f"a config with {label} is denied, named",
              r.returncode == 2 and "nem tud ellenorizni" in r.stderr, r.stderr)
    os.remove(os.path.join(store, "credential-gate.json"))
    r = gate(store, "Bash", letter)
    keyf = os.path.join(store, "credential-gate.key")
    check("the key file is created 0600 on first use",
          os.path.exists(keyf) and stat.S_IMODE(os.stat(keyf).st_mode) == 0o600)
    os.chmod(keyf, 0o644)
    r = gate(store, "Bash", letter)
    check("a key file readable by others is refused", r.returncode == 2 and "jogosultsaga" in r.stderr, r.stderr)
    os.chmod(keyf, 0o600)
    with open(os.path.join(store, "credential-gate-state.json"), "w") as fh:
        fh.write("[]")
    r = gate(store, "Bash", letter)
    check("a broken state file is denied, named", r.returncode == 2 and "allapot" in r.stderr, r.stderr)
    os.remove(os.path.join(store, "credential-gate-state.json"))
    r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", CLEAN))
    check("a clean letter needs no key, state or log", r.returncode == 0)
    print("CLI input checks")
    check("ack: a malformed anchor is refused", cli(store, "ack", "--anchor", "abc", "--by", "x", "--reason", "x" * 20).returncode == 2)
    check("ack: a short reason is refused", cli(store, "ack", "--anchor", "a" * 64, "--by", "x", "--reason", "rovid").returncode == 2)
    check("alias: an unknown fingerprint is refused, nothing guessed",
          cli(store, "alias", "--fp", "deadbeef", "--to", "a@example.invalid").returncode == 2)
    st = cli(store, "status")
    check("status prints counts only", st.returncode == 0 and set(json.loads(st.stdout)) ==
          {"shared", "acks_open", "acks_used", "seen", "aliases"}, st.stdout + st.stderr)


def test_whitespace_class():
    print("T1: every Unicode whitespace between the key and the value, the &nbsp; family, CRLF")
    spaces = [chr(i) for i in range(0x110000) if chr(i).isspace()]
    check("the whitespace class is the 29 code points of str.isspace", len(spaces) == 29, str(len(spaces)))
    forms = (("Jelszó:", ""), ("Jelszó", ": "), ("admin jelszó", ""))
    for head, tail in forms:
        missed = [f"U+{ord(c):04X}" for c in spaces if c != "\n" and len(detect(head + c + tail + VAL)) != 1]
        check(f"one hit across every whitespace but the newline: {head!r} + ws + {tail!r} + value", not missed,
              " ".join(missed))
    for ent in ("&nbsp;", "&#160;", "&#xA0;", "&ensp;", "&emsp;", "&thinsp;"):
        check(f"one hit with the entity {ent} after the key", len(detect("<p>Jelszó:" + ent + VAL + "</p>")) == 1)
    check("one hit with &nbsp; and a space", len(detect("Jelszó:&nbsp; " + VAL)) == 1)
    got = detect("Kedves Ugyfel!\r\nJelszó:\r\n" + VAL + "\r\nUdvozlettel\r\n")
    check("CRLF: the value on the next line is found, as with LF, on its own line", len(got) == 1 and got[0]["line"] == 3,
          repr(got))
    check("CRLF: a value on the same line", len(detect("Jelszó: " + VAL + "\r\n")) == 1)
    check("CRLF: a label line, then the value indented", len(detect("Felhasználó: admin\r\nJelszó:\r\n  " + VAL2 + "\r\n")) == 1)
    check("a keyword written with a no-break space inside still matches",
          len(detect("Wi-Fi" + chr(0xA0) + "kulcs: \"Kert!proba\"")) == 1)
    check("no hit: a sentence with no-break spaces stays a sentence",
          detect("A jelszó" + chr(0xA0) + "legalább 8 karakter hosszú legyen.") == [])
    check("no hit: CRLF, an empty line between the label and the value (the next line only)",
          detect("Jelszó:\r\n\r\n" + VAL) == [])
    # the token reader itself steps over any whitespace (not only through prepare_text)
    raw = "Jelszó:" + chr(0xA0) + VAL
    got = cl._candidate(raw, len("Jelszó"), len(raw), CFG)
    check("the scan steps over a raw no-break space too", got is not None and got[1] == VAL, repr(got))
    raw = "Jelszó: titkosproba" + chr(0x2009)
    got = cl._candidate(raw, len("Jelszó"), len(raw), CFG)
    check("a bare word ends its clause before a raw thin space at the line end", got is not None and got[1] == "titkosproba",
          repr(got))
    print("T1 on the hook (the tester's six forms and CRLF)")
    td, store = make_store()
    bodies = ("Jelszó:" + chr(0xA0) + VAL, "<p>Jelszó:&nbsp;" + VAL + "</p>", "Jelszó:" + chr(0x2009) + VAL,
              "Jelszó:" + chr(0x202F) + VAL, "Jelszó" + chr(0xA0) + ": " + VAL, "Jelszó:&nbsp; " + VAL)
    for k, body in enumerate(bodies):
        r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", "Kedves Ugyfel!\n" + body + "\n", name=f"t1-{k}.txt"))
        check(f"hook: form {k + 1} is denied", r.returncode == 2 and log_lines(store)[-1].get("reason") == "jeloles-nelkul",
              r.stderr)
    r = gate(store, "mcp__mail__send_email", {"to": "ugyfel@example.invalid", "subject": "x",
                                               "body": "Kedves Ugyfel!\r\nJelszó:\r\n" + VAL + "\r\n"})
    check("hook: CRLF with the value on the next line is denied", r.returncode == 2, r.stderr)


def test_multi_recipient():
    print("T2: one letter carrying a credential to more than one recipient")
    td, store = make_store()
    base = bash_send(td, "ugyfel@example.invalid", LETTER)
    for label, extra in (("to+cc", "--cc masik@example.invalid"), ("to+bcc", "--bcc masik@example.invalid"),
                         ("two to", "--to masik@example.invalid")):
        cmd = {"command": base["command"].replace("send.py ", f"send.py {extra} ", 1)}
        r = gate(store, "Bash", cmd)
        check(f"{label}: denied", r.returncode == 2 and log_lines(store)[-1].get("reason") == "tobb-cimzett", r.stderr)
        check(f"{label}: the deny names the alias way out, every recipient and the approval category",
              "alias --fp" in r.stderr and "--to masik@example.invalid" in r.stderr
              and "--to ugyfel@example.invalid" in r.stderr and "credential_alias" in r.stderr, r.stderr)
        cli(store, "ack", "--anchor", anchor_for(cmd), "--by", "teszt", "--reason", "probalom jelolessel atvinni (proba)")
        r = gate(store, "Bash", cmd)
        check(f"{label}: an acknowledgement does not lift it", r.returncode == 2
              and log_lines(store)[-1].get("reason") == "tobb-cimzett", r.stderr)
    with cl_state(store) as st:
        voided = [a.get("voided") for a in st.data["acks"]]
    check("... and every acknowledgement given for such a letter is void", voided == ["tobb-cimzett"] * 3, repr(voided))
    for label, ti in (("MCP to+cc", {"to": "ugyfel@example.invalid", "cc": "masik@example.invalid"}),
                      ("MCP two addresses in one to", {"to": "ugyfel@example.invalid, Masik <masik@example.invalid>"}),
                      ("MCP a to list", {"to": ["ugyfel@example.invalid", "masik@example.invalid"]})):
        r = gate(store, "mcp__mail__send_email", dict(ti, subject="x", body=LETTER))
        check(f"{label}: denied", r.returncode == 2 and log_lines(store)[-1].get("reason") == "tobb-cimzett", r.stderr)
    r = gate(store, "Bash", {"command": base["command"].replace("send.py ", "send.py --cc UGYFEL@example.invalid ", 1)})
    check("the same address twice (case apart) is one recipient, not two",
          r.returncode == 2 and log_lines(store)[-1].get("reason") == "jeloles-nelkul", r.stderr)
    print("T2: the owner-approved alias, and the acknowledgement's pair")
    two = {"command": base["command"].replace("send.py ", "send.py --cc masik@example.invalid ", 1)}
    r = gate(store, "Bash", two)
    toks = r.stderr.split()
    full = toks[toks.index("--fp") + 1] if "--fp" in toks else ""
    fp8 = full[:8]
    check("the deny prints the FULL keyed fingerprint (the value never went out, the state does not know it)",
          len(full) == 64 and fp8 == log_lines(store)[-1]["hits"][0]["fp8"], full)
    a = cli(store, "alias", "--fp", full, "--to", "ugyfel@example.invalid", "--to", "masik@example.invalid")
    check("the alias command the deny prints works on the first denied letter", a.returncode == 0, a.stderr)
    check("an unknown 8-hex prefix is still refused, nothing guessed",
          cli(store, "alias", "--fp", "0123abcd", "--to", "a@example.invalid").returncode == 2)
    r = gate(store, "Bash", two)
    check("an alias without an approval changes nothing",
          r.returncode == 2 and "nincs jovahagyott alias" in r.stderr and log_lines(store)[-1].get("reason") == "tobb-cimzett",
          r.stderr)
    with cl_state(store) as st:
        alias = next(iter(st.data["aliases"].values()))
    approve(store, "credential_alias", alias["anchor"])
    r = gate(store, "Bash", two)
    check("with the approved alias the letter still needs its own acknowledgement",
          r.returncode == 2 and log_lines(store)[-1].get("reason") == "jeloles-nelkul", r.stderr)
    cli(store, "ack", "--anchor", anchor_of(r), "--by", "teszt", "--reason", "ugyanaz az ugyfel ket cime (alias, proba)")
    r = gate(store, "Bash", two)
    check("alias + acknowledgement: the letter goes out", r.returncode == 0, r.stderr)
    with cl_state(store) as st:
        used = [a for a in st.data["acks"] if a.get("consumed") and not a.get("voided")]
    check("the used acknowledgement records the pair it covered: the fingerprints and exactly these recipients",
          len(used) == 1 and used[0].get("recipients") == ["masik@example.invalid", "ugyfel@example.invalid"]
          and len(used[0].get("fps") or []) == 1 and used[0]["fps"][0].startswith(fp8), repr(used))
    three = {"command": two["command"].replace("send.py ", "send.py --bcc harmadik@example.invalid ", 1)}
    r = gate(store, "Bash", three)
    # the value already went to the two: the history check (it comes before the several-recipients check) refuses
    check("a third recipient is not covered by the alias", r.returncode == 2
          and log_lines(store)[-1].get("reason") == "kozos-elozmeny", r.stderr)
    r = gate(store, "Bash", bash_send(td, "masik@example.invalid", LETTER))
    check("an acknowledgement covers its own letter only: the same value to one of the two needs a new one",
          r.returncode == 2 and log_lines(store)[-1].get("reason") == "jeloles-nelkul", r.stderr)
    td, store = make_store()
    two = {"command": base["command"].replace("send.py ", "send.py --cc masik@example.invalid ", 1)}
    r = gate(store, "Bash", two)
    toks = r.stderr.split()
    full = toks[toks.index("--fp") + 1] if "--fp" in toks else ""
    cli(store, "alias", "--fp", full, "--to", "ugyfel@example.invalid", "--to", "masik@example.invalid")
    with cl_state(store) as st:
        alias = next(iter(st.data["aliases"].values()), {})
    approve(store, "credential_alias", alias.get("anchor", ""))
    other = {"command": base["command"].replace("send.py ", "send.py --cc harmadik@example.invalid ", 1)}
    r = gate(store, "Bash", other)
    check("an approved alias covers exactly its recipients: a different pair is refused for several recipients",
          r.returncode == 2 and log_lines(store)[-1].get("reason") == "tobb-cimzett", r.stderr)
    td, store = make_store()
    r = gate(store, "Bash", {"command": base["command"].replace("send.py ", "send.py --cc masik@example.invalid ", 1)},
             CREDENTIAL_GATE_MODE="warn")
    check("warn: goes out, logged with what block mode would have done",
          r.returncode == 0 and log_lines(store)[-1].get("would_deny") == "tobb-cimzett", r.stderr)


def test_no_value_anywhere():
    print("(5) the value is never written")
    leaks = []
    for out in outputs:
        leaks += [v for v in ALL_VALUES if v in out and v != "4821"]
    check("no value in any stdout or stderr of the gate and the CLI", not leaks, repr(sorted(set(leaks))))
    td, store = make_store()
    for body in (LETTER, "Jelszó: " + VAL2 + "\nPIN: 4821\n"):
        r = gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", body))
        cli(store, "ack", "--anchor", anchor_of(r), "--by", "teszt", "--reason", "sajat egyedi adat (proba)")
        gate(store, "Bash", bash_send(td, "ugyfel@example.invalid", body))
    cli(store, "shared-add", "--note", "proba", stdin=SHARED)
    files = {}
    for name in os.listdir(store):
        if name.startswith("credential-gate") and not name.endswith(".lock"):
            with open(os.path.join(store, name), encoding="utf-8") as fh:
                files[name] = fh.read()
    found = sorted({(n, v) for n, t in files.items() for v in ALL_VALUES if v in t})
    check("no value in the log, the state or any other gate file", not found, repr(found))
    check("the log shows length and an 8-hex fingerprint prefix",
          all(set(h) == {"keyword", "line", "length", "fp8"} and len(h["fp8"]) == 8
              for x in log_lines(store) for h in x.get("hits", [])))


if __name__ == "__main__":
    os.environ.pop("CREDENTIAL_GATE_STORE", None)
    os.environ["CREDENTIAL_GATE_CONFIG"] = os.path.join(tempfile.mkdtemp(), "none.json")
    CFG = cl.load_config()
    os.environ.pop("CREDENTIAL_GATE_CONFIG", None)
    test_acceptance()
    test_detector()
    test_cross_recipient_and_alias()
    test_scope_and_drafts()
    test_warn_mode()
    test_fail_closed()
    test_whitespace_class()
    test_multi_recipient()
    test_no_value_anywhere()
    print(f"\n{'ALL PASS' if not failed else f'{len(failed)} FAIL'}")
    sys.exit(1 if failed else 0)
