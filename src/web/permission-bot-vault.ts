// Card 9a77b3e5 (B1): the Vault entry that holds the permission bot's token.
// It is written out-of-band by the operator, never through the dashboard API:
// any Bearer holder could otherwise swap in another bot's token. The routes
// that write or delete a Vault entry by a caller-chosen id refuse this one.
// (The token's bot id is ALSO pinned to PERMISSION_BOT_ID, see approvals.ts --
// this lock is the second fence, not the only one.)
export const PERMISSION_BOT_VAULT_ID = 'telegram-engedely-bot-token'

export function isPermissionBotVaultId(id: unknown): boolean {
  return typeof id === 'string' && id.trim().toLowerCase() === PERMISSION_BOT_VAULT_ID
}

export const PERMISSION_BOT_VAULT_LOCKED_ERROR =
  `The Vault entry "${PERMISSION_BOT_VAULT_ID}" is locked: it cannot be written or deleted through the API`
