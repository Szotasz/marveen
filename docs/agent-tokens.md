# Per-agent scoped dashboard tokens

The dashboard token in `store/.dashboard-token` is an all-or-nothing credential.
Whoever holds it can drive an agent's terminal, read the SSH vault, mint
dashboard users and revoke every device key. That is acceptable for scripts
running on this machine. It is not something to copy onto a machine in someone
else's network.

An **agent token** is the narrow alternative: a Bearer credential bound to one
agent id and one endpoint scope, revocable on its own.

| | dashboard token | agent token |
|---|---|---|
| Endpoints | every `/api/*` | the scope's allowlist, nothing else |
| Sender identity | may claim any `from` | only its own agent id |
| Mailbox | the whole fleet | its own queue only |
| Can mint credentials | yes | never |
| Revoke | rotates every fleet script | one `DELETE`, nothing else affected |

## Where the credential lives

Only `sha256(token)` is stored, in `agent_tokens` and in the in-process cache.
The raw value exists exactly once, in the mint response. There is no endpoint
that reads it back; a lost token is re-minted, not recovered.

## Scopes

Scopes are defined in `src/web/agent-token-scope.ts` and enforced centrally in
the `src/web.ts` gate, before any route sees the request. They are **allowlists**:
an endpoint nobody listed is denied. This is the property that matters over time.
A route added to the dashboard next month is out of scope for every existing
agent token until someone deliberately widens a profile.

- **`messaging`** -- send a message, read and close your own queue. The narrowest
  useful profile: an outstation that only reports in.
- **`remote-agent`** -- `messaging` plus the shared working memory a real agent has
  to keep in sync: the kanban board, `/api/memories`, `/api/daily-log`, and the
  approval channel (`POST /api/approvals`, `GET /api/approvals/:id`) it must use
  before acting on its own.

Out of reach for **every** profile, by omission and by test: the agent terminal,
the SSH vault, `/api/security/*`, all of `/api/auth/*` (an agent token can never
mint another credential), settings, connectors, schedules, federation, and the
fleet-management surface. `/api/messages/threads` and `/api/messages/backlog` are
excluded too: both answer for the whole fleet and cannot be narrowed per caller.

## Identity binding

The scope decides *which* endpoints. Identity binding decides *whose name* the
writes may carry. `from` on `/api/messages`, and `agent_id` on `/api/memories`,
`/api/daily-log` and `/api/approvals`, are self-declared fields for every other
caller. Under an agent token they must equal the token's agent, or the request is
403. An omitted `agent_id` resolves to the token's agent, never to the main agent.

Without this a remote agent could file text under the main agent's name, which on
the memory path is not merely bad attribution: memories are read back as the main
agent's own recall, so it would be an injection channel straight into its prompt.

Reads are bound the same way. `GET /api/messages` answers fleet-wide when no
`agent` filter is given; under an agent token the filter is pinned to the token's
own agent, and asking for another agent's mailbox is refused. A single message is
readable and closable only by a party to it, and a foreign one is `404`, not
`403` -- whether row N exists is itself fleet information.

A bound token also *authorizes* its own `from`, so a remote agent does not need an
`agents/<id>` directory on this machine. That check exists because the shared
token lets any holder name any sender; a bound token can only name the one agent
it was minted for, which is the stronger claim.

## Minting

Requires the dashboard token or a logged-in dashboard session. Deliberately not a
device key and not another agent token.

```bash
curl -s -X POST http://localhost:3420/api/auth/agent-tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"agent_id":"sam","scope":"remote-agent","label":"sam outstation"}'
```

```jsonc
{
  "ok": true,
  "id": 1,
  "agent_id": "sam",
  "scope": "remote-agent",
  "token": "mvat_...",      // the one and only disclosure
  "registered": false,      // no agents/sam here -- expected for a remote agent
  "allows": ["POST /api/messages", "..."]
}
```

`expires_in_days` is optional; omitted means the token lives until revoked.

List (metadata only, never the token or its hash) and revoke:

```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/auth/agent-tokens

curl -s -X DELETE -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/auth/agent-tokens/1
```

Revocation takes effect on the next request, including one made from another
process (the cache re-checks the row at most 60s after a token is used).
`npm run dashboard-user -- security:reset` revokes every agent token along with
every device key and browser session.

## Using it from the remote machine

The remote agent needs no inbound firewall rule: it reaches the dashboard's
public URL outbound, holding its own token.

```bash
# smoke test -- says whether the token is live and under whose name
curl -s -H "Authorization: Bearer $AGENT_TOKEN" \
  https://<dashboard-public-url>/api/auth/status
# {"authenticated":true,"method":"agent","agent":"sam", ...}

# report in
curl -s -X POST https://<dashboard-public-url>/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -d '{"from":"sam","to":"marveen","content":"..."}'

# read its own queue
curl -s -H "Authorization: Bearer $AGENT_TOKEN" \
  "https://<dashboard-public-url>/api/messages?status=pending"
```

A message counts as sent only when the response carries an `id`. An out-of-scope
request answers `403 {"error":"Out of scope for this agent token (scope: ...)"}`
and is logged here with the agent, path and method -- so a widening that is
actually needed shows up as a log line, not as a silent failure.

## Tests

`src/__tests__/auth-agent-tokens.test.ts` is the contract: default-deny over a
list of endpoints a leaked token must never reach, identity and mailbox binding,
storage discipline, revocation and expiry, and the fresh-install guarantee (zero
rows = zero behavior change).
