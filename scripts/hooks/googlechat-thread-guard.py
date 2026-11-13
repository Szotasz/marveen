#!/usr/bin/env python3
"""Google Chat thread guard (PELENKAGCHAT1113): a reply goes into the thread of
the question it answers.

WHY A HOOK. The Google Chat plugin threads a reply only when the model passes
the inbound's thread name as `reply_to`, and it fails SILENTLY in every other
case (read from the plugin source, buglime/claude-channel-googlechat 3421b382a,
src/tools.ts handleReply and src/chat-client.ts):
  - no reply_to                     -> a new thread, no error;
  - reply_to is a MESSAGE name      -> dropped without a word (only a value with
    (the Telegram habit)               "/threads/" counts), a new thread;
  - a reply longer than the chunk   -> with the default replyToMode "first" only
    limit                              the FIRST chunk is threaded, the rest open
                                       new threads.
So the rule "answer in the thread" lived only in the plugin's instructions.

ONE SCRIPT, TWO HOOKS, told apart by hook_event_name:

  UserPromptSubmit  records, per space, which message arrived in which thread.
                    IDS ONLY: the space, the message name, the thread name and a
                    time. Never the text, never the sender.
  PreToolUse        on mcp__plugin_googlechat_googlechat__reply: BLOCKS the call
                    when its reply_to is missing, is a message name or is not a
                    thread of the space, and names the right thread in the
                    reason.

It blocks, it does not rewrite: with two open threads in one space only the
model knows which question it is answering, and a silent rewrite could send the
answer into the wrong one. A blocked call is retried by the model with the
thread the reason names.

A THREAD OF THE SPACE THAT THE RECORD DOES NOT KNOW is a different case, and the
guard does not claim to know better there. The record can miss an inbound (an
envelope shape this parser does not read, two sessions on one state dir), and
then the model's value is the right one and the record is the wrong one. So such
a call is stopped ONCE, with a reason that states only what is known (no message
recorded in that thread, the threads that are recorded) and says: if this is the
thread attribute of the message you are answering, send the same call again. The
same value on the very next call passes, and is remembered for the space
(identifier only), so the rest of a multi-part reply is not stopped again.

WHAT PASSES WITHOUT A QUESTION ASKED:
  - a space with no recorded inbound (a message the agent starts on its own);
  - a space whose recorded inbounds carried no thread (nothing to enforce);
  - the third attempt in a row: after MAX_BLOCKS consecutive blocks in a space
    the next call passes, so a wedged model can never be trapped. A new inbound
    or a passed reply resets the count. The reason does not advertise this: it
    is a backstop, not a way around the guard.
  - any error of this hook (unreadable state, bad payload): a guard on the
    reply tool must never make the channel go silent.

THE STATE is the hook's own, under the plugin's state dir
(<state dir>/thread-guard/threads.json), not the conversation ledger: the ledger
hooks are not wired on sub-agents, where Google Chat normally runs, and this
guard must work there. The state dir is the one the plugin itself reads
(GOOGLECHAT_STATE_DIR ?? ~/.claude/channels/googlechat, src/config.ts), so each
agent has its own.

NOT MEASURED LIVE: there is no Google Chat test environment. The envelope shape
and the tool name are read from the plugin source, not from a real session.
"""
import json
import os
import re
import sys
import time

SOURCE = "plugin:googlechat:googlechat"
REPLY_TOOL = "mcp__plugin_googlechat_googlechat__reply"

MAX_BLOCKS = 2            # consecutive blocks per space; the next call passes
KEEP_PER_SPACE = 40       # newest inbounds remembered per space
KEEP_SECONDS = 7 * 86400  # and none older than this
MAX_SPACES = 200
NAMED_THREADS = 3         # how many recent threads a block reason lists
KEEP_CONFIRMED = 5        # threads per space the model confirmed by repeating them
CHUNK_LIMIT = 4096        # the plugin's MAX_CHUNK_LIMIT (src/config.ts)

# A whole envelope: the opening tag, the body, the closing tag. Only whole,
# non-overlapping blocks are read, so a tag written into a message body (which
# sits INSIDE the real block) is never taken for an inbound of its own.
#
# The opening tag is read as name="value" pairs first (group 1), so a ">" inside
# a quoted value does not cut the tag short and lose the attributes after it.
# Claude Code 2.1.323 writes ">" in a value as "&gt;" (read from its binary: the
# value goes through & < > " ' escaping), so there this cannot happen; a version
# that left it raw must not make the recorder miss an inbound. A tag that is not
# made of such pairs is still read up to its first ">" (group 2), as before: an
# opening tag this parser could not read at all would hand its block to a tag
# forged in the body.
BLOCK_RX = re.compile(
    r'<channel(?:((?:\s+[A-Za-z_][A-Za-z0-9_]*="[^"]*")+)\s*|\s+([^>]*))>(.*?)</channel>', re.DOTALL)
ATTR_RX = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"')
SPACE_RX = re.compile(r'^spaces/[A-Za-z0-9_-]+$')
NAME_RX = re.compile(r'^[A-Za-z0-9_.-]+$')

TEXTS = {
    "hu": {
        "missing": "a reply_to hiányzik",
        "message": "a reply_to egy ÜZENET neve, a plugin csak SZÁL nevét fogadja el (az üzenet-azonosítót szó nélkül eldobja)",
        "not_thread": "a reply_to nem szálnév (spaces/.../threads/... alak kell)",
        "unknown": "a reply_to nem ennek a space-nek a szála",
        "unheard": "⚠️ GOOGLE CHAT VÁLASZ MEGÁLLÍTVA ({space}): a megadott szálból (reply_to=\"{thread}\") ebben a space-ben nincs feljegyzett bejövő üzenet. Az itt feljegyzett szálak: {known}. A feljegyzésből kimaradhat üzenet. Ha a megadott érték annak az üzenetnek a thread attribútuma, amelyre válaszolsz, küldd újra a hívást VÁLTOZATLANUL. Ha nem az, annak az üzenetnek a thread attribútumát add meg, amelyre válaszolsz.",
        "head": "⚠️ GOOGLE CHAT VÁLASZ MEGÁLLÍTVA ({space}): {why}. Így a válasz NEM a kérdés szálába menne, hanem új szálat nyitna.",
        "one": "Küldd újra ugyanezt a választ ezzel: reply_to=\"{thread}\" (a legutóbbi bejövő üzenet szála).",
        "known": "Küldd újra ezzel: reply_to=\"{thread}\" (annak az üzenetnek a szála, amelyet megadtál).",
        "many": "Ebben a space-ben több szálból érkezett üzenet. A legutóbbi: reply_to=\"{thread}\". A korábbiak: {others}. Azt add meg, amelyik kérdésre válaszolsz.",
        "long": "⚠️ GOOGLE CHAT VÁLASZ MEGÁLLÍTVA ({space}): a válasz {length} karakter, a plugin {limit} karakterenként darabolja, és a mostani beállítással ({mode}) csak az ELSŐ darab megy a szálba, a többi új szálat nyit. Küldd a választ több reply hívásban, mindegyik legfeljebb {limit} karakter, mindegyik ugyanazzal a reply_to értékkel. Végleges megoldás (az üzemeltető állítja be, ne te): a Google Chat plugin access.json fájljában \"replyToMode\": \"all\".",
        "off": "⚠️ GOOGLE CHAT VÁLASZ MEGÁLLÍTVA ({space}): a plugin beállítása \"replyToMode\": \"off\", ezzel SEMMILYEN válasz nem megy szálba, a reply_to értékétől függetlenül. Szólj az üzemeltetőnek: a Google Chat plugin access.json fájljában \"replyToMode\": \"all\" kell. Ezt a beállítást ne te írd át.",
    },
    "en": {
        "missing": "reply_to is missing",
        "message": "reply_to is a MESSAGE name, the plugin takes a THREAD name only (it drops a message id without a word)",
        "not_thread": "reply_to is not a thread name (it must look like spaces/.../threads/...)",
        "unknown": "reply_to is not a thread of this space",
        "unheard": "⚠️ GOOGLE CHAT REPLY STOPPED ({space}): no message recorded in this space arrived in the thread you named (reply_to=\"{thread}\"). The threads recorded here: {known}. The record can miss a message. If the value you gave is the thread attribute of the message you are answering, send the call again UNCHANGED. If it is not, use the thread attribute of the message you are answering.",
        "head": "⚠️ GOOGLE CHAT REPLY STOPPED ({space}): {why}. Sent like this, the reply would NOT land in the thread of the question, it would open a new thread.",
        "one": "Send the same reply again with: reply_to=\"{thread}\" (the thread of the latest inbound message).",
        "known": "Send it again with: reply_to=\"{thread}\" (the thread of the message you named).",
        "many": "Messages arrived in more than one thread of this space. The latest: reply_to=\"{thread}\". Earlier ones: {others}. Use the one whose question you are answering.",
        "long": "⚠️ GOOGLE CHAT REPLY STOPPED ({space}): the reply is {length} characters, the plugin splits it every {limit}, and with the current setting ({mode}) only the FIRST part goes into the thread, the rest open new threads. Send the reply in several reply calls, each at most {limit} characters, each with the same reply_to. The lasting fix (for the operator to set, not you): \"replyToMode\": \"all\" in the Google Chat plugin's access.json.",
        "off": "⚠️ GOOGLE CHAT REPLY STOPPED ({space}): the plugin is set to \"replyToMode\": \"off\", so NO reply is threaded, whatever reply_to says. Tell the operator: the Google Chat plugin's access.json needs \"replyToMode\": \"all\". Do not change that setting yourself.",
    },
}


def state_dir():
    """The Google Chat plugin's own state dir (src/config.ts): the variable when
    it is set at all ("??" keeps an empty one), else the home default."""
    d = os.environ.get("GOOGLECHAT_STATE_DIR")
    if d is not None:
        return d
    return os.path.join(os.path.expanduser("~"), ".claude", "channels", "googlechat")


def lang(sd):
    """Install language, the rule of slack_progress.py: MARVEEN_LANG, else the
    install's .lang file found by walking up from the state dir, else hu."""
    v = (os.environ.get("MARVEEN_LANG") or "").strip().lower()
    if v in TEXTS:
        return v
    d = os.path.abspath(sd)
    for _ in range(6):
        try:
            with open(os.path.join(d, ".lang"), encoding="utf-8") as fh:
                v = fh.read().strip().lower()
            if v in TEXTS:
                return v
        except Exception:
            pass
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return "hu"


def _path(sd):
    return os.path.join(sd, "thread-guard", "threads.json")


def load(sd):
    """{"spaces": {space: {"seen": [{"message", "thread", "at"}], "blocks": n}}}"""
    try:
        with open(_path(sd), encoding="utf-8") as fh:
            raw = json.load(fh)
        spaces = raw.get("spaces") if isinstance(raw, dict) else None
        if isinstance(spaces, dict):
            return {"spaces": spaces}
    except (OSError, ValueError):
        pass
    return {"spaces": {}}


def save(sd, state):
    path = _path(sd)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _seen(state, space):
    entry = state["spaces"].get(space)
    seen = entry.get("seen") if isinstance(entry, dict) else None
    if not isinstance(seen, list):
        return []
    return [e for e in seen if isinstance(e, dict) and isinstance(e.get("thread"), str)
            and isinstance(e.get("message"), str)]


def _blocks(state, space):
    entry = state["spaces"].get(space)
    n = entry.get("blocks") if isinstance(entry, dict) else 0
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else 0


def _confirmed(state, space):
    entry = state["spaces"].get(space)
    conf = entry.get("confirmed") if isinstance(entry, dict) else None
    return [t for t in conf if isinstance(t, str)] if isinstance(conf, list) else []


def _pending(state, space):
    entry = state["spaces"].get(space)
    p = entry.get("pending") if isinstance(entry, dict) else None
    return p if isinstance(p, str) else None


def _under(space, kind, name):
    """Is `name` exactly <space>/<kind>/<one segment>?"""
    prefix = "%s/%s/" % (space, kind)
    return name.startswith(prefix) and bool(NAME_RX.match(name[len(prefix):]))


def envelopes(prompt):
    """(space, message, thread) of every whole Google Chat envelope that names a
    thread. A name must sit under its own space: a thread of another space, or a
    value that is not a resource name, is not recorded."""
    out = []
    for m in BLOCK_RX.finditer(prompt):
        pairs = ATTR_RX.findall(m.group(1) or m.group(2) or "")
        attrs = dict(pairs)
        if len(attrs) != len(pairs) or attrs.get("source") != SOURCE:
            continue
        space, message, thread = attrs.get("chat_id", ""), attrs.get("message_id", ""), attrs.get("thread", "")
        if not SPACE_RX.match(space):
            continue
        if not _under(space, "messages", message) or not _under(space, "threads", thread):
            continue
        out.append((space, message, thread))
    return out


def on_prompt(payload):
    found = envelopes(payload.get("prompt") or "")
    if not found:
        return
    sd = state_dir()
    state = load(sd)
    now = int(time.time())
    for space, message, thread in found:
        seen = [e for e in _seen(state, space) if e["message"] != message]
        seen.append({"message": message, "thread": thread, "at": now})
        seen = [e for e in seen if isinstance(e.get("at"), int) and now - e["at"] <= KEEP_SECONDS]
        # a new inbound is a new question: the block count starts over
        entry = {"seen": seen[-KEEP_PER_SPACE:], "blocks": 0}
        confirmed = _confirmed(state, space)
        if confirmed:
            entry["confirmed"] = confirmed[-KEEP_CONFIRMED:]
        state["spaces"][space] = entry
    if len(state["spaces"]) > MAX_SPACES:
        newest = sorted(state["spaces"].items(),
                        key=lambda kv: max([e.get("at", 0) for e in kv[1].get("seen", [])
                                            if isinstance(e, dict) and isinstance(e.get("at"), int)] or [0]))
        state["spaces"] = dict(newest[-MAX_SPACES:])
    save(sd, state)


def _access(sd):
    try:
        with open(os.path.join(sd, "access.json"), encoding="utf-8") as fh:
            raw = json.load(fh)
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _sent_length(text, fmt):
    """The length the plugin chunks on: UTF-16 units (a JS string's .length) of
    the text AFTER its own formatting step (gchat-format.ts toGchat: in "text"
    mode, the default, each of * _ ~ ` < gains a backslash)."""
    n = len(text.encode("utf-16-le")) // 2
    if fmt is None or fmt == "text":
        n += sum(text.count(c) for c in "*_~`<")
    return n


def decide(tool_input, state, access, texts):
    """(reason or None, space, note). A None reason = the call passes. The note
    is what the caller writes into the state: ("pending", thread) for a thread of
    the space the record does not know, stopped this once; ("confirm", thread)
    when that same value came again."""
    chat_id = tool_input.get("chat_id")
    if not isinstance(chat_id, str):
        return None, None, None
    seen = _seen(state, chat_id)
    if not seen:
        return None, chat_id, None  # no inbound recorded for this space: nothing to hold the reply to
    threads = []
    for e in reversed(seen):  # newest first, each thread once
        if e["thread"] not in threads:
            threads.append(e["thread"])
    latest = threads[0]

    raw = tool_input.get("reply_to")
    reply_to = "" if raw is None else str(raw).strip()
    why = known = note = None
    if not reply_to:
        why = texts["missing"]
    elif "/messages/" in reply_to:
        why = texts["message"]
        known = next((e["thread"] for e in seen if e["message"] == reply_to), None)
    elif "/threads/" not in reply_to:
        why = texts["not_thread"]
    elif reply_to not in threads and reply_to not in _confirmed(state, chat_id):
        if not _under(chat_id, "threads", reply_to):
            why = texts["unknown"]
        elif _pending(state, chat_id) == reply_to:
            # The same value on the very next call: the model says it is the
            # inbound's own thread, and the record can be the one that is wrong.
            note = ("confirm", reply_to)
        else:
            listed = ", ".join('"%s"' % t for t in threads[:NAMED_THREADS])
            return (texts["unheard"].format(space=chat_id, thread=reply_to, known=listed),
                    chat_id, ("pending", reply_to))
    if why is not None:
        parts = [texts["head"].format(space=chat_id, why=why)]
        if known:
            parts.append(texts["known"].format(thread=known))
        elif len(threads) == 1:
            parts.append(texts["one"].format(thread=latest))
        else:
            others = ", ".join('"%s"' % t for t in threads[1:NAMED_THREADS])
            parts.append(texts["many"].format(thread=latest, others=others))
        return " ".join(parts), chat_id, None

    # The thread is right. What the plugin does with it depends on its own settings.
    mode = access.get("replyToMode")
    mode = mode if mode in ("off", "first", "all") else "first"
    if mode == "off":
        return texts["off"].format(space=chat_id), chat_id, note
    limit = access.get("textChunkLimit")
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else CHUNK_LIMIT
    limit = max(1, min(limit, CHUNK_LIMIT))
    text = tool_input.get("text")
    length = _sent_length(text if isinstance(text, str) else "", tool_input.get("format"))
    if mode != "all" and length > limit:
        return texts["long"].format(space=chat_id, length=length, limit=limit,
                                    mode='"replyToMode": "%s"' % mode), chat_id, note
    return None, chat_id, note


def on_reply(payload):
    if payload.get("tool_name") != REPLY_TOOL:
        return None
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    sd = state_dir()
    state = load(sd)
    texts = TEXTS[lang(sd)]
    reason, space, note = decide(tool_input, state, _access(sd), texts)
    if space is None or not isinstance(state["spaces"].get(space), dict):
        return None
    entry = state["spaces"][space]
    blocks = _blocks(state, space)
    # "the very next call" only: whatever this call is, the earlier pending value is spent
    changed = entry.pop("pending", None) is not None
    if note and note[0] == "confirm":
        entry["confirmed"] = ([t for t in _confirmed(state, space) if t != note[1]] + [note[1]])[-KEEP_CONFIRMED:]
        changed = True
    if reason is None:
        if blocks:
            entry["blocks"] = 0
            changed = True
        if changed:
            save(sd, state)
        return None
    if blocks >= MAX_BLOCKS:
        # the backstop: let this one through, and start counting again
        entry["blocks"] = 0
        save(sd, state)
        return None
    entry["blocks"] = blocks + 1
    if note and note[0] == "pending":
        entry["pending"] = note[1]
    save(sd, state)
    return reason


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        on_prompt(payload)
    elif event == "PreToolUse":
        reason = on_reply(payload)
        if reason:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-open: a guard on the reply tool must never silence the channel
    sys.exit(0)
