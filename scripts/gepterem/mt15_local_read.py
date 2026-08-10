#!/usr/bin/env python3
"""Direct local reader for the MT15 machine-room sensor (card #312).

Runs on peci01, which shares the 192.168.2.x subnet with the sensor. Polls the
MT15 over the Tuya local protocol (v3.5, port 6668) and writes
room-temp-local.json in the same shape the HA push produces, so the
gree-thermostat can consume either file. This removes the cloud, HA and the
nucbox from the temperature path; the pushed file stays as fallback.

On ANY failure nothing is written: the thermostat then falls back to the
pushed file, and past STALE_SEC it goes fail-closed with an alert -- a broken
reader must surface as staleness, not as a frozen "fresh" value.

dps map (measured 2026-08-10): '2' = temperature, integer Celsius. The other
fields (humidity '3', co2 '4', pm25...) are not consumed yet.

Env (all optional):
  MT15_ID (default bfd056e15c2a12137bflwc)
  MT15_IP (default 192.168.2.140)
  MT15_KEY_FILE (default ~/.mt15-local-key, 0600)
  MT15_OUT (default /mnt/data/start-otthon/room-temp-local.json)
"""
import json
import os
import sys
import time

import tinytuya

DEV_ID = os.environ.get("MT15_ID", "bfd056e15c2a12137bflwc")
IP = os.environ.get("MT15_IP", "192.168.2.140")
KEY_FILE = os.environ.get("MT15_KEY_FILE", os.path.expanduser("~/.mt15-local-key"))
OUT = os.environ.get("MT15_OUT", "/mnt/data/start-otthon/room-temp-local.json")
TEMP_DPS = "2"


def main():
    try:
        key = open(KEY_FILE).read().strip()
    except OSError as e:
        print(f"[mt15-local] key file unreadable: {e}", file=sys.stderr)
        return 2
    d = tinytuya.Device(DEV_ID, IP, key, version=3.5)
    d.set_socketTimeout(5)
    st = d.status()
    dps = st.get("dps") if isinstance(st, dict) else None
    if not dps or TEMP_DPS not in dps:
        print(f"[mt15-local] no usable status: {str(st)[:120]}", file=sys.stderr)
        return 1
    try:
        temp = float(dps[TEMP_DPS])
    except (TypeError, ValueError):
        print(f"[mt15-local] non-numeric temp dps: {dps[TEMP_DPS]!r}", file=sys.stderr)
        return 1
    now = int(time.time())
    doc = {"fetched_unix": now, "source": "tuya-local",
           "rooms": [{"key": "mt15_kucko", "name": "MT15 kuckó", "c": round(temp, 1),
                      "updated_unix": now}]}
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, ensure_ascii=False)
    os.replace(tmp, OUT)
    print(f"[mt15-local] {temp}C -> {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
