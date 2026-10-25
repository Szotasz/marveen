#!/usr/bin/env python3
"""
Stop hook — two jobs, in one place so there is a single owner of the per-session
progress state at turn end (no racing Stop hooks):

  1) CLEAR: remove the "✍️ Dolgozom rajta…" placeholder(s) that the
     UserPromptSubmit hook (telegram_progress.py) posted for this session. Under
     normal operation the PostToolUse reply hook already cleared them the moment
     the agent replied, so usually there is nothing left to do.

  2) ENFORCE DELIVERY: if the turn was triggered by an inbound Telegram message
     but the agent ended the turn WITHOUT ever sending a reply to that chat
     (i.e. a placeholder is still pending), the answer only exists in the CLI /
     transcript — which the Telegram user never sees ("the agent looks frozen").
     This hook then:
       - on the first Stop: BLOCKS the stop and instructs the agent to send its
         answer via the Telegram `reply` tool (the agent re-enters and replies
         properly, with its own formatting);
       - if it STILL did not reply after that one nudge: delivers the agent's
         final answer (last assistant message from the transcript) to the chat
         as a guaranteed fallback, then removes the placeholder.
     So a Telegram turn always ends with the user getting the answer here.

Loop safety: a per-session `enforce-<sid>.marker` guarantees we block at most
once; `stop_hook_active` is also honored. Silent on stdout EXCEPT the single
decision JSON when blocking. Token/state dir resolution mirrors the plugin
(TELEGRAM_STATE_DIR else default).
"""
import sys, os, json, glob, time, urllib.request

INSTRUCTION = (
    "KÖTELEZŐ: erre a Telegram-üzenetre még NEM küldtél választ a Telegram "
    "`reply` tool-lal (chat_id=%s). A CLI/transzkript szöveget a felhasználó a "
    "Telegramon NEM látja — onnan nézve csak befagytál. Küldd el a válaszodat "
    "MOST a `reply` tool-lal a megfelelő chat_id-vel. Ha tényleg nincs érdemi "
    "válasz, akkor is küldj egy rövid visszaigazolást."
)


def state_dir():
    # #915: env override, then the install-scoped dir once it holds the .env,
    # then the legacy shared path (unmigrated installs only).
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _inst = os.path.join(_root, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(_inst, ".env")):
        return _inst
    return os.path.expanduser("~/.claude/channels/telegram")


def log(sd, msg):
    # Timestamped: the 2026-08-12 duplicate-reply hunt stalled for an hour
    # because [submit]/[enforce] lines carried no clock, so a twin-hook race
    # (milliseconds apart) was indistinguishable from two separate turns.
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()}] {msg}\n")
    except Exception:
        pass


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def _ssl_ctx():
    # See telegram_progress.py: some macOS python.org builds lose the default CA
    # store (cafile=None) after an OpenSSL upgrade, breaking the Stop-hook
    # enforce fallback. Fall back to the system bundle if the default is empty.
    import ssl
    ctx = ssl.create_default_context()
    if ssl.get_default_verify_paths().cafile is None:
        for p in ("/private/etc/ssl/cert.pem", "/usr/local/etc/ca-certificates/cert.pem"):
            if os.path.exists(p):
                ctx.load_verify_locations(p)
                break
    return ctx


_SSL_CTX = _ssl_ctx()


def api(tok, method, payload):
    # Base is overridable (TELEGRAM_API_BASE) so tests can point it at a local
    # stub; defaults to the real Bot API, so production is unchanged.
    base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    url = f"{base}/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8, context=_SSL_CTX) as r:
        return json.loads(r.read().decode())


def topic_of(entry):
    """The topic the placeholder was posted into (TELEGRAM_TOPICS_ENABLED), as
    sendMessage parameters; empty for a plain chat, so the payload stays as is."""
    t = entry.get("message_thread_id")
    return {"message_thread_id": t} if isinstance(t, int) and t > 0 else {}


def last_assistant_text(transcript_path):
    """Return the last non-empty assistant text message from the JSONL transcript
    (the agent's final user-facing answer). Empty string if none / unreadable."""
    text = ""
    if not transcript_path:
        return text
    try:
        for line in open(transcript_path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            msg = ev.get("message") or {}
            role = msg.get("role") or ev.get("role")
            if ev.get("type") == "assistant" or role == "assistant":
                content = msg.get("content", ev.get("content"))
                parts = []
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            parts.append(c.get("text", ""))
                elif isinstance(content, str):
                    parts.append(content)
                t = "\n".join(p for p in parts if p).strip()
                if t:
                    text = t  # keep the LAST non-empty one
    except Exception:
        pass
    return text


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        ev = {}
    sid = ev.get("session_id") or "default"
    transcript = ev.get("transcript_path")
    stop_active = bool(ev.get("stop_hook_active"))
    sd = state_dir()
    pdir = os.path.join(sd, "progress")
    guard = os.path.join(pdir, f"enforce-{sid}.marker")

    # Clean up this session's dedup markers (created by telegram_progress.py).
    for m in glob.glob(os.path.join(pdir, f"seen-{sid}-*.marker")):
        try:
            os.remove(m)
        except Exception:
            pass

    # Which chats already got a REAL reply this turn? The PostToolUse reply hook
    # drops replied-<sid>-<chat>.marker the moment the reply tool fires (even
    # before the async placeholder file is written). Those chats are done and
    # must NEVER get the transcript-prose fallback, or the user sees the answer
    # twice — and must NOT be nudged with a bogus "you never replied".
    def already_replied(chat_id):
        return os.path.exists(os.path.join(pdir, f"replied-{sid}-{chat_id}.marker"))

    def clear_replied_markers():
        for m in glob.glob(os.path.join(pdir, f"replied-{sid}-*.marker")):
            try:
                os.remove(m)
            except Exception:
                pass

    def claim_send(mid):
        """Win-once guard so a Stop hook registered under two python paths can't
        deliver the fallback twice. Both copies can run at once; only the one
        that atomically creates this marker sends -> the answer goes out exactly
        ONCE. Keyed by the unique placeholder message_id, so a leftover marker
        never suppresses a later turn's fallback."""
        try:
            fd = os.open(os.path.join(pdir, f"fbsent-{sid}-{mid}.marker"),
                         os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return True
        except FileExistsError:
            return False
        except Exception:
            return True  # guard unavailable -> prefer delivering over silence

    path = os.path.join(pdir, f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        pend = None

    if not pend:
        # Nothing pending: either not a Telegram turn, or the reply was already
        # sent (PostToolUse cleared it). Drop stale markers and exit.
        try:
            os.remove(guard)
        except Exception:
            pass
        clear_replied_markers()
        # Opportunistic housekeeping of spent send-claim markers (safe here: no
        # fallback is in flight this turn, and they are keyed by message_id).
        for m in glob.glob(os.path.join(pdir, f"fbsent-{sid}-*.marker")):
            try:
                os.remove(m)
            except Exception:
                pass
        return

    tok = token(sd)
    answered = [p for p in pend if already_replied(str(p.get("chat_id")))]
    unanswered = [p for p in pend if not already_replied(str(p.get("chat_id")))]

    # Answered chats: the reply DID go out via the tool; the placeholder just
    # wasn't cleared in time (race). Delete it silently — no fallback, no dupe.
    if answered and tok:
        for p in answered:
            try:
                api(tok, "deleteMessage",
                    {"chat_id": p.get("chat_id"), "message_id": p.get("message_id")})
            except Exception as e:
                log(sd, f"[stop] answered-delete failed: {e}")

    if not unanswered:
        # Every pending chat was actually answered -> nothing to enforce.
        for f in (path, guard):
            try:
                os.remove(f)
            except Exception:
                pass
        clear_replied_markers()
        log(sd, f"[enforce] all {len(pend)} placeholder(s) already answered, "
                f"no fallback sid={sid}")
        return

    # A Telegram turn whose reply was NOT sent for the remaining chat(s).
    #
    # "First stop" vs "already nudged" must be decided ATOMICALLY, because this
    # hook can run as two concurrent copies: the installer used to key its
    # idempotency on the resolved interpreter path, so a python3 upgrade added a
    # SECOND registration of the same script (2026-08-12 incident: every Stop ran
    # /usr/bin/python3 and /usr/local/bin/python3 side by side).
    #
    # With the old exists()-then-create the twins split down two different
    # branches: copy A saw no marker, wrote it and BLOCKED (nudging the agent to
    # reply through its tool), while copy B saw the marker A had just written,
    # concluded "already nudged" and delivered the raw transcript text. The agent
    # then replied properly -> the user got the same answer twice. That is the
    # duplicate-reply bug, and it hit every un-replied Telegram turn, the morning
    # briefing included.
    #
    # O_EXCL makes exactly one copy the nudger. The loser must NOT fall through
    # to delivery: a nudge is already in flight. A marker younger than
    # TWIN_WINDOW_SEC can only belong to a twin in this same Stop (a genuine
    # post-nudge Stop is a whole agent turn later), so that is the discriminator
    # when the harness does not set stop_hook_active.
    TWIN_WINDOW_SEC = 5
    nudged = False
    if not stop_active:
        try:
            fd = os.open(guard, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            nudged = True
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(guard)
            except Exception:
                age = TWIN_WINDOW_SEC  # unreadable -> treat as a real post-nudge
            if age < TWIN_WINDOW_SEC:
                # A twin copy owns the nudge for THIS stop. Stay silent; the
                # agent is about to reply with its own tool.
                log(sd, f"[enforce] twin stop hook, nudge already in flight sid={sid}")
                return
        except Exception:
            nudged = True  # marker unavailable -> prefer nudging over silence

    if nudged:
        # First Stop with a genuinely un-replied chat -> nudge the agent to reply
        # via its own tool. Keep only the unanswered placeholder(s) pending.
        if answered:
            try:
                json.dump(unanswered, open(path, "w"))
            except Exception:
                pass
        chats = ", ".join(sorted({str(p.get("chat_id")) for p in unanswered}))
        log(sd, f"[enforce] blocking stop, no reply sent sid={sid} chats={chats}")
        print(json.dumps({"decision": "block", "reason": INSTRUCTION % chats}))
        return

    # Already nudged once (or loop guard tripped) and STILL no reply -> guaranteed
    # fallback: deliver the agent's final answer to the un-replied chat(s), clear.
    answer = last_assistant_text(transcript)
    if tok:
        # One pending entry per inbound MESSAGE, not per chat: a batched delivery
        # (several messages from one chat in one turn) leaves several entries for
        # the same chat. The answer goes to each chat (and topic) ONCE; every
        # placeholder is still deleted (FALLBACKEGYSZER1019). A failed send does
        # not count as sent, so the next entry of that chat retries it.
        #
        # `sent` is per-PROCESS, and that is the half this hook cannot rely on
        # alone: a Stop hook registered under two interpreter paths runs as two
        # copies at once, each with its own empty `sent`. claim_send is the
        # cross-process half -- an O_EXCL marker only one copy can create.
        sent = set()
        for p in unanswered:
            cid, mid = p.get("chat_id"), p.get("message_id")
            topic = topic_of(p)
            dest = (str(cid), topic.get("message_thread_id"))
            if answer and dest not in sent and claim_send(str(mid)):
                try:
                    api(tok, "sendMessage", {"chat_id": cid, "text": answer[:4000], **topic})
                    sent.add(dest)
                except Exception as e:
                    log(sd, f"[enforce] fallback send failed: {e}")
            try:
                api(tok, "deleteMessage", {"chat_id": cid, "message_id": mid})
            except Exception as e:
                log(sd, f"[stop] delete failed: {e}")
    for f in (path, guard):
        try:
            os.remove(f)
        except Exception:
            pass
    clear_replied_markers()
    log(sd, f"[enforce] fallback-delivered={bool(answer)} cleared {len(unanswered)} "
            f"placeholder(s) sid={sid}")


if __name__ == "__main__":
    main()
