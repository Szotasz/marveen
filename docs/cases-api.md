# Case files and the send-once ledger

Two small APIs for fleets with several agents. Both sit behind the usual
`/api/*` Bearer gate.

## Case files (`/api/cases`)

Use a case when a finding concerns more than one agent, runs over several
rounds, or will be needed later as evidence. Everyone writes to the same case
instead of messaging each other N-to-N.

| Call | What it does |
|------|--------------|
| `POST /api/cases` `{id, title, agent}` | Open a case. `id` is a slug (`a-z0-9-`, 2-64 chars). Idempotent: opening an existing slug returns it. |
| `GET /api/cases[?status=open\|closed]` | List cases. |
| `GET /api/cases/<id>` | The case and all its notes, oldest first. |
| `POST /api/cases/<id>/notes` `{agent, kind, content}` | Append a note. `kind`: `finding`, `measurement`, `decision`, `correction`, `question`, `note`. |
| `POST /api/cases/<id>/close` `{agent}` | Close the case. |

Rules the API enforces:

- Notes are append-only. A correction is a new note with `kind: "correction"`,
  so the record of what was believed and when stays intact.
- A closed case refuses new notes and a second close (409); the first closer
  and time are kept. A later finding opens a new case.
- The author id `system` is reserved (403), as on `/api/messages`: agents read
  notes as trusted context.
- Note content goes through the same security filter as memories (400).
- A malformed or unknown id is a 400 / 404.

Suggested agent habit: read the case before messaging anyone about it, and
write findings there rather than in a message.

## Send-once ledger (`/api/owner-flags`)

Makes "tell the owner about this mail once" a property of the send itself.

| Call | What it does |
|------|--------------|
| `POST /api/owner-flags/claim` `{agent, source_ref, chat_id?, note?}` | Atomic claim. `claimed: true` means send; `claimed: false` means someone already did, stay quiet. |
| `POST /api/owner-flags/release` `{agent, source_ref, released_by?}` | Give the claim back when the send then failed. |
| `GET /api/owner-flags/releases?agent=&source_ref=` | Who released a claim and when. |
| `GET /api/owner-flags?agent=&limit=` | Recent claims for an agent. |

`source_ref` is whatever identifies the source item, e.g. `gmail:<message-id>`.
The Bearer is shared, so `released_by` is the caller's own id: a record, not an
authorisation.
