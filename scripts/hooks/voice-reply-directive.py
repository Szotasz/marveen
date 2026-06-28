#!/usr/bin/env python3
"""UserPromptSubmit hook: voice-reply directive injection + server-side STT.

When a voice message is delivered to a voice/auto-mode agent, this hook:
  1. Passes the attachment_file_id to /api/voice/directive so the server
     transcribes the audio (faster-whisper, no Bash/whisper permission needed).
  2. Injects "[Hang átirat]: <text>" into the prompt when a transcript is returned.
  3. Injects the TTS curl directive so the agent knows to reply with voice.

Claude Code delivers stdout from UserPromptSubmit hooks directly into the model
prompt (no JSON wrapper needed -- plain text is injected as-is). This hook
stays completely silent for non-voice messages.

Never raises: any error results in a silent exit(0) so the prompt is never blocked.
"""
import sys
import os
import json
import re
import urllib.request
import urllib.parse


def _project_root():
    # scripts/hooks/ -> project root (two dirs up)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_project_root(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"\'')
                        break
        except Exception:
            pass
    return port or "3420"


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except Exception:
        return ""


def _main_agent_id():
    """Read MAIN_AGENT_ID from .env; fall back to 'marveen'."""
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip().strip('"\'')
    except Exception:
        pass
    return "marveen"


def _agent_id(cwd):
    if not cwd:
        return None
    parts = os.path.normpath(cwd).split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    # Fallback: if cwd is the project root itself (main agent session),
    # use MAIN_AGENT_ID so voice config and state_dir resolve correctly.
    project_root = os.path.normpath(_project_root())
    if os.path.normpath(cwd) == project_root:
        return _main_agent_id()
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    prompt = payload.get("prompt") or ""

    # Gate: only fire for channel-inbound messages (has chat_id).
    # Inter-agent prompts and non-channel input have no chat_id -- skip those.
    # (voice-mode agents must reply with audio even to plain text input, so we
    # cannot gate on attachment_kind="voice" here.)
    m = re.search(r'\bchat_id="(\d+)"', prompt)
    if not m:
        sys.exit(0)
    chat_id = m.group(1)

    # Extract attachment_file_id if present (only set for voice attachments).
    # Passed to the endpoint so STT runs server-side when a voice file is attached.
    m_file = re.search(r'\battachment_file_id="([^"]+)"', prompt)
    file_id = m_file.group(1) if m_file else None

    agent_id = _agent_id(payload.get("cwd"))
    if not agent_id:
        sys.exit(0)

    token = _token()
    if not token:
        sys.exit(0)

    port = _web_port()
    url = "http://localhost:%s/api/voice/directive?agent=%s&chat=%s" % (port, agent_id, chat_id)
    if file_id:
        url += "&file=" + urllib.parse.quote(file_id, safe="")

    try:
        req = urllib.request.Request(url)
        req.add_header("Authorization", "Bearer " + token)
        with urllib.request.urlopen(req, timeout=55) as r:
            data = json.load(r)
    except Exception:
        sys.exit(0)  # dashboard unavailable -- fail-safe, no injection

    transcript = data.get("transcript")
    if transcript:
        sys.stdout.write("\n[Hang átirat]: " + transcript + "\n")
        sys.stdout.flush()

    directive = data.get("directive")
    if directive:
        sys.stdout.write(directive)
        sys.stdout.flush()

    sys.exit(0)


if __name__ == "__main__":
    main()
