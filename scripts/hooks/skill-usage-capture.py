#!/usr/bin/env python3
"""PostToolUse hook: log skill usage to the persistent skill_usage table.

Two event types are captured:
  tool_call  -- the Skill tool was invoked (tool_name == 'Skill')
  skill_read -- a SKILL.md file under <root>/skills/<name>/SKILL.md was Read,
                or is an argument of a reader command in Bash (cat, head,
                sed, grep without -l ...; SKILLBASHREAD1109, SKILLREADERONLY1109).
                A mere mention (echo, heredoc body, git diff, ls) does not count.
                The statistic can both over- and undercount; see the comment
                above _SKILL_ROOT.

Unlike tool_call_log (pruned every 24 h), skill_usage is never pruned so the
dream-engine can make data-driven suggestions after two or more weeks of data.

Registration (user-level ~/.claude/settings.json, post-install step):
  The hook command uses a guard so it silently no-ops if the file is missing
  (e.g. on develop before merging this feature):

    "command": "test -f /path/to/scripts/hooks/skill-usage-capture.py && python3 ... || true"

  This means the hook can be registered before merge without causing errors
  on other branches where the file does not yet exist.
"""
# Python 3.9 (macOS system python3) cannot evaluate PEP 604 unions at def time;
# lazy annotations keep the hook importable there (card 513c886e).
from __future__ import annotations

import sys
import os
import re
import json
import urllib.request
import urllib.error

# Agent identity comes from the ledger library -- ONE resolver for every hook.
# This file used to carry its own _agent_id_from_cwd() copy, which drifted:
# it missed the install-subdirectory case (only `cwd == install` mapped to the
# main agent) and kept the basename fallback, so skill_usage rows got an agent
# id INVENTED from the directory name. A drifted private copy is exactly how
# that class of bug survives -- delegate instead of duplicating.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _install_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_install_dir(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_install_dir(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ""


# Kept as a module-level alias for the tests (they pin that this file has no
# private copy of the resolver); the hook itself resolves from the PAYLOAD
# (transcript-anchored, LEDGERCWD828), not from this cwd-only fallback.
_agent_id_from_cwd = ledger_lib.agent_id_from_cwd


# <barhol>/.claude/skills/<name>/SKILL.md
#
# 2026-09-14: a minta KORABBAN csak a futo
# felhasznalo HOME-ja ala illeszkedett (`~/.claude/skills/...`). Emiatt a
# PROJEKT-SZINTU skillek (pl. <install>/.claude/skills/<nev>/SKILL.md) olvasasa
# SOHA nem keletkeztetett skill_usage sort -- a dream-engine 5. bucketje pedig
# epp az "utolso hasznalat" alapjan javasolna avult skilleket, tehat vakon futott.
# Merve 2026-09-14: 71 telepitett skillhez OSSZESEN 4 usage-sor tartozott, es
# mind a negy `tool_call` volt, egyetlen `skill_read` sem.
#
# MEGMARADO KORLAT, szandekosan kimondva: a hook a Skill es a Read TOOL-t, valamint
# a Bash-parancsban LITERALISAN leirt SKILL.md utat latja. Valtozobol, globbol vagy
# szkriptfajlbol olvasott SKILL.md tovabbra sem keletkeztet sort. A statisztika
# ezert MEG MINDIG ALULMER -- a "0 hasznalat" sosem bizonyitja, hogy a skill halott.
# Ezt a dream-engine bucket-5 ertelmezesenel figyelembe kell venni. (A Bash-ag ota
# felul is merhet, lasd lent: SKILLREADERONLY1109.)
#
# SKILLBASHREAD1109: the "Bash-bol olvasott SKILL.md nem keletkeztet sort" korlat
# a gyakorlatban a mérés nagy reszet elnyelte. Merve 2026-11-09: 11-07 20:21 es
# 11-09 08:10 kozott egyetlen sor sem keletkezett, mikozben a fo agens tobb
# skillt is megnyitott -- mind `cat`/`sed`-del, Bash-bol. A dream-engine ebbol
# "30 oraja allo merest" jelentett. Ezert a Bash-parancsban szereplo SKILL.md
# utat is szamoljuk (`skill_read`), lasd _classify_bash().
#
# A statisztika ezert MINDKET IRANYBA TEVEDHET, nem csak alulmer (SKILLREADERONLY1109):
# - ALUL: valtozobol, globbol, szkriptfajlbol olvasott SKILL.md, egy olvaso parancs,
#   amelyet a shlex nem tud szetbontani, vagy egy SKILL.md-t iro/torlo parancs mellett
#   allo olvasas (pl. `rm -rf /tmp/a && cat .../SKILL.md`) nem keletkeztet sort.
# - FELUL: az olvasas nem biztos, hogy hasznalat (pl. egy skill atnezese szerkesztes
#   elott), es egy `grep minta .../SKILL.md` is olvasasnak szamit.
# A puszta EMLITES (echo, heredoc-torzs, git diff, ls) mar nem szamit, csak egy olvaso
# parancs (cat, head, tail, less, sed, awk, grep -l nelkul ...) argumentuma.
# A "0 hasznalat" tehat tovabbra sem bizonyitja, hogy a skill halott, es egy
# alacsony szam sem bizonyitja, hogy hasznaltak.
#
# A config-gyoker neve sem mindig `.claude`: a fo agens izolalt gyokere
# `.channels-config`, a sub-agenseke `.claude-config`, es a Skill tool base
# directory-ja ezekbe mutat. Mindharom alak skill-gyoker.
_SKILL_ROOT = r"(?:^|/)\.(?:claude|channels-config|claude-config)/skills/"
_SKILL_MD_RE = re.compile(_SKILL_ROOT + r"([^/]+)/SKILL\.md$")
# A command that writes or removes a SKILL.md is not a use of the skill.
_WRITE_HINT_RE = re.compile(
    r"(?:>>?\s*[^\s]*SKILL\.md)|\bsed\s+(?:-[a-zA-Z]*\s+)*-i|\btee\b|\brm\b|\bmv\b|\bcp\b|"
    r"\bgit\s+(?:add|commit|checkout|restore|rm|mv)\b|\bln\b"
)
_MAX_BASH_SKILLS = 5

# SKILLREADERONLY1109: a path that is merely MENTIONED in a command line is not
# a read. The first cut counted every literal SKILL.md path anywhere in the
# command, so `echo "see .claude/skills/x/SKILL.md"`, a heredoc body, `git diff`
# and `ls -la` all produced a skill_read row (review of #2644, measured). Now a
# path counts only when it is an ARGUMENT of a reader command, and heredoc bodies
# are dropped before parsing.
_READERS = frozenset({
    "cat", "head", "tail", "less", "more", "bat", "batcat", "sed", "awk", "grep", "egrep", "rg",
})
# Words that run the NEXT word as the command; skipped when finding the program.
_PREFIX_WORDS = frozenset({"sudo", "env", "command", "nice", "nohup", "time"})
# grep/rg flags that print file NAMES or a count, not the content: a listing.
_GREP_LISTING_LONG = frozenset({"--files-with-matches", "--files-without-match", "--count", "--files"})
_GREP_LISTING_SHORT = frozenset("lLc")
_SEGMENT_OPS = frozenset({"&&", "||", ";", "|", "|&", "&", "(", ")", ";;"})
_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# One argument token (quotes already removed by shlex) that IS a single skill's
# SKILL.md. A glob or variable in the name segment is excluded, as before.
_SKILL_MD_TOKEN_RE = re.compile(_SKILL_ROOT + r"([^/\s*?\[\]{}$`]+)/SKILL\.md$")
_HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def _strip_heredoc_bodies(command: str) -> str:
    """Drop heredoc bodies: their text is data, not a command line."""
    out: list[str] = []
    terminators: list[str] = []
    for line in command.split("\n"):
        if terminators:
            if line.strip() == terminators[0]:
                terminators.pop(0)
            continue
        out.append(line)
        terminators.extend(m.group(2) for m in _HEREDOC_RE.finditer(line))
    return "\n".join(out)


def _simple_commands(command: str) -> list[list[str]]:
    """Split a command line into simple commands (word lists).

    A line shlex cannot parse (an unbalanced quote, a quote spanning lines) is
    skipped: an undercount is the safe direction here, never a crash.
    """
    import shlex  # lazy: most Bash calls return before this, keep their floor low

    segments: list[list[str]] = []
    for line in _strip_heredoc_bodies(command).split("\n"):
        lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        try:
            tokens = list(lexer)
        except ValueError:
            continue
        current: list[str] = []
        for tok in tokens:
            if tok in _SEGMENT_OPS:
                if current:
                    segments.append(current)
                current = []
            else:
                current.append(tok)
        if current:
            segments.append(current)
    return segments


def _reader_args(words: list[str]) -> list[str]:
    """The arguments of a reader command, or [] if this is not one."""
    i = 0
    while i < len(words) and (_ASSIGNMENT_RE.match(words[i]) or words[i] in _PREFIX_WORDS):
        i += 1
    if i >= len(words):
        return []
    program = os.path.basename(words[i])
    if program not in _READERS:
        return []
    args: list[str] = []
    skip_next = False
    for w in words[i + 1:]:
        if skip_next:  # the target of a redirection is not an argument
            skip_next = False
            continue
        if w and set(w) <= set("<>&"):
            skip_next = True
            continue
        args.append(w)
    if program in ("grep", "egrep", "rg"):
        for a in args:
            if a == "--":
                break
            if a in _GREP_LISTING_LONG:
                return []
            if a.startswith("-") and not a.startswith("--") and _GREP_LISTING_SHORT & set(a[1:]):
                return []
    return args


def _classify_bash(command: str) -> list[str]:
    """Skill names whose SKILL.md a Bash command reads (SKILLBASHREAD1109).

    Only a path that is an argument of a reader command counts
    (SKILLREADERONLY1109): a mention in echo, a heredoc body, git diff or ls
    does not. Distinct, in first-seen order, capped at _MAX_BASH_SKILLS so a
    long one-off sweep cannot flood the table. A command that looks like it
    writes, copies, moves or removes a SKILL.md yields nothing: editing a
    skill is not using it.
    """
    if not command or "SKILL.md" not in command:
        return []
    if _WRITE_HINT_RE.search(command):
        return []
    out: list[str] = []
    for words in _simple_commands(command):
        for arg in _reader_args(words):
            m = _SKILL_MD_TOKEN_RE.search(arg)
            if not m:
                continue
            name = m.group(1)
            if name not in out:
                out.append(name)
            if len(out) >= _MAX_BASH_SKILLS:
                return out
    return out


def _classify(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    """Return (skill_name, trigger_type) or None if this event is irrelevant."""
    if tool_name == "Skill":
        skill = (tool_input.get("skill") or "").strip()
        if skill:
            return skill, "tool_call"
    elif tool_name == "Read":
        path = (tool_input.get("file_path") or "").strip()
        # search(), NEM match(): a minta mostantol a path BARMELY pontjan illeszkedhet
        # (projekt-szintu skillek utja nem a home-mal kezdodik). A match() a 0. poziciohoz
        # kotne, es epp a projekt-szintu eseteket dobna el -- azt, amiert a mintat bovitettuk.
        m = _SKILL_MD_RE.search(path)
        if m:
            return m.group(1), "skill_read"
    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    session_id = payload.get("session_id") or None
    cwd = payload.get("cwd") or ""

    if tool_name == "Bash":
        events = [(name, "skill_read") for name in _classify_bash(str(tool_input.get("command") or ""))]
    else:
        result = _classify(tool_name, tool_input)
        events = [result] if result is not None else []
    if not events:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_payload(payload)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    for skill_name, trigger_type in events:
        body = json.dumps({
            "agent_id": agent_id,
            "skill_name": skill_name,
            "trigger_type": trigger_type,
            "session_id": session_id,
        }).encode()
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    f"http://localhost:{_web_port()}/api/skill-usage",
                    data=body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {token}",
                    },
                    method="POST",
                ),
                timeout=3,
            )
        except Exception:
            break  # never block the agent; a dead dashboard is not retried per skill

    sys.exit(0)


if __name__ == "__main__":
    main()
