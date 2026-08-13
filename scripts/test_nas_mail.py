"""Tests for scripts/nas-mail.py date handling.

hu: A RFC 2822 "-0000" zona azt jelenti, hogy az idozona ISMERETLEN -- a
    parsedate_to_datetime ilyenkor NAIV datetime-ot ad, minden mas esetben tz-tudatosat.
    A ket alak egy listaban osszehasonlithatatlan, es a szures TypeError-rel elszall.
en: RFC 2822 "-0000" means the zone is unknown -- parsedate_to_datetime returns a NAIVE
    datetime there and an aware one otherwise. Mixing both in one list makes the filter
    raise TypeError.
"""

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("nas_mail", Path(__file__).with_name("nas-mail.py"))
nas_mail = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nas_mail)


# A "-0000" az a fejlec-alak, ami a valos postaladaban a hibat kivaltotta.
NAIV_FEJLEC = "Wed, 13 Aug 2026 09:15:00 -0000"
ZONAS_FEJLEC = "Wed, 13 Aug 2026 11:15:00 +0200"


def test_parse_date_ismeretlen_zonaval_is_tz_tudatos():
    """A '-0000' fejlecbol NEM johet naiv datetime -- kulonben osszehasonlithatatlan."""
    d = nas_mail._parse_date(NAIV_FEJLEC)

    assert d is not None
    assert d.tzinfo is not None, "a '-0000' fejlec naiv datetime-ot adott"
    assert d.utcoffset() == timedelta(0)


def test_parse_date_zonaval_a_helyes_pillanatot_adja():
    """Pozitiv kontroll: a zonas fejlec eddig is mukodott, es tovabbra is helyes."""
    d = nas_mail._parse_date(ZONAS_FEJLEC)

    assert d.tzinfo is not None
    assert d.astimezone(timezone.utc).hour == 9


def test_parse_date_ertelmezhetetlen_datumra_none():
    assert nas_mail._parse_date("ez nem datum") is None


def test_select_recent_kevert_zonaju_listan_nem_szall_el():
    """A hiba, ami elesben tortent: naiv es tz-tudatos datum EGY listaban."""
    now = datetime.now(timezone.utc)
    entries = [
        {"id": "naiv-friss", "date": nas_mail._parse_date(NAIV_FEJLEC)},
        {"id": "zonas-friss", "date": nas_mail._parse_date(ZONAS_FEJLEC)},
    ]
    # A ket fejlec ugyanazt a pillanatot irja le; a "most"-ot oda igazitjuk, hogy friss legyen.
    now = nas_mail._parse_date(ZONAS_FEJLEC) + timedelta(hours=1)

    kept = nas_mail.select_recent(entries, now, hours=12)

    assert {e["id"] for e in kept} == {"naiv-friss", "zonas-friss"}


def test_select_recent_a_regit_kiszuri():
    """Ellen-proba: ha ez nem szur, a fenti teszt attol is zold lenne, hogy mindent megtart."""
    now = datetime.now(timezone.utc)
    entries = [
        {"id": "friss", "date": now - timedelta(hours=1)},
        {"id": "regi", "date": now - timedelta(hours=48)},
    ]

    kept = nas_mail.select_recent(entries, now, hours=12)

    assert [e["id"] for e in kept] == ["friss"]


def test_select_recent_a_datum_nelkulit_megtartja():
    """A modul sajat dokumentalt viselkedese: a hianyzo idobelyeg nem bizonyitek arra,
    hogy a level regi -- a csendes eldobas valos levelet rejtene el."""
    now = datetime.now(timezone.utc)
    entries = [{"id": "nincs-datum", "date": None}]

    kept = nas_mail.select_recent(entries, now, hours=12)

    assert [e["id"] for e in kept] == ["nincs-datum"]


def test_select_recent_naiv_bemenetet_is_elvisel():
    """Vedohalo: ha barhonnan megis naiv datum kerul a listaba, ne TypeError legyen."""
    now = datetime.now(timezone.utc)
    entries = [{"id": "naiv", "date": datetime(2026, 8, 13, 9, 15)}]

    kept = nas_mail.select_recent(entries, now, hours=100000)

    assert [e["id"] for e in kept] == ["naiv"]
