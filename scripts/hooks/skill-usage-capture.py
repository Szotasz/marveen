#!/usr/bin/env python3
"""PostToolUse hook: log skill usage to the persistent skill_usage table.

Two event types are captured:
  tool_call  -- the Skill tool was invoked (tool_name == 'Skill')
  skill_read -- a SKILL.md file under ~/.claude/skills/<name>/SKILL.md was Read

Unlike tool_call_log (pruned every 24 h), skill_usage is never pruned so the
dream-engine can make data-driven suggestions after two or more weeks of data.

Registration (user-level ~/.claude/settings.json, post-install step):
  The hook command uses a guard so it silently no-ops if the file is missing
  (e.g. on develop before merging this feature):

    "command": "test -f /path/to/scripts/hooks/skill-usage-capture.py && python3 ... || true"

  This means the hook can be registered before merge without causing errors
  on other branches where the file does not yet exist.
"""
import sys
import os
import re
import json
import urllib.request
import urllib.error


def _install_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_install_dir(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_install_dir(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ""


def _main_agent_id() -> str:
    v = os.environ.get("MAIN_AGENT_ID")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "marveen"


def _agent_id_from_cwd(cwd: str) -> str:
    """Derive agent_id from the session working directory.

    <install>/agents/<id>  -> <id>       (sub-agent: zack, rick, ...)
    <install>               -> MAIN_AGENT_ID
    """
    cwd = (cwd or "").rstrip("/")
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        seg = rel.split(os.sep)[0]
        return seg if seg else _main_agent_id()
    if cwd == install:
        return _main_agent_id()
    base = os.path.basename(cwd)
    return base if base else _main_agent_id()


# ~/.claude/skills/<name>/SKILL.md  (expand ~ for the running user)
_SKILL_MD_RE = re.compile(
    r"^" + re.escape(os.path.expanduser("~")) + r"/\.claude/skills/([^/]+)/SKILL\.md$"
)


def _classify(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    """Return (skill_name, trigger_type) or None if this event is irrelevant."""
    if tool_name == "Skill":
        skill = (tool_input.get("skill") or "").strip()
        if skill:
            return skill, "tool_call"
    elif tool_name == "Read":
        path = (tool_input.get("file_path") or "").strip()
        m = _SKILL_MD_RE.match(path)
        if m:
            return m.group(1), "skill_read"
    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    session_id = payload.get("session_id") or None
    cwd = payload.get("cwd") or ""

    result = _classify(tool_name, tool_input)
    if result is None:
        sys.exit(0)

    skill_name, trigger_type = result
    agent_id = _agent_id_from_cwd(cwd)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    body = json.dumps({
        "agent_id": agent_id,
        "skill_name": skill_name,
        "trigger_type": trigger_type,
        "session_id": session_id,
    }).encode()

    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f"http://localhost:{_web_port()}/api/skill-usage",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                },
                method="POST",
            ),
            timeout=3,
        )
    except Exception:
        pass  # never block the agent

    sys.exit(0)


if __name__ == "__main__":
    main()
