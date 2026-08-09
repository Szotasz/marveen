#!/usr/bin/env python3
"""Minimal, dependency-light Gree AC controller (card #289).

Speaks the Gree local UDP protocol (port 7000) directly, so it needs only the
`cryptography` package (present on peci01) -- no cloud, no broker, no HA. Runs
on peci01, which shares the 192.168.2.x subnet with the unit.

Usage:
  gree_ctl.py scan
  gree_ctl.py bind <ip>                 -> prints device key (store it)
  gree_ctl.py status <ip> <key>
  gree_ctl.py set <ip> <key> Pow=1 SetTem=24 Mod=1 WdSpd=0 ...
"""
import base64
import json
import socket
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

GENERIC_KEY = b"a3K8Bx%2r8Y7#xDh"
PORT = 7000
TIMEOUT = 5


def _ecb(key, data, decrypt=False):
    c = Cipher(algorithms.AES(key), modes.ECB(), backend=default_backend())
    op = c.decryptor() if decrypt else c.encryptor()
    return op.update(data) + op.finalize()


def _pad(b):
    n = 16 - (len(b) % 16)
    return b + bytes([n]) * n


def encrypt_pack(obj, key=GENERIC_KEY):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return base64.b64encode(_ecb(key, _pad(raw))).decode()


def decrypt_pack(b64, key=GENERIC_KEY):
    dec = _ecb(key, base64.b64decode(b64), decrypt=True)
    # Tolerant: keep up to the last closing brace; devices pad inconsistently.
    end = dec.rfind(b"}")
    return json.loads(dec[: end + 1].decode(errors="replace"))


def _send(ip, payload):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(TIMEOUT)
    s.sendto(json.dumps(payload, separators=(",", ":")).encode(), (ip, PORT))
    data, _ = s.recvfrom(4096)
    s.close()
    return json.loads(data.decode())


def scan(broadcast="192.168.2.255"):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(TIMEOUT)
    s.sendto(json.dumps({"t": "scan"}).encode(), (broadcast, PORT))
    out = []
    try:
        while True:
            data, addr = s.recvfrom(4096)
            resp = json.loads(data.decode())
            dev = decrypt_pack(resp["pack"])
            out.append({"ip": addr[0], "cid": resp.get("cid") or dev.get("cid"),
                        "name": dev.get("name"), "mac": dev.get("mac")})
    except socket.timeout:
        pass
    s.close()
    return out


def bind(ip, mac):
    payload = {"cid": "app", "i": 1, "t": "pack", "uid": 0, "tcid": mac,
               "pack": encrypt_pack({"mac": mac, "t": "bind", "uid": 0})}
    resp = _send(ip, payload)
    dev = decrypt_pack(resp["pack"])
    if dev.get("t") != "bindok":
        raise SystemExit(f"bind failed: {dev}")
    return dev["key"]


def _cid_of(ip):
    for d in scan():
        if d["ip"] == ip:
            return d["cid"] or d["mac"]
    raise SystemExit("device not found on scan")


def status(ip, key, mac):
    cols = ["Pow", "Mod", "SetTem", "WdSpd", "TemUn", "TemSen"]
    payload = {"cid": "app", "i": 0, "t": "pack", "uid": 0, "tcid": mac,
               "pack": encrypt_pack({"cols": cols, "mac": mac, "t": "status"}, key.encode())}
    resp = _send(ip, payload)
    dat = decrypt_pack(resp["pack"], key.encode())
    return dict(zip(dat["cols"], dat["dat"]))


def set_params(ip, key, mac, params):
    opts = list(params.keys())
    vals = [int(v) for v in params.values()]
    payload = {"cid": "app", "i": 0, "t": "pack", "uid": 0, "tcid": mac,
               "pack": encrypt_pack({"opt": opts, "p": vals, "t": "cmd", "mac": mac}, key.encode())}
    resp = _send(ip, payload)
    return decrypt_pack(resp["pack"], key.encode())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "scan"
    if cmd == "scan":
        print(json.dumps(scan(), ensure_ascii=False, indent=1))
    elif cmd == "bind":
        ip = sys.argv[2]
        print(bind(ip, _cid_of(ip)))
    elif cmd == "status":
        ip, key = sys.argv[2], sys.argv[3]
        print(json.dumps(status(ip, key, _cid_of(ip)), indent=1))
    elif cmd == "set":
        ip, key = sys.argv[2], sys.argv[3]
        params = dict(kv.split("=") for kv in sys.argv[4:])
        print(json.dumps(set_params(ip, key, _cid_of(ip), params), indent=1))
