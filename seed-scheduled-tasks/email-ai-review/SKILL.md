---
name: email-ai-review
description: Per-email AI review of the `ai_analysis` senders in store/email-rules.json. Triggered by the email-watch task (via run-now) when a new such mail arrives -- not on a clock. Reads the mail, summarizes WHAT happened (benign vs needs-attention), sends it to Telegram, then archives it.
---

# Email AI review (ai_analysis senders)

## When / purpose
Event-driven: the per-minute `email-watch` task fires this one through the
run-now endpoint as soon as a new unread mail from an `ai_analysis` sender
arrives (deduped by Message-ID, re-fired after 30 min if still unread). The
`ai_analysis` list is for senders whose mail cannot be triaged by address
alone -- monitoring alerts, system reports, anything you need to actually read.
This task is the ONLY place email CONTENT reaches the LLM, and only for these
explicitly-listed senders (the dump script is hard-restricted to the config's
`ai_analysis` list).

## Procedure

1. **Read the mail** (dumps only the `ai_analysis` unread, BODY.PEEK -- does not
   mark them read):
```bash
python3 scripts/email-digest/digest.py --mode ai-dump
```

2. **Analyze.**
   - If the output is `NINCS olvasatlan ai_analysis level`, reply with one short
     line ("AI review: nothing new") and skip to step 4 (ai-archive will move 0).
   - Otherwise, give a short per-mail summary: WHAT happened, and your verdict --
     **benign** (routine / no action) or **NEEDS ATTENTION** (a real problem).
     Make anything genuinely concerning stand out. Be terse and factual; do not
     paste the full body, just the essence.

3. **The summary is your reply** -- it goes to Telegram (this is a `task`-type
   scheduled task). Keep it short.

## Pitfalls
- The dump uses BODY.PEEK: if the run is interrupted, the mail stays unread and
  is not lost.
- Only `ai_analysis` senders are ever dumped -- never widen this to other mail.

## Verify / close
4. **Archive** the reviewed mail (moves only `ai_analysis` senders into the
   Archive folder, never deletes):
```bash
python3 scripts/email-digest/digest.py --mode ai-archive
```
Run this only AFTER the analysis. If step 2 found nothing, it moves 0 -- fine.
