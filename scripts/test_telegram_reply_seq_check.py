"""Tests for scripts/hooks/telegram-reply-seq-check.py SEQ_RX.

hu: A hook a `text` mezo NYERS elejet nezi -- de markdownv2 formatumban a
    kotelezo szamozott elotag `{`/`}` jelei MAGUK IS Telegram-specialis
    karakterek, tehat escapelve kell allniuk (`\\{622\\} `), kulonben a
    Telegram API 400-at ad ("Character '{' is reserved"). A regi regex
    (`^\\{\\d+\\}\\s`) csak a NEM escapelt alakot fogadta el -- markdownv2-ben
    tehat a hook es a Telegram API egymasnak ellentmondo alakot kert.
    Merve elesben (2026-08-19): a nem-escapelt alak athaladt a hookon,
    de a Telegram API elutasitotta ("can't parse entities").
en: The hook checks the RAW start of `text` -- but in markdownv2 format the
    mandatory numbered prefix's `{`/`}` are themselves Telegram-reserved
    characters and must be escaped (`\\{622\\} `), or the Telegram API
    returns 400 ("Character '{' is reserved"). The old regex only accepted
    the unescaped form -- so in markdownv2 mode the hook and the Telegram
    API demanded contradictory shapes. Measured live (2026-08-19): the
    unescaped form passed the hook but Telegram rejected it.
"""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "telegram_reply_seq_check", Path(__file__).with_name("hooks") / "telegram-reply-seq-check.py"
)
seq_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seq_check)


def test_plain_text_prefix_matches():
    """A megszokott, format='text' alak valtozatlanul mukodjon."""
    assert seq_check.SEQ_RX.match("{622} valami szoveg")


def test_markdownv2_escaped_prefix_matches():
    """format='markdownv2'-ben a Telegram-nek escapelt \\{622\\} alak KELL -- ezt a hook fogadja el."""
    assert seq_check.SEQ_RX.match(r"\{622\} *bold cim*")


def test_missing_prefix_still_blocked():
    """Pozitiv kontroll a masik iranyba: sorszam nelkuli szoveg tovabbra is bukjon."""
    assert not seq_check.SEQ_RX.match("nincs sorszam az elejen")


def test_only_opening_brace_escaped_still_blocked():
    """Felig escapelt alak (csak a nyito zarojel) ne csusszon at -- ez korrupt formatum."""
    assert not seq_check.SEQ_RX.match(r"\{622} valami")
