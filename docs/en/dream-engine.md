# Dream-engine

> While you sleep, the assistant "dreams": it reorganises the day's knowledge and prepares for morning.

---

## 🎯 What it does / why it matters

Every night a silent analysis loop runs — the **dream-engine**. It doesn't disturb anyone (no messages sent), but consolidates the day's knowledge and prepares the morning: tidies the memory, calibrates tomorrow's priorities, and assembles a prioritised suggestion bundle that the morning digest delivers to you.

Think of it as the assistant "thinking over the day": what did we learn, what needs tidying in memory, what are the three most important tasks for tomorrow, and does the fleet have a recurring pattern that could become a new skill — all of this processed and ready by morning.

**Highlight:** your morning digest doesn't start from scratch — the overnight dream-engine has already done the heavy lifting based on kanban cards and the day's lessons. You don't "catch up" in the morning: you continue where you left off yesterday. The 7:30 summary is therefore much denser than what a fresh-start assistant could assemble.

---

## 🛠 How it works

Runs overnight (around 02:00) and generates a `DREAM.md` file across 5 "buckets":

1. **💡 Skill suggestions** — scans the day's (24h) memories and log: are there 3+ recurring manual operations, or a new uncovered pattern that could become a skill?
2. **🧹 Memory health** — vectorisation check, moving stale `hot` entries to `cold`, handling duplicates (never deleting).
3. **🎯 Top-3 tomorrow suggestions** — prioritised based on open kanban cards + weekly activity.
4. **🌐 External opportunity** — fresh external tool/skill search 1-2 times per week (otherwise skipped to avoid noise).
5. **🛠 Skill fleet health** — flagging stale (non-pinned, long-unused) skills.

In the morning the digest puts the `DREAM.md` 5 buckets at the top of the report, before the email/calendar/AI-news sections. All operations are local (SQL + optional local embedding), no external API calls. On error, an error section is appended to `DREAM.md` — visible in the morning digest.
