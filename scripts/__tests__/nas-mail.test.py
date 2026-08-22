#!/usr/bin/env python3
"""Unit tests for scripts/nas-mail.py.

Covers the pure logic only -- credentials parsing, MIME header decoding, the
newsletter/promo filter and the recency window. The IMAP paths are exercised
out of band against the live mailbox (`nas-mail.py verify`); nothing here opens
a socket, reads the real credentials file or touches store/.
"""
import importlib.util
import os
import unittest
from datetime import datetime, timedelta, timezone

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "nas-mail.py",
)

_spec = importlib.util.spec_from_file_location("nas_mail", _MODULE_PATH)
nm = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(nm)  # type: ignore[union-attr]


FULL = "\n".join(
    [
        "HOST=nas.example.invalid",
        "PORT=993",
        "TLS=true",
        "USER=Info.Example",
        "PASSWORD=pw-plain",
    ]
)


class TestParseCredentials(unittest.TestCase):
    def test_parses_a_well_formed_file(self):
        c = nm.parse_credentials(FULL)
        self.assertEqual(c["host"], "nas.example.invalid")
        self.assertEqual(c["port"], 993)
        self.assertTrue(c["tls"])
        self.assertEqual(c["user"], "Info.Example")
        self.assertEqual(c["password"], "pw-plain")

    def test_ignores_comments_and_blank_lines(self):
        c = nm.parse_credentials("# header\n\n" + FULL + "\n\n# trailer")
        self.assertEqual(c["user"], "Info.Example")

    def test_keeps_equals_signs_inside_the_password(self):
        # The live NAS password contains '=' -- splitting on every '=' would
        # silently truncate it and the login would fail with no clue why.
        c = nm.parse_credentials(FULL.replace("PASSWORD=pw-plain", "PASSWORD=ab=cd=ef"))
        self.assertEqual(c["password"], "ab=cd=ef")

    def test_strips_surrounding_quotes(self):
        c = nm.parse_credentials(FULL.replace("PASSWORD=pw-plain", 'PASSWORD="pw plain"'))
        self.assertEqual(c["password"], "pw plain")

    def test_does_not_strip_a_leading_or_trailing_quote_character(self):
        # A password that merely STARTS with a quote is not a quoted value.
        c = nm.parse_credentials(FULL.replace("PASSWORD=pw-plain", 'PASSWORD="pw'))
        self.assertEqual(c["password"], '"pw')

    def test_port_defaults_to_993(self):
        c = nm.parse_credentials(FULL.replace("PORT=993\n", ""))
        self.assertEqual(c["port"], 993)

    def test_tls_false_is_honoured(self):
        c = nm.parse_credentials(FULL.replace("TLS=true", "TLS=false"))
        self.assertFalse(c["tls"])

    def test_throws_listing_every_missing_key(self):
        with self.assertRaises(ValueError) as ctx:
            nm.parse_credentials("HOST=nas.example.invalid")
        msg = str(ctx.exception)
        self.assertIn("USER", msg)
        self.assertIn("PASSWORD", msg)

    def test_empty_value_counts_as_missing(self):
        with self.assertRaises(ValueError) as ctx:
            nm.parse_credentials(FULL.replace("PASSWORD=pw-plain", "PASSWORD="))
        self.assertIn("PASSWORD", str(ctx.exception))

    def test_the_error_never_echoes_the_password(self):
        # An exception message travels into logs and Telegram; the secret must
        # not ride along with it.
        with self.assertRaises(ValueError) as ctx:
            nm.parse_credentials(FULL.replace("USER=Info.Example", "USER="))
        self.assertNotIn("pw-plain", str(ctx.exception))


class TestDecodeHeader(unittest.TestCase):
    def test_plain_ascii_passes_through(self):
        self.assertEqual(nm.decode_header_value("Hello"), "Hello")

    def test_none_becomes_empty_string(self):
        self.assertEqual(nm.decode_header_value(None), "")

    def test_decodes_utf8_base64_encoded_words(self):
        # "Árajánlat" -- Hungarian accents are the whole point of this project.
        self.assertEqual(
            nm.decode_header_value("=?utf-8?B?w4FyYWrDoW5sYXQ=?="), "Árajánlat"
        )

    def test_decodes_iso_8859_2_quoted_printable(self):
        # Latin-2 is what older Hungarian mailers still emit.
        self.assertEqual(
            nm.decode_header_value("=?iso-8859-2?Q?K=F6sz=F6n=F6m?="), "Köszönöm"
        )

    def test_joins_multiple_encoded_words(self):
        self.assertEqual(
            nm.decode_header_value("=?utf-8?B?w4E=?= =?utf-8?B?Qg==?="), "ÁB"
        )

    def test_collapses_newlines_from_folded_headers(self):
        # A folded header would otherwise break the one-line summary layout.
        self.assertEqual(nm.decode_header_value("Line one\r\n  line two"), "Line one line two")

    def test_undecodable_bytes_do_not_raise(self):
        self.assertIsInstance(nm.decode_header_value("=?utf-8?B?////?="), str)


class TestNoiseFilter(unittest.TestCase):
    def test_ordinary_mail_is_kept(self):
        self.assertFalse(nm.is_noise("zoli@com-passz.hu", "Teszt eredmeny", {}))

    def test_list_unsubscribe_header_marks_a_newsletter(self):
        # RFC 2369: the strongest machine-readable bulk-mail signal there is.
        self.assertTrue(
            nm.is_noise("hirek@bolt.hu", "Uj termekek", {"List-Unsubscribe": "<https://x/u>"})
        )

    def test_auto_submitted_header_marks_a_robot(self):
        self.assertTrue(
            nm.is_noise("system@bolt.hu", "Riport", {"Auto-Submitted": "auto-generated"})
        )

    def test_auto_submitted_no_is_not_noise(self):
        # RFC 3834: "no" explicitly means this is NOT an automatic response.
        self.assertFalse(nm.is_noise("a@b.hu", "Valasz", {"Auto-Submitted": "no"}))

    def test_bulk_precedence_marks_a_newsletter(self):
        self.assertTrue(nm.is_noise("a@b.hu", "Hirek", {"Precedence": "bulk"}))

    def test_noreply_sender_is_noise(self):
        self.assertTrue(nm.is_noise("no-reply@bolt.hu", "Rendeles", {}))

    def test_promo_subject_is_noise(self):
        self.assertTrue(nm.is_noise("a@bolt.hu", "AKCIÓ: -50% kedvezmény", {}))

    def test_subject_match_is_accent_and_case_insensitive(self):
        # "hírlevél" written without accents must match too -- a plain
        # lowercase compare would let it through.
        self.assertTrue(nm.is_noise("a@b.hu", "Heti hirlevel", {}))
        self.assertTrue(nm.is_noise("a@b.hu", "Heti HÍRLEVÉL", {}))

    def test_header_lookup_is_case_insensitive(self):
        # IMAP servers return header names in whatever case they please.
        self.assertTrue(nm.is_noise("a@b.hu", "x", {"list-unsubscribe": "<https://x/u>"}))

    def test_a_keyword_inside_a_longer_word_does_not_match(self):
        # "akcióterv" is not a promotion; substring matching would flag it.
        self.assertFalse(nm.is_noise("a@b.hu", "Akcióterv a jövő hétre", {}))


class TestRecencyWindow(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 13, 9, 0, tzinfo=timezone.utc)

    def test_keeps_a_message_inside_the_window(self):
        entries = [{"date": self.now - timedelta(hours=3)}]
        self.assertEqual(len(nm.select_recent(entries, self.now, hours=12)), 1)

    def test_drops_a_message_older_than_the_window(self):
        entries = [{"date": self.now - timedelta(hours=20)}]
        self.assertEqual(nm.select_recent(entries, self.now, hours=12), [])

    def test_keeps_a_message_with_an_unparsable_date(self):
        # Dropping it would hide real mail; a missing timestamp is not evidence
        # that the message is old.
        entries = [{"date": None}]
        self.assertEqual(len(nm.select_recent(entries, self.now, hours=12)), 1)

    def test_compares_across_timezones(self):
        # +02:00 local is the same instant as 07:00Z -- a naive compare would
        # shift it by two hours and drop or keep the wrong messages.
        local = timezone(timedelta(hours=2))
        entries = [{"date": datetime(2026, 8, 13, 9, 30, tzinfo=local)}]  # 07:30Z
        self.assertEqual(len(nm.select_recent(entries, self.now, hours=12)), 1)

    def test_sorts_newest_first(self):
        older = {"date": self.now - timedelta(hours=5), "subject": "older"}
        newer = {"date": self.now - timedelta(hours=1), "subject": "newer"}
        self.assertEqual(
            [e["subject"] for e in nm.select_recent([older, newer], self.now, hours=12)],
            ["newer", "older"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
