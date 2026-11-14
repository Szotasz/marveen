# Scoped board access

A sub-agent that works for one or more people (for example a colleague's own
chat assistant) normally reads the whole kanban board. The scoped board lets
the owner decide, server-side, which cards such an agent may see:

- a person sees the cards assigned to them (`self`),
- a team lead also sees the cards of the people who report to them,
  recursively (`lead`),
- an executive sees every card (`all`),
- every person can ask for a daily report of today's and planned cards.

Code: `src/web/board-access.ts` (config, visibility, gate),
`src/web/routes/board.ts` (routes), wired in `src/web.ts`. Tests:
`src/__tests__/board-access.test.ts`.

## Prerequisite: per-agent tokens

The scope binds to the AUTHENTICATED caller, which is a sub-agent's own
dashboard token (`AGENT_TOKENS=1`, see `src/web/agent-tokens.ts`). A request
made with the shared main token is the main/admin principal and is never
scoped, whatever `X-Agent-Id` it carries.

## Configuration

`store/board-access.json`, edited by the owner (not a secret):

```json
{
  "enabled": true,
  "people": {
    "alice": { "name": "Alice", "assignees": ["alice", "Alice A."], "role": "self", "senderIds": ["1001"] },
    "bob":   { "name": "Bob",   "assignees": ["bob"], "role": "lead", "reports": ["alice"], "senderIds": ["1002"] },
    "erin":  { "name": "Erin",  "assignees": ["erin"], "role": "all" }
  },
  "agents": {
    "alice-assistant": { "people": ["alice"] },
    "team-assistant":  { "people": ["alice", "bob"] },
    "exec-assistant":  { "people": ["erin"] }
  }
}
```

- `assignees`: the card `assignee` strings that mean this person. Matching is
  trimmed and case-insensitive. The first entry is the default assignee of a
  card the person creates.
- `role`: `self`, `lead` or `all`. Anything else reads as `self`.
- `reports`: person ids. Only a `lead` uses them; they are followed
  recursively and cycles are harmless. A report's own role never widens the
  lead's view.
- `senderIds`: chat sender ids (strings; numbers are accepted and converted)
  that identify the person when one agent serves several people.
- `agents`: the sub-agents that are scoped, and the people each one serves.

Normalisation is fail-closed:

| File state | Effect |
|---|---|
| missing, or `enabled` is not literally `true` | feature off: no agent is scoped, `/api/board/*` is 403 for everyone |
| exists but is not a readable JSON object | **locked**: every sub-agent token is refused on `/api/kanban*` and `/api/board/*` until it is fixed (the main token is unaffected) |
| unknown person id in `reports` or `agents.*.people` | dropped |
| agent listed with no valid person | still scoped, sees nothing |

The "locked" row is deliberate: a present file means the owner confined
someone, and a typo must not reopen the full board to that agent. The file is
read on each relevant request, so a fix applies immediately, without restart.

## The gate

Runs in `web.ts` after authentication and before any route handler:

- a scoped agent (listed under `agents` while `enabled`) gets 403
  (`rule: "board-scope"`) on every path that starts with `/api/kanban`,
  including `/api/kanban-projects` and any kanban route added in the future
  (prefix match on the decoded, lower-cased path, no list to maintain);
- `/api/board/*` is allowed only for a scoped agent; everyone else (main token,
  browser sessions, device keys, federation, unlisted sub-agents) gets 403, so
  each endpoint has exactly one meaning;
- everything else is unchanged; the sub-agent allowlist
  (`AGENT_TOKEN_ALLOWLIST`) still applies to the scoped agent's other calls.

## Which person

- An agent mapped to exactly one person acts for that person. A header, if
  sent, must name the same person.
- An agent mapped to several people must send `X-Board-Person: <personId>` or
  `X-Board-Sender: <senderId>` (400 otherwise). Both may be sent; they must
  agree.
- A person not mapped to that agent is refused (403), whatever the header says.

## Endpoints

| Method and path | Body / query | Result |
|---|---|---|
| `GET /api/board/cards` | `?status=planned,in_progress` (optional) | `{ person, cards }`, visible non-archived cards |
| `GET /api/board/cards/:id` | | the card plus `comments`; 404 when missing, archived OR invisible (one answer for all three) |
| `POST /api/board/cards` | `{ title, description?, assignee?, priority?, due_date?, project? }` | new `planned` card; `assignee` defaults to the person's first assignee and must be inside the visible set (403 otherwise) |
| `POST /api/board/cards/:id/comments` | `{ content }` | comment authored by the person's `name`, set server-side |
| `POST /api/board/cards/:id/move` | `{ status, evidence? }` | moved with the person's `name` as audit actor; compare-and-set on the status read (409 on a concurrent change) |
| `GET /api/board/report` | `?date=YYYY-MM-DD` (optional, default today in `APP_TZ`) | `{ person, date, timezone, groups, text }` |

Bodies are strict: an unknown field, a non-object body or an unknown query
parameter is a 400 that names the accepted set. Writes use the same db helpers
as `/api/kanban` (`createKanbanCard`, `moveKanbanCard`, `addKanbanComment`) and
the move keeps the kanban move's side effects (dispatch on `in_progress`,
dependents freed on `done`).

### Daily report

Open (not done) visible cards, each listed once, in the first group it fits:
`due_today`, `overdue`, `in_progress` (includes `testing`), `waiting`,
`planned` (ordered by due day, undated last, then priority). `text` is a short
plain-text summary, at most 10 items per group, ready to send as a chat
message. A date-only due date (UTC midnight, what the dashboard date picker
stores) is read as that calendar day; a due date with a time of day is read in
the server zone. A daily message per person can be built as a scheduled task
of the colleague's agent that calls this endpoint and sends `text`.

## Threat model (honest)

- **What it protects against: a confused agent.** A colleague's assistant that
  is asked "show me everything on the board", or that improvises a
  `/api/kanban` call, gets only its person's cards. The decision is made by the
  server from the owner's file, not by the agent's prompt.
- **What it does NOT protect against: a malicious agent.** All agents run as
  the same Unix user as the dashboard. An agent that reads
  `store/.dashboard-token` (the master token) or another agent's token file
  can present it and is no longer scoped. File permissions cannot prevent
  that while the user is shared. Real isolation needs one OS user per agent.
- **Recommendation for colleague-facing agents:** give them a security
  profile whose permissions deny reading the master token and the other
  agents' token files (for example deny `Read` and Bash access to
  `store/.dashboard-token` and `agents/*/.dashboard-token` other than its own),
  run with `AGENT_TOKENS=1` so the agent only ever holds its own token, and do
  not hand such an agent a shell recipe that embeds the master token. This
  raises the bar for a confused agent; it is still a permission layer, not an
  OS boundary.
- **Other surfaces are not person-scoped.** The scope covers the kanban
  family. A scoped agent's other allowlisted calls (messages, memories, daily
  log) are not filtered by person, so card content that ends up there (a
  dispatch message, a daily-log line) is outside this feature.
- **Self-asserted person headers.** `X-Board-Person` / `X-Board-Sender` are
  chosen by the agent. They only select among the people the owner mapped to
  that agent; an agent serving several people can therefore read any of their
  boards. Map an agent to several people only when that is acceptable.
