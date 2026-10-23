# Agent budgets

Per-agent monthly budgets live in the costops config (`store/costops-config.json`): `budgets` entries with `"scope": "agent"` and `scope_ref` set to the agent name, plus `token_prices` per model. `checkAgentBudgets` measures them after each hourly token collection and alerts at the warning and hard levels.

## Opt-in enforcement

Set `"enforce_agent_budgets": true` in the config (default: off). While an agent is at its hard level this month, its heartbeat (background) scheduled tasks are deferred: the deferral is logged, a `skipped` task run is recorded, and the next occurrence is evaluated again.

This is deferral, not a stop:

- nothing is killed and messages still reach the agent;
- owner-facing scheduled tasks and command tasks are never held;
- the owner's own messages never pass through the scheduler.

The hold lifts by itself at the next budget check after the month rolls over or the budget is raised (or when the option is turned off).

Not held: a heartbeat that sends its digest directly (`sendDigestDirect`) builds the digest from the live board without a model call for that agent and sends it to the main agent, so it costs the held agent nothing; like the global quota gate, the hold does not apply to it. Budget `scope_ref` must match the agent name the scheduler targets exactly.
