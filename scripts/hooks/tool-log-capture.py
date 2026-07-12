#!/usr/bin/env python3
"""PostToolUse hook: log every tool call to /api/tool-log for the activity dashboard."""
import sys
import os
import json
import re
import random
import urllib.request
import urllib.error


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port() -> str:
    # Config-driven: WEB_PORT env, else .env file, default 3420.
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_project_root(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ''


# Patterns that could reveal secrets if stored verbatim.
_SECRET_PATTERNS = [
    # Bearer / Authorization headers
    re.compile(r'(?i)(bearer\s+)[A-Za-z0-9+/=_\-\.]{8,}'),
    # Generic key=value / key: value pairs
    re.compile(r'(?i)((?:token|secret|password|api[_\-]?key|apikey|auth|credential)\s*[=:]\s*)[^\s,\'";&|]{6,}'),
    # GitHub/Anthropic/OpenAI style tokens
    re.compile(r'\b(ghp_|sk-|sk-ant-|xoxb-|xoxp-)[A-Za-z0-9_\-]{10,}'),
    # Raw hex blobs ≥ 32 chars (likely hashed secrets) -- no capture group, full match replaced
    re.compile(r'\b[0-9a-fA-F]{32,}\b'),
]


def _redact(text: str) -> str:
    """Replace potential secret values with [REDACTED]."""
    for pat in _SECRET_PATTERNS:
        # Keep any leading label group (group 1), replace the secret part
        if pat.groups:
            text = pat.sub(lambda m: (m.group(1) if m.lastindex and m.lastindex >= 1 else '') + '[REDACTED]', text)
        else:
            text = pat.sub('[REDACTED]', text)
    return text


def _input_summary(tool_input: dict, tool_name: str) -> str:
    """Build a short human-readable summary of the tool input, secrets redacted."""
    if not tool_input:
        return ''
    if tool_name in ('Bash', 'bash'):
        return _redact(str(tool_input.get('command', ''))[:400])[:200]
    if tool_name in ('Read', 'Write', 'Edit'):
        return str(tool_input.get('file_path', ''))[:200]
    if tool_name in ('WebFetch', 'WebSearch'):
        return _redact(str(tool_input.get('url', tool_input.get('query', '')))[:400])[:200]
    # Generic fallback: first string value found
    for v in tool_input.values():
        if isinstance(v, str):
            return _redact(v[:400])[:200]
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

    port = _web_port()
    base_url = f'http://localhost:{port}/api'

    body = json.dumps({
        'session_id': session_id,
        'tool_name': tool_name,
        'input_summary': _input_summary(tool_input, tool_name),
        'success': success,
    }).encode()

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
    }

    try:
        urllib.request.urlopen(
            urllib.request.Request(f'{base_url}/tool-log', data=body, headers=headers, method='POST'),
            timeout=3,
        )
    except Exception:
        pass  # never block the agent

    # Prune old entries with ~1% probability to keep the table from growing indefinitely.
    if random.random() < 0.01:
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    f'{base_url}/tool-log/prune',
                    data=b'{}',
                    headers=headers,
                    method='POST',
                ),
                timeout=3,
            )
        except Exception:
            pass

    sys.exit(0)


if __name__ == '__main__':
    main()
