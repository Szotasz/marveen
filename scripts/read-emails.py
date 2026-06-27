#!/usr/bin/env python3
"""
fiREG email olvasó -- a@fireg.hu IMAP
Használat: python3 read-emails.py [--count N] [--search QUERY] [--folder FOLDER]
"""
import imaplib, email, sys, argparse, os
from email.header import decode_header

def _email_pass():
    v = os.environ.get('IMAP_PASS') or os.environ.get('SMTP_PASS')
    if v:
        return v
    creds = os.path.join(os.path.dirname(__file__), '..', 'store', '.email-creds')
    try:
        with open(creds) as f:
            for line in f:
                line = line.strip()
                if line.startswith(('EMAIL_PASS=', 'IMAP_PASS=', 'SMTP_PASS=')):
                    return line.split('=', 1)[1]
    except FileNotFoundError:
        pass
    raise SystemExit('Email password not set: export IMAP_PASS or add EMAIL_PASS to store/.email-creds')

def decode_str(s):
    if s is None: return ""
    parts = decode_header(s)
    result = ""
    for part, enc in parts:
        if isinstance(part, bytes):
            result += part.decode(enc or 'utf-8', errors='replace')
        else:
            result += str(part)
    return result

def read_emails(count=10, search='ALL', folder='INBOX'):
    with imaplib.IMAP4_SSL(os.environ.get('IMAP_HOST', 'mail.fws.hu'), 993) as imap:
        imap.login(os.environ.get('IMAP_USER', 'boss@fireg.hu'), _email_pass())
        imap.select(folder)
        _, msg_ids = imap.search(None, search)
        ids = msg_ids[0].split()
        ids = ids[-count:]  # legfrissebb N
        
        results = []
        for mid in reversed(ids):
            _, data = imap.fetch(mid, '(BODY.PEEK[])')
            msg = email.message_from_bytes(data[0][1])
            subject = decode_str(msg.get('Subject', ''))
            sender = decode_str(msg.get('From', ''))
            date = msg.get('Date', '')
            
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == 'text/plain':
                        body = part.get_payload(decode=True).decode('utf-8', errors='replace')[:500]
                        break
            else:
                body = msg.get_payload(decode=True).decode('utf-8', errors='replace')[:500]
            
            results.append(f"FROM: {sender}\nDATE: {date}\nSUBJECT: {subject}\n{body[:300]}\n---")
        
        return "\n".join(results)

def _creds_value(key):
    creds = os.path.join(os.path.dirname(__file__), '..', 'store', '.email-creds')
    try:
        with open(creds) as f:
            for line in f:
                if line.startswith(key + '='):
                    return line.strip().split('=', 1)[1]
    except FileNotFoundError:
        pass
    return None

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--count', type=int, default=10)
    parser.add_argument('--search', default='ALL')
    parser.add_argument('--folder', default='INBOX')
    parser.add_argument('--account', default='boss', choices=['boss', 'a'],
                        help="boss = boss@fireg.hu (default), a = a@fireg.hu (Attila inbox)")
    args = parser.parse_args()
    if args.account == 'a':
        os.environ['IMAP_USER'] = _creds_value('A_FIREG_USER') or 'a@fireg.hu'
        apw = _creds_value('A_FIREG_PASS')
        if apw:
            os.environ['IMAP_PASS'] = apw
    print(read_emails(args.count, args.search, args.folder))
