"""Shared helpers for the deterministic conversation-continuity ledger.

The ledger (store/claudeclaw.db -> conversation_log) is a rolling TRANSCRIPT of
every channel turn -- inbound user messages AND outbound replies -- per
agent_id + chat_id. On a respawn (a fresh --channels session with no memory of
the live conversation) the SessionStart hook injects the last ~20 turns of
context PLUS the open question, so the fresh session continues where the
connection dropped -- with ZERO agent discretion.

Generic across all three channel agents (marveen / dia / erno-ba): agent_id is
derived from the running session's cwd so each session only ever sees its OWN
chat. Pure stdlib (sqlite3) -- no node startup, no jq.
"""
import os
import sqlite3
import time

# Canonical schema. MUST stay identical to the db.ts initDatabase() migration
# (asserted by a contract test). Created defensively so a hook that runs before
# the dashboard migration (fresh boot / respawn) still works.
SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text TEXT,
  ts TEXT,
  created_at INTEGER NOT NULL,
  attachment_kind TEXT,
  attachment_file_id TEXT,
  UNIQUE(agent_id, chat_id, direction, message_id)
)
"""
INDEX = "CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at)"

# Columns added after the initial schema shipped. connect() retrofits them onto
# existing DBs with idempotent ALTERs (CREATE TABLE IF NOT EXISTS is a no-op on
# an already-created table, so the SCHEMA text alone never upgrades old DBs).
_MIGRATION_COLUMNS = (
    ("attachment_kind", "TEXT"),
    ("attachment_file_id", "TEXT"),
)

RECENT_LIMIT = 20


def db_path():
    # Hooks live in <install>/scripts/hooks/; the ledger is <install>/store/.
    # Resolve from THIS file's location so it is correct regardless of the
    # session's cwd. Test override: LEDGER_DB_PATH.
    override = os.environ.get("LEDGER_DB_PATH")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    install = os.path.dirname(os.path.dirname(here))
    return os.path.join(install, "store", "claudeclaw.db")


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def main_agent_id():
    v = os.environ.get("MAIN_AGENT_ID")
    if v:
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "marveen"


def owner_name():
    """The human owner's display name, used to label inbound turns in the
    replayed conversation context. Same resolution order as main_agent_id():
    OWNER_NAME env var first, then the install-dir .env (channels.sh does NOT
    export OWNER_NAME into the hook environment, so the .env file is the path
    that actually fires at runtime), finally a neutral default. Never hardcode
    a specific person -- every install configures its own OWNER_NAME, so a
    baked-in name (e.g. "Gyula") leaks the wrong name into every user's agent."""
    v = os.environ.get("OWNER_NAME")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("OWNER_NAME="):
                    name = line.split("=", 1)[1].strip()
                    if name:
                        return name
    except Exception:
        pass
    return "A felhasználó"


def agent_id_from_payload(payload):
    """Session-stable agent identity from a hook payload (LEDGERCWD828).

    The shell cwd is MUTABLE within a session: when the main agent stepped into
    agents/iris/... for a measurement, its OWN replies to the owner ledgered
    under iris, the reply guard then found no outbound under the real id and
    triple-sent an already-answered link. Measured blast radius on the owner
    chat: 51 outbound rows under 7 names, several of them plain directory
    names, not agents.

    The session's transcript_path is derived from the agent's own config dir
    (CLAUDE_CONFIG_DIR), which never changes within a session -- that is the
    identity anchor. Resolution order:
      1. transcript_path  (immutable per session)
      2. MARVEEN_AGENT_ID (explicit launcher override)
      3. cwd              (last resort, for callers that have nothing else)
    """
    payload = payload or {}
    agent = _agent_id_from_config_path(payload.get("transcript_path"))
    if agent:
        return agent
    env_id = os.environ.get("MARVEEN_AGENT_ID", "").strip()
    if env_id:
        return env_id
    return agent_id_from_cwd(payload.get("cwd"))


def _agent_id_from_config_path(path):
    """Map a transcript/config path to an agent id, or None when the path says
    nothing (caller falls through to the env/cwd chain).

      <install>/agents/<id>/...  -> <id>            (a sub-agent's config dir)
      anywhere else in the tree  -> MAIN_AGENT_ID   (.channels-config etc.)
      under ~/.claude            -> MAIN_AGENT_ID   (non-isolated main session)
      anything else / empty      -> None
    """
    if not path or not isinstance(path, str):
        return None
    path = os.path.abspath(path.strip())
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    # 1. The CONFIG OWNER is authoritative: a transcript under
    #    <install>/agents/<id>/... is that agent's isolated config dir, no
    #    matter where the session's cwd wandered.
    if path.startswith(agents_root + os.sep):
        rel = path[len(agents_root) + 1:]
        head = rel.split(os.sep)[0]
        return head or None
    # 2. Non-isolated config roots (~/.claude and friends) key the project dir
    #    by the session's STARTING cwd, flattened: /a/b -> "-a-b". Every fleet
    #    agent's tmux session runs this way (measured 2026-08-28: the live
    #    samu session's transcript sits under
    #    ~/.claude/projects/-Users-marvin-ClaudeClaw-agents-samu/), so the
    #    agent id is IN the path -- mapping the whole family to the main agent
    #    would be the original bug mirrored. Parse the segment instead.
    seg_agent = _agent_id_from_project_segment(path, install)
    if seg_agent is not None:
        return seg_agent
    if path == install or path.startswith(install + os.sep):
        return main_agent_id()
    home_claude = os.path.join(os.path.expanduser("~"), ".claude")
    if path == home_claude or path.startswith(home_claude + os.sep):
        return main_agent_id()
    return None


def _agent_id_from_project_segment(path, install):
    """Read the agent id out of a flattened projects/<segment>/ component.

      .../projects/-Users-...-ClaudeClaw-agents-<id>[-...]/x.jsonl -> <id>
      .../projects/-Users-...-ClaudeClaw[-...]/x.jsonl             -> MAIN
      no /projects/ component, or a foreign segment                -> None

    Agent ids may in principle contain hyphens, which the flattening makes
    ambiguous; when <install>/agents exists its entries disambiguate (longest
    match wins), otherwise the first hyphen-delimited hunk is taken -- correct
    for every current fleet name.
    """
    marker = os.sep + "projects" + os.sep
    i = path.find(marker)
    if i < 0:
        return None
    seg = path[i + len(marker):].split(os.sep)[0]
    flat_install = install.replace(os.sep, "-")
    agents_prefix = flat_install + "-agents-"
    if seg.startswith(agents_prefix):
        rest = seg[len(agents_prefix):]
        try:
            names = sorted(os.listdir(os.path.join(install, "agents")), key=len, reverse=True)
        except OSError:
            names = []
        for name in names:
            if rest == name or rest.startswith(name + "-"):
                return name
        head = rest.split("-")[0]
        return head or None
    if seg == flat_install or seg.startswith(flat_install + "-"):
        return main_agent_id()
    return None


def agent_id_from_cwd(cwd):
    """Which channel agent is this session? Derived from cwd. LAST-RESORT ONLY:
    the cwd changes within a session (a `cd` into agents/<x>/ re-attributes
    every later row), so payload-carrying hooks must call agent_id_from_payload
    instead -- its docstring carries the measured incident (LEDGERCWD828).
      <install>/agents/<id>[/...]  -> <id>           (a sub-agent)
      anywhere else in the tree    -> MAIN_AGENT_ID   (the main channels agent)
    """
    cwd = (cwd or "").rstrip("/")
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        return rel.split(os.sep)[0] or main_agent_id()
    if cwd == install or cwd.startswith(install + os.sep):
        # Anywhere else INSIDE the install tree is still the main agent. Without
        # this, a session whose cwd happens to be a subdirectory (a scratch dir,
        # a build folder, ...) logs its messages under an agent id invented from
        # the directory name. That splits the conversation ledger across two
        # identities and makes the reply guard block on a question it has
        # already answered, because it finds no outbound under the real id.
        return main_agent_id()
    # Outside the install tree: never invent an agent id from the directory name.
    # The launcher can name the session explicitly via MARVEEN_AGENT_ID; failing
    # that, attribute to the main agent rather than a bogus basename.
    env_id = os.environ.get("MARVEEN_AGENT_ID", "").strip()
    if env_id:
        return env_id
    return main_agent_id()


def connect():
    con = sqlite3.connect(db_path(), timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    con.execute(SCHEMA)
    con.execute(INDEX)
    existing = {row[1] for row in con.execute("PRAGMA table_info(conversation_log)")}
    for col, coltype in _MIGRATION_COLUMNS:
        if col not in existing:
            con.execute(f"ALTER TABLE conversation_log ADD COLUMN {col} {coltype}")
    return con


def log_inbound(agent_id, chat_id, message_id, text, ts,
                attachment_kind=None, attachment_file_id=None):
    """Record an inbound user message. Idempotent on (agent_id, chat_id, in, message_id).

    attachment_kind/file_id: set for voice / video_note messages that arrived
    WITHOUT a transcript, so a respawned session can still download and
    transcribe the audio instead of losing the message content forever."""
    con = connect()
    try:
        con.execute(
            "INSERT OR IGNORE INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at,"
            "  attachment_kind, attachment_file_id)"
            " VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)",
            (str(agent_id), str(chat_id), str(message_id), text, ts, int(time.time()),
             attachment_kind, attachment_file_id),
        )
        con.commit()
    finally:
        con.close()


def log_outbound(agent_id, chat_id, text, message_id=None):
    """Record an outbound reply.

    message_id: the Telegram message_id returned by the reply tool, or None.
    When provided, INSERT OR IGNORE deduplicates on the UNIQUE constraint so
    a double-fire of the hook does not produce a duplicate row. When None the
    constraint does not trigger (NULL != NULL in SQL), preserving the existing
    behaviour for callers that do not supply a message_id.
    Note: INSERT OR IGNORE silently swallows ALL constraint violations, not
    only UNIQUE conflicts. This is intentional: a duplicate outbound row is
    harmless, and we never want the ledger write to raise an exception.
    """
    con = connect()
    try:
        now = int(time.time())
        mid = str(message_id) if message_id is not None else None
        con.execute(
            "INSERT OR IGNORE INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES (?, ?, 'out', ?, ?, ?, ?)",
            (str(agent_id), str(chat_id), mid, text,
             time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), now),
        )
        con.commit()
    finally:
        con.close()


def recent(agent_id, limit=RECENT_LIMIT):
    """The last `limit` turns for this agent, oldest-first.
    Rows: (direction, chat_id, text, ts, attachment_kind, attachment_file_id)."""
    con = connect()
    try:
        rows = con.execute(
            "SELECT direction, chat_id, text, ts, attachment_kind, attachment_file_id"
            " FROM conversation_log"
            " WHERE agent_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
            (str(agent_id), int(limit)),
        ).fetchall()
        return list(reversed(rows))
    finally:
        con.close()


def open_question_with_age(agent_id):
    """Like open_question() but also returns the open inbound's created_at (unix
    epoch). Returns (chat_id, message_id, text, ts, created_at, attachment_kind,
    attachment_file_id) or None. Used by the live-drain hook, which needs the
    age for its grace window."""
    con = connect()
    try:
        row = con.execute(
            "SELECT chat_id, message_id, text, ts, created_at, id,"
            "       attachment_kind, attachment_file_id"
            " FROM conversation_log"
            " WHERE agent_id=? AND direction='in' ORDER BY created_at DESC, id DESC LIMIT 1",
            (str(agent_id),),
        ).fetchone()
        if not row:
            return None
        chat_id, message_id, text, ts, created_at, rid, att_kind, att_file_id = row
        later_out = con.execute(
            "SELECT 1 FROM conversation_log"
            " WHERE agent_id=? AND direction='out'"
            "   AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1",
            (str(agent_id), created_at, created_at, rid),
        ).fetchone()
        if later_out:
            return None  # the last inbound has already been answered
        return (chat_id, message_id, text, ts, created_at, att_kind, att_file_id)
    finally:
        con.close()


def open_question(agent_id):
    """The most recent inbound with NO later outbound (the unanswered question),
    or None. Returns (chat_id, message_id, text, ts, attachment_kind,
    attachment_file_id)."""
    oq = open_question_with_age(agent_id)
    if not oq:
        return None
    # Prefix-slice on purpose (HOOKARITAS821): if open_question_with_age()
    # ever widens again, this unpack would ValueError INSIDE ledger_lib, and
    # every caller that wraps only the open_question() call in try/except
    # would read the failure as "ledger unavailable" -- fail-open, silently.
    chat_id, message_id, text, ts, _created_at, att_kind, att_file_id = oq[:7]
    return (chat_id, message_id, text, ts, att_kind, att_file_id)
