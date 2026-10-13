"""
PreToolUse hook: de-anonymize PII markers in outbound reply tool calls.
Fires on: mcp__plugin_telegram_telegram__reply, mcp__plugin_slack_slack__reply,
          mcp__plugin_telegram_telegram__edit_message

Loads the session mapping from ~/.pii-mapper/<session_id>/mapping.json
and replaces markers (SZEMELY_1, EMAIL_1, etc.) with the original values.
If the mapping file does not exist, passes through unchanged.
"""
import json
import os
import re
import sys

MAPPER_BASE = os.path.expanduser("~/.pii-mapper")
COORDINATOR_MAPPING_FILE = os.path.join(MAPPER_BASE, "coordinator", "mapping.json")
PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR", "")


def is_enabled() -> bool:
    env_file = os.path.join(PROJECT_DIR, ".env")
    if not os.path.exists(env_file):
        return False
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith("PII_ANONYMIZE="):
                val = line.split("=", 1)[1].strip().strip('"\'')
                return val.lower() in ("true", "1", "yes")
    return False


def mapping_file(session_id: str) -> str:
    # Claude Code passes session_id in the hook's stdin JSON, not in the env.
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id or "") or "default"
    return os.path.join(MAPPER_BASE, safe, "mapping.json")


def load_mapping(session_id: str) -> dict:
    merged: dict = {}
    # Load coordinator mapping (from channel-coordinator PII pass)
    if os.path.exists(COORDINATOR_MAPPING_FILE):
        try:
            with open(COORDINATOR_MAPPING_FILE) as f:
                merged.update(json.load(f))
        except Exception:
            pass
    # Load session mapping (from inbound hook PII pass) -- session wins on conflict
    path = mapping_file(session_id)
    if os.path.exists(path):
        try:
            with open(path) as f:
                merged.update(json.load(f))
        except Exception:
            pass
    return merged


def deanonymize(text: str, mapping: dict) -> str:
    # Whole-marker match, so SZEMELY_1 never eats the prefix of SZEMELY_10,
    # while a glued Hungarian suffix (SZEMELY_1nek) still resolves.
    return re.sub(
        r"(?<![A-Za-z0-9_])[A-Z]+_\d+(?!\d)",
        lambda m: mapping.get(m.group(0), m.group(0)),
        text,
    )


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        return

    if not is_enabled():
        return

    mapping = load_mapping(data.get("session_id", ""))
    if not mapping:
        return

    tool_input = data.get("tool_input", {})
    changed = False

    # Handle 'text' field (reply, edit_message)
    if "text" in tool_input and isinstance(tool_input["text"], str):
        new_text = deanonymize(tool_input["text"], mapping)
        if new_text != tool_input["text"]:
            tool_input["text"] = new_text
            changed = True

    # Handle 'message' field (some Slack variants)
    if "message" in tool_input and isinstance(tool_input["message"], str):
        new_msg = deanonymize(tool_input["message"], mapping)
        if new_msg != tool_input["message"]:
            tool_input["message"] = new_msg
            changed = True

    # Echoing the payload back changes nothing: a PreToolUse hook rewrites the
    # call only through hookSpecificOutput.updatedInput.
    if changed:
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": tool_input,
            }
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
