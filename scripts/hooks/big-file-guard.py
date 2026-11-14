#!/usr/bin/env python3
"""PreToolUse hook: block writing an absurdly large single file.

An agent occasionally tries to Write a minified bundle, a generated data blob, or
a pasted artifact straight into the source tree -- which then risks being
committed and bloating the shared checkout. No legitimate hand-authored source
file is multiple megabytes. This guard blocks (exit 2) a single Write whose
content exceeds MAX_BYTES; everything smaller passes untouched.

Deliberately narrow / fail-open:
  - Only the Write tool (which carries full file content). Edit/MultiEdit deltas
    are not size-capped here.
  - Threshold is high (2 MB) so it never trips on real source; it catches the
    blob-into-source mistake, not normal work.
  - Any parse error -> exit 0. A guard bug must never block legitimate writes.
"""
import sys
import os
import json

DEFAULT_MAX_BYTES = 2_000_000  # 2 MB; override with HOOK_MAX_WRITE_BYTES


def _limit():
    raw = os.environ.get("HOOK_MAX_WRITE_BYTES")
    if raw:
        try:
            v = int(raw)
            if v > 0:
                return v
        except Exception:
            pass
    return DEFAULT_MAX_BYTES


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Write":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    content = ti.get("content") if isinstance(ti, dict) else None
    if not isinstance(content, str):
        sys.exit(0)

    try:
        size = len(content.encode("utf-8", errors="ignore"))
    except Exception:
        sys.exit(0)

    limit = _limit()
    if size > limit:
        mb = size / 1_000_000
        sys.stderr.write(
            f"BIG-FILE-GUARD: {mb:.1f} MB-os fajl irasa blokkolva (limit "
            f"{limit/1_000_000:.1f} MB). Ekkora fajl szinte biztosan generalt blob / "
            "minified bundle / beillesztett artifact -- ne kerüljon a forrasfaba. "
            "Ha tenyleg kell, generald build-lepesben, vagy tedd git-ignoralt utvonalra."
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
