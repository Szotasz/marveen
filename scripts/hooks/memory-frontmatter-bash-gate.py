#!/usr/bin/env python3
"""memory-frontmatter-bash-gate.py -- the memory frontmatter check for Bash writes (KAPUEGYUT918).

WHY: memory-frontmatter-gate.py sits on Write/Edit/MultiEdit, but the fleet
also writes memory files from Bash (python3 heredocs, cat >, sed -i), and our
own instructions recommend it. Measured 2026-09-29: 8 of the 268 fleet memory
files had a frontmatter that did not parse (recall-blind), all 8 changed after
the Write gate went live, and in the transcripts all 8 were written by Bash,
none by Write. So the gate guarded one of the two sanctioned paths. This hook
closes the concept, not a tool: it does not parse the command (arbitrary
interpreter code cannot be judged statically), it looks at the EFFECT -- which
memory files changed during the call, and whether they still parse.

HOW, three events, one script (the event comes from hook_event_name):
  PreToolUse(Bash)          stat snapshot (mtime_ns + size) of the caller's own
                            memory directories, stored under the tool_use_id.
  PostToolUse(Bash)         compare with the snapshot; read ONLY the changed
  PostToolUseFailure(Bash)  files and check them with the shared parser. A
                            failed command can still have written the file, and
                            a failed call fires PostToolUseFailure, never
                            PostToolUse (measured 2026-09-21), so both are needed.

WHAT exit 2 MEANS HERE (measured on 2.1.284, 2026-09-29, scratch project): in
PostToolUse and in PostToolUseFailure alike, exit 2 delivers the stderr text to
the model as a hook_blocking_error. It does NOT undo the write: the command has
already run and the file stays as written. The model gets the reason and the fix
in the same turn and has to repair the file. That is the whole of "block" here.

SCOPE (Samu, 32012):
  - only the CALLER's own memory directories: <config>/projects/<slug>/memory
    for the transcript's project and for the git root of the session's cwd (a
    sub-agent's memory lives under the repo root's slug, not under its cwd's),
    each resolved with realpath and counted once (.claude-config/projects is a
    symlink);
  - only files the command NAMES (the file name appears in the command text).
    The memory directory is shared by the fleet (one realpath), so another
    agent may write a file in the same window; a broken file this command did
    not name is not blamed on the caller, it gets one log line, and the daily
    sweep reports it. Measured: all 8 recall-blind files were named in the
    Bash command that wrote them.

FAIL-OPEN: any error of the hook itself (stdin, stat, a missing directory, an
unreadable state file) never blocks the call: exit 0 and one line to
store/hook-errors.log. This hook never exits 1.
"""
import json
import os
import re
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# HOOKDEPLOAD1008: guarded, like every other failure of this hook. Unguarded, a
# broken memory_frontmatter_lib.py failed at module load, before main(), with
# exit 1 -- the code this hook promises never to return.
try:
    from memory_frontmatter_lib import tartalom_hiba  # noqa: E402
    _LIB_ERR = None
except Exception as _lib_exc:  # noqa: BLE001 -- SyntaxError, ImportError, anything
    _LIB_ERR = _lib_exc

HOOK = 'memory-frontmatter-bash-gate'
STATE_DIR = os.environ.get('MEMFM_BASH_STATE_DIR') or os.path.join(tempfile.gettempdir(), 'claudeclaw-memfm-bash-gate')
STALE_S = 6 * 3600


def _log(message, exc=None):
    try:
        import hook_errlog
        hook_errlog.report(HOOK, message, exc)
    except Exception:
        pass


def _encode(path):
    """Claude Code's projects-dir name: every character that is not alphanumeric or '-' becomes '-'."""
    return re.sub(r'[^A-Za-z0-9-]', '-', path)


def _git_root(cwd):
    """The main repository root for cwd (a worktree's .git file points back to it), or None."""
    d = os.path.abspath(cwd)
    while True:
        g = os.path.join(d, '.git')
        if os.path.isdir(g):
            return d
        if os.path.isfile(g):
            try:
                with open(g, encoding='utf-8') as fh:
                    line = fh.read().strip()
            except Exception:
                return d
            m = re.match(r'gitdir:\s*(.+)$', line)
            if m and '/.git/worktrees/' in m.group(1).replace('\\', '/'):
                return m.group(1).replace('\\', '/').split('/.git/worktrees/')[0]
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def memory_dirs(payload):
    """The caller's own memory directories, realpath-resolved, each once."""
    config = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(os.path.expanduser('~'), '.claude')
    projects = os.path.join(config, 'projects')
    jeloltek = []
    tp = payload.get('transcript_path')
    if isinstance(tp, str) and tp:
        jeloltek.append(os.path.join(os.path.dirname(tp), 'memory'))
    cwd = payload.get('cwd')
    if isinstance(cwd, str) and cwd:
        # Both spellings of the path: the projects-dir name may come from the
        # logical path or from the resolved one (/var vs /private/var on macOS).
        for c in dict.fromkeys((os.path.abspath(cwd), os.path.realpath(cwd))):
            root = _git_root(c)
            if root:
                jeloltek.append(os.path.join(projects, _encode(root), 'memory'))
            jeloltek.append(os.path.join(projects, _encode(c), 'memory'))
    out = []
    for d in jeloltek:
        if os.path.isdir(d):
            rd = os.path.realpath(d)
            if rd not in out:
                out.append(rd)
    return out


def snapshot(dirs):
    snap = {}
    for d in dirs:
        for name in os.listdir(d):
            if not name.endswith('.md') or name == 'MEMORY.md':
                continue
            p = os.path.join(d, name)
            try:
                st = os.stat(p)
            except FileNotFoundError:
                continue
            snap[p] = [st.st_mtime_ns, st.st_size]
    return snap


def _state_path(tool_use_id):
    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', str(tool_use_id))[:120]
    return os.path.join(STATE_DIR, safe + '.json')


def _sweep_stale():
    try:
        now = time.time()
        for n in os.listdir(STATE_DIR):
            p = os.path.join(STATE_DIR, n)
            if now - os.path.getmtime(p) > STALE_S:
                os.remove(p)
    except Exception:
        pass


def pre(payload):
    tid = payload.get('tool_use_id')
    if not tid:
        return 0
    dirs = memory_dirs(payload)
    if not dirs:
        return 0
    os.makedirs(STATE_DIR, exist_ok=True)
    _sweep_stale()
    tmp = _state_path(tid) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'dirs': dirs, 'snap': snapshot(dirs)}, fh)
    os.replace(tmp, _state_path(tid))
    return 0


def changed_files(state):
    before = state.get('snap') or {}
    after = snapshot([d for d in state.get('dirs') or [] if os.path.isdir(d)])
    return sorted(p for p, sig in after.items() if before.get(p) != sig)


def post(payload):
    tid = payload.get('tool_use_id')
    if not tid:
        return 0
    sp = _state_path(tid)
    if not os.path.exists(sp):
        return 0  # no snapshot (hook added mid-call, or no memory dir): nothing to compare
    with open(sp, encoding='utf-8') as fh:
        state = json.load(fh)
    try:
        os.remove(sp)
    except Exception:
        pass
    cmd = (payload.get('tool_input') or {}).get('command') or ''
    hibak, nem_nevezett = [], []
    for p in changed_files(state):
        try:
            with open(p, encoding='utf-8') as fh:
                body = fh.read()
        except Exception:
            continue  # removed or unreadable since: not ours to judge
        ok = tartalom_hiba(body)
        if not ok:
            continue
        name = os.path.basename(p)
        if name in cmd or name[:-3] in cmd:
            hibak.append((p, ok))
        else:
            nem_nevezett.append(p)
    for p in nem_nevezett:
        _log(f'a hivas alatt valtozott, de a parancs nem nevezi meg, nem rojuk fel a hivonak: {p}')
    if not hibak:
        return 0
    sorok = [f'MEMORIA-FRONTMATTER UTOKAPU (Bash): a parancs LEFUTOTT, a fajl(ok) MEG VANNAK IRVA, de a frontmatter NEM parszol, a memoria igy RECALL-VAK. Javitsd most, es olvasd vissza:']
    for p, ok in hibak:
        sorok.append(f'- {p}: {ok}')
    sys.stderr.write('\n'.join(sorok) + '\n')
    return 2


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as ex:
        _log('olvashatatlan stdin, atengedve', ex)
        sys.exit(0)
    if not isinstance(payload, dict) or payload.get('tool_name') != 'Bash':
        sys.exit(0)
    ev = payload.get('hook_event_name')
    if _LIB_ERR is not None:
        msg = f'a kapu fuggosege (scripts/hooks/memory_frontmatter_lib.py) nem toltheto be ({ev}), atengedve'
        _log(msg, _LIB_ERR)
        sys.stderr.write(f'{HOOK}: {msg}: {_LIB_ERR!r}\n')
        sys.exit(0)
    try:
        if ev == 'PreToolUse':
            code = pre(payload)
        elif ev in ('PostToolUse', 'PostToolUseFailure'):
            code = post(payload)
        else:
            code = 0
    except Exception as ex:  # the hook's own error never blocks the call
        _log(f'belso hiba ({ev}), atengedve', ex)
        code = 0
    sys.exit(code)


if __name__ == '__main__':
    main()
