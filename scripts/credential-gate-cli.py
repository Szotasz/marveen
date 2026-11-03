#!/usr/bin/env python3
"""Operator CLI of the credential gate (CREDGATE1003).

  ack --anchor <sha256> --by <who> --reason <text>
      One-shot acknowledgement for ONE letter (the anchor the gate printed):
      "this credential is the recipient's own, unique one". It never lifts the
      shared list or the cross-recipient check.
  shared-add --note <text>
      Put a value on the shared list. The value is read from stdin (no echo on
      a terminal), never from the command line; only its fingerprint is kept.
  shared-remove --fp <prefix>
  alias --fp <prefix> --to <addr> [--to <addr> ...] [--request --by <who>]
      Record an alias candidate: the value with this fingerprint may go to
      exactly this recipient set (one customer, several addresses). It is live
      only after an owner-approved approval of category credential_alias on
      the printed hash; --request files that approval on the dashboard.
  status
      Counts only; no value and no fingerprint is printed.

Store: CREDENTIAL_GATE_STORE (default <repo>/store), same as the gate.
"""
import argparse
import getpass
import json
import os
import secrets
import sys
import urllib.request

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "scripts", "hooks"))
import credential_lib as cl  # noqa: E402

ALIAS_CATEGORY = "credential_alias"


def fail(msg: str, code: int = 2):
    sys.stderr.write(f"credential-gate-cli: {msg}\n")
    sys.exit(code)


def cmd_ack(a):
    anchor = a.anchor.strip().lower()
    if len(anchor) != 64 or any(c not in "0123456789abcdef" for c in anchor):
        fail("az --anchor 64 hex jegy kell legyen (a kapu tilto uzenete irja ki)")
    if len(a.reason.strip()) < 10:
        fail("az --reason legalabb 10 karakter: miert a cimzett sajat, egyedi adata, es honnan tudod")
    if not a.by.strip():
        fail("a --by nem lehet ures")
    with cl.State() as st:
        ack = {"id": "ack-" + secrets.token_hex(4), "anchor": anchor, "by": a.by.strip(),
               "reason": a.reason.strip(), "created": cl.now_stamp(), "consumed": None}
        st.data["acks"].append(ack)
    cl.append_log({"event": "ack", "id": ack["id"], "by": ack["by"], "reason": ack["reason"],
                   "anchor16": anchor[:16]})
    print(f"jeloles rogzitve: {ack['id']} (egyszer hasznalhato, csak erre a levelre)")


def read_secret() -> str:
    if sys.stdin.isatty():
        return getpass.getpass("az ertek (nem jelenik meg): ")
    return sys.stdin.read()


def cmd_shared_add(a):
    value = cl.normalize_value(read_secret())
    if not value:
        fail("ures ertek")
    fp = cl.make_fingerprint(cl.load_key())(value)
    with cl.State() as st:
        st.data["shared"].setdefault(fp, {"note": a.note.strip(), "added": cl.now_stamp()})
    cl.append_log({"event": "shared-add", "fp8": fp[:8], "length": len(value), "note": a.note.strip()})
    print(f"a kozos listan: ujjlenyomat {fp[:8]}, {len(value)} karakter")


def cmd_shared_remove(a):
    with cl.State() as st:
        fp = cl.resolve_fp({"seen": {}, "aliases": {}, "acks": [], "shared": st.data["shared"]}, a.fp)
        del st.data["shared"][fp]
    cl.append_log({"event": "shared-remove", "fp8": fp[:8]})
    print(f"levettem a kozos listarol: {fp[:8]}")


def post_approval(by: str, description: str, content_hash: str):
    token_path = os.path.join(cl.store_dir(), ".dashboard-token")
    try:
        with open(token_path, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        fail(f"a dashboard-token nem olvashato ({exc}); a jovahagyast kerd kezzel")
    port = os.environ.get("WEB_PORT") or "3420"
    body = json.dumps({"agent_id": by, "category": ALIAS_CATEGORY, "action_description": description,
                       "content_hash": content_hash}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/approvals", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            row = json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as exc:  # noqa: BLE001 -- reported, the alias stays a candidate
        fail(f"a jovahagyas-keres nem ment at ({exc}); a jelolt rogzitve, a jovahagyast kerd kezzel")
    return row.get("id")


def cmd_alias(a):
    recipients = cl.recipients_of({"to": a.to})
    if not recipients:
        fail("legalabb egy --to cim kell")
    with cl.State() as st:
        fp = cl.resolve_fp(st.data, a.fp)
        anchor = cl.alias_anchor(fp, recipients)
        st.data["aliases"][fp] = {"recipients": recipients, "anchor": anchor, "added": cl.now_stamp()}
    description = (f"Jelszo-kapu alias: a(z) {fp[:8]} ujjlenyomatu ertek ezekhez a cimekhez mehet "
                   f"(ugyanaz az ugyfel): {', '.join(recipients)}")
    cl.append_log({"event": "alias", "fp8": fp[:8], "recipients": recipients, "anchor16": anchor[:16]})
    print(f"alias-jelolt rogzitve: {fp[:8]} -> {', '.join(recipients)}")
    print(f"elesites: jovahagyas, kategoria {ALIAS_CATEGORY}, content_hash {anchor}")
    if a.request:
        if not a.by:
            fail("a --request melle --by kell")
        print(f"jovahagyas-keres: {post_approval(a.by, description, anchor)}")


def cmd_status(_a):
    with cl.State(write=False) as st:
        d = st.data
        open_acks = sum(1 for x in d["acks"] if not x.get("consumed"))
        print(json.dumps({"shared": len(d["shared"]), "acks_open": open_acks, "acks_used": len(d["acks"]) - open_acks,
                          "seen": len(d["seen"]), "aliases": len(d["aliases"])}))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="credential-gate-cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ack")
    p.add_argument("--anchor", required=True)
    p.add_argument("--by", required=True)
    p.add_argument("--reason", required=True)
    p.set_defaults(fn=cmd_ack)
    p = sub.add_parser("shared-add")
    p.add_argument("--note", required=True)
    p.set_defaults(fn=cmd_shared_add)
    p = sub.add_parser("shared-remove")
    p.add_argument("--fp", required=True)
    p.set_defaults(fn=cmd_shared_remove)
    p = sub.add_parser("alias")
    p.add_argument("--fp", required=True)
    p.add_argument("--to", action="append", required=True)
    p.add_argument("--request", action="store_true")
    p.add_argument("--by")
    p.set_defaults(fn=cmd_alias)
    p = sub.add_parser("status")
    p.set_defaults(fn=cmd_status)
    a = ap.parse_args(argv)
    try:
        a.fn(a)
    except cl.GateConfigError as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
