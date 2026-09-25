#!/usr/bin/env python3
"""UserPromptSubmit hook: a link the OWNER sends to their bot opens without a stall.

OWNERURL924: with the quarantine-reader in allowlist mode, a link the owner
sends to their own bot used to stop at the egress gate, and the bot had to ask
the supervisor to add the domain by hand -- for a page the owner explicitly
asked it to open.

OPT-IN: does nothing unless MARVEEN_OWNER_URL_ALLOW=1 (environment or the
install's .env).

What it does: for every <channel> DM in the prompt whose sender is the bot's
OWNER, each http(s) host in the message text is appended to
quarantine_domains in store/egress-allowlist.json, with a dated audit entry,
and the bot's rendered quarantine-reader definition is refreshed. The reader
keeps its isolation -- fetched content still comes back as data, never as
instructions.

Who counts as the owner:
  - MARVEEN_OWNER_URL_SENDERS (comma-separated user ids), if set;
  - otherwise the single DM entry of the bot's access.json allowFrom. With
    several paired contacts nobody qualifies (a guess would widen egress for a
    non-owner), unless MARVEEN_OWNER_URL_ANY_PAIRED=1 accepts every paired
    contact.
Note: the allowlist is shared by every agent of the install, so a host added
here is open to all of them.

What it deliberately does NOT do:
  - group messages (negative chat_id): anyone in a group could post a link;
  - non-owner senders: the whole point is the owner's own request;
  - private / local hosts: the gate's deny rules apply, and this hook skips
    anything that is not a public DNS name;
  - it never blocks the prompt: every failure exits 0.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _env_val(key, default=""):
    """Environment first, then the install's .env (hooks may not inherit it)."""
    if os.environ.get(key):
        return os.environ[key].strip()
    try:
        with open(os.path.join(ROOT, ".env")) as f:
            for line in f:
                if line.strip().startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return default


MAIN_AGENT_ID = _env_val("MAIN_AGENT_ID", "marveen")
ALLOWLIST = os.environ.get("OWNER_URL_ALLOWLIST_PATH", os.path.join(ROOT, "store", "egress-allowlist.json"))
CHANNEL_RX = re.compile(r'<channel\s+source="plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+"([^>]*)>(.*?)</channel>', re.DOTALL)
URL_RX = re.compile(r"https?://([A-Za-z0-9.-]+)(?::\d+)?(?:[/?#][^\s<>\"')\]]*)?", re.IGNORECASE)
PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".lan")


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def public_host(host):
    h = (host or "").strip(".").lower()
    if not h or "." not in h or h == "localhost" or h.endswith(PRIVATE_SUFFIXES):
        return None
    if re.fullmatch(r"[0-9.]+", h):  # IP literal: never auto-allow
        return None
    if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", h):
        return None
    return h


def _access_path(cwd):
    for base in (os.path.join(cwd, ".claude", "channels", "telegram"),
                 os.path.join(os.path.expanduser("~"), ".claude", "channels", "telegram")):
        p = os.path.join(base, "access.json")
        if os.path.isfile(p):
            return p
    return None


def paired_senders(cwd):
    p = _access_path(cwd)
    if not p:
        return set()
    try:
        with open(p) as f:
            return {str(x) for x in json.load(f).get("allowFrom", [])}
    except Exception:
        return set()


def owner_senders(cwd):
    explicit = [x.strip() for x in _env_val("MARVEEN_OWNER_URL_SENDERS").split(",") if x.strip()]
    if explicit:
        return set(explicit)
    dm = {x for x in paired_senders(cwd) if x and not x.startswith("-") and x != "0"}
    if len(dm) == 1:
        return dm
    if _env_val("MARVEEN_OWNER_URL_ANY_PAIRED") == "1":
        return dm
    return set()


def hosts_to_allow(prompt, senders):
    out = []
    for m in CHANNEL_RX.finditer(prompt or ""):
        attrs, text = m.group(1), m.group(2)
        chat_id = (_attr(attrs, "chat_id") or "").strip()
        user_id = (_attr(attrs, "user_id") or "").strip()
        if not chat_id or chat_id.startswith("-"):  # groups excluded
            continue
        if user_id not in senders:
            continue
        for u in URL_RX.finditer(text):
            h = public_host(u.group(1))
            if h and h not in out:
                out.append(h)
    return out


def add_hosts(hosts, agent, path=ALLOWLIST):
    with open(path) as f:
        d = json.load(f)
    q = d.setdefault("quarantine_domains", [])
    have = {x.lower() for x in q} | {x.lower() for x in d.get("domains", [])}
    new = [h for h in hosts if h not in have]
    if not new:
        return []
    q.extend(new)
    log = d.setdefault("_owner_url_auto", [])
    log.append({"at": time.strftime("%Y-%m-%d %H:%M"), "agent": agent, "hosts": new,
                "why": "OWNERURL924: link sent by the bot's owner in a DM"})
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".egress-allowlist.")
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return new


def refresh_reader(agent):
    js = ("const m=await import('%s/dist/web/agent-scaffold.js'); m.ensureQuarantineReader(%s); process.exit(0)"
          % (ROOT, json.dumps(agent)))
    subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT,
                   capture_output=True, timeout=20)


def main():
    try:
        payload = json.load(sys.stdin)
        if _env_val("MARVEEN_OWNER_URL_ALLOW") != "1":
            sys.exit(0)
        cwd = payload.get("cwd") or os.getcwd()
        agent = os.path.basename(os.path.normpath(cwd)) if "/agents/" in cwd else MAIN_AGENT_ID
        hosts = hosts_to_allow(payload.get("prompt") or "", owner_senders(cwd))
        if not hosts:
            sys.exit(0)
        new = add_hosts(hosts, agent)
        if new and agent != MAIN_AGENT_ID:
            refresh_reader(agent)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
