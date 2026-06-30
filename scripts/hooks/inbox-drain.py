#!/usr/bin/env python3
"""UserPromptSubmit hook: PULL the MAIN agent's inter-agent inbox into context.

The main agent's channel session is effectively always busy, so the message
router cannot reliably tmux-inject inter-agent messages into it -- they stall as
'pending' (the ~1h silent-delivery incidents). This hook delivers them the other
way: on each main-agent turn it calls the dashboard
  POST /api/agents/<main>/drain-inbox
which ATOMICALLY claims the pending messages and returns them ALREADY WRAPPED
(the trusted/untrusted/channel-inbound security framing is single-sourced in TS
-- never duplicated here), and prints them so they enter the agent's context.

Main-agent ONLY: agent_id is derived from the session cwd; sub-agents keep the
router's tmux-push path (draining them here too would double-deliver). The
router skips main-agent delivery, so this is the main agent's sole inbound path.
Never blocks the prompt (always exit 0); a drain error just retries next turn.
"""
import sys
import os
import json
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _web_port():
    """Dashboard port: WEB_PORT env, then the install .env, default 3420. Never
    hardcode an install-specific value (distribution rule)."""
    v = os.environ.get("WEB_PORT")
    if v and v.strip().isdigit():
        return v.strip()
    try:
        with open(os.path.join(ledger_lib._install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("WEB_PORT="):
                    p = line.split("=", 1)[1].strip()
                    if p.isdigit():
                        return p
    except Exception:
        pass
    return "3420"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    if agent_id != ledger_lib.main_agent_id():
        sys.exit(0)  # sub-agents are delivered by the router push path

    try:
        token_path = os.path.join(ledger_lib._install_dir(), "store", ".dashboard-token")
        with open(token_path) as f:
            token = f.read().strip()
        if not token:
            sys.exit(0)
        url = "http://127.0.0.1:%s/api/agents/%s/drain-inbox" % (_web_port(), agent_id)
        req = urllib.request.Request(
            url,
            data=b"{}",
            method="POST",
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.load(resp)
        text = (data or {}).get("text") or ""
        if text:
            # UserPromptSubmit hook stdout is prepended to the agent's context.
            sys.stdout.write(text)
            sys.stdout.write("\n")
    except Exception:
        pass  # never block the prompt on a drain error -- the next turn retries

    sys.exit(0)


if __name__ == "__main__":
    main()
