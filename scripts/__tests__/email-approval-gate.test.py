#!/usr/bin/env python3
"""EMAILKAPU901 PR2: the email_send level becomes a real switch on the main agent.

Branches proven (Marveen msgs 17900/17936):
  - level 1: the send is DENIED outright.
  - level 2: denied without approval; ALLOWED against an approved, matching,
    in-window approval; the SAME send a SECOND time is denied again (one-shot
    consumption -- the feature's built-in mutation control); an expired window
    denies; a pending approval denies with its id.
  - level 3: allowed.
  - four-field anchor: an approval for the SAME subject+body but a DIFFERENT
    recipient does NOT authorize the send.
  - FAIL-CLOSED, proven separately from the happy path: missing approvals DB,
    missing/corrupt autonomy-config, unreadable letter ($VAR body), and a
    recipient that cannot be extracted all DENY (exit 2, never 1).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import tokenize

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "email-approval-gate.py")
WINDOW = 1800
# Same portability constraint as the gate: this file drives the gate through
# the HOST's python3, so its own fixtures must not need SQLite 3.38 either.
NOW_S = "CAST(strftime('%s','now') AS INTEGER)"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(td, level=2, max_level=None, config="ok"):
    store = os.path.join(td, "store")
    os.makedirs(store, exist_ok=True)
    cfg_path = os.path.join(store, "autonomy-config.json")
    if config == "ok":
        cat = {"key": "email_send", "label": "Email", "level": level, "locked": False}
        if max_level is not None:
            cat["maxLevel"] = max_level
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "categories": [cat]}, fh)
    elif config == "corrupt":
        with open(cfg_path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
    # config == "missing": write nothing
    db_path = os.path.join(store, "claudeclaw.db")
    con = sqlite3.connect(db_path)
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


def run_gate(store, payload):
    env = dict(os.environ,
               EMAIL_APPROVAL_GATE_STORE=store,
               EMAIL_APPROVAL_WINDOW_S=str(WINDOW),
               OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
    proc = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(),
                          capture_output=True, env=env)
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


def mcp_send(to="a@b.hu", cc=None, subject="Teszt tárgy", body="Kedves Ügyfelünk! Törzs."):
    ti = {"to": [to], "subject": subject, "body": body}
    if cc:
        ti["cc"] = [cc]
    return {"tool_name": "mcp__server-gmail-autoauth-mcp__send_email", "tool_input": ti}


def approve(store, anchor, resolved_ago=0, status="approved", consumed=None):
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute(
        "INSERT INTO approvals (id, agent_id, category, action_description, status,"
        " requested_at, resolved_at, resolved_by, content_hash, consumed_at)"
        " VALUES (hex(randomblob(6)), 'marveen', 'email_send', 'Email teszt', ?,"
        f" {NOW_S}-?-60, CASE WHEN ?='pending' THEN NULL ELSE {NOW_S}-? END,"
        " 'szabi', ?, ?)",
        (status, resolved_ago, status, resolved_ago, anchor, consumed))
    con.commit()
    con.close()


def anchor_from_stderr(err):
    m = re.search(r"\b([0-9a-f]{64})\b", err)
    return m.group(1) if m else None


with tempfile.TemporaryDirectory() as td:
    # --- scope: what the gate must NOT touch --------------------------------
    store = make_store(os.path.join(td, "s0"), level=1)
    code, _, _ = run_gate(store, {"tool_name": "Bash", "tool_input": {"command": "ls -la"}})
    check("non-send Bash passes untouched even at level 1", code == 0, f"exit={code}")
    code, _, _ = run_gate(store, {"tool_name": "Read", "tool_input": {"file_path": "/x"}})
    check("non-email tool passes untouched", code == 0, f"exit={code}")

    # --- level 1: hard deny --------------------------------------------------
    code, _, err = run_gate(store, mcp_send())
    check("level 1: MCP send DENIED", code == 2 and "szint 1" in err, f"exit={code}")
    code, _, err = run_gate(store, {"tool_name": "mcp__x__manage_email",
                                    "tool_input": {"action": "send", "to": ["a@b.hu"], "body": "x"}})
    check("level 1: manage_email DENIED too (2026-08-10 bypass class)", code == 2, f"exit={code}")

    # --- level 3: allow ------------------------------------------------------
    store = make_store(os.path.join(td, "s3"), level=3)
    code, _, _ = run_gate(store, mcp_send())
    check("level 3: MCP send allowed", code == 0, f"exit={code}")

    # --- level 2: the approval loop -----------------------------------------
    store = make_store(os.path.join(td, "s2"), level=2)
    payload = mcp_send()
    code, _, err = run_gate(store, payload)
    anchor = anchor_from_stderr(err)
    check("level 2 without approval: DENIED and the deny carries the sha256 anchor",
          code == 2 and "NINCS jovahagyas" in err and anchor is not None, f"exit={code} err={err[:150]!r}")
    check("deny message is actionable (POST /api/approvals + resend instructions)",
          "api/approvals" in err and "content_hash" in err and "a@b.hu" in err)

    approve(store, anchor)
    code, out, _ = run_gate(store, payload)
    check("level 2 with approved+matching+in-window approval: ALLOWED",
          code == 0 and "felhasznalva" in out, f"exit={code} out={out[:120]!r}")

    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    consumed = con.execute("SELECT consumed_at FROM approvals WHERE content_hash=?", (anchor,)).fetchone()[0]
    con.close()
    check("the allow CONSUMED the approval (consumed_at set in the DB)", consumed is not None)

    code, _, err = run_gate(store, payload)
    check("the SAME send a SECOND time: DENIED (one-shot)",
          code == 2 and "FEL LETT HASZNALVA" in err, f"exit={code}")

    # window expiry: a different letter, approved too long ago
    payload_b = mcp_send(subject="Masik tárgy")
    _, _, err = run_gate(store, payload_b)
    anchor_b = anchor_from_stderr(err)
    approve(store, anchor_b, resolved_ago=WINDOW + 60)
    code, _, err = run_gate(store, payload_b)
    check("approval outside the time window: DENIED as expired",
          code == 2 and "IDOABLAKA lejart" in err, f"exit={code} err={err[:150]!r}")

    # pending approval names itself
    payload_c = mcp_send(subject="Harmadik tárgy")
    _, _, err = run_gate(store, payload_c)
    anchor_c = anchor_from_stderr(err)
    approve(store, anchor_c, status="pending")
    code, _, err = run_gate(store, payload_c)
    check("pending approval: DENIED with 'meg fuggoben'",
          code == 2 and "FUGGOBEN" in err, f"exit={code}")

    # --- the four-field anchor: recipient is part of the identity ------------
    payload_d = mcp_send(subject="Negyedik tárgy", body="Ugyanaz a törzs.")
    _, _, err = run_gate(store, payload_d)
    approve(store, anchor_from_stderr(err))
    hijacked = mcp_send(to="evil@x.hu", subject="Negyedik tárgy", body="Ugyanaz a törzs.")
    code, _, err = run_gate(store, hijacked)
    check("approved subject+body to a DIFFERENT recipient: DENIED (anchor covers to)",
          code == 2 and "NINCS jovahagyas" in err, f"exit={code}")
    cc_flip = mcp_send(cc="cc@x.hu", subject="Negyedik tárgy", body="Ugyanaz a törzs.")
    code, _, _ = run_gate(store, cc_flip)
    check("same letter with an ADDED cc: DENIED (anchor covers cc)", code == 2)

    # --- maxLevel clamps -----------------------------------------------------
    store = make_store(os.path.join(td, "sclamp"), level=3, max_level=2)
    code, _, err = run_gate(store, mcp_send())
    check("level 3 clamped by maxLevel 2: behaves as level 2 (deny w/o approval)",
          code == 2 and "level 2" in err, f"exit={code}")

    # --- Bash path end-to-end at level 2 ------------------------------------
    store = make_store(os.path.join(td, "sbash"), level=2)
    bash_payload = {"tool_name": "Bash", "tool_input": {
        "command": 'sendmail --to a@b.hu --subject "Bash tárgy" --body "Bash törzs."'}}
    code, _, err = run_gate(store, bash_payload)
    b_anchor = anchor_from_stderr(err)
    check("level 2 Bash send without approval: DENIED with anchor",
          code == 2 and b_anchor is not None, f"exit={code} err={err[:150]!r}")
    approve(store, b_anchor)
    code, _, _ = run_gate(store, bash_payload)
    check("level 2 Bash send with approval: ALLOWED", code == 0, f"exit={code}")

    # --- FAIL-CLOSED, each branch separately --------------------------------
    store = make_store(os.path.join(td, "sf1"), level=2)
    os.remove(os.path.join(store, "claudeclaw.db"))
    code, _, err = run_gate(store, mcp_send())
    check("fail-closed: approvals DB missing -> DENIED (undecidable != allowed)",
          code == 2 and "nem-eldontheto" in err, f"exit={code}")

    store = make_store(os.path.join(td, "sf2"), config="missing")
    code, _, err = run_gate(store, mcp_send())
    check("fail-closed: autonomy-config missing -> level 2 path, DENIED w/o approval",
          code == 2 and "fail-closed" in err, f"exit={code}")

    store = make_store(os.path.join(td, "sf3"), config="corrupt")
    code, _, err = run_gate(store, mcp_send())
    check("fail-closed: autonomy-config corrupt -> level 2 path, DENIED",
          code == 2, f"exit={code}")

    store = make_store(os.path.join(td, "sf4"), level=2)
    code, _, err = run_gate(store, {"tool_name": "Bash", "tool_input": {
        "command": 'sendmail --to a@b.hu --body "$LETTER"'}})
    check("fail-closed: $VAR body at level 2 -> DENIED as unanchorable",
          code == 2 and "horgonyozhato" in err, f"exit={code}")

    code, _, err = run_gate(store, {"tool_name": "mcp__x__send_email",
                                    "tool_input": {"subject": "t", "body": "b"}})
    check("fail-closed: no extractable recipient -> DENIED",
          code == 2 and "cimzett" in err, f"exit={code}")

    code, _, err = run_gate(store, {"tool_name": "mcp__x__send_email", "tool_input": "not-a-dict"})
    check("fail-closed: non-dict tool_input -> DENIED (exit 2, never 1)",
          code == 2, f"exit={code}")

    # Marveen's #1149 review: this gate AUTHORIZES, so unlike the copy gate it
    # must fail closed on an unparseable payload too -- the docstring and the
    # code now state the same contract.
    env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=store,
               OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
    proc = subprocess.run([sys.executable, GATE], input=b"this is not json",
                          capture_output=True, env=env)
    check("fail-closed: unparseable stdin -> DENIED (exit 2, never 0/1)",
          proc.returncode == 2, f"exit={proc.returncode}")

    # --- EMAILBCCHORGONY903: bcc is part of the anchor -----------------------
    # The gap this pins closed: with a to+cc+text anchor, an approved letter
    # could be re-sent with an ADDED bcc -- identical hash, the approval was
    # consumed, and a recipient nobody approved got the letter. Both send
    # paths are covered, plus the backward-compat golden below.
    store = make_store(os.path.join(td, "bcc-mcp"))
    _, _, err = run_gate(store, mcp_send())          # harvest the letter's anchor
    bccless_anchor = anchor_from_stderr(err)
    approve(store, bccless_anchor)
    bcc_payload = mcp_send()
    bcc_payload["tool_input"]["bcc"] = ["rejtett@idegen.example"]
    code, _, _ = run_gate(store, bcc_payload)
    check("bcc/MCP: approved bcc-less letter re-sent WITH bcc -> DENIED",
          code == 2, f"exit={code}")
    code, _, _ = run_gate(store, mcp_send())
    check("bcc/MCP: the bcc-less letter itself still sends on that approval",
          code == 0, f"exit={code}")

    store = make_store(os.path.join(td, "bcc-bash"))
    bash_cmd = ('python3 scripts/send.py --to "a@b.hu" --subject "Teszt tárgy" '
                '--body "Kedves Ügyfelünk! Törzs."')
    _, _, err = run_gate(store, {"tool_name": "Bash", "tool_input": {"command": bash_cmd}})
    approve(store, anchor_from_stderr(err))
    code, _, _ = run_gate(store, {"tool_name": "Bash",
                                  "tool_input": {"command": bash_cmd + ' --bcc "rejtett@idegen.example"'}})
    check("bcc/Bash: approved bcc-less command re-sent WITH --bcc -> DENIED",
          code == 2, f"exit={code}")
    code, _, _ = run_gate(store, {"tool_name": "Bash", "tool_input": {"command": bash_cmd}})
    check("bcc/Bash: the bcc-less command itself still sends on that approval",
          code == 0, f"exit={code}")

    # Backward-compat golden: the bcc-less canon is BYTE-STABLE across the bcc
    # fix (bcc joins the hash ONLY when non-empty), so approvals recorded
    # before the change stay valid for the letters they approved. If this hash
    # ever changes, EVERY open approval silently invalidates -- that must be a
    # loud, deliberate decision failing here, never a side effect.
    check("bcc/golden: bcc-less anchor is byte-stable across the bcc fix",
          bccless_anchor == "de87bdb699dcab419b68811bb57b6fab44b34e2fe16bff11cf90b2a5848f82ec",
          f"got {bccless_anchor}")

    # SQLite-version portability, kept as a STATIC check on purpose. The
    # behavioural cases above only catch the bad call on a host whose sqlite is
    # older than 3.38 -- on CI (newer) they stay green while the live install
    # denies every approved letter. So assert the function is absent from the
    # source, which fails on every host once it is reintroduced. Measured
    # 2026-09-02: host python sqlite3 3.37.2, gate raised OperationalError,
    # and the fail-closed deny read as "no approval" rather than a version
    # fault. The 'unixepoch' MODIFIER (date(x,'unixepoch')) is ancient and
    # fine -- only the bare function call is banned.
    #
    # COMMENTS ARE STRIPPED before matching, and the pattern is assembled from
    # fragments: otherwise this file's own prose (and the pattern itself) would
    # register as a violation and the check would fail for a reason that has
    # nothing to do with any SQL. Strings are KEPT -- that is where the SQL is.
    banned = re.compile(r"(?<!')\b" + "unix" + r"epoch\s*\(")

    def code_without_comments(path):
        with open(path, "rb") as fh:
            return "".join(t.string for t in tokenize.tokenize(fh.readline)
                           if t.type != tokenize.COMMENT)

    hook_srcs = [os.path.join(HOOKS, f) for f in sorted(os.listdir(HOOKS)) if f.endswith(".py")]
    offenders = [os.path.basename(p) for p in hook_srcs + [os.path.abspath(__file__)]
                 if banned.search(code_without_comments(p))]
    check("portability: no bare SQLite unixepoch function call (needs 3.38+) in the hooks",
          not offenders, f"offenders={offenders}")
    # Control: the check can actually fail. Without this, a broken matcher
    # would report a clean tree forever and read exactly like a passing gate.
    check("control: the same matcher DOES flag the old expression",
          bool(banned.search("SELECT unix" + "epoch()-60")))
    check("control: the host's own sqlite3 really executes the replacement expression",
          sqlite3.connect(":memory:").execute(f"SELECT {NOW_S}").fetchone()[0] > 1_700_000_000)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate tests passed.")
