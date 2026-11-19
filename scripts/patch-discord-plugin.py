#!/usr/bin/env python3
"""
Marveen's version of the Discord channel plugin, put in place over the cached
official one (DCEXT1111; replaces the DCBTN1023 anchor patch, whose answer
buttons it carries).

The official plugin (claude-plugins-official/discord/<ver>/server.ts) is
vendored verbatim in vendor/discord-plugin/<ver>/upstream/, our version of it in
vendor/discord-plugin/<ver>/overlay/ (see vendor/discord-plugin/VENDOR.md for
what differs and why). Upstream does not take outside pull requests (its
close-external-prs workflow closes them), so the change lives here.

Runs at every channel start (scripts/channels.sh) when the session listens on
Discord, before the plugin is spawned, over every cached plugin version in ONE
cache: the one this install launches from ($CLAUDE_CONFIG_DIR/plugins/cache, or
~/.claude/plugins/cache when the variable is unset).

What a cached server.ts is decides what happens, never its folder name:
- the vendored upstream file (sha256), or that file with the old DCBTN1023
  tagged lines in it: ours goes in ("overlaid");
- a file this script wrote (its sha256 in the .marveen-overlay.json manifest
  next to it, or byte-identical to a vendored overlay server.ts): brought to the current overlay and settings ("upgraded"), or
  left alone when already current ("already");
- anything else (a plugin update): left alone, one loud line, the plugin runs
  as shipped ("unknown"). Nothing is ever written over a file we cannot name.

DISCORD_PLUGIN_EXT=off puts the vendored upstream file back, byte-identical,
and removes everything else this script wrote ("restored"): the plugin is the
official one again after the next channel start. DISCORD_OWNER_USER_ID and
DISCORD_BACKFILL go to marveen-ext.json next to server.ts, which the overlay
reads at start, together with the dashboard's command menu (the slash commands,
read with the install's dashboard token; null when that is not possible). Settings are read as the dashboard's settings store answers
them (the first two are overrides-only: the owner's override, never .env);
a change takes effect at the next channel start.

Always exits 0: a failed run must never stop the channel from starting.
With --state FILE, the outcome per file is written there as JSON.

Usage: patch-discord-plugin.py [--state FILE] [--install DIR] [<plugins cache root>]
(default root: $CLAUDE_CONFIG_DIR/plugins/cache, else ~/.claude/plugins/cache;
default install: the one this script lives in)
"""
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL_DIR = os.path.dirname(HERE)
VENDOR = os.path.join(INSTALL_DIR, "vendor", "discord-plugin")

# The old anchor patch tagged every line it added; a file still carrying them
# is the upstream file plus our buttons, and is taken over like the upstream one.
DCBTN_TAG = "// MARVEEN-PATCH(dcbtn1023)"
MANIFEST = ".marveen-overlay.json"
EXT_CONFIG = "marveen-ext.json"
SNOWFLAKE = re.compile(r"^[1-9][0-9]{16,19}$")
# The overlay's id shape for channels and roles (marveen-ext.ts SNOWFLAKE_ID).
SNOWFLAKE_ID = re.compile(r"^[0-9]{15,20}\Z")
# DISCORD_CHANNEL_POLICY's on/off keys per channel, as the overlay's parseChannelPolicy reads them.
CHANNEL_POLICY_FLAGS = ("history", "autoThread")


def log(msg):
    sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} patch-discord-plugin: {msg}\n")


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def strip_dcbtn(text):
    return "".join(l for l in text.splitlines(keepends=True) if not l.rstrip("\n").endswith(DCBTN_TAG))


def load_vendor():
    """{upstream sha256: {"version", "upstream": bytes, "overlay": {name: bytes}}} for every vendored version."""
    out = {}
    if not os.path.isdir(VENDOR):
        return out
    for ver in sorted(os.listdir(VENDOR)):
        up = os.path.join(VENDOR, ver, "upstream", "server.ts")
        ov = os.path.join(VENDOR, ver, "overlay")
        if not (os.path.isfile(up) and os.path.isdir(ov)):
            continue
        upstream = read_bytes(up)
        overlay = {n: read_bytes(os.path.join(ov, n)) for n in sorted(os.listdir(ov)) if os.path.isfile(os.path.join(ov, n))}
        if "server.ts" not in overlay:
            continue
        out[sha(upstream)] = {"version": ver, "upstream": upstream, "overlay": overlay}
    return out


def _telegram_helpers():
    # The store's .env parsing and flag reading, mirrored once in the Telegram patcher (parity-tested there).
    spec = importlib.util.spec_from_file_location("patch_telegram_plugin", os.path.join(HERE, "patch-telegram-plugin.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def override_value(install_dir, key):
    """An OVERRIDES-ONLY key as settings-store answers it: store/config-overrides.json, never .env."""
    try:
        with open(os.path.join(install_dir, "store", "config-overrides.json"), encoding="utf-8") as f:
            ov = json.load(f)
        v = ov.get(key) if isinstance(ov, dict) else None
        if isinstance(v, (str, int)) and not isinstance(v, bool):
            return str(v)
    except Exception:
        pass
    return None


def settings(install_dir):
    """(ext on?, marveen-ext.json content). DISCORD_PLUGIN_EXT and DISCORD_OWNER_USER_ID are overrides-only
    (src/config-registry.ts: switching the overlay off, or naming another owner, loosens who approves a tool);
    DISCORD_BACKFILL is a plain flag (override, then .env, then on)."""
    tg = _telegram_helpers()
    raw = override_value(install_dir, "DISCORD_PLUGIN_EXT")
    ext_on = True if raw is None else tg.is_on(raw)
    owner = (override_value(install_dir, "DISCORD_OWNER_USER_ID") or "").strip(tg.JS_TRIM)
    if owner and not SNOWFLAKE.match(owner):
        log("LOUD: DISCORD_OWNER_USER_ID is set but is not a Discord user id -- NOT used")
        owner = ""
    backfill = tg.flag_setting(install_dir, "DISCORD_BACKFILL", True)
    # DISCORD_CHANNEL_POLICY (overrides-only): per-channel extras, e.g. {"<channel>": {"allowRoles": ["<role>"], "history": true}}.
    # Passed through as parsed JSON; the overlay keeps only well-formed entries (marveen-ext.ts parseChannelPolicy).
    policy = {}
    raw_policy = (override_value(install_dir, "DISCORD_CHANNEL_POLICY") or "").strip(tg.JS_TRIM)
    if raw_policy:
        try:
            parsed = json.loads(raw_policy)
            if not isinstance(parsed, dict):
                raise ValueError("not an object")
            policy = parsed
        except ValueError:
            log("LOUD: DISCORD_CHANNEL_POLICY is set but is not a JSON object -- NOT used (no channel extras)")
        for line in channel_policy_drops(policy):
            log(f"LOUD: DISCORD_CHANNEL_POLICY {line} -- dropped, that channel keeps the plain allowFrom rule")
    return ext_on, {"ownerUserId": owner, "backfill": bool(backfill), "channelPolicy": policy,
                    "slashCommands": slash_commands(install_dir) if ext_on else None}


def slash_commands(install_dir):
    """DCEXT1111 F1s: the dashboard registry's command list for Discord (GET /api/commands/menu?channel=discord: the
    Telegram menu plus the Discord-only entries), as the Discord slash commands the overlay registers. None when it cannot be read (no token, the
    dashboard down): the overlay then registers nothing and what Discord has stays. The token is never logged."""
    try:
        with open(os.path.join(install_dir, "store", ".dashboard-token"), encoding="utf-8") as f:
            tok = f.read().strip()
    except OSError:
        return None
    if not tok:
        return None
    port = (os.environ.get("WEB_PORT") or "").strip()
    if not port.isdigit():
        port = "3420"
        try:
            for line in open(os.path.join(install_dir, ".env"), encoding="utf-8"):
                if line.startswith("WEB_PORT=") and line.split("=", 1)[1].strip().isdigit():
                    port = line.split("=", 1)[1].strip()
        except OSError:
            pass
    base = os.environ.get("MARVEEN_API_BASE") or f"http://127.0.0.1:{port}"
    try:
        req = urllib.request.Request(base + "/api/commands/menu?channel=discord", headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=5) as r:
            cmds = json.loads(r.read().decode("utf-8")).get("commands")
    except Exception as e:
        log(f"slash commands: the dashboard menu is not readable ({type(e).__name__}), none registered this time")
        return None
    if not isinstance(cmds, list):
        return None
    return [{"name": str(c["command"]).lstrip("/"), "description": str(c.get("description") or "")}
            for c in cmds if isinstance(c, dict) and isinstance(c.get("command"), str)]


def channel_policy_drops(policy):
    """What the overlay's parseChannelPolicy (marveen-ext.ts) will silently drop, one line each. The object
    itself is passed on unchanged; this only makes the drop visible (a role NAME instead of its id, say)."""
    out = []
    for ch, v in policy.items():
        if not SNOWFLAKE_ID.match(ch):
            out.append(f"channel {ch!r} is not a Discord channel id")
            continue
        if not isinstance(v, dict):
            out.append(f"channel {ch}: not an object")
            continue
        for k, flag in v.items():
            if k == "allowRoles":
                continue
            if k not in CHANNEL_POLICY_FLAGS:
                out.append(f"channel {ch}: unknown key {k!r}")
            elif flag is not True and flag is not False:
                out.append(f"channel {ch}: {k} is {flag!r}, only a literal true turns it on")
        roles = v.get("allowRoles")
        if roles is None:
            continue
        if not isinstance(roles, list):
            out.append(f"channel {ch}: allowRoles is not a list")
            continue
        for r in roles:
            if not (isinstance(r, str) and SNOWFLAKE_ID.match(r)):
                out.append(f"channel {ch}: allowRoles entry {r!r} is not a Discord role id (the id, not the name)")
    return out


def identify(dirpath, text_bytes, vendor):
    """(kind, vendor entry, manifest): kind is 'upstream' | 'dcbtn' | 'ours' | 'unknown'."""
    h = sha(text_bytes)
    if h in vendor:
        return "upstream", vendor[h], None
    # Ours before DCBTN: the overlay carries the DCBTN-tagged button lines too.
    manifest = None
    try:
        with open(os.path.join(dirpath, MANIFEST), encoding="utf-8") as f:
            manifest = json.load(f)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict):
            manifest = None
        elif manifest["files"].get("server.ts") == h and manifest.get("upstream") in vendor:
            return "ours", vendor[manifest["upstream"]], manifest
    except Exception:
        manifest = None
    # A vendored overlay server.ts is ours even when the manifest is missing or stale: a run that
    # failed between writing server.ts and writing the manifest must not strand the overlay.
    for entry in vendor.values():
        if sha(entry["overlay"]["server.ts"]) == h:
            return "ours", entry, manifest
    try:
        text = text_bytes.decode("utf-8")
    except UnicodeDecodeError:
        text = ""
    if DCBTN_TAG in text:
        base = sha(strip_dcbtn(text))
        if base in vendor:
            return "dcbtn", vendor[base], None
    return "unknown", None, None


def write_atomic(path, data):
    tmp = path + ".marveen-tmp"
    # A leftover (or planted) temp entry is unlinked, never followed: os.remove on a symlink removes the link.
    if os.path.lexists(tmp):
        os.remove(tmp)
    created = False
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o666)
        created = True
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        created = False
    finally:
        if created and os.path.lexists(tmp):
            os.remove(tmp)


def desired_files(entry, ext):
    files = dict(entry["overlay"])
    files[EXT_CONFIG] = (json.dumps(ext, indent=1, sort_keys=True) + "\n").encode("utf-8")
    return files


def manifest_old_files(manifest, vendor):
    """The manifest's file names that may be removed: plain basenames of the vendored overlay set (or
    marveen-ext.json). The manifest is a file in the plugin folder, not ours to trust: anything else
    (a path, ../, an absolute name) is skipped loudly and never handed to os.remove. (names, rejected?)"""
    known = {n for e in vendor.values() for n in e["overlay"]} | {EXT_CONFIG}
    names, rejected = set(), False
    for name in (manifest or {}).get("files", {}):
        if name == "server.ts":
            continue
        if isinstance(name, str) and name in known and name not in ("", ".", "..") and os.path.basename(name) == name:
            names.add(name)
        else:
            rejected = True
            log(f"LOUD: {MANIFEST} names {name!r}, which is not one of the overlay's own files -- not removed")
    return names, rejected


def apply_file(path, vendor, ext_on, ext):
    dirpath = os.path.dirname(path)
    try:
        current = read_bytes(path)
    except Exception as e:
        log(f"cannot read {path}: {type(e).__name__}")
        return "unreadable"
    kind, entry, manifest = identify(dirpath, current, vendor)
    if kind == "unknown":
        if vendor:
            log(f"LOUD: {path} is not a plugin version this install knows (plugin updated?) -- "
                "left as shipped, Marveen's Discord additions are off until vendor/discord-plugin catches up")
        else:
            log(f"LOUD: vendor/discord-plugin missing or empty -- {path} left as shipped")
        return "unknown"
    old_files, manifest_rejected = manifest_old_files(manifest, vendor)
    if kind == "ours":
        # Without a manifest naming them, the overlay's own supporting files are the ones we wrote.
        old_files |= {n for n in entry["overlay"] if n != "server.ts" and os.path.isfile(os.path.join(dirpath, n))
                      and read_bytes(os.path.join(dirpath, n)) == entry["overlay"][n]}

    try:
        if not ext_on:
            if kind == "upstream" and manifest is None and not os.path.exists(os.path.join(dirpath, MANIFEST)):
                return "upstream"
            write_atomic(path, entry["upstream"])
            for name in sorted(old_files | {EXT_CONFIG}):
                p = os.path.join(dirpath, name)
                if os.path.exists(p):
                    os.remove(p)
            if os.path.exists(os.path.join(dirpath, MANIFEST)):
                os.remove(os.path.join(dirpath, MANIFEST))
            log(f"restored {path} to the official plugin {entry['version']} (DISCORD_PLUGIN_EXT=off)")
            return "restored"

        want = desired_files(entry, ext)
        if kind == "ours":
            same = all(
                os.path.isfile(os.path.join(dirpath, n)) and read_bytes(os.path.join(dirpath, n)) == data
                for n, data in want.items()
            ) and old_files | {"server.ts", EXT_CONFIG} == set(want) and not manifest_rejected and manifest is not None and (
                manifest.get("files") == {n: sha(d) for n, d in want.items() if n != EXT_CONFIG})
            if same:
                return "already"
        # Supporting files first, server.ts last: until it is replaced, the old
        # server.ts runs and never imports a half-written set.
        for name, data in sorted(want.items()):
            if name != "server.ts":
                write_atomic(os.path.join(dirpath, name), data)
        for name in sorted(old_files - set(want)):
            p = os.path.join(dirpath, name)
            if os.path.exists(p):
                os.remove(p)
        write_atomic(path, want["server.ts"])
        write_atomic(os.path.join(dirpath, MANIFEST), (json.dumps({
            "upstream": sha(entry["upstream"]),
            "version": entry["version"],
            "files": {n: sha(d) for n, d in sorted(want.items()) if n != EXT_CONFIG},
        }, indent=1) + "\n").encode("utf-8"))
    except Exception as e:
        log(f"cannot write in {dirpath}: {type(e).__name__} -- left as it was")
        return "unwritable"
    status = "upgraded" if kind == "ours" else "overlaid"
    log(f"{status} {path} (Marveen's Discord plugin {entry['version']}, from {kind})")
    return status


def default_root():
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        return os.path.join(cfg, "plugins", "cache")
    return os.path.expanduser("~/.claude/plugins/cache")


def write_state(state_path, state):
    tmp = state_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, state_path)
    except Exception as e:
        log(f"cannot write state {state_path}: {type(e).__name__}")


def main(argv):
    args = argv[1:]
    state_path = None
    install_dir = INSTALL_DIR
    while len(args) >= 2 and args[0] in ("--state", "--install"):
        if args[0] == "--state":
            state_path = args[1]
        else:
            install_dir = args[1]
        args = args[2:]
    root = args[0] if args else default_root()
    ext_on, ext = settings(install_dir)
    vendor = load_vendor()
    files = []
    base = os.path.join(root, "claude-plugins-official", "discord")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base)):
            path = os.path.join(base, ver, "server.ts")
            if os.path.isfile(path):
                files.append({"version": ver, "path": path, "status": apply_file(path, vendor, ext_on, ext)})
    if state_path:
        write_state(state_path, {
            "at": int(time.time()), "root": root, "mode": "on" if ext_on else "off",
            "owner_set": bool(ext["ownerUserId"]), "backfill": ext["backfill"],
            "slash_commands": None if ext.get("slashCommands") is None else len(ext["slashCommands"]), "files": files,
        })


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as e:  # never stop the channel from starting
        log(f"unexpected {type(e).__name__}, nothing changed")
    sys.exit(0)
