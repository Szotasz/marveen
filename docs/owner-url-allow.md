# Owner-sent links open without an egress stall (opt-in)

With the quarantine-reader in allowlist mode, a link the owner sends to their
own bot stops at the egress gate until someone adds the domain by hand, even
though the owner explicitly asked the bot to open it.
`scripts/hooks/owner-url-allow.py` (UserPromptSubmit) closes that gap.

**Disabled by default.** Enable with `MARVEEN_OWNER_URL_ALLOW=1` (environment
or the install's `.env`).

When enabled, for every `<channel>` DM in the prompt whose sender is the bot's
**owner**, each public http(s) host in the message is appended to
`quarantine_domains` in `store/egress-allowlist.json`, with a dated audit
entry under `_owner_url_auto`, and the agent's quarantine-reader definition is
refreshed. Fetched content still goes through the quarantine-reader and comes
back as data, never as instructions.

Who counts as the owner:

| Setting | Effect |
|---|---|
| `MARVEEN_OWNER_URL_SENDERS=111,222` | exactly these user ids |
| (unset) | the single DM entry of the bot's `access.json` `allowFrom`; with several paired contacts nobody qualifies |
| `MARVEEN_OWNER_URL_ANY_PAIRED=1` | every paired DM contact |

Never added: links in group messages (negative chat_id), links from other
senders, IP literals, `localhost` and private suffixes (`.local`, `.lan`,
`.internal`, `.home.arpa`). The hook never blocks a prompt; every failure
exits 0.

Keep in mind: the allowlist is shared by every agent of the install, so a
host added through one bot is open to all of them.
