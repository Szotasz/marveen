---
name: kanban-audit
description: Kanban board audit every 4 hours. Cleanup (archive done cards older than 7 days) + follow-up on stuck tasks (started, not moved since -> ping the assignee).
---

# Kanban 4-hour audit

## When it runs
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Autonomy level (config-driven, MANDATORY FIRST)

Read it (with python3, because `jq` is NOT installed on an average Linux machine):
```bash
python3 -c "
import json
d=json.load(open('{{INSTALL_DIR}}/store/autonomy-config.json'))
for c in d.get('categories',[]):
    if c.get('key') in ('kanban_archive_done','kanban_stuck_nudge'):
        print(c['key'], c.get('level'))
" 2>/dev/null
```

The levels of the two categories control steps 2 and 4:
- **`kanban_archive_done`** (step 2): level 3 → archive on your own. level 2 → do NOT archive, propose it on Telegram ("X done cards older than 7 days are waiting to be archived, OK to go ahead?") and wait for approval. level 1 → only report the number.
- **`kanban_stuck_nudge`** (step 4): level 3 → ping the assignee on your own, and escalate to the owner ({{OWNER_NAME}}) ONLY after 2 unsuccessful audit rounds (the comment history shows how many times you pinged). level 2 → do not ping on your own, propose it to the owner ({{OWNER_NAME}}) on Telegram. level 1 → only list the stuck tasks.

If the config is missing, unreadable, or the key is not in it (the command above prints nothing) → level 1: only report, do not archive and do not ping. This is the level of `seed-config`; a missing config must not switch on the most permissive behavior.

## Procedure

1. **Read the state file**: `store/kanban-audit-state.json` holds the `last_audit_at` Unix timestamp. On the first run it is null -> do not ping anyone, only set the state.

   Use the dashboard API to reach the board, NOT the `sqlite3` CLI (see Pitfalls).
   The port comes from `.env`, so it also works on a non-default port:
   ```bash
   PORT="$(sed -n 's/^WEB_PORT=//p' {{INSTALL_DIR}}/.env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-3420}"
   TOKEN="$(cat {{INSTALL_DIR}}/store/.dashboard-token)"
   ```

2. **Cleanup**: archive done cards older than 7 days (list them first, then archive them one by one):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,time
cut=int(time.time())-7*86400
d=[c for c in json.load(sys.stdin) if c.get('status')=='done' and not c.get('archived_at')]
o=[c for c in d if (c.get('updated_at') or 0) < cut]
print(f'Cleanup: examined={len(d)}, hits={len(o)}' + ('' if d else ' (could not measure)'))
for c in o: print(c['id'])
" | tail -n +2 | while read -r id; do
     curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban/$id/archive" >/dev/null
   done
   ```

3. **Stuck task detection** (started and not moved since, not only `in_progress`; the logic lives in `/api/kanban/stuck`):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban/stuck?planned_days=7&active_days=3" | python3 -c "
import json,sys,time
d=json.load(sys.stdin)
print(f\"Stuck: examined={d['examined']}, hits={len(d['stuck'])}\" + ('' if d['examined'] else ' (could not measure)'))
now=int(time.time())
for c in sorted(d['stuck'], key=lambda c: -c['last_activity']):
    print(' ', c['id'], '|', (c.get('assignee') or '-'), '|', round((now-c['last_activity'])/3600.0,1), 'h |', c['title'])
w=d['waiting']
print(f\"Waiting: {w['examined']}, overdue: {len(w['overdue'])}, without deadline: {w['without_deadline']}\")
for c in w['overdue']:
    print(' ', c['id'], '|', (c.get('assignee') or '-'), '|', c['overdue_days'], 'days late |', c['title'])
"
   ```
   Only the assignee's own, non-automated comment counts as a work trace. Write bulk or automated comments with `"automated": true` (POST `/api/kanban/<id>/comments`). `waiting` is not idleness: report the overdue ones to the owner, do not ping them.

4. **Stuck task -> ping**: for every stuck card, send an inter-agent message to the assignee (except to {{MAIN_AGENT_ID}} and to an empty assignee):
   ```
   "Kanban audit: {card_id} ({title}) has been in_progress for {hours_stale}h without movement (since the previous audit). Update the status (done/waiting) or add a comment saying what is blocking it."
   ```


   **RUN NOTE for the SQL below:** the `sqlite3` CLI is not installed on every machine
   (see Pitfalls), so run the SQL with python3's built-in sqlite3 module:
   ```bash
   python3 -c "import sqlite3
for r in sqlite3.connect('{{INSTALL_DIR}}/store/claudeclaw.db').execute('''<SQL GOES HERE>'''):
    print(*r, sep=' | ')"
   ```
   The blocks below document the SQL; the `sqlite3 db "..."` form in the examples shows the LOGIC,
   the actual run goes through the python3 wrapper above.

4b. **WAITING ROUND CHECK** (since 2026-07-27, the full text is in the reference file): `~/.claude/scheduled-tasks/kanban-audit/references/kanban-audit-step4b-waiting.md`.
   **MANDATORY to read when executing step 4**: the SQL and the decision rules (CROSSER / NEW ENTRY) are there and must not be skipped.

4c. **SEND-OUT DETECTOR FOR FRESH CARDS (since 2026-08-24, AUDITKIKULD823: this was MISSING until now,
   and a customer report sat for 4.5 hours because of it).** None of the three nets above (done archiving, stuck
   `in_progress`, `waiting` older than 30 days) catches a card that was created TODAY, sits in
   `planned`, has a NAMED fleet assignee, and was NEVER sent to them. The triggering case:
   the 01ABD89F connectors report was created at 15:12 as `planned/samu`, zero messages
   went out about it until 19:4x, and the OWNER asked about it on Telegram; we did not notice it ourselves.
   ```bash
   LAST="$(python3 -c "
import json
try: print(json.load(open('{{INSTALL_DIR}}/store/kanban-audit-state.json')).get('last_audit_at') or 0)
except Exception: print(0)
")"
   ```
   ```sql
   -- run with the python3-sqlite wrapper; substitute the $LAST value
     SELECT k.id, k.status, k.assignee, datetime(k.created_at,'unixepoch','localtime'), substr(k.title,1,60)
       FROM kanban_cards k
      WHERE k.archived_at IS NULL
        AND k.status IN ('planned','waiting')
        AND k.created_at >= $LAST
        AND lower(k.assignee) IN (<the install's sub-agent names in lowercase, per the agents/ directory>)  -- ALLOWLIST, NOT "NOT IN"
        AND NOT EXISTS (SELECT 1 FROM agent_messages m
                         WHERE m.from_agent <> 'heartbeat'
                           AND (m.content LIKE '%'||k.id||'%'
                                OR (k.id GLOB 'PR[0-9]*' AND m.content LIKE '%#'||substr(k.id,3)||'%'))
                           AND m.created_at >= k.created_at)
      ORDER BY k.created_at
   ```

   **THE `NOT IN` FILTER IS NOT ENOUGH, AN ALLOWLIST IS NEEDED, AND MY OWN TEXT ALREADY SAID SO, YET THE QUERY
   DID NOT FOLLOW IT (2026-08-26 08:00, measured).** The paragraph below has said since 2026-08-10 that for an EXTERNAL
   author zero inter-agent messages is the EXPECTED state (they get a PR comment or an email). The query, however,
   had an exclusion list of the form `NOT IN ('', '<main-agent>', '<owner>')`, so every external name SLIPPED THROUGH it. The 08:00 full-set
   run reported FIVE `waiting` items as not sent out, and ALL FIVE belonged to external people
   (zollak, stivi1g-gif, tekt, szuszupaks, zsuzsa). Zero real findings, five rows of noise: exactly the kind
   next to which a real finding would get lost.
   Report: examined=N,hits=K,0→notmeasured.
   **THE BROADER LESSON: a written rule next to which the QUERY stays the old one is worth as much as an
   unwritten rule.** The text and the code must be fixed AT THE SAME TIME, otherwise the skill contradicts itself.
   If there is a hit, the card did not get done by itself: send it to its assignee, and add a
   comment to the card saying the send-out was made up for by the audit.
   **ZERO HITS ALONE IS NOT PROOF: RUN A POSITIVE CONTROL (2026-08-23 20:2x, measured).**
   The fresh window is typically empty, and the empty set looks exactly like a query that never fires.
   So also run the detector once on the FULL open set (dropping the `created_at >= $LAST` line):
   if it finds nothing there either, the INSTRUMENT is broken, not the world. The query above, run on 2026-08-24
   at 05:5x: fresh window 0 hits, full set `planned` 77 + `waiting` 9, so the
   detector fires and the fresh zero is a REAL zero.
   **BUT MATCHING ON THE CARD ID GIVES A FALSE POSITIVE FOR EVERY PR CARD (2026-08-24 16:0x, measured).**
   The query looks for the card ID in the messages (`content LIKE '%'||k.id||'%'`), but PR card
   IDs have the form `PR1059`, and in conversation we NEVER call the PR that, we call it
   `#1059`. Because of this, today's round reported `PR1058` and `PR1059` as not sent out, although
   I had written to the assignee about both in the same hour. The false positive is more expensive than usual here:
   IT HIDES THE REAL FINDING (that day a 30-day-old card that really was not sent out, `9D766E19`),
   because the list fills up with noise, and a person skims a noisy list.
   **FIX: for a PR card, also accept the `#<number>` form.**
   ```sql
   AND NOT EXISTS (SELECT 1 FROM agent_messages m
                    WHERE m.from_agent <> 'heartbeat'
                      AND (m.content LIKE '%'||k.id||'%'
                           OR (k.id GLOB 'PR[0-9]*' AND m.content LIKE '%#'||substr(k.id,3)||'%'))
                      AND m.created_at >= k.created_at)
   ```
   `substr(k.id,3)` cuts off the `PR` prefix. Without the `GLOB` condition, a fragment of a
   non-PR card ID could also match by accident.

   **BUT MY OWN HEARTBEAT DIGEST ALSO "MENTIONS" THE CARD ID, AND THAT IS A FALSE POSITIVE (2026-08-25, measured).**
   The hourly digest lists card IDs (the `urgent` list AND the 8 most recent `waiting` cards),
   so `content LIKE '%<ID>%'` finds a match for every such card, and the detector reads it as a send-out.
   THE MEASURED CASE: INSTPWURES825 (urgent, deadline tomorrow) sat unsent for three hours, and its
   message trace was NOT zero but FOUR: all four were my own digest reading the
   card ID back to me. So the trace existed, it just did not lead to the assignee.
   **FIX, one line:** `AND m.from_agent <> 'heartbeat'` inside the NOT EXISTS. This does NOT contradict the
   "any message" rule below: the digest is not a mention by a person or an agent, but an automated
   read-back TO ME.
   **ITS SCOPE IS NARROW, AND MEASURE THIS TOO, DO NOT ASSUME IT:** in the 2026-08-25 20:00 round the two variants
   (with and without heartbeat) gave the SAME result, because the hit at the time was `planned`, and the digest
   only lists the `urgent` cards and the most recent `waiting` ones. In other words the blindness is TARGETED: it exists exactly for
   the most important cards.

   **TWO MORE GAPS IN THE SAME DETECTOR (2026-08-25, same round):**
   1. **A STATUS CHANGE KNOCKS IT OUT OF THE WINDOW.** The query is `status IN ('planned','waiting')`. If anyone sets an
      unsent card to `in_progress`, the detector NO LONGER looks for it: exactly the card drops out
      that the board claims someone is working on RIGHT NOW. If the send-out trace is missing,
      the `in_progress` setting itself is the suspicious part.
   2. **THE FRESH WINDOW GIVES ONE CHANCE ONLY.** The `created_at >= $LAST` filter is justified by backlog noise
      (on the old `planned` set zero messages is the EXPECTED state), but if a card slips through one round,
      it never becomes visible again. **It needs a less frequent FULL-SET run alongside it** (once a day,
      e.g. in the 08:00 round), and its output must NOT be the bare number: on 2026-08-25 the full set gave
      76 `planned` + 5 `waiting` unsent cards, and a large part of the 76 is legitimate backlog. The finding is the
      FRESH card WITH A NAMED ASSIGNEE, not the count.

   **THE CONDITION DELIBERATELY ACCEPTS ANY message that mentions the card ID, not only the
   marveen -> assignee direction.** If the assignee raised it THEMSELVES (their own card, feedback), then they know
   about it, and the purpose of the send-out is met. Do not "fix" it into outgoing-only filtering: then a card
   the assignee created themselves would raise a false alarm in every round.
   **BUT DO NOT REPORT THE 117 AS A FINDING: BROKEN DOWN, IT SAYS SOMETHING ELSE (same measurement).** `planned` 110/244,
   `waiting` 7/98. The old `planned` set is BACKLOG: there zero messages is the EXPECTED state, not an omission.
   That is why the query filters on the fresh window: the finding is the NEW card with a named assignee, not the backlog.


5. **Update the state file** (at the END of the run): `store/kanban-audit-state.json` -> `{"last_audit_at": <current Unix timestamp>}`.

6. **Undelegated cards**: every non-archived, NOT `done` card (filter by exclusion, not by listing the statuses) whose assignee is NULL/empty -> log + Telegram only if there are 3+ of them.
   Report: examined=N,hits=K,0→notmeasured.

6a. **Cards with a status no detector covers** (KANBANSTATUSZVAK916, MANDATORY in every round): the other
   detectors filter on the four statuses `planned`, `in_progress`, `waiting`, `done`, but the board allows more
   (according to the CHECK in the `kanban_cards` schema, `testing` is also valid). Such a card does not show up in ANY
   detector (measured case 2026-09-16: `17d07456`, `testing`, since 2026-09-05); for the audit it does not exist.
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,time
COVERED={'planned','in_progress','waiting','done'}
for c in json.load(sys.stdin):
    if c.get('archived_at') or c.get('status') in COVERED: continue
    age=(time.time()-(c.get('updated_at') or 0))/86400
    print(c['id'][:8],'|',c.get('status'),'|',round(age,1),'days without movement |',(c.get('title') or '')[:50])
"
   ```
   **If there is a hit:** it goes into the round's report with ID, status and age, and it also
   goes out on Telegram (point 7), because the stuck and the
   undelegated measurements do not apply to these cards. **If 0:** it appears as 0 in the report too, do not leave it out,
   otherwise it is not visible that the step ran. Extend the `COVERED` set only if
   a detector actually measures the new status, otherwise the extension hides the card again.
   Report: examined=N,hits=K,0→notmeasured.

6b. **PRE-DATED TITLE STAMP detector** (introduced on 2026-08-25, because the error happened for the fourth time):
   the time written into a card title may be ESTIMATED, and in a long session it accumulates a MONOTONICALLY GROWING drift
   (measured case: 17 cards, from +16 minutes to +189 minutes). `updated_at` is authoritative, the time copied into the title is not:
   this is denormalization, and the copy can drift.
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/kanban" | python3 -c "
import json,sys,datetime,re
# IMPORTANT: the pattern must ALSO match the 'HH:1x' form, otherwise you get a silent zero
pat=re.compile(r'(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d)[\dxX]')
for c in json.load(sys.stdin):
    if c.get('archived_at') or not c.get('updated_at'): continue
    real=datetime.datetime.fromtimestamp(c['updated_at']); m=pat.search(c.get('title') or '')
    if not m or m.group(1)!=real.strftime('%Y-%m-%d'): continue
    d=(real.replace(hour=int(m.group(2)),minute=int(m.group(3))*10,second=0)-real).total_seconds()/60
    if d>10: print(c['id'],'| title claims',m.group(0)[-5:],'| actual',real.strftime('%H:%M'),'| +%d min'%d)
"
   ```
   **If there is a hit:** fix the TITLE to the actual `updated_at` (do NOT move `updated_at`: this is
   a stamp fix, not a state change), and write the count into the round's report. Do NOT rewrite
   the comments: the history must stay readable, but the title is state, and the heartbeat works from it.
   **Control, so the zero is not blind:** if there are 0 hits, also run it on a known positive
   (a future time temporarily written into any card's title), otherwise a pattern error looks like zero.


7. **Only write on Telegram if**:
   - there are 3+ stuck tasks (critical)
   - New blocker (waiting > 48h)
   - Card with a status no detector covers (6a): at most once a day about the same card, in the other rounds only in the report
   - **A HARD BLOCKER WAITING ON THE OWNER, regardless of status and age.**
     The two thresholds above are narrow, because both look at STATE or AGE, but
     a blocker can be fresh, and it can be `planned` too. 2026-08-11: a
     card saying that a provider's prepaid balance had run out and
     every call returned 429, in `planned` status, had existed for 100 minutes,
     so NEITHER "3+ stuck" NOR "waiting > 48h" caught it.
     Meanwhile it had stopped four threads, and only the owner could resolve it,
     because it was billing.
     The rule: if a card (a) describes a hard stop, (b) its assignee is the
     owner, or according to its description only the owner can do it, and (c) there is no
     sign that anyone told them, then it goes out on Telegram.
     Checking (c): look at whether anyone asked for it to be forwarded in an inter-agent
     message, and skim your own outgoing messages. If in doubt, rather
     speak up: a blocker said twice is cheaper than a fleet standing still for four hours.
   - Otherwise stay quiet (heartbeat style)

## Pitfalls

The detailed list of pitfalls: `~/.claude/scheduled-tasks/kanban-audit/references/kanban-audit-buktatok.md`.

## Verification
- The state file was updated at the end of the run.
- Inter-agent messages succeeded (200 response).
