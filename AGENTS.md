# AGENTS.md

This repository is an AI agent orchestration framework built on Claude Code. It is designed for a self-learning agent fleet, scheduled tasks, background monitoring, channel integrations, and a dashboard-based mission control layer.

## Key repository facts

- Runtime is written in TypeScript and uses ESM.
- Requires Node.js 20+.
- Core runtime entrypoint: `src/index.ts`.
- Agent orchestration lives in `src/agent.ts`.
- The web dashboard lives under `src/web/` and `web/`.
- Shell helpers and install/runtime scripts are under `scripts/`.
- Runtime state and seed configuration are stored in `store/` and `scheduled-tasks/`.

## Build and development commands

- `npm install`
- `npm run build`
- `npm test`
- `npm run dev`
- `npm run setup` runs the TypeScript setup script.
- `./scripts/start.sh`, `./scripts/stop.sh`, `./scripts/monitor_agents.sh`

## Project conventions for code agents

- Keep guidance minimal and link to existing docs whenever possible.
- This project is not a standard API service; it is an agent host. Prefer editing core behavior in `src/` and support scripts in `scripts/`.
- `seed-skills/` and `seed-scheduled-tasks/` are bootstrap defaults. Do not modify them unless you are intentionally adding or changing default seed content.
- Runtime agent-specific behavior is controlled by agent instruction files such as `CLAUDE.md` and personality files like `SOUL.md`, plus per-agent memory and skill state in `store/`.
- Do not assume live runtime state is stored only in source files; `store/` contains runtime configuration and state.

## Useful documentation

- `README.md` — repo overview and install/run flow.
- `docs/README.md` — entrypoint for feature-level documentation.
- `docs/agent-fleet.md` — agent architecture and inter-agent behavior.
- `docs/skill-factory.md` — how self-learning skills are created and patched.
- `docs/heartbeat-autonomy.md` — heartbeat/monitoring design.
- `docs/memory-system.md` — memory tiers and storage design.
- `docs/vault.md` — secret handling and Vault integration.

## Practical guidance

- When changing runtime behavior, prefer `nnézd pm run build` + local validation.
- For TypeScript changes, run `npm run typecheck`.
- If you add a new agent skill or scheduled task, document it in `docs/` or the relevant `seed-*` folder.
- Treat `CLAUDE.md` as the root agent persona/instruction file for the default agent in this repo.
- Use the existing documentation structure rather than duplicating large design details in code comments.
