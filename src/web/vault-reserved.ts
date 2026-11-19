// GMAILDRAFT1116 review B1: RESERVED vault entries. A reserved entry is stored in the ordinary vault (same file, same
// master key, same encryption) but it is never handed out by any generic vault path: not by GET /api/vault/:id, not by
// POST /api/vault/resolve, not by a binding (env var or header), not by the listing, and not by vault.ts getSecret()
// itself, which every in-process consumer (custom providers, Claude plans, bindings sync, the resolver scripts that
// import dist/web/vault.js) goes through. Generic writes (POST /api/vault, import, label PATCH, DELETE) are refused too.
// Only the module that owns the entry reads it, in the dashboard process, through the reserved accessor in vault.ts (a
// source-scan test pins who imports that).
//
// The first and only owner today is the Gmail draft endpoint (src/web/gmail-draft.ts): the owner's gmail.compose
// refresh token and OAuth client. gmail.compose can also SEND, so the value must not reach an agent.
//
// This module has no imports on purpose: the routes, the auth gate's floor (vault-acl.ts) and vault.ts all use the
// same predicate, and tests that mock vault.js keep working.
//
// Known limit, stated, not hidden: this closes the API path, not the OS path. Every agent runs as the same OS user,
// store/vault.json is readable by that user, and the master key sits in the login Keychain stored with `-A`
// (keychain.ts: any process of the user reads it without a prompt) or in store/.vault-key. An agent that decrypts
// vault.json itself still gets the value. The full fix is the OS-user split (vault-acl.ts F3).

export const RESERVED_VAULT_PREFIX = 'gmail-draft-'

/** True for every spelling the prefix can take as a vault id: trimmed, case-folded, '_' read as '-'. So
 *  'gmail-draft-x', 'GMAIL_DRAFT_X' (the ids the first version of PR #2824 asked the owner to store) and
 *  ' Gmail-Draft-x ' are all reserved. Conservative: a different entry that merely looks like one is refused too. */
export function isReservedVaultId(id: unknown): boolean {
  if (typeof id !== 'string') return false
  return id.trim().toLowerCase().replace(/_/g, '-').startsWith(RESERVED_VAULT_PREFIX)
}

export const RESERVED_VAULT_REFUSAL = 'This vault entry is reserved for an in-process feature and is never served, bound, listed or written through the vault API'
