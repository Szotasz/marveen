# Skill-factory (self-learning)

> The assistant learns from every complex task and knows it next time.

---

## 🎯 What it does / why it matters

Most AIs repeat the same mistakes over and over. Marveen instead **self-learns**: when it completes a non-trivial workflow (or hits an error, recovers, and succeeds), it writes itself a **reusable skill** (recipe). Next time the same situation arises, it's routine, not trial and error.

If it finds a better solution to an existing recipe mid-task, it doesn't rewrite the whole thing — it patches just the changed part and notes the reason under "Pitfalls".

**Highlight:** skills don't only come from successes. When the agent hits an error, gets out of it, and the next time already knows the trap — the "Pitfalls" section is built exactly from those first failures. Self-learning goes in both directions: successful workflow → recipe, error → pitfall entry. Recipes use progressive loading: by default only their name + short description loads, full content only when actually needed. Up to 50+ skills fit comfortably this way.

---

## 🛠 How it works

### Skill structure

Every skill: a `SKILL.md` (frontmatter: `name`, `description` for triggering) + optional `references/`, `scripts/`. The `description` determines when it activates, so a concrete trigger description is required.

```
~/.claude/skills/<skill-name>/SKILL.md
```

### When a skill is created

| Situation | Action |
|-----------|--------|
| 5+ tool-call successful complex task | generate skill |
| Error → recovery → success | skill + "Pitfalls" section |
| User correction | patch existing skill |
| Simple one-step task | nothing |

### Patch vs. rewrite

For an existing skill: targeted replacement (old text → new), not a full rewrite. The reason for the change goes in the "Pitfalls" section so the lesson is preserved.

### Progressive loading (3 levels)

- **Level 0:** name + description (~100 words) — always available
- **Level 1:** full `SKILL.md` — only when relevant
- **Level 2:** support files (`scripts/`, `references/`) — only when specifically needed

`SKILL.md` stays under 500 lines; larger material goes in `references/`.

### Reflection + sync

The system regularly (heartbeat / before context compaction) checks: is there a reusable pattern in the session? Fleet-wide skills are distributed from `seed-skills/` on install/update to every installation — **sanitised** (no personal data, no concrete agent names, since agents may run under different names elsewhere).
