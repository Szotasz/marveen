// contacts-sync-ledger.mjs -- manual, one-way sync contacts -> recipient ledger
// (card f90928e3, AC25). Reached ONLY from the CLI (`contacts.mjs sync-ledger`),
// never from the dashboard API: the API caller identity is self-declared, so an
// API write must not be able to make an address gate-trusted.
// An address already in the ledger is left alone (its evidence and timestamp
// stay). Nothing here prints an address.
import { addRecipient, isVerifiedIn, ledgerPath, loadLedger } from './recipient-ledger.mjs'

/**
 * @param {{ id: number, values?: Array<{ field: string, value: string, source: string, status?: string }> }} contact
 * @returns {{ added: number, exists: number, skipped: number, failed: number }}
 */
export function syncContactToLedger(contact, ledgerFile = ledgerPath()) {
  const out = { added: 0, exists: 0, skipped: 0, failed: 0 }
  for (const v of contact.values ?? []) {
    if (v.field !== 'email' || (v.status && v.status !== 'active')) continue
    const value = String(v.value ?? '').trim()
    if (!value.includes('@')) { out.skipped++; continue }
    try {
      const existing = loadLedger(ledgerFile)
      if (existing && isVerifiedIn(existing, value)) { out.exists++; continue }
      addRecipient(value, String(v.source).trim(), `contact:${contact.id}`, ledgerFile)
      out.added++
    } catch {
      out.failed++
    }
  }
  return out
}
