#!/usr/bin/env python3
"""
PreCompact hook: detect skill-worthy sessions and generate a SKILL.md draft.

Threshold (any one is sufficient):
  - tool_use count >= 5
  - ToolUseFailure followed by a successful tool call (error->recovery)
  - User correction keywords detected (Hungarian + English)

On threshold hit: calls `claude --print` with a compact session summary,
saves the draft to agents/<agent>/.claude/skills/auto-discovered/<ts>-draft.md,
and posts an inter-agent message to jarvis.

Always exits 0 -- hook must never block the compaction.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime

MARVEEN_ROOT = "/Users/jonasgergo/marveen"
DASHBOARD_TOKEN_PATH = os.path.join(MARVEEN_ROOT, "store/.dashboard-token")
DASHBOARD_URL = "http://localhost:3420"

# Hungarian + English correction patterns
CORRECTION_KEYWORDS = [
    "ne csináld", "ne csinald", "ne tedd", "ne add", "ne írj", "ne irj",
    "ne így", "ne igy", "stop doing", "don't do", "don't use",
    "wrong", "incorrect", "that's wrong", "not right",
    "javítsd", "javitsd", "nem ezt", "rossz", "hibás", "hibas",
    "no,", "wait,", "actually,", "nem jó", "nem jo",
]


def _text_from_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _count_tool_uses(history: list) -> int:
    count = 0
    for msg in history:
        content = msg.get("content", [])
        if isinstance(content, list):
            count += sum(1 for b in content if isinstance(b, dict) and b.get("type") == "tool_use")
    return count


def _has_error_recovery(history: list) -> bool:
    saw_error = False
    for msg in history:
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                if block.get("is_error"):
                    saw_error = True
                elif saw_error:
                    return True
    return False


def _has_user_correction(history: list) -> bool:
    for msg in history:
        if msg.get("role") != "user":
            continue
        text = _text_from_content(msg.get("content", "")).lower()
        if any(kw in text for kw in CORRECTION_KEYWORDS):
            return True
    return False


def _threshold_met(history: list) -> tuple[bool, str]:
    tool_count = _count_tool_uses(history)
    if tool_count >= 5:
        return True, f"tool_use={tool_count}"
    if _has_error_recovery(history):
        return True, "error->recovery"
    if _has_user_correction(history):
        return True, "user-correction"
    return False, ""


def _session_extract(history: list) -> str:
    first_user = ""
    last_assistant = ""

    for msg in history:
        role = msg.get("role", "")
        text = _text_from_content(msg.get("content", ""))
        if role == "user" and not first_user and len(text) > 10:
            first_user = text[:300]
        elif role == "assistant" and text:
            last_assistant = text[:300]

    parts = []
    if first_user:
        parts.append(f"Initial task: {first_user}")
    if last_assistant:
        parts.append(f"Last assistant output: {last_assistant}")
    return "\n".join(parts)


def _get_agent_name(cwd: str) -> str:
    m = re.search(r"/agents/([^/]+)(?:/|$)", cwd)
    if m:
        return m.group(1)
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")
    m2 = re.search(r"/agents/([^/]+)/", config_dir)
    if m2:
        return m2.group(1)
    return "jarvis"


def _draft_path(agent_name: str) -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    if agent_name == "jarvis":
        base = os.path.expanduser("~/.claude/skills/auto-discovered")
    else:
        base = os.path.join(MARVEEN_ROOT, "agents", agent_name, ".claude", "skills", "auto-discovered")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f"{ts}-draft.md")


def _run_claude(prompt: str) -> str:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        for candidate in [
            "/usr/local/bin/claude",
            os.path.expanduser("~/.local/bin/claude"),
            "/opt/homebrew/bin/claude",
        ]:
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                claude_bin = candidate
                break
    if not claude_bin:
        return ""

    # Isolate from the agent's CLAUDE_CONFIG_DIR so the print call uses the
    # user's default config (avoids restricted per-agent settings).
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
    try:
        result = subprocess.run(
            [claude_bin, "--print", prompt],
            capture_output=True,
            text=True,
            timeout=90,
            env=env,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def _notify_jarvis(agent_name: str, draft_path: str, reason: str) -> None:
    try:
        token = open(DASHBOARD_TOKEN_PATH).read().strip()
    except Exception:
        return
    content = (
        f"[auto-skillify] {agent_name}: skill draft generálva ({reason})\n"
        f"Draft: {draft_path}\n"
        "Átnézés után patch-elhető vagy globális skillbe mozgatható."
    )
    payload = json.dumps({"from": agent_name, "to": "jarvis", "content": content})
    try:
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/messages",
            data=payload.encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    # Only trigger on automatic compaction
    if payload.get("trigger") != "auto":
        sys.exit(0)

    history = payload.get("conversation_history", [])
    met, reason = _threshold_met(history)
    if not met:
        sys.exit(0)

    cwd = os.getcwd()
    agent_name = _get_agent_name(cwd)
    tool_count = _count_tool_uses(history)
    session_extract = _session_extract(history)

    skill_prompt = f"""Generate a SKILL.md draft for a reusable skill based on this session.
Return ONLY the SKILL.md file content -- no prose, no explanation.

Session info:
- Agent: {agent_name}
- Tool calls made: {tool_count}
- Trigger: {reason}

{session_extract}

Output format (fill in all sections, keep under 200 lines):
---
name: [kebab-case-name]
description: [what it does; include multiple concrete trigger phrases so the skill activates reliably]
---

# [Skill Name]

## When to Use
[Concrete trigger conditions and contexts]

## Procedure
1. [First step with exact commands]
2. [Continue...]

## Pitfalls
- **[Problem]**: [How to solve it]

## Verification
- [How to confirm the result is correct]"""

    draft_content = _run_claude(skill_prompt)
    if not draft_content:
        sys.exit(0)

    draft_path = _draft_path(agent_name)
    try:
        with open(draft_path, "w") as f:
            f.write(draft_content)
    except Exception:
        sys.exit(0)

    _notify_jarvis(agent_name, draft_path, reason)
    sys.exit(0)


if __name__ == "__main__":
    main()
