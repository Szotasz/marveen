#!/usr/bin/env python3
"""SMTP envelope recipients of scripts/support-mail/send.py (SENDMAILLIST928).

--to and --cc accept a comma-separated address list. Before this, the whole list
went into the envelope as ONE RCPT ("a@x, b@y"), so a two-recipient letter could
not be sent. The headers keep the value as given; only the envelope is split.

Two layers are tested, because each can be wrong on its own:
  1. envelope_recipients(): the parsing (single, list, display name with a comma,
     duplicates, malformed input fails loudly instead of yielding an empty list);
  2. the BINDING: main() really passes that list to the SMTP call. main() runs
     in-process with smtplib/imaplib/lib.password replaced by recorders, so no
     network and no credential is touched.

Run:  python3 scripts/__tests__/support-mail-rcpt-list.test.py
"""
import io, os, sys, contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SUPPORT = os.path.join(ROOT, 'scripts', 'support-mail')
FAILS = []

# Hermetic config: set before import so lib/send read these, never a real .env value.
os.environ.update({
    'SUPPORT_OWNER_CC': 'owner@example.test',
    'SUPPORT_MAILBOX': 'box@example.test',
    'SUPPORT_VAULT_KEY': 'UNUSED-IN-TEST',
})
sys.path.insert(0, SUPPORT)
import send  # noqa: E402
import lib   # noqa: E402


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def parse_cases():
    er = send.envelope_recipients
    check('single --to', er('a@x.test') == ['a@x.test'], er('a@x.test'))
    check('comma list is split', er('a@x.test, b@y.test') == ['a@x.test', 'b@y.test'])
    check('--cc list is appended after --to',
          er('a@x.test', 'c@z.test, d@z.test') == ['a@x.test', 'c@z.test', 'd@z.test'])
    check('no cc (None) adds nothing', er('a@x.test', None) == ['a@x.test'])
    check('empty cc string adds nothing', er('a@x.test', '  ') == ['a@x.test'])
    check('display name with a comma stays ONE address',
          er('"Doe, John" <j@x.test>, B <b@y.test>') == ['j@x.test', 'b@y.test'],
          er('"Doe, John" <j@x.test>, B <b@y.test>'))
    check('duplicates are dropped, case-insensitively, first spelling kept',
          er('a@x.test, A@X.test', 'a@x.test') == ['a@x.test'])
    check('an empty item between commas is ignored', er('a@x.test,,b@y.test') == ['a@x.test', 'b@y.test'])
    for bad in ('nonsense', 'a@x.test, ,'):
        try:
            got = er(bad)
            check(f'malformed {bad!r} fails loudly', False, f'returned {got}')
        except ValueError:
            check(f'malformed {bad!r} fails loudly', True)


class _SMTP:
    calls = []

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, *a):
        pass

    def send_message(self, msg, to_addrs=None):
        _SMTP.calls.append({'to_addrs': list(to_addrs or []), 'To': msg['To'], 'Cc': msg['Cc']})


class _IMAP:
    def __init__(self, *a, **k):
        pass

    def login(self, *a):
        pass

    def append(self, *a):
        pass

    def logout(self):
        pass


def run_main(argv):
    """main() with recorders in place of the network; returns (smtp_call|None, exit_code|None)."""
    _SMTP.calls = []
    saved = (send.smtplib.SMTP_SSL, send.imaplib.IMAP4_SSL, lib.password, sys.argv)
    send.smtplib.SMTP_SSL, send.imaplib.IMAP4_SSL = _SMTP, _IMAP
    lib.password = lambda: 'x'
    sys.argv = ['send.py', '--subject', 's', '--body', 'b'] + argv
    code = None
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            send.main()
    except SystemExit as e:
        code = e.code
    finally:
        send.smtplib.SMTP_SSL, send.imaplib.IMAP4_SSL, lib.password, sys.argv = saved
    return (_SMTP.calls[0] if _SMTP.calls else None), code


def binding_cases():
    call, _ = run_main(['--to', 'a@x.test'])
    check('main: single --to reaches the envelope with the owner cc',
          call and call['to_addrs'] == ['a@x.test', 'owner@example.test'], call)

    call, _ = run_main(['--to', 'a@x.test, b@y.test'])
    check('main: a --to list reaches the envelope address by address',
          call and call['to_addrs'] == ['a@x.test', 'b@y.test', 'owner@example.test'], call)
    check('main: the To header keeps the list as given',
          call and call['To'] == 'a@x.test, b@y.test', call)

    call, _ = run_main(['--to', 'a@x.test, b@y.test', '--no-owner-cc'])
    check('main: without cc the envelope is exactly the --to list',
          call and call['to_addrs'] == ['a@x.test', 'b@y.test'] and call['Cc'] is None, call)

    call, code = run_main(['--to', 'nonsense'])
    check('main: malformed --to refuses BEFORE any SMTP call',
          call is None and code not in (None, 0), (call, code))


if __name__ == '__main__':
    parse_cases()
    binding_cases()
    print(f'\n{"ALL PASS" if not FAILS else str(len(FAILS)) + " FAILED"}')
    sys.exit(1 if FAILS else 0)
