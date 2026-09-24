#!/usr/bin/env python3
"""PostToolUse + PostToolUseFailure hook: log every tool call to /api/tool-log
for the activity dashboard.

TWO EVENTS, ONE SCRIPT (TOOLLOGVAKSIKER921, measured 2026-09-21 on Claude Code
2.1.278): a tool call that FAILS does not fire PostToolUse at all. It fires
PostToolUseFailure, whose payload carries an `error` string and `is_interrupt`
and has NO `tool_response`. A hook registered under PostToolUse alone therefore
never sees a failure -- it is not that failures were logged as success=1, they
were not logged at all (2948/2948 rows success=1 in the whole history, while
two exit-1 calls from the same session had no row). The `success` column is
derived from `hook_event_name` first: PostToolUseFailure -> 0. The older
`tool_response.is_error` check is kept as a second signal for tool families
that report an error inside a successful PostToolUse payload; a plain Bash
success payload has only stdout/stderr/interrupted/isImage/noOutputExpected.

REGISTRATION IS PER-AGENT, WITH ONE EXCEPTION THAT IS NOT A LEAK TO FIX BY
MOVING FILES. This hook is shipped in templates/settings.json.template, which
ensureAgentHooks merges into the file agentSettingsPath(name) returns. For a
sub-agent that is the agent's OWN settings.json
(agents/<name>/.claude/settings.json). For MAIN_AGENT_ID that function returns
~/.claude/settings.json (agent-scaffold.ts), and web.ts starts the scaffold
loop with the main agent -- so on the owner's machine this entry DOES sit in
the global settings file, and every Claude Code session started there loads it,
including the owner's own sessions. That is the current, measured behaviour:
skill-usage-capture.py already rides the same PostToolUse path in that same
file. Do not read the per-agent placement as a filter on who gets logged.

What the per-agent placement does buy is scope on OTHER machines and for
sub-agents: a session that never loads a given agent's settings.json never
reaches this hook under that agent's name. If the owner's own sessions must be
kept out of tool_call_log, the filter belongs IN this hook (identity is already
resolved below, so the check is cheap) and needs a test -- moving the entry
between settings files will not do it, because the main agent's settings file
IS the global one.

Identity comes from ledger_lib.agent_id_from_payload (LEDGERCWD828 / #1100):
the session transcript path first, then MARVEEN_AGENT_ID, then cwd. The
transcript path is fixed when the session starts, so an agent that later cds
into another repo (devy working in molyo) still logs under its own name --
measured 2026-08-29, both branches.
"""
import sys
import os
import json
import re
import random
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


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
#
# TOOLLOGREDACT924: the first version let 4 measured shapes through (Boni, #1533
# review, on formatted fabricated secrets): a QUOTED value (`KEY="sbp_..."`, the
# PATSZIVARGAS912 shape), a SPACE-separated flag (`--token sbp_...`), a JWT after
# a `*_KEY=` name the generic key list did not know, and `Authorization: Basic`.
# Same review, same pattern set asked of the TS twin (#1533, tool-input-preview):
# quoted values, spaced flags, any `*KEY` / `*TOKEN` / `*SECRET` / `*PASSWORD`
# name, a bare JWT, the sbp_ / gho_ / ghs_ / ghu_ / ghr_ / github_pat_ prefixes,
# Basic auth, and credentials embedded in a URL. A value that is a shell
# variable (`$X`, `${X}`, `$(...)`) is a reference, not a secret, and is kept so
# the log stays readable. `-p X` is deliberately NOT a flag here: `mkdir -p`,
# `ssh -p 22`, `psql -p 5432` would all be redacted for nothing.
# Group 1, when present, is kept (the label); the rest of the match is replaced.
_SECRET_PATTERNS = [
    # Bearer / Basic authorization values
    re.compile(r'(?i)(\b(?:bearer|basic)\s+)[A-Za-z0-9+/=_\-\.]{8,}'),
    # Credentials embedded in a URL: https://user:pass@host and https://token@host
    re.compile(r'(?i)(\bhttps?://)(?!\$)[^/\s:@]+:[^/\s@]+(?=@)'),
    re.compile(r'(?i)(\bhttps?://)[A-Za-z0-9_\-]{20,}(?=@)'),
    # Spaced or = flags: --token X, --password 'X', --api-key=X ...
    re.compile(r'(?i)(--(?:token|password|passwd|api-key|apikey|access-token|auth-token|secret)(?:\s+|=)[\'"]?)(?!\$)[^\s\'"]{6,}'),
    # key=value / key: value, the value quoted or not, the key any name ending in
    # a secret word (SERVICE_ROLE_KEY=, GITHUB_TOKEN=, "password": ...)
    re.compile(r'(?i)(\b\w*(?:token|secret|passw(?:or)?d|api[_\-]?key|apikey|auth|credential|_key)[\'"]?\s*[=:]\s*[\'"]?)(?!\$)[^\s,\'";&|]{6,}'),
    # Known token prefixes (the prefix is kept as the label)
    re.compile(r'\b(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sbp_|sk-ant-|sk-|xoxb-|xoxp-|xapp-)[A-Za-z0-9_\-]{10,}'),
    # A JWT anywhere (header.payload.signature)
    re.compile(r'\beyJ[\w\-]{8,}\.eyJ[\w\-]{8,}\.[\w\-]{8,}'),
    # Raw hex blobs >= 32 chars (likely hashed secrets) -- no capture group, full match replaced
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


def _success_from_payload(payload: dict) -> bool:
    """False for a PostToolUseFailure event, or for a PostToolUse payload whose
    tool_response carries is_error; True otherwise. The event name is the
    primary signal -- a failed Bash call never reaches PostToolUse."""
    if payload.get('hook_event_name') == 'PostToolUseFailure':
        return False
    tr = payload.get('tool_response')
    if isinstance(tr, dict) and tr.get('is_error'):
        return False
    return True


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    session_id = payload.get('session_id') or ''
    tool_name = payload.get('tool_name') or ''
    tool_input = payload.get('tool_input') or {}
    cwd = payload.get('cwd') or ''
    # CC provides tool_use_id (stable per-call ID shared with PreToolUse) and
    # duration_ms (native wall-clock measurement, more accurate than hook-side
    # timestamps because it excludes hook overhead).
    tool_use_id = payload.get('tool_use_id') or None
    duration_ms = payload.get('duration_ms')
    if not isinstance(duration_ms, int):
        duration_ms = None
    success = _success_from_payload(payload)

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
        'agent_id': ledger_lib.agent_id_from_payload(payload),
        # trace_id holds the CC-native tool_use_id: stable, unique per call,
        # present in both Pre and PostToolUse payloads (empirically verified).
        # No PreToolUse hook needed -- CC already gives us the correlation key
        # and the latency measurement in one place.
        'trace_id': tool_use_id,
        'duration_ms': duration_ms,
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
