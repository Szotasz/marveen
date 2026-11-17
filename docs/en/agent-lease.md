# Temporary agent lease

## 🎯 What it does

The owner issues a time-boxed permission (a lease). While it runs, the main agent may create, run and delete throwaway test agents **on a local model** without the owner login. On expiry or revoke, every agent created under the lease is stopped and deleted.

**Who can issue, read or revoke it:** only the owner, signed in with the dashboard password (`mayActAsOwner`). The first-run exception does not apply: the lease is a grant to the shared token, so the shared token can never grant itself one.

**What a lease lets the shared token do (and nothing else):**
- **Create** (`POST /api/agents`) when ALL hold:
  - the name starts with `tmp-`;
  - a `customProvider` is set, and the host of its base URL is **loopback**: `localhost`, a `127.x.x.x` address or `::1`. Not local: `0.0.0.0`, a LAN address, `*.localhost`, or a name that merely resolves to loopback;
  - the security profile is `lease-sandbox` (another one is a 403; none means this one);
  - at most `maxAgents` creations per lease. A deleted agent does NOT free its slot, so a create/delete loop cannot flood the owner with notifications.
- **Delete** (`DELETE /api/agents/:name`): only a `tmp-` agent created under the CURRENT active lease.
- **Start, stop:** these already worked with the shared token; the lease changes nothing there.

Every other owner action stays owner-only: channel setup, pairing, trust, plan, MCP, profile, persona (CLAUDE.md/SOUL.md), provider.

**Which token:** only the shared token (`store/.dashboard-token`, `kind: 'token'` without `tokenAgent`). A sub-agent's own token cannot use it (the gate's allowlist does not let it reach `POST /api/agents` anyway), nor can a device key, a peer or an operator.

## Where

- **Dashboard:** Team page, under the header: minutes (1-60, default 60), max agents (1-3, default 3), Start lease; while active, the status and a Revoke button. Only the owner session sees it.
- **API:**
  - `GET /api/agent-leases` -> `{ active, lease }`;
  - `POST /api/agent-leases {"minutes": 1-60, "maxAgents": 1-3, "note": "..."}`; 409 while one is active;
  - `DELETE /api/agent-leases/current` -> revoke, the same cleanup as the expiry.
- **State:** `store/agent-lease.json` (the current or the last lease, atomic writes).

## 🛠 How it works

- **The `lease-sandbox` profile** (`templates/profiles/lease-sandbox.json`) is the narrowest one: strict mode, read and edit only inside the agent's own directory; every other tool call would ask for a permission nobody answers in a non-interactive agent. Denied: `WebFetch`, `WebSearch`, `curl`, `wget`, `ssh`, `scp`, `nc`, `sudo`, `rm`, `sendmail`, `mail`, `git push`, reading `store/` (the dashboard token), the sub-agent tokens, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude` and `.env` files. The fleet baseline deny floor is added on top.
- **On creation** the lease agent gets an empty `.mcp.json`, the template persona (no Claude call) and no team greeting.
- **The slot is taken** synchronously right before the agent directory is created: two concurrent requests cannot both take the last slot, and a lease that expired meanwhile grants nothing.
- **Expiry:** checked by the dashboard's one-minute tick (`web.ts`, beside the desktop-lock sweeper) and before every lease-gated request. The cleanup first marks the lease ended (from then on it grants nothing), then deletes the agents through the same path as a manual delete (`removeAgentCompletely`). An agent that cannot be deleted stays "not deleted" on the lease, the dashboard lists it and the owner is notified.
- **Audit and notification:** a config-log row per event (`agent_lease.create`, `agent_lease.create_agent`, `agent_lease.delete`, `agent_lease.expired`, `agent_lease.revoked`); one owner notification per agent created and per agent deleted (`notifyOwner`).

## ⚠️ Honest limitation

**A lease does not authenticate.** The shared token is readable by every process of the same OS user, so while a lease runs, ANY agent (or process) holding the shared token can use it, not only the main agent. The design limits the damage instead of identifying the caller: a short life (60 minutes max), few agents (3 creations max), local provider and the locked profile only, only its own `tmp-` agents deletable, a notification on every use, full cleanup on expiry, revocable at any time.

**What it does not protect against:**
- "Loopback" does not prove the model is local: a proxy on localhost (e.g. LiteLLM) can forward to a paid cloud model. The provider registry decides that, and only the owner can write it.
- If the local provider has a vault key, the lease agent receives it at launch.
- Anyone with a shell on the machine: the same OS user reaches everything without a lease. The lease narrows and logs what the dashboard API grants; it is not a sandbox.
- The strict profile relies on Claude Code's permission engine; a permission prompt can be approved by hand in the tmux pane.
