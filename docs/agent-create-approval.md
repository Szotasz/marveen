# Creating an agent through an approval

An agent can ask for a new agent; only the owner's approval makes one. Off by default: `AGENT_CREATE_VIA_APPROVAL=on`
(switching it on needs the owner's dashboard session).

## The request

`POST /api/agent-specs` with a spec. The shared token can file one, because filing creates nothing:

```json
{
  "spec_version": 1,
  "name": "Kutató",
  "description": "Market research",
  "model": "claude-sonnet-5",
  "profile": "default",
  "customProvider": null,
  "channel": { "provider": "telegram", "botToken": { "vault_ref": "TG-BOT-KUTATO" } }
}
```

- `spec_version` is required. An unknown field is refused with 400, so a field the server does not support yet never
  slips through.
- The server validates the spec before it asks for anything. It runs the same refusals as the dashboard's create (name,
  model, custom provider, the CLI gate, description, reserved names, an existing agent), checks that the security
  profile exists, and checks that the vault reference resolves. A refused spec gets no approval.
- A request without a model gets the install default, chosen at that moment, so the owner approves the model that will
  be created.
- A secret is never a value in the spec. The bot token is given by its vault id. The stored spec keeps the id and the
  sha256 of the value at request time.
- The requester may name only a vault entry it may read itself, under the vault's own read rule, applied strictly. SSH
  material and the vault's sub-resources are never allowed. The agent, named by its own token or by the name a
  shared-token caller claims, must be listed for that id in the allowlist (`store/vault-acl.json`). A caller with no name
  gets no entry. The owner's session may name any entry the floor allows. An entry the requester may not read gets exactly the answer
  a missing one gets (400, "cannot be used"), so a spec cannot be used to learn which ids exist. Without this rule, an
  agent could take out a secret it cannot read, because the owner sees only "set (vault: <id>)".
- Each request opens an owner approval, so the open ones are capped: at most three per requester and twenty in all. A
  request over the cap gets 429.
- Version 1 sets up a Telegram channel only. Slack also needs its app token and Discord a channel id, so both come with a
  later version, together with the team rights, the invite, the pairing and the MCP servers.

The answer is `201 { approvalId, contentHash, text }`. The server stores the canonical spec (sorted keys, no whitespace)
in `agent_create_specs`, a security table agents cannot write. It also opens an `agent_create` approval whose
`content_hash` is the sha256 of that canonical JSON.

## What the owner sees

The server renders the owner's text from the stored spec: id, display name, description, model, security profile,
custom provider, channel, spec version, and the first 8 characters of the hash. Every hashed field is on that list. For
the secret, the text says only `bot-token: set (vault: <id>)`, with no value, prefix or length. The requesting agent's
own words never reach that text.

## The decision

An `agent_create` request is approved only through the decision core (`decideApproval`). The request must carry a stored
hash, and whoever decides must pass back exactly the hash the owner was shown. A rejection needs neither.

- **On the dashboard**, the owner's session approves it. The approve button shows the whole server-rendered text and its
  check code. The click sends back that hash (`PATCH /api/approvals/:id` with `content_hash`), and the core decides with
  it. The audit records `resolved_by = dashboard_owner`. Without the hash the answer is 400, with another hash 409. The
  shared token, a sub-agent's own token and a device key without the owner session get 403, and so does the first-run
  or install path, which has no owner session. This gives no new right: the owner session can create an agent on the
  dashboard directly anyway.
- **In a channel**, an adapter checks the owner's decision itself and passes the hash it showed. The adapters (Teams
  card, Telegram, Slack, Gromzo) come in the next step.

A rejection stays a plain status write.

## The creation

After an approval commits, the `agent_create` consumer runs. In one transaction it:

- consumes the approval (approved to consumed, the same hash, once);
- marks the spec row as consumed;
- re-checks the stored spec: it is still canonical, it still hashes to the approved hash, and the vault value still has
  the approved sha256.

Then it creates the agent through `createAgentFromSpec`, the same code as the dashboard's create. If the spec has a
channel, it sets the channel up through `setupAgentChannel`, the same code as the dashboard's channel setup. The bot
token is read from the vault at that moment, and its sha256 is checked once more.

The spec row records the outcome: `created`, `refused:<reason>`, `failed:<status>:<error>`,
`created_channel_failed:...` or `created_channel_refused:vault_value_changed`. Anything but `created` also goes to the
main agent as an alert. A changed spec or a swapped vault value creates nothing.

## After a restart

When the server starts, it checks for two cases:

- A request approved while the consumer could not run is consumed and created now.
- A request consumed without an outcome (a crash between the consume and the create) is marked `interrupted` and
  alerted. It is never run again.
