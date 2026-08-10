#!/usr/bin/env python3
"""Machine-room thermostat loop (card #289). Runs on peci01.

Reads the machine-room temperature from the pushed sensor file and drives the
Gree AC over the local protocol, with hysteresis. Fail-CLOSED on a missing or
stale reading: it does NOT command the AC and emits an alert instead, because
acting on an unknown temperature is worse than not acting -- a spurious cool is
wasted power, a spurious off in a hot room is a risk, and either way a broken
sensor should surface, not be papered over.

Thresholds come from a CONFIG FILE (thermostat-config.json) so they are
adjustable without editing this script or the unit. The file carries named
profiles (e.g. "unattended" for machines-only, "occupied" for when Viktor is in
the room and wants a comfort range) and an active-profile pointer. After each
run the loop writes climate-status.json into the webroot, so the start.otthon
page can show the AC state and the active range next to the measured value --
same-origin, no extra Gree query from the status generator.

Manual changes are respected (card #310): the loop remembers the last power
state IT commanded (thermostat-state.json). If the unit's state differs, a
human intervened, and the auto-OFF rule is suspended for MANUAL_OVERRIDE_SEC.
Twice in 12 hours the old loop switched the AC off minutes after Viktor
powered it on by hand, because the sensor sits in the cold outflow and dips
under the off threshold. The auto-ON rule is NOT suspended: a hot room risks
the machines, so high-temp protection wins over a manual OFF.

Config via env (all optional; the config file wins for thresholds):
  GREE_IP (default 192.168.2.174)
  GREE_KEY (required)
  ROOM_TEMP_FILE (default /mnt/data/start-otthon/room-temp.json)
  ROOM_SENSOR_KEY (default mt15_kucko)
  THERMOSTAT_CONFIG (default /mnt/data/start-otthon/thermostat-config.json)
  CLIMATE_STATUS (default /mnt/data/start-otthon/climate-status.json)
  THERMOSTAT_STATE (default /mnt/data/start-otthon/thermostat-state.json)
  STALE_SEC (default 600) / GREE_SET_TEMP (default 24)
  MANUAL_OVERRIDE_SEC (default 7200)
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

IP = os.environ.get("GREE_IP", "192.168.2.174")
KEY = os.environ.get("GREE_KEY", "")
TEMP_FILE = os.environ.get("ROOM_TEMP_FILE", "/mnt/data/start-otthon/room-temp.json")
SENSOR_KEY = os.environ.get("ROOM_SENSOR_KEY", "mt15_kucko")
CONFIG_FILE = os.environ.get("THERMOSTAT_CONFIG", "/mnt/data/start-otthon/thermostat-config.json")
STATUS_FILE = os.environ.get("CLIMATE_STATUS", "/mnt/data/start-otthon/climate-status.json")
STATE_FILE = os.environ.get("THERMOSTAT_STATE", "/mnt/data/start-otthon/thermostat-state.json")
STALE_SEC = int(os.environ.get("STALE_SEC", "600"))
SET_TEMP = int(os.environ.get("GREE_SET_TEMP", "24"))
OVERRIDE_SEC = int(os.environ.get("MANUAL_OVERRIDE_SEC", "7200"))

# Fallback if the config file is missing/broken -- the machines-only range.
DEFAULT_ON, DEFAULT_OFF = 32.0, 27.0


def alert(msg):
    print(f"[gree-thermostat] ALERT: {msg}", file=sys.stderr, flush=True)


def load_thresholds():
    """(temp_on, temp_off, profile_name). Config file wins; safe fallback."""
    try:
        c = json.load(open(CONFIG_FILE))
        name = c.get("active", "unattended")
        prof = c["profiles"][name]
        on, off = float(prof["on"]), float(prof["off"])
        if off >= on:  # a nonsense range would thrash; refuse it
            alert(f"profile {name!r} has off>=on ({off}>={on}); using defaults")
            return DEFAULT_ON, DEFAULT_OFF, "default(bad-config)"
        return on, off, name
    except FileNotFoundError:
        return DEFAULT_ON, DEFAULT_OFF, "default(no-config)"
    except Exception as e:
        alert(f"config unreadable ({e}); using defaults")
        return DEFAULT_ON, DEFAULT_OFF, "default(bad-config)"


def read_temp():
    try:
        d = json.load(open(TEMP_FILE))
    except Exception as e:
        return None, f"temp file unreadable: {e}"
    for r in d.get("rooms", []) if isinstance(d, dict) else []:
        if SENSOR_KEY in (r.get("key", ""), r.get("name", "")):
            age = time.time() - d.get("fetched_unix", 0)
            if age > STALE_SEC:
                return None, f"reading {int(age)}s stale"
            return float(r["c"]), None
    return None, f"sensor {SENSOR_KEY!r} not in temp file"


def load_state():
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        alert(f"could not write state: {e}")


def decide(temp, on, off, powered, state, now, override_sec=None):
    """Pure decision step: (cmd, note, new_state); cmd is 'on', 'off' or None.

    state carries last_cmd_pow (last power state THIS loop commanded, or
    adopted as baseline) and override_until. A mismatch between the unit and
    last_cmd_pow means a human intervened; the auto-OFF rule then sleeps until
    override_until. Auto-ON is never suspended -- see the module docstring.
    """
    if override_sec is None:
        override_sec = OVERRIDE_SEC
    state = dict(state)
    last_cmd = state.get("last_cmd_pow")
    manual = last_cmd is not None and powered != (last_cmd == 1)
    if manual:
        state["override_until"] = now + override_sec
    state["last_cmd_pow"] = 1 if powered else 0
    override = now < state.get("override_until", 0)
    if temp >= on and not powered:
        state["last_cmd_pow"] = 1
        state["override_until"] = 0
        return "on", f"{temp}C >= {on} -> ON (cool {SET_TEMP}C)", state
    if temp <= off and powered:
        if override:
            until = time.strftime("%H:%M", time.localtime(state["override_until"]))
            return None, f"manual ON respected until {until} ({temp}C <= {off} suppressed)", state
        state["last_cmd_pow"] = 0
        return "off", f"{temp}C <= {off} -> OFF", state
    if override:
        return None, "no change (manual override active)", state
    return None, "no change", state


def write_status(temp, on, off, profile, ac_pow, note, override_until=0):
    doc = {"generated_unix": int(time.time()),
           "temp_c": temp, "temp_on": on, "temp_off": off,
           "profile": profile,
           "ac": None if ac_pow is None else ("on" if ac_pow == 1 else "off"),
           "override_until": int(override_until) or None,
           "note": note}
    tmp = STATUS_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(doc, f, ensure_ascii=False)
        os.replace(tmp, STATUS_FILE)
    except Exception as e:
        alert(f"could not write status: {e}")


def main():
    on, off, profile = load_thresholds()
    if not KEY:
        alert("GREE_KEY unset; refusing to run")
        write_status(None, on, off, profile, None, "no key")
        return 2
    temp, err = read_temp()
    if temp is None:
        alert(f"no valid temp ({err}); AC left untouched")
        write_status(None, on, off, profile, None, err)
        return 1
    import gree_ctl
    mac = gree_ctl._cid_of(IP)
    st = gree_ctl.status(IP, KEY, mac)
    powered = st.get("Pow", 0) == 1
    cmd, note, state = decide(temp, on, off, powered, load_state(), time.time())
    if cmd == "on":
        gree_ctl.set_params(IP, KEY, mac, {"Pow": 1, "Mod": 1, "SetTem": SET_TEMP, "WdSpd": 0})
        powered = True
    elif cmd == "off":
        gree_ctl.set_params(IP, KEY, mac, {"Pow": 0})
        powered = False
    save_state(state)
    print(f"[{profile}] temp {temp}C on>={on} off<={off} AC {'on' if powered else 'off'}: {note}", flush=True)
    write_status(temp, on, off, profile, 1 if powered else 0, note,
                 override_until=state.get("override_until", 0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
