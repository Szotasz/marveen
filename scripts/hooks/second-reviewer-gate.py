#!/usr/bin/env python3
"""D3(b) second reviewer: a PreToolUse hook that asks the dashboard to review
high-risk tool calls before they run.

Wired only on agents whose security profile sets `secondReviewer` (default
off). It reviews only high-risk shapes (destructive or outward-facing Bash
commands, MCP tools that send/delete/pay/...) and exits 0 on everything else.
A deny or an "ask" stops the call with a message to the agent. When the
hook input cannot be read the call is stopped too, and so it is when the
dashboard cannot be reached (fail-closed), because an
opt-in safety gate that silently lets everything through when its server is
down is not a gate. The patterns are a triage of what is worth a review, not a
security boundary.
"""
import json
import os
import re
import sys
import urllib.request

BASH_RISK_PATTERNS = [
    r"\brm\s+(-[A-Za-z]*[rRf]|--recursive|--force)",
    r"\bgit\b(\s+-[cC]\s+\S+|\s+--[a-z-]+(=\S+)?)*\s+push\b",
    r"\bgit\s+reset\s+--hard\b",
    r"\bgit\s+(branch|tag)\s+(-D|-d|--delete)\b",
    r"\b(curl|wget)\b[^\n]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|-[A-Za-z]*d\b|--data(-[a-z]+)?\b|-F\b|--form\b|-T\b|--upload-file\b|--post-(data|file)\b|--json\b)",
    r"\b(ssh|scp|rsync|sftp)\s",
    r"\bsudo\b",
    r"\b(chmod|chown)\s+-[A-Za-z]*R",
    r"\bdd\s+[^\n]*\bof=",
    r"\bmkfs(\.[a-z0-9]+)?\b",
    r"\bcrontab\s+-[re]\b",
    r"\b(pkill|killall)\b|\bkill\s+-9\b",
    r"\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b",
    r"\bkubectl\s+delete\b",
    r"(?i)\b(drop\s+(table|database)|truncate\s+table)\b",
]
MCP_RISK_RE = re.compile(r"(?:^|_)(send|reply|post|publish|forward|delete|remove|drop|destroy|transfer|pay|share|invite|push)(?:_|$)")


def _snake(name: str) -> str:
    # sendMessage -> send_message, chat_postMessage -> chat_post_message
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name).lower().replace("-", "_")


def is_high_risk(tool_name: str, tool_input: dict) -> bool:
    if tool_name == "Bash":
        cmd = tool_input.get("command")
        return isinstance(cmd, str) and any(re.search(p, cmd) for p in BASH_RISK_PATTERNS)
    if tool_name.startswith("mcp__"):
        return bool(MCP_RISK_RE.search(_snake(tool_name.rsplit("__", 1)[-1])))
    return False


def agent_name(payload: dict) -> str:
    name = os.environ.get("MARVEEN_AGENT_NAME")
    if name:
        return name
    cwd = payload.get("cwd")
    if isinstance(cwd, str):
        parts = cwd.split("/")
        for i in range(len(parts) - 2, -1, -1):
            if parts[i] == "agents":
                if parts[i + 1]:
                    return parts[i + 1]
                break
    return "unknown"


def install_setting(root: str, key: str, default: str) -> str:
    """Env first, then the install .env, then the default."""
    v = os.environ.get(key)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    val = line.split("=", 1)[1].strip()
                    if val:
                        return val
    except Exception:  # noqa: BLE001 -- a missing .env just means the default
        pass
    return default


def stop(msg: str):
    sys.stderr.write(msg)
    sys.exit(2)


UNREADABLE = "MASODIK-ELLENOR: a hook bemenete nem olvashato (%s); a hivas nem ment ki.\n"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        stop(UNREADABLE % "nem JSON")
    if not isinstance(payload, dict):
        stop(UNREADABLE % "nem objektum")
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_name, str) or not tool_name:
        stop(UNREADABLE % "nincs tool_name")
    if not isinstance(tool_input, dict):
        tool_input = {}
    if not is_high_risk(tool_name, tool_input):
        sys.exit(0)

    agent = agent_name(payload)
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        url = os.environ.get("SECOND_REVIEWER_URL") or \
            "http://127.0.0.1:%s/api/review-action" % install_setting(root, "WEB_PORT", "3420")
        token_file = os.environ.get("SECOND_REVIEWER_TOKEN_FILE") or \
            os.path.join(root, "store", ".dashboard-token")
        with open(token_file, encoding="utf-8") as fh:
            token = fh.read().strip()
        if not token:
            raise ValueError("ures token")
        body = json.dumps({"agent": agent, "tool_name": tool_name,
                           "tool_input": tool_input}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=75) as resp:
            answer = json.loads(resp.read().decode("utf-8"))
        if not isinstance(answer, dict):
            raise ValueError("ismeretlen valasz")
        decision = answer.get("decision")
        if decision not in ("allow", "deny", "ask"):
            raise ValueError("ismeretlen dontes")
    except Exception as exc:  # noqa: BLE001 -- fail closed
        err = (str(exc) or type(exc).__name__).replace("\n", " ")
        err = err.replace(locals().get("token") or "\0", "***")[:300]
        stop("MASODIK-ELLENOR: a masodik ellenor nem erheto el (%s); a hivas nem ment ki.\n" % err)

    if decision == "allow":
        sys.exit(0)
    if decision == "deny":
        reason = str(answer.get("reason", ""))[:300]
        stop("MASODIK-ELLENOR: TILTVA. A masodik ellenor ezt a hivast nem engedte: %s\n" % reason)
    approval = str(answer.get("approval_id", ""))[:300]
    stop("MASODIK-ELLENOR: A GAZDA JOVAHAGYASARA VAR (approval %s). A hivas nem ment ki. "
         "Ha a gazda jovahagyta, ugyanez a hivas egyszer atmegy; addig ne probald mas alakban.\n" % approval)


if __name__ == "__main__":
    main()
