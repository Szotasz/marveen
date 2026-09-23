#!/usr/bin/env python3
"""
Take /status and /help away from the Telegram channel plugin (ELSOKOR922 D-4),
and mark forwarded messages in the inbound meta (forwarded="1").

The official plugin (claude-plugins-official/telegram/<ver>/server.ts) answers
/status ("Paired as ...") and /help itself, inside its bot poller -- those
messages never reach the session, so Marveen's command hook
(scripts/hooks/marveen-commands.py) cannot answer them. This script removes
the two handlers (and the plugin's own command menu, which would advertise
them with the plugin's meaning), leaving /start and everything else intact.
Without the handlers the two words arrive as ordinary text messages, exactly
like /usage does today, and the hook takes them.

Runs at every channel start (scripts/channels.sh), before the plugin is
spawned, over every cached plugin version:

- idempotent: a file carrying the marker is left alone;
- all-or-nothing per patch: if ANY anchor of a patch is missing (a plugin
  update changed the code), that patch is left out and one loud line says so
  -- /status and /help then fall back to the plugin's own answers, or a
  forwarded command is not refused; the channel itself is not touched;
- always exits 0: a failed patch must never stop the channel from starting.

Usage: patch-telegram-plugin.py [<plugins cache root> ...]
(default: $CLAUDE_CONFIG_DIR/plugins/cache and ~/.claude/plugins/cache)
"""
import os
import re
import sys
import time

MARKER = "// MARVEEN-PATCH(elsokor922-d4): /status and /help belong to the command hook"
FWD_MARKER = "// MARVEEN-PATCH(elsokor922-fwd): forwarded flag for the command hook"

# Each anchor is the handler's full block, up to its closing `})` at column 0.
ANCHORS = [
    ("help handler", re.compile(r"^bot\.command\('help', async ctx => \{\n.*?^\}\)\n", re.DOTALL | re.MULTILINE)),
    ("status handler", re.compile(r"^bot\.command\('status', async ctx => \{\n.*?^\}\)\n", re.DOTALL | re.MULTILINE)),
    ("setMyCommands menu", re.compile(r"^( *)void bot\.api\.setMyCommands\(\n.*?\n\1\)\.catch\(\(\) => \{\}\)\n", re.DOTALL | re.MULTILINE)),
]

# The inbound meta says nothing about forwarding, so a forwarded message that
# carries a command is byte-identical to one the owner typed (measured on the
# test bot, 2026-09-23: a forwarded /status ran). One meta key more, right
# after user_id, and the hook refuses to run a forwarded command.
FWD_ANCHOR = ("inbound meta user_id", re.compile(r"^( *)user_id: String\(from\.id\),\n", re.MULTILINE))

# Independent patches: each has its own marker and is all-or-nothing on its
# own, so a plugin update that moves one anchor does not undo the other.
PATCHES = [
    {"name": "d4", "marker": MARKER, "anchors": ANCHORS, "mode": "remove",
     "fallback": "/status and /help fall back to the plugin's own answers"},
    {"name": "fwd", "marker": FWD_MARKER, "anchors": [FWD_ANCHOR], "mode": "insert-after",
     "insert": "{indent}...(ctx.message?.forward_origin ? {{ forwarded: '1' }} : {{}}), " + FWD_MARKER + "\n",
     "fallback": "forwarded messages are not marked, a forwarded command runs like a typed one"},
]


def log(msg):
    sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} patch-telegram-plugin: {msg}\n")


def apply_patch(text, patch):
    """Returns (new_text, status). status: 'patched' | 'already' | 'anchor-missing:<name>'."""
    if patch["marker"] in text:
        return text, "already"
    out = text
    for name, rx in patch["anchors"]:
        found = list(rx.finditer(out))
        if len(found) != 1:
            return text, f"anchor-missing:{name}"
        m = found[0]
        indent = m.group(1) if rx.groups else ""
        if patch["mode"] == "remove":
            out = out[:m.start()] + f"{indent}{patch['marker']} ({name} removed)\n" + out[m.end():]
        else:
            out = out[:m.end()] + patch["insert"].format(indent=indent) + out[m.end():]
    return out, "patched"


def patch_text(text):
    """Returns (new_text, [(patch name, status), ...])."""
    results = []
    for patch in PATCHES:
        text, status = apply_patch(text, patch)
        results.append((patch, status))
    return text, results


def patch_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception as e:
        log(f"cannot read {path}: {type(e).__name__}")
        return "unreadable"
    new, results = patch_text(text)
    for patch, status in results:
        if status.startswith("anchor-missing"):
            log(f"LOUD: {status.split(':', 1)[1]} not found exactly once in {path} (plugin changed?) -- "
                f"the {patch['name']} patch left out, {patch['fallback']}")
    patched = [p["name"] for p, st in results if st == "patched"]
    if not patched:
        return "unchanged"
    tmp = path + ".marveen-tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(tmp, path)
    except Exception as e:
        log(f"cannot write {path}: {type(e).__name__} -- left unpatched ({', '.join(patched)})")
        try:
            os.remove(tmp)
        except Exception:
            pass
        return "unwritable"
    log(f"patched {path} ({', '.join(patched)})")
    return "patched"


def default_roots():
    roots = []
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        roots.append(os.path.join(cfg, "plugins", "cache"))
    roots.append(os.path.expanduser("~/.claude/plugins/cache"))
    return roots


def main(argv):
    roots = argv[1:] or default_roots()
    seen = set()
    for root in roots:
        base = os.path.join(root, "claude-plugins-official", "telegram")
        if not os.path.isdir(base):
            continue
        for ver in sorted(os.listdir(base)):
            path = os.path.realpath(os.path.join(base, ver, "server.ts"))
            if path in seen or not os.path.isfile(path):
                continue
            seen.add(path)
            patch_file(path)
    return 0


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as e:  # never stop the channel from starting
        log(f"unexpected {type(e).__name__}, nothing patched")
    sys.exit(0)
