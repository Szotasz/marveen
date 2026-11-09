#!/usr/bin/env python3
"""The ONE safe writer of Claude Code's machine-wide managed-settings.json (MANAGEDSETTINGSWRITE1103).

Every installer path that touches the org-policy file calls this, instead of its own inline
merge. The inline copies had two faults:

1. scripts/ensure-managed-channels-enabled.sh turned an unreadable or non-object file into {}
   and wrote it back, as root. That silently dropped every other managed key, including the
   allowedChannelPlugins list, and so muted every channel host-wide.
2. All of them wrote a FIXED tmp name (`<file>.tmp`) with a plain open(), which follows a
   symlink, then copymode/chmod on that path (also following it), then os.replace. Whoever can
   write the directory can make a root process write and chmod a file of its choosing.
   (The same class was fixed in the Bridge's gromzo-root.sh on review of Bridge #99.)

The rules here:
- an existing file that is not valid JSON or not a JSON object: NOT written, exit 1;
- the file, if it exists, must be a regular file (not a symlink) owned by the effective user;
- the directory must be owned by the effective user and not group- or other-writable;
- changes are additive only: plugins are appended once, channelsEnabled is set true; every
  other key and entry stays; an unchanged file is not rewritten;
- the write: a fresh mkstemp file in the same directory (O_EXCL, unpredictable name), mode and
  owner set on the fd (an existing file keeps its mode, a new one gets 0644 so the
  unprivileged session can read the policy), written through the fd, then os.replace; the
  tmp is removed on any error.

The ownership checks use the EFFECTIVE uid: root when the installer runs this with sudo, the
test user in the tests, so the same code is measured in both.

Usage: managed-settings-write.py <file> [--create] [--channels-enabled] [--add-plugin NAME@MARKET]...
  --create  write the file if it does not exist (otherwise a missing file is left alone, exit 0)
Exit: 0 written or nothing to do; 1 refused (the reason on stderr), nothing changed.
"""
import json
import os
import stat
import sys
import tempfile


def refuse(msg):
    print("managed-settings NOT written: %s" % msg, file=sys.stderr)
    sys.exit(1)


def parse_args(argv):
    if not argv or argv[0].startswith("-"):
        refuse("usage: managed-settings-write.py <file> [--create] [--channels-enabled] [--add-plugin NAME@MARKET]...")
    path, create, enable, plugins = argv[0], False, False, []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--create":
            create = True
        elif a == "--channels-enabled":
            enable = True
        elif a == "--add-plugin" and i + 1 < len(argv):
            name, sep, market = argv[i + 1].partition("@")
            if not sep or not name or not market:
                refuse("bad --add-plugin value: %r (want NAME@MARKETPLACE)" % argv[i + 1])
            plugins.append({"plugin": name, "marketplace": market})
            i += 1
        else:
            refuse("unknown argument: %r" % a)
        i += 1
    return path, create, enable, plugins


def check_dir(d, euid):
    try:
        st = os.lstat(d)
    except OSError as e:
        refuse("the directory %s cannot be read: %s" % (d, e.strerror))
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        refuse("%s is not a plain directory" % d)
    if st.st_uid != euid:
        refuse("the directory %s is not owned by uid %d" % (d, euid))
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        refuse("the directory %s is group- or other-writable" % d)


def main(argv):
    path, create, enable, plugins = parse_args(argv)
    euid = os.geteuid()
    d = os.path.dirname(os.path.abspath(path))
    check_dir(d, euid)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        st = None
    if st is None:
        if not create:
            print("managed-settings: %s does not exist, nothing to merge" % path)
            return 0
        data, mode = {}, 0o644
    else:
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            refuse("%s is not a regular file" % path)
        if st.st_uid != euid:
            refuse("%s is not owned by uid %d" % (path, euid))
        try:
            with open(path, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            refuse("%s is not valid JSON (%s); an org-policy file is never rebuilt from scratch" % (path, type(e).__name__))
        if not isinstance(data, dict):
            refuse("%s is not a JSON object" % path)
        mode = stat.S_IMODE(st.st_mode)
    before = json.dumps(data, sort_keys=True)
    if plugins:
        have = data.get("allowedChannelPlugins")
        if have is None:
            have = []
        if not isinstance(have, list):
            refuse("allowedChannelPlugins in %s is not a list" % path)
        for p in plugins:
            if not any(isinstance(e, dict) and e.get("plugin") == p["plugin"]
                       and e.get("marketplace") == p["marketplace"] for e in have):
                have.append(p)
        data["allowedChannelPlugins"] = have
    if enable:
        data["channelsEnabled"] = True
    if json.dumps(data, sort_keys=True) == before and st is not None:
        print("managed-settings: %s already has everything, not rewritten" % path)
        return 0
    fd, tmp = tempfile.mkstemp(prefix=".managed-settings.", suffix=".tmp", dir=d)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, euid, os.getegid() if euid != 0 else 0)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print("managed-settings: %s written" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
