#!/usr/bin/env python3
"""Behaviour test for e39b8f7b: a failed sendVoice must say WHY.

WHAT THIS MEASURES, and why it is not a source match: the old code called
``urlopen`` with no handler, so a 4xx surfaced as ``HTTP Error 400: Bad
Request`` and Telegram's own ``description`` -- the only string that says
whether the chat is wrong, the voice is forbidden, or the file is empty -- was
never read. Asserting that a ``try/except`` appears in the file would not prove
the description reaches the caller. These tests drive ``_post_voice`` with an
injected ``HTTPError`` and read the message that comes out.

NO NETWORK AND NO TOKEN. The live 400 against the real API is the infra's
measurement (the card says so); this file covers the part that must hold on
every machine, deterministically.

Run: python3 scripts/voice/test_vtools_send_errors.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("_vtools_under_test", os.path.join(HERE, "_vtools.py"))
vt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vt)

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print("ok   - %s" % name)
    else:
        FAILS.append(name)
        print("FAIL - %s%s" % (name, ("  :: " + detail) if detail else ""))


def http_error(code: int, body: bytes) -> urllib.error.HTTPError:
    # The URL carries the bot token in real life; a placeholder here keeps the
    # test honest about that (see the token-leak check below).
    return urllib.error.HTTPError(
        "https://api.telegram.org/botSECRET-TOKEN-123/sendVoice",
        code, "Bad Request", {}, io.BytesIO(body),
    )


def ogg_with(nbytes: int) -> str:
    fd, path = tempfile.mkstemp(suffix=".ogg")
    with os.fdopen(fd, "wb") as f:
        f.write(b"\0" * nbytes)
    return path


class Recorder:
    """Stands in for urlopen; records whether it was called at all."""

    def __init__(self, raises=None, returns=None):
        self.calls = 0
        self._raises = raises
        self._returns = returns

    def __call__(self, req, timeout=None):
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return io.BytesIO(json.dumps(self._returns).encode())


def run() -> None:
    real_urlopen = vt.urllib.request.urlopen
    ogg = ogg_with(64)
    empty = ogg_with(0)
    try:
        # ── 1. A 4xx MUST surface Telegram's description ────────────────────
        rec = Recorder(raises=http_error(400, b'{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'))
        vt.urllib.request.urlopen = rec
        try:
            vt._post_voice("TOK", 123, ogg)
            check("[1] a 4xx raises", False, "no exception was raised")
        except BaseException as e:  # noqa: BLE001 - a MUTACIO nyers HTTPError-t dob
            check("[1] the error is VoiceSendError, not the raw urllib one",
                  isinstance(e, vt.VoiceSendError),
                  "%s escaped: %s" % (type(e).__name__, e))
            msg = str(e)
            check("[1] the message carries the API description", "chat not found" in msg, msg)
            check("[1] and it is not the bare urllib text", msg != "HTTP Error 400: Bad Request", msg)
            # Security: the request URL holds the bot token. It must not travel
            # in an error string that gets pasted into cards and chat messages.
            check("[1] the token does NOT leak into the message", "SECRET-TOKEN-123" not in msg, msg)

        # ── 2. CONTROL: the success path stays untouched ────────────────────
        rec_ok = Recorder(returns={"ok": True, "result": {"message_id": 7}})
        vt.urllib.request.urlopen = rec_ok
        r = vt._post_voice("TOK", 123, ogg)
        check("[2] control: a 200 returns the parsed body", r.get("result", {}).get("message_id") == 7, repr(r))
        check("[2] control: the success path does not raise", True)

        # ── 3. An EMPTY ogg is caught BEFORE the network call ───────────────
        rec_never = Recorder(returns={"ok": True})
        vt.urllib.request.urlopen = rec_never
        try:
            vt._post_voice("TOK", 123, empty)
            check("[3] an empty ogg raises", False, "no exception")
        except BaseException as e:  # noqa: BLE001
            check("[3] the empty-file message says what is wrong", "empty" in str(e).lower(), str(e))
        # This is the point of the guard: not annotating a failed call, but not
        # making it. A network round-trip for a zero-byte file is the bug.
        check("[3] and the HTTP call was NOT made", rec_never.calls == 0, "urlopen calls=%d" % rec_never.calls)

        # ── 4. A body that is NOT Telegram JSON must still be usable ────────
        rec_html = Recorder(raises=http_error(502, b"<html><body>Bad gateway</body></html>"))
        vt.urllib.request.urlopen = rec_html
        try:
            vt._post_voice("TOK", 123, ogg)
            check("[4] a non-JSON error raises", False, "no exception")
        except BaseException as e:  # noqa: BLE001
            check("[4] a non-JSON body still yields an excerpt", "Bad gateway" in str(e), str(e))

        # ── 5. An EMPTY body must not crash the error path ──────────────────
        rec_none = Recorder(raises=http_error(400, b""))
        vt.urllib.request.urlopen = rec_none
        try:
            vt._post_voice("TOK", 123, ogg)
            check("[5] an empty error body raises", False, "no exception")
        except BaseException as e:  # noqa: BLE001
            # "400" alone would also be true of the RAW HTTPError -- that assertion
            # stayed green under the mutation, so it proved nothing. The marker below
            # exists only in our own fallback path.
            check("[5] an empty body degrades gracefully",
                  "no body" in str(e), str(e))
    finally:
        vt.urllib.request.urlopen = real_urlopen
        for p in (ogg, empty):
            try:
                os.unlink(p)
            except OSError:
                pass

    if FAILS:
        print("FAILED: %s" % ", ".join(FAILS))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    run()
