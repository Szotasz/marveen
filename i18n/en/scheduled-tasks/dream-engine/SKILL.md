---
name: dream-engine
description: Nightly analysis loop over the day's memories, daily log and kanban state. Generates 4 prioritized action suggestions for the morning.
---

You are now running the "Dream Engine" nightly analysis loop. It is 02:07, {{OWNER_NAME}} is asleep, DO NOT send a message to the configured channel.

The goal: consolidate the day's knowledge and prepare 4 prioritized suggestions for the morning (07:30 morning briefing).

## What you have to do

Generate a `{{INSTALL_DIR}}/DREAM.md` file based on the 5 buckets below. The format is at the bottom of this file.

### Bucket 1: 💡 Skill suggestions (fleet level)

Go through the memories and the daily log of EVERY agent (the main agent and all sub-agents) for yesterday (24h). Find out:
- Was there an operation repeated manually 3+ times that would fit into a skill?
- A new, NOT yet covered pattern that would be worth turning into a skill?

SQL example:
```bash
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT agent_id, content, keywords FROM memories WHERE created_at > strftime('%s', 'now', '-24 hours') AND category IN ('hot','warm') ORDER BY agent_id, created_at"
```

Output: 0-2 concrete skill suggestions. For each: title + 1 sentence of reasoning + "fleet level" or "agent: <name>".

### Bucket 2: 🧹 Memory health (NO delete, move to the COLD tier)

```bash
# Vectorization check
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT COUNT(*) as total, COUNT(embedding) as with_emb FROM memories"
# If NOT 100%, call the backfill endpoint (it embeds the missing IDs with Ollama):
curl -s -X POST http://localhost:{{WEB_PORT}}/api/memories/backfill -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)"

# Stale hot tier (hot older than 7 days, not referenced via memories_fts in the last 24h)
# WARNING -- the CAST and the COALESCE are BOTH MANDATORY, do not remove them:
#   created_at/accessed_at are INTEGER, but strftime('%s',...) returns TEXT,
#   and in SQLite `integer < text` is ALWAYS TRUE (type order: INTEGER < TEXT).
#   Without CAST this query returns ALL hot memories, today's active ones too.
#   It caused damage twice: 2026-07-30 (148 rows to cold, same-day ones among them) and 2026-07-31 (35 rows).
#   AGE decides, not reads (DREAMHOTKOR916): accessed_at is refreshed by the memory search
#   and by the heartbeat on every read, so frequently read rows never aged
#   out and the hot tier never emptied (2026-09-16: 38 of 57 hot rows were like this). updated_at is refreshed
#   on a content or category change (memories_touch trigger) and can be NULL -> COALESCE to
#   created_at, which is never NULL. This way an old row rewritten today does not drop out either.
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, content, created_at, updated_at FROM memories WHERE category='hot' AND COALESCE(updated_at, created_at) < CAST(strftime('%s', 'now', '-7 days') AS INTEGER)"
```

**BEFORE THE BULK UPDATE IT IS MANDATORY:** first run the `SELECT` above, look at the
COUNT and a SAMPLE (the date of the newest match!), and the `UPDATE` must run on EXACTLY that
id set (`WHERE id IN (...)`), do not repeat the predicate. If the newest match
is from today, the predicate is wrong: stop. (Without an ID list the operation cannot be reversed
exactly: on 2026-07-31 this is why it could only be restored from a content sample.)

Operations:
1. Unvectorized memories: report how many you found (the fire-and-forget embedding job does it anyway, but here you check it).
2. Stale hot/warm → PUT into the COLD tier (UPDATE category='cold'). Never delete.
3. Exact duplicate content: report it, move it to cold.

Make the changes directly with SQL:
```bash
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "UPDATE memories SET category='cold' WHERE id IN (...)"
```

**DO NOT READ THE SUCCESS OF THE UPDATE FROM `changes()` (2026-08-07).** `sqlite3 db "SELECT changes()"`
opens a SEPARATE connection, and there the counter is always 0, even when the UPDATE ran
perfectly. For me it printed `moved: 0` for 14 successfully moved rows, and for a moment it looked
as if the operation had not gone through. **The proof is RE-MEASURING the predicate** (the filter now gives 0 matches) plus
reading back the itemized ID list (`SELECT category, COUNT(*) ... WHERE id IN (...) GROUP BY category`).
Same family as the other measurement traps of this bucket: the wrong instrument lies silently, and here
it happens to lie in the PESSIMISTIC direction, so the temptation is to run it again for nothing.

Output: a short statistic ("X memories moved to the cold tier, Y unvectorized resolved").

### Bucket 3: 🎯 Project priority (top 3 suggestions for tomorrow)

```bash
# Open kanban cards by project + priority
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, title, status, project, priority, assignee FROM kanban_cards WHERE status IN ('planned','in_progress','waiting') AND archived_at IS NULL ORDER BY project, priority DESC"
```

Group by project. In the daily log (last 7 days) check which project has active movement (commit, PR, kanban move). Produce a TOP 3 suggestion for tomorrow, weighted by priority + activity.

**THE LOG TABLE IS NAMED `daily_logs`, PLURAL (2026-08-09 02:1x, my own slip).** `daily_log` does NOT exist, and a query against it dies with an `Error: in prepare, no such table` line. This is dangerous because the error comes in the MIDDLE of the run, at the bottom of a `head`-ed output, and the run simply goes on: that day the top 3 was put together WITHOUT the activity data, from the kanban priority alone. The correct query (columns: `agent_id`, `date`, `content`, `created_at`):

```bash
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT agent_id, date, substr(content,1,120) FROM daily_logs WHERE created_at > CAST(strftime('%s','now','-7 days') AS INTEGER) ORDER BY created_at DESC"
```

**PROCEDURE: if the query of a bucket FAILS WITH AN ERROR, that is not an empty result but missing input.** Either fix it and run it again in the same run, or state in the `## ⚠️ Errors` section of DREAM.md that the given bucket worked from truncated input. Silently moving on is the worst option, because the output looks just as confident.

Output: 3 lines, each in the format `<project>: <card title / action> -- <reason in 1 sentence>`.

### Bucket 4: 🌐 External opportunities (new skill repo recommendations)

1-2 times a week (NOT every night: we avoid a noisy daily suggestion) run a WebSearch for new Claude Code / agentic AI / productivity skills. Filter:
- GitHub stars >100
- Recent activity (a commit in the last 90 days)
- README clarity (what the skill does, how to install it)

Limitation: if there was a recommendation in the last 7 days, skip it. The authoritative source is the PREVIOUS
night's copy of DREAM.md (its "External opportunity" section states the date of the last run), NOT a
`.external-ops-last-run` marker file: nothing writes the marker, so on its own it would rerun the search
every night (measured 2026-07-27: the marker stopped on 06-07). If we ever make the marker official,
the bucket must also WRITE it at the end (`date -u +%F > .external-ops-last-run`),
otherwise the DREAM.md archive stays the source.

**Gradual autonomy:** if you found a relevant external opportunity, READ the
`external_skill_adoption` category from the `{{INSTALL_DIR}}/store/autonomy-config.json` file.
If the config or the category is missing, treat it as `level 1` (fail closed).

- **Level 1: report only:** write only the repo URL and the reason for its relevance into DREAM.md. DO NOT modify any skill.
- **Level 2: propose + approval:** in DREAM.md give a concrete, local skill adaptation plan (which skill to create/patch, what would change), but DO NOT write a skill file. The morning briefing takes this to the owner; it can only be carried out after a later decision by the owner.

The highest allowed level of the `external_skill_adoption` category is 2. Based on an external opportunity, the Dream Engine does not create or modify a skill file on its own. The actual adaptation requires a decision by the owner.

Output (max 1 opportunity): repo URL + relevance + `mode=report|propose`.
### Bucket 5: 🛠 Skill fleet health (only NON-pinned skills)

```bash
# Stale skills: no use log, or pinned: false in the front matter
ls ~/.claude/skills/ | head
# In each SKILL.md, grep -l "pinned: true": these are all protected
grep -L "^pinned:" ~/.claude/skills/*/SKILL.md  # the skills that have no pinned flag (NOT built in)
```

Pinned default (always protected): claude-video, frontend-design, docx, skill-creator, skill-factory, skill-install-from-git, init, review, security-review, simplify, fewer-permission-prompts, loop, schedule, claude-api, update-config, keybindings-help, telegram:configure, telegram:access.

Output: 0-3 suggestions: "skill <name> is stale (last use >30 days), deletion or update suggested".

## Output format (DREAM.md)

```markdown
# 💭 Dream Engine -- 2026-05-12 02:07

## 💡 Skill suggestions
- (or "No new suggestion")

## 🧹 Memory health
346 / 346 vectorized, 5 moved hot→cold, 0 duplicates.

## 🎯 Top 3 suggestions for tomorrow
1. <project>: <action> -- <reason>
2. ...
3. ...

## 🌐 External opportunity
- (or "Skip: weekly limit reached" / "No relevant new repo")

## 🛠 Skill fleet health
- (or "Every skill is active or pinned")
```

## Rules

- **READ DREAM.md FIRST, only then overwrite it (2026-08-15 02:1x, one wasted call every night).** The file is overwritten every night, but Write refuses a file you have not read in this run (`File has not been read yet`). You have to read it anyway: the PREVIOUS copy of the External opportunity section is the authoritative source for when the search last ran. So one Read at the start of the run gives you two things at once, and saves a failed write.
- DO NOT send a message to the channel. DREAM.md is sent out by the morning briefing (07:30).
- The `Bash` and SQL operations are all local: no external API call of any kind (except the Ollama embedding if needed).
- If there is an obstacle (e.g. DB lock, missing embedding model), add a `## ⚠️ Errors` section at the end of DREAM.md: I will see it in the morning.
- **EM DASH GATE BEFORE CLOSING THE FILE, AND THE GATE PREVENTS THE WRITE, it does not just report (2026-08-08, caught)**: DREAM.md is NOT an internal note but OUTGOING text: the morning briefing takes it to the channel. So the owner's standing rule (no em dash, ever) applies to it too, it just was not stated anywhere in this task until now, and in the 2026-08-08 run SIX em dashes got into the file. The lesson is more general, and that same evening it already went off on two other surfaces: **an outgoing gate does not belong to the TYPE of the text but to the ACT of publishing**: if you built it into only one path, the other one lets it through silently.
  ```bash
  N=$(grep -oE '—|–|―' DREAM.md | wc -l | tr -d ' '); echo "dash=$N"
  [ "$N" = "0" ] || { echo "STOP: em dash in DREAM.md, fix it before you close the file"; }
  ```
  Fix it with Python (` — ` -> ` -- `, then any remaining long dash -> `--`), after that READ IT BACK and run the grep again.
- **AND THE GATE REPEATED ITSELF, BECAUSE WRITING TO DISK DOES NOT ARM IT (2026-08-11, the same six em dashes)**: on 08-08 the gate above went here, onto the DISK, but the running round gets the REGISTERED prompt, and that does not contain it. Measured: on disk 9142 bytes and one `GONDOLATJEL-KAPU` match, in `/api/schedules` 8147 bytes and ZERO. So the gate has not run a single time since it was written, and the 08-11 DREAM.md was produced with six em dashes just the same. **The lesson is not about the em dash: any pitfall of a scheduled task written in here DOES NOT EXIST until the registered prompt knows about it** (`project_scheduled_task_rules`: the file is not the registration). So the run must NOT expect the gate only from here: run it before closing `DREAM.md` even if it is not in the prompt you received. Syncing has to go the correct way (on disk there is a `{{BOT_NAME}}` placeholder, in the registered prompt the name is burned in, so a raw copy would break it); the open item sits on the `TASKSYNC811` card.
- To finish, write at the end of DREAM.md: `*{{BOT_NAME}}, 02:XX -- now I go to sleep too.*`
