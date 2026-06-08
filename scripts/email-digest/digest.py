#!/usr/bin/env python3
"""Address-based email digest for any IMAP account in store/email-rules.json.

Privacy-first: matches purely on the sender ADDRESS. No body or subject ever
leaves the mailbox to an LLM/cloud -- the ONE exception is the `ai_analysis`
allowlist (see below), whose content you explicitly opt into AI review for.
Rules live in store/email-rules.json (`@domain.com` = whole domain incl.
subdomains, `someone@company.com` = exact sender). The IMAP password lives
ONLY in the vault, fetched at runtime via the dashboard API -- never stored
in this repo. The Telegram chat is read from ALLOWED_CHAT_ID in .env.

Run modes (each wired to a separate scheduled task):
  --mode watch       (e.g. every minute): archive `archive`-rule mail into the
                     Archive folder (move, never delete), route `routes` mail to
                     custom folders, and Telegram-ping each NEW `important`
                     unread ONCE (deduped by Message-ID). Also triggers the AI
                     review (run-now) when a new `ai_analysis` mail arrives.
  --mode daily       (e.g. 08:00): send the day's numeric archive summary (how
                     many per domain) to Telegram and reset the tally.
  --mode ai-dump     print the `ai_analysis` mail for the AI task to read.
  --mode ai-archive  move the reviewed `ai_analysis` mail into Archive.

Matching respects two carve-outs:
  - \\Flagged (the IMAP "important"/star flag) -> never moved, stays in inbox.
  - `ai_analysis` senders -> left for the AI review task, not address-filtered.
"""
import imaplib, json, email, email.utils, email.header, urllib.request, urllib.parse, pathlib, sys, time
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONFIG = ROOT / "store" / "email-rules.json"
STATE = ROOT / "store" / "email-digest-state.json"      # notified important Message-IDs
TALLY = ROOT / "store" / "email-archive-tally.json"     # archived-per-domain since last daily
MAX_NOTIFIED = 3000    # cap the dedup ring so it cannot grow unbounded
AI_TASK = "email-ai-review"   # scheduled task the watch triggers per new ai_analysis mail
AI_RETRIGGER_SEC = 1800       # re-fire if a mail is still unread after 30 min (crash recovery)


def _env(key, default=""):
    envf = ROOT / ".env"
    if envf.exists():
        for line in envf.read_text().splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                return line[len(key) + 1:].strip().strip('"').strip("'")
    return default


def vault_password(vault_key):
    tok = (ROOT / "store" / ".dashboard-token").read_text().strip()
    port = _env("WEB_PORT", "3420")
    url = f"http://localhost:{port}/api/vault/" + urllib.parse.quote(vault_key, safe="")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    return json.load(urllib.request.urlopen(req, timeout=10)).get("value", "")


def telegram(text):
    token = _env("TELEGRAM_BOT_TOKEN")
    chat_id = _env("ALLOWED_CHAT_ID")
    if not token or not chat_id:
        print("no TELEGRAM_BOT_TOKEN / ALLOWED_CHAT_ID -- skip send"); return
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    urllib.request.urlopen(req, timeout=15)


def trigger_ai_task():
    """Fire the AI-analysis scheduled task via run-now (delivers its SKILL prompt
    to the agent, auto-starting it if down). Returns True on success."""
    tok = (ROOT / "store" / ".dashboard-token").read_text().strip()
    port = _env("WEB_PORT", "3420")
    url = f"http://localhost:{port}/api/schedules/{AI_TASK}/run"
    req = urllib.request.Request(url, data=b"{}", method="POST",
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=20)
        return True
    except Exception as e:
        print(f"AI-trigger HIBA: {e}", file=sys.stderr)
        return False


def _load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def matches(addr, rules):
    addr = (addr or "").lower()
    dom = addr.split("@")[-1] if "@" in addr else ""
    for r in rules:
        r = r.strip().lower()
        if not r:
            continue
        if r.startswith("@"):
            base = r[1:]
            # Domain rule covers the domain itself AND its subdomains
            # (@example.com -> info.example.com, mail.example.com, ...).
            if dom == base or dom.endswith("." + base):
                return True
        elif r == addr:
            return True
    return False


def _hdr(msg, name, default=""):
    raw = msg.get(name, default)
    try:
        return str(email.header.make_header(email.header.decode_header(raw)))
    except Exception:
        return raw


def _match_kind(addr, rules):
    """How `addr` matches `rules`: 'exact' (full address) > 'domain' > None."""
    addr = (addr or "").lower()
    dom = addr.split("@")[-1] if "@" in addr else ""
    best = None
    for r in rules:
        r = r.strip().lower()
        if not r:
            continue
        if r.startswith("@"):
            base = r[1:]
            if dom == base or dom.endswith("." + base):
                best = best or "domain"
        elif r == addr:
            return "exact"  # most specific -- can't be beaten
    return best


def classify(addr, important, archive):
    """'important' / 'archive' / None by specificity: an exact-address rule beats
    a domain rule in the other list (e.g. messages-noreply@social.example stays
    important even though @social.example is archived). On a tie, important wins."""
    rank = {"exact": 2, "domain": 1, None: 0}
    ik, ak = _match_kind(addr, important), _match_kind(addr, archive)
    if rank[ik] > rank[ak]:
        return "important"
    if rank[ak] > rank[ik]:
        return "archive"
    return "important" if ik else None


def match_route(addr, subject, routes):
    """First route whose sender matches and (if given) whose subject contains a
    keyword. Subject is matched LOCALLY only (never sent anywhere)."""
    subj = (subject or "").lower()
    for rt in routes:
        if not matches(addr, [rt.get("from", "")]):
            continue
        kws = rt.get("subject_contains") or []
        if not kws or any(k.lower() in subj for k in kws):
            return rt
    return None


def process_account(acct, important, archive, ai_rules, routes, notified):
    """Returns (new_important, arch_counts). Mutates `notified` with seen Message-IDs."""
    from collections import defaultdict
    pw = vault_password(acct["vault_key"])
    if not pw:
        print(f"[{acct['email']}] no vault password -- skip"); return [], Counter()
    M = imaplib.IMAP4_SSL(acct["imap_host"], int(acct.get("imap_port", 993)))
    M.login(acct["email"], pw)
    M.select("INBOX")  # read-write: we may move mail to Archive / route folders
    # Candidates: all UNSEEN (for the important-ping + new mail) PLUS every mail
    # (read or unread) from archive / route / ai senders, so already-READ junk
    # and read alerts get handled too. The important-ping itself stays unseen-only.
    typ, data = M.search(None, "UNSEEN")
    unseen = set(data[0].split() if data and data[0] else [])
    sender_terms = set()
    for r in archive:
        sender_terms.add((r[1:] if r.startswith("@") else r).strip().lower())
    for rt in routes:
        f = rt.get("from", "")
        sender_terms.add((f[1:] if f.startswith("@") else f).strip().lower())
    for r in ai_rules:
        sender_terms.add((r[1:] if r.startswith("@") else r).strip().lower())
    cand = set(unseen)
    for term in sender_terms:
        if not term:
            continue
        typ, d = M.search(None, "FROM", term)
        if typ == "OK" and d and d[0]:
            cand.update(d[0].split())
    archive_folder = acct.get("archive_folder", "Archive")
    new_important, moves, arch_counts, ai_unread = [], defaultdict(list), Counter(), []
    for mid in cand:
        # FLAGS + headers only. BODY.PEEK so the unread flag is NOT cleared.
        typ, parts = M.fetch(mid, "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])")
        if typ != "OK" or not parts or not parts[0]:
            continue
        meta = parts[0][0] or b""
        flagged = b"\\Flagged" in meta  # Thunderbird "important"/star
        msg = email.message_from_bytes(parts[0][1])
        addr = email.utils.parseaddr(msg.get("From", ""))[1]
        dom = addr.split("@")[-1].lower() if "@" in addr else ""
        subj = _hdr(msg, "Subject", "(nincs targy)")
        date = msg.get("Date", "")[:25]
        if matches(addr, ai_rules):
            # Left in the inbox for the AI task; record its Message-ID so the
            # watch can trigger a per-email analysis (deduped) for new ones.
            msgid = (msg.get("Message-ID") or msg.get("Message-Id") or "").strip() or f"{addr}|{date}"
            ai_unread.append(msgid)
            continue
        if flagged:
            continue  # Thunderbird-important stays in the inbox, untouched
        rt = match_route(addr, subj, routes)
        if rt:
            moves[rt.get("folder", archive_folder)].append(mid)
            if rt.get("notify") and mid in unseen:  # ping only new (unread) ones
                new_important.append({"from": addr, "subject": subj[:80], "date": date,
                                      "folder": rt.get("folder")})
            continue
        kind = classify(addr, important, archive)
        if kind == "archive":
            moves[archive_folder].append(mid)
            arch_counts[dom] += 1
        elif kind == "important" and mid in unseen:
            # Only ping unread important; a read one (e.g. surfaced by the sender
            # search) stays in the inbox untouched.
            msgid = (msg.get("Message-ID") or msg.get("Message-Id") or "").strip()
            key = msgid or f"{addr}|{subj}|{date}"
            if key in notified:
                continue
            notified.add(key)
            new_important.append({"from": addr, "subject": subj[:80], "date": date})
    for folder, mids in moves.items():
        ids_str = b",".join(mids).decode()
        M.copy(ids_str, folder)
        M.store(ids_str, "+FLAGS", "\\Deleted")
    if moves:
        M.expunge()
    M.logout()
    moved = sum(len(v) for v in moves.values())
    print(f"[{acct['email']}] {len(new_important)} uj fontos, {moved} mozgatva ({sum(arch_counts.values())} archiv)")
    return new_important, arch_counts, ai_unread


def run_watch(cfg):
    important = cfg.get("important", [])
    archive = cfg.get("archive", [])
    ai_rules = cfg.get("ai_analysis", [])
    routes = cfg.get("routes", [])
    state = _load_json(STATE, {})
    notified = set(state.get("notified", []))
    ai_triggered = dict(state.get("ai_triggered", {}))  # Message-ID -> epoch last triggered
    tally = Counter(_load_json(TALLY, {}))
    all_new, ai_seen = [], []
    for acct in cfg.get("accounts", []):
        try:
            new_imp, counts, ai_unread = process_account(acct, important, archive, ai_rules, routes, notified)
            all_new += [(acct["email"], f) for f in new_imp]
            tally += counts
            ai_seen += ai_unread
        except Exception as e:
            print(f"[{acct.get('email')}] HIBA: {e}", file=sys.stderr)
    # Per-email AI trigger: fire for any alert not triggered recently (new, or
    # still unread 30 min after a trigger that apparently did not finish).
    now = time.time()
    due = [m for m in ai_seen if now - ai_triggered.get(m, 0) > AI_RETRIGGER_SEC]
    if due:
        if trigger_ai_task():
            for m in ai_seen:
                ai_triggered[m] = now
            print(f"AI-review triggerelve ({len(due)} uj/lejart level)")
    # Drop trigger records for alerts no longer unread (analyzed + archived).
    ai_triggered = {m: t for m, t in ai_triggered.items() if m in ai_seen}
    # Persist dedup ring (trimmed) + AI trigger state + running archive tally.
    STATE.write_text(json.dumps({"notified": list(notified)[-MAX_NOTIFIED:], "ai_triggered": ai_triggered}))
    TALLY.write_text(json.dumps(dict(tally)))
    if all_new:
        lines = [f"Fontos olvasatlan ({len(all_new)}):", ""]
        for _box, f in all_new:
            tag = f"  [-> {f['folder']}]" if f.get("folder") else ""
            lines.append(f"- {f['from']}\n  {f['subject']}\n  {f['date']}{tag}")
        telegram("\n".join(lines))
        print("Fontos-ping elkuldve")
    else:
        print("nincs uj fontos -- nincs Telegram")


def run_daily(cfg):
    tally = Counter(_load_json(TALLY, {}))
    if not tally:
        telegram("Email napi osszesito: az elmult 24 oraban nem volt archivalando level.")
        print("ures tally -- 'semmi' uzenet"); return
    lines = [f"Email napi osszesito -- archivalva ({sum(tally.values())}):", ""]
    for dom, n in sorted(tally.items(), key=lambda x: -x[1]):
        lines.append(f"- {dom}: {n}")
    telegram("\n".join(lines))
    TALLY.write_text(json.dumps({}))  # reset for the next day
    print("Napi osszesito elkuldve + tally reset")


def _body_text(msg, limit=4000):
    """Plain-text body (fallback: HTML stripped). Used ONLY by the AI-analysis
    dump, which is restricted to ai_analysis senders -- no other mail's content
    is ever read out."""
    import re as _re
    def dec(part):
        try:
            return (part.get_payload(decode=True) or b"").decode(part.get_content_charset() or "utf-8", "replace")
        except Exception:
            return ""
    text = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                text += dec(part) + "\n"
        if not text.strip():
            for part in msg.walk():
                if part.get_content_type() == "text/html":
                    text += _re.sub("<[^>]+>", " ", dec(part)) + "\n"
    else:
        text = dec(msg)
    text = _re.sub(r"[ \t]+", " ", text)
    return text.strip()[:limit]


def _ai_candidate_uids(M, ai_rules):
    """All mail (READ or unread) from ai_analysis senders in the selected box --
    AI review is needed regardless of read status."""
    cand = set()
    for r in ai_rules:
        term = (r[1:] if r.startswith("@") else r).strip()
        if not term:
            continue
        typ, d = M.search(None, "FROM", term)
        if typ == "OK" and d and d[0]:
            cand.update(d[0].split())
    return sorted(cand, key=lambda b: int(b))


def run_ai_dump(cfg):
    """Print the ai_analysis mail (From/Date/Subject/Body) for the LLM task to
    analyze. Hard-restricted to the ai_analysis senders -- nothing else is ever
    dumped. BODY.PEEK keeps the unread flag so a failed run loses nothing."""
    ai_rules = cfg.get("ai_analysis", [])
    if not ai_rules:
        print("nincs ai_analysis szabaly a configban"); return
    total = 0
    for acct in cfg.get("accounts", []):
        pw = vault_password(acct["vault_key"])
        if not pw:
            continue
        M = imaplib.IMAP4_SSL(acct["imap_host"], int(acct.get("imap_port", 993)))
        M.login(acct["email"], pw); M.select("INBOX")
        for mid in _ai_candidate_uids(M, ai_rules):
            typ, p = M.fetch(mid, "(BODY.PEEK[])")
            if typ != "OK" or not p or not p[0]:
                continue
            msg = email.message_from_bytes(p[0][1])
            addr = email.utils.parseaddr(msg.get("From", ""))[1]
            if not matches(addr, ai_rules):
                continue  # safety: only ever read ai_analysis senders
            total += 1
            print(f"=== AI-REVIEW #{total} ===")
            print(f"From: {addr}")
            print(f"Date: {msg.get('Date', '')}")
            print(f"Subject: {_hdr(msg, 'Subject')}")
            print("Body:")
            print(_body_text(msg))
            print()
        M.logout()
    if total == 0:
        print("NINCS olvasatlan ai_analysis level")


def run_ai_archive(cfg):
    """Move the UNREAD ai_analysis mail to Archive (call after analysis)."""
    ai_rules = cfg.get("ai_analysis", [])
    moved = 0
    for acct in cfg.get("accounts", []):
        pw = vault_password(acct["vault_key"])
        if not pw:
            continue
        M = imaplib.IMAP4_SSL(acct["imap_host"], int(acct.get("imap_port", 993)))
        M.login(acct["email"], pw); M.select("INBOX")
        to_move = []
        for mid in _ai_candidate_uids(M, ai_rules):
            typ, p = M.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM)])")
            if typ != "OK" or not p or not p[0]:
                continue
            addr = email.utils.parseaddr(email.message_from_bytes(p[0][1]).get("From", ""))[1]
            if matches(addr, ai_rules):  # safety: FROM search is substring, re-verify
                to_move.append(mid)
        if to_move:
            af = acct.get("archive_folder", "Archive")
            ids_str = b",".join(to_move).decode()
            M.copy(ids_str, af); M.store(ids_str, "+FLAGS", "\\Deleted"); M.expunge()
            moved += len(to_move)
        M.logout()
    print(f"{moved} ai_analysis level archivalva")


def main():
    mode = "watch"
    if "--mode" in sys.argv:
        mode = sys.argv[sys.argv.index("--mode") + 1]
    cfg = json.loads(CONFIG.read_text())
    if mode == "daily":
        run_daily(cfg)
    elif mode == "ai-dump":
        run_ai_dump(cfg)
    elif mode == "ai-archive":
        run_ai_archive(cfg)
    else:
        run_watch(cfg)


if __name__ == "__main__":
    main()
