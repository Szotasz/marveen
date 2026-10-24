#!/usr/bin/env python3
# PTY relay for `claude setup-token` (SETUPTOKENWIZ1022).
#
# `claude setup-token` needs a terminal: without a PTY it prints nothing and
# waits forever (measured for the Bridge installer, TOKENWIZ1). Node has no PTY
# in its standard library and this repo carries no native PTY module, so this
# stdlib-only relay provides one. It holds NO logic: the PTY output goes to
# stdout byte for byte, stdin goes to the PTY. Parsing, timeouts and the secret
# regime all live in src/web/setup-token-login.ts.
#
# Usage: setup-token-pty.py <absolute path of the claude binary>
# The environment is passed through unchanged; the caller builds it.
#
# Ending: stdin EOF or SIGTERM closes the PTY master, which ends the prompt
# (measured on CLI 2.1.308: the process exits, nothing lingers; Ctrl-C does
# not end it). A child still alive after the grace period gets SIGKILL.
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

GRACE_S = 3.0
# Wide geometry so the URL and the token are not hard-wrapped by the CLI.
# The parser is wrap-tolerant anyway; this keeps the common case simple.
COLS, ROWS = 512, 24


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except OSError as e:
            if e.errno == errno.EINTR:
                continue
            raise
        data = data[n:]


def main():
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        sys.stderr.write('usage: setup-token-pty.py <absolute claude path>\n')
        return 2
    claude = sys.argv[1]

    pid, master = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        except OSError:
            pass
        try:
            os.execv(claude, [claude, 'setup-token'])
        except OSError:
            os._exit(127)

    stop = {'flag': False}

    def on_term(_signum, _frame):
        stop['flag'] = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGHUP, on_term)

    stdin_open = True
    while not stop['flag']:
        watch = [master] + ([0] if stdin_open else [])
        try:
            ready, _, _ = select.select(watch, [], [], 0.5)
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break  # the child closed the terminal (exited)
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 4096)
            if not data:
                break  # stdin EOF: the caller ends the session
            write_all(master, data)

    try:
        os.close(master)
    except OSError:
        pass

    deadline = time.time() + GRACE_S
    status = None
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        time.sleep(0.05)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        _, status = os.waitpid(pid, 0)

    if status is not None and os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 1


if __name__ == '__main__':
    sys.exit(main())
