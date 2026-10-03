#!/usr/bin/env python3
"""db121902: scripts/sms/seeme-send.py consumes its external_message approval BEFORE the SeeMe call.

Before this card the sender only READ the approval, so one approved row let any number of SMS out.
Hermetic: a stub dashboard (GET /api/approvals/<id> and a one-shot POST .../consume like the real
endpoint) and a stub SeeMe gateway on 127.0.0.1. The script reaches them, a lab credentials file, a lab
send log and lab number/token files through its SEEME_* overrides; the live store/ and the running
dashboard are never touched.

Proven:
  - a dry run consumes nothing and sends nothing;
  - the first send consumes once and sends once, the consume comes BEFORE the gateway call, and it
    names category external_message, consumer seeme-send and the very reference the gateway got;
  - a SECOND send with the same approval is refused (409 already_consumed): no second gateway call,
    and the send log records the refusal;
  - an expired approval (409), a dashboard error (500) and an approval gone at consume time (404)
    send nothing;
  - missing credentials stop the send BEFORE the approval is consumed (it stays usable);
  - an internal number is sent without any consume (unchanged);
  - a missing consume helper stops the send (fail closed);
  - mutation control: a copy of the script without the consume call sends TWICE with one approval,
    so the checks above can fail.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO, "scripts", "sms", "seeme-send.py")
HELPER = os.path.join(REPO, "scripts", "approval-consume.py")
TO = "36301234567"           # external: not in the lab internal list
INTERNAL = "36305552860"     # internal in the lab list
TOKEN = "lab-token-not-a-secret"

failed = []
events = []                  # ordered: ("get", id) / ("consume", id, body) / ("seeme", number, reference)
consumed = {}                # approval id -> body of the first successful consume


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failed.append(name)


def count(kind, key=None):
    return sum(1 for e in events if e[0] == kind and (key is None or e[1] == key))


class Dash(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self._send(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self):
        if not self._authorized():
            return
        aid = self.path.rstrip("/").split("/")[-1]
        events.append(("get", aid))
        self._send(200, {"id": aid, "status": "approved", "category": "external_message",
                         "action_description": "SMS-t kuldenek a %s szamra (SeeMe). Labor." % TO,
                         "requested_at": 1, "resolved_at": 2})

    def do_POST(self):
        if not self._authorized():
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = json.loads(raw.decode("utf-8") or "{}")
        parts = self.path.strip("/").split("/")  # api approvals <id> consume
        aid = parts[2]
        events.append(("consume", aid, body))
        if aid == "appr-expired":
            return self._send(409, {"ok": False, "reason": "expired"})
        if aid == "appr-boom":
            return self._send(500, {"error": "internal"})
        if aid == "appr-gone":
            return self._send(404, {"ok": False, "reason": "not_found"})
        if body.get("category") != "external_message":
            return self._send(409, {"ok": False, "reason": "wrong_category"})
        if aid in consumed:
            return self._send(409, {"ok": False, "reason": "already_consumed",
                                    "approval": {"id": aid, "consumed_by": consumed[aid].get("consumer")}})
        consumed[aid] = body
        return self._send(200, {"ok": True, "approval": {"id": aid, "consumed_at": 3, "consumed_by": body.get("consumer"),
                                                         "consumed_ref": body.get("ref")}})


class SeeMe(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        events.append(("seeme", q.get("number", [""])[0], q.get("reference", [""])[0]))
        data = json.dumps({"code": "0", "result": "OK", "split": 1, "price": "0"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


dash, seeme = HTTPServer(("127.0.0.1", 0), Dash), HTTPServer(("127.0.0.1", 0), SeeMe)
for srv in (dash, seeme):
    threading.Thread(target=srv.serve_forever, daemon=True).start()

lab = tempfile.mkdtemp(prefix="seeme-consume-test-")
CREDS = os.path.join(lab, "seeme-gateway.env")
with open(CREDS, "w", encoding="utf-8") as fh:
    fh.write("SEEME_API_KEY=lab-key-not-real\nSEEME_SENDER=36300000000\n")
    fh.write("SEEME_BASE=http://127.0.0.1:%d/gateway\n" % seeme.server_address[1])
with open(os.path.join(lab, "internal.json"), "w", encoding="utf-8") as fh:
    json.dump({"internal": [INTERNAL]}, fh)
with open(os.path.join(lab, "token"), "w", encoding="utf-8") as fh:
    fh.write(TOKEN + "\n")
SEND_LOG = os.path.join(lab, "seeme-send.log")
ENV = dict(os.environ,
           SEEME_DASH_BASE="http://127.0.0.1:%d" % dash.server_address[1],
           SEEME_ENV_FILE=CREDS,
           SEEME_LOG_FILE=SEND_LOG,
           SEEME_INTERNAL_FILE=os.path.join(lab, "internal.json"),
           SEEME_DASH_TOKEN_FILE=os.path.join(lab, "token"))


def run(to, approval=None, *extra, script=SCRIPT, env=None):
    args = [sys.executable, script, "--to", to]
    if approval:
        args += ["--approval", approval]
    p = subprocess.run(args + list(extra), input="Labor teszt uzenet", capture_output=True, text=True,
                       env=env or ENV, timeout=60)
    return p.returncode, p.stdout + p.stderr


def log_lines():
    if not os.path.exists(SEND_LOG):
        return []
    with open(SEND_LOG, encoding="utf-8") as fh:
        return fh.read().splitlines()


try:
    # --- dry run: the gate runs, nothing is consumed or sent -------------------------------------
    rc, out = run(TO, "appr-1", "--dry-run")
    check("dry run exits 0", rc == 0)
    check("dry run consumes nothing and calls no gateway", count("consume") == 0 and count("seeme") == 0)

    # --- first send: one consume, then one gateway call -------------------------------------------
    rc, out = run(TO, "appr-1", "--reference", "lab-ref-1")
    check("first send exits 0", rc == 0)
    check("first send consumed once and sent once", count("consume", "appr-1") == 1 and count("seeme") == 1)
    # next() with a default: a missing event is a FAIL below, not a crash that hides the later checks.
    i_consume = next((i for i, e in enumerate(events) if e[0] == "consume"), None)
    i_seeme = next((i for i, e in enumerate(events) if e[0] == "seeme"), None)
    check("the consume came BEFORE the gateway call", None not in (i_consume, i_seeme) and i_consume < i_seeme)
    check("the consume names category, consumer and the reference", i_consume is not None and
          events[i_consume][2] == {"category": "external_message", "consumer": "seeme-send", "ref": "lab-ref-1"})
    check("the gateway got the same reference and number", i_seeme is not None and events[i_seeme][1:] == (TO, "lab-ref-1"))

    # --- the double send: same approval again -----------------------------------------------------
    rc, out = run(TO, "appr-1", "--reference", "lab-ref-2")
    check("SECOND send with the same approval fails (rc != 0)", rc != 0)
    check("the refusal names already_consumed", "already_consumed" in out)
    check("no second gateway call", count("seeme") == 1)
    check("the send log records the refused attempt",
          any("NEM-KULDVE" in ln and "already_consumed" in ln and "lab-ref-2" in ln for ln in log_lines()))

    # --- every other refusal sends nothing --------------------------------------------------------
    outs = {}
    for aid, what in (("appr-expired", "an expired approval (409)"), ("appr-boom", "a dashboard error (500)"),
                      ("appr-gone", "an approval gone at consume time (404)")):
        before = count("seeme")
        rc, outs[aid] = run(TO, aid)
        check("%s: tried to consume, rc != 0, no gateway call" % what,
              rc != 0 and count("consume", aid) == 1 and count("seeme") == before)
    check("the expired refusal tells why", "expired" in outs["appr-expired"])

    # --- missing credentials stop the send before the approval is used ------------------------------
    no_creds = dict(ENV, SEEME_ENV_FILE=os.path.join(lab, "no-such-file.env"))
    before = count("seeme")
    rc, out = run(TO, "appr-2", env=no_creds)
    check("missing credentials: rc != 0, nothing consumed, nothing sent",
          rc != 0 and count("consume", "appr-2") == 0 and count("seeme") == before)
    rc, out = run(TO, "appr-2")
    check("the same approval still works once the credentials are there", rc == 0 and count("consume", "appr-2") == 1)

    # --- the default reference travels the same way ------------------------------------------------
    rc, out = run(TO, "appr-5")
    c5 = [e for e in events if e[0] == "consume" and e[1] == "appr-5"]
    ref = (c5[0][2].get("ref") or "") if c5 else ""
    check("the default fleet-adhoc reference is consumed and sent as one value",
          rc == 0 and ref.startswith("fleet-adhoc-") and events[-1] == ("seeme", TO, ref))

    # --- internal number: unchanged, no approval, no consume ---------------------------------------
    consumes_before, seeme_before = count("consume"), count("seeme")
    rc, out = run(INTERNAL)
    check("an internal number is sent without a consume",
          rc == 0 and count("consume") == consumes_before and count("seeme") == seeme_before + 1)

    # --- a missing consume helper fails closed ------------------------------------------------------
    bare = tempfile.mkdtemp(prefix="seeme-consume-bare-", dir=lab)
    os.makedirs(os.path.join(bare, "scripts", "sms"))
    shutil.copy(SCRIPT, os.path.join(bare, "scripts", "sms", "seeme-send.py"))
    before = count("seeme")
    rc, out = run(TO, "appr-3", script=os.path.join(bare, "scripts", "sms", "seeme-send.py"))
    check("without the consume helper: rc != 0, nothing consumed, nothing sent",
          rc != 0 and count("consume", "appr-3") == 0 and count("seeme") == before)

    # --- mutation control: without the consume call one approval sends twice -------------------------
    mut = tempfile.mkdtemp(prefix="seeme-consume-mut-", dir=lab)
    os.makedirs(os.path.join(mut, "scripts", "sms"))
    shutil.copy(HELPER, os.path.join(mut, "scripts", "approval-consume.py"))
    with open(SCRIPT, encoding="utf-8") as fh:
        src = fh.read()
    call = "        consume_approval(args.approval, to, reference)\n"
    check("mutation: the consume call is found exactly once", src.count(call) == 1)
    with open(os.path.join(mut, "scripts", "sms", "seeme-send.py"), "w", encoding="utf-8") as fh:
        fh.write(src.replace(call, "        pass  # MUTATION: no consume\n"))
    before = count("seeme")
    r1, _ = run(TO, "appr-4", script=os.path.join(mut, "scripts", "sms", "seeme-send.py"))
    r2, _ = run(TO, "appr-4", script=os.path.join(mut, "scripts", "sms", "seeme-send.py"))
    check("control: the mutant sends TWICE with one approval (so the double-send check can fail)",
          (r1, r2) == (0, 0) and count("seeme") == before + 2 and count("consume", "appr-4") == 0)
finally:
    dash.shutdown()
    seeme.shutdown()
    shutil.rmtree(lab, ignore_errors=True)

print()
if failed:
    print("%d FAILED: %s" % (len(failed), failed), file=sys.stderr)
    sys.exit(1)
print("All seeme-send consume tests passed.")
