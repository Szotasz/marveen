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

SESSION_ID = os.environ.get("CLAUDE_SESSION_ID", "default")
MAPPER_BASE = os.path.expanduser("~/.pii-mapper")
MAPPING_FILE = os.path.join(MAPPER_BASE, SESSION_ID, "mapping.json")
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


def load_mapping() -> dict:
    merged: dict = {}
    # Load coordinator mapping (from channel-coordinator PII pass)
    if os.path.exists(COORDINATOR_MAPPING_FILE):
        try:
            with open(COORDINATOR_MAPPING_FILE) as f:
                merged.update(json.load(f))
        except Exception:
            pass
    # Load session mapping (from inbound hook PII pass) -- session wins on conflict
    if os.path.exists(MAPPING_FILE):
        try:
            with open(MAPPING_FILE) as f:
                merged.update(json.load(f))
        except Exception:
            pass
    return merged


def deanonymize(text: str, mapping: dict) -> str:
    # Sort by marker length descending to handle SZEMELY_10 before SZEMELY_1
    for marker, original in sorted(mapping.items(), key=lambda kv: -len(kv[0])):
        text = text.replace(marker, original)
    return text


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        sys.stdout.write(raw)
        return

    if not is_enabled():
        sys.stdout.write(raw)
        return

    mapping = load_mapping()
    if not mapping:
        sys.stdout.write(raw)
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

    if changed:
        data["tool_input"] = tool_input
        sys.stdout.write(json.dumps(data, ensure_ascii=False))
    else:
        sys.stdout.write(raw)


if __name__ == "__main__":
    main()
