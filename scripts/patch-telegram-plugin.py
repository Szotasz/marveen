#!/usr/bin/env python3
"""
Take /status and /help away from the Telegram channel plugin (ELSOKOR922 D-4),
mark forwarded messages in the inbound meta (forwarded="1"), record every
inbound message the bot receives (the evidence owner WRITE commands need),
hand the email-approval buttons (apv:*) to the repo's callback block (see
APV_MARKER), and -- only while TELEGRAM_TOPICS_ENABLED is on -- carry the topic of a
message in and the answer back into it (see TOPICS_STEPS).

The official plugin (claude-plugins-official/telegram/<ver>/server.ts) answers
/status ("Paired as ...") and /help itself, inside its bot poller -- those
messages never reach the session, so Marveen's command hook
(scripts/hooks/marveen-commands.py) cannot answer them. This script removes
the two handlers (and the plugin's own command menu, which would advertise
them with the plugin's meaning), leaving /start and everything else intact.
Without the handlers the two words arrive as ordinary text messages, exactly
like /usage does today, and the hook takes them.

Runs at every channel start (scripts/channels.sh), before the plugin is
spawned, over every cached plugin version in ONE cache: the one this install
launches from ($CLAUDE_CONFIG_DIR/plugins/cache, or ~/.claude/plugins/cache
when the variable is unset). Never both: an install with its own config dir
must not rewrite the user-level cache other Claude Code sessions load
(maintainer review on #1529, 2026-09-25).

- idempotent: a file carrying the marker is left alone;
- all-or-nothing per patch: if ANY anchor of a patch is missing (a plugin
  update changed the code), that patch is left out and one loud line says so
  -- /status and /help then fall back to the plugin's own answers, or a
  forwarded command is not refused; the channel itself is not touched;
- always exits 0: a failed patch must never stop the channel from starting
  (the one exception is a --topics value other than on or off: exit 2, nothing
  patched; channels.sh never passes --topics);
- the reply-keyboard patch (c67f5f34) inserts WHOLE LINES only, each carrying
  its marker, so taking it back is deleting the lines that carry
  "MARVEEN-PATCH(c67f5f34-kbd)" (the file is then byte-identical to the one
  patched without it; tested);
- the approval-button patch is one marked BEGIN..END block, one
  marked env-snapshot line right after END and one marked call line; deleting
  those gives back the file patched without it;
- with --state FILE, the outcome per file (and per patch) is written there as
  JSON, so /status can say in one line when a patch is missing
  (src/web/system-status.ts) instead of the command silently falling back.

Usage: patch-telegram-plugin.py [--state FILE] [--topics on|off] [<plugins cache root>]
(default root: $CLAUDE_CONFIG_DIR/plugins/cache, else ~/.claude/plugins/cache;
without --topics the TELEGRAM_TOPICS_ENABLED setting of this install decides)
"""
import hashlib
import json
import os
import re
import sys
import time

MARKER = "// MARVEEN-PATCH(elsokor922-d4): /status and /help belong to the command hook"
FWD_MARKER = "// MARVEEN-PATCH(elsokor922-fwd): forwarded flag for the command hook"
EVID_MARKER = "// MARVEEN-PATCH(cmd920-evid): inbound evidence for owner write commands"
KBD_MARKER = "// MARVEEN-PATCH(c67f5f34-kbd): one-tap answer buttons"

# Each anchor is the handler's full block, up to its closing `})` at column 0.
ANCHORS = [
    ("help handler", re.compile(r"^bot\.command\('help', async ctx => \{\n.*?^\}\)\n", re.DOTALL | re.MULTILINE)),
    ("status handler", re.compile(r"^bot\.command\('status', async ctx => \{\n.*?^\}\)\n", re.DOTALL | re.MULTILINE)),
    ("setMyCommands menu", re.compile(r"^( *)void bot\.api\.setMyCommands\(\n.*?\n\1\)\.catch\(\(\) => \{\}\)\n", re.DOTALL | re.MULTILINE)),
]

# The inbound meta says nothing about forwarding, so a forwarded message that
# carries a command is byte-identical to one the owner typed (measured on the
# test bot, 2026-09-23: a forwarded /status ran). One meta key more, right
# after user_id, and the hook refuses to run a forwarded command.
FWD_ANCHOR = ("inbound meta user_id", re.compile(r"^( *)user_id: String\(from\.id\),\n", re.MULTILINE))

# Owner WRITE commands (/model, /context clear, ...) run only when the message
# they came in is on record HERE, in the plugin process, the one place that
# only a real Telegram update reaches (#1530 review: the dashboard token is
# shared by every fleet agent, and the prompt text is not evidence -- anything
# typed into the session pane can carry a <channel> block). One JSON line per
# inbound message into <STATE_DIR>/inbound-evidence.jsonl, written just before
# the message is handed to Claude Code; the dashboard reads it
# (src/web/write-evidence.ts). Bounded: past 256 KiB the file becomes .1.
# Uses only names server.ts already imports (writeFileSync, statSync,
# renameSync, join) and the handler's own chat_id / msgId / text.
EVID_ANCHOR = ("channel notification", re.compile(
    r"^( *)mcp\.notification\(\{\n *method: 'notifications/claude/channel',\n", re.MULTILINE))
EVID_INSERT = (
    "{indent}try {{ const evidFile = join(STATE_DIR, 'inbound-evidence.jsonl'); "
    "try {{ if (statSync(evidFile).size > 262144) renameSync(evidFile, evidFile + '.1') }} catch {{}}; "
    "writeFileSync(evidFile, JSON.stringify({{ chat_id, message_id: msgId != null ? String(msgId) : null, "
    "text, at: Date.now() }}) + '\\n', {{ flag: 'a', mode: 0o600 }}) }} catch {{}} " + EVID_MARKER + "\n"
)

# The staff are asked one question at a time, with lettered options (A/B/C),
# and today they type the letter back (c67f5f34, owner request). The reply
# tool can send no button: its schema has no such field and the send passes
# only reply_parameters and parse_mode. A reply keyboard needs nothing on the
# inbound side: a tapped text-only button arrives as the user's ordinary text
# message, through the same gate, evidence log and channel notification as a
# typed letter. So three lines, all in the reply tool: an optional `buttons`
# list in the schema (after `files`), its check before anything is sent (the
# tool-call handler turns the throw into a tool error), and the keyboard on
# the LAST text chunk (an empty list removes a keyboard shown earlier). The
# labels are outgoing text: the copy gate (scripts/hooks/outgoing-copy-gate.py)
# audits them together with `text`.
KBD_SCHEMA = ("reply schema files property", re.compile(
    r"^ *description: 'Absolute file paths to attach\. [^\n]*',\n( *)\},\n", re.MULTILINE), "insert-after",
    "{indent}buttons: {{ type: 'array', items: {{ type: 'string' }}, description: 'Optional one-tap answer buttons, "
    "shown as a keyboard under the input field and hidden after one tap; the tapped label comes back as an ordinary "
    "text message from the user. Also write the options into text, so the question can be answered by typing. An "
    "empty list removes a keyboard shown earlier. At most 12 labels, each non-empty and at most 64 characters.' }}, "
    + KBD_MARKER + "\n")
KBD_CHECK = ("reply chat check", re.compile(r"^( *)assertAllowedChat\(chat_id\)\n", re.MULTILINE), "insert-after",
    "{indent}const kbdButtons = args.buttons == null ? undefined : Array.isArray(args.buttons) && args.buttons.length <= 12 "
    "&& args.buttons.every(b => typeof b === 'string' && b.trim() !== '' && b.length <= 64) ? (args.buttons as string[]) "
    ": (() => {{ throw new Error('buttons: a list of at most 12 non-empty labels, each at most 64 characters') }})() "
    + KBD_MARKER + "\n")
KBD_SEND = ("reply send options", re.compile(
    r"^( *)\.\.\.\(parseMode \? \{ parse_mode: parseMode \} : \{\}\),\n",
    re.MULTILINE), "insert-after",
    "{indent}...(kbdButtons && i === chunks.length - 1 ? {{ reply_markup: kbdButtons.length ? {{ keyboard: "
    "kbdButtons.map(label => [{{ text: label }}]), one_time_keyboard: true, resize_keyboard: true }} : "
    "{{ remove_keyboard: true as const }} }} : {{}}), " + KBD_MARKER + "\n")

# Email-approval buttons: the plugin's callback_query handler only
# knows perm:*, and answers every other press with an empty toast. The handler
# for the apv:* buttons the dashboard puts under an approval notice lives in
# the repo, as an import-free TS module with its own tests
# (src/telegram-plugin-patches/approval-callback.ts); this patch copies it in.
# Two edits, all-or-nothing together:
#  - the module, its line-leading `export ` cut, between a BEGIN line (carrying
#    the sha256 of the module source) and an END line, right before the
#    callback_query handler;
#  - one call line as the handler's first branch, right before its perm: regex,
#    so an apv: press never reaches the perm: branch (or the model), and every
#    other press runs exactly as before.
# The block uses only what server.ts already has (readFileSync from the fs
# import, STATE_DIR, loadAccess, the global fetch, process.env for the proxy
# check); those are checked, not assumed. The module may not name `process`
# (APV_DENY), so its proxy check gets the environment from two patcher lines:
# the call line passes process.env as it is now, and a snapshot line right after
# END copies process.env once, when the plugin loads (after its .env loader):
# bun keeps proxying after a variable is deleted from process.env at runtime
# (measured on 1.4.2), so the current env alone could miss a proxy.
# Every run rebuilds the patch from the module source and compares it with what
# the file holds, so a changed source OR a hand-edited block or line (even under
# a matching sha label) is replaced.
# Taking it back: delete the lines from BEGIN to END, the snapshot line and the
# call line (the file is then byte-identical to the one patched without it;
# tested).
APV_MARKER = "// MARVEEN-PATCH(apv-buttons)"
APV_SOURCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "src", "telegram-plugin-patches", "approval-callback.ts")
APV_BEGIN_RX = re.compile(r"^" + re.escape(APV_MARKER) + r" BEGIN src-sha256:([0-9a-f]{16})\n", re.MULTILINE)
APV_END_RX = re.compile(r"^" + re.escape(APV_MARKER) + r" END\n", re.MULTILINE)
APV_CALL_RX = re.compile(r"^ *if \(data\.startsWith\('apv:'\)\) \{[^\n]* " + re.escape(APV_MARKER) + r"\n", re.MULTILINE)
APV_SNAP_RX = re.compile(r"^const MARVEEN_APV_ENV_AT_LOAD = [^\n]* " + re.escape(APV_MARKER) + r"\n", re.MULTILINE)
APV_HANDLER = ("callback_query handler", re.compile(r"^bot\.on\('callback_query:data', async ctx => \{\n", re.MULTILINE))
APV_PERM = ("perm regex", re.compile(
    r"^( *)const m = /\^perm:\(allow\|deny\|more\):\(\[a-km-z\]\{5\}\)\$/\.exec\(data\)\n", re.MULTILINE))
# The call line runs with the handler's `ctx` and `data`: only this one line may
# stand between the handler's opening and the perm: regex.
APV_DATA_LINE = re.compile(r" *const data = ctx\.callbackQuery\.data\n")
APV_NAMES = [
    ("fs readFileSync import", re.compile(r"^import \{[^}\n]*\breadFileSync\b[^}\n]*\} from 'fs'\n", re.MULTILINE)),
    ("STATE_DIR", re.compile(r"^const STATE_DIR = ", re.MULTILINE)),
    ("loadAccess", re.compile(r"^function loadAccess\(\)", re.MULTILINE)),
]
# Every top-level name of the module starts with one of these (its own rule).
APV_OWN_NAMES = re.compile(r"marveenApprovalCallback|marveenApv|MarveenApv|MARVEEN_APV")
# The block is inlined into the plugin process next to the bot token: a source
# naming any of these is not copied in (the same list the module's own test
# holds, src/__tests__/approval-callback-plugin.test.ts). Checked over the
# whole source, comments included.
APV_DENY = [
    ("import", re.compile(r"\bimport\b")),
    ("require", re.compile(r"\brequire\b")),
    ("mcp", re.compile(r"mcp", re.IGNORECASE)),
    ("notification", re.compile(r"notification", re.IGNORECASE)),
    ("console", re.compile(r"console\.")),
    ("process", re.compile(r"\bprocess\b")),
    ("eval", re.compile(r"\beval\b")),
    ("Function", re.compile(r"\bFunction\b")),
    ("Bun", re.compile(r"\bBun\b")),
    ("child process", re.compile(r"child_process|\bexecFile|\bexecSync|\bspawn")),
    ("globalThis", re.compile(r"globalThis")),
]
# A line at column 0 of the block is a comment, a closing bracket, or a
# declaration of a prefixed name; anything else (a destructuring, a bare
# statement, `const STATE_DIR = ...`, which would stop bun from loading the
# plugin at all) makes the source unusable.
APV_TOP_LEVEL_OK = re.compile(r"^(//|/\*|\*/|[}\])])")
APV_TOP_LEVEL_DECL = re.compile(
    r"^(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+"
    r"(?:marveenApprovalCallback\b|marveenApv\w|MarveenApv\w|MARVEEN_APV_\w)")
APV_CALL = ("if (data.startsWith('apv:')) { await marveenApprovalCallback(ctx, data, "
            "{ stateDir: STATE_DIR, readFileSync, fetch, loadAccess, env: process.env, envAtLoad: MARVEEN_APV_ENV_AT_LOAD }); "
            "return } " + APV_MARKER + "\n")
APV_SNAP = "const MARVEEN_APV_ENV_AT_LOAD = { ...process.env } " + APV_MARKER + "\n"

_apv_source_cache = {}


def apv_source(path=None):
    """(block, sha16) to insert, or (None, why). The module must name nothing
    on APV_DENY, declare only prefixed top-level names, and carry no marker of
    its own."""
    path = path or APV_SOURCE
    if path in _apv_source_cache:
        return _apv_source_cache[path]
    try:
        with open(path, "rb") as f:
            raw = f.read()
        src = raw.decode("utf-8")
    except FileNotFoundError:
        res = (None, "missing")
    except Exception as e:
        res = (None, f"unreadable ({type(e).__name__})")
    else:
        block = re.sub(r"^export ", "", src, flags=re.MULTILINE)
        if not block.endswith("\n"):
            block += "\n"
        denied = next((name for name, rx in APV_DENY if rx.search(block)), None)
        top = next((ln for ln in block.split("\n") if ln and not ln[0].isspace()
                    and not APV_TOP_LEVEL_OK.match(ln) and not APV_TOP_LEVEL_DECL.match(ln)), None)
        if denied:
            res = (None, f"denied {denied}")
        elif "MARVEEN-PATCH" in block or "\r" in block:
            res = (None, "marker or CR in the source")
        elif re.search(r"^\s*export\b", block, re.MULTILINE) or re.search(
                r"^export (?!(async function|function|const|let|interface|type|class) )", src, re.MULTILINE):
            res = (None, "export form")
        elif len(re.findall(r"^async function marveenApprovalCallback\(", block, re.MULTILINE)) != 1:
            res = (None, "no marveenApprovalCallback")
        elif top is not None:
            res = (None, "top-level name")
        else:
            res = (block, hashlib.sha256(raw).hexdigest()[:16])
    _apv_source_cache[path] = res
    return res


def strip_apv(text):
    """(text without the apv patch, sha16 label of the block it had) -- or
    (text, None) when it has none -- or (None, why) when the marked lines are not
    one intact block, at most one snapshot line and one call line (then nothing
    is touched). A missing snapshot line (a file patched before it existed, or a
    hand edit) is not damage: the rebuild puts it back."""
    if APV_MARKER not in text:
        return text, None
    begins = list(APV_BEGIN_RX.finditer(text))
    ends = list(APV_END_RX.finditer(text))
    calls = list(APV_CALL_RX.finditer(text))
    snaps = list(APV_SNAP_RX.finditer(text))
    if (len(begins), len(ends), len(calls)) != (1, 1, 1) or len(snaps) > 1 \
            or text.count(APV_MARKER) != 3 + len(snaps) or ends[0].start() < begins[0].end():
        return None, "apv markers"
    b, e = begins[0], ends[0]
    lines = [(m.start(), m.end()) for m in calls + snaps]
    if any(b.start() <= start < e.end() for start, _ in lines):
        return None, "apv markers"
    cut = sorted([(b.start(), e.end())] + lines)
    out, at = [], 0
    for start, end in cut:
        out.append(text[at:start])
        at = end
    out.append(text[at:])
    return "".join(out), b.group(1)


def apply_apv(text, source=None):
    """Returns (new_text, status), all-or-nothing like apply_patch. status:
    'patched' (inserted, or a stale or hand-edited block replaced) | 'already' |
    'anchor-missing:<name>' | 'source-unusable:<why>' | 'damaged:<why>' | 'conflict:apv names'.
    'already' only when the file holds exactly the patch built from the source now."""
    base, had = strip_apv(text)
    if base is None:
        return text, f"damaged:{had}"
    block, sha = apv_source(source)
    if block is None:
        # A block already in place keeps working; it is only not refreshed.
        return text, f"source-unusable:{sha}"
    if APV_OWN_NAMES.search(base):
        return text, "conflict:apv names"
    for name, rx in APV_NAMES:
        if len(rx.findall(base)) != 1:
            return text, f"anchor-missing:{name}"
    handler = list(APV_HANDLER[1].finditer(base))
    if len(handler) != 1:
        return text, f"anchor-missing:{APV_HANDLER[0]}"
    perm = list(APV_PERM[1].finditer(base))
    if len(perm) != 1:
        return text, f"anchor-missing:{APV_PERM[0]}"
    h, m = handler[0], perm[0]
    if m.start() < h.end() or not APV_DATA_LINE.fullmatch(base, h.end(), m.start()):
        return text, "anchor-missing:callback data line"
    out = base[:m.start()] + m.group(1) + APV_CALL + base[m.start():]
    begin = f"{APV_MARKER} BEGIN src-sha256:{sha}\n"
    out = out[:h.start()] + begin + block + f"{APV_MARKER} END\n" + APV_SNAP + out[h.start():]
    if out == text:
        return text, "already"
    if had == sha:
        log(f"LOUD: the apv block or a marked apv line differs from its source under a matching label "
            f"(src-sha256:{sha}, edited by hand?) -- replaced")
    return out, "patched"


# Independent patches: each has its own marker and is all-or-nothing on its
# own, so a plugin update that moves one anchor does not undo the other.
PATCHES = [
    {"name": "d4", "marker": MARKER, "anchors": ANCHORS, "mode": "remove",
     "fallback": "/status and /help fall back to the plugin's own answers"},
    {"name": "fwd", "marker": FWD_MARKER, "anchors": [FWD_ANCHOR], "mode": "insert-after",
     "insert": "{indent}...(ctx.message?.forward_origin ? {{ forwarded: '1' }} : {{}}), " + FWD_MARKER + "\n",
     "fallback": "forwarded messages are not marked, a forwarded command runs like a typed one"},
    {"name": "evid", "marker": EVID_MARKER, "anchors": [EVID_ANCHOR], "mode": "insert-before",
     "insert": EVID_INSERT,
     "fallback": "no inbound evidence is recorded, owner write commands are refused"},
    # an anchor may carry its own mode and insert (name, regex, mode, insert): the three kbd lines differ
    {"name": "kbd", "marker": KBD_MARKER, "anchors": [KBD_SCHEMA, KBD_CHECK, KBD_SEND], "mode": "insert-after",
     "fallback": "the reply tool has no buttons: a question goes out without them and is answered by typing"},
    # its own apply (block + call line, refreshed when the module source changes)
    {"name": "apv", "marker": APV_MARKER, "apply": apply_apv,
     "fallback": "the email-approval buttons do nothing, approvals are decided on the dashboard"},
]

# Topics (TELEGRAM_TOPICS_ENABLED, default off). A private chat with topic mode
# enabled in BotFather, or a forum, delivers each message with the topic it was
# written in -- but the plugin drops that id from the inbound meta and its reply
# tool cannot address a topic, so every answer lands outside the topic. This
# patch carries message_thread_id in (meta, only for a real topic message) and
# back out (reply text chunks, attached files, the typing indicator).
#
# Unlike the patches above it is switchable, so it must also come OFF again:
# every line it adds ends with TOPICS_TAG, and every line it replaces is kept
# verbatim behind TOPICS_ORIG at column 0. Removing all TOPICS_TAG lines and
# the TOPICS_ORIG prefixes gives back the unpatched text byte for byte.
# Without a topic every changed call gets exactly the arguments it gets today.
TOPICS_TAG = "// MARVEEN-PATCH(tgtopics)"
TOPICS_ORIG = "// MARVEEN-PATCH(tgtopics-orig) "
TOPICS_SETTING = "TELEGRAM_TOPICS_ENABLED"
# The values src/config.ts reads as on; the Settings page itself writes "1".
TRUTHY = ("1", "true", "yes", "on")
# What JavaScript's String.prototype.trim() removes. Python's own strip() set
# differs both ways: it keeps U+FEFF (a BOM) and removes U+001C-U+001F and U+0085.
JS_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

_INBOUND_THREAD = "ctx.message?.is_topic_message && ctx.message.message_thread_id != null"
TOPICS_STEPS = [
    ("inbound meta ts", "insert-after",
     re.compile(r"^( *)ts: new Date\(\(ctx\.message\?\.date \?\? 0\) \* 1000\)\.toISOString\(\),\n", re.MULTILINE),
     ["...(" + _INBOUND_THREAD + " ? { message_thread_id: String(ctx.message.message_thread_id) } : {}),"]),
    ("typing indicator", "replace",
     re.compile(r"^( *)void bot\.api\.sendChatAction\(chat_id, 'typing'\)\.catch\(\(\) => \{\}\)\n", re.MULTILINE),
     ["void bot.api.sendChatAction(chat_id, 'typing', ...(" + _INBOUND_THREAD
      + " ? [{ message_thread_id: ctx.message.message_thread_id }] : [])).catch(() => {})"]),
    ("instructions inbound tag", "insert-after",
     re.compile(r"^( *)'Messages from Telegram arrive as <channel source=\"telegram\" [^\n]*\n", re.MULTILINE),
     ["'In a topic (a private chat with topics enabled, or a forum) the tag also has message_thread_id: "
      "pass it back to reply as message_thread_id, so the answer lands in the same topic.',"]),
    ("reply schema files", "insert-before",
     re.compile(r"^( *)files: \{\n *type: 'array',\n *items: \{ type: 'string' \},\n *description: 'Absolute file paths",
                re.MULTILINE),
     ["message_thread_id: {",
      "  type: 'string',",
      "  description: 'Topic to post into. Pass message_thread_id from the inbound <channel> block when it has one; omit it otherwise.',",
      "},"]),
    ("reply args", "insert-after",
     re.compile(r"^( *)const reply_to = args\.reply_to != null \? Number\(args\.reply_to\) : undefined\n", re.MULTILINE),
     ["const message_thread_id = args.message_thread_id != null && args.message_thread_id !== '' ? Number(args.message_thread_id) : undefined",
      "if (message_thread_id !== undefined && !(Number.isSafeInteger(message_thread_id) && message_thread_id > 0)) "
      "throw new Error(`invalid message_thread_id: ${String(args.message_thread_id)}`)"]),
    ("reply text options", "insert-after",
     re.compile(r"^( *)\.\.\.\(shouldReplyTo \? \{ reply_parameters: \{ message_id: reply_to \} \} : \{\}\),\n", re.MULTILINE),
     ["...(message_thread_id != null ? { message_thread_id } : {}),"]),
    ("reply file options", "replace",
     re.compile(r"^( *)const opts = reply_to != null && replyMode !== 'off'\n *\? \{ reply_parameters: \{ message_id: reply_to \} \}\n *: undefined\n",
                re.MULTILINE),
     ["const replyOpts = reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : undefined",
      "const opts = message_thread_id != null ? { ...replyOpts, message_thread_id } : replyOpts"]),
]
TOPICS_FALLBACK = "replies and the typing indicator land outside the topic the message came from"


def log(msg):
    sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} patch-telegram-plugin: {msg}\n")


def apply_patch(text, patch):
    """Returns (new_text, status). status: 'patched' | 'already' | 'anchor-missing:<name>'."""
    if patch["marker"] in text:
        return text, "already"
    out = text
    for anchor in patch["anchors"]:
        name, rx = anchor[0], anchor[1]
        mode = anchor[2] if len(anchor) > 2 else patch["mode"]
        insert = anchor[3] if len(anchor) > 3 else patch.get("insert", "")
        found = list(rx.finditer(out))
        if len(found) != 1:
            return text, f"anchor-missing:{name}"
        m = found[0]
        indent = m.group(1) if rx.groups else ""
        if mode == "remove":
            out = out[:m.start()] + f"{indent}{patch['marker']} ({name} removed)\n" + out[m.end():]
        elif mode == "insert-before":
            out = out[:m.start()] + insert.format(indent=indent) + out[m.start():]
        else:
            out = out[:m.end()] + insert.format(indent=indent) + out[m.end():]
    return out, "patched"


def apply_topics(text):
    """Returns (new_text, status), all-or-nothing like apply_patch."""
    if TOPICS_TAG in text:
        return text, "already"
    out = text
    for name, mode, rx, lines in TOPICS_STEPS:
        found = list(rx.finditer(out))
        if len(found) != 1:
            return text, f"anchor-missing:{name}"
        m = found[0]
        indent = m.group(1)
        added = "".join(f"{indent}{line} {TOPICS_TAG}\n" for line in lines)
        if mode == "insert-before":
            out = out[:m.start()] + added + out[m.start():]
        elif mode == "insert-after":
            out = out[:m.end()] + added + out[m.end():]
        else:
            kept = "".join(TOPICS_ORIG + line for line in m.group(0).splitlines(keepends=True))
            out = out[:m.start()] + kept + added + out[m.end():]
    return out, "patched"


def remove_topics(text):
    """Returns (new_text, 'removed'), or (text, None) when the patch is not there."""
    if TOPICS_TAG not in text and TOPICS_ORIG not in text:
        return text, None
    out = []
    for line in text.splitlines(keepends=True):
        if line.rstrip("\n").endswith(" " + TOPICS_TAG):
            continue
        out.append(line[len(TOPICS_ORIG):] if line.startswith(TOPICS_ORIG) else line)
    return "".join(out), "removed"


TOPICS_PATCH = {"name": "topics", "fallback": TOPICS_FALLBACK}


def patch_text(text, topics=False):
    """Returns (new_text, [(patch, status), ...]). The topics entry is there
    when the switch is on, or when switching it off took the patch out."""
    results = []
    for patch in PATCHES:
        text, status = patch["apply"](text) if "apply" in patch else apply_patch(text, patch)
        results.append((patch, status))
    if topics:
        text, status = apply_topics(text)
        results.append((TOPICS_PATCH, status))
    else:
        text, status = remove_topics(text)
        if status:
            results.append((TOPICS_PATCH, status))
    return text, results


def file_status(results):
    """One word for the file: 'already' when every patch was there,
    'patched' when this run wrote (or took out) one, else the first failure
    (anchor-missing:..., or one of the apv patch's own)."""
    statuses = [st for _, st in results]
    if "patched" in statuses or "removed" in statuses:
        return "patched"
    return next((st for st in statuses if st != "already"), "already")


def patch_file(path, topics=False):
    """Returns (file status, {patch name: status})."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception as e:
        log(f"cannot read {path}: {type(e).__name__}")
        return "unreadable", {}
    new, results = patch_text(text, topics)
    per_patch = {p["name"]: st for p, st in results}
    for patch, status in results:
        if status.startswith("anchor-missing"):
            log(f"LOUD: {status.split(':', 1)[1]} not found exactly once in {path} (plugin changed?) -- "
                f"the {patch['name']} patch left out, {patch['fallback']}")
        elif status not in ("patched", "already", "removed"):
            log(f"LOUD: {status} in {path} -- the {patch['name']} patch not applied or not refreshed, "
                f"{patch['fallback']} unless an earlier copy is in place")
    patched = [p["name"] + (" removed" if st == "removed" else "") for p, st in results if st in ("patched", "removed")]
    if not patched:
        return file_status(results), per_patch
    tmp = path + ".marveen-tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(tmp, path)
    except Exception as e:
        log(f"cannot write {path}: {type(e).__name__} -- left unpatched ({', '.join(patched)})")
        try:
            os.remove(tmp)
        except Exception:
            pass
        return "unwritable", {n: ("unwritable" if st in ("patched", "removed") else st) for n, st in per_patch.items()}
    log(f"patched {path} ({', '.join(patched)})")
    return file_status(results), per_patch


def default_root():
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        return os.path.join(cfg, "plugins", "cache")
    return os.path.expanduser("~/.claude/plugins/cache")


def write_state(state_path, state):
    tmp = state_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, state_path)
    except Exception as e:
        log(f"cannot write state {state_path}: {type(e).__name__}")


def parse_env_content(content):
    """src/env-parse.ts parseEnvContent, rule for rule: lines split on \\n only,
    trimmed like JS trim(), comments and blank lines skipped, the key trimmed
    around the first =, ONE pair of matching surrounding quotes stripped, and
    a later line for the same key wins."""
    result = {}
    for line in content.split("\n"):
        trimmed = line.strip(JS_TRIM)
        if not trimmed or trimmed.startswith("#"):
            continue
        eq = trimmed.find("=")
        if eq == -1:
            continue
        key = trimmed[:eq].strip(JS_TRIM)
        value = trimmed[eq + 1:].strip(JS_TRIM)
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        result[key] = value
    return result


def is_on(value):
    """src/setting-flag.ts isSettingValueOn."""
    return str(value).strip(JS_TRIM).lower() in TRUTHY


def topics_setting(install_dir):
    """TELEGRAM_TOPICS_ENABLED as the dashboard settings store resolves it:
    store/config-overrides.json, then .env, then the registry default (off)."""
    try:
        with open(os.path.join(install_dir, "store", "config-overrides.json"), encoding="utf-8") as f:
            overrides = json.load(f)
        if isinstance(overrides, dict) and TOPICS_SETTING in overrides:
            return is_on(overrides[TOPICS_SETTING])
    except Exception:
        pass
    try:
        # As Node's readFileSync(path, 'utf-8') reads it: no newline translation
        # (a lone \r does not end a line there), a bad byte becomes U+FFFD
        # instead of failing the whole file.
        with open(os.path.join(install_dir, ".env"), encoding="utf-8", errors="replace", newline="") as f:
            env = parse_env_content(f.read())
        if TOPICS_SETTING in env:
            return is_on(env[TOPICS_SETTING])
    except Exception:
        pass
    return False


def main(argv):
    args = argv[1:]
    state_path = None
    topics = None
    while len(args) >= 2 and args[0] in ("--state", "--topics"):
        if args[0] == "--state":
            state_path = args[1]
        elif args[1] in ("on", "off"):
            topics = args[1] == "on"
        else:
            # An explicit switch: anything else is a typo, and reading it as
            # "off" would silently take the topics patch off.
            print(f"patch-telegram-plugin.py: --topics takes on or off, got {args[1]!r}; nothing patched", file=sys.stderr)
            return 2
        args = args[2:]
    if topics is None:
        topics = topics_setting(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    root = args[0] if args else default_root()
    files = []
    base = os.path.join(root, "claude-plugins-official", "telegram")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base)):
            path = os.path.join(base, ver, "server.ts")
            if os.path.isfile(path):
                status, patches = patch_file(path, topics)
                files.append({"version": ver, "path": path, "status": status, "patches": patches})
    if state_path:
        write_state(state_path, {"at": int(time.time()), "root": root, "topics": "on" if topics else "off", "files": files})
    return 0


if __name__ == "__main__":
    code = 0
    try:
        # Non-zero only for a mistyped --topics, which channels.sh never passes.
        code = main(sys.argv)
    except Exception as e:  # never stop the channel from starting
        log(f"unexpected {type(e).__name__}, nothing patched")
    sys.exit(code)
