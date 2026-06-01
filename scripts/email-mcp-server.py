#!/usr/bin/env python3
"""
fiREG Email MCP Server
Eszközök: read_emails, send_email, mark_unread
"""
import imaplib
import smtplib
import email
import sys
import os
import asyncio
from email.header import decode_header
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

IMAP_HOST = os.environ.get('IMAP_HOST', 'mail.fws.hu')
IMAP_PORT = int(os.environ.get('IMAP_PORT', '993'))
SMTP_HOST = os.environ.get('SMTP_HOST', 'mail.fws.hu')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
USER = os.environ.get('SMTP_USER', 'boss@fireg.hu')
PASS = os.environ.get('SMTP_PASS', '8MeqaFtzFd')

app = Server("fireg-email")


def decode_str(s):
    if s is None:
        return ""
    parts = decode_header(s)
    result = ""
    for part, enc in parts:
        if isinstance(part, bytes):
            result += part.decode(enc or 'utf-8', errors='replace')
        else:
            result += str(part)
    return result


@app.list_tools()
async def list_tools():
    return [
        types.Tool(
            name="read_emails",
            description="Beolvassa a fiREG postafiók emailjeit (IMAP, nem jelöli olvasottnak). Inbox vagy Sent mappa, keresés UNSEEN/ALL/stb.",
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {"type": "integer", "description": "Hány levelet olvasson be (legfrissebb N)", "default": 10},
                    "folder": {"type": "string", "description": "Mappa neve: INBOX vagy Sent", "default": "INBOX"},
                    "search": {"type": "string", "description": "IMAP keresési feltétel: ALL, UNSEEN, SEEN, FROM x, SUBJECT x", "default": "ALL"},
                },
                "required": [],
            },
        ),
        types.Tool(
            name="send_email",
            description="Emailt küld a fiREG SMTP szerveren keresztül (a@fireg.hu feladóval).",
            inputSchema={
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Címzett email cím"},
                    "subject": {"type": "string", "description": "Email tárgya"},
                    "body": {"type": "string", "description": "Email törzse (plain text)"},
                },
                "required": ["to", "subject", "body"],
            },
        ),
        types.Tool(
            name="mark_unread",
            description="A legutóbbi N levelet visszaállítja olvasatlanra (eltávolítja a Seen flaget). CSAK explicit kérésre használd.",
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {"type": "integer", "description": "Hány levelet állítson vissza olvasatlanra", "default": 10},
                    "folder": {"type": "string", "description": "Mappa neve", "default": "INBOX"},
                },
                "required": [],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "read_emails":
        count = arguments.get("count", 10)
        folder = arguments.get("folder", "INBOX")
        search = arguments.get("search", "ALL")
        result = _read_emails(count, folder, search)
        return [types.TextContent(type="text", text=result)]

    elif name == "send_email":
        to = arguments["to"]
        subject = arguments["subject"]
        body = arguments["body"]
        result = _send_email(to, subject, body)
        return [types.TextContent(type="text", text=result)]

    elif name == "mark_unread":
        count = arguments.get("count", 10)
        folder = arguments.get("folder", "INBOX")
        result = _mark_unread(count, folder)
        return [types.TextContent(type="text", text=result)]

    else:
        return [types.TextContent(type="text", text=f"Ismeretlen tool: {name}")]


def _read_emails(count=10, folder='INBOX', search='ALL'):
    with imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT) as imap:
        imap.login(USER, PASS)
        imap.select(folder)
        _, msg_ids = imap.search(None, search)
        ids = msg_ids[0].split()
        ids = ids[-count:]

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
                payload = msg.get_payload(decode=True)
                if payload:
                    body = payload.decode('utf-8', errors='replace')[:500]

            results.append(f"FROM: {sender}\nDATE: {date}\nSUBJECT: {subject}\n{body[:300]}\n---")

        return "\n".join(results) if results else "Nincs levél."


def _send_email(to, subject, body):
    msg = MIMEMultipart()
    msg['From'] = USER
    msg['To'] = to
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        s.ehlo()
        s.starttls()
        s.login(USER, PASS)
        s.sendmail(USER, [to], msg.as_bytes())
    return f"Email elküldve: {to} / {subject}"


def _mark_unread(count=10, folder='INBOX'):
    with imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT) as imap:
        imap.login(USER, PASS)
        imap.select(folder)
        _, msg_ids = imap.search(None, 'ALL')
        ids = msg_ids[0].split()
        ids = ids[-count:]
        for mid in ids:
            imap.store(mid, '-FLAGS', '\\Seen')
        return f"{len(ids)} levél visszaállítva olvasatlanra."


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
