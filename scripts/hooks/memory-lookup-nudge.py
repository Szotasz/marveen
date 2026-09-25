#!/usr/bin/env python3
"""UserPromptSubmit hook: on a human message, remind the agent to look in its memory.

The owner asked (2026-09-25, TG 16727) that an agent always look around in its
memory when a HUMAN writes, without loading any tier by default. Measured the
same day on the owner's last 30 Telegram messages: a strict FTS search built
from the message words hit 3/30, all trivial ("Mehet"); the relaxed OR form hit
30/30 with ~2400 rows each, i.e. noise; the stored nomic vectors do not separate
Hungarian text either. So this hook injects NO memory content. It injects a
short, fixed instruction with the correct search recipe, and the agent picks the
keyword (a name, a topic), which it does far better than a word list.

When it speaks: a channel message (<channel ...>) or a bare terminal prompt.
When it stays silent: inter-agent traffic (<trusted-peer>, <untrusted>,
[Uzenet @...]), scheduled tasks, the agent's own task notices, system-style
prompts that start with "[" (context guard, recovery brief, inbox nudges,
SYSTEM-DIREKTIVA), and local slash commands.

Never raises and never blocks: any error is a silent exit(0). The registration
carries a 3 s timeout, and the hook does no network or DB work at all.
"""
import json
import os
import sys

MACHINE_MARKERS = (
    "<trusted-peer ",
    "<untrusted ",
    "<scheduled-task ",
    "<task-notification>",
    "[Uzenet @",
    "[Uzenet a tavoli @",
    "[Üzenet @",
    "<command-name>",
    "<local-command-",
)


def _project_root():
    # scripts/hooks/ -> project root (two dirs up)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _env_value(key, default):
    val = os.environ.get(key)
    if val:
        return val
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith(key + "="):
                    v = line.split("=", 1)[1].strip().strip("\"'")
                    if v:
                        return v
    except Exception:
        pass
    return default


def agent_id(cwd):
    """<install>/agents/<name>[/...] -> name; the install root -> MAIN_AGENT_ID."""
    root = os.path.realpath(_project_root())
    here = os.path.realpath(cwd or "")
    agents = os.path.join(root, "agents") + os.sep
    if here.startswith(agents):
        name = here[len(agents):].split(os.sep, 1)[0]
        if name:
            return name
    return _env_value("MAIN_AGENT_ID", "marveen")


def is_human(prompt):
    text = prompt.lstrip()
    if not text:
        return False
    if any(m in prompt for m in MACHINE_MARKERS):
        return False
    if "<channel " in prompt:
        return True
    # Bare prompt: the owner typing into the terminal or the dashboard. System
    # prompts on this path are bracket-tagged, and slash commands start with "/".
    return not text.startswith("[") and not text.startswith("/")


def nudge(agent, port, token_path):
    return (
        "[memoria-szetnezes] Emberi uzenet: mielott valaszolsz, nezd meg, van-e rola emleked. "
        "A kulcsszot te valaszd (nev, tema), ne a mondat toltelekszavait.\n"
        f'curl -s -G -D /tmp/mem-fejlec-{agent}.txt -H "Authorization: Bearer $(cat {token_path})" '
        f'--data-urlencode "agent={agent}" --data-urlencode "q=KULCSSZO" "http://localhost:{port}/api/memories"\n'
        f"grep -i '^x-memory-search' /tmp/mem-fejlec-{agent}.txt  "
        "(relaxed=true = kozelites, nem bizonyitek; hiany-allitashoz: --data-urlencode \"strict=1\")"
    )


def main():
    try:
        payload = json.load(sys.stdin)
        prompt = payload.get("prompt") or ""
        if not is_human(prompt):
            sys.exit(0)
        agent = agent_id(payload.get("cwd") or os.getcwd())
        port = _env_value("WEB_PORT", "3420")
        token_path = os.path.join(_project_root(), "store", ".dashboard-token")
        print(nudge(agent, port, token_path))
    except SystemExit:
        raise
    except Exception:
        pass  # a nudge that crashes the prompt is worse than no nudge
    sys.exit(0)


if __name__ == "__main__":
    main()
