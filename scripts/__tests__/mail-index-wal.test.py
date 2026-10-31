#!/usr/bin/env python3
"""Tests for the WAL-aware envelope-index read in mail_triage.py.

MAILINDEXFAGYOTT914. The reader used `immutable=1`, which promises SQLite the
file cannot change, so SQLite skips the WAL. Mail.app keeps the envelope index
in WAL mode, so everything since the last checkpoint was invisible. Measured on
the live install 2026-09-23 06:44, same database, same second: immutable=1 saw
40485 rows with the newest message at 22:15 the previous evening, a WAL-aware
read saw 40487 with the newest at 02:02 that night. The result came back as a
clean zero with exit 0 -- indistinguishable from an empty mailbox.

These tests build a real WAL database and keep the writer connection OPEN, which
is what keeps rows in the WAL: closing the last connection checkpoints it, and a
checkpointed fixture would pass under the old bug too.
"""
import os
import sqlite3
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "seed-skills", "fleet-helper", "scripts"))
import mail_triage  # noqa: E402


SCHEMA = """
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INT, sender INT,
  subject INT, date_received INT, read INT, deleted INT);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, comment TEXT, address TEXT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
"""


class WalIndexFixture:
    """A WAL-mode envelope index whose newest rows sit in the -wal file."""

    def __init__(self, checkpointed_at, wal_at):
        self.dir = tempfile.mkdtemp(prefix="mail-idx-")
        self.db = os.path.join(self.dir, "Envelope Index")
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.execute("INSERT INTO mailboxes (ROWID, url) VALUES (1, 'imap://x/INBOX')")
        con.execute("INSERT INTO addresses (ROWID, comment, address) VALUES (1, 'Bank', 'b@bank.hu')")
        con.execute("INSERT INTO subjects (ROWID, subject) VALUES (1, 'szamla')")
        con.execute("INSERT INTO messages VALUES (1, 1, 1, 1, ?, 0, 0)", (checkpointed_at,))
        con.commit()
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA wal_autocheckpoint=0")
        # This row lives in the WAL until something checkpoints it. The writer
        # connection stays open for exactly that reason.
        con.execute("INSERT INTO messages VALUES (2, 1, 1, 1, ?, 0, 0)", (wal_at,))
        con.commit()
        self.writer = con

    def close(self):
        try:
            self.writer.close()
        finally:
            for suffix in ("", "-wal", "-shm"):
                try:
                    os.remove(self.db + suffix)
                except OSError:
                    pass
            try:
                os.rmdir(self.dir)
            except OSError:
                pass


class WalVisibility(unittest.TestCase):
    def setUp(self):
        self.now = int(time.time())
        self.fx = WalIndexFixture(self.now - 8 * 3600, self.now - 600)
        self.addCleanup(self.fx.close)

    def test_immutable_read_misses_the_wal(self):
        """The trap itself, pinned: if this ever stops being true the comment in
        mail_triage.py is obsolete and the fallback ordering can be revisited."""
        con = sqlite3.connect(f"file:{self.fx.db}?immutable=1", uri=True)
        newest = con.execute("SELECT MAX(date_received) FROM messages").fetchone()[0]
        con.close()
        self.assertEqual(newest, self.now - 8 * 3600,
                         "immutable=1 unexpectedly saw the WAL row")

    def test_connect_sees_the_wal_row(self):
        con, mode, tmp = mail_triage._connect(self.fx.db)
        try:
            newest = con.execute("SELECT MAX(date_received) FROM messages").fetchone()[0]
        finally:
            con.close()
            if tmp:
                import shutil
                shutil.rmtree(tmp, ignore_errors=True)
        self.assertIn(mode, ("ro", "copy"))
        self.assertEqual(newest, self.now - 600,
                         "the WAL-aware read still cannot see the newest message")

    def test_read_unread_returns_the_wal_message(self):
        original = mail_triage._envelope_index_path
        mail_triage._envelope_index_path = lambda: self.fx.db
        try:
            rows = mail_triage.read_unread(60)
        finally:
            mail_triage._envelope_index_path = original
        self.assertEqual(len(rows), 1, f"expected the 10-minute-old message, got {rows}")
        self.assertIn("szamla", rows[0][1])


class HealthVerdict(unittest.TestCase):
    """A zero is only a measurement when the index can be trusted."""

    def test_fresh_mail_is_usable(self):
        now = int(time.time())
        fx = WalIndexFixture(now - 8 * 3600, now - 600)
        self.addCleanup(fx.close)
        h = mail_triage.index_health(fx.db, now=now)
        self.assertTrue(h["usable"])
        self.assertLessEqual(h["index_age_min"], mail_triage.STALE_AFTER_MIN)

    def test_quiet_mailbox_with_a_live_index_is_still_usable(self):
        """No new mail all night is NOT a broken index: the WAL mtime proves the
        pipeline is alive. Without this arm the nightly briefing would cry wolf
        every single morning."""
        now = int(time.time())
        fx = WalIndexFixture(now - 30 * 3600, now - 20 * 3600)
        self.addCleanup(fx.close)
        h = mail_triage.index_health(fx.db, now=now)
        self.assertTrue(h["usable"], h["note"])
        self.assertIn("pipeline is alive", h["note"])

    def test_old_mail_and_untouched_index_is_cannot_tell(self):
        now = int(time.time())
        fx = WalIndexFixture(now - 30 * 3600, now - 29 * 3600)
        self.addCleanup(fx.close)
        stale_mtime = now - 5 * 3600
        for suffix in ("", "-wal"):
            if os.path.exists(fx.db + suffix):
                os.utime(fx.db + suffix, (stale_mtime, stale_mtime))
        h = mail_triage.index_health(fx.db, now=now)
        self.assertFalse(h["usable"], h["note"])
        self.assertIn("cannot tell", h["note"])

    def test_missing_index_is_not_silence(self):
        h = mail_triage.index_health("/nincs/ilyen/Envelope Index", now=int(time.time()))
        self.assertFalse(h["usable"])
        self.assertEqual(h["note"], "Envelope Index not found")


class TriageOutput(unittest.TestCase):
    def test_unusable_index_marks_the_zero_and_warns(self):
        now = int(time.time())
        original = mail_triage._envelope_index_path
        mail_triage._envelope_index_path = lambda: "/nincs/ilyen/Envelope Index"
        try:
            out = mail_triage.triage(720)
        finally:
            mail_triage._envelope_index_path = original
        self.assertEqual(out["zero_means"], "cannot-tell")
        self.assertIn("warning", out)
        self.assertFalse(out["has_signal"])

    def test_usable_index_says_the_zero_is_real(self):
        now = int(time.time())
        fx = WalIndexFixture(now - 600, now - 300)
        self.addCleanup(fx.close)
        original = mail_triage._envelope_index_path
        mail_triage._envelope_index_path = lambda: fx.db
        try:
            # Window of 1 minute: both messages are older, so the buckets are
            # empty while the index itself is fresh -- the honest zero.
            out = mail_triage.triage(1)
        finally:
            mail_triage._envelope_index_path = original
        self.assertEqual(out["zero_means"], "no-unread")
        self.assertNotIn("warning", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
