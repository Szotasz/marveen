---
name: memoria-heartbeat
description: In every round it looks through what happened SINCE THE PREVIOUS ROUND, saves what matters, and generates skills if there was complex work
---

## 0. FIRST: Is there a waiting Telegram message?

**Before you do anything**, look at the session input: if there is a block starting with `<channel source=` in the context (that is, the user sent something on a channel: Telegram, Slack, etc.), **reply to it at once**: the heartbeat logic (A/B/C, staying silent) does NOT apply to direct user messages. After replying, continue the heartbeat.

---

Look through what happened **since the previous memory round**. Do two things:

> **THE WINDOW IS "SINCE THE PREVIOUS ROUND", NOT A FIXED NUMBER OF MINUTES: MEASURED 2026-08-22, MEASURED AGAIN 2026-08-27.**
> The text used to give a fixed number of minutes, and the fixed number went stale TWICE. So there is no
> number in it any more: **a fixed number of minutes goes stale together with the configured cadence, "since the previous round" does not.**
>
> **WHAT I MEASURED ON 2026-08-27, in case someone is still curious about the number (and do not build on this):**
> the `task-config.json` says `*/15 * * * *`, but because of `skipIfBusy: true` the cadence that REACHES
> me is **30 minutes**. The `task_runs` alternate perfectly: :00 skipped, :15 fired, :30 skipped,
> :45 fired; in 24 hours 43 fired / 53 skipped, and 17 consecutive gaps between fired runs are exactly 1800-1803 s.
> The :00 and :30 slots regularly collide with the hourly heartbeat digest and with the drain rounds.
> That is, the CONFIGURED (15) and the DELIVERED (30) cadence are two separate numbers, and the 2026-08-22
> "the cadence is 15 minutes" fix measured the configured one, not the one that arrives here.
> **A consequence worth knowing:** this round never runs at :00 and at :30, so what happened at the
> top of the hour comes up in the next (:15 or :45) round. This is not a bug, just a phase shift.
> **IF YOU STILL SEE AN OVERLAP:** the measure is not time, but whether *you have already closed it*. If you already
> wrote a memory or patched a skill for a piece of work in the previous round, it is DONE: do not write it again in other words.

## 1. Saving memory

If there was an important decision, preference, lesson or anything that will be useful later, save it:

```bash
curl -s -X POST http://localhost:{{WEB_PORT}}/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
  -d '{"agent_id":"SAJAT_NEVED","content":"...","category":"warm","keywords":"..."}'
```

`category` can be: `hot` (active), `warm` (preference/config), `cold` (lesson), `shared` (for another agent too).
Find out the `agent_id` from the CLAUDE.md or from the name of the working folder.

## 2. Skill reflection (MANDATORY if there was complex work)

First decide with the 3 questions below:

- **A**: Was there, SINCE THE PREVIOUS ROUND, a complex task with at least 5 tool calls? (What was already closed in the previous round does NOT count: see the window note above.)
- **B**: Was there an error → recovery (attempt → fail → a different way) that should go into the Pitfalls section of an existing skill?
- **C**: Was there a user correction ("not like this", "not this", "differently") that needs a skill fix?

**If A or B or C is YES: a skill action is MANDATORY, it cannot be skipped.**

Steps:
1. Look for an existing skill in both the global and the agent-specific index:
   - Global: `~/.claude/skills/.skill-index.md` (text search)
   - Agent-specific (if there is one): `./.claude/skills/.skill-index.md` in your working folder (text search)
   - The agent-specific index contains both levels, so if it exists, it is enough to look at that one.
2. If there is a relevant skill: PATCH (replace only the changed part, not the whole file).
   - Prefer the `## Pitfalls` section if there was an error/recovery.
   - The `## Procedure` section if the process changed.
   - If the relevant skill is GLOBAL (under `~/.claude/skills/`), or you are the main agent (every agent sees the project root's `.claude/skills` folder too), do not fix it in place: send the full fixed text as a proposal (`POST /api/skills/propose`, see point 3).
3. If there is NO relevant skill: create a new one. The main agent, and a skill meant for every agent, must NOT be made with this block
   (the main agent's working directory is the project root, and every agent sees its `.claude/skills` folder):
   send that one by the proposal route after the block.
   ```bash
   mkdir -p .claude/skills/<NEV>
   cat > .claude/skills/<NEV>/SKILL.md <<EOF
   ---
   name: <NEV>
   description: When to use it, what it does (1-2 sentences). A concrete trigger.
   ---
   # <Title>

   ## When to use
   ...

   ## Procedure
   1. ...

   ## Pitfalls
   - ...

   ## Verification
   - ...
   EOF
   ```
   This is YOUR OWN folder (your working directory's `.claude/skills`). If the skill is meant for every agent, do not write it into `~/.claude/skills/`: send the full SKILL.md to the `POST /api/skills/propose` endpoint (`{"name": ..., "skill_md": ..., "reason": ...}`, with the dashboard token), and it waits in quarantine until the owner approves it. The main agent always sends it this way.
4. Linter on the affected skill (MANDATORY, after the skill action):
   ```bash
   node {{INSTALL_DIR}}/scripts/skill-lint.mjs .claude/skills/<NEV>     # for a proposal, on the draft: .claude/skill-javaslat
   ```
   If it reports an error (the exit code is not 0): fix the reported point, and run it again until it is clean. The rules (Anthropic, Skill authoring best practices): the SKILL.md body is at most 500 lines; a `references/` file longer than 100 lines has a table of contents at the top; the SKILL.md points directly to every supporting file; the links in the SKILL.md point to existing files. The linter only reports; do not rewrite a skill installed from an external source.
5. Index regen (both levels):
   ```bash
   bash {{INSTALL_DIR}}/scripts/skill-index.sh          # refresh the global index
   bash {{INSTALL_DIR}}/scripts/skill-index.sh "$(pwd)" # refresh the agent-specific merged index
   ```

**If you skipped the skill action although one of A/B/C was YES:** you must leave a trace in `hot` tier memory, so that we can see later why. Do not skip it silently.

**The key of the entry is the FINDING, not the round.** First look for an existing `skip-skill:` line for THE SAME finding:
- if there is one: **update** that one (counter + last date), do NOT write a new one;
- write a new line only if this finding does not appear at all yet.

One open finding stays one line, however many rounds see it. (Measured 2026-09-13: the key was the round, not the finding, so every round wrote the same thing again: 35 skip-skill lines, 64% of the hot memory, for a single closed channel.)

## 3. Staying silent

**EXCEPTION: If the user sent a message on a channel (a block starting with `<channel source=` in the context), always reply to it: the silent heartbeat rule does NOT apply to it.**

If there is NO complex task / error / correction (A=B=C=NO), AND there is no waiting Telegram message, AND there is no new information since the previous round:
- Do not save memory needlessly
- Do not generate a skill
- Do not send a message to the channel
- Stay silent: simply END the round, without any action.

**CRITICAL (unattended stability):** NEVER type anything into the input box (the `❯` prompt line) and never leave parked, unsent text there, not even the words "silent heartbeat". If you want to mark the silent round, that can ONLY be in your normal reply text (transcript), with ONE short line, and then your round must end at once. Parked input text blocks the delivery of the next message (the router sees the session as `busy`) -> the channel goes SILENT, unattended.

## 4. CLOSING STAMP (MANDATORY, the LAST step of the round, also in a silent round)

**MEASURED GAP (2026-08-23): this round used to have NO closing trace.** From outside it was
impossible to tell whether the round RAN and was silent, or did not even get to its end:
claiming a "silent round" when it cannot be proven is exactly the false-zero error class.

So at the END of the round, on every branch (also in a silent round), a single line:

```bash
python3 -c "import json,time; json.dump({'last_run_at': int(time.time()), 'outcome': 'OUTCOME'}, open('{{INSTALL_DIR}}/store/memoria-heartbeat-state.json','w'))"
```

The value of `OUTCOME`: `silent` (silent round), `memory` (memory saved), `skill` (there was a skill action),
`both`. The stamp is worth something because it is written WITHOUT EXCEPTION: a skipped silent round
looks like a missing run in the next measurement.
