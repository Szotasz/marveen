#!/usr/bin/env python3
"""
UserPromptSubmit hook — Telegram "processing" indicator.

When an inbound Telegram channel message is delivered to the agent, this:
  1) reacts with ✍️ on the user's message (a persistent "received" marker), and
  2) posts a "✍️ Dolgozom rajta…" placeholder message,
then records the placeholder id so the Stop hook can delete it when the turn
ends. This is the honest alternative to a "typing…" action (which only lasts
~5s and lies, since the model is thinking, not typing).

MUST stay silent on stdout — stdout from UserPromptSubmit is injected into the
model prompt. All diagnostics go to a debug log file under the state dir.

Token/state dir resolution mirrors the telegram plugin: honor TELEGRAM_STATE_DIR
(set per-agent), else default to ~/.claude/channels/telegram. This keeps the
hook correct even if installed globally across agents with different bots.
"""
import sys, os, json, re, urllib.request

PLACEHOLDER = "✍️ Dolgozom rajta…"   # ✍️ Dolgozom rajta…
REACTION = "✍️"                            # ✍️


def state_dir():
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    return os.path.expanduser("~/.claude/channels/telegram")


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def claim(progress_dir, sid, src_mid):
    """Atomic per-inbound-message guard. Returns True if THIS invocation claimed
    the message (proceed), False if another already did (skip). Prevents double
    placeholders if the hook is ever registered at two scopes (global + project)
    that both fire for the same prompt. O_EXCL makes the claim race-safe."""
    if not src_mid:
        return True
    try:
        os.makedirs(progress_dir, exist_ok=True)
        marker = os.path.join(progress_dir, f"seen-{sid}-{src_mid}.marker")
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except Exception:
        return True  # never let the guard block the indicator


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        return
    prompt = ev.get("prompt") or ""
    sid = ev.get("session_id") or "default"
    sd = state_dir()

    blocks = re.findall(r'<channel\b[^>]*\bsource="[^"]*telegram[^"]*"[^>]*>', prompt)
    if not blocks:
        return  # not a telegram turn — stay silent
    log(sd, f"[submit] sid={sid} blocks={len(blocks)} state_dir={sd}")

    tok = token(sd)
    if not tok:
        log(sd, "[submit] no token found")
        return

    pending = []
    for b in blocks:
        cid = re.search(r'\bchat_id="([^"]+)"', b)
        mid = re.search(r'\bmessage_id="([^"]+)"', b)
        if not cid:
            continue
        chat_id = cid.group(1)
        src_mid = mid.group(1) if mid else None
        # Dedup: skip if a sibling invocation already handled this inbound msg.
        if not claim(os.path.join(sd, "progress"), sid, src_mid):
            log(sd, f"[submit] dedup skip src={src_mid}")
            continue
        # Note: no reaction on the user's message — the "Dolgozom rajta…"
        # placeholder already signals receipt, so a reaction would be redundant
        # (per user preference 2026-06-07).
        try:
            resp = api(tok, "sendMessage", {"chat_id": chat_id, "text": PLACEHOLDER})
            pmid = resp.get("result", {}).get("message_id")
            if pmid:
                pending.append({"chat_id": chat_id, "message_id": pmid})
        except Exception as e:
            log(sd, f"[submit] placeholder failed: {e}")

    if pending:
        path = os.path.join(sd, "progress", f"{sid}.json")
        old = []
        try:
            old = json.load(open(path))
        except Exception:
            old = []
        try:
            json.dump(old + pending, open(path, "w"))
            log(sd, f"[submit] stored {len(pending)} placeholder(s)")
        except Exception as e:
            log(sd, f"[submit] store failed: {e}")


if __name__ == "__main__":
    main()
