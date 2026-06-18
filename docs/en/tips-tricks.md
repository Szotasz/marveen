# Tips & Tricks

> Proven techniques for working faster and more effectively with the Marveen fleet.

---

## 1. Self-review and skill extraction for agent descriptors

Agent CLAUDE.md descriptors can periodically review themselves: anything procedural and repetitive -- API recipes, step sequences -- should be moved into a skill (recall-on-demand). The behavioural and safety core stays in the descriptor. The process itself is delegable: ask the agent to review its own descriptor and extract what it can into skills.

Example prompt: "Review the agents' CLAUDE.md descriptors: what can be extracted into a shared skill (keeping the behavioural and safety core in place) to reduce descriptor size and token usage?"

**Effect achieved:** Six sub-agent CLAUDE.md files shrank from 103 to 54 lines; the main CLAUDE.md from 292 to 194 lines; duplicated API recipes were consolidated into a single shared skill. Every session now loads fewer tokens -- smaller context, faster responses.

---

## 2. Label-driven done-state email notification workflow

If an agent has email-sending capability (e.g. Google Workspace MCP), a label can drive a workflow that automatically sends an email to the relevant party when a card reaches DONE. The label marks which cards belong to the workflow; a scheduled heartbeat task watches for done+labelled, not-yet-notified cards, sends the email (with correctly encoded subject), then marks the card so it doesn't repeat. For PII-sensitive cases a human approval step can be added.

Live example: the Eszter label + eszter-done-ertesito scheduled task -- done cards with the Eszter label trigger an email to a given address.

**Effect achieved:** automatic, reliable notification on task completion with no manual step; the label makes the workflow reusable for any project.

---

## 3. Break down larger tasks onto the kanban board with AI

When you hand the agent a larger task, put it on the kanban board and use the "Kanban (AI) breakdown": the agent splits it into meaningful subtasks with priorities and assigned agents. You don't need to plan the whole structure upfront.

**Effect achieved:** faster delegation, clearer progress tracking, less manual planning.

---

## 4. The idea box as a buffer and prioritisation layer

Log not-yet-ripe ideas in the Idea Box with impact/effort scores, and only promote approved ones to the kanban board. The Idea Box is not a to-do list -- it is a filter where ideas mature and get prioritised.

**Effect achieved:** no idea gets lost, but the kanban board stays uncluttered; the scoring helps decide what the best next step is.

---

## 5. Label by topic or project

Tag kanban cards with labels by theme or project. This lets you filter the board instantly, and you can build notification or automation workflows on top of the labels (see Tip 2). The swimlane view can also group by label.

**Effect achieved:** fast overview and filtering; the label doubles as a workflow trigger.

---

## 6. Use your own aliases

Define short personal keywords for repetitive requests that launch an entire complex workflow with a single word. You don't need to spell out every step -- the alias does it for you.

Example: the "napindító" keyword runs the full morning chain (Dream Engine -> Peter workout summary -> email -> calendar) with one word.

**Effect achieved:** faster, consistent daily control; recurring routines start on one keyword and never deviate from the usual order.

---

## 7. Periodic model review for every specialised agent

Regularly review which Claude model each specialised agent uses (the "model" field in `agent-config.json`) and align it with the agent's role and the current model offering.

A demanding, intellectually intensive role -- architecture design, complex code generation, multi-source analysis -- may justify a stronger model where quality is the primary concern. A simpler, routine role -- calendar summaries, email notifications, data formatting -- works just as well with a lighter, faster, and cheaper model. When new models are released, it is worth reassessing the entire fleet.

Why periodic review pays off:

- Better quality where it matters: the hardest tasks get the strongest available model
- Lower cost and latency where it is sufficient: routine roles run on lighter models
- The fleet stays current with model progress -- a model that is less capable today may be adequate for a role in six months
- Deliberate resource management: not every agent needs the heaviest model
- Documented decisions: record the reason and date for every model change (commit message, daily log) -- context is easily lost over months if the only trace is a changed value in agent-config.json
- Risk management: for agents in critical roles (architecture design, complex analysis) allow a testing period before making the new model permanent; a faster or cheaper model may seem sufficient until quality degradation shows under real load

**Effect achieved:** optimal quality/cost/speed balance across the fleet; lower bills for routine roles, higher performance where it counts.

---

## 8. Periodic review and rate-reduction of low-yield heartbeat tasks

Scheduled heartbeat tasks accumulate easily, and a run frequency that was justified at setup can become unnecessary over time. Periodically review which tasks typically find nothing (no-op runs) and reduce their schedule. For most notification-type tasks, hourly runs deliver results just as promptly as every-10-minutes -- but with 6x fewer LLM calls.

Concrete example: the eszter-done-ertesito task changed from every 10 minutes (`*/10 * * * *`) to hourly (`0 * * * *`) -- 144 runs per day down to 24, and notifications still arrive within minutes.

Schedules can be adjusted on the dashboard Schedules page or via the API; run history is the best guide for identifying which tasks are candidates for rate reduction.

Before reducing frequency, assess time-criticality: if a task's result has an immediate impact within minutes -- instant alerting, SLA threshold, business process blocker -- do not reduce its frequency. Rate reduction only makes sense where a delayed result does not reduce the value delivered.

Make the review a recurring habit (e.g. monthly): a task's importance can change, and what was essential two months ago may now be a consistent no-op.

**Effect achieved:** token and resource savings by eliminating unnecessary no-op LLM runs; reduced noise in the logs -- without compromising time-critical monitoring.
