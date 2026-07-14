#!/usr/bin/env python3
"""UserPromptSubmit hook: drain sub-agent Telegram channel notifications.

Telegram sub-agents load the official channel plugin as a plain MCP server to
avoid the plugin in_use lock. Claude Code ignores that server's channel
notifications, so scripts/channel-inbound-tee.mjs persists them to a local JSONL
inbox. This hook pulls that local queue into the next prompt, using the same
<channel> framing the --channels path would have produced.

Sub-agents ONLY: the main agent runs with --channels and receives notifications
directly; it has no local derived inbox. An agent_id/cwd guard (mirroring
inbox-drain.py) exits silently when called from the main session so the hook can
safely be installed in both agent profiles without double-delivering to the main
agent. All errors are fail-open so prompt submission is never blocked.
"""
import glob
import html
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import ledger_lib  # noqa: E402
    _HAS_LEDGER = True
except ImportError:
    _HAS_LEDGER = False


PREFIX = "[Telegram inbox drain -- %d fuggoben levo uzenet erkezett mikozben a session masszal foglalkozott:]"


def _load_payload():
    try:
        return json.load(sys.stdin)
    except Exception:
        return None


def _is_main_session(payload):
    """Return True when running inside the main agent session.

    Resolution order (mirrors inbox-drain.py / ledger_lib.agent_id_from_cwd):
    1. ledger_lib.agent_id_from_cwd + main_agent_id() comparison (preferred).
    2. Fallback: MAIN_AGENT_ID env var vs cwd-derived agent name.
    """
    cwd = (payload or {}).get("cwd") or ""
    if _HAS_LEDGER:
        try:
            agent_id = ledger_lib.agent_id_from_cwd(cwd)
            return agent_id == ledger_lib.main_agent_id()
        except Exception:
            pass
    # Fallback without ledger_lib: cwd inside agents/<name>/ means sub-agent.
    main_id = os.environ.get("MAIN_AGENT_ID", "")
    if not cwd or not main_id:
        return False
    agents_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(cwd))), "agents")
    return not cwd.startswith(agents_dir)


def _state_dir(payload):
    env_dir = os.environ.get("TELEGRAM_STATE_DIR")
    if env_dir:
        return env_dir
    cwd = ""
    if isinstance(payload, dict):
        cwd = payload.get("cwd") or ""
    if not cwd:
        return ""
    return os.path.join(cwd, ".claude", "channels", "telegram")


def _claim_one(state_dir):
    pending = os.path.join(state_dir, "inbox-pending.jsonl")
    draining = sorted(
        glob.glob(os.path.join(state_dir, "inbox-draining-*.jsonl")),
        key=lambda p: (os.path.getmtime(p), p),
    )
    for path in draining + [pending]:
        try:
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                continue
            if os.path.basename(path).startswith("inbox-draining-"):
                return path
            claimed = os.path.join(state_dir, "inbox-draining-%d.jsonl" % os.getpid())
            os.rename(path, claimed)
            return claimed
        except FileNotFoundError:
            return None
        except Exception:
            return None
    return None


def _attr(value):
    return html.escape(str(value), quote=True)


def _format_entry(entry):
    params = entry.get("params") if isinstance(entry, dict) else None
    if not isinstance(params, dict):
        return None
    meta = params.get("meta") if isinstance(params.get("meta"), dict) else {}
    content = params.get("content")
    if content is None:
        content = ""
    body = str(content).replace("</channel>", "")

    attrs = [('source', 'telegram')]
    for key in ("chat_id", "message_id", "user", "ts", "image_path"):
        if key in meta and meta.get(key) is not None:
            attrs.append((key, meta.get(key)))
    for key in sorted(meta.keys()):
        if key.startswith("attachment_") and meta.get(key) is not None:
            attrs.append((key, meta.get(key)))

    attr_text = " ".join('%s="%s"' % (key, _attr(value)) for key, value in attrs)
    return "<channel %s>%s</channel>" % (attr_text, body)


def _read_entries(path):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                formatted = _format_entry(json.loads(line))
                if formatted:
                    out.append(formatted)
            except Exception:
                continue
    return out


def drain(payload):
    state_dir = _state_dir(payload)
    if not state_dir or not os.path.isdir(state_dir):
        return ""
    claimed = _claim_one(state_dir)
    if not claimed:
        return ""

    entries = _read_entries(claimed)
    if not entries:
        try:
            os.unlink(claimed)
        except Exception:
            pass
        return ""

    text = PREFIX % len(entries) + "\n" + "\n".join(entries)
    sys.stdout.write(text)
    sys.stdout.write("\n")
    os.unlink(claimed)
    return text


def self_test():
    with tempfile.TemporaryDirectory() as td:
        state = os.path.join(td, ".claude", "channels", "telegram")
        os.makedirs(state)
        pending = os.path.join(state, "inbox-pending.jsonl")
        entries = [
            {
                "receivedAt": 1,
                "params": {
                    "content": "hello </channel> world",
                    "meta": {
                        "chat_id": "c1",
                        "message_id": "m1",
                        "user": "u1",
                        "ts": "123",
                        "image_path": "/tmp/img.png",
                        "attachment_0_name": "a.png",
                    },
                },
            },
            {"receivedAt": 2, "params": {"content": "second", "meta": {"chat_id": "c2"}}},
        ]
        with open(pending, "w", encoding="utf-8") as f:
            f.write(json.dumps(entries[0]) + "\n")
            f.write("{malformed\n")
            f.write(json.dumps(entries[1]) + "\n")

        old_stdout = sys.stdout
        capture = tempfile.TemporaryFile("w+", encoding="utf-8")
        try:
            sys.stdout = capture
            os.environ["TELEGRAM_STATE_DIR"] = state
            drain({"cwd": td})
            capture.seek(0)
            out = capture.read()
        finally:
            sys.stdout = old_stdout
            os.environ.pop("TELEGRAM_STATE_DIR", None)
            capture.close()

        assert "2 fuggoben levo uzenet" in out
        assert "hello  world</channel>" in out
        assert out.count("<channel ") == 2
        assert 'image_path="/tmp/img.png"' in out
        assert 'attachment_0_name="a.png"' in out
        assert not os.path.exists(pending)
        assert not glob.glob(os.path.join(state, "inbox-draining-*.jsonl"))
    print("channel-inbox-drain self-test passed")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        sys.exit(0)
    payload = _load_payload()
    if payload is None:
        sys.exit(0)
    # Sub-agents only: the main agent receives Telegram via --channels directly.
    if _is_main_session(payload):
        sys.exit(0)
    try:
        drain(payload)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
