import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

// One-way sync contacts -> recipient ledger (card f90928e3, node C3, AC25).
// The contact value is committed first; this runs afterwards and can only add.
// An address already in the ledger is left alone, so its original evidence and
// timestamp are never overwritten. Nothing here logs or returns an address.

interface LedgerModule {
  addRecipient: (address: string, source: string, note: string, path?: string) => unknown
  loadLedger: (path?: string) => { recipients: Record<string, unknown> } | null
  isVerifiedIn: (ledger: unknown, address: string) => boolean
  ledgerPath: () => string
}

export type LedgerSyncResult = 'ok' | 'exists' | 'failed' | 'skipped'

let ledgerPathOverride: string | null = null

/** Tests point the sync at a temp ledger; null restores the default store path. */
export function setLedgerSyncPath(path: string | null): void {
  ledgerPathOverride = path
}

async function loadModule(): Promise<LedgerModule> {
  const href = pathToFileURL(join(PROJECT_ROOT, 'scripts', 'recipient-ledger.mjs')).href
  return (await import(href)) as LedgerModule
}

export async function syncEmailToLedger(input: { contactId: number; value: string; source: string }): Promise<LedgerSyncResult> {
  if (!input.value.includes('@')) return 'skipped'
  try {
    const mod = await loadModule()
    const path = ledgerPathOverride ?? mod.ledgerPath()
    const existing = mod.loadLedger(path)
    if (existing && mod.isVerifiedIn(existing, input.value)) return 'exists'
    mod.addRecipient(input.value, input.source, `contact:${input.contactId}`, path)
    return 'ok'
  } catch {
    logger.error({ contact_id: input.contactId }, 'contacts: ledger sync failed (contact value kept)')
    return 'failed'
  }
}
