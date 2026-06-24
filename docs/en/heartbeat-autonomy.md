# Heartbeat + Progressive Autonomy

> The assistant doesn't wait to be told. It checks in on a schedule, and you decide how much leash to give it.

---

## 🎯 What it does / why it matters

Most AI assistants are reactive: you ask, they answer. Marveen is **proactive** — it checks its environment on a schedule (kanban board, calendar, memory, system state) and only speaks up when there's actually something to report.

The key to this behaviour is **progressive autonomy**: a trust ladder where you set, per category, how much the assistant can do on its own:

- **Level 1 — Notify only:** notices the thing and asks before doing anything.
- **Level 2 — Suggest + approve:** prepares the concrete step, you approve with one click.
- **Level 3 — Autonomous + report:** for low-risk, pre-authorised tasks it just does it and reports afterwards.

A dashboard UI, per category, lets you slide the level up or down — loosen or tighten based on the project phase. For example "archiving old closed tasks" can run fully autonomously, while "publishing" or "money movement" always require approval.

**The safety limit is built in:** irreversible, outbound operations (sending emails, publishing, purchasing, deletion, permission changes) are **locked** — no matter what you set, these can never become fully autonomous. This is not an option; it's hardcoded.

**Highlight:** this pattern is essentially what Anthropic officially announced in 2025 as "Routines" — proactive, scheduled agents with per-category configurable autonomy. Marveen was running this pattern in production before that announcement, on its own scheduled-task + heartbeat infrastructure. Not as a concept, but as a real production system running daily.

---

## 🛠 How it works

### Components

1. **Scheduled tasks (heartbeats):** cron-style scheduled prompts (e.g. memory save, kanban audit, midday/morning digest). Each run is a short, focused check.
2. **Autonomy config:** `store/autonomy-config.json` stores, per category, the level (`level: 1|2|3`), a `locked` flag, and `maxLevel`.
3. **Dashboard UI + API:** `GET/POST /api/autonomy` reads/writes the config; the UI shows a level selector per category row, locked rows greyed out with a padlock. The backend server-side blocks level increases for locked categories.
4. **Heartbeat wiring:** every scheduled task reads its relevant category's level at the start of the run and behaves accordingly.

### Level logic (example: kanban audit)

```
level 3  → archives 7+ day old closed cards automatically;
           when a task stalls, contacts the assignee directly,
           and only escalates to the user after 2 failed rounds
level 2  → does nothing automatically; suggests in a message and waits for approval
level 1  → only lists/flags, takes no action
```

Missing config or key defaults to level 3 (preserving prior behaviour).

### Config schema

```json
{
  "version": 1,
  "categories": [
    { "key": "kanban_archive_done", "label": "...", "level": 3, "locked": false, "maxLevel": 3 },
    { "key": "email_send",          "label": "...", "level": 1, "locked": false, "maxLevel": 2 },
    { "key": "payment",             "label": "...", "level": 1, "locked": true,  "maxLevel": 1 }
  ]
}
```

- `locked: true` + `maxLevel: 1` → hard-safety category, cannot be raised (publishing, money, deletion, permissions, external messages).
- `email_send` is special: configurable, but `maxLevel: 2` (draft + approval, never fully autonomous sending).

### Installation / updates

The default config lives in `seed-config/`; install copies it to `store/` if not already present. On update the existing config is **not overwritten** — only missing (newly introduced) categories are appended, leaving user-set levels untouched.

### Extending

New autonomy category: add it to `seed-config/autonomy-config.json` (`key`, `label`, `level`, `locked`, `maxLevel`), and have the relevant heartbeat prompt read the level before acting. Always respect the hard-safety boundary: outbound / irreversible operations never get `maxLevel > 1` (email is the exception at `maxLevel: 2`).
