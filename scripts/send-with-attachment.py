#!/usr/bin/env python3
"""Send an email with one or more file attachments via the fiREG SMTP server.
Reads SMTP_* from the project .env. Usage:
  python3 scripts/send-with-attachment.py <to> <subject> <body_file> <attachment_path> [<attachment_path> ...]
"""
import os, sys, smtplib, mimetypes
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

ENV = os.path.join(os.path.dirname(__file__), '..', '.env')
env = {}
with open(ENV) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")

HOST = env.get('SMTP_HOST', 'mail.fws.hu')
PORT = int(env.get('SMTP_PORT', '587'))
USER = env.get('SMTP_USER', 'boss@fireg.hu')
PASS = env.get('SMTP_PASS', '')
FROM = env.get('SMTP_FROM', USER)

to, subject, body_file = sys.argv[1], sys.argv[2], sys.argv[3]
atts = sys.argv[4:]
with open(body_file, encoding='utf-8') as f:
    body = f.read()

msg = MIMEMultipart()
msg['From'] = FROM
msg['To'] = to
msg['Subject'] = subject
msg.attach(MIMEText(body, 'plain', 'utf-8'))

names = []
for att in atts:
    with open(att, 'rb') as f:
        data = f.read()
    fname = os.path.basename(att)
    part = MIMEApplication(data, Name=fname)
    part['Content-Disposition'] = f'attachment; filename="{fname}"'
    msg.attach(part)
    names.append(f"{fname} ({len(data)}b)")

with smtplib.SMTP(HOST, PORT, timeout=20) as s:
    s.starttls()
    s.login(USER, PASS)
    s.sendmail(FROM, [to], msg.as_bytes())
print(f"SENT from {FROM} to {to} (att: {', '.join(names)})")
