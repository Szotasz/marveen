#!/usr/bin/env python3
"""
Take /status and /help away from the Telegram channel plugin (ELSOKOR922 D-4),
mark forwarded messages in the inbound meta (forwarded="1"), record every
inbound message the bot receives (the evidence owner WRITE commands need),
and -- only while TELEGRAM_TOPICS_ENABLED is on -- carry the topic of a
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
- the answer-buttons patch (c67f5f34: inline keyboard under the message, a
  tap comes back as an ordinary text message) inserts WHOLE LINES only, each
  carrying its marker, so taking it back is deleting the lines that carry
  "MARVEEN-PATCH(c67f5f34-kbd)" (the file is then byte-identical to the one
  patched without it; tested). It has its own apply function: a file carrying
  an older version of those lines (the reply keyboard) is rebuilt in place;
- with --state FILE, the outcome per file (and per patch) is written there as
  JSON, so /status can say in one line when a patch is missing
  (src/web/system-status.ts) instead of the command silently falling back.

Usage: patch-telegram-plugin.py [--state FILE] [--topics on|off] [<plugins cache root>]
(default root: $CLAUDE_CONFIG_DIR/plugins/cache, else ~/.claude/plugins/cache;
without --topics the TELEGRAM_TOPICS_ENABLED setting of this install decides)
"""
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
# only reply_parameters and parse_mode. First version: a reply keyboard, which
# Gyuri's client keeps collapsed until he starts typing. Now an INLINE keyboard
# under the message: one button per label (callback_data kbd:<index>), and a
# tap comes back as the label in an ordinary text message, through the same
# gate, evidence log and channel notification as a typed letter. Six anchors:
# the optional `buttons` list in the reply schema (after `files`), its check
# before anything is sent (the tool-call handler turns the throw into a tool
# error), the inline keyboard on the LAST text chunk (an empty list removes a
# keyboard shown earlier), a module-level Set of answered messages, the kbd
# branch of the callback handler, and the ts of the inbound meta.
#
# The callback branch sits right AFTER the perm regex line, not before it: the
# apv patch (approval buttons) requires nothing but the `const data` line
# between the handler's opening line and the perm regex, and the Set sits
# after PERMISSION_REPLY_RE for the same reason (the apv block goes in front
# of the handler). The branch answers only the owner in a private chat (never
# gate(): its pairing path would write a pending code for a stranger), takes
# the label from the keyboard of the message the button sits on (never from
# the data), lets one message be answered once, and takes the other buttons
# off BEFORE anything is delivered. A label never starts with a slash (checked
# when it is sent): a tap carries no message id, and the write-evidence of the
# command hook would otherwise have only the text to go by.
# The labels are outgoing text: the copy gate (scripts/hooks/outgoing-copy-gate.py)
# audits them together with `text`.


def _kbd_lines(lines):
    """Whole inserted lines, each carrying the marker; `{`/`}` are doubled
    because the insert goes through str.format (the {indent} field)."""
    return "".join("{indent}" + line.replace("{", "{{").replace("}", "}}") + " " + KBD_MARKER + "\n" for line in lines)


KBD_SCHEMA = ("reply schema files property", re.compile(
    r"^ *description: 'Absolute file paths to attach\. [^\n]*',\n( *)\},\n", re.MULTILINE), "insert-after",
    "{indent}buttons: {{ type: 'array', items: {{ type: 'string' }}, description: 'Optional one-tap answer buttons, "
    "shown under the message; after one tap the chosen one stays, marked with a check mark, and its label comes back "
    "as an ordinary text message from the user. Also write the options into text, so the question can be answered by "
    "typing. At most 12 labels, each non-empty, at most 64 characters, not starting with a slash; private chats only. "
    "Editing the message with edit_message removes the buttons; with files the buttons sit under the last text part. "
    "An empty list removes a keyboard shown earlier under the input field.' }}, "
    + KBD_MARKER + "\n")
KBD_CHECK = ("reply chat check", re.compile(r"^( *)assertAllowedChat\(chat_id\)\n", re.MULTILINE), "insert-after",
    _kbd_lines([
        r"const kbdButtons = args.buttons == null ? undefined : Array.isArray(args.buttons) && args.buttons.length <= 12 "
        r"&& args.buttons.every(b => typeof b === 'string' && b.trim() !== '' && b.length <= 64 "
        r"&& !/^[^\p{L}\p{N}]*\//u.test(b) && !/[\u0000-\u001f\u007f-\u009f]/.test(b) && !PERMISSION_REPLY_RE.test(b)) "
        r"? (args.buttons as string[]) : (() => { throw new Error('buttons: a list of at most 12 non-empty labels, "
        r"each at most 64 characters, not starting with a slash, without control characters, not a permission reply') })()",
        r"if (kbdButtons?.length && !loadAccess().allowFrom.includes(chat_id)) "
        r"throw new Error('buttons: only in a private chat with a paired user')",
    ]))
KBD_SEND = ("reply send options", re.compile(
    r"^( *)\.\.\.\(parseMode \? \{ parse_mode: parseMode \} : \{\}\),\n",
    re.MULTILINE), "insert-after",
    _kbd_lines([
        "...(kbdButtons && i === chunks.length - 1 ? { reply_markup: kbdButtons.length ? { inline_keyboard: "
        "kbdButtons.map((label, n) => [{ text: label, callback_data: 'kbd:' + n }]) } : "
        "{ remove_keyboard: true as const } } : {}),",
    ]))
KBD_SET = ("permission reply regex", re.compile(r"^( *)const PERMISSION_REPLY_RE = [^\n]*\n", re.MULTILINE), "insert-after",
    _kbd_lines(["const marveenKbdAnswered = new Set<string>()"]))
KBD_CALLBACK = ("callback perm regex", re.compile(
    r"^( *)const m = /\^perm:\(allow\|deny\|more\):\(\[a-km-z\]\{5\}\)\$/\.exec\(data\)\n", re.MULTILINE), "insert-after",
    _kbd_lines([
        "if (data.startsWith('kbd:')) {",
        "  const kbdMsg = ctx.callbackQuery.message",
        "  const kbdToast = (text: string) => ctx.answerCallbackQuery({ text }).catch(() => {})",
        "  if (!kbdMsg || !ctx.from || kbdMsg.chat.type !== 'private' || kbdMsg.chat.id !== ctx.from.id "
        "|| !loadAccess().allowFrom.includes(String(ctx.from.id))) { await kbdToast('Nem engedélyezett.'); return }",
        "  const kbdRows = 'reply_markup' in kbdMsg ? kbdMsg.reply_markup?.inline_keyboard : undefined",
        "  const kbdButton = /^kbd:(0|[1-9]|1[01])$/.test(data) "
        "? kbdRows?.flat().find(b => 'callback_data' in b && b.callback_data === data) : undefined",
        "  if (!kbdButton) { await kbdToast(data === 'kbd:-' ? 'Erre már válaszoltál.' "
        ": 'Ez a gomb már nem él, írd be a választ.'); return }",
        "  const kbdKey = kbdMsg.chat.id + ':' + kbdMsg.message_id",
        "  if (marveenKbdAnswered.has(kbdKey)) { await kbdToast('Erre már válaszoltál.'); return }",
        "  if (marveenKbdAnswered.size >= 1000) marveenKbdAnswered.clear()",
        "  marveenKbdAnswered.add(kbdKey)",
        "  try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: "
        "[[{ text: '✓ ' + kbdButton.text, callback_data: 'kbd:-' }]] } }) } "
        "catch { marveenKbdAnswered.delete(kbdKey); await kbdToast('Nem sikerült rögzíteni, írd be a választ.'); return }",
        "  await kbdToast('✓ ' + kbdButton.text)",
        "  await handleInbound(ctx, kbdButton.text, undefined)",
        "  return",
        "}",
    ]))
# A tap has no ctx.message: the meta would say ts 1970 (the staleness guard then warns on every tap) and carry no
# message_id. A later spread wins over the earlier `ts` key; message_id is the id of the QUESTION the button sits on
# (the conversation ledger keys the tapped answer by it). Before the imagePath line, not after the ts line: the topics
# patch inserts after the ts line, and both orders must give the same file.
KBD_TS = ("inbound meta imagePath", re.compile(
    r"^( *)\.\.\.\(imagePath \? \{ image_path: imagePath \} : \{\}\),\n", re.MULTILINE), "insert-before",
    _kbd_lines([
        "...(ctx.callbackQuery?.message ? { ts: new Date().toISOString(), "
        "message_id: String(ctx.callbackQuery.message.message_id) } : {}),",
    ]))
KBD_ANCHORS = [KBD_SCHEMA, KBD_CHECK, KBD_SEND, KBD_SET, KBD_CALLBACK, KBD_TS]
KBD_PATCH = {"name": "kbd", "marker": KBD_MARKER, "anchors": KBD_ANCHORS, "mode": "insert-after",
             "apply": lambda text: apply_kbd(text),  # defined below
             "fallback": "the reply tool has no buttons: a question goes out without them and is answered by typing"}

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
    # an anchor may carry its own mode and insert (name, regex, mode, insert): the kbd lines differ.
    # "apply" replaces apply_patch for a patch that must also rebuild an older version of itself.
    KBD_PATCH,
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


def strip_kbd(text):
    """The text without the lines the kbd patch inserted (they all end with ' ' + KBD_MARKER)."""
    return "".join(line for line in text.splitlines(keepends=True) if not line.rstrip("\n").endswith(" " + KBD_MARKER))


def apply_kbd(text):
    """Returns (new_text, status) like apply_patch, but a file that already carries kbd lines is not skipped:
    the lines are taken out and rebuilt, so an older version (the reply keyboard) is replaced in place and
    a current one comes out byte-identical ('already'). Status also: 'damaged:kbd markers' (a marker that is
    not at the end of a line; the file is left alone)."""
    if KBD_MARKER not in text:
        return apply_patch(text, KBD_PATCH)
    base = strip_kbd(text)
    if KBD_MARKER in base:
        return text, "damaged:kbd markers"
    new, status = apply_patch(base, KBD_PATCH)
    if status != "patched":
        return text, status  # the old lines stay: they still work
    if new == text:
        return text, "already"
    log("kbd lines of an older or edited version replaced")
    return new, "patched"


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
    'patched' when this run wrote (or took out) one, else the first anchor-missing (or damaged)."""
    statuses = [st for _, st in results]
    if "patched" in statuses or "removed" in statuses:
        return "patched"
    if all(st == "already" for st in statuses):
        return "already"
    return next(st for st in statuses if st.startswith(("anchor-missing", "damaged")))


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
        elif status.startswith("damaged"):
            log(f"LOUD: {status.split(':', 1)[1]} damaged in {path} (a marker not at the end of a line) -- "
                f"the {patch['name']} patch left alone, {patch['fallback']}")
    patched =[p["name"] + (" removed" if st == "removed" else "") for p, st in results if st in ("patched", "removed")]
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
