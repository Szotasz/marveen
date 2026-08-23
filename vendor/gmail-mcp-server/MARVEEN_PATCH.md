# Marveen patch notes

Vendored from `gmail-mcp-server@1.0.30` (npm, MIT, https://www.npmjs.com/package/gmail-mcp-server)
on 2026-08-23. See `../../ATTRIBUTIONS.md` for the full attribution entry.

## Why this exists

The published `--multi-user` mode advertises a `userId` parameter on every tool
(`gmail_search_emails`, `gmail_read_email`, `gmail_send_email`, `gmail_draft`,
`gmail_mark_email`, `gmail_move_email`, `gmail_delete_email`,
`gmail_list_attachments`, `gmail_get_attachment`), but the shipped handlers never
actually used it: they always called the single legacy `gmailOperations` singleton,
regardless of `userId`. `gmail_send_email` even fetched the per-user client via
`multiUserAuth.getGmailClientForUser(userId)` and then discarded it. Net effect:
every account you authenticate through `gmail_authenticate_user` silently reads and
sends through whichever account was authenticated first, via `gmail_authenticate`.

## What changed

- `dist/utils/gmail-operations.js`: every method that reaches Gmail
  (`sendEmail`, `getEmail`, `getAttachment`, `getAttachmentToLocal`,
  `listAttachments`, `searchEmails` + its two internal search strategies,
  `markEmail`, `moveToLabel`, `deleteEmail`, the draft CRUD methods, `listEmails`)
  now takes an optional trailing `overrideClient` param. When present, it's used
  instead of the legacy singleton client; when absent, behavior is unchanged
  (falls back to the legacy default account). Internal cross-calls
  (`performEnhancedSearch`/`performTraditionalSearch` calling `getEmail`,
  `listDrafts` calling `getDraft`) now thread the same override through.
- `dist/utils/multi-user-auth.js`: `getGmailClientForUser(userId)` now also
  accepts a plain email address (matched against `session.userEmail`), not just
  the generated `user_<hash>_...` id, so callers don't need to remember the
  opaque id.
- `dist/index.js`: each of the 9 affected tool handlers now resolves
  `overrideClient` from `userId` (via `multiUserAuth.getGmailClientForUser`)
  *when userId is given*, and passes it through. The old
  `"'userId' is required in multi-user mode"` throws were removed — omitting
  `userId` now means "use the primary/default account" instead of erroring, so
  existing callers that don't know about multi-user mode keep working
  unchanged. The duplicated multi-user/single-user branches in the
  `gmail_draft` handler were collapsed into one (they did the same discard-the-
  client thing in both branches anyway).

## If you ever refresh this vendor copy from a newer npm release

Re-check whether `dist/index.js` and `dist/utils/gmail-operations.js` /
`multi-user-auth.js` still have this exact bug before assuming the patch still
applies cleanly — search for `gmailOperations.searchEmails(searchCriteria)`
(no second arg) and `is not authenticated` in `multi-user-auth.js` as anchors.
