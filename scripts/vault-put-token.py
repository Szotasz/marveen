#!/usr/bin/env python3
"""Interactively store one secret in the Marveen vault.

Why a script and not a shell one-liner: a one-liner that the owner types by hand
cannot be dry-run before it is handed over, and a shell quoting mistake consumes
the secret from `read` before failing, so the failure looks like "nothing
happened". Measured 2026-09-22: `TOK="$TOK"` placed AFTER `python3 -c` became an
argv element instead of an environment variable and died with KeyError, with
almost nothing on screen.

Usage:
    python3 scripts/vault-put-token.py <secret-id> [label]

The value is read with getpass (never echoed, never in shell history, never an
argv element). The HTTP status and the response body are always printed, so a
rejected write cannot be mistaken for a successful one.
"""
import getpass
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TOKEN_PATH = PROJECT_ROOT / 'store' / '.dashboard-token'
VAULT_URL = 'http://localhost:3420/api/vault'


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    secret_id = sys.argv[1].strip()
    label = sys.argv[2] if len(sys.argv) > 2 else secret_id

    if not TOKEN_PATH.exists():
        print(f'FAIL: dashboard token not found at {TOKEN_PATH}', file=sys.stderr)
        return 1
    dashboard_token = TOKEN_PATH.read_text().strip()

    # A non-TTY stdin is the failure this script kept hitting from inside the
    # agent prompt: `read`/getpass see EOF at once, the value is empty, and the
    # whole thing looks like it ran. Say it out loud instead.
    if not sys.stdin.isatty():
        print(
            'FAIL: stdin is not a terminal, so the value cannot be typed in.\n'
            '      Run this in a real shell, not from an agent prompt or a pipe.',
            file=sys.stderr,
        )
        return 1

    value = getpass.getpass(f'Value for "{secret_id}" (not echoed): ').strip()
    if not value:
        print('FAIL: empty value, nothing written.', file=sys.stderr)
        return 1

    payload = json.dumps({'id': secret_id, 'label': label, 'value': value}).encode()
    req = urllib.request.Request(
        VAULT_URL,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {dashboard_token}',
        },
        method='POST',
    )
    # Both branches report the status AND the body: a silent failure here is the
    # exact thing this script exists to prevent.
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
            print(f'HTTP {resp.status}  {body}')
            ok = resp.status == 200 and '"ok":true' in body.replace(' ', '')
    except urllib.error.HTTPError as err:
        print(f'HTTP {err.code}  {err.read().decode()[:300]}', file=sys.stderr)
        return 1
    except urllib.error.URLError as err:
        print(f'FAIL: cannot reach the dashboard ({err.reason}). Is it running?', file=sys.stderr)
        return 1

    if not ok:
        print('FAIL: the vault did not confirm the write.', file=sys.stderr)
        return 1

    # Read back by id, and print only the LENGTH: proof it is stored, without
    # putting the secret on screen or in a log.
    verify = urllib.request.Request(
        f'{VAULT_URL}/{secret_id}',
        headers={'Authorization': f'Bearer {dashboard_token}'},
    )
    try:
        with urllib.request.urlopen(verify, timeout=15) as resp:
            stored = json.loads(resp.read().decode()).get('value') or ''
        match = 'MATCHES' if stored == value else 'DIFFERS FROM INPUT'
        print(f'Verified: vault returned {len(stored)} characters, {match}.')
    except urllib.error.HTTPError as err:
        print(f'WARN: stored, but read-back failed with HTTP {err.code}', file=sys.stderr)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
