#!/usr/bin/env python3
"""PostToolUse hook: sync every cloud (claude.ai Artifact tool) publish to the
local artifact DB via POST /api/artifacts.

Triggered when tool_name == "Artifact" and action == "publish".
Always exits 0 so it never blocks or interrupts the agent.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# Extension -> artifact kind mapping (matches ARTIFACT_KINDS in artifacts-db.ts)
_EXT_KIND = {
    '.html': 'html',
    '.htm':  'html',
    '.md':   'markdown',
    '.json': 'json',
    '.txt':  'text',
}
_CLOUD_URL_RE = re.compile(r'https://claude\.ai/[^\s\'"<>]+')


def _project_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _web_port() -> str:
    port = os.environ.get('WEB_PORT')
    if not port:
        try:
            with open(os.path.join(_project_root(), '.env')) as f:
                for line in f:
                    if line.startswith('WEB_PORT='):
                        port = line.split('=', 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or '3420'


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_project_root(), 'store', '.dashboard-token')) as f:
            return f.read().strip()
    except OSError:
        return ''


def _kind_from_path(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return _EXT_KIND.get(ext, 'text')


def _extract_cloud_url(tool_response) -> str:
    """Pull the published cloud URL out of whatever shape tool_response takes."""
    if isinstance(tool_response, dict):
        # Direct field names the Artifact tool may use
        for key in ('url', 'cloud_url', 'artifact_url', 'published_url'):
            val = tool_response.get(key)
            if val and isinstance(val, str) and 'claude.ai' in val and val.startswith('https'):
                return val
        # Recurse into nested dicts (e.g. {result: {url: ...}})
        for val in tool_response.values():
            found = _extract_cloud_url(val)
            if found:
                return found

    if isinstance(tool_response, str):
        m = _CLOUD_URL_RE.search(tool_response)
        if m:
            return m.group(0)

    if isinstance(tool_response, list):
        for item in tool_response:
            found = _extract_cloud_url(item)
            if found:
                return found

    return ''


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get('tool_name') or ''
    if tool_name != 'Artifact':
        sys.exit(0)

    tool_input = payload.get('tool_input') or {}
    action = tool_input.get('action') or 'publish'
    if action != 'publish':
        # list / other actions don't produce a cloud artifact
        sys.exit(0)

    # Error response: don't try to sync a failed publish
    tool_response = payload.get('tool_response')
    if isinstance(tool_response, dict) and tool_response.get('is_error'):
        sys.exit(0)

    cloud_url = _extract_cloud_url(tool_response)
    if not cloud_url:
        # Artifact didn't publish a URL (unlikely but possible for previews/dry runs)
        sys.exit(0)

    file_path = tool_input.get('file_path') or ''
    title = tool_input.get('title') or (os.path.basename(file_path) if file_path else 'Untitled')
    kind = _kind_from_path(file_path)

    content = ''
    if file_path and os.path.isfile(file_path):
        try:
            with open(file_path, encoding='utf-8', errors='replace') as f:
                content = f.read()
        except Exception:
            content = ''

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    cwd = payload.get('cwd') or ''
    agent_id = ledger_lib.agent_id_from_cwd(cwd)

    body = json.dumps({
        'agent_id': agent_id,
        'title':    title,
        'kind':     kind,
        'content':  content,
        'source':   'cloud:artifact',
        'cloud_url': cloud_url,
    }).encode('utf-8')

    port = _web_port()
    url = f'http://localhost:{port}/api/artifacts'
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
    }

    try:
        req = urllib.request.Request(url, data=body, headers=headers, method='POST')
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        # Fail-soft: dashboard may not be running; never block the agent.
        # Log the failure so the heartbeat task can alert if errors accumulate.
        log_path = os.path.join(_project_root(), 'store', 'artifact-sync-errors.log')
        try:
            import datetime
            with open(log_path, 'a') as lf:
                lf.write(f"{datetime.datetime.now().isoformat()} ERROR: {exc}\n")
        except OSError:
            pass  # log-write failure is truly unrecoverable; still must not block

    sys.exit(0)


if __name__ == '__main__':
    main()
