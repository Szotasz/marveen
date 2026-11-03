#!/usr/bin/env python3
"""
Answer buttons on the Discord channel plugin's reply tool (DCBTN1023).

The official plugin (claude-plugins-official/discord/<ver>/server.ts) can only
send text and files, so a question with a few fixed answers ("Igen / Nem",
"A / B / C") has to be answered by typing. This script adds an optional
`buttons` list to the reply tool: the buttons go under the last chunk, a click
arrives as an ordinary <channel> message whose text is the label (with
button="true" in the meta), and the first accepted click replaces the buttons
with "-> <label> (<display name>)". Clicks pass the same access check as
messages (DMs: allowFrom; a channel: its own allowFrom when set, else anyone
there when it listens to every message, else allowFrom); a refused click gets
an ephemeral "Not authorized." and the buttons stay. The Telegram counterpart
is the kbd patch in scripts/patch-telegram-plugin.py (c67f5f34).

Upstream does not take outside pull requests (its close-external-prs workflow
closes them), so the change lives here and is put back after every plugin
update. The same code is offered upstream on
anthropics/claude-plugins-official#895.

Runs at every channel start (scripts/channels.sh) when the session listens on
Discord (CHANNEL_PROVIDER=discord, or discord@... in CHANNEL_PLUGINS_EXTRA),
before the plugin is spawned, over every cached plugin version in ONE cache:
the one this install launches from ($CLAUDE_CONFIG_DIR/plugins/cache, or
~/.claude/plugins/cache when the variable is unset).

- idempotent: a file carrying the marker is left alone, unless this script's
  code changed since: then the old lines are taken out and the current ones
  put in ("upgraded");
- all-or-nothing: if ANY anchor is missing or not unique (a plugin update
  changed the code), the file is left unchanged and one loud line says so --
  the reply tool then has no buttons, everything else works as before;
- a plugin whose reply tool already declares `buttons` (upstream took the
  feature) is left alone: status "native";
- every line it adds ends with TAG (a blank line is the TAG alone), so taking
  the patch back is deleting those lines: the file is then byte-identical to
  the unpatched one (tested);
- uses only names the plugin already imports (ButtonBuilder, ButtonStyle,
  ActionRowBuilder, Interaction);
- always exits 0: a failed patch must never stop the channel from starting;
- with --state FILE, the outcome per file is written there as JSON.

Usage: patch-discord-plugin.py [--state FILE] [<plugins cache root>]
(default root: $CLAUDE_CONFIG_DIR/plugins/cache, else ~/.claude/plugins/cache)
"""
import json
import os
import re
import sys
import time

TAG = "// MARVEEN-PATCH(dcbtn1023)"

# A reply tool that already declares `buttons` (upstream took the feature, or
# a hand-applied copy without the tag): adding ours would duplicate the key.
NATIVE = re.compile(r"^ *buttons: \{\n", re.MULTILINE)

INSTRUCTIONS = """\
'reply accepts buttons (buttons: [{label: "Yes"}, {label: "No", style: "danger"}]) for decisions with a few fixed answers. A click arrives as a normal <channel> message whose text is the button label, with button="true" in its attributes; the user can still type an answer instead. Clicks pass the same access check as messages, and the buttons are removed after the first accepted click.',
'',
"""

SCHEMA = """\
buttons: {
  type: 'array',
  description: 'Optional answer buttons, shown under the last chunk (max 25, 5 per row). A click comes back as an inbound message whose text is the label.',
  items: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Button text, max 80 chars. This is what you receive on click.' },
      style: { type: 'string', enum: ['primary', 'secondary', 'success', 'danger'] },
    },
    required: ['label'],
  },
},
"""

ROWS = """\
const rows = buildButtonRows(args.buttons)
"""

SEND = """\
...(i === chunks.length - 1 && rows.length > 0 ? { components: rows } : {}),
"""

HANDLER = """\
const BUTTON_STYLES: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
}

// reply's buttons param -> action rows. customId is `choice:<n>`; the label
// itself is read back from the clicked component, so no state survives here.
function buildButtonRows(raw: unknown): ActionRowBuilder<ButtonBuilder>[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('buttons must be an array')
  if (raw.length > 25) throw new Error('Discord allows max 25 buttons per message')
  const seen = new Set<string>()
  const buttons = raw.map((b, i) => {
    const label = typeof b?.label === 'string' ? b.label.trim() : ''
    if (!label) throw new Error(`button ${i}: label is required`)
    if (label.length > 80) throw new Error(`button ${i}: label longer than 80 chars`)
    if (seen.has(label)) throw new Error(`button ${i}: duplicate label "${label}"`)
    seen.add(label)
    const style = BUTTON_STYLES[b?.style ?? 'secondary']
    if (style === undefined) throw new Error(`button ${i}: unknown style "${b.style}"`)
    return new ButtonBuilder().setCustomId(`choice:${i}`).setLabel(label).setStyle(style)
  })
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)))
  }
  return rows
}

// Who may answer with a button: gate() for messages, minus the mention.
// Inbound switched off (dmPolicy disabled) drops clicks too, so buttons sent
// before that stop being answerable. DMs: only allowFrom, like messages. Guild
// channels: the channel must be opted in and groupAllowFrom (if set) applies.
// In a channel that listens to every message (requireMention: false) anyone
// there may click; otherwise only allowFrom / groupAllowFrom members, because
// a click carries no mention to gate on.
function clickAllowed(interaction: Interaction, access: Access): boolean {
  if (access.dmPolicy === 'disabled') return false
  const userId = interaction.user.id
  if (interaction.guildId === null) return access.allowFrom.includes(userId)
  const ch = interaction.channel
  if (!ch) return false
  const channelId = ch.isThread() ? ch.parentId ?? ch.id : ch.id
  const policy = access.groups[channelId]
  if (!policy) return false
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0) return groupAllowFrom.includes(userId)
  if ((policy.requireMention ?? true) === false) return true
  return access.allowFrom.includes(userId)
}

// Message ids whose buttons were already answered: two quick clicks must not
// both reach the session before the first update removes the buttons.
const answeredChoices = new Set<string>()

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isButton()) return
  if (!/^choice:\\d{1,2}$/.test(interaction.customId)) return
  if (interaction.message.author.id !== client.user?.id) return
  const access = loadAccess()
  if (!clickAllowed(interaction, access)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  const message_id = interaction.message.id
  if (answeredChoices.has(message_id)) {
    await interaction.reply({ content: 'Already answered.', ephemeral: true }).catch(() => {})
    return
  }
  answeredChoices.add(message_id)
  const c = interaction.component
  const label = ('label' in c ? c.label : null) ?? ''
  // Show the choice under the message; if that would pass Discord's 2000-char
  // cap, only drop the buttons so the same message can't be answered twice.
  // Show the name people see in the chat: server nickname, then the
  // account's display name, then the username.
  const m = interaction.member
  const who = m === null ? interaction.user.displayName
    : 'displayName' in m ? m.displayName
    : m.nick ?? interaction.user.displayName
  const answered = `${interaction.message.content}\\n\\n➡️ ${label} (${who})`
  await interaction
    .update(answered.length <= MAX_CHUNK_LIMIT ? { content: answered, components: [] } : { components: [] })
    .catch(err => process.stderr.write(`discord channel: failed to close buttons: ${err}\\n`))
  if (interaction.guildId === null) {
    dmChannelUsers.set(interaction.channelId, interaction.user.id)
  }
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: label,
      meta: {
        chat_id: interaction.channelId,
        message_id,
        user: interaction.user.username,
        user_id: interaction.user.id,
        ts: new Date().toISOString(),
        button: 'true',
      },
    },
  }).catch(err => {
    process.stderr.write(`discord channel: failed to deliver button click to Claude: ${err}\\n`)
  })
})

"""

# The names the inserted code uses from the plugin. An anchor only proves the
# code next to the insertion is still there; if a later version renamed or
# dropped one of these, the patched file would still say "patched" and then
# fail: a top-level ButtonStyle reference throws ReferenceError when the module
# loads, so the channel would not start at all. Missing -> the same loud
# "left out" path as a moved anchor.
DISCORD_IMPORT = re.compile(r"^import \{\n((?:[^\n]*\n)*?)\} from 'discord\.js'\n", re.MULTILINE)


def _imports(*names):
    def ok(text):
        m = DISCORD_IMPORT.search(text)
        return bool(m) and all(re.search(rf"^\s*(?:type\s+)?{n},?\s*$", m.group(1), re.MULTILINE) for n in names)
    return ok


def _defines(rx):
    return lambda text: len(re.findall(rx, text, re.MULTILINE)) == 1


REQUIRES = [
    ("discord.js imports ButtonBuilder, ButtonStyle, ActionRowBuilder, Interaction",
     _imports("ButtonBuilder", "ButtonStyle", "ActionRowBuilder", "Interaction")),
    ("function loadAccess", _defines(r"^function loadAccess\(")),
    ("const dmChannelUsers", _defines(r"^const dmChannelUsers = ")),
    ("const MAX_CHUNK_LIMIT", _defines(r"^const MAX_CHUNK_LIMIT = ")),
    ("const client", _defines(r"^const client = ")),
    ("const mcp", _defines(r"^const mcp = ")),
]

# (name, anchor, mode, lines). The anchor's group 1 is the indent the lines
# get; each anchor must match exactly once.
STEPS = [
    # The model learns the parameter from the server instructions, before the
    # files hint.
    ("instructions inbound tag", re.compile(
        r"^( *)'Messages from Discord arrive as <channel source=\"discord\" [^\n]*\n *'',\n", re.MULTILINE),
     "insert-after", INSTRUCTIONS),
    # The parameter itself, after `files` in the reply tool's schema.
    ("reply schema files property", re.compile(
        r"^ *description: 'Absolute file paths to attach[^\n]*\n( *)\},\n", re.MULTILINE),
     "insert-after", SCHEMA),
    # Checked before anything is sent: a bad list is a tool error, not a half-sent reply.
    ("reply files arg", re.compile(
        r"^( *)const files = \(args\.files as string\[\] \| undefined\) \?\? \[\]\n", re.MULTILINE),
     "insert-after", ROWS),
    # The buttons go on the LAST chunk, under the whole answer.
    ("reply send files option", re.compile(
        r"^( *)\.\.\.\(i === 0 && files\.length > 0 \? \{ files \} : \{\}\),\n", re.MULTILINE),
     "insert-after", SEND),
    # The rows builder, the click check and the click handler, before the
    # inbound message handler.
    ("messageCreate handler", re.compile(r"^()client\.on\('messageCreate', msg => \{\n", re.MULTILINE),
     "insert-before", HANDLER),
]


def log(msg):
    sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} patch-discord-plugin: {msg}\n")


def tagged(indent, block):
    return "".join((f"{indent}{line} {TAG}\n" if line else f"{TAG}\n") for line in block.split("\n")[:-1])


def patch_text(text):
    """Returns (new_text, status): 'patched' | 'upgraded' | 'already' | 'native' | 'anchor-missing:<name>'."""
    if TAG in text:
        # Patched before. Take our lines out (byte-exact) and patch again, so a
        # file patched by an older version of this script gets the current code.
        fresh, status = patch_text(unpatch_text(text))
        if status == "patched" and fresh != text:
            return fresh, "upgraded"
        return text, "already"
    if NATIVE.search(text):
        return text, "native"
    for name, ok in REQUIRES:
        if not ok(text):
            return text, f"anchor-missing:{name}"
    out = text
    for name, rx, mode, block in STEPS:
        found = list(rx.finditer(out))
        if len(found) != 1:
            return text, f"anchor-missing:{name}"
        m = found[0]
        added = tagged(m.group(1), block)
        at = m.start() if mode == "insert-before" else m.end()
        out = out[:at] + added + out[at:]
    return out, "patched"


def unpatch_text(text):
    """The unpatched text back: every line carrying TAG removed."""
    return "".join(l for l in text.splitlines(keepends=True) if not l.rstrip("\n").endswith(TAG))


def patch_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except Exception as e:
        log(f"cannot read {path}: {type(e).__name__}")
        return "unreadable"
    new, status = patch_text(text)
    if status.startswith("anchor-missing"):
        log(f"LOUD: {status.split(':', 1)[1]} not found exactly once in {path} (plugin changed?) -- "
            "the buttons patch left out, the reply tool has no buttons")
    elif status == "native":
        log(f"{path}: the reply tool already has buttons -- left alone")
    if status not in ("patched", "upgraded"):
        return status
    tmp = path + ".marveen-tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(tmp, path)
    except Exception as e:
        log(f"cannot write {path}: {type(e).__name__} -- left unpatched")
        try:
            os.remove(tmp)
        except Exception:
            pass
        return "unwritable"
    log(f"{status} {path} (buttons)")
    return status


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


def main(argv):
    args = argv[1:]
    state_path = None
    if len(args) >= 2 and args[0] == "--state":
        state_path = args[1]
        args = args[2:]
    root = args[0] if args else default_root()
    files = []
    base = os.path.join(root, "claude-plugins-official", "discord")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base)):
            path = os.path.join(base, ver, "server.ts")
            if os.path.isfile(path):
                files.append({"version": ver, "path": path, "status": patch_file(path)})
    if state_path:
        write_state(state_path, {"at": int(time.time()), "root": root, "files": files})


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as e:  # never stop the channel from starting
        log(f"unexpected {type(e).__name__}, nothing patched")
    sys.exit(0)
