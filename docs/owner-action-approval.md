# Owner actions through an approval

An agent can ask for two owner-only actions; only the owner's approval runs one. Off by default:
`OWNER_ACTION_VIA_APPROVAL=on` (switching it on needs the owner's dashboard session). The shape is the one of
[creating an agent through an approval](agent-create-approval.md); this covers the two actions that held work up next to
it:

| kind | what the server runs after the approval | the owner-session route it replaces |
|---|---|---|
| `channel_setup` | `setupAgentChannel` (bot token, Slack app token, Discord channel id, `extra`, `allowFrom`) | `POST /api/agents/:name/channels/:provider` |
| `channel_approve` | `approveChannelPairing`, bound to the sender the code named at the filing | `POST /api/agents/:name/channels/:provider/approve` |

## The request

`POST /api/owner-actions`. The shared token can file one, because filing runs nothing:

```json
{ "kind": "channel_setup", "agent": "prorab", "provider": "slack",
  "botToken": { "vault_ref": "PRORAB_SLACK_BOT_TOKEN" }, "appToken": { "vault_ref": "PRORAB_SLACK_APP_TOKEN" },
  "extra": true, "allowFrom": ["U0123ABCD", "U0456EFGH"] }
```

```json
{ "kind": "channel_approve", "agent": "prorab", "provider": "telegram", "code": "abc123" }
```

- An unknown field is refused with 400. A secret is never a value: a token is given by its vault id, and the stored
  request keeps the id and the sha256 of the value at filing time. The requester may name only a vault entry it may read
  itself (the same rule as `/api/agent-specs`); a refused id gets exactly the answer a missing one gets.
- `channel_setup`: the agent must exist; the main agent's channel stays a dashboard action (403). Slack needs `appToken`,
  Discord needs `channelId`.
- `channel_approve`: the code must be pending now (404 otherwise); the request binds the sender id it names.
- The open requests are capped: three per requester, twenty in all (429).
- Who asked is the agent's own token's name, or, with the shared token, the name the caller claims (`X-Agent-Id`), as on
  `/api/agent-specs`. So with the shared token the "Requested by" line is not verified, the vault rule runs for the
  claimed name, and the per-requester cap can be dodged by claiming another name (the cap of twenty cannot). Nothing
  runs on that account: the action still runs only after the owner's hash-bound approval.
- The answer is `{ ok, approvalId, contentHash }`. The owner is asked on the channels like for any server-filed request.

## The decision

- The owner's text is rendered by the server from the stored request (agent, provider, whether the channel goes NEXT TO
  the primary or REPLACES it, the vault ids, who may message the agent, the pairing's sender), plus the requester and
  an 8-character check code from the hash.
- `owner_action` is a hash-bound category: it is approved only through the decision core with the hash the owner was
  shown. On the dashboard the owner's session approves in the same confirm dialog as `agent_create` (the whole text and
  the check code). The bare shared token, an agent's own token and a device key without the owner session cannot
  approve. The generic `POST /api/approvals` refuses the category (403): the server files these rows only.

## The run

- The consumer consumes the approval once (the same hash), stamps the request and re-hashes the stored bytes in one
  transaction; only then it runs the action through the owner-session route's own code.
- A vault value swapped since the filing, a pairing code that names another sender by then, an agent that no longer
  exists, or stored bytes that no longer match the hash: refused, nothing written.
- Every outcome is written on `owner_action_requests` (a security table, like `agent_create_specs`) and told to the
  owner in one line and to the main agent.
- At server start: an approved, unconsumed request runs now; one consumed without an outcome is alerted, never re-run.

## The limit (T2)

This closes the API path: with the shared token an agent can only ask. It is NOT a boundary against an agent that runs
commands as the same OS user as the dashboard. Such a process can write `store/claudeclaw.db` directly (an approved row,
or an owner session row: the session table keeps an unkeyed sha256 of the cookie), or click in the owner's dashboard if
it is open in a browser on this machine. The db-write-gate hook denies the plain SQL write on the security tables, but a
hook is a text brake, not an OS boundary. Only running the dashboard (with its database, vault and master key) as a
separate OS user from the agents closes this.
