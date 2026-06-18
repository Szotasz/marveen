# Google Docs helper

`scripts/gdocs.py` lets an agent **read and edit Google Docs** from the command
line: read the full text, do targeted find/replace, or replace the whole body
with formatted content (headings + bullets). It is a thin wrapper over the
Google Docs API with no extra services to run.

## Install

The helper needs two Google libraries. Install them into a dedicated venv so
they don't touch the system Python:

```bash
python3 -m venv .venv-gdocs
.venv-gdocs/bin/pip install -r scripts/gdocs-requirements.txt
```

Run the helper with that venv's Python:

```bash
.venv-gdocs/bin/python scripts/gdocs.py <command> ...
```

## Authentication

Two methods are supported. The helper picks OAuth if `store/.gdocs-oauth.json`
exists, otherwise it falls back to the service account.

### A. Service account (recommended, no admin needed)

1. In the [Google Cloud Console](https://console.cloud.google.com/) pick or
   create a project and **enable the Google Docs API and Google Drive API**.
2. Create a **service account** (APIs & Services -> Credentials -> Create
   credentials -> Service account). No roles are required.
3. On the service account, open **Keys -> Add key -> Create new key -> JSON**
   and save the downloaded file to `store/.gdocs-sa.json` (override the path
   with the `GDOCS_SA` environment variable).
4. Print the service account address and **share the target document** with it
   as **Editor** (in the document's Share dialog -- do not try to log in as it):

   ```bash
   .venv-gdocs/bin/python scripts/gdocs.py whoami
   # -> my-bot@my-project.iam.gserviceaccount.com
   ```

Edits then appear under the service account's name. To make edits appear under
a **human user** instead, you need Google Workspace domain-wide delegation
(Workspace admin required): authorize the service account's client ID for the
two scopes above in the Admin console, then set `GDOCS_SUBJECT=user@domain`.

### B. OAuth user token (edits appear as a real user)

Use this when you have no Workspace admin but want edits attributed to a person.

1. In the same Cloud project create an **OAuth client ID** of type **Desktop
   app** and save the downloaded JSON to `store/.gdocs-oauth-client.json`.
2. Generate the consent URL, open it, sign in, approve, and copy the `code`
   value from the redirected (localhost) URL:

   ```bash
   .venv-gdocs/bin/python scripts/gdocs.py auth-url
   .venv-gdocs/bin/python scripts/gdocs.py auth-exchange "<code>"
   ```

The refresh token is stored in `store/.gdocs-oauth.json` and reused afterwards.

> Keep all credential files out of version control. The `store/` directory is
> already gitignored in this project.

## Commands

A document is identified by its ID or full URL.

| Command | What it does |
| --- | --- |
| `whoami` | Print the service account email (the address to share docs with). |
| `read <doc>` | Print the document's plain text to stdout. |
| `replace <doc> "old" "new"` | Replace every exact (case-sensitive) match of `old` with `new`. |
| `replace-batch <doc> pairs.json` | Apply many replacements from a JSON array of `{"old","new"}`. |
| `set-content <doc> source.txt` | Replace the **entire body** from a source file. |
| `auth-url` / `auth-exchange <code>` | OAuth setup (method B). |

Every `replace*` reports how many occurrences changed per pair, so a `0` flags a
mismatched `old` string.

### `set-content` markers

`set-content` renders a simple text file into the document with basic styling:

- `# text` -> Heading 1
- `## text` -> Heading 2
- `- text` -> bullet list item
- any other line -> normal paragraph
- blank lines are ignored (paragraph spacing handles separation)

## Examples

```bash
PY=".venv-gdocs/bin/python scripts/gdocs.py"
DOC="https://docs.google.com/document/d/<id>/edit"

# Read it
$PY read "$DOC"

# One targeted edit
$PY replace "$DOC" "Q3 2025" "Q4 2025"

# Several edits at once
echo '[{"old":"draft","new":"final"},{"old":"TODO","new":"Done"}]' > /tmp/pairs.json
$PY replace-batch "$DOC" /tmp/pairs.json

# Rewrite the whole document
cat > /tmp/body.txt <<'EOF'
# Release notes

Summary paragraph.

## Highlights
- First item
- Second item
EOF
$PY set-content "$DOC" /tmp/body.txt
```
