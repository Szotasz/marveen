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


def env_file_value(root: str, key: str):
    """The install .env's value of `key` as src/env-parse.ts reads it: the LAST
    matching line wins, the value is trimmed and ONE pair of surrounding quotes
    is stripped; None when absent or unreadable. Never os.environ
    (ENVRELAXGATE1104 step 2): the hook runs in the reviewed agent's own
    environment, which must not choose where the review goes."""
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as fh:
            content = fh.read()
    except Exception:  # noqa: BLE001 -- a missing .env just means the default
        return None
    found = None
    for line in content.split("\n"):
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        if k.strip() != key:
            continue
        v = v.strip()
        if v[:1] in ('"', "'") and v.endswith(v[:1]):
            v = v[1:-1]
        found = v
    return found


DEFAULT_WEB_PORT = "3420"


def web_port(root: str) -> str:
    """The dashboard port from the install .env: 1-65535, else the default."""
    v = env_file_value(root, "WEB_PORT")
    if v is None or not re.fullmatch(r"[0-9]{1,5}", v) or not 1 <= int(v) <= 65535:
        return DEFAULT_WEB_PORT
    return str(int(v))


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
        # The review always goes to this install's own dashboard with its own token
        # (ENVRELAXGATE1104 step 2): no environment variable may redirect it.
        url = "http://127.0.0.1:%s/api/review-action" % web_port(root)
        token_file = os.path.join(root, "store", ".dashboard-token")
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
