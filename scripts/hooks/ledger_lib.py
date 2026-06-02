"""Shared helpers for the deterministic conversation-continuity ledger.

The ledger (store/claudeclaw.db -> pending_messages) records inbound channel
messages and whether they were answered, so a respawn (a fresh --channels session
with no memory of the live conversation) can replay the last UNANSWERED message
and continue from where the connection dropped -- with ZERO agent discretion.

Used by the three settings.json hooks (ledger-capture / ledger-answered /
ledger-replay). Pure stdlib (sqlite3 + json) -- no node startup, no jq.
"""
import os
import sqlite3
import time

# Canonical schema. MUST stay identical to the db.ts initDatabase() migration
# (asserted by a contract test). Created defensively here too so a hook that runs
# before the dashboard migration (e.g. on a fresh boot / respawn) still works.
SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_messages (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  text TEXT,
  ts TEXT,
  answered INTEGER NOT NULL DEFAULT 0,
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(chat_id, message_id)
)
"""
INDEX = "CREATE INDEX IF NOT EXISTS idx_pending_unanswered ON pending_messages(chat_id, answered)"


def db_path():
    # Hooks live in <install>/scripts/hooks/; the ledger is <install>/store/.
    # Resolve from THIS file's location so the path is correct regardless of the
    # session's cwd (sub-agents run from a different cwd). Override with
    # LEDGER_DB_PATH for tests.
    override = os.environ.get("LEDGER_DB_PATH")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    install = os.path.dirname(os.path.dirname(here))
    return os.path.join(install, "store", "claudeclaw.db")


def connect():
    con = sqlite3.connect(db_path(), timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    con.execute(SCHEMA)
    con.execute(INDEX)
    return con


def owner_chat_id():
    """The main/owner Telegram chat id. The reply tool sometimes uses chat_id=0 as
    a shorthand for 'the current chat' (see CLAUDE.md), but inbound is stored under
    the real id -- so the answered-flip resolves 0/empty to this. Test override:
    LEDGER_OWNER_CHAT."""
    v = os.environ.get("LEDGER_OWNER_CHAT") or os.environ.get("ALLOWED_CHAT_ID")
    if v:
        return v.strip()
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        env_path = os.path.join(os.path.dirname(os.path.dirname(here)), ".env")
        with open(env_path) as f:
            for line in f:
                if line.startswith("ALLOWED_CHAT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def upsert_inbound(chat_id, message_id, text, ts):
    """Record an inbound message as UNANSWERED. Idempotent on (chat_id, message_id)."""
    con = connect()
    try:
        con.execute(
            "INSERT OR IGNORE INTO pending_messages"
            " (chat_id, message_id, text, ts, answered, created_at)"
            " VALUES (?, ?, ?, ?, 0, ?)",
            (str(chat_id), str(message_id), text, ts, int(time.time())),
        )
        con.commit()
    finally:
        con.close()


def mark_answered(chat_id):
    """Flip every still-open message for this chat to answered. Returns the count."""
    con = connect()
    try:
        cur = con.execute(
            "UPDATE pending_messages SET answered=1, answered_at=?"
            " WHERE chat_id=? AND answered=0",
            (int(time.time()), str(chat_id)),
        )
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def unanswered():
    """All still-open messages, oldest first. Returns list of (chat_id, message_id, text, ts)."""
    con = connect()
    try:
        return con.execute(
            "SELECT chat_id, message_id, text, ts FROM pending_messages"
            " WHERE answered=0 ORDER BY created_at ASC, rowid ASC"
        ).fetchall()
    finally:
        con.close()
