# Kanban audit: 4b. waiting age check (references)

4b. **WAITING AGE CHECK (from 2026-07-27, this was MISSING from the procedure until now)**: until now the audit
   looked ONLY at `in_progress` stuck cards, never at `waiting`. Because of this 12 cards sat
   unnoticed for 30+ days, among them a security fix (34 days) and a reply owed to an external
   person (waiting for approval for 5 days).
   ```sql
   SELECT id, assignee, date(updated_at,'unixepoch','localtime'), substr(title,1,60)
     FROM kanban_cards
    WHERE archived_at IS NULL AND status='waiting'
      AND updated_at < strftime('%s','now','-30 days')
    ORDER BY updated_at
   ```
   (Run it with the python3-sqlite wrapper above.)
   - Do NOT report the bare number to the owner in every round (that would turn into noise too). Speak up if
     the number GROWS since the previous audit, or if there is one among them that concerns an EXTERNAL
     person or security.
   - **BUT GROWTH CAN HAVE TWO SEPARATE CAUSES, AND ONLY ONE OF THEM IS A FINDING (2026-08-08, measured).**
     The 16:00 audit measured the number growing from 3 to 4 -- and the fourth was NOT a new problem:
     `cbe2a240` (update system overhaul) crossed 30 days THAT DAY, with unchanged content.
     If you report on bare number growth, you raise an alarm every time an old
     card simply ages -- the signal then depends on the calendar, not on reality.
     **PROCEDURE: split it into TWO parts before you report.** (a) NEW ENTRY: it GOT INTO
     `waiting` since the previous audit and is already 30+ days old -- rare, and a real finding. (b) CROSSER: it was already sitting on `waiting`,
     it has only now reached 30 days -- this is the calendar's doing, not a change. Report ONLY on (a),
     and on the external-person/security highlight; (b) goes into the transcript, and its place is the
     next priority weighing. Telling them apart is one query: if the card's `updated_at`
     is OLDER than the previous `last_audit_at`, it is a CROSSER.

     **BUT THE SENTENCE ABOVE IMPLIES A QUERY THAT CAN NEVER FIRE -- IT HAPPENED TO ME
     (2026-08-19 11:5x, own error, caught during the round).** I read the text as saying that a NEW ENTRY
     is one whose `updated_at` is AFTER the previous audit, and I wrote: `updated_at >= LAST AND
     updated_at < now-30 days`. **These two conditions are NEVER true at the same time:** what was refreshed four hours ago
     cannot have been sitting for 30 days. So the query ALWAYS returns zero, and the zero looks like a
     reassuring measurement result. Exactly the kind of metric that no reality can refute
     (see [[feedback_a_metric_needs_a_refuter]]).
     **THE CORRECT CROSSER QUERY, copyable:**
     ```sql
     -- the ones that crossed the 30 day line SINCE THE PREVIOUS AUDIT
     SELECT id, assignee, datetime(updated_at,'unixepoch','localtime'), substr(title,1,45)
       FROM kanban_cards
      WHERE archived_at IS NULL AND status='waiting'
        AND updated_at <  strftime('%s','now','-30 days')   -- already 30+ days old TODAY
        AND updated_at >= <LAST> - 30*86400;                -- was NOT yet at the PREVIOUS audit
     ```
     On 2026-08-19 this gave two cards (E728AE14, E3702858, both 2026-07-20 11:25) -- so the
     instrument fires when there is something for it to find.
     **AND IN PRACTICE BRANCH (a) IS AN ALMOST EMPTY SET:** for a card to GET INTO `waiting`
     since the previous audit AND be 30+ days old right away, the status change would have to NOT refresh
     `updated_at`. Here it does refresh it. So do not look for (a) with a detector, but at the moment
     of the status change -- the real subject of the report is the CROSSER list and the external-person/security highlight.
   - Pruning the backlog is an OWNER DECISION, do not do it on your own (see the deep-clean pitfall).
     Your job is to produce the list. Report: examined=N,hits=K,0→notmeasured.
