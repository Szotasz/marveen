#!/usr/bin/env python3
"""UserPromptSubmit hook: drain sub-agent Telegram channel notifications.

Telegram sub-agents load the official channel plugin as a plain MCP server to
avoid the plugin in_use lock. Claude Code ignores that server's channel
notifications, so scripts/channel-inbound-tee.mjs persists them to a local JSONL
inbox. This hook pulls that local queue into the next prompt, using the same
<channel> framing the --channels path would have produced.

This template is shared with the main agent. Main --channels sessions already
receive notifications directly, and they normally do not have TELEGRAM_STATE_DIR
set to a per-agent channel directory; when no local derived inbox exists this
hook exits silently. All errors are fail-open so prompt submission is never
blocked.
"""
import glob
import html
import json
import os
import sys
import tempfile


PREFIX = "[Telegram inbox drain -- %d fuggoben levo uzenet erkezett mikozben a session masszal foglalkozott:]"


def _load_payload():
    try:
        return json.load(sys.stdin)
    except Exception:
        return None


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
    try:
        drain(payload)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
