# Google Calendar and Drive over a service account

The heartbeat and the morning brief read Google Calendar and Drive. They can do
that two ways:

- **OAuth** (the existing path): the tokens in
  `~/.config/google-calendar-mcp/tokens.json`. If the OAuth app is in Google's
  *Testing* state, its refresh token expires after **7 days**, so the owner has
  to consent again every week.
- **Service account** (this path): a machine identity with its own address, no
  consent screen and no expiry. When its key file is installed, Calendar and
  Drive use it; otherwise they fall back to OAuth.

Gmail is not covered: a service account cannot read a consumer `gmail.com`
mailbox without Google Workspace domain-wide delegation, so Gmail stays on OAuth.

## Setup

1. In the [Google Cloud Console](https://console.cloud.google.com/) pick or
   create a project and **enable the Google Calendar API and the Google Drive
   API**.
2. Create a **service account** (APIs & Services -> Credentials -> Create
   credentials -> Service account). No roles are required.
3. On the service account open **Keys -> Add key -> Create new key -> JSON**
   and save the file as:

   ```bash
   mkdir -p ~/.config/marveen
   mv ~/Downloads/<downloaded-key>.json ~/.config/marveen/google-service-account.json
   chmod 600 ~/.config/marveen/google-service-account.json
   ```

   The `chmod 600` is enforced: a key file readable by group or others is
   refused, and the error names the `chmod` that fixes it. Like ssh with a
   loose identity file, it is better to stop than to run with a private key
   anyone on the machine can read.

4. **Share** what the agents should read with the service account's address
   (the `client_email` field in the key file, e.g.
   `my-bot@my-project.iam.gserviceaccount.com`):
   - a calendar: Google Calendar -> the calendar's *Settings and sharing* ->
     *Share with specific people* -> add the address with *See all event
     details*;
   - Drive: share the folders or files with the address as *Viewer*.

The service account sees only what was shared with it. It requests read-only
scopes (`calendar.readonly`, `drive.readonly`); one token covers both.

## Checking it

The key file is re-read when it changes (by modification time), so no restart is
needed after installing or rotating it. A failed token exchange is logged as
`Google service-account token exchange failed` with the HTTP status, and the
cached token is dropped, so a revoked key surfaces as an error instead of an
old token being reused.

To stop using the service account, remove the key file; Calendar and Drive go
back to OAuth.
