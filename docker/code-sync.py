#!/usr/bin/env python3
"""Copy this image's code into the install volume, atomically and verified (HOSTINGERDOCKER1107, Dani 72670).

/opt/marveen is a volume that holds the code AND the state, as a normal install does (every path the same, so the
gates that resolve real paths see no symlink). The code comes from /opt/marveen-image. When the image changes:

  1. the whole code tree is copied into a stage dir inside the volume and verified against the build manifest
     (every file's sha256, every symlink's target);
  2. a pending marker is written, then each top-level code entry is swapped in by rename (the old one moved aside),
     and code entries the new image no longer has are moved aside too;
  3. the swapped tree is verified against the manifest again IN PLACE; only then is the image id recorded and the
     marker removed.

A half-copied tree never starts: a failed check exits non-zero (the container stops before any process runs), and a
crash in between leaves the marker, so the next start does the whole sync again. State never enters the image
(.dockerignore), so a top-level state entry (.env, store/, agents/, ...) is never touched. Two files inside a code dir
are written at runtime by the dashboard (.claude/settings.json and settings.local.json: the hook entries): an existing
one is kept, and they are left out of the in-place check.
"""
import hashlib
import os
import shutil
import sys

IMG = os.environ.get('MARVEEN_IMAGE_DIR', '/opt/marveen-image')
DST = os.environ.get('MARVEEN_INSTALL_DIR', '/opt/marveen')
META = os.environ.get('MARVEEN_DOCKER_DIR', '/opt/marveen-docker')
KEEP = ('.claude/settings.json', '.claude/settings.local.json')
PENDING = '.code-sync-pending'
ID_FILE = '.image-id'
ENTRIES_FILE = '.code-entries'


def log(msg):
    print(f'code-sync: {msg}', flush=True)


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ''


def manifest():
    rows = []
    with open(os.path.join(META, 'image.manifest')) as f:
        for line in f:
            kind, value, rel = line.rstrip('\n').split(' ', 2)
            rows.append((kind, value, os.path.normpath(rel)))
    return rows


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def verify(root, rows, skip=()):
    bad = []
    for kind, value, rel in rows:
        if rel in skip:
            continue
        p = os.path.join(root, rel)
        if kind == 'L':
            if not os.path.islink(p) or os.readlink(p) != value:
                bad.append(rel)
        elif os.path.islink(p) or not os.path.isfile(p) or sha256(p) != value:
            bad.append(rel)
        if len(bad) >= 5:
            break
    return bad


def main():
    want = read(os.path.join(META, 'image.id'))
    if not want:
        log('no image id: the image is broken')
        return 2
    have = read(os.path.join(DST, ID_FILE))
    pending = os.path.exists(os.path.join(DST, PENDING))
    if want == have and not pending:
        log(f'code is current ({want[:12]})')
        return 0
    log(f'syncing the code {have[:12] or "-"} -> {want[:12]}' + (' (an interrupted sync is redone)' if pending else ''))
    rows = manifest()
    entries = sorted(os.listdir(IMG))

    stage = os.path.join(DST, f'.code-stage.{want[:12]}')
    aside = os.path.join(DST, f'.code-old.{os.getpid()}')
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    for e in entries:
        src, dst = os.path.join(IMG, e), os.path.join(stage, e)
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
    bad = verify(stage, rows)
    if bad:
        log(f'the staged copy does not match the image: {bad}')
        return 3
    for rel in KEEP:
        cur = os.path.join(DST, rel)
        if os.path.isfile(cur) and not os.path.islink(cur):
            shutil.copy2(cur, os.path.join(stage, rel))

    with open(os.path.join(DST, PENDING), 'w') as f:
        f.write(want + '\n')
    os.makedirs(aside)
    previous = [x for x in read(os.path.join(DST, ENTRIES_FILE)).split('\n') if x]
    for e in previous:
        if e not in entries and (os.path.lexists(os.path.join(DST, e))):
            os.rename(os.path.join(DST, e), os.path.join(aside, e))
    for e in entries:
        cur = os.path.join(DST, e)
        if os.path.lexists(cur):
            os.rename(cur, os.path.join(aside, e))
        os.rename(os.path.join(stage, e), cur)

    bad = verify(DST, rows, skip=KEEP)
    if bad:
        log(f'the swapped tree does not match the image: {bad} (the marker stays, the next start redoes it)')
        return 4
    with open(os.path.join(DST, ENTRIES_FILE), 'w') as f:
        f.write('\n'.join(entries) + '\n')
    with open(os.path.join(DST, ID_FILE), 'w') as f:
        f.write(want + '\n')
    os.remove(os.path.join(DST, PENDING))
    shutil.rmtree(aside, ignore_errors=True)
    shutil.rmtree(stage, ignore_errors=True)
    log(f'code synced and verified ({len(rows)} files)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
