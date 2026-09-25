#!/usr/bin/env python3
"""Telethon login for the channel-deafness watchdog prober (dedicated user account).

Two steps (the SMS/Telegram login code comes from the operator interactively):
  request            -> connect + send_code_request, persist session+phone_code_hash
  signin <code> [pw] -> sign_in with the code (and 2FA password if set), persist final session

Creds: store/.watchdog-userbot.json (api_id, api_hash). Phone is passed/loaded.
Final authorized session string is written to store/.watchdog-userbot.session (mode 600).

ARMING PRECONDITION (HBTAILVAK914) -- read before running `signin`:
creating the session file ARMS the deafness-respawn path, and that path is
currently built on a transcript reader that is measurably blind. Do not sign in
until the fix below is merged; the script asks for explicit confirmation.
"""
import asyncio, json, os, sys
from telethon import TelegramClient
from telethon.sessions import StringSession

# HBTAILVAK914 (2026-09-14, measured twice, independently): the deafness check
# reads only the last 256KB of the newest main-session transcript. Between two
# inbound messages the session appends MBs, so on the MAIN root the window held
# no ingestion line for ~82% of the time (time-weighted), median inter-message
# append 284KB. An ARMED prober turns that blindness into false "deaf" verdicts,
# and the 15-minute respawn grace reproduces exactly the measured "13 restarts a
# night" shape. Precondition: the event-based last-ingestion state file (card
# HBTAILVAK914) must be merged BEFORE a session is created. Remove this gate
# when that card is closed.
TAIL_BLIND_WARNING = """
================================================================================
  FIGYELEM -- ELESITESI ELOFELTETEL (HBTAILVAK914)

  A session-fajl letrehozasa ELESITI a deafness-respawn agat, amely ma a
  transcript-reader 256KB-os tail-ablakara epul. Merve (2026-09-14, ket
  fuggetlen modszerrel): a fo munkameneten az ablak az ido ~82%-aban VAK --
  ket bejovo uzenet kozott a session tobb MB-ot appendel, es az ingestion
  kicsuszik az ablakbol. Elesitett proberrel ez HAMIS "deaf" iteletet ad, es
  a 15 perces respawn-grace pont a mert "13 ejszakai ujrainditas" alakzatot
  termeli ujra.

  ELOFELTETEL: az esemeny-alapu last-ingestion state-fajl (HBTAILVAK914
  kartya) legyen mergelve, MIELOTT sessiont hozol letre.
================================================================================
"""

def confirm_arming_precondition():
    print(TAIL_BLIND_WARNING, file=sys.stderr)
    if os.environ.get("HBTAILVAK914_ACK") == "1":
        print("HBTAILVAK914_ACK=1 -- precondition acknowledged via env.", file=sys.stderr)
        return
    # prompt on stderr: stdout carries the protocol lines (CODE_REQUEST_SENT,
    # SIGNED_IN) that callers may parse.
    print("A HBTAILVAK914 elofeltetel teljesult, elesitem a probert (ird be: ELESITEM): ", file=sys.stderr, end="", flush=True)
    try:
        answer = input()
    except EOFError:
        answer = ""
    if answer.strip() != "ELESITEM":
        print("Megszakitva: a session-fajl NEM jott letre (HBTAILVAK914 elofeltetel).", file=sys.stderr)
        sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS = os.path.join(ROOT, "store", ".watchdog-userbot.json")
LOGIN_TMP = os.path.join(ROOT, "store", ".watchdog-userbot-login.json")
SESSION_OUT = os.path.join(ROOT, "store", ".watchdog-userbot.session")
PHONE = "+00000000000"  # operator: set to the prober account phone before running

def load(p):
    with open(p) as f:
        return json.load(f)

def save600(p, obj):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)

async def do_request(api_id, api_hash):
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.connect()
    sent = await client.send_code_request(PHONE)
    save600(LOGIN_TMP, {"session": client.session.save(), "phone_code_hash": sent.phone_code_hash})
    print("CODE_REQUEST_SENT type=%s" % type(sent.type).__name__)
    await client.disconnect()

async def do_signin(api_id, api_hash, code, password):
    tmp = load(LOGIN_TMP)
    client = TelegramClient(StringSession(tmp["session"]), api_id, api_hash)
    await client.connect()
    try:
        await client.sign_in(PHONE, code=code, phone_code_hash=tmp["phone_code_hash"])
    except Exception as e:
        if "password" in str(e).lower() or "2fa" in str(e).lower() or "SessionPasswordNeeded" in type(e).__name__:
            if not password:
                print("NEEDS_2FA_PASSWORD"); await client.disconnect(); return
            await client.sign_in(password=password)
        else:
            print("SIGNIN_ERROR %s" % e); await client.disconnect(); return
    me = await client.get_me()
    save600(SESSION_OUT, {"session": client.session.save()})
    try: os.remove(LOGIN_TMP)
    except OSError: pass
    print("SIGNED_IN id=%s user=%s phone=%s" % (me.id, me.username, me.phone))
    await client.disconnect()

def main():
    c = load(CREDS)
    api_id, api_hash = int(c["api_id"]), c["api_hash"]
    cmd = sys.argv[1] if len(sys.argv) > 1 else "request"
    if cmd == "request":
        asyncio.get_event_loop().run_until_complete(do_request(api_id, api_hash))
    elif cmd == "signin":
        # signin is the step that persists the session file, i.e. the arming
        # act -- the gate sits here, not on `request`.
        confirm_arming_precondition()
        code = sys.argv[2]
        password = sys.argv[3] if len(sys.argv) > 3 else None
        asyncio.get_event_loop().run_until_complete(do_signin(api_id, api_hash, code, password))

if __name__ == "__main__":
    main()
