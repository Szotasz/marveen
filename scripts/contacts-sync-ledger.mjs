// contacts-sync-ledger.mjs -- manual, one-way sync contacts -> recipient ledger
// (card f90928e3, AC25). Reached ONLY from the CLI (`contacts.mjs sync-ledger`),
// never from the dashboard API: the API caller identity is self-declared, so an
// API write must not be able to make an address gate-trusted.
// An address already in the ledger is left alone (its evidence and timestamp
// stay). Dry run is the default: it lists each address and its source and
// writes nothing; only `apply: true` (CLI: --apply) calls addRecipient.
import { addRecipient, isVerifiedIn, ledgerPath, loadLedger } from './recipient-ledger.mjs'

/**
 * @param {{ id: number, values?: Array<{ field: string, value: string, source: string, status?: string }> }} contact
 * @param {string} [ledgerFile]
 * @param {{ apply?: boolean }} [opts]
 * @returns {{ dryRun: boolean, added: number, would_add: number, exists: number, skipped: number, failed: number, entries: Array<{ address: string, source: string, action: string }> }}
 */
export function syncContactToLedger(contact, ledgerFile = ledgerPath(), { apply = false } = {}) {
  const out = { dryRun: !apply, added: 0, would_add: 0, exists: 0, skipped: 0, failed: 0, entries: [] }
  for (const v of contact.values ?? []) {
    if (v.field !== 'email' || (v.status && v.status !== 'active')) continue
    const value = String(v.value ?? '').trim()
    const source = String(v.source).trim()
    if (!value.includes('@')) { out.skipped++; continue }
    try {
      const existing = loadLedger(ledgerFile)
      if (existing && isVerifiedIn(existing, value)) {
        out.exists++; out.entries.push({ address: value, source, action: 'exists' }); continue
      }
      if (!apply) {
        out.would_add++; out.entries.push({ address: value, source, action: 'would-add' }); continue
      }
      addRecipient(value, source, `contact:${contact.id}`, ledgerFile)
      out.added++; out.entries.push({ address: value, source, action: 'added' })
    } catch {
      out.failed++; out.entries.push({ address: value, source, action: 'failed' })
    }
  }
  return out
}
