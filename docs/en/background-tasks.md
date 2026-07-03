# Background Tasks

> "Work on this while I do something else." The assistant runs a task in the background and notifies you when it's done.

---

## 🎯 What it does / why it matters

Sometimes a task takes a long time — research, builds, batch processing — and you don't want to sit next to it. With background tasks, the assistant **detaches** the work, you continue with other things, and when it's done a Telegram notification arrives. The conversation doesn't block, the session stays free.

**Highlight:** the prompt never goes directly into a command — it runs wrapped in an XML tag, treated as "untrusted data". If task description text accidentally contained executable instructions, they won't run. This isn't an afterthought: for background tasks that run without live supervision, this is one of the most important security boundaries.

---

## 🛠 How it works

### Starting a task

A task prefixed with `/background` or started from the dashboard runs in a separate process. The system tracks its state (running / done / failed) and notifies on completion.

### Security

The background-task prompt is **not interpolated directly into a command** — it's wrapped in an XML tag and treated as untrusted data so that any injection attempt in the task description cannot execute. Command arguments are passed via environment variable (not shell interpolation), eliminating shell injection.

### Lifecycle API

```
POST /api/background-tasks      # new background task (prompt from env variable)
GET  /api/background-tasks      # status
```

Tasks are visible on the dashboard; completion notifies via the configured channel (Telegram/Slack).

### When to use it

Long, well-defined, supervisable work (research, batch processing, builds). For interactive tasks requiring frequent decisions, use the normal conversational mode instead.
