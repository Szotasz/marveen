# Scoped board access

A sub-agent that works for one or more people (for example a colleague's own
chat assistant) normally reads the whole kanban board. The scoped board lets
the owner decide, server-side, which cards such an agent may see:

- a person sees the cards assigned to them (`self`),
- a team lead also sees the cards of the people who report to them,
  recursively (`lead`),
- an executive sees every card (`all`),
- every person can ask for a daily report of today's and planned cards.

Two kinds of caller use the scoped board:

- a colleague-facing **sub-agent**, with its own dashboard token (below);
- a **colleague in a browser**, with an owner-made login (see
  [Colleague login](#colleague-login)).

Code: `src/web/board-access.ts` (config, visibility, gate),
`src/web/routes/board.ts` (routes), wired in `src/web.ts`. Tests:
`src/__tests__/board-access.test.ts`, `src/__tests__/colleague-login.test.ts`.

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

Only the owner edits the file. It is on the db-write gate's protected list
(`PROTECTED_INSTALL_PATHS` in `scripts/hooks/db-write-gate.mjs`), like the
other owner-set policy files in `store/`: an agent's Write/Edit or Bash write
to it (redirect, `tee`, `sed -i`, a rename onto it, `rm`) is denied, a read is
allowed. Without this, a confined agent told "your board access gives an
error, fix it" could set `"enabled": false` or give its person the role
`all`, and the next request would read the new file.

## The gate

Runs in `web.ts` after authentication and before any route handler:

- a scoped agent (listed under `agents` while `enabled`) gets 403
  (`rule: "board-scope"`) on every path that starts with `/api/kanban`,
  including `/api/kanban-projects` and any kanban route added in the future
  (prefix match on the decoded, lower-cased path, no list to maintain);
- `/api/board/*` is allowed only for a scoped agent and for a colleague board
  session (while the board is `enabled` and the file is readable); everyone
  else (main token, owner sessions, device keys, federation, unlisted
  sub-agents) gets 403, so each endpoint has exactly one meaning;
- everything else is unchanged; the sub-agent allowlist
  (`AGENT_TOKEN_ALLOWLIST`) still applies to the scoped agent's other calls.

## Which person

- A colleague board session acts as the person its account names. The
  `X-Board-Person` / `X-Board-Sender` headers are ignored for it: the session,
  not the request, decides the person.
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
| `POST /api/board/cards` | `{ title, description?, assignee?, priority?, due_date?, project? }` | new `planned` card; `title` at most 300 characters (400 above that); `assignee` defaults to the person's first assignee and must be inside the visible set (403 otherwise) |
| `POST /api/board/cards/:id/comments` | `{ content }` | comment authored by the person's `name`, set server-side; a `#hex8` card reference becomes `#seq` only for a card the person can see |
| `POST /api/board/cards/:id/move` | `{ status, evidence? }` | moved with the person's `name` as audit actor; compare-and-set on the status read (409 on a concurrent change); `done` without `evidence` is held at `testing` |
| `GET /api/board/report` | `?date=YYYY-MM-DD` (optional, default today in `APP_TZ`) | `{ person, date, timezone, groups, text }` |

Bodies are strict: an unknown field, a non-object body or an unknown query
parameter is a 400 that names the accepted set. Writes use the same db helpers
as `/api/kanban` (`createKanbanCard`, `moveKanbanCard`, `addKanbanComment`) and
the move keeps the kanban move's side effects (dispatch on `in_progress`,
dependents freed on `done`).

**Done needs evidence, the same as on `/api/kanban`.** The writer on these
routes is always a sub-agent; the person's name is only the actor recorded on
the card. So the done-gate of `/api/kanban/:id/move` applies here too: a move
to `done` without a non-empty `evidence` lands in `testing`, and the answer is
`{ ok: false, status: "testing", evidence_required: true, note }`. The agent
moves it to `done` again with `evidence` saying what was checked (for example
the person's own confirmation, a document or a photo). A person's word is not a
way around the gate; the owner decided this when the route was reviewed.

**Title length.** The `kanban_cards` insert trigger cuts a title above 300
characters to 300 and moves the full text into a comment, silently. The board
refuses such a title up front instead.

**Card references in comments.** A comment's `#<8 hex>` reference is rewritten
to the card's `#seq` only when that card is visible to the person; any other
reference is stored as typed, so the stored comment never says whether an
invisible card exists. Comment and move are logged with the agent that made
them, as create is.

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
- **The database is not scoped.** The scope covers the HTTP API only. The
  board itself lives in `store/claudeclaw.db`, and an agent that reads that
  file directly (for example `sqlite3 store/claudeclaw.db "select * from
  kanban_cards"`, which the fleet's own instructions present as a normal way
  to read the kanban) sees every card. Without a deny on the database file,
  the scope holds only for API calls.
- **Recommendation for colleague-facing agents:** give them a security
  profile whose permissions deny reading the master token, the other
  agents' token files and the database (for example deny `Read` and Bash
  access to `store/.dashboard-token`, `agents/*/.dashboard-token` other than
  its own, and `store/claudeclaw.db` with its `-wal` and `-shm` files),
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

## Colleague login

A colleague (for example an office assistant) can sign in to the dashboard in
a browser and see only the board cards their `board-access.json` person may
see, with read and write: list, create a card, comment, change status. Nothing
else of the dashboard is reachable with that login: no agents, memory,
settings, schedules, messages, owner kanban, or other people's cards.

Code: `src/web/colleague-accounts.ts` (accounts), `src/web/colleague-sessions.ts`
(sessions), `src/web/colleague-gate.ts` (the path fence),
`src/web/routes/colleague.ts` (login and owner admin routes),
`web/colleague.html` + `web/colleague.js` (the page),
`scripts/colleague-account.ts` (CLI).

### Setup

1. Make sure the person exists in `store/board-access.json` and the file has
   `"enabled": true`. For "own cards only", give the person `"role": "self"`.
   A colleague login honours the person's role exactly as written: a `lead`
   or `all` person sees more than their own cards.
2. Create the account on the machine (the password is asked twice, muted):

   ```bash
   npm run colleague-account -- add alice alice     # <username> <personId>
   npm run colleague-account -- list
   npm run colleague-account -- reset-password alice
   npm run colleague-account -- disable alice       # ends its open sessions
   npm run colleague-account -- enable alice
   npm run colleague-account -- remove alice
   ```

   Or, with the owner's dashboard login (an owner session; the access token
   alone is refused, as is every other credential):

   | Method and path | Body | Result |
   |---|---|---|
   | `GET /api/colleague-accounts` | | `{ accounts: [{ username, person, disabled, createdAt, updatedAt }] }` (never a hash) |
   | `POST /api/colleague-accounts` | `{ username, person, password }` | creates; the person must exist in `board-access.json` |
   | `POST /api/colleague-accounts/:username/password` | `{ password }` | new password; ends the account's sessions |
   | `POST /api/colleague-accounts/:username/disable` | | disables; ends the account's sessions |
   | `POST /api/colleague-accounts/:username/enable` | | enables (old sessions stay ended) |
   | `DELETE /api/colleague-accounts/:username` | | removes; ends the account's sessions |

   Usernames are lower case (`a-z 0-9 . _ -`, at most 64), and the login is
   case-insensitive. Passwords follow the owner login's policy (10 to 128
   characters).
3. The colleague opens `http://<dashboard host>:<port>/colleague` and signs in.
   The page is in Hungarian or English (the dashboard's `marveen.lang` choice
   in that browser, Hungarian by default).

Accounts live in `store/colleague-accounts.json` (gitignored, written `0600`):
the username, the person id, a scrypt hash in PHC format (the owner login's own
`password-hash.ts`), a `disabled` flag and a `generation` counter. A file that
exists but cannot be read signs nobody in, ends every colleague session and is
never overwritten by the CLI or the API; fix or remove it by hand. In an entry,
only a literal `"disabled": false` keeps an account usable.

### How a colleague session is kept apart from the owner

- **Its own cookie, table and principal.** The login sets `mv_colleague`
  (HttpOnly, SameSite=Strict, Secure when the request came over HTTPS), not the
  owner's `mv_session`. Only `sha256` of the cookie is stored, in the SQLite
  table `colleague_sessions`. The gate resolves it to the principal kind
  `colleague`, never `session`, so `mayActAsOwner` and every other owner check
  refuse it. In a browser that also holds the owner's session, the owner's
  session wins.
- **The path fence** (`colleague-gate.ts`), in `web.ts` right after
  authentication and before any handler, for every path, public ones included:
  only `/api/board*`, `/api/colleague/*` and the page's own static files
  (`/colleague`, `/colleague.js`, `/style.css`, `/lang/hu.js`, `/lang/en.js`)
  pass. Any other `/api/*` path is 403 (`rule: "colleague-scope"`), any other
  page is a redirect to `/colleague`, any other write is 403. It is a prefix
  deny-by-default, so a route added later is closed without editing a list. A
  path is allowed only when its raw form is already canonical (decoded, lower
  case, single slashes), so a spelling variant cannot pass the fence and then
  reach some other handler.
- **The person is the session's.** `/api/board/*` resolves a colleague session
  to its account's person on every request; headers are ignored.
- **Every request re-checks the account.** A disabled, deleted or
  password-reset account (the `generation` moves on) ends its open sessions on
  the next request, also when the change came from the CLI. Removing the
  person from `board-access.json`, or turning the board off, closes the board
  to the session (403) and refuses new logins.
- **Lifetimes:** 12 hours idle, 7 days absolute, enforced server-side. Sessions
  survive a dashboard restart. `npm run dashboard-user -- security:reset`
  clears colleague sessions too (the accounts stay).
- **Login throttling** is the owner login's policy (5 failures lock the
  username for 30 s, doubling to 15 min; 50 failures an hour lock every
  colleague login), on its OWN counter: colleague failures never lock the
  owner out. An unknown username costs the same password check as a wrong
  password, and a disabled account answers like a wrong password.
- **CSRF**: the dashboard's Origin check for every state-changing request runs
  before authentication and covers these requests too; the cookie is
  SameSite=Strict.

### Reaching it from the office network

The dashboard listens on `WEB_HOST` (default `127.0.0.1`, this machine only).
For colleagues on the company LAN, set `WEB_HOST` in `.env` to the machine's
LAN address (for example `WEB_HOST=192.168.1.10`), or `0.0.0.0` for every
interface, and restart the dashboard. Know what that means:

- **The whole dashboard becomes reachable from the LAN**, not only the
  colleague page: the owner login page, and the API for anyone holding the
  access token. The colleague fence limits what a colleague LOGIN can do; it
  does not hide the rest of the server from the network. Prefer the specific
  LAN address over `0.0.0.0`, restrict the port to the office subnet in the
  host firewall, and keep using `http://localhost:<port>` yourself on the
  machine.
- **LAN HTTP is unencrypted.** Passwords and session cookies cross the
  network in clear text. Anyone who can sniff that network segment can take a
  colleague's session or password. Do not reuse a password that matters
  elsewhere, and put the dashboard behind HTTPS (a reverse proxy) if the
  segment is not trusted. Never sign in as the owner over plain LAN HTTP.

### Threat model of the colleague login (honest)

- **What it protects against: a curious colleague on the LAN.** With their
  own login they see and change only their own cards; every other API answers
  403, other people's cards answer 404 (the same as a card that does not
  exist), and they cannot pick another person.
- **What it does NOT protect against: anything running on the dashboard
  machine as the same OS user.** Such a process can read the access token, the
  account file and the database, so it is not confined by any of this. The
  colleague login is a network-facing permission layer, not an OS boundary.
- **Not protected: the network path.** See "LAN HTTP is unencrypted" above.
- **Not in the pilot:** a second factor for colleague logins, and a
  self-service password change (the owner resets passwords).
