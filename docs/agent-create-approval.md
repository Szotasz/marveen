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
- Version 1 sets up a Telegram channel only. Version 2 (below) adds Slack and Discord, the team rights, the pairing, the
  MCP servers and the invite. A version-1 request is still accepted exactly as before; a version-2 field in it is an
  unknown field (400).

### Version 2

```json
{
  "spec_version": 2,
  "name": "Kutató",
  "description": "Market research",
  "channel": {
    "provider": "slack",
    "botToken": { "vault_ref": "SLACK-BOT-KUTATO" },
    "appToken": { "vault_ref": "SLACK-APP-KUTATO" },
    "allowFrom": ["U012ABC"]
  },
  "team": { "role": "member", "reportsTo": "samu", "delegatesTo": [], "autoDelegation": false, "trustFrom": ["samu"], "tagline": "Market research" },
  "mcp": ["github"],
  "invite": false
}
```

- `channel.provider` is `telegram`, `slack` or `discord`.
  - Slack needs `appToken`, also as a vault reference. The request is refused with 409 when the machine's managed
    settings for the Slack channel are not set up yet, so the owner is never asked about a create whose channel cannot
    start.
  - Discord needs `channelId`, checked as the dashboard checks it.
  - `appToken` on another provider, and `channelId` on another provider, are refused.
- `channel.allowFrom` is the pairing of a spec: the user ids let in (the channel's policy becomes an allowlist). A code
  pairing needs a live bot that someone has already messaged, so it stays on the owner's dashboard. The owner's text
  says when no code pairing was done.
- `team` is the agent's team block, with explicit values (the agent is new, so nothing is kept from a current block):
  role `member` or `leader`, reports-to, delegates, auto-delegation, the trusted peers (whose messages it accepts), and
  a tagline. A name the dashboard would drop (an unknown agent, or the agent itself) and a reporting cycle are refused
  with 400, never dropped in silence. The leader role gives a wider security profile, and the owner's text says so on a
  line of its own.
- `mcp` lists MCP servers already on this install, by name, looked up as the dashboard's assign does. A new server
  (`claude mcp add`, with its secrets) and a raw `.mcp.json` stay on the owner's dashboard. A `plugin:` connector is
  global and is refused. The spec binds each server's config by its sha256. Neither the stored spec (agents can read
  it) nor the owner's text holds the server's arguments, a URL's query, fragment or user info, or any environment or
  header value. The owner sees its type, its command and the number of arguments, or the URL's origin and path (a
  key-like path segment, 16 or more characters of letters, digits, `_` and `-`, shown as `***`), the keys of its
  environment and headers, and the file the config came from. That file is marked when an agent can write it
  (an agent's `projects/<p>` list, an external project), because its config could have been planted.
- `invite: true` makes the consumer issue a channel invite after the channel is set up, on Telegram or Slack, and not
  together with `allowFrom` (an invite opens pairing). The invite's link is shown only on the owner's dashboard: an
  alert may say an invite exists, never its link.

The answer is `201 { approvalId, contentHash }`. The owner's text is not returned to the requester. The server stores the canonical spec (sorted keys, no whitespace)
in `agent_create_specs`, a security table agents cannot write. It also opens an `agent_create` approval whose
`content_hash` is the sha256 of that canonical JSON.

## What the owner sees

The server renders the owner's text from the stored spec: id, display name, description, model, security profile,
custom provider, channel, spec version, and the first 8 characters of the hash. Every hashed field is on that list. For
the secret, the text says only `bot-token: set (vault: <id>)`, with no value, prefix or length. The requesting agent's
own words never reach that text. Version 2 adds a line for each of its fields:
- the Slack app token (`set (vault: <id>)`), the Discord channel and the ids let in;
- each team field, with a separate line when the role is leader;
- each MCP server with its type, its command and argument count or its URL's origin and path, the keys of its
  environment and headers (values hidden), its source file, and the first 8 characters of its config hash;
- whether an invite will be issued.

## The decision

An `agent_create` request is approved only through the decision core (`decideApproval`). The request must carry a stored
hash, and whoever decides must pass back exactly the hash the owner was shown. A rejection needs neither.

- **On the dashboard**, the owner's session approves it. The approve button shows the whole server-rendered text and its
  check code. The click sends back that hash (`PATCH /api/approvals/:id` with `content_hash`), and the core decides with
  it. The audit records `resolved_by = dashboard_owner`. Without the hash the answer is 400, with another hash 409. The
  shared token, a sub-agent's own token and a device key without the owner session get 403, and so does the first-run
  or install path, which has no owner session. This gives no new right: the owner session can create an agent on the
  dashboard directly anyway.
- **In a channel**, an adapter checks the owner's decision itself and passes the hash it showed.
  - A filed request asks the owner right away, as any server-filed request does: a Teams card, else the Slack reply path,
    else the Slack DM, else Telegram. It goes to the Gromzo app too, when mxd can take decisions. A delivery that fails
    never undoes the filing: the request stays pending on the dashboard, and the failure is logged.
  - **Teams card**: rendered from the stored spec, only while its canonical JSON still hashes to the approval's hash.
    The card shows the server's whole text, and the click is decided against the hash the card showed.
  - **Slack reply** (✅ or "mehet"; there is no Slack button): the post records the hash it showed, and the reply is
    decided against it. A request too long for one Slack message is never split: the DM is a short "decide on the
    dashboard" pointer with no post row, so no reply can approve it.
  - **Gromzo**: the stored spec's text goes to the owner's app as an mxd decisions row. Before every post a capability
    probe (`decision_get` of a random id) tells an mxd older than the decisions verbs (the adapter stays off, loudly)
    from one that cannot be reached now. A watcher reads the owner's answer and spends it in this order: our row
    pending to consuming, then mxd's `decision_consume`, then the core decides against the hash the posted row showed.
    If mxd refuses, the row goes back to pending and nothing is decided. If mxd spent it but the core did not decide,
    the main agent is alerted and nothing is created.
  - Telegram's button comes in a separate change.

On a channel a rejection is bound to the shown hash too (as the Teams card always was); on the dashboard it stays a plain
status write.

## The creation

After an approval commits, the `agent_create` consumer runs. In one transaction it:

- consumes the approval (approved to consumed, the same hash, once);
- marks the spec row as consumed;
- re-checks the stored spec: it is still canonical, it still hashes to the approved hash, and the vault value still has
  the approved sha256.

For version 2 the re-check also covers the Slack app token's value, each MCP server's config (the same sha256), and the
team block's names (still known, still no cycle).

Then it creates the agent through `createAgentFromSpec`, the same code as the dashboard's create. For version 2 the next
steps run in this order. The team and the servers come first, because the channel setup restarts the agent.

1. The team block, through `applyAgentTeam` (the code of `PUT /api/agents/:name/team`).
2. The MCP servers, through `writeConnectorIntoAgent` (the code of the assign route). Each config is read and its
   sha256 checked again right before the write.
3. The channel, through `setupAgentChannel`, the same code as the dashboard's channel setup. The tokens are read from
   the vault at that moment and their sha256 checked once more. Slack gets its app token, Discord its channel id, and
   the allowFrom list goes in when there is one.
4. The invite, through `issueAgentChannelInvite` (the code of the invite route).

A step that cannot run as approved stops there. The agent exists, and nothing after that step runs.

The spec row records the outcome:
- `created`;
- `refused:<reason>`: the re-check refused it, and nothing was created;
- `failed:<status>:<error>`;
- `created_team_changed`;
- `created_mcp_refused:<name>`;
- `created_channel_failed:...`;
- `created_channel_refused:vault_value_changed`;
- `created_invite_failed:<status>`.

Anything but `created` also goes to the main agent as an alert. A changed spec, a swapped vault value, a changed MCP
config or a team name gone before the consume creates nothing.

## After a restart

When the server starts, it checks for two cases:

- A request approved while the consumer could not run is consumed and created now.
- A request consumed without an outcome (a crash between the consume and the create) is marked `interrupted` and
  alerted. It is never run again.
