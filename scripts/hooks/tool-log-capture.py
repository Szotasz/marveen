#!/usr/bin/env python3
"""PostToolUse hook: log every tool call to /api/tool-log for the activity dashboard."""
import sys
import os
import json
import urllib.request
import urllib.error


def _dashboard_token() -> str:
    token_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'store', '.dashboard-token')
    try:
        with open(os.path.normpath(token_path)) as f:
            return f.read().strip()
    except OSError:
        return ''


def _input_summary(tool_input: dict, tool_name: str) -> str:
    """Build a short human-readable summary of the tool input."""
    if not tool_input:
        return ''
    if tool_name in ('Bash', 'bash'):
        return str(tool_input.get('command', ''))[:200]
    if tool_name in ('Read', 'Write', 'Edit'):
        return str(tool_input.get('file_path', ''))[:200]
    if tool_name in ('WebFetch', 'WebSearch'):
        return str(tool_input.get('url', tool_input.get('query', '')))[:200]
    # Generic fallback: first string value found
    for v in tool_input.values():
        if isinstance(v, str):
            return v[:200]
    return ''


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = payload.get('session_id') or ''
    tool_name = payload.get('tool_name') or ''
    tool_input = payload.get('tool_input') or {}
    success = not bool(payload.get('tool_response', {}).get('is_error') if isinstance(payload.get('tool_response'), dict) else False)

    if not session_id or not tool_name:
        sys.exit(0)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    body = json.dumps({
        'session_id': session_id,
        'tool_name': tool_name,
        'input_summary': _input_summary(tool_input, tool_name),
        'success': success,
    }).encode()

    req = urllib.request.Request(
        'http://localhost:3420/api/tool-log',
        data=body,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method='POST',
    )
    try:
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass  # never block the agent

    sys.exit(0)


if __name__ == '__main__':
    main()
