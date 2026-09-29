#!/usr/bin/env python3
"""Does an inbound Telegram message owe a reply? (scripts/hooks/channel_scope.py)

Pins the shared rule AND the four hooks that consume it, each driven the way
production drives it (subprocess, isolated ledger via LEDGER_DB_PATH):

  1. channel_scope.reply_owed itself: DM always; group only when addressed --
     by an accent-folded, inflection-tolerant name form, a configured alias, or
     a Telegram reply to one of the agent's own messages.
  2. telegram-reply-guard.py (Stop): an unaddressed group message must NOT
     block; an addressed one must.
  3. telegram-reply-directive.py (UserPromptSubmit): the "do not post" group
     directive only for an unaddressed group message; an inflected / accented
     name or a reply to the agent gets the normal reply directive.
  4. ledger-replay.py (SessionStart): a group message is never labelled with
     the owner's name, and an unaddressed one is not replayed as the open
     question.

The TypeScript twin (src/reply-owed.ts) runs the same name cases in
src/__tests__/open-question-reply-owed.test.ts.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)

DM = "111111111"
GROUP = "-100222222222"
OWNER = "Test Owner"
# A cwd outside any install tree: the agent id then comes from MARVEEN_AGENT_ID.
CWD = tempfile.gettempdir()

FAILS = []


def check(name, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILS.append(name)


# Hermetic environment: no alias config from the checkout, no env aliases.
TMP = tempfile.mkdtemp(prefix="chscope-")
AGENTS_DIR = os.path.join(TMP, "agents")
os.makedirs(AGENTS_DIR)
os.environ["CHANNEL_SCOPE_AGENTS_DIR"] = AGENTS_DIR
os.environ.pop("TG_MENTION_NAMES", None)

import channel_scope  # noqa: E402


def fresh_db(tag):
    path = os.path.join(TMP, f"{tag}.db")
    if os.path.exists(path):
        os.remove(path)
    return path


def lib_for(db):
    os.environ["LEDGER_DB_PATH"] = db
    import importlib
    import ledger_lib
    importlib.reload(ledger_lib)
    return ledger_lib


def run(hook, db, agent, payload):
    env = dict(os.environ)
    env.update({"LEDGER_DB_PATH": db, "MARVEEN_AGENT_ID": agent, "OWNER_NAME": OWNER,
                "CHANNEL_SCOPE_AGENTS_DIR": AGENTS_DIR})
    payload = dict(payload, cwd=CWD)
    p = subprocess.run([sys.executable, os.path.join(HOOKS, hook)],
                       input=json.dumps(payload), capture_output=True, text=True,
                       env=env, cwd=CWD, timeout=20)
    return p.stdout


def guard(db, agent):
    out = run("telegram-reply-guard.py", db, agent, {"stop_hook_active": False}).strip()
    return json.loads(out).get("decision") if out else None


def directive(db, agent, chat_id, text, reply_to=None):
    rt = f' reply_to_message_id="{reply_to}"' if reply_to else ""
    block = (f'<channel source="plugin:telegram:telegram" chat_id="{chat_id}" '
             f'message_id="900" user="someone"{rt} ts="2026-09-24T08:00:00.000Z">\n'
             f'{text}\n</channel>')
    out = run("telegram-reply-directive.py", db, agent,
              {"hook_event_name": "UserPromptSubmit", "prompt": block})
    if out.startswith("[TELEGRAM-CSOPORT]"):
        return "silent"
    if out.startswith("[TELEGRAM-DIREKT"):
        return "reply"
    return "none:" + out[:40]


# --- 1. the rule itself ----------------------------------------------------
print("channel_scope.reply_owed")
ro = channel_scope.reply_owed
check("DM always owes a reply", ro(DM, "szia", "zara"), True)
check("unaddressed group message owes none", ro(GROUP, "Anna, mehet a meeting", "zara"), False)
check("group, plain name", ro(GROUP, "Zara, nézd meg", "zara"), True)
check("group, accented + inflected (Zárát)", ro(GROUP, "Zárát kérem, nézd meg", "zara"), True)
check("group, accented + linking letter (Írisz)", ro(GROUP, "Írisz, segíts", "iris"), True)
check("group, stacked suffix (Írisszel)", ro(GROUP, "beszéltem Írisszel", "iris"), True)
check("group, @-tag with a long bot-username tail",
      ro(GROUP, "@iris_helper_bot kész?", "iris"), True)
check("group, name inside an unrelated long word is not a mention",
      ro(GROUP, "irisztinakonyvtar", "iris"), False)
check("group, name as a later part of a word is not a mention",
      ro(GROUP, "bazara", "zara"), False)
check("group, reply to the agent's own message", ro(GROUP, "ok, mehet", "zara", True), True)
check("group, reply-to lookup fails -> counts as addressed",
      ro(GROUP, "ok, mehet", "zara", lambda: 1 / 0), True)
check("DM never evaluates the reply-to lookup",
      ro(DM, "x", "zara", lambda: 1 / 0), True)

os.makedirs(os.path.join(AGENTS_DIR, "kappa"))
with open(os.path.join(AGENTS_DIR, "kappa", "agent-config.json"), "w") as f:
    json.dump({"displayName": "Front Desk", "mentionNames": ["Kristóf"]}, f)
check("configured mentionNames form (accent-folded)",
      ro(GROUP, "Kristofnak szólj", "kappa"), True)
check("configured multi-word displayName", ro(GROUP, "front  desk, help", "kappa"), True)
check("config does not leak to another agent", ro(GROUP, "Kristóf, szia", "zara"), False)
os.environ["TG_MENTION_NAMES"] = "Zarabot, Z-Bot"
check("TG_MENTION_NAMES alias", ro(GROUP, "z-bot?", "zara"), True)
os.environ.pop("TG_MENTION_NAMES")

# --- 2. Stop guard ---------------------------------------------------------
print("telegram-reply-guard.py")
db = fresh_db("guard-group")
lib = lib_for(db)
lib.log_inbound("zara", GROUP, "10", "Anna, mehet a meeting", "t")
check("guard: unaddressed group message does not block", guard(db, "zara"), None)

db = fresh_db("guard-zarat")
lib = lib_for(db)
lib.log_inbound("zara", GROUP, "11", "Zárát kérem, nézd meg a számlát", "t")
check("guard: inflected name in group blocks", guard(db, "zara"), "block")

db = fresh_db("guard-replyto")
lib = lib_for(db)
lib.log_outbound("zara", GROUP, "Kész a lista.", "500")
lib.log_inbound("zara", GROUP, "12", "és a másik mikor lesz?", "t", reply_to_message_id="500")
check("guard: reply to the agent's own message blocks", guard(db, "zara"), "block")

db = fresh_db("guard-replyother")
lib = lib_for(db)
lib.log_outbound("zara", GROUP, "Kész a lista.", "500")
lib.log_inbound("zara", GROUP, "13", "és a másik mikor lesz?", "t", reply_to_message_id="499")
check("guard: reply to someone else's message does not block", guard(db, "zara"), None)

db = fresh_db("guard-dm")
lib = lib_for(db)
lib.log_inbound("zara", DM, "14", "Mikor jön a szállítás?", "t")
check("guard: DM question blocks", guard(db, "zara"), "block")

# --- 3. prompt directive -----------------------------------------------------
print("telegram-reply-directive.py")
db = fresh_db("directive")
lib = lib_for(db)
check("directive: Zárát -> reply", directive(db, "zara", GROUP, "Zárát kérem, nézd meg"), "reply")
check("directive: Írisz -> reply", directive(db, "iris", GROUP, "Írisz, segíts"), "reply")
check("directive: Zara -> reply", directive(db, "zara", GROUP, "Zara, nézd meg"), "reply")
check("directive: unaddressed group -> silent",
      directive(db, "zara", GROUP, "Anna, mehet a meeting"), "silent")
check("directive: DM -> reply", directive(db, "zara", DM, "szia"), "reply")
lib.log_outbound("zara", GROUP, "Kész a lista.", "600")
check("directive: reply to the agent's own message -> reply",
      directive(db, "zara", GROUP, "és a másik?", reply_to="600"), "reply")
check("directive: reply to another message -> silent",
      directive(db, "zara", GROUP, "és a másik?", reply_to="601"), "silent")

# --- 4. replay -----------------------------------------------------------------
print("ledger-replay.py")
db = fresh_db("replay")
lib = lib_for(db)
lib.log_inbound("zara", DM, "20", "Szia, itt vagy?", "2026-09-24T07:00:00Z")
lib.log_outbound("zara", DM, "Itt.", "700")
lib.log_inbound("zara", GROUP, "21", "Fyi: elvittem a létrát", "2026-09-24T07:05:00Z")
out = json.loads(run("ledger-replay.py", db, "zara", {"hook_event_name": "SessionStart"}) or "{}")
ctx = (out.get("hookSpecificOutput") or {}).get("additionalContext") or ""
check("replay: group line is not attributed to the owner",
      f'{OWNER}: "Fyi: elvittem a létrát"' in ctx, False)
check("replay: group line is still in the transcript",
      'Fyi: elvittem a létrát' in ctx, True)
check("replay: DM line keeps the owner's name",
      f'{OWNER}: "Szia, itt vagy?"' in ctx, True)
check("replay: unaddressed group message is not the open question",
      "NYITOTT" in ctx, False)

db = fresh_db("replay-addressed")
lib = lib_for(db)
lib.log_inbound("zara", GROUP, "22", "Zárát kérem, küldd a listát", "2026-09-24T07:10:00Z")
out = json.loads(run("ledger-replay.py", db, "zara", {"hook_event_name": "SessionStart"}) or "{}")
ctx = (out.get("hookSpecificOutput") or {}).get("additionalContext") or ""
check("replay: addressed group message is the open question",
      "message_id 22" in ctx, True)
check("replay: the open group question is not attributed to the owner",
      OWNER in ctx, False)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
    sys.exit(1)
print("All channel-scope tests passed.")
