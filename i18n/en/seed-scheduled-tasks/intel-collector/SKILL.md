---
name: intel-collector
description: Proactive intelligence gatherer -- hourly collection on your own watched topics, results go to the intel registry (store/intel.db). The daily brief (intel-napi-brief) is built from it.
---

# Proactive intelligence gatherer -- hourly collection cycle

> ⚠️ TEMPLATE: ships DISABLED by default (task-config.json: `"enabled": false`).
> Before you enable it, replace the DOMAIN blocks below with YOUR OWN watched
> topics. The "END OF RUN" section (registry write) is a fixed part of the system;
> do not remove it -- it feeds the daily brief.

Goal: sweep the given domains and write EVERY relevant finding into the
registry. ONLY send a Telegram message to the owner ({{OWNER_NAME}})
if there is an alert-level event (a threshold you defined is crossed, an urgent
deadline). Otherwise run silently: registry + daily log.

## DOMAIN 1 -- [REPLACE: e.g. industry news / competitors]

1. WebSearch queries (2-4 of them, tailored to your topic):
   - "[KEYWORD 1] 2026" site:[TRUSTED SOURCE]
   - "[COMPETITOR NAME]" (latest news)

2. Short triage for every finding: does it contain numeric data, an announcement,
   or a deadline that affects the owner? If a local LLM is available (Ollama MCP), you
   can delegate the pre-filtering to it in YES/NO format -- it saves tokens.

3. Process only the relevant records. If one crosses your own threshold
   (e.g. >X% price move) -> Telegram notification.

## DOMAIN 2 -- [REPLACE: e.g. exchange rates / market data]

1. WebFetch [OFFICIAL SOURCE URL, e.g. central bank exchange rate page]
   Band trigger example: if the value is outside the [LOWER]..[UPPER] band -> IMMEDIATE Telegram.

2. Less frequent checks behind a time gate (e.g. only at 09:00, only on Mondays, only on the
   1st of the month): this keeps the hourly run cheap. As the first step, check the exact time
   with the `date` Bash command.

## DOMAIN 3 -- [REPLACE: e.g. legislation / grant calls / deadlines -- or delete it]

1. WebFetch [SOURCE URL]
   Triage: is there a new round / a new deadline? If YES -> Telegram.

## END OF RUN (fixed part -- this feeds the daily brief)

1. REGISTRY WRITE (mandatory): write EVERY relevant finding into the
   known_facts_registry with the CLI:
   ```
   python3 {{INSTALL_DIR}}/scripts/intel_db.py add-fact \
     --title "SHORT TITLE" --domain <your-domain-slug> \
     --source "URL or source name" --tier <1|2|3> \
     --content "The gist of the fact, with numbers" --priority <0.0-1.0>
   ```
   - Do NOT pass --id: the CLI generates a deterministic id (domain-YYYYMMDD-hash8),
     so a repeated hourly finding becomes an update, not a duplicate.
   - Output "DUPLICATE content already in registry" = an already known fact; that is fine, move on.
   - Priority rule of thumb: alert-level trigger = 0.9; numeric data or
     deadline = 0.7; other relevant = 0.5. Tier-1 source: +0.1, tier-3: -0.1
     (clamped to 0..1).
   - If an EARLIER fact has evolved (same topic with a new number), overwrite it with the
     same --id and --status evolving.
2. New direction to follow (not a fact yet, but worth watching): add-watch:
   ```
   python3 {{INSTALL_DIR}}/scripts/intel_db.py add-watch \
     --title "WHAT" --domain <domain> --direction "WHERE it may move" --notes "WHY"
   ```
3. POST /api/daily-log (agent_id: {{MAIN_AGENT_ID}}) -- what ran, how many facts
   went into the registry, status.
4. If there is no alert: stay silent (the registry write is NOT an alert, no Telegram goes out about it).
5. If there is an alert: Telegram to the owner, brief and actionable.
