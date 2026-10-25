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
import sys, os, json, glob, urllib.request

# #2269: the CLI writes its OWN lines into the transcript as assistant messages (the session-limit
# wall "You've hit your session limit · resets 12am (UTC)", the usage limit, an API error); the guaranteed fallback below
# must never send such a line as the agent's answer (the progress watchdog did, before #2269). The
# markers are the watchdog's: isApiErrorMessage, the model "<synthetic>", or a known prefix. Instead the placeholder says
# the answer is late (OUTAGE_TEXT) and stays; no ledger row, so the open question stays open for the next session.
# #2269: only a limit or error line is an outage; another CLI-written line ("No response
# requested.") means the turn has no answer, and it takes the no-answer path: the placeholder goes, nothing is sent.
SYNTHETIC_MODEL = "<synthetic>"
SYNTHETIC_PREFIXES = (
    "you've hit your session limit", "you've hit your usage limit", "you've hit your weekly limit",
    "usage limit reached", "claude ai usage limit reached", "api error", "credit balance is too low",
    "invalid api key", "please run /login",
)
OUTAGE_TEXT = "⏳ A válasz egy átmeneti kiesés miatt késik."
# #2269: a real fallback send goes into the conversation ledger (direction out), marked in the TEXT like the other
# machine rows, not in the source column (ledger_lib.source_for() reads the newest source in any direction, and the reply
# guard names the reply tool from it).
LEDGER_PREFIX = "[telegram-progress-clear, fallback]"

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
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
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


def api(tok, method, payload):
    # Base is overridable (TELEGRAM_API_BASE) so tests can point it at a local
    # stub; defaults to the real Bot API, so production is unchanged.
    base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    url = f"{base}/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def topic_of(entry):
    """The topic the placeholder was posted into (TELEGRAM_TOPICS_ENABLED), as
    sendMessage parameters; empty for a plain chat, so the payload stays as is."""
    t = entry.get("message_thread_id")
    return {"message_thread_id": t} if isinstance(t, int) and t > 0 else {}


def _synthetic_kind(ev, text):
    """What an assistant text is (#2269): "" the agent's own; "outage" a CLI limit or error line
    (isApiErrorMessage, or a known prefix on an event that names no model or the model "<synthetic>"); "none" any other
    CLI-written line, i.e. no answer. A real answer carries its model id and may itself begin with "API error"."""
    msg = ev.get("message") or {}
    model = msg.get("model")
    if ev.get("isApiErrorMessage") is True:
        return "outage"
    if model and model != SYNTHETIC_MODEL:
        return ""
    if (text or "").strip().lower().startswith(SYNTHETIC_PREFIXES):
        return "outage"
    return "none" if model == SYNTHETIC_MODEL else ""


def last_assistant_text(transcript_path):
    """Return the last non-empty assistant text message from the JSONL transcript
    (the agent's final user-facing answer). Empty string if none / unreadable."""
    return last_assistant(transcript_path)[0]


def last_assistant(transcript_path):
    """(text, synthetic): the last non-empty assistant text, and whether it is a CLI limit or error line (#2269); any
    other CLI-written last line comes back as ("", False): the turn has no answer (#2269)."""
    text = ""
    kind = ""
    if not transcript_path:
        return text, False
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
                    kind = _synthetic_kind(ev, t)
    except Exception:
        pass
    if kind == "none":
        return "", False
    return text, kind == "outage"


def _ledger_lib():
    """#2269: the install's ledger_lib, loaded by file path: next to this file (the repo copy, beside
    ledger-outbound.py), else under MARVEEN_ROOT, CLAUDE_PROJECT_DIR or ~/marveen (the legacy ~/.claude/hooks copy has
    none of its own). Its own location fixes the install, so db_path() is that install's ledger. None when not found."""
    import importlib.util
    dirs = [os.path.dirname(os.path.abspath(__file__))]
    for root in (os.environ.get("MARVEEN_ROOT"), os.environ.get("CLAUDE_PROJECT_DIR"), os.path.expanduser("~/marveen")):
        if root:
            dirs.append(os.path.join(root, "scripts", "hooks"))
    for d in dirs:
        p = os.path.join(d, "ledger_lib.py")
        if os.path.isfile(p):
            spec = importlib.util.spec_from_file_location("ledger_lib", p)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    return None


def ledger_log_out(sd, ev, chat_id, text, result):
    """#2269: one conversation_log row (direction out) for a fallback message that really went out, through ledger_lib,
    under the session identity the reply tool's own row gets (agent_id_from_payload: the transcript path, not the mutable
    cwd, LEDGERCWD828). Writes only into an EXISTING ledger. Called only after the pending state is removed, and it
    swallows EVERYTHING, SystemExit included: a ledger step that ended this hook before the cleanup (an exit, or the
    15 s hook limit spent waiting on a locked ledger) would leave the pending state for the next Stop to send again
    (#2269)."""
    try:
        lib = _ledger_lib()
        if lib is None:
            log(sd, "[enforce] ledger: no ledger_lib found, fallback send not logged")
            return False
        db = lib.db_path()
        if not os.path.isfile(db):
            log(sd, f"[enforce] ledger: no database at {db}, fallback send not logged")
            return False
        res = result.get("result") if isinstance(result, dict) else None
        mid = res.get("message_id") if isinstance(res, dict) else None
        lib.log_outbound(lib.agent_id_from_payload(ev), chat_id, LEDGER_PREFIX + " " + text, mid)
        return True
    except BaseException as e:
        log(sd, f"[enforce] ledger write failed: {type(e).__name__}: {e}")
        return False


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

    path = os.path.join(pdir, f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        pend = None

    if not pend:
        # Nothing pending: either not a Telegram turn, or the reply was already
        # sent (PostToolUse cleared it). Drop any stale enforce marker and exit.
        try:
            os.remove(guard)
        except Exception:
            pass
        return

    # A Telegram turn whose reply was NOT sent for the listed chat(s).
    blocked_before = os.path.exists(guard)
    if not stop_active and not blocked_before:
        # First Stop with an un-replied Telegram turn -> nudge the agent to reply
        # properly via its own tool. Keep the placeholder so the re-entry path
        # (PostToolUse) clears it when the reply finally goes out.
        try:
            open(guard, "w").close()
        except Exception:
            pass
        chats = ", ".join(sorted({str(p.get("chat_id")) for p in pend}))
        log(sd, f"[enforce] blocking stop, no reply sent sid={sid} chats={chats}")
        print(json.dumps({"decision": "block", "reason": INSTRUCTION % chats}))
        return

    # Already nudged once (or loop guard tripped) and STILL no reply -> guaranteed
    # fallback: deliver the agent's final answer to the chat, then clear.
    answer, synthetic = last_assistant(transcript)
    tok = token(sd)
    sent = []
    if tok:
        # One pending entry per inbound MESSAGE, not per chat: a batched delivery
        # (several messages from one chat in one turn) leaves several entries for
        # the same chat. The answer goes to each chat (and topic) ONCE; every
        # placeholder is still deleted (FALLBACKEGYSZER1019). A failed send does
        # not count as sent, so the next entry of that chat retries it.
        sent_to = set()
        for p in pend:
            cid, mid = p.get("chat_id"), p.get("message_id")
            topic = topic_of(p)
            dest = (str(cid), topic.get("message_thread_id"))
            if answer and synthetic:
                # #2269: the turn ended on a CLI line, not an answer: the placeholder says the answer is late and stays.
                try:
                    api(tok, "editMessageText", {"chat_id": cid, "message_id": mid, "text": OUTAGE_TEXT})
                except Exception as e:
                    log(sd, f"[enforce] outage edit failed: {e}")
                continue
            if answer and dest not in sent_to:
                try:
                    res = api(tok, "sendMessage", {"chat_id": cid, "text": answer[:4000], **topic})
                    sent_to.add(dest)
                    sent.append((cid, answer[:4000], res))
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
    log(sd, f"[enforce] fallback-delivered={bool(answer) and not synthetic} synthetic={synthetic} "
            f"cleared {len(pend)} placeholder(s) sid={sid}")
    # #2269: the ledger rows only now, with the pending state gone (see ledger_log_out).
    for cid, text, res in sent:
        ledger_log_out(sd, ev, cid, text, res)


if __name__ == "__main__":
    main()
